const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { PNG_BYTES } = require('./image-fixtures');

async function assertPrivate(pool, directory) {
  const [[identity]] = await pool.query('SELECT @@datadir AS directory, DATABASE() AS name');
  assert.equal(path.resolve(identity.directory).toLowerCase(), path.resolve(directory).toLowerCase());
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('neighborlens-community-mysql-'));
  assert.match(identity.name, /^(community_isolated|recovery_[a-z_]+)$/);
}

async function sourceRunner(directory, { through = '018', newer001 = false, newer009 = false, ending } = {}) {
  const root = path.resolve('server/infrastructure/database/mysql');
  await fs.mkdir(path.join(directory, 'migrations'), { recursive: true });
  await fs.copyFile(path.join(root, 'migrationRunner.js'), path.join(directory, 'migrationRunner.js'));
  await fs.copyFile(path.join(root, 'migrationHistory.json'), path.join(directory, 'migrationHistory.json'));
  await fs.cp(path.join(root, 'migration-history'), path.join(directory, 'migration-history'), { recursive: true });
  for (const filename of (await fs.readdir(path.join(root, 'migrations'))).filter(name => name.endsWith('.sql') && name.slice(0, 3) <= through)) {
    const alternate = filename.startsWith('001_') && newer001 || filename.startsWith('009_') && newer009;
    const versions = require(path.join(root, 'migrationHistory.json'));
    const source = alternate ? path.join(root, 'migration-history', filename.slice(0, -4), `${versions[filename][0]}.sql`) : path.join(root, 'migrations', filename);
    const bytes = await fs.readFile(source);
    await fs.writeFile(path.join(directory, 'migrations', filename), ending ? bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, ending) : bytes);
  }
  return require(path.join(directory, 'migrationRunner.js'));
}

async function tableSnapshot(pool, previous) {
  const snapshot = {};
  const names = previous ? Object.keys(previous) : (await pool.query("SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> 'schema_migrations' ORDER BY TABLE_NAME"))[0].map(row => row.name);
  for (const name of names) {
    const columns = previous?.[name].columns || (await pool.query('SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION', [name]))[0].map(row => row.name);
    const [rows] = await pool.query(`SELECT ${columns.map(mysql.escapeId).join(', ')} FROM ${mysql.escapeId(name)}`);
    snapshot[name] = { columns, rows: rows.length, sha256: createHash('sha256').update(rows.map(row => JSON.stringify(row)).sort().join('\n')).digest('hex') };
  }
  return snapshot;
}

async function schemaSnapshot(pool) {
  const result = {};
  const [tables] = await pool.query('SHOW FULL TABLES');
  for (const row of tables) {
    const name = Object.values(row)[0];
    const [[definition]] = await pool.query(`SHOW CREATE TABLE ${mysql.escapeId(name)}`);
    result[name] = definition['Create Table'].replace(/AUTO_INCREMENT=\d+ /g, '');
  }
  return result;
}

