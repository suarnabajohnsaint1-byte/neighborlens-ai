const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND = path.join(__dirname, '../../frontend/js');

function session(role, overrides = {}) {
  return { id: 7, username: `${role}_user`, role, barangay: role === 'barangay' ? 'Villamonte' : null, apiToken: `token-${role}`, ...overrides };
}

function page(pathname, stored = null, { meResponse = null } = {}) {
  const navigations = [];
  const values = new Map(stored ? [['up_session', typeof stored === 'string' ? stored : JSON.stringify(stored)]] : []);
  const listeners = new Map();
  const fetchCalls = [];
  const location = {
    pathname, hostname: '127.0.0.1', href: `http://127.0.0.1:5500${pathname}`,
    replace(target) { navigations.push(target); }
  };
  const window = { location, addEventListener() {}, dispatchEvent() {} };
  const context = vm.createContext({
    console, window, URL, AbortController, setTimeout, clearTimeout, CustomEvent: class { constructor(type) { this.type = type; } },
    sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener: (event, fn) => listeners.set(event, fn), getElementById: () => null },
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).endsWith('/api/me') && meResponse) return meResponse;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'shared/api.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'auth/security.js'), 'utf8'), context);
  return {
    window, navigations, values, fetchCalls,
    ready: () => listeners.get('DOMContentLoaded')?.(),
    settle: () => new Promise(resolve => setImmediate(resolve))
  };
}

test('one central map routes each backend role to its existing portal', () => {
  const { window } = page('/frontend/login.html');
  assert.equal(window.portalForRole('admin'), 'admin.html');
  assert.equal(window.portalForRole('barangay'), 'barangay.html');
  assert.equal(window.portalForRole('citizen'), 'citizen.html');
  assert.equal(window.portalForRole('superuser'), null);
  assert.equal(window.portalForRole('__proto__'), null);
});

for (const [portal, loginPage] of [
  ['admin.html', 'admin-login.html'],
  ['barangay.html', 'barangay-login.html'],
  ['citizen.html', 'login.html'],
  ['report-details.html', 'login.html']
]) {
  test(`missing session on ${portal} goes to ${loginPage} without claiming the session expired`, () => {
    const app = page(`/frontend/${portal}`);
    assert.equal(app.window.NEIGHBORLENS_ACCESS_GRANTED, false);
    assert.deepEqual(app.navigations, [loginPage]);
  });
}

test('each role has its own login page in the central map', () => {
  const { window } = page('/frontend/login.html');
  assert.equal(window.loginPageForRole('admin'), 'admin-login.html');
  assert.equal(window.loginPageForRole('barangay'), 'barangay-login.html');
  assert.equal(window.loginPageForRole('citizen'), 'login.html');
  assert.equal(window.loginPageForRole('unknown'), 'login.html');
});

test('portal scripts calling the API after a missing-session redirect cannot turn it into an expired-session redirect', async () => {
  const app = page('/frontend/admin.html');
  await assert.rejects(app.window.apiRequest('/api/admin/barangay-users'), { status: 401 });
  app.window.handleSessionExpired();
  assert.deepEqual(app.navigations, ['admin-login.html']);
  assert.equal(app.fetchCalls.length, 0);
});

for (const role of ['admin', 'barangay', 'citizen']) {
  test(`a valid ${role} session is granted its own portal and survives reload`, async () => {
    for (let load = 0; load < 2; load++) {
      const app = page(`/frontend/${role}.html`, session(role), {
        meResponse: { ok: true, status: 200, json: async () => ({ user: { id: 7, role } }) }
      });
      assert.equal(app.window.NEIGHBORLENS_ACCESS_GRANTED, true);
      app.ready();
      await app.settle();
      assert.deepEqual(app.navigations, []);
      assert.equal(app.values.has('up_session'), true);
    }
  });
}

