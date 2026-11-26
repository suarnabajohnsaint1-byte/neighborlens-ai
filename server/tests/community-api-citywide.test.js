const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the shared feed sends area scope without sending a client-selected Barangay ID', async () => {
  const calls = [], window = { apiRequest: async url => { calls.push(url); return {}; } };
  vm.runInNewContext(fs.readFileSync(path.resolve('frontend/js/community/communityApi.js'), 'utf8'), { window, URLSearchParams });
  await window.CommunityApi.list({ page: 2, pageSize: 10, sort: 'reacted', search: 'road', scope: 'local', barangay: 'Villamonte', barangayId: 60 });
  await window.CommunityApi.list({ scope: 'citywide' });
  const url = new URL(calls[0], 'http://127.0.0.1');
  assert.equal(url.searchParams.has('barangay'), false); assert.equal(url.searchParams.has('barangayId'), false);
  assert.equal(url.searchParams.get('page'), '2'); assert.equal(url.searchParams.get('search'), 'road'); assert.equal(url.searchParams.get('sort'), 'reacted');
  assert.equal(url.searchParams.get('scope'), 'local');
  assert.equal(new URL(calls[1], 'http://127.0.0.1').searchParams.get('scope'), 'citywide');
});
