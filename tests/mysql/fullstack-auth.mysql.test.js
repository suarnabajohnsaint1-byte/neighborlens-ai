const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const jwt = require('jsonwebtoken');

const {
  TEST_DB_NAME,
  TEST_ADMIN,
  recreateTestDatabase,
  useTestDatabaseEnvironment,
  seedTestAdmin,
  startServerProcess
} = require('../support/mysql-test-db');

useTestDatabaseEnvironment();

const { getPool, closePool } = require('../../server/infrastructure/database/mysql/pool');
const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
const passwordHasher = require('../../server/infrastructure/security/passwordHasher');
const { bootstrapAdmin, readBootstrapCredentials } = require('../../server/infrastructure/database/mysql/bootstrapAdmin');
const { getDatabase, resetDatabase } = require('../../server/infrastructure/database');
const { startSignedEnrollment } = require('../support/signed-enrollment');
const { reportGpsFields } = require('../support/citizens');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');

const OFFICIAL_PASSWORD = 'Official1234';
const state = {};
let server;
let baseUrl;
let enrollment;

function q(sql, params = []) {
  return getPool().query(sql, params).then(([rows]) => rows);
}

async function versionOf(id) {
  const [row] = await q('SELECT account_version FROM users WHERE id = ?', [id]);
  return row.account_version;
}

function api(path, { token, method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined)
  });
}

async function json(response) {
  return response.json().catch(() => ({}));
}

async function login(username, password) {
  const [account] = await q('SELECT role FROM users WHERE username = ?', [username]);
  const portal = account?.role || 'citizen';
  const response = await api(`/api/auth/${portal}/login`, { method: 'POST', body: { username, password } });
  return { status: response.status, body: await json(response) };
}

async function registerCitizen(prefix, barangay) {
  const username = `${prefix}_${Date.now()}`;
  const response = await api('/api/auth/register', {
    method: 'POST',
    body: await enrollment.registrationPayload(baseUrl, { username, password: 'citizen123', barangay })
  });
  assert.equal(response.status, 201);
  return { username, ...(await json(response)) };
}

function reportForm(description, barangay, gpsBarangay = barangay) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    description, barangay, location: 'Lacson Street', ...reportGpsFields(gpsBarangay)
  })) form.append(key, String(value));
  form.append('images', new File([JPEG_BYTES], 'a.jpg', { type: 'image/jpeg' }));
  form.append('images', new File([SECOND_JPEG_BYTES], 'b.jpg', { type: 'image/jpeg' }));
  return form;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

test.before(async () => {
  await recreateTestDatabase();
  await runMigrations(getPool());
  await seedTestAdmin(getPool(), passwordHasher);
  enrollment = await startSignedEnrollment();
  const { stubInference } = require('../support/test-app');
  stubInference(async () => ({ detections: [{ class: 'pothole', confidence: 0.91, severity_level: 'high' }] }));
  const app = require('../../server/app');
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  enrollment?.close();
  await getDatabase().close().catch(() => {});
  resetDatabase();
  await closePool().catch(() => {});
});

test('the suite runs against the isolated MySQL test database, never the dev database', async () => {
  const [{ db }] = await q('SELECT DATABASE() AS db');
  assert.equal(db, TEST_DB_NAME);
  assert.equal(getDatabase().driver, 'mysql');
});

test('phase 1: migrations seed exactly 61 official barangays with stable ids and rerun as a no-op', async () => {
  const [{ total, distinctNames, minId, maxId }] = await q(
    'SELECT COUNT(*) AS total, COUNT(DISTINCT name) AS distinctNames, MIN(id) AS minId, MAX(id) AS maxId FROM barangays'
  );
  assert.deepEqual([Number(total), Number(distinctNames), Number(minId), Number(maxId)], [61, 61, 1, 61]);
  const [first, villamonte] = await Promise.all([
    q("SELECT id, region FROM barangays WHERE name = 'Barangay 1'"),
    q("SELECT id FROM barangays WHERE name = 'Villamonte'")
  ]);
  assert.equal(first[0].id, 1);
  assert.equal(first[0].region, 'Negros Island Region (NIR)');
  assert.equal(villamonte[0].id, 60);

  const rerun = await runMigrations(getPool());
  assert.deepEqual(rerun.applied, []);
  const [{ after }] = await q('SELECT COUNT(*) AS after FROM barangays');
  assert.equal(Number(after), 61);

  const response = await api('/api/barangays');
  assert.equal(response.status, 200);
  const { barangays } = await json(response);
  assert.equal(barangays.length, 61);
  assert.deepEqual(barangays.map(b => b.id), Array.from({ length: 61 }, (_, i) => i + 1));
});

