const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../../frontend/js/admin/adminViewState');

function fixture() {
  const values = new Map([['up_session', JSON.stringify({ id: 1, role: 'admin' })]]);
  const environment = { sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    location: { hash: '' }, history: { pushState(_, __, hash) { environment.location.hash = hash; }, replaceState(_, __, hash) { environment.location.hash = hash; } } };
  return { values, environment, store: create(environment) };
}

test('admin view restores its screen and query state without storing report or credential data', () => {
  const { store, values } = fixture();
  store.save({ section: 'accountsSection', accountTab: 'admin', accountPage: 2, accountQuery: { search: 'staff', status: 'active' } });
  assert.equal(store.read().section, 'accountsSection');
  assert.equal(store.read().accountPage, 2);
  assert.equal(store.read().accountQuery.search, 'staff');
  assert.equal(values.get('neighborlens:admin-view:v1:1').includes('apiToken'), false);
});

test('admin URL route wins over a saved screen and navigation writes a restorable route', () => {
  const { store, environment } = fixture();
  store.save({ section: 'accountsSection' });
  store.navigate('reportsSection');
  assert.equal(environment.location.hash, '#reports');
  assert.equal(store.read().section, 'reportsSection');
  environment.location.hash = '#constructor';
  assert.equal(store.sectionFromHash(), null);
  assert.equal(store.read().section, 'accountsSection');
});

test('admin view state is isolated per account and malformed snapshots are safe', () => {
  const { store, environment, values } = fixture();
  store.save({ section: 'logsSection', reportsPage: -1 });
  assert.equal(store.read().reportsPage, 1);
  values.set('up_session', JSON.stringify({ id: 2, role: 'admin' }));
  assert.equal(store.read().section, 'analyticsSection');
  values.set('neighborlens:admin-view:v1:2', '{');
  assert.equal(store.read().section, 'analyticsSection');
  environment.sessionStorage.getItem = () => { throw new Error('Blocked'); };
  assert.equal(store.read().section, 'analyticsSection');
  store.save({ section: 'reportsSection' });
});

test('analytics period survives unrelated section, filter and pagination snapshots', () => {
  const { store, values } = fixture();
  store.save({ analyticsDays: 7 });
  store.save({ section: 'reportsSection', reportsPage: 3 });
  assert.equal(store.read().analyticsDays, 7);
  assert.equal(store.read().reportsPage, 3);
  values.set('up_session', JSON.stringify({ id: 2, role: 'admin' }));
  assert.equal(store.read().analyticsDays, 30);
});

test('bookmarks and saved state for the retired overview open Analytics', () => {
  const { store, environment } = fixture();
  store.save({ section: 'overviewSection' });
  assert.equal(store.read().section, 'analyticsSection');
  environment.location.hash = '#overview';
  assert.equal(store.read().section, 'analyticsSection');
});
