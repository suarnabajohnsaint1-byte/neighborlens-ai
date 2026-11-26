const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function actor(id, role, barangay = 'Barangay A') {
  return { id, username: `user-${id}`, role, barangay, apiToken: `token-${id}-${role}` };
}

function report(id, owner = 1, barangay = 'Barangay A') {
  return { id: `RPT_SRV_${id}`, backendId: id, description: `Private clarification ${id}`,
    barangay, submittedById: owner, submittedBy: `user-${owner}`, submittedByRole: 'citizen',
    status: 'pending', visionDetected: true, aiCategory: 'pothole', citizenCategory: 'Street Light Damage',
    originalAi: { status: 'DETECTED', canonical_class: 'pothole', suggested_category: 'Road Damage', confidence: 0.9, photos: [] } };
}

function serverRow(row) {
  return { id: row.backendId, description: row.description, barangay: row.barangay,
    submitted_by: row.submittedById, submitted_by_username: row.submittedBy,
    status: row.status, citizenCategory: row.citizenCategory, originalAi: row.originalAi };
}

function browser(session = actor(9, 'admin'), persisted = new Map(), sessionValues = new Map()) {
  let current = session;
  let response = { ok: true, json: async () => ({ reports: [] }) };
  const nodes = new Map();
  const storage = { getItem: key => persisted.get(key) ?? null,
    setItem: (key, value) => persisted.set(key, String(value)), removeItem: key => persisted.delete(key) };
  sessionValues.set('up_session', JSON.stringify(session));
  const sessionStorage = { getItem: key => sessionValues.get(key) ?? null,
    setItem: (key, value) => sessionValues.set(key, String(value)), removeItem: key => sessionValues.delete(key) };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, dataset: {}, closest: () => ({ hidden: false }) });
    return nodes.get(id);
  };
  const context = vm.createContext({ console, FormData, File, atob, AbortController, clearTimeout, localStorage: storage, sessionStorage,
    getSession: () => current, fetch: async () => typeof response === 'function' ? response() : response,
    document: { addEventListener() {}, getElementById: id => id === 'logBox' ? null : node(id), querySelectorAll: () => [], querySelector: () => null },
    CustomEvent: class {}, setTimeout() {},
    window: { matchMedia: () => ({ matches: false }), ReportCard: require('../../frontend/js/shared/reportCard'), ReportVocabulary: require('../../shared/reportVocabulary'), ManilaDates: require('../../shared/manilaDates'), addEventListener() {}, dispatchEvent() {}, location: { pathname: '/barangay.html' }, NEIGHBORLENS_API_BASE_URL: 'http://isolated.test' } });
  for (const file of ['shared/portalComponents.js', 'shared/reports.js', 'auth/security.js', 'barangay/barangay.js', 'admin/admin_logic.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), context);
  }
  return { context, persisted, sessionValues, node,
    switchTo: value => { current = value; sessionStorage.setItem('up_session', JSON.stringify(value)); },
    respond: value => { response = value; },
    logout: () => { context.window.logout(); current = null; } };
}

for (const [name, first, second] of [
  ['admin to barangay', actor(9, 'admin'), actor(2, 'barangay', 'Barangay B')],
  ['barangay to barangay', actor(1, 'barangay'), actor(2, 'barangay', 'Barangay B')],
  ['citizen to citizen', actor(1, 'citizen'), actor(2, 'citizen')]
]) {
  test(`Phase 2 cache: ${name} logout removes prior reports without removing preferences`, () => {
    const app = browser(first);
    app.persisted.set('theme-preference', 'dark');
    app.context.saveReports([report(1)]);
    assert.equal(app.context.getAllReports().length, 1);
    app.logout();
    assert.equal(app.persisted.has('up_reports'), false);
    assert.equal(app.sessionValues.has('up_reports'), false);
    app.switchTo(second);
    assert.equal(app.context.getAllReports().length, 0);
    assert.equal(app.persisted.get('theme-preference'), 'dark');
  });
}

for (const next of [actor(2, 'admin'), actor(9, 'barangay'), actor(9, 'admin', 'Barangay B')]) {
  test(`Phase 2 cache: identity/access context change ${JSON.stringify(next)} invalidates prior data`, () => {
    const app = browser();
    app.context.saveReports([report(1)]);
    app.switchTo(next);
    assert.equal(app.context.getAllReports().length, 0);
    assert.equal(app.persisted.has('up_reports'), false);
    assert.equal(app.sessionValues.has('up_reports'), false);
  });
}