test('phase 1: the database rejects duplicate barangays and officials without a valid barangay', async () => {
  await assert.rejects(q("INSERT INTO barangays (name) VALUES ('Villamonte')"), { code: 'ER_DUP_ENTRY' });
  await assert.rejects(
    q("INSERT INTO users (username, password_hash, role, barangay) VALUES ('orphan_official', 'x', 'barangay', 'Nowhere')"),
    { code: 'ER_CHECK_CONSTRAINT_VIOLATED' }
  );
  await assert.rejects(
    q("INSERT INTO users (username, password_hash, role, barangay, barangay_id) VALUES ('ghost_official', 'x', 'barangay', 'Ghost', 999)"),
    { code: 'ER_NO_REFERENCED_ROW_2' }
  );
});

test('phase 2: admin and citizens sign in against MySQL', async () => {
  const admin = await login(TEST_ADMIN.username, TEST_ADMIN.password);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.user.role, 'admin');
  assert.equal(admin.body.user.password_hash, undefined);
  state.admin = admin.body;

  state.citizenA = await registerCitizen('citizen_a', 'Villamonte');
  state.citizenB = await registerCitizen('citizen_b', 'Barangay 1');
  const rows = await q('SELECT username, role, barangay_id FROM users WHERE username IN (?, ?) ORDER BY id', [state.citizenA.username, state.citizenB.username]);
  assert.deepEqual(rows.map(r => [r.role, r.barangay_id]), [['citizen', 60], ['citizen', 1]]);
});

test('phase 2: admin creates barangay officials that are inserted into MySQL with bcrypt hashes', async () => {
  for (const [key, barangayId, prefix] of [['officialA', 60, 'brgy_villamonte'], ['officialB', 1, 'brgy_one']]) {
    const username = `${prefix}_${Date.now()}`;
    const response = await api('/api/admin/barangay-users', {
      token: state.admin.token,
      method: 'POST',
      body: { username, password: OFFICIAL_PASSWORD, barangayId, fullName: `Captain ${prefix}`, role: 'admin' }
    });
    assert.equal(response.status, 201);
    const body = await json(response);
    assert.equal(body.user.role, 'barangay');
    assert.equal(body.user.barangayId, barangayId);
    assert.equal(body.user.password_hash, undefined);
    assert.equal(JSON.stringify(body).includes(OFFICIAL_PASSWORD), false);

    const [row] = await q('SELECT id, role, status, barangay_id, password_hash, token_version FROM users WHERE username = ?', [username]);
    assert.equal(row.role, 'barangay');
    assert.equal(row.status, 'active');
    assert.equal(row.barangay_id, barangayId);
    assert.match(row.password_hash, /^\$2[aby]\$12\$/);
    assert.ok(passwordHasher.verify(OFFICIAL_PASSWORD, row.password_hash));
    state[key] = { id: row.id, username, barangayId };
  }

  const audit = await q("SELECT actor_id, entity_id FROM audit_logs WHERE action = 'official_create' ORDER BY id");
  assert.deepEqual(audit.map(a => a.entity_id), [state.officialA.id, state.officialB.id]);
  assert.ok(audit.every(a => a.actor_id === state.admin.user.id));
});

test('phase 2: official creation validates input and rejects duplicates and unknown barangays', async () => {
  const cases = [
    [{ username: state.officialA.username, password: OFFICIAL_PASSWORD, barangayId: 60 }, 409],
    [{ username: `nobrgy_${Date.now()}`, password: OFFICIAL_PASSWORD, barangayId: 999 }, 400],
    [{ username: `fakebrgy_${Date.now()}`, password: OFFICIAL_PASSWORD, barangay: 'Barangay Central' }, 400],
    [{ username: `weak_${Date.now()}`, password: 'short1', barangayId: 1 }, 400],
    [{ username: `letters_${Date.now()}`, password: 'onlyletters', barangayId: 1 }, 400],
    [{ username: 'x', password: OFFICIAL_PASSWORD, barangayId: 1 }, 400]
  ];
  for (const [body, expected] of cases) {
    const response = await api('/api/admin/barangay-users', { token: state.admin.token, method: 'POST', body });
    assert.equal(response.status, expected, JSON.stringify(body));
  }
  const [{ officials }] = await q("SELECT COUNT(*) AS officials FROM users WHERE role = 'barangay'");
  assert.equal(Number(officials), 2);
});

