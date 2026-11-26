const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { privateMysql } = require('../support/private-mysql');
const { readMigration, runMigrations, parseStatements } = require('../../server/infrastructure/database/mysql/migrationRunner');
const { useTestDatabase } = require('../../server/infrastructure/database');
const repository = require('../../server/infrastructure/repositories/report.repository');
const { photoSnapshot, originalAssessment } = require('../../server/domain/reports/submissionAssessment.rules');

function assessment() {
  const photo = photoSnapshot({ status: 'DETECTED', detected: true, canonical_category: 'pothole', candidate: { canonical_category: 'pothole', confidence: 0.9, accepted: true }, confidence: 0.9, detections: [] });
  return { schema_version: 1, citizen_category: 'Flooding / Drainage', original_ai: originalAssessment([photo, photo]), evidence: { citizen_id: '1', photos: [1, 2].map(order => ({ order, sha256: 'a'.repeat(64), proof_id: `mysql-proof-${order}`, issued_at: 100 })) } };
}

function report(snapshot = null) {
  return { description: 'Isolated MySQL report', barangay: 'Barangay 1', location: null, latitude: null, longitude: null,
    imagePath: null, aiCategory: 'pothole', aiClassification: null, aiPriority: null, aiConfidence: 90, visionDetected: true,
    submittedBy: 1, submissionAssessment: snapshot };
}

