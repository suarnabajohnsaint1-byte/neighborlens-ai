const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TEST_DB_NAME,
  TEST_ADMIN,
  recreateTestDatabase,
  useTestDatabaseEnvironment,
  seedTestAdmin
} = require('../support/mysql-test-db');

useTestDatabaseEnvironment();

const { getPool, closePool } = require('../../server/infrastructure/database/mysql/pool');
const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
const passwordHasher = require('../../server/infrastructure/security/passwordHasher');
const { readRecoveryRequest, runRecovery } = require('../../server/infrastructure/database/mysql/adminRecovery');
const { getDatabase, resetDatabase } = require('../../server/infrastructure/database');
const { stubInference } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const { seedCitizen, reportGpsFields } = require('../support/citizens');

const ADMIN_PASSWORD = 'AdminPassword2026';
const OFFICIAL_PASSWORD = 'Official2026';
const CITIZEN_PASSWORD = 'citizen2026';
const accounts = {};
let server;
let baseUrl;

function q(sql, params = []) {
  return getPool().query(sql, params).then(([rows]) => rows);
}

function api(pathName, { token, method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${pathName}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
}

async function json(response) {
  return response.json().catch(() => ({}));
}

async function login(username, password) {
  const [account] = await q('SELECT role FROM users WHERE username = ?', [username]);
  const portal = account?.role || 'admin';
  const response = await api(`/api/auth/${portal}/login`, { method: 'POST', body: { username, password } });
  return { status: response.status, body: await json(response) };
}

async function signIn(key, password) {
  const result = await login(accounts[key].username, password);
  assert.equal(result.status, 200, `${key} should sign in`);
  accounts[key].token = result.body.token;
  accounts[key].id = result.body.user.id;
  return result.body;
}

async function snapshot(ids) {
  const rows = await q(
    `SELECT id, username, password_hash, role, status, barangay_id, full_name, token_version, account_version, updated_at
     FROM users WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`,
    ids
  );
  const permissions = await q('SELECT user_id, permission FROM user_permissions ORDER BY user_id, permission');
  return JSON.stringify({ rows, permissions });
}

async function versionOf(id) {
  const [row] = await q('SELECT account_version FROM users WHERE id = ?', [id]);
  return row.account_version;
}

function reportForm(description, barangay) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ description, barangay, location: 'Test street', ...reportGpsFields(barangay) })) {
    form.append(key, String(value));
  }
  form.append('images', new File([JPEG_BYTES], 'a.jpg', { type: 'image/jpeg' }));
  form.append('images', new File([SECOND_JPEG_BYTES], 'b.jpg', { type: 'image/jpeg' }));
  return form;
}

test.before(async () => {
  await recreateTestDatabase();
  await runMigrations(getPool());
  await seedTestAdmin(getPool(), passwordHasher);
  stubInference(async () => ({ detections: [{ class: 'pothole', confidence: 0.9, severity_level: 'high' }] }));
  const app = require('../../server/app');
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await getDatabase().close().catch(() => {});
  resetDatabase();
  await closePool().catch(() => {});
});

test('fixtures run on the isolated MySQL test database', async () => {
  const [{ db }] = await q('SELECT DATABASE() AS db');
  assert.equal(db, TEST_DB_NAME);
});

