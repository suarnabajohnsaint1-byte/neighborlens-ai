const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OFFICIAL = {
  id: 12, username: 'brgy_villamonte', role: 'barangay', fullName: 'Kapitan Villamonte',
  barangay: 'Villamonte', barangayId: 60, status: 'active', version: 4, createdAt: '2026-10-15 09:00:00'
};

const ADMINS = [
  { id: 1, username: 'admin', role: 'admin', fullName: 'First Admin', status: 'active', version: 0, permissions: ['admin:create'], isSelf: true, createdAt: '2026-10-01 09:00:00' },
  { id: 2, username: 'admin_b', role: 'admin', fullName: 'Second Admin', status: 'active', version: 3, permissions: [], isSelf: false, createdAt: '2026-10-02 09:00:00' }
];

function harness({ role = 'admin', barangay = null, legacy = null, serverReports = [] } = {}) {
  const nodes = new Map();
  const calls = [];
  let responder = async () => ({});
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
        classList: { add() {}, remove() {} }, addEventListener() {}, prepend() {} });
    }
    return nodes.get(id);
  };
  const persisted = new Map(legacy ? [['up_users', JSON.stringify(legacy)]] : []);
  const session = { id: role === 'admin' ? 1 : 12, username: 'tester', role, barangay, apiToken: 'token-under-test' };
  const sessionValues = new Map([['up_session', JSON.stringify(session)]]);
  const window = {
    ReportVocabulary: require('../../shared/reportVocabulary'), ManilaDates: require('../../shared/manilaDates'),
    addEventListener() {}, dispatchEvent() {}, location: { pathname: `/${role}.html`, hostname: '127.0.0.1' },
    apiRequest: async (pathName, options = {}) => {
      calls.push({ path: pathName, method: options.method || 'GET', body: options.body });
      return responder(pathName, options);
    }
  };
  const context = vm.createContext({
    console, window, self: window, AbortController, CustomEvent: class {}, setTimeout() {}, setInterval() {}, clearTimeout() {},
    localStorage: { getItem: key => persisted.get(key) ?? null, setItem: (key, value) => persisted.set(key, String(value)), removeItem: key => persisted.delete(key) },
    sessionStorage: { getItem: key => sessionValues.get(key) ?? null, setItem: (key, value) => sessionValues.set(key, value), removeItem: key => sessionValues.delete(key) },
    getSession: () => session,
    fetch: async () => ({ ok: true, json: async () => ({ reports: serverReports }) }),
    document: {
      addEventListener() {}, getElementById: node, querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ className: '', textContent: '' })
    }
  });
  node('accountPageSize').value = '10';
  node('auditPageSize').value = '10';
  for (const file of ['shared/portalComponents.js', 'shared/reports.js', 'shared/reportPresentation.js', 'shared/activityLogView.js', 'admin/admin_logic.js', 'barangay/barangay.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), context);
  }
  return { context, node, calls, persisted, respond: fn => { responder = fn; } };
}

test('admin account list renders MySQL-backed officials with status and actions', async () => {
  const app = harness();
  app.respond(async () => ({ users: [OFFICIAL, { ...OFFICIAL, id: 13, username: 'brgy_one', barangay: 'Barangay 1', barangayId: 1, status: 'suspended' }] }));
  await app.context.loadOfficials();
  const markup = app.node('brgyAccountsBody').innerHTML;
  assert.deepEqual(app.calls.map(c => c.path), ['/api/admin/barangay-users']);
  assert.match(markup, /brgy_villamonte/);
  assert.match(markup, /Kapitan Villamonte/);
  assert.match(markup, /Suspended/);
  assert.match(markup, /Reactivate/);
  assert.match(markup, /openEditAccountModal\(12\)/);
  assert.doesNotMatch(markup, /localStorage|passwordHash/);
});

test('admin account list shows empty and error states', async () => {
  const app = harness();
  app.respond(async () => ({ users: [] }));
  await app.context.loadOfficials();
  assert.match(app.node('brgyAccountsBody').innerHTML, /No barangay accounts yet/);

  app.respond(async () => { throw new Error('You do not have permission to perform this action.'); });
  await app.context.loadOfficials();
  assert.match(app.node('brgyAccountsBody').innerHTML, /You do not have permission/);
  assert.match(app.node('brgyAccountsBody').innerHTML, /Retry/);
});