test('a signed-in user who opens another role portal is returned to their own portal, not logged out', () => {
  for (const [role, other] of [['admin', 'citizen'], ['barangay', 'admin'], ['citizen', 'admin'], ['citizen', 'barangay']]) {
    const app = page(`/frontend/${other}.html`, session(role));
    assert.equal(app.window.NEIGHBORLENS_ACCESS_GRANTED, false);
    assert.deepEqual(app.navigations, [`${role}.html`]);
    assert.equal(app.values.has('up_session'), true);
  }
});

test('the admin is never sent into citizen onboarding or the citizen portal', () => {
  const app = page('/frontend/citizen.html', session('admin'));
  assert.deepEqual(app.navigations, ['admin.html']);
  assert.doesNotMatch(app.navigations.join(), /complete-identity|citizen/);
});

test('corrupt, roleless, or tokenless stored sessions are cleared and sent to login', () => {
  for (const stored of ['{not json', JSON.stringify(session('superuser')), JSON.stringify(session('admin', { apiToken: '' }))]) {
    const app = page('/frontend/admin.html', stored);
    assert.deepEqual(app.navigations, ['admin-login.html']);
    assert.equal(app.values.has('up_session'), false);
  }
});

test('a server-rejected session clears local state and shows the expired message once', async () => {
  const app = page('/frontend/admin.html', session('admin'), { meResponse: { ok: false, status: 401, json: async () => ({}) } });
  app.ready();
  await app.settle();
  await app.settle();
  app.window.handleSessionExpired();
  assert.deepEqual(app.navigations, ['admin-login.html?session=expired']);
  assert.equal(app.values.has('up_session'), false);
});

test('a stored role that no longer matches the server account is treated as expired', async () => {
  const app = page('/frontend/admin.html', session('admin'), {
    meResponse: { ok: true, status: 200, json: async () => ({ user: { id: 7, role: 'citizen' } }) }
  });
  app.ready();
  await app.settle();
  await app.settle();
  assert.deepEqual(app.navigations, ['admin-login.html?session=expired']);
});

test('expired barangay and citizen sessions return to their own login pages', async () => {
  for (const [role, loginPage] of [['barangay', 'barangay-login.html'], ['citizen', 'login.html']]) {
    const app = page(`/frontend/${role}.html`, session(role), { meResponse: { ok: false, status: 401, json: async () => ({}) } });
    app.ready();
    await app.settle();
    await app.settle();
    assert.deepEqual(app.navigations, [`${loginPage}?session=expired`]);
  }
});

test('logout clears the session, revokes it on the server, and returns to login', () => {
  const app = page('/frontend/admin.html', session('admin'));
  app.window.logout();
  assert.equal(app.values.has('up_session'), false);
  const revoke = app.fetchCalls.find(call => call.url.endsWith('/api/auth/logout'));
  assert.equal(revoke.init.method, 'POST');
  assert.equal(revoke.init.headers.Authorization, 'Bearer token-admin');
  assert.deepEqual(app.navigations, ['admin-login.html']);
});

test('the login page is public and never redirects, whatever session is stored', () => {
  for (const loginPage of ['login.html', 'admin-login.html', 'barangay-login.html']) {
    for (const stored of [null, session('citizen'), '{broken']) {
      const app = page(`/frontend/${loginPage}`, stored);
      assert.equal(app.window.NEIGHBORLENS_ACCESS_GRANTED, true);
      assert.deepEqual(app.navigations, []);
    }
  }
});

test('login routing, stale-message clearing, and citizen-only recovery are wired through the central map', () => {
  const source = fs.readFileSync(path.join(FRONTEND, 'auth/auth.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/login.html'), 'utf8');
  assert.match(source, /window\.location\.replace\(window\.portalForRole\(session\.role\)\)/);
  assert.doesNotMatch(source, /admin: "admin\.html"/);
  assert.match(source, /message\("loginMsg", ""\);/);
  assert.match(source, /history\.replaceState\(null, "", "login\.html"\)/);
  assert.match(html, /id="recoverIdentityBtn" class="media-toggle-btn" hidden/);
  assert.ok(html.indexOf('js/auth/security.js') < html.indexOf('js/auth/auth.js'));
});
