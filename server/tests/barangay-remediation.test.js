const test = require('node:test');
const assert = require('node:assert/strict');
const vocabulary = require('../../shared/reportVocabulary');
const dates = require('../../shared/manilaDates');
const { create } = require('../../frontend/js/shared/reportMutations');

test('B04 B05: report vocabulary keeps unknown metadata honest and citizen corrections authoritative', () => {
  assert.equal(vocabulary.classification(null), 'UNCLASSIFIED');
  assert.equal(vocabulary.confidence(null), 'Not available');
  assert.equal(vocabulary.confidence(0), '0%');
  assert.equal(vocabulary.statuses.rejected, 'Rejected');
  assert.equal(vocabulary.categoryOf({ aiCategory: 'pothole' }), 'Road Damage');
  assert.equal(vocabulary.categoryOf({ aiCategory: 'broken_streetlight', citizenCategory: 'Road Damage' }), 'Road Damage');
  assert.equal(vocabulary.categoryOf({ aiCategory: 'unknown' }), 'Uncategorized');
  assert.equal(vocabulary.categoryOf({ originalAi: { status: 'LOW_CONFIDENCE', canonical_class: 'pothole' } }), 'Uncategorized');
  assert.deepEqual(vocabulary.reviewStatuses('citizen', 'pending'), []);
  assert.deepEqual(vocabulary.reviewStatuses('barangay', 'resolved'), []);
});

test('B06: Manila intervals include early morning and fractional end-of-day timestamps', () => {
  const range = dates.interval('2026-10-15', '2026-10-15');
  for (const value of ['2026-10-14T17:00:00Z', '2026-10-15T15:59:59.500Z', '2026-10-15 01:00:00']) {
    assert.ok(dates.timestamp(value) >= range.start && dates.timestamp(value) < range.end);
  }
  assert.equal(dates.timestamp('2026-10-15T16:00:00Z') < range.end, false);
  assert.equal(dates.isDay('2026-02-30'), false);
  assert.equal(dates.isDay('invalid'), false);
});

test('B03: mutations deduplicate requests, invalidate reads on both boundaries and reject changed sessions', async () => {
  let user = { id: 1, role: 'barangay', apiToken: 'one' };
  let resolve, calls = 0;
  const phases = [];
  const state = create({ session: () => user, changed: event => phases.push(event.phase), request: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const before = state.revision();
  const first = state.update(1, 'ongoing');
  assert.equal(state.update(1, 'ongoing'), first);
  assert.notEqual(state.revision(), before);
  assert.equal(state.pending(1), true);
  await Promise.resolve();
  const during = state.revision();
  resolve({ id: 1, status: 'ongoing' });
  await first;
  assert.equal(calls, 1);
  assert.notEqual(state.revision(), during);
  assert.deepEqual(phases, ['started', 'saved']);
  const second = state.update(1, 'resolved');
  await Promise.resolve();
  user = { id: 2, role: 'barangay', apiToken: 'two' };
  resolve({ id: 1, status: 'resolved' });
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(state.pending(), false);
});

test('B11: initial pageshow does not repeat a completed initial read; resume after pagehide does', async () => {
  const events = new Map(), timers = new Map();
  let calls = 0, serial = 0;
  const environment = { addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name),
    setTimeout: handler => { const id = ++serial; timers.set(id, handler); return id; }, clearTimeout: id => timers.delete(id) };
  const document = { ...environment, visibilityState: 'visible' };
  const scheduler = require('../../frontend/js/shared/portalRefresh').create({ window: environment, document, refresh: async () => { calls++; } });
  scheduler.start();
  await scheduler.refresh();
  assert.equal(calls, 1);
  events.get('pageshow')();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers.size, 1);
  events.get('pagehide')();
  assert.equal(timers.size, 0);
  events.get('pageshow')();
  await scheduler.refresh();
  assert.equal(calls, 2);
  scheduler.destroy();
  assert.equal(events.size, 0);
  assert.equal(timers.size, 0);
});

test('B03 B10: Barangay reads coalesce, reject old mutation revisions and clear changed-account data', async () => {
  const { create } = require('../../frontend/js/barangay/reportState');
  let user = { id: 1, role: 'barangay', apiToken: 'one' }, revision = 0, finish, error = null;
  const result = { reports: [{ id: 1, status: 'pending' }], stats: { total: 1 }, pagination: { page: 1 } };
  const state = create({ query: { page: 1 }, session: () => user, mutations: { pending: () => false, revision: () => revision }, changed() {},
    load: () => error ? Promise.reject(error) : new Promise(resolve => { finish = resolve; }) });
  const first = state.refresh();
  assert.equal(state.refresh(), first);
  await Promise.resolve();
  revision++;
  finish(result);
  await first;
  assert.equal(state.snapshot().data, null);
  const second = state.refresh(); await Promise.resolve(); finish(result); await second;
  error = Object.assign(new Error('Fixture outage'), { status: 503 });
  await state.refresh();
  assert.equal(state.snapshot().data.stats.total, 1);
  assert.equal(state.snapshot().status, 'error');
  user = { id: 2, role: 'barangay', apiToken: 'two' };
  await state.refresh();
  assert.equal(state.snapshot().data, null);
  state.destroy();
});
