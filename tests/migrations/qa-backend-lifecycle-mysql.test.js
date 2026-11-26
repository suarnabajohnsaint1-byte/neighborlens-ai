const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { privateMysql } = require('../support/private-mysql');
const { evidenceFile, PNG_BYTES, JPEG_BYTES } = require('../support/image-fixtures');
const { setFixtureResidency, freshReportFixAt } = require('../support/citizens');

test('private MySQL report retries, publication, jurisdiction and action proofs remain consistent', { timeout: 180000 }, async t => {
  const database = await privateMysql(t);
  let server;
  try {
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    process.env.UPLOAD_DIR = path.join(database.directory, 'uploads');
    process.env.STORAGE_DRIVER = 'local';
    if (process.env.QA_REAL_INFERENCE_URL) {
      const url = new URL(process.env.QA_REAL_INFERENCE_URL);
      assert.equal(url.hostname, '127.0.0.1');
      process.env.DAMAGE_INFERENCE_URL = new URL('/predict', url).href;
      process.env.DAMAGE_PAIR_INFERENCE_URL = new URL('/api/v1/damage/verify-pair', url).href;
    }
    await require('../../server/infrastructure/database/mysql/migrationRunner').runMigrations(database.pool);
    require('../../server/infrastructure/database').useTestDatabase(database.adapter);
    const services = require('../../server/composition');
    const app = require('../../server/app');
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const password = 'QaFixture1234';
    const hash = await bcrypt.hash(password, 4);
    async function actor(username, role, barangay = 'Villamonte') {
      await database.pool.execute('INSERT INTO users (username, password_hash, role, barangay, barangay_id) SELECT ?, ?, ?, name, id FROM barangays WHERE name = ?', [username, hash, role, barangay]);
      const response = await fetch(`${base}/api/auth/${role}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200);
      return response.json();
    }
    const citizen = await actor('qa_owner', 'citizen'), admin = await actor('qa_admin', 'admin');
    await setFixtureResidency('qa_owner', 'Villamonte', database.adapter);
    const official = await actor('qa_official', 'barangay'), outside = await actor('qa_outside', 'barangay', 'Mandalagan');
    async function api(route, user, method = 'GET', body) {
      const multipart = body instanceof FormData;
      const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${user.token}`, ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    }
    function form(key, photos = [PNG_BYTES, JPEG_BYTES], proofs = null, gpsFixAt = freshReportFixAt()) {
      const body = new FormData();
      for (const [keyName, value] of Object.entries({ requestKey: key, description: 'Isolated QA lifecycle', barangay: 'Villamonte', citizenCategory: 'Road Damage', latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15', gpsFixAt })) body.append(keyName, value);
      if (proofs) body.append('assessmentProofs', JSON.stringify(proofs));
      photos.forEach((bytes, index) => body.append('images', new Blob([bytes], { type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }), `evidence-${index}.jpg`));
      return body;
    }
    let report;
    await t.test('rejected duplicates and screenshots leave MySQL and storage unchanged', async () => {
      const before = await database.adapter.query('SELECT COUNT(*) AS total FROM reports');
      const files = await fs.readdir(process.env.UPLOAD_DIR);
      for (const [photos, code] of [
        [[JPEG_BYTES, JPEG_BYTES], 'DUPLICATE_EVIDENCE'],
        [[JPEG_BYTES, evidenceFile('camo-studio.png')], 'INVALID_EVIDENCE']
      ]) {
        const response = await api('/api/reports', citizen, 'POST', form(randomUUID(), photos));
        assert.equal(response.status, 422);
        assert.equal(response.data.code, code);
      }
      assert.deepEqual(await database.adapter.query('SELECT COUNT(*) AS total FROM reports'), before);
      assert.deepEqual(await fs.readdir(process.env.UPLOAD_DIR), files);
    });
    await t.test('real FastAPI pair previews pass through Node into MySQL without invented severity', {
      skip: !process.env.QA_REAL_INFERENCE_URL || !process.env.QA_REAL_IMAGE || !process.env.QA_REAL_IMAGE_2
    }, async () => {
      const photos = await Promise.all([process.env.QA_REAL_IMAGE, process.env.QA_REAL_IMAGE_2].map(file => fs.readFile(file)));
      const body = form(randomUUID(), photos);
      body.append('assessment', 'pair');
      const result = await api('/api/ai/damage', citizen, 'POST', body);
      assert.equal(result.status, 200);
      const review = process.env.QA_REAL_EXPECT_REVIEW === '1';
      assert.equal(result.data.evidenceStatus, review ? 'EVIDENCE_REVIEW_REQUIRED' : 'PASSED');
      assert.ok(result.data.photos.every(photo => photo.assessmentProof && !photo.failure));
      if (review) {
        assert.equal(result.data.severitySuggestion, null);
        assert.ok(result.data.photos.every(({ result }) => result.status === 'EVIDENCE_REVIEW_REQUIRED' &&
          result.evidence_relevance === 'UNAVAILABLE'));
        const expectedExtents = JSON.parse(process.env.QA_REAL_EXPECT_EXTENTS || '["EXPERIMENTAL","EXPERIMENTAL"]');
        assert.deepEqual(result.data.photos.map(({ result }) => result.visual_extent?.quality ?? null), expectedExtents);
      }
      const proofs = result.data.photos.map(photo => photo.assessmentProof);
      const saved = await api('/api/reports', citizen, 'POST', form(randomUUID(), photos, proofs));
      assert.equal(saved.status, 201);
      report = saved.data;
      assert.equal(report.citizenCategory, 'Road Damage');
      assert.ok(report.originalAi);
      assert.equal(report.ai_classification, null); assert.equal(report.ai_priority, null);
      const [stored] = await database.pool.execute('SELECT highest_severity FROM damage_verifications WHERE report_id = ?', [report.id]);
      if (review) {
        assert.equal(stored.length, 0);
        assert.deepEqual(report.visualExtents, result.data.photos.map(photo => photo.result.visual_extent ?? null));
        const [rows] = await database.pool.execute('SELECT submission_assessment FROM reports WHERE id = ?', [report.id]);
        assert.deepEqual(rows[0].submission_assessment.visual_extents, report.visualExtents);
      } else {
        assert.equal(stored.length, 1);
        assert.equal(stored[0].highest_severity, null);
      }
    });
    services.damageDetectionService.detectForReport = async () => null;
    services.damageDetectionService.verifyReportImages = async () => null;
    await t.test('concurrent manual retries retain one report, two photos, one audit and one publication request', async () => {
      const key = randomUUID();
      const gpsFixAt = freshReportFixAt();
      const submit = () => api('/api/reports', citizen, 'POST', form(key, undefined, null, gpsFixAt));
      const results = await Promise.all([submit(), submit()]);
      assert.deepEqual(results.map(result => result.status), [201, 201]);
      assert.equal(results[0].data.id, results[1].data.id);
      report = results[0].data;
      const [photos] = await database.pool.execute('SELECT COUNT(*) AS total FROM report_images WHERE report_id = ?', [report.id]);
      const [requests] = await database.pool.execute('SELECT COUNT(*) AS total FROM community_publication_requests WHERE report_id = ?', [report.id]);
      const [logs] = await database.pool.execute("SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'report' AND entity_id = ? AND action = 'create'", [report.id]);
      assert.equal(photos[0].total, 2); assert.equal(requests[0].total, 1); assert.equal(logs[0].total, 1);
      const changed = form(key, undefined, null, gpsFixAt); changed.set('description', 'Conflicting content');
      assert.equal((await api('/api/reports', citizen, 'POST', changed)).status, 409);
    });
    await t.test('jurisdiction, required resolution proof, history and publication remain separate', async () => {
      assert.equal((await api(`/api/reports/${report.id}`, outside)).status, 403);
      assert.equal((await api(`/api/reports/${report.id}/status`, citizen, 'PATCH', { status: 'ongoing' })).status, 403);
      assert.equal((await api(`/api/reports/${report.id}/status`, official, 'PATCH', { status: 'ongoing' })).status, 200);
      assert.equal((await api(`/api/reports/${report.id}/status`, official, 'PATCH', { status: 'resolved', note: 'Completed' })).status, 400);
      const notifications = require('../../server/infrastructure/repositories/notification.repository');
      const beforeFiles = (await fs.readdir(process.env.UPLOAD_DIR, { recursive: true })).sort();
      const notificationFailure = t.mock.method(notifications, 'create', async () => { throw new Error('Controlled completion notification failure'); });
      const failed = new FormData(); failed.append('status', 'resolved'); failed.append('note', 'Completion must roll back with its notification.'); failed.append('requestKey', randomUUID()); failed.append('images', new Blob([PNG_BYTES], { type: 'image/png' }), 'rollback-proof.png');
      let failure;
      try { failure = await api(`/api/reports/${report.id}/status`, official, 'PATCH', failed); }
      finally { notificationFailure.mock.restore(); }
      assert.equal(failure.status, 500);
      assert.equal((await api(`/api/reports/${report.id}`, official)).data.status, 'ongoing');
      const [rolledBack] = await database.pool.execute('SELECT COUNT(*) AS total FROM report_action_proofs p JOIN report_status_history h ON h.id = p.history_id WHERE h.report_id = ?', [report.id]);
      assert.equal(rolledBack[0].total, 0);
      assert.deepEqual((await fs.readdir(process.env.UPLOAD_DIR, { recursive: true })).sort(), beforeFiles);
      const body = new FormData(); body.append('status', 'resolved'); body.append('note', 'Isolated completion evidence'); body.append('requestKey', randomUUID()); body.append('images', new Blob([PNG_BYTES], { type: 'image/png' }), 'proof.png');
      assert.equal((await api(`/api/reports/${report.id}/status`, official, 'PATCH', body)).status, 200);
      const history = (await api(`/api/reports/${report.id}/history`, citizen)).data.history;
      assert.equal(history.filter(row => row.new_status === 'resolved').length, 1);
      const pending = await api(`/api/admin/community-publications/${report.id}`, admin);
      assert.equal(pending.data.publication.state, 'pending_approval');
      assert.equal((await api(`/api/admin/community-publications/${report.id}/decision`, official, 'POST', { state: 'approved', version: pending.data.publication.version })).status, 403);
      assert.equal((await api(`/api/admin/community-publications/${report.id}/decision`, admin, 'POST', { state: 'approved', version: pending.data.publication.version })).status, 200);
      const feed = await api('/api/community/posts', citizen);
      assert.ok(feed.data.posts.some(post => post.linkedReport?.id === report.id));
      assert.equal((await api(`/api/reports/${report.id}`, citizen)).data.status, 'resolved');
      const [unassessed] = await database.pool.execute('SELECT ai_classification, ai_priority FROM reports WHERE id = ?', [report.id]);
      assert.equal(unassessed[0].ai_classification, null); assert.equal(unassessed[0].ai_priority, null);
      const [assessments] = await database.pool.execute('SELECT COUNT(*) AS total FROM report_severity_reviews WHERE report_id = ?', [report.id]);
      assert.equal(assessments[0].total, 0);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await database.close();
  }
});
