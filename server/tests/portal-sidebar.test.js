const test = require('node:test');
const assert = require('node:assert/strict');
const sidebar = require('../../frontend/js/shared/portalSidebar');

test('shared sidebar: citizen navigation is reused by portal and report details', () => {
  assert.strictEqual(sidebar.navigation('citizen'), sidebar.navigation('citizen', true));
  const links = sidebar.navigation('citizen').filter(item => !item.disabled);
  assert.deepEqual(links.map(item => item.section), ['submitSection', 'myReportsSection', 'communitySection']);
  assert.deepEqual(links.map(item => item.href), ['citizen.html', 'citizen.html#my-reports', 'citizen.html#community']);
});

test('shared sidebar: Community Feed activates the authorized section with the existing icon', () => {
  const community = sidebar.navigation('citizen')[2];
  assert.equal(community.label, 'Community Feed');
  assert.equal(community.icon, 'bx-group');
  assert.equal(Boolean(community.disabled), false);
  assert.equal(community.href, 'citizen.html#community');
  assert.equal(community.section, 'communitySection');
});

test('shared sidebar: citizen configuration cannot be changed by a consumer', () => {
  const items = sidebar.navigation('citizen');
  assert.equal(Object.isFrozen(items), true);
  assert.equal(items.every(Object.isFrozen), true);
});

test('shared sidebar: admin dashboard and report details use the same immutable full menu', () => {
  const items = sidebar.navigation('admin');
  assert.strictEqual(items, sidebar.navigation('admin', true));
  assert.equal(Object.isFrozen(items), true);
  assert.equal(items.every(Object.isFrozen), true);
  assert.deepEqual(items.map(item => item.href), ['admin.html#accounts', 'admin.html#reports', 'admin.html#gis-map', 'admin.html#logs', 'admin.html#analytics']);
  assert.deepEqual(items.map(item => item.section), ['accountsSection', 'reportsSection', 'gisMapSection', 'logsSection', 'analyticsSection']);
  assert.equal(sidebar.home('admin'), 'admin.html');
});

for (const role of ['barangay']) {
  test(`shared sidebar: ${role} details links to its own portal`, () => {
    const items = sidebar.navigation(role, true);
    assert.equal(items.length, 5);
    assert.deepEqual(items.map(item => item.section), ['reports', 'community', 'gis-map', 'activity', 'analytics']);
    assert.equal(items[1].href, 'barangay.html#community');
    assert.equal(items[0].label, 'Local Reports');
    assert.equal(Object.isFrozen(items[0]), true);
    assert.equal(items[0].href, `${role}.html#reports`);
    assert.equal(sidebar.home(role), `${role}.html`);
    assert.equal(sidebar.navigation(role), items);
  });
}

for (const role of [null, undefined, '', 'superadmin', '__proto__', 'constructor']) {
  test(`shared sidebar: unsupported role ${String(role)} gets no privileged navigation`, () => {
    assert.deepEqual(sidebar.navigation(role, true), []);
    assert.equal(sidebar.home(role), 'login.html');
  });
}