test('phase 2: only administrators can manage accounts', async () => {
  const officialSession = await login(state.officialA.username, OFFICIAL_PASSWORD);
  assert.equal(officialSession.status, 200);
  state.officialA.token = officialSession.body.token;

  const body = { username: `escalate_${Date.now()}`, password: OFFICIAL_PASSWORD, barangayId: 1 };
  for (const [token, expected] of [[undefined, 401], [state.citizenA.token, 403], [state.officialA.token, 403]]) {
    assert.equal((await api('/api/admin/barangay-users', { token, method: 'POST', body })).status, expected);
    assert.equal((await api('/api/admin/barangay-users', { token })).status, expected);
    assert.equal((await api(`/api/admin/barangay-users/${state.officialB.id}/status`, { token, method: 'PATCH', body: { status: 'suspended', version: 0 } })).status, expected);
    assert.equal((await api('/api/admin/audit-logs', { token })).status, expected);
  }
  const [{ total }] = await q('SELECT COUNT(*) AS total FROM users WHERE username = ?', [body.username]);
  assert.equal(Number(total), 0);
});

test('phase 2: the admin account list comes from MySQL and never exposes credentials', async () => {
  const response = await api('/api/admin/barangay-users', { token: state.admin.token });
  assert.equal(response.status, 200);
  const { users } = await json(response);
  assert.deepEqual(users.map(u => u.username).sort(), [state.officialA.username, state.officialB.username].sort());
  for (const user of users) {
    assert.equal(user.password_hash, undefined);
    assert.equal(user.token_version, undefined);
    assert.equal(user.status, 'active');
  }
  const detail = await json(await api(`/api/admin/barangay-users/${state.officialA.id}`, { token: state.admin.token }));
  assert.equal(detail.user.barangay, 'Villamonte');
  assert.equal((await api(`/api/admin/barangay-users/${state.citizenA.user.id}`, { token: state.admin.token })).status, 404);
});

test('phase 3: barangay login verifies bcrypt credentials without revealing which part failed', async () => {
  const wrongPassword = await login(state.officialA.username, 'Wrong12345');
  const unknownUser = await login(`missing_${Date.now()}`, 'Wrong12345');
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.body.error, unknownUser.body.error);

  const ok = await login(state.officialA.username, OFFICIAL_PASSWORD);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'barangay');
  assert.equal(ok.body.user.barangay, 'Villamonte');
  assert.equal(ok.body.user.barangay_id, 60);
  state.officialA.token = ok.body.token;

  const me = await json(await api('/api/me', { token: state.officialA.token }));
  assert.deepEqual(me.user, { id: state.officialA.id, username: state.officialA.username, role: 'barangay', barangay: 'Villamonte', barangay_id: 60 });

  state.officialB.token = (await login(state.officialB.username, OFFICIAL_PASSWORD)).body.token;
});

test('routing: login returns the authoritative database role for each portal and ignores a requested role', async () => {
  for (const [username, password, role] of [
    [TEST_ADMIN.username, TEST_ADMIN.password, 'admin'],
    [state.officialA.username, OFFICIAL_PASSWORD, 'barangay'],
    [state.citizenA.username, 'citizen123', 'citizen']
  ]) {
    const response = await api(`/api/auth/${role}/login`, { method: 'POST', body: { username, password, role: 'admin' } });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.user.role, role);
    const me = await json(await api('/api/me', { token: body.token }));
    assert.equal(me.user.role, role);
  }
  state.officialA.token = (await login(state.officialA.username, OFFICIAL_PASSWORD)).body.token;
  state.citizenA.token = (await login(state.citizenA.username, 'citizen123')).body.token;
});