test('creating an official posts to the API and never stores credentials in the browser', async () => {
  const app = harness();
  app.respond(async (pathName) => pathName === '/api/admin/barangay-users' ? { users: [OFFICIAL] } : {});
  app.context.window.openCreateAccountModal();
  app.node('accUsername').value = 'brgy_villamonte';
  app.node('accFullName').value = 'Kapitan Villamonte';
  app.node('accBarangay').value = '60';
  app.node('accPassword').value = 'Barangay2026';
  app.node('accPasswordConfirm').value = 'Barangay2026';
  await app.context.window.saveBarangayAccount();

  const create = app.calls.find(c => c.method === 'POST');
  assert.equal(create.path, '/api/admin/barangay-users');
  assert.deepEqual({ ...create.body }, { username: 'brgy_villamonte', password: 'Barangay2026', fullName: 'Kapitan Villamonte', barangayId: 60 });
  assert.equal(app.persisted.has('up_users'), false);
  assert.equal(app.node('accPassword').value, '');
  assert.match(app.node('accountFormMsg').textContent, /created/);
});

test('client validation blocks weak passwords and missing barangays before any request', async () => {
  const app = harness();
  app.context.window.openCreateAccountModal();
  app.node('accUsername').value = 'brgy_new';
  app.node('accBarangay').value = '';
  app.node('accPassword').value = 'Barangay2026';
  await app.context.window.saveBarangayAccount();
  assert.match(app.node('accountFormMsg').textContent, /assign a barangay/);

  app.node('accBarangay').value = '5';
  app.node('accPassword').value = 'password';
  await app.context.window.saveBarangayAccount();
  assert.match(app.node('accountFormMsg').textContent, /letter and one number/);
  app.node('accPassword').value = 'Barangay2026';
  await app.context.window.saveBarangayAccount();
  assert.match(app.node('accountFormMsg').textContent, /Passwords do not match/);
  assert.equal(app.calls.length, 0);
});

test('server validation errors from account creation are shown to the admin', async () => {
  const app = harness();
  app.respond(async (pathName, options) => {
    if (options.method === 'POST') { const error = new Error('Username already exists.'); error.status = 409; throw error; }
    return { users: [] };
  });
  app.context.window.openCreateAccountModal();
  Object.assign(app.node('accUsername'), { value: 'brgy_dupe' });
  Object.assign(app.node('accBarangay'), { value: '3' });
  Object.assign(app.node('accPassword'), { value: 'Barangay2026' });
  app.node('accPasswordConfirm').value = 'Barangay2026';
  await app.context.window.saveBarangayAccount();
  assert.match(app.node('accountFormMsg').textContent, /^Username already exists\./);
});

test('editing updates the profile and resets the password only when one is entered', async () => {
  const app = harness();
  app.respond(async (pathName, options) => options.method === 'PATCH' ? { user: { ...OFFICIAL, version: 5 } } : { users: [OFFICIAL] });
  await app.context.loadOfficials();
  app.calls.length = 0;

  app.context.window.openEditAccountModal(12);
  assert.equal(app.node('accUsername').disabled, true);
  assert.equal(app.node('accBarangay').value, '60');
  app.node('accFullName').value = 'Kapitana Bago';
  app.node('accBarangay').value = '1';
  await app.context.window.saveBarangayAccount();
  assert.deepEqual(app.calls.filter(c => c.method !== 'GET').map(c => [c.method, c.path, { ...c.body }]), [
    ['PATCH', '/api/admin/barangay-users/12', { fullName: 'Kapitana Bago', barangayId: 1, version: 4 }]
  ]);

  app.calls.length = 0;
  app.context.window.openEditAccountModal(12);
  app.node('accPassword').value = 'Rotated2026';
  app.node('accPasswordConfirm').value = 'Rotated2026';
  await app.context.window.saveBarangayAccount();
  assert.deepEqual(app.calls.filter(c => c.method !== 'GET').map(c => c.path), [
    '/api/admin/barangay-users/12',
    '/api/admin/barangay-users/12/password'
  ]);
  assert.deepEqual({ ...app.calls.find(c => c.path.endsWith('/password')).body }, { password: 'Rotated2026', version: 5 });
});

