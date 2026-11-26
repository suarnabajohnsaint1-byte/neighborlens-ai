const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const listeners = new Map();
  const intervals = [];
  const storage = new Map();
  const sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  let finish;
  let requests = 0;
  const window = {
    location: { hostname: '127.0.0.1' },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); }
  };
  const context = vm.createContext({ window, console, AbortController, setTimeout, clearTimeout,
    sessionStorage,
    CustomEvent: class { constructor(type) { this.type = type; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    getSession: () => ({ id: 1, username: 'admin', role: 'admin', apiToken: 'test-token' }),
    document: { getElementById: () => null },
    setInterval: callback => intervals.push(callback),
    fetch: () => { requests++; return new Promise(resolve => { finish = resolve; }); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/shared/reports.js'), 'utf8'), context);
  return { context, window, intervals, count: () => requests, finish: () => finish({ ok: true, json: async () => ({ reports: [] }) }) };
}

test('report polling initializes once and does not overlap a pending API request', async () => {
  const app = harness();
  app.window.dispatchEvent({ type: 'DOMContentLoaded' });
  app.window.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.equal(app.intervals.length, 1);
  assert.equal(app.count(), 1);
  app.intervals[0]();
  app.intervals[0]();
  assert.equal(app.count(), 1);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  app.intervals[0]();
  assert.equal(app.count(), 2);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
});

test('one report storage event notifies subscribers once without fetching again', () => {
  const app = harness();
  let renders = 0;
  app.context.onReportsChanged(() => renders++);
  app.window.dispatchEvent({ type: 'storage', key: 'up_reports' });
  assert.equal(renders, 1);
  assert.equal(app.count(), 0);
});

test('shared localStorage report events from another portal do not invalidate or rerender this tab', () => {
  const app = harness();
  let renders = 0;
  app.context.onReportsChanged(() => renders++);
  app.window.dispatchEvent({ type: 'storage', key: 'up_reports', storageArea: app.context.localStorage });
  app.window.dispatchEvent({ type: 'storage', key: 'up_reports_context', storageArea: app.context.localStorage });
  app.window.dispatchEvent({ type: 'storage', key: null, storageArea: app.context.localStorage });
  assert.equal(renders, 0);
  assert.equal(app.count(), 0);
});

test('live refresh events coalesce while a request runs and fetch once more for changes received in flight', async () => {
  const app = harness();
  const first = app.window.refreshReports();
  assert.equal(app.count(), 1);
  assert.equal(app.window.refreshReports(true), first);
  assert.equal(app.window.refreshReports(true), first);
  assert.equal(app.count(), 1);
  app.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.count(), 2);
  app.finish();
  await first;
  assert.equal(app.count(), 2);
});