test('phase 4: a citizen report is persisted with the matching barangay relationship', async () => {
  const response = await api('/api/reports', { token: state.citizenA.token, method: 'POST', form: reportForm('Deep pothole near the plaza', 'villamonte', 'Villamonte') });
  assert.equal(response.status, 201);
  const report = await json(response);
  state.report = report;

  const [row] = await q('SELECT barangay, barangay_id, jurisdiction_source, status, submitted_by FROM reports WHERE id = ?', [report.id]);
  assert.equal(row.barangay, 'Villamonte');
  assert.equal(row.barangay_id, 60);
  assert.equal(row.jurisdiction_source, 'geofence_resolved');
  assert.equal(row.status, 'pending');
  assert.equal(row.submitted_by, state.citizenA.user.id);

  const attempt = await api('/api/reports', { token: state.citizenB.token, method: 'POST',
    form: reportForm('Cross-barangay report', 'Barangay 1', 'Villamonte') });
  assert.equal(attempt.status, 403);
  assert.equal((await json(attempt)).code, 'REPORT_BARANGAY_MISMATCH');
  const historical = await getDatabase().execute(
    'INSERT INTO reports (description, barangay, submitted_by) VALUES (?, ?, ?)',
    ['Historical report without confirmed barangay', 'Barangay Central', state.citizenB.user.id]);
  state.unmatchedReport = { id: historical.insertId };

  const [notification] = await q("SELECT type FROM notifications WHERE report_id = ? AND user_id = ?", [report.id, state.citizenA.user.id]);
  assert.equal(notification.type, 'report_submitted');
});

test('phase 4: only the assigned barangay can see and act on the report', async () => {
  const listA = await json(await api('/api/reports', { token: state.officialA.token }));
  const listB = await json(await api('/api/reports', { token: state.officialB.token }));
  assert.ok(listA.reports.some(r => r.id === state.report.id));
  assert.ok(listA.reports.every(r => r.barangay_id === 60));
  assert.equal(listB.reports.some(r => r.id === state.report.id), false);
  assert.equal(listB.reports.some(r => r.id === state.unmatchedReport.id), false);
  assert.equal(listA.stats.total, listA.reports.length);

  const id = state.report.id;
  assert.equal((await api(`/api/reports/${id}`, { token: state.officialB.token })).status, 403);
  assert.equal((await api(`/api/reports/${id}/history`, { token: state.officialB.token })).status, 403);
  assert.equal((await api(`/api/reports/${id}/status`, { token: state.officialB.token, method: 'PATCH', body: { status: 'ongoing' } })).status, 403);
  assert.equal((await api(`/api/reports/${id}/status`, { token: state.citizenA.token, method: 'PATCH', body: { status: 'ongoing' } })).status, 403);
  assert.equal((await api(`/api/reports/${id}`, { token: state.citizenB.token })).status, 403);
  assert.equal((await api(`/api/reports?barangay=Villamonte`, { token: state.officialB.token })).status, 400);

  const [row] = await q('SELECT status FROM reports WHERE id = ?', [id]);
  assert.equal(row.status, 'pending');
});

test('phase 4: an authorized status change persists status, history, audit, and the citizen notification', async () => {
  const id = state.report.id;
  const response = await api(`/api/reports/${id}/status`, {
    token: state.officialA.token, method: 'PATCH', body: { status: 'ongoing', note: 'Crew dispatched' }
  });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).status, 'ongoing');

  const [report] = await q('SELECT status FROM reports WHERE id = ?', [id]);
  assert.equal(report.status, 'ongoing');
  const history = await q('SELECT old_status, new_status, changed_by, note FROM report_status_history WHERE report_id = ?', [id]);
  assert.deepEqual(history.map(h => [h.old_status, h.new_status, h.changed_by, h.note]), [['pending', 'ongoing', state.officialA.id, 'Crew dispatched']]);
  const [audit] = await q("SELECT actor_id, details FROM audit_logs WHERE action = 'status_update' AND entity_id = ?", [id]);
  assert.equal(audit.actor_id, state.officialA.id);
  const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
  assert.deepEqual(details, { from: 'pending', to: 'ongoing', barangay_id: 60 });

  const notes = await json(await api('/api/notifications', { token: state.citizenA.token }));
  assert.ok(notes.notifications.some(n => n.reportId === id && n.type === 'status_update'));
  const otherNotes = await json(await api('/api/notifications', { token: state.citizenB.token }));
  assert.equal(otherNotes.notifications.some(n => n.reportId === id), false);

  const adminView = await json(await api('/api/reports', { token: state.admin.token }));
  assert.equal(adminView.reports.find(r => r.id === id).status, 'ongoing');

  const apiHistory = await json(await api(`/api/reports/${id}/history`, { token: state.citizenA.token }));
  assert.equal(apiHistory.history[0].note, 'Crew dispatched');
  assert.equal(apiHistory.history[0].changed_by_username, undefined);
  const staffHistory = await json(await api(`/api/reports/${id}/history`, { token: state.admin.token }));
  assert.equal(staffHistory.history[0].changed_by_username, state.officialA.username);

  assert.equal((await api(`/api/reports/${id}/status`, { token: state.officialA.token, method: 'PATCH', body: { status: 'pending' } })).status, 400);
  assert.equal((await api(`/api/reports/${id}/status`, { token: state.officialA.token, method: 'PATCH', body: { status: 'resolved', note: 'x'.repeat(501) } })).status, 400);
});