test('suspension is confirmed in a modal and persisted through the status endpoint', async () => {
  const app = harness();
  app.respond(async () => ({ users: [OFFICIAL] }));
  await app.context.loadOfficials();
  app.context.window.openAccountStatusModal(12);
  assert.equal(app.node('statusModalTitle').textContent, 'Suspend Account');
  assert.match(app.node('deleteModalMsg').textContent, /signed out immediately/);
  await app.context.window.confirmAccountStatus();
  const patch = app.calls.find(c => c.method === 'PATCH');
  assert.equal(patch.path, '/api/admin/barangay-users/12/status');
  assert.deepEqual({ ...patch.body }, { status: 'suspended', version: 4 });
});

test('legacy browser-only accounts are reported, never imported, and can be cleared', () => {
  const app = harness({ legacy: [{ id: 'user_brgy_1', username: 'old_local', role: 'barangay', barangay: 'Bata', passwordHash: 'abc' }] });
  app.context.renderLegacyAccountsNotice();
  const notice = app.node('legacyAccountsNotice');
  assert.match(notice.innerHTML, /old_local/);
  assert.match(notice.innerHTML, /never saved to the server/);
  assert.doesNotMatch(notice.innerHTML, /abc/);
  app.context.window.clearLegacyAccounts();
  assert.equal(app.persisted.has('up_users'), false);
  assert.equal(app.node('legacyAccountsNotice').style.display, 'none');
  assert.equal(app.calls.length, 0);
});