test('migrations add the permission table and account versions without single-admin constraints', async () => {
  const [{ total }] = await q("SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user_permissions'", [TEST_DB_NAME]);
  assert.equal(Number(total), 1);
  const columns = await q("SHOW COLUMNS FROM users LIKE 'account_version'");
  assert.equal(columns.length, 1);
  const uniques = await q(
    "SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND NON_UNIQUE = 0",
    [TEST_DB_NAME]
  );
  assert.deepEqual(uniques.map(u => u.COLUMN_NAME).sort(), ['id', 'username']);
  await assert.rejects(q("INSERT INTO user_permissions (user_id, permission) VALUES (1, 'admin:delete')"), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  const unsafe = fs.readdirSync(path.join(__dirname, '../../server/infrastructure/repositories'))
    .filter(file => /REPLACE\s+INTO/i.test(fs.readFileSync(path.join(__dirname, '../../server/infrastructure/repositories', file), 'utf8')));
  assert.deepEqual(unsafe, []);
});

test('7.2: Admin C with admin:create provisions Admin A and Admin B with plain inserts', async () => {
  accounts.adminC = { username: TEST_ADMIN.username };
  await signIn('adminC', TEST_ADMIN.password);
  const before = await snapshot([accounts.adminC.id]);

  for (const key of ['adminA', 'adminB']) {
    const username = `${key.toLowerCase()}_${Date.now()}`;
    const response = await api('/api/admin/admins', {
      token: accounts.adminC.token, method: 'POST',
      body: { username, password: ADMIN_PASSWORD, fullName: `Administrator ${key}`, role: 'barangay', permissions: ['admin:create'] }
    });
    assert.equal(response.status, 201);
    const { user } = await json(response);
    assert.equal(user.role, 'admin');
    assert.deepEqual(user.permissions, []);
    accounts[key] = { username, id: user.id };
  }

  assert.equal(await snapshot([accounts.adminC.id]), before, 'creating admins must not modify Admin C');
  const rows = await q('SELECT id, role, password_hash FROM users WHERE id IN (?, ?)', [accounts.adminA.id, accounts.adminB.id]);
  assert.equal(new Set(rows.map(r => r.password_hash)).size, 2, 'each admin has an independent bcrypt hash');
  assert.ok(rows.every(r => r.role === 'admin' && /^\$2[aby]\$12\$/.test(r.password_hash)));
  const grants = await q("SELECT user_id FROM user_permissions WHERE permission = 'admin:create'");
  assert.deepEqual(grants.map(g => g.user_id), [accounts.adminC.id]);
  const audit = await q("SELECT actor_id, entity_id FROM audit_logs WHERE action = 'admin_create' ORDER BY id");
  assert.deepEqual(audit.map(a => [a.actor_id, a.entity_id]), [[accounts.adminC.id, accounts.adminA.id], [accounts.adminC.id, accounts.adminB.id]]);
});

test('7.1: Admin A and Admin B sign in independently with separate sessions', async () => {
  const a = await signIn('adminA', ADMIN_PASSWORD);
  const b = await signIn('adminB', ADMIN_PASSWORD);
  assert.notEqual(a.user.id, b.user.id);
  assert.equal((await json(await api('/api/me', { token: accounts.adminA.token }))).user.id, accounts.adminA.id);
  assert.equal((await json(await api('/api/me', { token: accounts.adminB.token }))).user.id, accounts.adminB.id);
  await api('/api/auth/logout', { token: accounts.adminA.token, method: 'POST' });
  assert.equal((await api('/api/me', { token: accounts.adminA.token })).status, 401);
  assert.equal((await api('/api/me', { token: accounts.adminB.token })).status, 200, 'Admin A logout must not end Admin B sessions');
  await signIn('adminA', ADMIN_PASSWORD);
});

test('7.3: administrators without admin:create, officials, and citizens cannot create administrators', async () => {
  accounts.citizenA = { username: `citizen_a_${Date.now()}` };
  await seedCitizen({
    username: accounts.citizenA.username, password: CITIZEN_PASSWORD, barangay: 'Villamonte', reporting: true
  });
  await signIn('citizenA', CITIZEN_PASSWORD);

  const [{ adminsBefore }] = await q("SELECT COUNT(*) AS adminsBefore FROM users WHERE role = 'admin'");
  for (const token of [accounts.adminA.token, accounts.adminB.token, accounts.citizenA.token, undefined]) {
    const response = await api('/api/admin/admins', {
      token, method: 'POST', body: { username: `rogue_${Date.now()}`, password: ADMIN_PASSWORD }
    });
    assert.ok([401, 403].includes(response.status), `expected denial, got ${response.status}`);
  }
  const [{ adminsAfter }] = await q("SELECT COUNT(*) AS adminsAfter FROM users WHERE role = 'admin'");
  assert.equal(Number(adminsAfter), Number(adminsBefore));
  const listing = await json(await api('/api/admin/admins', { token: accounts.adminA.token }));
  assert.equal(listing.canCreateAdmins, false);
  assert.equal(listing.users.find(u => u.id === accounts.adminA.id).isSelf, true);
});

test('7.4 to 7.7 and 7.16: Admin A cannot change, suspend, reset, re-role, or revoke Admin B', async () => {
  const before = await snapshot([accounts.adminB.id]);
  const target = accounts.adminB.id;
  const version = await versionOf(target);
  const attempts = [
    ['GET', `/api/admin/barangay-users/${target}`, undefined],
    ['PATCH', `/api/admin/barangay-users/${target}`, { fullName: 'Hijacked', version }],
    ['PATCH', `/api/admin/barangay-users/${target}`, { role: 'citizen', version }],
    ['PATCH', `/api/admin/barangay-users/${target}/status`, { status: 'suspended', version }],
    ['POST', `/api/admin/barangay-users/${target}/password`, { password: 'Hijacked2026', version }]
  ];
  for (const [method, pathName, body] of attempts) {
    const response = await api(pathName, { token: accounts.adminA.token, method, body });
    assert.equal(response.status, 403, `${method} ${pathName}`);
    assert.match((await json(response)).error, /own owner/);
  }
  for (const route of ['/api/admin/users/', '/api/admin/admins/']) {
    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      const response = await api(`${route}${target}`, { token: accounts.adminA.token, method, body: { role: 'citizen', password: 'Hijacked2026' } });
      assert.equal(response.status, 404, `${method} ${route} has no handler`);
    }
  }

  const forgedSelf = await api('/api/auth/me/account', {
    token: accounts.adminA.token, method: 'PATCH',
    body: { id: target, userId: target, fullName: 'Admin A renamed', version: await versionOf(accounts.adminA.id) }
  });
  assert.equal(forgedSelf.status, 200);
  assert.equal((await json(forgedSelf)).user.id, accounts.adminA.id);
  for (const field of [{ role: 'citizen' }, { username: 'renamed' }, { permissions: ['admin:create'] }, { status: 'suspended' }]) {
    const response = await api('/api/auth/me/account', {
      token: accounts.adminA.token, method: 'PATCH', body: { ...field, version: await versionOf(accounts.adminA.id) }
    });
    assert.equal(response.status, 403);
  }

  assert.equal(await snapshot([target]), before, 'Admin B row and permissions must be unchanged');
  assert.equal((await api('/api/me', { token: accounts.adminB.token })).status, 200, 'Admin B session must survive');
  const [{ blocked }] = await q("SELECT COUNT(*) AS blocked FROM audit_logs WHERE entity_id = ? AND action LIKE 'official_%'", [target]);
  assert.equal(Number(blocked), 0);
});