async function seedMigrationRecovery(pool, directory) {
  await assertPrivate(pool, directory);
  const [[existing]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'migration_qa_%'");
  if (Number(existing.n)) {
    assert.equal(Number(existing.n), 44);
    for (const [table, count] of Object.entries({ reports: 120, community_comments: 60, report_coordination_messages: 20 })) assert.equal(Number((await pool.query(`SELECT COUNT(*) AS n FROM ${mysql.escapeId(table)}`))[0][0].n), count);
    return { citizens: 30, officials: 12, administrators: 2, reports: 120, possibleDuplicatePairs: 25, commentsAndReplies: 60, internalMessages: 20, replayed: true };
  }
  const [barangays] = await pool.query('SELECT id, name FROM barangays ORDER BY id LIMIT 6');
  const password = await bcrypt.hash('SyntheticMigrationOnly123!', 4);
  const upload = path.join(directory, 'uploads');
  await fs.mkdir(upload, { recursive: true });
  for (const file of ['synthetic-evidence-a.png', 'synthetic-evidence-b.png', 'synthetic-proof.png']) await fs.writeFile(path.join(upload, file), PNG_BYTES);
  const connection = await pool.getConnection();
  const at = minutes => new Date(Date.UTC(2026, 8, 1, 0, minutes)).toISOString().slice(0, 19).replace('T', ' ');
  try {
    await connection.beginTransaction();
    for (let i = 0; i < barangays.length; i++) {
      const x = 122.90 + i * 0.01, y = 10.60 + i * 0.01;
      const polygon = { type: 'Polygon', coordinates: [[[x - 0.003, y - 0.003], [x + 0.003, y - 0.003], [x + 0.003, y + 0.035], [x - 0.003, y + 0.035], [x - 0.003, y - 0.003]]] };
      await connection.execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ?, updated_at = ? WHERE id = ?', [JSON.stringify(polygon), 'SYNTHETIC isolated migration fixture; not official Bacolod boundaries', 'migration-qa-v1', at(0), barangays[i].id]);
    }
    for (let i = 0; i < 44; i++) {
      const role = i < 30 ? 'citizen' : i < 42 ? 'barangay' : 'admin';
      const barangay = barangays[role === 'barangay' ? Math.floor((i - 30) / 2) : i % 6];
      await connection.execute('INSERT INTO users (id, username, password_hash, role, barangay, barangay_id, full_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [i + 1, `migration_qa_${String(i + 1).padStart(2, '0')}`, password, role, barangay.name, barangay.id, `Synthetic ${role} ${i + 1}`, 'active', at(0), at(0)]);
    }
    await connection.execute("INSERT INTO user_permissions (user_id, permission, granted_by, granted_at) VALUES (43, 'admin:create', NULL, ?)", [at(0)]);
    await connection.execute("UPDATE admin_initialization SET initialized_at = ?, initialized_by = 43, source = 'legacy' WHERE id = 1", [at(0)]);
    const categories = ['pothole', 'road_crack', 'broken_streetlight', 'clogged_drainage'];
    const approved = [];
    for (let i = 0; i < 120; i++) {
      const pair = i < 50 ? Math.floor(i / 2) : i;
      const b = barangays[pair % 6], citizen = i % 30 + 1, official = 31 + pair % 6 * 2;
      const state = i < 50 ? 'pending' : ['pending', 'ongoing', 'resolved', 'rejected'][i % 4];
      const classification = [null, 'MINOR', 'MAJOR'][i % 3], priority = classification === 'MINOR' ? 'Low' : classification === 'MAJOR' ? 'High' : null;
      const body = `Synthetic ${categories[pair % 4]} observation at fictional test segment ${pair + 1}.`;
      await connection.execute('INSERT INTO reports (id, description, location, barangay, barangay_id, jurisdiction_source, boundary_check_status, latitude, longitude, gps_accuracy, ai_category, ai_classification, ai_priority, ai_confidence, vision_detected, status, submitted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [i + 1, body, `Fictional test segment ${pair + 1}`, b.name, b.id, 'citizen_declared', 'inside_service_area', 10.60 + pair % 6 * 0.01 + Math.floor(pair / 6) * 0.0015, 122.90 + pair % 6 * 0.01, 15, categories[pair % 4], classification, priority, 0, 0, state, citizen, at(i), at(i + 5)]);
      for (let n = 0; n < 2; n++) await connection.execute('INSERT INTO report_images (report_id, image_path, image_order, file_size, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?)', [i + 1, `/uploads/synthetic-evidence-${n ? 'b' : 'a'}.png`, n + 1, PNG_BYTES.length, 'image/png', at(i)]);
      const states = state === 'resolved' ? ['pending', 'ongoing', 'resolved'] : state === 'pending' ? ['pending'] : ['pending', state];
      for (let n = 0; n < states.length; n++) {
        const [history] = await connection.execute('INSERT INTO report_status_history (report_id, old_status, new_status, changed_by, note, request_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [i + 1, states[n - 1] || null, states[n], n ? official : citizen, 'Synthetic historical workflow fixture, not an AI assessment.', `migration-qa-seed-status-${i}-${n}`, 'a'.repeat(64), at(i + n)]);
        if (states[n] === 'resolved') await connection.execute('INSERT INTO report_action_proofs (history_id, image_path, image_order, mime_type, file_size) VALUES (?, ?, 1, ?, ?)', [history.insertId, '/uploads/synthetic-proof.png', 'image/png', PNG_BYTES.length]);
      }
      if (classification) await connection.execute('INSERT INTO report_severity_reviews (report_id, reviewed_by, category, classification, priority, previous_classification, reason, evidence, policy_version, recommendation, request_key, request_hash, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)', [i + 1, official, categories[pair % 4], classification, priority, 'Synthetic reviewer-confirmed historical impact for migration preservation.', JSON.stringify({ safety_impact: 'Fictional inspection evidence; no model accuracy claim.' }), 'synthetic-manual-v1', `migration-qa-seed-severity-${i}`, 'b'.repeat(64), at(i + 3)]);
      const publication = ['approved', 'pending_approval', 'rejected'][i % 3], admin = 43 + i % 2;
      let post = null;
      if (publication === 'approved') {
        const [created] = await connection.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [b.id, citizen, body, i + 1, `migration-qa-seed-post-${i}`, 'c'.repeat(64), at(i + 2), at(i + 2)]);
        post = created.insertId; approved.push({ id: post, author: citizen, barangayIndex: pair % 6 });
        for (let n = 0; n < 2; n++) await connection.execute('INSERT INTO community_media (post_id, storage_reference, image_order) VALUES (?, ?, ?)', [post, `/uploads/synthetic-evidence-${n ? 'b' : 'a'}.png`, n + 1]);
      }
      await connection.execute('INSERT INTO community_publication_requests (id, report_id, requested_by, barangay_id, state, body, request_key, request_hash, assigned_admin_id, reviewed_by, rejection_reason, post_id, requested_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [i + 1, i + 1, citizen, b.id, publication, body, `migration-qa-seed-publication-${i}`, 'd'.repeat(64), admin, publication === 'pending_approval' ? null : admin, publication === 'rejected' ? 'Synthetic public-content rejection with report preserved.' : null, post, at(i), publication === 'pending_approval' ? null : at(i + 2)]);
      for (let n = 0; n < 2; n++) await connection.execute('INSERT INTO community_publication_media (request_id, image_order, storage_reference) VALUES (?, ?, ?)', [i + 1, n + 1, `/uploads/synthetic-evidence-${n ? 'b' : 'a'}.png`]);
      if (publication !== 'pending_approval') await connection.execute('INSERT INTO community_publication_reviews (request_id, version, reviewer_id, decision, reason, reviewed_at) VALUES (?, 1, ?, ?, ?, ?)', [i + 1, admin, publication, publication === 'rejected' ? 'Synthetic public-content rejection.' : null, at(i + 2)]);
    }
    const roots = [];
    for (let i = 0; i < 60; i++) {
      const target = i < 30 ? approved[i] : approved[i - 30], user = target.barangayIndex + 1 + (i < 30 ? 0 : 6);
      const [created] = await connection.execute('INSERT INTO community_comments (post_id, parent_id, author_id, body, request_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [target.id, i < 30 ? null : roots[i - 30], user, `Synthetic public ${i < 30 ? 'comment' : 'reply'} ${i + 1}.`, `migration-qa-seed-comment-${i}`, at(180 + i), at(180 + i)]);
      if (i < 30) roots.push(created.insertId);
      await connection.execute('INSERT IGNORE INTO community_personas (post_id, user_id, display_name, avatar_variant, created_at) VALUES (?, ?, ?, ?, ?)', [target.id, user, `SyntheticPerson_${user}`, user % 8, at(180 + i)]);
    }
    for (let i = 0; i < 20; i++) {
      const report = Math.floor(i / 2) + 1, b = Math.floor((report - 1) / 2) % 6, sender = i % 2 ? 31 + b * 2 : 43;
      await connection.execute('INSERT INTO report_coordination_messages (report_id, sender_id, sender_role, body, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?)', [report, sender, i % 2 ? 'barangay' : 'admin', `Synthetic internal follow-up ${i + 1}; no personal information.`, `migration-qa-seed-message-${i}`, at(300 + i)]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  return { citizens: 30, officials: 12, administrators: 2, reports: 120, possibleDuplicatePairs: 25, commentsAndReplies: 60, internalMessages: 20, replayed: false };
}

module.exports = { assertPrivate, sourceRunner, tableSnapshot, schemaSnapshot, seedMigrationRecovery };