test('system logs render real audit entries and escape their content', async () => {
  const app = harness();
  app.respond(async () => ({ total: 2, logs: [
    { id: 2, actor_username: 'admin', action: 'official_suspend', entity_type: 'user', entity_id: 12, details: { from: 'active', to: 'suspended' }, created_at: '2026-10-15 10:00:00' },
    { id: 1, actor_username: '<img src=x>', action: 'login', entity_type: 'user', entity_id: 3, details: null, created_at: '2026-10-15 09:00:00' }
  ] }));
  vm.runInContext("_activeAdminSection = 'logsSection'", app.context);
  await app.context.loadAuditLogs();
  const markup = app.node('logBox').innerHTML;
  assert.equal(app.calls[0].path, '/api/admin/audit-logs?limit=10&offset=0');
  assert.match(markup, /admin suspended official account user #12 \(active → suspended\)/);
  assert.match(markup, /&lt;img src=x&gt;/);
  assert.doesNotMatch(markup, /Heartbeat|No anomalies/);
});

test('system logs show an error instead of simulated entries when the API fails', async () => {
  const app = harness();
  app.respond(async () => { throw new Error('Insufficient permissions.'); });
  vm.runInContext("_activeAdminSection = 'logsSection'", app.context);
  await app.context.loadAuditLogs();
  assert.match(app.node('logBox').innerHTML, /Audit log unavailable: Insufficient permissions/);
});

test('shared status mutations wait for the server and leave caller state unchanged on failure', async () => {
  const { create } = require('../../frontend/js/shared/reportMutations');
  const phases = [];
  const model = { status: 'pending' };
  let failure = true;
  const mutations = create({ session: () => ({ id: 12, role: 'barangay', apiToken: 'fixture' }), changed: event => phases.push(event.phase),
    request: async (url, options) => {
      assert.equal(url, '/api/reports/7/status');
      assert.equal(options.body.status, 'ongoing');
      if (failure) throw new Error('Report is outside your barangay.');
      return { status: 'ongoing' };
    } });
  await assert.rejects(mutations.update(7, 'ongoing'), /outside/);
  assert.equal(model.status, 'pending');
  failure = false;
  model.status = (await mutations.update(7, 'ongoing')).status;
  assert.equal(model.status, 'ongoing');
  assert.deepEqual(phases, ['started', 'failed', 'started', 'saved']);
});

test('shared report presentation accepts MySQL decimal-string coordinates', () => {
  const presentation = require('../../frontend/js/shared/reportPresentation');
  assert.deepEqual(presentation.coordinates({ latitude: '10.6780000', longitude: '122.9460000' }), { lat: 10.678, lng: 122.946 });
  const markup = require('../../frontend/js/shared/reportCard').render({ id: 8, ai_category: 'road_crack', barangay: 'Villamonte', latitude: '10.6780000', longitude: '122.9460000' }, { staff: true });
  assert.match(markup, /Road Crack/);
  assert.doesNotMatch(markup, /NaN/);
});

test('administrators tab shows other admins read only and only your own row as manageable', async () => {
  const app = harness();
  app.respond(async () => ({ users: ADMINS, canCreateAdmins: true }));
  await app.context.loadAdministrators();
  app.context.window.setAccountTab('admin');
  const [selfRow, otherRow] = app.node('brgyAccountsBody').innerHTML.split('<tr>').slice(1);
  assert.match(selfRow, />You</);
  assert.match(selfRow, /Manage my account/);
  assert.match(selfRow, /Can provision administrators/);
  assert.match(otherRow, /admin_b/);
  assert.match(otherRow, /Read only/);
  assert.doesNotMatch(otherRow, /Edit|Suspend|Reactivate|password|Manage my account/i);
  assert.equal(app.node('addAdminBtn').hidden, false);
});

test('the add administrator action is hidden without the server-granted permission', async () => {
  const app = harness();
  app.respond(async () => ({ users: ADMINS.map(a => ({ ...a, isSelf: a.id === 2 })), canCreateAdmins: false }));
  await app.context.loadAdministrators();
  assert.equal(app.node('addAdminBtn').hidden, true);
  app.context.window.openCreateAdminModal();
  assert.notEqual(app.node('accountModal').style.display, 'flex');
});

test('creating an administrator posts to the admin endpoint with the stricter password policy', async () => {
  const app = harness();
  app.respond(async (pathName, options) => options.method === 'POST' ? { user: { id: 9 } } : { users: ADMINS, canCreateAdmins: true });
  await app.context.loadAdministrators();
  app.context.window.openCreateAdminModal();
  assert.equal(app.node('accBarangayGroup').style.display, 'none');
  app.node('accUsername').value = 'admin_c';
  app.node('accPassword').value = 'Short2026';
  await app.context.window.saveBarangayAccount();
  assert.match(app.node('accountFormMsg').textContent, /at least 12/);
  app.node('accPassword').value = 'LongerAdmin2026';
  app.node('accPasswordConfirm').value = 'LongerAdmin2026';
  await app.context.window.saveBarangayAccount();
  const create = app.calls.find(c => c.method === 'POST');
  assert.equal(create.path, '/api/admin/admins');
  assert.deepEqual({ ...create.body }, { username: 'admin_c', password: 'LongerAdmin2026', fullName: '' });
});

test('my account changes the name and password with versions and keeps the new session token', async () => {
  const app = harness();
  app.respond(async (pathName, options) => {
    if (pathName === '/api/auth/me/account' && !options.method) return { user: { id: 1, username: 'admin', fullName: 'Old Name', version: 2 } };
    if (pathName === '/api/auth/me/account') return { user: { id: 1, username: 'admin', fullName: 'New Name', version: 3 } };
    if (pathName === '/api/auth/me/password') return { token: 'rotated-token', user: { id: 1 } };
    return { users: [] };
  });
  await app.context.window.openOwnAccountModal();
  assert.equal(app.node('accCurrentPassGroup').style.display, '');
  app.node('accFullName').value = 'New Name';
  app.node('accCurrentPassword').value = 'CurrentAdmin2026';
  app.node('accPassword').value = 'RotatedAdmin2026';
  app.node('accPasswordConfirm').value = 'RotatedAdmin2026';
  await app.context.window.saveBarangayAccount();
  const mutations = app.calls.filter(c => c.method === 'PATCH' || c.method === 'POST');
  assert.deepEqual(mutations.map(c => [c.path, { ...c.body }]), [
    ['/api/auth/me/account', { fullName: 'New Name', version: 2 }],
    ['/api/auth/me/password', { currentPassword: 'CurrentAdmin2026', newPassword: 'RotatedAdmin2026', version: 3 }]
  ]);
  assert.equal(JSON.parse(app.context.sessionStorage.getItem('up_session')).apiToken, 'rotated-token');
});

test('conflicting account changes are explained and the list reloads instead of overwriting', async () => {
  const app = harness();
  app.respond(async (pathName, options) => {
    if (options.method === 'PATCH') {
      const error = new Error('This account was changed by someone else. Reload it and try again.');
      error.status = 409;
      throw error;
    }
    return { users: [OFFICIAL] };
  });
  await app.context.loadOfficials();
  app.context.window.openEditAccountModal(12);
  app.node('accFullName').value = 'Changed';
  await app.context.window.saveBarangayAccount();
  assert.match(app.node('accountFormMsg').textContent, /changed by someone else.*reloaded/);
  assert.ok(app.calls.filter(c => c.path === '/api/admin/barangay-users').length >= 2);
});

test('account search, status filter, sort, and pagination apply to the loaded list', async () => {
  const app = harness();
  const officials = Array.from({ length: 23 }, (_, index) => ({
    ...OFFICIAL, id: 100 + index, username: `brgy_${String(index).padStart(2, '0')}`,
    status: index % 5 === 0 ? 'suspended' : 'active', barangay: index % 2 ? 'Villamonte' : 'Bata'
  }));
  app.respond(async () => ({ users: officials }));
  await app.context.loadOfficials();
  assert.match(app.node('accountPageInfo').textContent, /1-10 of 23 accounts/);
  app.context.window.changeAccountPage(2);
  assert.match(app.node('accountPageInfo').textContent, /21-23 of 23 accounts/);
  app.context.window.setAccountQuery('status', 'suspended');
  assert.match(app.node('accountPageInfo').textContent, /of 5 /);
  app.context.window.setAccountQuery('search', 'brgy_05');
  assert.match(app.node('brgyAccountsBody').innerHTML, /brgy_05/);
  assert.doesNotMatch(app.node('brgyAccountsBody').innerHTML, /brgy_10/);
  app.context.window.setAccountQuery('search', 'nobody');
  assert.match(app.node('brgyAccountsBody').innerHTML, /No accounts match/);
});

test('pending admin sign-up requests are listed for provisioning admins and approved only after confirmation', async () => {
  const app = harness();
  app.respond(async (pathName, options) => {
    if (pathName === '/api/admin/admins') return { users: ADMINS, canCreateAdmins: true };
    if (pathName === '/api/admin/admin-access-requests') return { requests: [{ id: 5, username: 'new_admin', fullName: 'New Admin', reason: '<b>Engineering</b>', createdAt: '2026-10-15 10:00:00' }] };
    if (options.method === 'POST') return { request: { id: 5, status: 'approved' }, user: { id: 20 } };
    return { users: [] };
  });
  await app.context.loadAdministrators();
  await new Promise(resolve => setImmediate(resolve));
  const panel = app.node('adminRequestsList').innerHTML;
  assert.equal(app.node('adminRequestsPanel').style.display, 'block');
  assert.match(panel, /new_admin/);
  assert.match(panel, /&lt;b&gt;Engineering&lt;\/b&gt;/);
  assert.equal(app.calls.filter(c => c.method === 'POST').length, 0);

  app.context.window.openRequestDecisionModal(5, 'approve');
  assert.equal(app.node('statusModalTitle').textContent, 'Approve Administrator');
  await app.context.window.confirmAccountStatus();
  assert.deepEqual(app.calls.filter(c => c.method === 'POST').map(c => c.path), ['/api/admin/admin-access-requests/5/approve']);
});

test('admins without provisioning permission never see or load access requests', async () => {
  const app = harness();
  app.respond(async () => ({ users: ADMINS, canCreateAdmins: false }));
  await app.context.loadAdministrators();
  assert.notEqual(app.node('adminRequestsPanel').style.display, 'block');
  assert.equal(app.calls.some(c => c.path.includes('admin-access-requests')), false);
});