test('phase 2/3: admin updates and reassigns an official; reassignment ends the old session', async () => {
  const response = await api(`/api/admin/barangay-users/${state.officialA.id}`, {
    token: state.admin.token, method: 'PATCH', body: { fullName: 'Kapitan Updated', version: await versionOf(state.officialA.id) }
  });
  assert.equal(response.status, 200);
  let [row] = await q('SELECT full_name, barangay_id, token_version FROM users WHERE id = ?', [state.officialA.id]);
  assert.equal(row.full_name, 'Kapitan Updated');
  assert.equal(row.token_version, 0);
  assert.equal((await api('/api/me', { token: state.officialA.token })).status, 200);

  const reassign = await api(`/api/admin/barangay-users/${state.officialA.id}`, {
    token: state.admin.token, method: 'PATCH', body: { barangayId: 2, version: await versionOf(state.officialA.id) }
  });
  assert.equal(reassign.status, 200);
  [row] = await q('SELECT barangay, barangay_id, token_version FROM users WHERE id = ?', [state.officialA.id]);
  assert.deepEqual([row.barangay, row.barangay_id, row.token_version], ['Barangay 2', 2, 1]);

  assert.equal((await api('/api/reports', { token: state.officialA.token })).status, 401);
  const relogin = await login(state.officialA.username, OFFICIAL_PASSWORD);
  assert.equal(relogin.body.user.barangay_id, 2);
  const list = await json(await api('/api/reports', { token: relogin.body.token }));
  assert.equal(list.reports.some(r => r.id === state.report.id), false);

  await api(`/api/admin/barangay-users/${state.officialA.id}`, { token: state.admin.token, method: 'PATCH', body: { barangayId: 60, version: await versionOf(state.officialA.id) } });
  state.officialA.token = (await login(state.officialA.username, OFFICIAL_PASSWORD)).body.token;
  assert.equal((await api(`/api/reports/${state.report.id}`, { token: state.officialA.token })).status, 200);
});

test('phase 3/5: suspension is persisted and enforced on login and on existing sessions', async () => {
  const stale = state.officialB.token;
  const suspend = await api(`/api/admin/barangay-users/${state.officialB.id}/status`, {
    token: state.admin.token, method: 'PATCH', body: { status: 'suspended', version: await versionOf(state.officialB.id) }
  });
  assert.equal(suspend.status, 200);
  const [row] = await q('SELECT status, token_version FROM users WHERE id = ?', [state.officialB.id]);
  assert.equal(row.status, 'suspended');
  assert.ok(row.token_version >= 1);

  assert.equal((await api('/api/reports', { token: stale })).status, 401);
  const blocked = await login(state.officialB.username, OFFICIAL_PASSWORD);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /suspended/i);
  const wrong = await login(state.officialB.username, 'Wrong12345');
  assert.equal(wrong.status, 401);

  assert.equal((await api(`/api/admin/barangay-users/${state.officialB.id}/status`, { token: state.admin.token, method: 'PATCH', body: { status: 'suspended', version: await versionOf(state.officialB.id) } })).status, 409);
  assert.equal((await api(`/api/admin/barangay-users/${state.officialB.id}/status`, { token: state.admin.token, method: 'PATCH', body: { status: 'deleted', version: await versionOf(state.officialB.id) } })).status, 400);

  const reactivate = await api(`/api/admin/barangay-users/${state.officialB.id}/status`, {
    token: state.admin.token, method: 'PATCH', body: { status: 'active', version: await versionOf(state.officialB.id) }
  });
  assert.equal(reactivate.status, 200);
  const again = await login(state.officialB.username, OFFICIAL_PASSWORD);
  assert.equal(again.status, 200);
  state.officialB.token = again.body.token;

  const actions = (await q("SELECT action FROM audit_logs WHERE entity_id = ? AND action LIKE 'official_%' ORDER BY id", [state.officialB.id])).map(r => r.action);
  assert.deepEqual(actions, ['official_create', 'official_suspend', 'official_activate']);
});

