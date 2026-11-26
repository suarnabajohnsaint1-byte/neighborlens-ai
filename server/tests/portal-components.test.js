const test = require('node:test');
const assert = require('node:assert/strict');
const components = require('../../frontend/js/shared/portalComponents');

test('shared loader coalesces concurrent reads and allows a fresh read after completion', async () => {
  let finish;
  let calls = 0;
  const operation = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = components.load('officials', operation);
  const second = components.load('officials', operation);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish('loaded');
  assert.equal(await second, 'loaded');
  assert.equal(await components.load('officials', async () => 'updated'), 'updated');
});

test('shared loader releases failed requests for retry', async () => {
  await assert.rejects(components.load('failure', async () => { throw new Error('Unavailable'); }), /Unavailable/);
  assert.equal(await components.load('failure', async () => 'recovered'), 'recovered');
});

test('shared rendering preserves DOM when its view has not changed', () => {
  let writes = 0;
  const element = { set innerHTML(value) { writes++; this.value = value; } };
  assert.equal(components.render(element, '<p>Report</p>'), true);
  assert.equal(components.render(element, '<p>Report</p>'), false);
  assert.equal(writes, 1);
  assert.equal(components.render(element, '<p>Updated</p>'), true);
  assert.equal(writes, 2);
  components.invalidate(element);
  assert.equal(components.render(element, '<p>Updated</p>'), true);
  assert.equal(writes, 3);
});