test('Phase 2 migration lifecycle on a separate temporary MySQL instance', { timeout: 180000 }, async t => {
  const { pool, adapter: database, directory, close } = await privateMysql(t, { executable: process.env.PHASE2_MYSQLD });
  try {
    const [[identity]] = await pool.query('SELECT VERSION() AS version');
    assert.match(identity.version, /^8\./);
    const initial = await readMigration('001_init_schema.sql');
    for (const statement of initial.statements) await pool.query(statement);
    await pool.query('CREATE TABLE schema_migrations (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, filename VARCHAR(255) NOT NULL UNIQUE, checksum VARCHAR(64) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [initial.filename, initial.checksum]);
    await pool.query("INSERT INTO users (id, username, password_hash, role, barangay) VALUES (1, 'isolated', 'not-a-live-account', 'citizen', 'Barangay 1')");
    await pool.query("INSERT INTO reports (description, barangay, submitted_by, ai_category) VALUES ('Representative legacy generic report', 'Barangay 1', 1, 'Fallen Tree')");
    const [legacy] = await pool.query('SELECT * FROM reports WHERE id = 1');
    useTestDatabase(database);

    await t.test('forward migrations preserve legacy values and add nullable assessment and GPS columns', async () => {
      const result = await runMigrations(pool);
      assert.deepEqual(result.applied, (await require('../../server/infrastructure/database/mysql/migrationRunner').listMigrationFiles()).filter(name => name !== '001_init_schema.sql'));
      const [rows] = await pool.query('SELECT * FROM reports WHERE id = 1');
      const { submission_assessment, gps_fix_at, barangay_id, ...unchanged } = rows[0];
      const { barangay_id: legacyBarangayId, ...legacyUnchanged } = legacy[0];
      assert.equal(submission_assessment, null);
      assert.equal(gps_fix_at, null);
      assert.equal(legacyBarangayId, null);
      assert.equal(barangay_id, 1);
      assert.deepEqual(unchanged, legacyUnchanged);
      const [columns] = await pool.query("SHOW COLUMNS FROM reports LIKE 'submission_assessment'");
      assert.equal(columns[0].Type, 'json'); assert.equal(columns[0].Null, 'YES');
      assert.equal(Object.keys(rows[0]).length, Object.keys(legacy[0]).length + 2);
    });

    await t.test('new snapshot survives actual MySQL JSON serialization and repository reads', async () => {
      const snapshot = assessment();
      const { insertId } = await repository.create(report(snapshot));
      const saved = await repository.findById(insertId);
      assert.deepEqual(saved.submission_assessment, snapshot);
      assert.equal(saved.ai_category, 'pothole');
      assert.equal(saved.description, 'Isolated MySQL report');
      const unselected = assessment();
      unselected.citizen_category = null;
      const optional = await repository.create(report(unselected));
      assert.equal((await repository.findById(optional.insertId)).submission_assessment.citizen_category, null);
    });

    await t.test('new legacy submissions retain SQL NULL compatibility', async () => {
      const { insertId } = await repository.create(report());
      assert.equal((await repository.findById(insertId)).submission_assessment, null);
    });

    await t.test('authorized details read actual MySQL JSON and ordered images through the application service', async () => {
      const { createReportService } = require('../../server/application/use-cases/report.service');
      const images = require('../../server/infrastructure/repositories/reportImage.repository');
      const snapshot = assessment();
      snapshot.visual_extents = [{ source: 'opencv_visual_extent', version: '1', category: 'pothole',
        quality: 'EXPERIMENTAL', reason: 'CANDIDATE_MASK_ONLY', grid: [40,40], region: [0,0,40,40],
        features: { candidate_area_px2: 80, crop_fraction: .05, components: 1, largest_component_fraction: 1,
          threshold_stability_iou: .83 } }, null];
      const { insertId } = await repository.create(report(snapshot));
      await images.createMany(insertId, [1, 2].map(order => ({ imagePath: `supabase:reports/1/00000000-0000-4000-8000-00000000000${order}.jpg`, imageOrder: order })));
      const signed = [];
      const service = createReportService({ reportRepository: repository, reportImageRepository: images,
        getImageStorage: () => ({ getReadUrl: async reference => { signed.push(reference); return `https://isolated-storage.test/photo-${signed.length}.jpg`; } }) });
      await assert.rejects(() => service.getReport(insertId, { id: 2, role: 'citizen' }), /own reports/);
      assert.equal(signed.length, 0);
      const result = await service.getReport(insertId, { id: 1, role: 'citizen' });
      assert.equal(result.citizenCategory, 'Flooding / Drainage');
      assert.equal(result.originalAi.canonical_class, 'pothole');
      assert.deepEqual(result.visualExtents, snapshot.visual_extents);
      assert.equal(result.ai_classification, null);
      assert.deepEqual(result.images.map(image => image.imageOrder), [1, 2]);
      assert.equal(signed.length, 2);
      assert.doesNotMatch(JSON.stringify(result), /proof_id|supabase:|submission_assessment/);
    });

    await t.test('malformed JSON and invalid application snapshots are rejected', async () => {
      await assert.rejects(() => pool.execute("INSERT INTO reports (description, barangay, submission_assessment) VALUES ('Bad JSON', 'Barangay 1', ?)", ['{broken']));
      await assert.rejects(() => repository.create(report({ ...assessment(), citizen_category: 'Electrical' })), /Malformed/);
    });

    await t.test('transaction rollback removes the entire new snapshot write', async () => {
      const [before] = await pool.query('SELECT COUNT(*) AS count FROM reports');
      await assert.rejects(() => database.withTransaction(async tx => { await repository.create(report(assessment()), tx); throw new Error('Rollback check'); }), /Rollback check/);
      const [after] = await pool.query('SELECT COUNT(*) AS count FROM reports');
      assert.equal(after[0].count, before[0].count);
    });

    await t.test('concurrent replay is serialized by the owner row lock', async () => {
      const snapshot = assessment();
      snapshot.evidence.photos.forEach(photo => { photo.proof_id += '-concurrent'; });
      const submit = () => database.withTransaction(async tx => {
        await repository.assertUnusedAssessment(1, snapshot.evidence.photos.map(photo => photo.proof_id), tx);
        return repository.create(report(snapshot), tx);
      });
      const results = await Promise.allSettled([submit(), submit()]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ASSESSMENT_REPLAY');
    });

    await t.test('rollback drops only the snapshot column after export', async () => {
      const [exported] = await pool.query('SELECT id, submission_assessment FROM reports WHERE submission_assessment IS NOT NULL');
      assert.ok(exported.length);
      await fs.writeFile(path.join(directory, 'snapshot-export.json'), JSON.stringify(exported));
      const [before] = await pool.query('SELECT id, description, ai_category FROM reports ORDER BY id');
      const rollback = await fs.readFile(path.join(__dirname, '../../server/infrastructure/database/mysql/rollbacks/002_submission_assessment.sql'), 'utf8');
      for (const statement of parseStatements(rollback)) await pool.query(statement);
      const [after] = await pool.query('SELECT id, description, ai_category FROM reports ORDER BY id');
      assert.deepEqual(after, before);
      const [columns] = await pool.query("SHOW COLUMNS FROM reports LIKE 'submission_assessment'");
      assert.equal(columns.length, 0);
    });

    await t.test('reapplication is supported without invented historical snapshots', async () => {
      assert.deepEqual((await runMigrations(pool)).applied, ['002_submission_assessment.sql']);
      const [rows] = await pool.query('SELECT submission_assessment FROM reports');
      assert.ok(rows.every(row => row.submission_assessment === null));
      assert.deepEqual((await runMigrations(pool)).applied, []);
    });
  } finally {
    await close();
  }
});
