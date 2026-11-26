const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.STORAGE_DRIVER = 'local';
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { privateMysql } = require('../support/private-mysql');
const { runMigrations, listMigrationFiles, readMigration } = require('../../server/infrastructure/database/mysql/migrationRunner');
const { bootstrapAdmin } = require('../../server/infrastructure/database/mysql/bootstrapAdmin');
const { readRecoveryRequest, runRecovery } = require('../../server/infrastructure/database/mysql/adminRecovery');
const passwordHasher = require('../../server/infrastructure/security/passwordHasher');
const { checkAdminPassword } = require('../../server/domain/accounts/account.rules');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);

test('administrator provisioning security on private MySQL', { timeout: 180000 }, async t => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  t.beforeEach(() => { offset += 61000; });
  const database = await privateMysql(t);
  const { pool, adapter } = database;
  let server;
  try {
    await runMigrations(pool);
    require('../../server/infrastructure/database').useTestDatabase(adapter);
    const app = require('../../server/app');
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, token, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    }
    const credentials = { BOOTSTRAP_ADMIN_USERNAME: 'aa_operator_initial', BOOTSTRAP_ADMIN_PASSWORD: 'FictionalOperator2026!' };
    let admin;

    await t.test('fresh installation keeps public Admin signup pending without granting an account', async () => {
      assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))[0][0].n, 0);
      const result = await request('/api/auth/admin-access-requests', null, 'POST', { username: 'requested_admin', password: 'FictionalRequest2026!' });
      assert.equal(result.status, 202);
      assert.equal(result.data.status, 'pending');
      assert.equal((await pool.query('SELECT COUNT(*) AS n FROM users'))[0][0].n, 0);
      assert.equal((await request('/api/auth/admin/login', null, 'POST', { username: 'requested_admin', password: 'FictionalRequest2026!' })).status, 401);
    });

    await t.test('concurrent public access requests reserve one pending username', async () => {
      const repository = require('../../server/infrastructure/repositories/adminAccessRequest.repository');
      const original = repository.hasPendingForUsername.bind(repository);
      let arrivals = 0, release;
      const ready = new Promise(resolve => { release = resolve; });
      const mock = t.mock.method(repository, 'hasPendingForUsername', async (...args) => {
        const result = await original(...args);
        if (++arrivals === 2) release();
        await ready;
        return result;
      });
      try {
        const input = { username: 'concurrent_request', password: 'FictionalRequest2026!' };
        const responses = await Promise.all([request('/api/auth/admin-access-requests', null, 'POST', input), request('/api/auth/admin-access-requests', null, 'POST', input)]);
        assert.deepEqual(responses.map(row => row.status).sort(), [202, 409]);
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM admin_access_requests WHERE username = 'concurrent_request'"))[0][0].n, 1);
      } finally { mock.mock.restore(); }
    });

    await t.test('failed bootstrap rolls back the account, permission and initialization marker', async () => {
      const repository = require('../../server/infrastructure/repositories/userPermission.repository');
      const mock = t.mock.method(repository, 'grant', async () => { throw new Error('Isolated permission write failure'); });
      try {
        await assert.rejects(bootstrapAdmin(pool, credentials), /Isolated permission write failure/);
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))[0][0].n, 0);
        assert.equal((await pool.query('SELECT initialized_at FROM admin_initialization WHERE id = 1'))[0][0].initialized_at, null);
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin_bootstrap'"))[0][0].n, 0);
      } finally { mock.mock.restore(); }
    });

    await t.test('AUTH-10 concurrent bootstrap creates at most one privileged account', async () => {
      await pool.execute("INSERT INTO users (username, password_hash, role, barangay) VALUES (?, ?, 'citizen', 'Barangay 1')", ['middle_fixture', passwordHasher.hash('FictionalCitizen2026!', 4)]);
      let arrivals = 0, release;
      const ready = new Promise(resolve => { release = resolve; });
      const barrierPool = {
        getConnection: () => pool.getConnection(),
        query: async (...args) => {
          const result = await pool.query(...args);
          if (/SELECT id, username FROM users WHERE role/.test(args[0])) {
            if (++arrivals === 2) release();
            await ready;
          }
          return result;
        }
      };
      const results = await Promise.allSettled([
        bootstrapAdmin(barrierPool, credentials),
        bootstrapAdmin(barrierPool, { ...credentials, BOOTSTRAP_ADMIN_USERNAME: 'zz_operator_other' })
      ]);
      assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.created).length, 1);
      assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))[0][0].n, 1);
      const row = (await pool.query("SELECT id, username FROM users WHERE role = 'admin'"))[0][0];
      admin = row;
    });

    await t.test('AUTH-11 bootstrap initialization survives loss of the last Admin role', async () => {
      await pool.query("UPDATE users SET role = 'citizen' WHERE role = 'admin'");
      await assert.rejects(bootstrapAdmin(pool, { ...credentials, BOOTSTRAP_ADMIN_USERNAME: 'operator_reopened' }), /initialized|recovery/i);
      assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE username = 'operator_reopened'"))[0][0].n, 0);
      if (admin) await pool.execute("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    });

    await t.test('staff password validation rejects bcrypt byte truncation collisions', () => {
      const first = 'A1' + 'é'.repeat(35) + 'x';
      const second = 'A1' + 'é'.repeat(35) + 'y';
      assert.equal(passwordHasher.verify(second, passwordHasher.hash(first, 4)), true);
      assert.match(checkAdminPassword(first) || '', /72.*byte/i);
    });

    admin = { ...admin, ...(await request('/api/auth/admin/login', null, 'POST', { username: admin.username, password: credentials.BOOTSTRAP_ADMIN_PASSWORD })).data };
    assert.ok(admin.token);
    const citizen = await require('../support/citizens').seedCitizen({
      username: 'citizen_security', password: 'FictionalCitizen2026!', barangay: 'Villamonte'
    });
    const official = (await request('/api/admin/barangay-users', admin.token, 'POST', { username: 'official_security', password: 'FictionalOfficial2026!', barangayId: 60 })).data.user;
    const officialSession = (await request('/api/auth/barangay/login', null, 'POST', { username: official.username, password: 'FictionalOfficial2026!' })).data;
    const pending = (await pool.query("SELECT id FROM admin_access_requests WHERE username = 'requested_admin'"))[0][0];

    for (const [id, portal] of [['AUTH-01', 'admin'], ['AUTH-02', 'barangay']]) {
      await t.test(`${id} citizen cannot authenticate through ${portal} login`, async () => {
        const result = await request(`/api/auth/${portal}/login`, null, 'POST', { username: citizen.user.username, password: 'FictionalCitizen2026!' });
        assert.equal(result.status, 401);
        assert.equal(result.data.error, 'Invalid username or password.');
      });
    }

    await t.test('AUTH-03 AUTH-04 pending requests have no privileged session or protected API access', async () => {
      const result = await request('/api/auth/admin/login', null, 'POST', { username: 'requested_admin', password: 'FictionalRequest2026!' });
      assert.equal(result.status, 401);
      assert.equal(result.data.token, undefined);
      assert.equal((await request('/api/admin/users')).status, 401);
      const token = require('../../server/infrastructure/security/tokenProvider').issue({ id: citizen.user.id, role: 'admin' });
      assert.equal((await request('/api/admin/users', token)).status, 401);
    });

    await t.test('AUTH-06 unauthenticated, Citizen and Barangay callers cannot approve requests', async () => {
      for (const token of [null, citizen.token, officialSession.token]) {
        assert.equal((await request(`/api/admin/admin-access-requests/${pending.id}/approve`, token, 'POST')).status, token ? 403 : 401);
      }
    });

    let ordinary;
    await t.test('AUTH-16 concurrent approval and replay create one ordinary Admin without extra permissions', async () => {
      const responses = await Promise.all(Array.from({ length: 4 }, () => request(`/api/admin/admin-access-requests/${pending.id}/approve`, admin.token, 'POST')));
      assert.deepEqual(responses.map(row => row.status).sort(), [200, 409, 409, 409]);
      const approved = responses.find(row => row.status === 200).data;
      ordinary = approved.user;
      assert.deepEqual(ordinary.permissions, []);
      assert.doesNotMatch(JSON.stringify(approved), /password_hash|FictionalRequest/);
      assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE username = 'requested_admin'"))[0][0].n, 1);
      assert.equal((await pool.execute('SELECT password_hash FROM admin_access_requests WHERE id = ?', [pending.id]))[0][0].password_hash, '');
      ordinary = { ...ordinary, ...(await request('/api/auth/admin/login', null, 'POST', { username: ordinary.username, password: 'FictionalRequest2026!' })).data };
      assert.ok(ordinary.token);
      assert.equal((await request(`/api/admin/admin-access-requests/${pending.id}/approve`, admin.token, 'POST')).status, 409);
    });

    await t.test('AUTH-07 ordinary Admin cannot create Admins or review access requests', async () => {
      assert.equal((await request('/api/admin/admins', ordinary.token, 'POST', { username: 'unauthorized_admin', password: 'FictionalBlocked2026!' })).status, 403);
      assert.equal((await request('/api/admin/admin-access-requests', ordinary.token)).status, 403);
      assert.equal((await request(`/api/admin/admin-access-requests/${pending.id}/reject`, ordinary.token, 'POST')).status, 403);
    });

    await t.test('AUTH-08 AUTH-12 HTTP account management cannot disable or reset another Admin or the last privileged Admin', async () => {
      for (const target of [admin, ordinary]) {
        for (const [suffix, method, body] of [
          ['/status', 'PATCH', { status: 'suspended', version: 0 }],
          ['/password', 'POST', { password: 'FictionalHijack2026!', version: 0 }],
          ['', 'PATCH', { fullName: 'Changed by another Admin', version: 0 }]
        ]) assert.equal((await request(`/api/admin/barangay-users/${target.id}${suffix}`, admin.token, method, body)).status, 403);
      }
      assert.equal((await request('/api/auth/me/account', admin.token, 'PATCH', { status: 'suspended', version: 0 })).status, 403);
      assert.equal((await request('/api/me', admin.token)).status, 200);
    });

    await t.test('AUTH-09 AUTH-14 assigned barangay and Citizen ownership remain server authoritative', async () => {
      const [report] = await pool.execute("INSERT INTO reports (description, barangay, barangay_id, submitted_by) VALUES ('Private fictional incident', 'Mandalagan', 51, ?)", [citizen.user.id]);
      assert.equal((await request(`/api/reports/${report.insertId}`, officialSession.token)).status, 403);
      assert.equal((await request('/api/admin/barangay-users/' + official.id, citizen.token, 'PATCH', { barangayId: 51, version: 0 })).status, 403);
      assert.equal((await request('/api/auth/me/account', citizen.token, 'PATCH', { id: admin.id, fullName: 'Own profile only', version: 0 })).status, 200);
      assert.notEqual((await pool.execute('SELECT full_name FROM users WHERE id = ?', [admin.id]))[0][0].full_name, 'Own profile only');
      assert.equal((await request(`/api/reports/${report.insertId}`, ordinary.token)).status, 200);
    });

    await t.test('AUTH-13 public Citizen registration rejects client-controlled privilege fields', async () => {
      for (const extra of [{ role: 'admin' }, { permissions: ['admin:create'] }, { status: 'active' }]) {
        assert.equal((await request('/api/auth/register', null, 'POST', { username: 'forged_account', password: 'FictionalCitizen2026!', ...extra })).status, 400);
      }
      assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE username = 'forged_account'"))[0][0].n, 0);
    });

    await t.test('AUTH-05 AUTH-17 provisioned Admin cannot approve or reject a pending request for its own username', async () => {
      const input = { username: 'self_review_request', password: 'FictionalSelf2026!' };
      const ownRequest = (await request('/api/auth/admin-access-requests', null, 'POST', input)).data;
      const created = (await request('/api/admin/admins', admin.token, 'POST', input)).data.user;
      await pool.execute("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'admin:create')", [created.id]);
      const ownSession = (await request('/api/auth/admin/login', null, 'POST', input)).data;
      for (const action of ['approve', 'reject']) {
        assert.equal((await request(`/api/admin/admin-access-requests/${ownRequest.id}/${action}`, ownSession.token, 'POST')).status, 403);
      }
      assert.equal((await pool.execute('SELECT status FROM admin_access_requests WHERE id = ?', [ownRequest.id]))[0][0].status, 'pending');
    });

    await t.test('rejection discards credentials and allows a new pending request without activation', async () => {
      const input = { username: 'rejected_request', password: 'FictionalRejected2026!' };
      const result = await request('/api/auth/admin-access-requests', null, 'POST', input);
      assert.equal((await request(`/api/admin/admin-access-requests/${result.data.id}/reject`, admin.token, 'POST')).status, 200);
      const rejected = (await pool.execute('SELECT password_hash, status FROM admin_access_requests WHERE id = ?', [result.data.id]))[0][0];
      assert.deepEqual(rejected, { password_hash: '', status: 'rejected' });
      assert.equal((await request('/api/auth/admin/login', null, 'POST', input)).status, 401);
      assert.equal((await request('/api/auth/admin-access-requests', null, 'POST', input)).status, 202);
    });

    await t.test('AUTH-15 revocation rejects existing JWT and unused SSE tickets; operator recovery restores access only', async () => {
      const ticket = (await request('/api/notifications/stream-ticket', ordinary.token, 'POST')).data.ticket;
      await pool.execute("UPDATE users SET status = 'suspended', token_version = token_version + 1 WHERE id = ?", [ordinary.id]);
      assert.equal((await request('/api/admin/users', ordinary.token)).status, 401);
      assert.equal((await request('/api/notifications/stream?ticket=' + encodeURIComponent(ticket))).status, 401);
      const env = { RECOVERY_OPERATOR: 'Fictional test operator', RECOVERY_REASON: 'Private recovery acceptance test', RECOVERY_CONFIRM: ordinary.username };
      await runRecovery(pool, readRecoveryRequest(['reactivate', ordinary.username], env));
      assert.equal((await request('/api/admin/users', ordinary.token)).status, 401);
      await runRecovery(pool, readRecoveryRequest(['reset-password', ordinary.username], { ...env, RECOVERY_NEW_PASSWORD: 'FictionalRecovered2026!' }));
      assert.equal((await request('/api/auth/admin/login', null, 'POST', { username: ordinary.username, password: 'FictionalRequest2026!' })).status, 401);
      assert.equal((await request('/api/auth/admin/login', null, 'POST', { username: ordinary.username, password: 'FictionalRecovered2026!' })).status, 200);
      await runRecovery(pool, readRecoveryRequest(['grant-admin-create', ordinary.username], env));
      await runRecovery(pool, readRecoveryRequest(['grant-admin-create', ordinary.username], env));
      assert.equal((await pool.execute("SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = ? AND permission = 'admin:create'", [ordinary.id]))[0][0].n, 1);
      await assert.rejects(bootstrapAdmin(pool, credentials), /initialized|recovery/i);
      const audits = JSON.stringify((await pool.query("SELECT details FROM audit_logs WHERE action LIKE 'recovery_%'"))[0]);
      assert.match(audits, /Fictional test operator/);
      assert.doesNotMatch(audits, /FictionalRecovered|password_hash|\$2[aby]\$/);
    });

    await t.test('AUTH-18 cross-role token reuse and forged role claims fail closed', async () => {
      for (const actor of [citizen, officialSession]) assert.equal((await request('/api/admin/users', actor.token)).status, 403);
      const provider = require('../../server/infrastructure/security/tokenProvider');
      const forged = provider.issue({ id: citizen.user.id, role: 'admin' });
      const expired = provider.issue({ id: admin.id, role: 'admin' }, -1);
      for (const token of [forged, expired, admin.token.slice(0, -8) + 'tampered']) assert.equal((await request('/api/admin/users', token)).status, 401);
    });

    await t.test('Admin signup rate limits repeated attempts and rejects over-byte passwords', async () => {
      const input = { username: 'password_bytes', password: 'A1' + 'é'.repeat(36) };
      assert.equal((await request('/api/auth/admin-access-requests', null, 'POST', input)).status, 400);
      for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/admin-access-requests', null, 'POST', { username: 'rate_limit', password: 'short' })).status, 400);
      assert.equal((await request('/api/auth/admin-access-requests', null, 'POST', { username: 'rate_limit', password: 'short' })).status, 429);
    });

    await t.test('password reset during login cannot issue a fresh token for the previous password', async () => {
      const input = { username: 'login_race', password: 'FictionalOriginal2026!' };
      const created = (await request('/api/admin/admins', admin.token, 'POST', input)).data.user;
      const repository = require('../../server/infrastructure/repositories/user.repository');
      const original = repository.findSessionState.bind(repository);
      let changed = false;
      const mock = t.mock.method(repository, 'findSessionState', async (...args) => {
        if (!changed && Number(args[0]) === Number(created.id)) {
          changed = true;
          await pool.execute('UPDATE users SET password_hash = ?, token_version = token_version + 1, account_version = account_version + 1 WHERE id = ?', [passwordHasher.hash('FictionalNew2026!', 4), created.id]);
        }
        return original(...args);
      });
      try {
        const result = await request('/api/auth/admin/login', null, 'POST', input);
        assert.equal(result.status, 401);
        assert.equal(result.data.token, undefined);
      } finally { mock.mock.restore(); }
      assert.equal((await request('/api/auth/admin/login', null, 'POST', { ...input, password: 'FictionalNew2026!' })).status, 200);
    });

    await t.test('existing Admin signup UI submits a real pending request, handles duplicates and blocks oversized UTF-8 passwords', async () => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await page.addInitScript(base => {
          Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => base, set() {} });
        }, base);
        await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await page.goto(base + '/admin-signup.html');
        await page.locator('#signupUser').fill('browser_admin_request');
        await page.locator('#signupFullName').fill('Fictional Browser Applicant');
        await page.locator('#signupPass').fill('FictionalBrowser2026!');
        await page.locator('#signupConfirm').fill('FictionalBrowser2026!');
        await page.locator('#signupSubmit').click();
        await expect(page.locator('#signupMsg')).toContainText('authorized administrator must approve');
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM users WHERE username = 'browser_admin_request'"))[0][0].n, 0);
        assert.equal((await pool.query("SELECT status FROM admin_access_requests WHERE username = 'browser_admin_request'"))[0][0].status, 'pending');
        const evidence = path.resolve('.data/admin-provisioning');
        await fs.mkdir(evidence, { recursive: true });
        await page.screenshot({ path: path.join(evidence, 'admin-signup-pending-mobile.png'), fullPage: true });
        await page.locator('#signupUser').fill('browser_admin_request');
        await page.locator('#signupPass').fill('FictionalBrowser2026!');
        await page.locator('#signupConfirm').fill('FictionalBrowser2026!');
        await page.locator('#signupSubmit').click();
        await expect(page.locator('#signupMsg')).toContainText('already waiting for approval');
        await page.locator('#signupPass').fill('A1' + 'é'.repeat(36));
        await page.locator('#signupConfirm').fill('A1' + 'é'.repeat(36));
        await page.locator('#signupSubmit').click();
        await expect(page.locator('#signupMsg')).toContainText('72 UTF-8 bytes');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(base + '/admin-login.html');
        await page.locator('#roleLoginUser').fill('browser_admin_request');
        await page.locator('#roleLoginPass').fill('FictionalBrowser2026!');
        await page.locator('#roleLoginSubmit').click();
        await expect(page.locator('#roleLoginMsg')).toContainText('Invalid credentials or expired session');
        const pendingRow = (await pool.query("SELECT id FROM admin_access_requests WHERE username = 'browser_admin_request'"))[0][0];
        assert.equal((await request(`/api/admin/admin-access-requests/${pendingRow.id}/approve`, admin.token, 'POST')).status, 200);
        await page.locator('#roleLoginPass').fill('FictionalBrowser2026!');
        await page.locator('#roleLoginSubmit').click();
        await expect(page).toHaveURL(/\/admin\.html(?:#.*)?$/);
        await page.screenshot({ path: path.join(evidence, 'approved-admin-login-desktop.png'), fullPage: true });
      } finally { await browser.close(); }
    });

    await t.test('migration 013 preserves legacy accounts and records historical initialization even without surviving Admins', async () => {
      for (const scenario of ['legacy', 'history', 'created_history', 'approved_history', 'duplicates']) {
        const connection = await pool.getConnection();
        const originalDatabase = (await connection.query('SELECT DATABASE() AS db'))[0][0].db;
        try {
          const name = 'provisioning_' + scenario;
          await connection.query('CREATE DATABASE ' + name);
          await connection.changeUser({ database: name });
          for (const filename of (await listMigrationFiles()).filter(file => file < '013')) {
            for (const sql of (await readMigration(filename)).statements) await connection.query(sql);
          }
          if (scenario === 'legacy') {
            await connection.execute("INSERT INTO users (username, password_hash, role, barangay) VALUES ('legacy_admin', ?, 'admin', 'City Wide')", [passwordHasher.hash('FictionalLegacy2026!', 4)]);
          } else if (scenario.includes('history')) {
            const action = { history: 'admin_bootstrap', created_history: 'admin_create', approved_history: 'admin_request_approve' }[scenario];
            await connection.execute("INSERT INTO audit_logs (action, entity_type) VALUES (?, 'user')", [action]);
          } else {
            await connection.query("INSERT INTO admin_access_requests (username, password_hash) VALUES ('LegacyDuplicate', 'fixture'), ('legacyduplicate', 'fixture')");
          }
          const beforeUsers = (await connection.query('SELECT * FROM users ORDER BY id'))[0];
          const beforeRequests = (await connection.query('SELECT id, username, password_hash, status FROM admin_access_requests ORDER BY id'))[0];
          const apply = async () => { for (const sql of (await readMigration('013_admin_initialization.sql')).statements) await connection.query(sql); };
          if (scenario === 'duplicates') {
            await assert.rejects(apply(), { code: 'ER_DUP_ENTRY' });
          } else {
            await apply();
            const state = (await connection.query('SELECT * FROM admin_initialization'))[0][0];
            assert.ok(state.initialized_at);
            assert.equal(state.source, 'legacy');
            await assert.rejects(connection.query('INSERT INTO admin_initialization (id) VALUES (2)'), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
          }
          assert.deepEqual((await connection.query('SELECT * FROM users ORDER BY id'))[0], beforeUsers);
          assert.deepEqual((await connection.query('SELECT id, username, password_hash, status FROM admin_access_requests ORDER BY id'))[0], beforeRequests);
        } finally {
          await connection.changeUser({ database: originalDatabase });
          connection.release();
        }
      }
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    require('../../server/infrastructure/database').resetDatabase();
    await database.close();
  }
});

test('fresh Admin Sign Up, operator CLI bootstrap and subsequent authorized approval form one complete lifecycle', { timeout: 120000 }, async t => {
  const database = await privateMysql(t);
  const { pool, adapter } = database;
  let server, browser;
  try {
    await runMigrations(pool);
    require('../../server/infrastructure/database').useTestDatabase(adapter);
    const app = require('../../server/app');
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (route, token, body) => {
      const response = await fetch(base + route, {
        method: body !== undefined ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      return { status: response.status, data: await response.json() };
    };
    const rows = async (sql, params = []) => (await pool.execute(sql, params))[0];
    assert.equal((await rows("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))[0].n, 0);
    assert.equal((await rows('SELECT initialized_at FROM admin_initialization WHERE id = 1'))[0].initialized_at, null);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(base => {
      Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => base, set() {} });
    }, base);
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.goto(base + '/admin-signup.html');
    const applicantPassword = 'FictionalApplicant2026!';
    async function signup(username) {
      await page.locator('#signupUser').fill(username);
      await page.locator('#signupPass').fill(applicantPassword);
      await page.locator('#signupConfirm').fill(applicantPassword);
      const response = page.waitForResponse(response => response.url() === base + '/api/auth/admin-access-requests' && response.request().method() === 'POST');
      await page.locator('#signupSubmit').click();
      const result = await response;
      assert.equal(result.status(), 202);
      const body = await result.json();
      assert.equal(body.status, 'pending');
      assert.equal(body.token, undefined);
      await expect(page.locator('#signupMsg')).toContainText('authorized administrator must approve');
      return body.id;
    }
    const firstRequest = await signup('first_public_applicant');
    assert.equal((await rows('SELECT COUNT(*) AS n FROM users'))[0].n, 0);
    assert.equal((await api('/api/admin/admin-access-requests')).status, 401);
    assert.equal((await api('/api/auth/admin/login', null, { username: 'first_public_applicant', password: applicantPassword })).status, 401);
    assert.equal((await rows('SELECT status FROM admin_access_requests WHERE id = ?', [firstRequest]))[0].status, 'pending');

    const [connection] = await rows('SELECT @@port AS port, DATABASE() AS name');
    const operatorPassword = 'FictionalOperator' + randomBytes(12).toString('hex') + '!1';
    const cliOptions = {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        DB_DRIVER: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: String(connection.port),
        DB_USER: 'root', DB_PASSWORD: '', DB_NAME: connection.name,
        BOOTSTRAP_ADMIN_USERNAME: 'operator_system_admin', BOOTSTRAP_ADMIN_PASSWORD: operatorPassword
      },
      windowsHide: true,
      timeout: 20000
    };
    const cliPath = path.resolve(__dirname, '../../server/infrastructure/database/mysql/bootstrapAdmin.js');
    const output = await executeFile(process.execPath, [cliPath], cliOptions);
    assert.match(output.stdout, /created administrator "operator_system_admin"/);
    for (const secret of [operatorPassword, applicantPassword]) assert.equal((output.stdout + output.stderr).includes(secret), false);
    const system = await api('/api/auth/admin/login', null, { username: 'operator_system_admin', password: operatorPassword });
    assert.equal(system.status, 200);
    const own = await api('/api/auth/me/account', system.data.token);
    assert.deepEqual(own.data.user.permissions, ['admin:create']);
    assert.equal((await rows("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))[0].n, 1);
    assert.equal((await rows('SELECT initialized_by FROM admin_initialization WHERE id = 1'))[0].initialized_by, system.data.user.id);
    assert.equal((await rows('SELECT status FROM admin_access_requests WHERE id = ?', [firstRequest]))[0].status, 'pending');
    assert.equal((await rows("SELECT COUNT(*) AS n FROM users WHERE username = 'first_public_applicant'"))[0].n, 0);

    const secondRequest = await signup('subsequent_public_applicant');
    assert.equal((await rows('SELECT status FROM admin_access_requests WHERE id = ?', [secondRequest]))[0].status, 'pending');
    assert.equal((await api('/api/auth/admin/login', null, { username: 'subsequent_public_applicant', password: applicantPassword })).status, 401);
    assert.equal((await api(`/api/admin/admin-access-requests/${firstRequest}/approve`, null, {})).status, 401);
    const approved = await api(`/api/admin/admin-access-requests/${firstRequest}/approve`, system.data.token, {});
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.data.user.permissions, []);
    const firstLogin = await api('/api/auth/admin/login', null, { username: 'first_public_applicant', password: applicantPassword });
    assert.equal(firstLogin.status, 200);
    assert.equal((await api(`/api/admin/admin-access-requests/${secondRequest}/approve`, firstLogin.data.token, {})).status, 403);
    assert.equal((await rows('SELECT status FROM admin_access_requests WHERE id = ?', [secondRequest]))[0].status, 'pending');
    assert.equal((await api(`/api/admin/admin-access-requests/${secondRequest}/approve`, system.data.token, {})).status, 200);
    assert.equal((await api('/api/auth/admin/login', null, { username: 'subsequent_public_applicant', password: applicantPassword })).status, 200);

    const before = await rows('SELECT id, username, role, status FROM users ORDER BY id');
    await assert.rejects(executeFile(process.execPath, [cliPath], cliOptions), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /already initialized.*recovery/i);
      assert.equal((error.stdout + error.stderr).includes(operatorPassword), false);
      return true;
    });
    assert.deepEqual(await rows('SELECT id, username, role, status FROM users ORDER BY id'), before);
    assert.equal((await rows("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin_bootstrap'"))[0].n, 1);
    assert.equal((await rows("SELECT COUNT(*) AS n FROM user_permissions WHERE permission = 'admin:create'"))[0].n, 1);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    require('../../server/infrastructure/database').resetDatabase();
    await database.close();
  }
});