test('phase 5: an admin password reset revokes sessions and replaces the bcrypt hash', async () => {
  const stale = state.officialB.token;
  const newPassword = 'Rotated9876';
  assert.equal((await api(`/api/admin/barangay-users/${state.officialB.id}/password`, { token: state.admin.token, method: 'POST', body: { password: 'weak', version: await versionOf(state.officialB.id) } })).status, 400);
  const reset = await api(`/api/admin/barangay-users/${state.officialB.id}/password`, {
    token: state.admin.token, method: 'POST', body: { password: newPassword, version: await versionOf(state.officialB.id) }
  });
  assert.equal(reset.status, 200);
  assert.equal(JSON.stringify(await json(reset)).includes(newPassword), false);

  assert.equal((await api('/api/me', { token: stale })).status, 401);
  assert.equal((await login(state.officialB.username, OFFICIAL_PASSWORD)).status, 401);
  const fresh = await login(state.officialB.username, newPassword);
  assert.equal(fresh.status, 200);
  state.officialB.token = fresh.body.token;
  state.officialB.password = newPassword;

  const logs = await q("SELECT details FROM audit_logs WHERE action = 'official_password_reset'");
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes(newPassword), false);
});

test('phase 5: logout revokes the token server-side', async () => {
  const session = await login(state.citizenB.username, 'citizen123');
  assert.equal((await api('/api/me', { token: session.body.token })).status, 200);
  assert.equal((await api('/api/auth/logout', { token: session.body.token, method: 'POST' })).status, 200);
  assert.equal((await api('/api/me', { token: session.body.token })).status, 401);
  assert.equal((await api('/api/auth/logout', { token: session.body.token, method: 'POST' })).status, 401);
  const next = await login(state.citizenB.username, 'citizen123');
  assert.equal(next.status, 200);
  state.citizenB.token = next.body.token;
});

test('phase 5: tokens are never accepted from query parameters and forged or expired tokens fail', async () => {
  const token = state.admin.token;
  assert.equal((await fetch(`${baseUrl}/api/reports?token=${encodeURIComponent(token)}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/audit-logs?token=${encodeURIComponent(token)}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/notifications/stream?token=${encodeURIComponent(token)}`)).status, 401);

  const secret = process.env.JWT_SECRET || 'development-only-change-me';
  const forgedRole = jwt.sign({ id: state.citizenA.user.id, username: state.citizenA.username, role: 'admin', tv: 0 }, secret, { expiresIn: '1h' });
  assert.equal((await api('/api/admin/barangay-users', { token: forgedRole })).status, 401);
  const forgedBarangay = jwt.sign({ id: state.officialB.id, role: 'barangay', barangay: 'Villamonte', tv: 99 }, secret, { expiresIn: '1h' });
  assert.equal((await api('/api/reports', { token: forgedBarangay })).status, 401);
  const expired = jwt.sign({ id: state.admin.user.id, role: 'admin', tv: 0 }, secret, { expiresIn: -10 });
  assert.equal((await api('/api/admin/users', { token: expired })).status, 401);
  const wrongKey = jwt.sign({ id: state.admin.user.id, role: 'admin', tv: 0 }, 'not-the-secret', { expiresIn: '1h' });
  assert.equal((await api('/api/admin/users', { token: wrongKey })).status, 401);
  assert.equal((await api('/api/admin/users', { token: 'garbage' })).status, 401);
});