test('Phase 2 cache: same user refresh retains scoped authorized records and reloads them', async () => {
  const first = browser();
  first.context.saveReports([report(1)]);
  const refreshed = browser(actor(9, 'admin'), first.persisted, first.sessionValues);
  assert.equal(refreshed.context.getAllReports().length, 1);
  refreshed.respond({ ok: true, json: async () => ({ reports: [serverRow(report(1))] }) });
  await refreshed.context.syncReportsFromBackend();
  assert.equal(refreshed.context.getAllReports().length, 1);
});

test('report synchronization refreshes mutable server fields and removes deleted evidence', async () => {
  const app = browser();
  const original = { ...report(1), description: 'Old description', images: ['/old.jpg'], image: '/old.jpg' };
  app.context.saveReports([original]);
  app.respond({ ok: true, json: async () => ({ reports: [{ ...serverRow(original),
    description: 'Updated description', location: 'Updated location', latitude: '10.67', longitude: '122.95',
    gps_accuracy: '12', updated_at: '2026-10-15 12:00:00', images: []
  }] }) });
  await app.context.syncReportsFromBackend();
  const updated = app.context.getAllReports()[0];
  assert.equal(updated.description, 'Updated description');
  assert.equal(updated.location, 'Updated location');
  assert.equal(updated.lat, 10.67);
  assert.equal(updated.lng, 122.95);
  assert.equal(updated.accuracy, 12);
  assert.equal(updated.updatedAt, '2026-10-15 12:00:00');
  assert.deepEqual(Array.from(updated.images), []);
  assert.equal(updated.image, '');
});

test('report cache is isolated between portal tabs that share localStorage', async () => {
  const shared = new Map();
  const citizen = browser(actor(1, 'citizen'), shared);
  citizen.context.saveReports([report(1)]);
  const admin = browser(actor(9, 'admin'), shared);
  admin.context.saveReports([report(1), report(2, 2)]);
  assert.equal(citizen.context.getAllReports().length, 1);
  assert.equal(admin.context.getAllReports().length, 2);
  admin.logout();
  assert.equal(citizen.context.getAllReports().length, 1);
  assert.equal(shared.has('up_reports'), false);
  assert.equal(shared.has('up_reports_context'), false);
  assert.equal(admin.sessionValues.has('up_reports'), false);
});

test('Phase 2 cache: legacy unscoped storage is discarded rather than assigned to the next actor', () => {
  const app = browser(actor(2, 'barangay', 'Barangay B'), new Map([['up_reports', JSON.stringify([report(1)])]]));
  assert.equal(app.context.getAllReports().length, 0);
});

test('Phase 2 cache: cross-jurisdiction and cross-citizen records cannot be read or rendered', () => {
  for (const session of [actor(2, 'barangay', 'Barangay B'), actor(2, 'citizen')]) {
    const app = browser(session);
    app.context.saveReports([report(1)]);
    assert.equal(app.context.getAllReports().length, 0);
    app.context.adminViewReport('RPT_SRV_1');
    assert.equal(app.node('modalBody').innerHTML, '');
  }
});

test('Barangay state disposal clears authorized records and ignores a late read', async () => {
  const { create } = require('../../frontend/js/barangay/reportState');
  let finish;
  const state = create({ query: { page: 1 }, session: () => actor(1, 'barangay'), mutations: { pending: () => false, revision: () => 0 },
    load: () => new Promise(resolve => { finish = resolve; }), changed() {} });
  const pending = state.refresh();
  await Promise.resolve();
  state.destroy();
  finish({ reports: [report(1)], pagination: { page: 1 }, stats: { total: 1 } });
  await pending;
  assert.equal(state.snapshot().data, null);
});

test('Phase 2 cache: narrower API results remove omitted reports and invalidate their open modal', async () => {
  const app = browser();
  app.context.saveReports([report(1), report(2)]);
  app.context.adminViewReport('RPT_SRV_1');
  app.respond({ ok: true, json: async () => ({ reports: [serverRow(report(2))] }) });
  await app.context.syncReportsFromBackend();
  assert.deepEqual(Array.from(app.context.getAllReports(), row => row.backendId), [2]);
  assert.equal(app.node('modalBody').innerHTML, '');
});