test('7.8: a duplicate administrator username fails with 409 and changes nothing', async () => {
  const before = await snapshot([accounts.adminA.id, accounts.adminB.id, accounts.adminC.id]);
  for (const username of [accounts.adminA.username, accounts.adminA.username.toUpperCase()]) {
    const response = await api('/api/admin/admins', {
      token: accounts.adminC.token, method: 'POST', body: { username, password: 'DifferentPass2026' }
    });
    assert.equal(response.status, 409);
  }
  assert.equal(await snapshot([accounts.adminA.id, accounts.adminB.id, accounts.adminC.id]), before);
  assert.equal((await login(accounts.adminA.username, ADMIN_PASSWORD)).status, 200);
});

test('7.8: simultaneous creation of the same username inserts exactly one account', async () => {
  const username = `race_admin_${Date.now()}`;
  const results = await Promise.all([1, 2, 3].map(() => api('/api/admin/admins', {
    token: accounts.adminC.token, method: 'POST', body: { username, password: ADMIN_PASSWORD }
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409]);
  const [{ total }] = await q('SELECT COUNT(*) AS total FROM users WHERE username = ?', [username]);
  assert.equal(Number(total), 1);
});

test('7.13: one barangay can have several independent officials', async () => {
  for (const [key, barangayId] of [['officialA1', 60], ['officialA2', 60], ['officialB1', 1]]) {
    const username = `${key.toLowerCase()}_${Date.now()}`;
    const response = await api('/api/admin/barangay-users', {
      token: accounts.adminA.token, method: 'POST', body: { username, password: OFFICIAL_PASSWORD, barangayId }
    });
    assert.equal(response.status, 201);
    accounts[key] = { username };
    await signIn(key, OFFICIAL_PASSWORD);
  }
  const rows = await q('SELECT id, barangay_id, password_hash FROM users WHERE id IN (?, ?, ?) ORDER BY id',
    [accounts.officialA1.id, accounts.officialA2.id, accounts.officialB1.id]);
  assert.deepEqual(rows.map(r => r.barangay_id), [60, 60, 1]);
  assert.equal(new Set(rows.map(r => r.password_hash)).size, 3);
  assert.notEqual(accounts.officialA1.id, accounts.officialA2.id);
});

test('7.10: barangay officials cannot manage any account or their own assignment or role', async () => {
  const before = await snapshot([accounts.officialA1.id, accounts.officialA2.id, accounts.officialB1.id]);
  const victim = accounts.officialB1.id;
  for (const [method, pathName, body] of [
    ['PATCH', `/api/admin/barangay-users/${victim}`, { fullName: 'Hijacked', version: 0 }],
    ['PATCH', `/api/admin/barangay-users/${victim}/status`, { status: 'suspended', version: 0 }],
    ['POST', `/api/admin/barangay-users/${victim}/password`, { password: 'Hijacked2026', version: 0 }],
    ['POST', '/api/admin/barangay-users', { username: 'rogue_official', password: OFFICIAL_PASSWORD, barangayId: 60 }],
    ['POST', '/api/admin/admins', { username: 'rogue_admin', password: ADMIN_PASSWORD }]
  ]) {
    assert.equal((await api(pathName, { token: accounts.officialA1.token, method, body })).status, 403, `${method} ${pathName}`);
  }
  for (const field of [{ barangayId: 1 }, { barangay: 'Barangay 1' }, { role: 'admin' }]) {
    const response = await api('/api/auth/me/account', {
      token: accounts.officialA1.token, method: 'PATCH', body: { ...field, version: await versionOf(accounts.officialA1.id) }
    });
    assert.equal(response.status, 403);
  }
  assert.equal(await snapshot([accounts.officialA1.id, accounts.officialA2.id, accounts.officialB1.id]), before);
  const me = await json(await api('/api/me', { token: accounts.officialA1.token }));
  assert.deepEqual([me.user.role, me.user.barangay_id], ['barangay', 60]);
});

test('7.11: officials only reach reports in their own barangay', async () => {
  const otherCitizen = await seedCitizen({
    username: 'multi_admin_other_resident', password: CITIZEN_PASSWORD, barangay: 'Barangay 1', reporting: true
  });
  const first = await api('/api/reports', { token: accounts.citizenA.token, method: 'POST', form: reportForm('Villamonte pothole', 'Villamonte') });
  const second = await api('/api/reports', { token: otherCitizen.token, method: 'POST', form: reportForm('Barangay 1 crack', 'Barangay 1') });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const villamonte = await json(first);
  const barangayOne = await json(second);
  accounts.reports = { villamonte: villamonte.id, barangayOne: barangayOne.id };

  for (const key of ['officialA1', 'officialA2']) {
    const list = await json(await api('/api/reports', { token: accounts[key].token }));
    assert.deepEqual(list.reports.map(r => r.id), [villamonte.id]);
    assert.equal((await api(`/api/reports/${barangayOne.id}`, { token: accounts[key].token })).status, 403);
    assert.equal((await api(`/api/reports/${barangayOne.id}/status`, { token: accounts[key].token, method: 'PATCH', body: { status: 'ongoing' } })).status, 403);
  }
  const listB = await json(await api('/api/reports', { token: accounts.officialB1.token }));
  assert.deepEqual(listB.reports.map(r => r.id), [barangayOne.id]);
  const [row] = await q('SELECT status FROM reports WHERE id = ?', [barangayOne.id]);
  assert.equal(row.status, 'pending');
});

test('7.12, 7.14, 7.15: admins manage officials explicitly by id; suspending one official leaves the other working', async () => {
  const target = accounts.officialA1.id;
  const rename = await api(`/api/admin/barangay-users/${target}`, {
    token: accounts.adminB.token, method: 'PATCH', body: { fullName: 'Kapitan Uno', version: await versionOf(target) }
  });
  assert.equal(rename.status, 200);
  const suspend = await api(`/api/admin/barangay-users/${target}/status`, {
    token: accounts.adminB.token, method: 'PATCH', body: { status: 'suspended', version: await versionOf(target) }
  });
  assert.equal(suspend.status, 200);

  const [a1] = await q('SELECT full_name, status, account_version FROM users WHERE id = ?', [target]);
  assert.deepEqual([a1.full_name, a1.status, a1.account_version], ['Kapitan Uno', 'suspended', 2]);
  assert.equal((await api('/api/reports', { token: accounts.officialA1.token })).status, 401);
  assert.equal((await login(accounts.officialA1.username, OFFICIAL_PASSWORD)).status, 403);

  const a2 = await api('/api/reports', { token: accounts.officialA2.token });
  assert.equal(a2.status, 200);
  const status = await api(`/api/reports/${accounts.reports.villamonte}/status`, {
    token: accounts.officialA2.token, method: 'PATCH', body: { status: 'ongoing', note: 'Second official acts' }
  });
  assert.equal(status.status, 200);

  const audit = await q("SELECT actor_id, action, entity_id FROM audit_logs WHERE entity_id = ? AND action LIKE 'official_%' ORDER BY id", [target]);
  assert.deepEqual(audit.map(a => [a.actor_id, a.action]), [
    [accounts.adminA.id, 'official_create'],
    [accounts.adminB.id, 'official_update'],
    [accounts.adminB.id, 'official_suspend']
  ]);
});

test('7.9: concurrent conflicting edits to one official cannot silently overwrite each other', async () => {
  const target = accounts.officialA2.id;
  const version = await versionOf(target);
  const results = await Promise.all([
    api(`/api/admin/barangay-users/${target}`, { token: accounts.adminA.token, method: 'PATCH', body: { fullName: 'Edit from Admin A', version } }),
    api(`/api/admin/barangay-users/${target}`, { token: accounts.adminB.token, method: 'PATCH', body: { fullName: 'Edit from Admin B', version } })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? 'Edit from Admin A' : 'Edit from Admin B';
  const [row] = await q('SELECT full_name, account_version FROM users WHERE id = ?', [target]);
  assert.equal(row.full_name, winner);
  assert.equal(row.account_version, version + 1);

  const stale = await api(`/api/admin/barangay-users/${target}/password`, {
    token: accounts.adminA.token, method: 'POST', body: { password: 'Stale2026pass', version }
  });
  assert.equal(stale.status, 409);
  assert.equal((await api(`/api/admin/barangay-users/${target}`, { token: accounts.adminA.token, method: 'PATCH', body: { fullName: 'x' } })).status, 400);
  assert.equal((await login(accounts.officialA2.username, OFFICIAL_PASSWORD)).status, 200);
});

test('self service: each account changes only its own password, with the current password, and gets a fresh session', async () => {
  const bBefore = await snapshot([accounts.adminB.id]);
  const old = accounts.adminA.token;
  const wrong = await api('/api/auth/me/password', {
    token: old, method: 'POST', body: { currentPassword: 'Nope', newPassword: 'NewAdminPass2026', version: await versionOf(accounts.adminA.id) }
  });
  assert.equal(wrong.status, 400);
  const weak = await api('/api/auth/me/password', {
    token: old, method: 'POST', body: { currentPassword: ADMIN_PASSWORD, newPassword: 'short1', version: await versionOf(accounts.adminA.id) }
  });
  assert.equal(weak.status, 400);
  const changed = await api('/api/auth/me/password', {
    token: old, method: 'POST',
    body: { userId: accounts.adminB.id, currentPassword: ADMIN_PASSWORD, newPassword: 'NewAdminPass2026', version: await versionOf(accounts.adminA.id) }
  });
  assert.equal(changed.status, 200);
  const { token, user } = await json(changed);
  assert.equal(user.id, accounts.adminA.id);
  assert.equal((await api('/api/me', { token: old })).status, 401);
  assert.equal((await api('/api/me', { token })).status, 200);
  assert.equal((await login(accounts.adminA.username, 'NewAdminPass2026')).status, 200);
  assert.equal(await snapshot([accounts.adminB.id]), bBefore);
  assert.equal((await api('/api/me', { token: accounts.adminB.token })).status, 200);
});

test('recovery: the audited CLI procedure is the only path that grants permissions or resets another administrator', async () => {
  const base = { RECOVERY_OPERATOR: 'test-custodian', RECOVERY_REASON: 'Locked out during automated test', RECOVERY_CONFIRM: accounts.adminB.username };
  assert.throws(() => readRecoveryRequest(['grant-admin-create', accounts.adminB.username], { ...base, RECOVERY_CONFIRM: 'someone_else' }), /RECOVERY_CONFIRM/);
  assert.throws(() => readRecoveryRequest(['grant-admin-create', accounts.adminB.username], { ...base, RECOVERY_REASON: 'short' }), /RECOVERY_REASON/);
  await assert.rejects(runRecovery(getPool(), readRecoveryRequest(['reactivate', accounts.officialA2.username], { ...base, RECOVERY_CONFIRM: accounts.officialA2.username })), /No administrator/);

  await runRecovery(getPool(), readRecoveryRequest(['grant-admin-create', accounts.adminB.username], base));
  const listing = await json(await api('/api/admin/admins', { token: accounts.adminB.token }));
  assert.equal(listing.canCreateAdmins, true);

  await runRecovery(getPool(), readRecoveryRequest(['reset-password', accounts.adminB.username], { ...base, RECOVERY_NEW_PASSWORD: 'RecoveredAdmin2026' }));
  assert.equal((await api('/api/me', { token: accounts.adminB.token })).status, 401);
  assert.equal((await login(accounts.adminB.username, 'RecoveredAdmin2026')).status, 200);

  const audit = await q("SELECT action, actor_id, details FROM audit_logs WHERE action LIKE 'recovery_%' ORDER BY id");
  assert.deepEqual(audit.map(a => a.action), ['recovery_grant_admin_create', 'recovery_reset_password']);
  assert.ok(audit.every(a => a.actor_id === null));
  assert.equal(JSON.stringify(audit).includes('RecoveredAdmin2026'), false);
});

test('admin sign up creates only a pending request; no account exists or signs in until an authorized approval', async () => {
  await signIn('adminA', 'NewAdminPass2026');
  const username = `signup_admin_${Date.now()}`;
  const [{ adminsBefore }] = await q("SELECT COUNT(*) AS adminsBefore FROM users WHERE role = 'admin'");
  const submitted = await api('/api/auth/admin-access-requests', {
    method: 'POST', body: { username, fullName: 'Requested Admin', password: 'RequestedAdmin2026', reason: 'City engineering office', role: 'admin' }
  });
  assert.equal(submitted.status, 202);
  const { id } = await json(submitted);

  const [request] = await q('SELECT username, status, password_hash FROM admin_access_requests WHERE id = ?', [id]);
  assert.equal(request.status, 'pending');
  assert.match(request.password_hash, /^\$2[aby]\$12\$/);
  const [{ adminsAfter }] = await q("SELECT COUNT(*) AS adminsAfter FROM users WHERE role = 'admin'");
  assert.equal(Number(adminsAfter), Number(adminsBefore));
  assert.equal((await login(username, 'RequestedAdmin2026')).status, 401);

  assert.equal((await api('/api/auth/admin-access-requests', { method: 'POST', body: { username, password: 'RequestedAdmin2026' } })).status, 409);
  assert.equal((await api('/api/auth/admin-access-requests', { method: 'POST', body: { username: accounts.adminA.username, password: 'RequestedAdmin2026' } })).status, 409);
  assert.equal((await api('/api/auth/admin-access-requests', { method: 'POST', body: { username: `weak_${Date.now()}`, password: 'short1' } })).status, 400);

  for (const token of [accounts.adminA.token, accounts.officialA2.token, accounts.citizenA.token]) {
    assert.equal((await api('/api/admin/admin-access-requests', { token })).status, 403);
    assert.equal((await api(`/api/admin/admin-access-requests/${id}/approve`, { token, method: 'POST', body: {} })).status, 403);
  }
  const [{ stillPending }] = await q('SELECT COUNT(*) AS stillPending FROM admin_access_requests WHERE id = ? AND status = \'pending\'', [id]);
  assert.equal(Number(stillPending), 1);

  const pending = await json(await api('/api/admin/admin-access-requests', { token: accounts.adminC.token }));
  assert.ok(pending.requests.some(r => r.id === id && r.username === username));
  assert.equal(JSON.stringify(pending).includes('password'), false);

  const approved = await api(`/api/admin/admin-access-requests/${id}/approve`, { token: accounts.adminC.token, method: 'POST', body: {} });
  assert.equal(approved.status, 200);
  const { user } = await json(approved);
  assert.equal(user.role, 'admin');
  assert.deepEqual(user.permissions, []);
  assert.equal((await api(`/api/admin/admin-access-requests/${id}/approve`, { token: accounts.adminC.token, method: 'POST', body: {} })).status, 409);

  const [after] = await q('SELECT status, password_hash, reviewed_by, created_user_id FROM admin_access_requests WHERE id = ?', [id]);
  assert.deepEqual([after.status, after.password_hash, after.reviewed_by, after.created_user_id], ['approved', '', accounts.adminC.id, user.id]);
  assert.equal((await login(username, 'RequestedAdmin2026')).status, 200);
  const grants = await q("SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = ?", [user.id]);
  assert.equal(Number(grants[0].n), 0);
  const audit = (await q("SELECT action FROM audit_logs WHERE (entity_type = 'admin_access_request' AND entity_id = ?) OR (action = 'admin_create' AND entity_id = ?) ORDER BY id", [id, user.id])).map(a => a.action);
  assert.deepEqual(audit, ['admin_request_submit', 'admin_create', 'admin_request_approve']);
});

test('a rejected admin sign up never becomes an account and its password hash is discarded', async () => {
  const username = `rejected_admin_${Date.now()}`;
  const { id } = await json(await api('/api/auth/admin-access-requests', { method: 'POST', body: { username, password: 'RejectedAdmin2026' } }));
  const rejected = await api(`/api/admin/admin-access-requests/${id}/reject`, { token: accounts.adminC.token, method: 'POST', body: {} });
  assert.equal(rejected.status, 200);
  const [row] = await q('SELECT status, password_hash, created_user_id FROM admin_access_requests WHERE id = ?', [id]);
  assert.deepEqual([row.status, row.password_hash, row.created_user_id], ['rejected', '', null]);
  const [{ total }] = await q('SELECT COUNT(*) AS total FROM users WHERE username = ?', [username]);
  assert.equal(Number(total), 0);
  assert.equal((await login(username, 'RejectedAdmin2026')).status, 401);
  assert.equal((await api(`/api/admin/admin-access-requests/${id}/approve`, { token: accounts.adminC.token, method: 'POST', body: {} })).status, 409);
  const resubmit = await api('/api/auth/admin-access-requests', { method: 'POST', body: { username, password: 'RejectedAdmin2026' } });
  assert.equal(resubmit.status, 202, 'a rejected username may request again');
});