test('phase 5: notification streams use single-use tickets bound to the live session', async () => {
  const issue = await api('/api/notifications/stream-ticket', { token: state.citizenA.token, method: 'POST' });
  assert.equal(issue.status, 200);
  const { ticket, expiresInSeconds } = await json(issue);
  assert.ok(expiresInSeconds <= 30);

  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  controller.abort();

  assert.equal((await fetch(`${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`)).status, 401);

  const session = await login(state.citizenA.username, 'citizen123');
  const second = await json(await api('/api/notifications/stream-ticket', { token: session.body.token, method: 'POST' }));
  await api('/api/auth/logout', { token: session.body.token, method: 'POST' });
  assert.equal((await fetch(`${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(second.ticket)}`)).status, 401);
  state.citizenA.token = (await login(state.citizenA.username, 'citizen123')).body.token;
});

test('phase 5: admin audit logs come from MySQL with pagination and no secrets', async () => {
  const response = await api('/api/admin/audit-logs?limit=5', { token: state.admin.token });
  assert.equal(response.status, 200);
  const page = await json(response);
  assert.equal(page.logs.length, 5);
  const [{ total }] = await q('SELECT COUNT(*) AS total FROM audit_logs');
  assert.equal(page.total, Number(total));
  assert.ok(page.logs[0].id > page.logs[4].id);
  assert.ok(page.logs.every(log => log.created_at));

  const next = await json(await api('/api/admin/audit-logs?limit=5&offset=5', { token: state.admin.token }));
  assert.ok(next.logs[0].id < page.logs[4].id);

  const filtered = await json(await api('/api/admin/audit-logs?action=official_create', { token: state.admin.token }));
  assert.equal(filtered.total, 2);
  assert.ok(filtered.logs.every(log => log.action === 'official_create' && log.actor_username === TEST_ADMIN.username));

  assert.equal((await api('/api/admin/audit-logs?limit=0', { token: state.admin.token })).status, 400);
  assert.equal((await api('/api/admin/audit-logs?action=DROP%20TABLE', { token: state.admin.token })).status, 400);

  const serialized = JSON.stringify((await json(await api('/api/admin/audit-logs?limit=200', { token: state.admin.token }))).logs);
  for (const secret of [OFFICIAL_PASSWORD, state.officialB.password, 'citizen123', state.admin.token]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('phase 5: the admin bootstrap never overwrites an existing administrator or accepts a default password', async () => {
  const [before] = await q("SELECT id, password_hash FROM users WHERE role = 'admin'");
  const result = await bootstrapAdmin(getPool(), { BOOTSTRAP_ADMIN_USERNAME: 'second_admin', BOOTSTRAP_ADMIN_PASSWORD: 'SomethingLong123' });
  assert.equal(result.created, false);
  const admins = await q("SELECT id, password_hash FROM users WHERE role = 'admin'");
  assert.deepEqual(admins, [before]);
  assert.throws(() => readBootstrapCredentials({ BOOTSTRAP_ADMIN_USERNAME: 'root_admin', BOOTSTRAP_ADMIN_PASSWORD: 'admin123' }));
  assert.throws(() => readBootstrapCredentials({ BOOTSTRAP_ADMIN_USERNAME: 'root_admin' }));
});

test('phase 6: accounts, reports, and history survive a real backend restart', async () => {
  const port = await freePort();
  const backend = startServerProcess(port);
  try {
    await backend.ready;
    const restartedBase = `http://127.0.0.1:${port}`;
    const official = await fetch(`${restartedBase}/api/auth/barangay/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: state.officialA.username, password: OFFICIAL_PASSWORD })
    });
    assert.equal(official.status, 200);
    const { token } = await official.json();
    const list = await (await fetch(`${restartedBase}/api/reports`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const report = list.reports.find(r => r.id === state.report.id);
    assert.equal(report.status, 'ongoing');

    const accounts = await (await fetch(`${restartedBase}/api/admin/barangay-users`, { headers: { Authorization: `Bearer ${state.admin.token}` } })).json();
    assert.equal(accounts.users.length, 2);
    assert.ok(accounts.users.every(u => u.status === 'active'));

    const history = await (await fetch(`${restartedBase}/api/reports/${state.report.id}/history`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(history.history[0].note, 'Crew dispatched');
  } finally {
    await backend.stop();
  }
});