for (const [name, response] of [
  ['empty', { ok: true, json: async () => ({ reports: [] }) }],
  ['access denial', { ok: false, status: 403 }],
  ['malformed body', { ok: true, json: async () => ({}) }],
  ['network error', () => { throw new Error('Isolated network failure'); }]
]) {
  test(`Phase 2 cache: ${name} response does not retain stale reports`, async () => {
    const app = browser();
    app.context.saveReports([report(1)]);
    app.respond(response);
    await app.context.syncReportsFromBackend();
    assert.equal(app.context.getAllReports().length, 0);
  });
}

test('Phase 2 cache: delayed GET cannot write data after session switching', async () => {
  const app = browser();
  let finish;
  app.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = app.context.syncReportsFromBackend();
  app.switchTo(actor(2, 'barangay', 'Barangay B'));
  finish({ ok: true, json: async () => ({ reports: [serverRow(report(1))] }) });
  await pending;
  assert.equal(app.context.getAllReports().length, 0);
});

test('admin dashboard retains scoped records for transient outages but clears them for access denial', async () => {
  const app = browser();
  app.context.saveReports([report(1)]);
  app.respond({ ok: false, status: 503 });
  await app.context.syncReportsFromBackend();
  assert.equal(app.context.getAllReports().length, 1);
  assert.equal(app.context.getReportLoadState().status, 'error');
  app.respond({ ok: false, status: 403 });
  await app.context.syncReportsFromBackend();
  assert.equal(app.context.getAllReports().length, 0);
});

test('Phase 2 cache: older broad GET cannot restore reports after a newer narrow response', async () => {
  const app = browser();
  let finish;
  app.respond(() => new Promise(resolve => { finish = resolve; }));
  const older = app.context.syncReportsFromBackend();
  app.respond({ ok: true, json: async () => ({ reports: [] }) });
  await app.context.syncReportsFromBackend();
  finish({ ok: true, json: async () => ({ reports: [serverRow(report(1))] }) });
  await older;
  assert.equal(app.context.getAllReports().length, 0);
});

test('Phase 2 cache: delayed POST cannot repopulate a logged-out or different account cache', async () => {
  const app = browser(actor(1, 'citizen'));
  let finish;
  app.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = app.context.addReport({ description: 'Old account report', submittedById: 1 });
  app.logout();
  app.switchTo(actor(2, 'citizen'));
  finish({ ok: true, json: async () => ({ id: 1, citizenCategory: 'Road Damage', originalAi: report(1).originalAi }) });
  assert.equal((await pending.syncPromise).ok, false);
  assert.equal(app.context.getAllReports().length, 0);
});

test('Phase 2 cache: metadata never persists the bearer token or assessment proof', () => {
  const app = browser();
  app.context.saveReports([report(1)]);
  const metadata = app.sessionValues.get('up_reports_context');
  assert.ok(metadata.includes('admin'));
  assert.ok(!metadata.includes('token-'));
  assert.ok(!metadata.includes('assessmentProof'));
});

for (const role of ['admin', 'barangay']) {
  for (const scenario of ['corrected', 'unchanged', 'legacy']) {
    test(`Phase 2 labels: ${role} ${scenario} category has accurate attribution`, () => {
      const app = browser(actor(9, role));
      const row = report(1);
      if (scenario === 'unchanged') row.citizenCategory = 'Road Damage';
      if (scenario === 'legacy') { row.originalAi = null; row.citizenCategory = null; row.aiCategory = 'Road Damage'; }
      app.context.saveReports([row]);
      if (role === 'admin') app.context.renderAdminReports();
      const markup = role === 'admin' ? app.node('adminReportsBody').innerHTML : require('../../frontend/js/shared/reportCard').render(row, { staff: true });
      if (scenario === 'legacy') {
        assert.ok(markup.includes('Road Damage'));
        if (role === 'admin') assert.ok(markup.includes('Detected by Vision AI'));
        else assert.ok(!markup.includes('AI detected:'));
      }
      else {
        if (role === 'admin' || scenario === 'corrected') assert.ok(markup.includes(row.citizenCategory));
        if (role === 'admin') assert.ok(markup.includes(scenario === 'corrected' ? 'Citizen correction' : 'Citizen category'));
        else assert.ok(!markup.includes('AI detected:'));
        assert.ok(!markup.includes('Detected by Vision AI'));
        assert.ok(!markup.includes('\u{1F916}'));
      }
    });
  }
}
