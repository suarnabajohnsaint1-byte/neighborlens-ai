const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { create, storageKey } = require('../../frontend/js/shared/themeManager');

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatch(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); },
    count(type) { return listeners.get(type)?.size || 0; }
  });
}

function fixture({ dark = false, stored = null, readError = false, writeError = false, mediaUnavailable = false } = {}) {
  const values = new Map(stored === null ? [] : [[storageKey, stored]]);
  let mutations = 0;
  const dataset = new Proxy({}, { set(target, key, value) { mutations++; target[key] = value; return true; } });
  const document = events({ documentElement: { dataset }, visibilityState: 'visible' });
  const media = events({ matches: dark });
  const localStorage = {
    getItem(key) { if (readError) throw new Error('Storage blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (writeError) throw new Error('Storage full'); values.set(key, value); }
  };
  const environment = events({
    document,
    localStorage,
    matchMedia(query) {
      assert.equal(query, '(prefers-color-scheme: dark)');
      if (mediaUnavailable) throw new Error('Media queries unavailable');
      return media;
    }
  });
  const manager = create(environment);
  return { manager, environment, document, media, values, mutations: () => mutations };
}

for (const dark of [false, true]) {
  test(`theme: first visit defaults to light on a ${dark ? 'dark' : 'light'} system without persisting account data`, () => {
    const state = fixture({ dark });
    state.manager.initialize();
    assert.equal(state.manager.getPreference(), 'light');
    assert.equal(state.manager.getEffectiveTheme(), 'light');
    assert.equal(state.document.documentElement.dataset.theme, 'light');
    assert.equal(state.values.size, 0);
  });
}

for (const preference of ['light', 'dark', 'auto']) {
  test(`theme: restores stored ${preference} before an application view is needed`, () => {
    const state = fixture({ dark: true, stored: preference });
    state.manager.initialize();
    assert.equal(state.manager.getPreference(), preference);
    assert.equal(state.manager.getEffectiveTheme(), preference === 'auto' ? 'dark' : preference);
  });
}

test('theme: invalid stored data safely defaults to light even on a dark system', () => {
  const state = fixture({ dark: true, stored: '<img onerror=alert(1)>' });
  state.manager.initialize();
  assert.equal(state.manager.getPreference(), 'light');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
});

test('theme: manual selection persists only the namespaced visual preference', () => {
  const state = fixture();
  state.values.set('up_reports', 'unchanged');
  state.manager.setPreference('dark');
  assert.equal(state.values.get(storageKey), 'dark');
  assert.equal(state.values.get('up_reports'), 'unchanged');
  assert.deepEqual([...state.values.keys()].sort(), [storageKey, 'up_reports'].sort());
});

test('theme: automatic updates follow live system appearance changes', () => {
  const state = fixture();
  state.manager.setPreference('auto');
  state.media.matches = true;
  state.media.dispatch('change');
  assert.equal(state.manager.getEffectiveTheme(), 'dark');
  assert.equal(state.manager.getPreference(), 'auto');
});

test('theme: the default stays light when the system changes to dark', () => {
  const state = fixture();
  state.manager.initialize();
  state.media.matches = true;
  state.media.dispatch('change');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
  assert.equal(state.values.size, 0);
});

test('theme: blocked storage starts in light mode even on a dark system', () => {
  const state = fixture({ dark: true, readError: true });
  state.manager.initialize();
  assert.equal(state.manager.getPreference(), 'light');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
});

test('theme: system changes never override a manual preference', () => {
  const state = fixture();
  state.manager.setPreference('light');
  state.media.matches = true;
  state.media.dispatch('change');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
  state.manager.setPreference('auto');
  assert.equal(state.manager.getEffectiveTheme(), 'dark');
});

test('theme: blocked storage does not prevent selection or lose the in-memory override on resume', () => {
  const state = fixture({ readError: true, writeError: true });
  state.manager.setPreference('dark');
  state.environment.dispatch('pageshow');
  assert.equal(state.manager.getPreference(), 'dark');
  assert.equal(state.manager.getEffectiveTheme(), 'dark');
});

test('theme: readable but unwritable storage cannot silently reset a manual override', () => {
  const state = fixture({ writeError: true });
  state.manager.setPreference('dark');
  state.environment.dispatch('pageshow');
  state.document.dispatch('visibilitychange');
  assert.equal(state.manager.getPreference(), 'dark');
  assert.equal(state.values.has(storageKey), false);
});

test('theme: preference changes from another tab update effective appearance', () => {
  const state = fixture({ dark: true });
  state.manager.initialize();
  state.environment.dispatch('storage', { key: storageKey, newValue: 'light', storageArea: state.environment.localStorage });
  assert.equal(state.manager.getPreference(), 'light');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
});

test('theme: unrelated caches and session storage changes do not change appearance', () => {
  const state = fixture();
  state.manager.initialize();
  state.environment.dispatch('storage', { key: 'up_reports', newValue: 'dark' });
  state.environment.dispatch('storage', { key: storageKey, newValue: 'dark', storageArea: {} });
  assert.equal(state.manager.getPreference(), 'light');
});

test('theme: cleared or invalid cross-tab preferences restore the light default', () => {
  const state = fixture({ dark: true });
  state.manager.setPreference('light');
  state.environment.dispatch('storage', { key: storageKey, newValue: 'unknown' });
  assert.equal(state.manager.getEffectiveTheme(), 'light');
  state.manager.setPreference('light');
  state.environment.dispatch('storage', { key: null, newValue: null });
  assert.equal(state.manager.getPreference(), 'light');
});

test('theme: repeated initialization and unchanged media events do not add listeners or mutate the root', () => {
  const state = fixture();
  state.manager.initialize();
  state.manager.initialize();
  state.media.dispatch('change');
  assert.equal(state.media.count('change'), 1);
  assert.equal(state.environment.count('storage'), 1);
  assert.equal(state.environment.count('pageshow'), 1);
  assert.equal(state.document.count('visibilitychange'), 1);
  assert.equal(state.mutations(), 1);
});

test('theme: destroying and remounting removes every subscription', () => {
  const state = fixture();
  state.manager.initialize();
  state.manager.destroy();
  assert.equal(state.media.count('change'), 0);
  assert.equal(state.environment.count('storage'), 0);
  assert.equal(state.environment.count('pageshow'), 0);
  assert.equal(state.document.count('visibilitychange'), 0);
  assert.equal(state.manager.getEffectiveTheme(), null);
  state.manager.initialize();
  assert.equal(state.media.count('change'), 1);
});

test('theme: subscribers see preference changes even when the effective appearance stays the same', () => {
  const state = fixture({ dark: true, stored: 'auto' });
  state.manager.initialize();
  const changes = [];
  const unsubscribe = state.manager.subscribe(value => changes.push(value));
  state.manager.setPreference('dark');
  state.manager.setPreference('dark');
  assert.deepEqual(changes, [{ preference: 'dark', effective: 'dark' }]);
  unsubscribe();
  state.manager.setPreference('light');
  assert.equal(changes.length, 1);
});

test('theme: resume rereads preferences and the current system setting', () => {
  const state = fixture();
  state.manager.initialize();
  state.values.set(storageKey, 'auto');
  state.media.matches = true;
  state.environment.dispatch('pageshow');
  assert.equal(state.manager.getEffectiveTheme(), 'dark');
  state.values.set(storageKey, 'light');
  state.document.dispatch('visibilitychange');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
});

test('theme: a hidden document defers resume synchronization until it becomes visible', () => {
  const state = fixture();
  state.manager.initialize();
  state.values.set(storageKey, 'dark');
  state.document.visibilityState = 'hidden';
  state.document.dispatch('visibilitychange');
  assert.equal(state.manager.getEffectiveTheme(), 'light');
  state.document.visibilityState = 'visible';
  state.document.dispatch('visibilitychange');
  assert.equal(state.manager.getEffectiveTheme(), 'dark');
});

test('theme: unavailable system queries retain the light fallback for automatic preferences', () => {
  const state = fixture({ mediaUnavailable: true, stored: 'auto' });
  state.manager.initialize();
  assert.equal(state.manager.getEffectiveTheme(), 'light');
  state.manager.setPreference('dark');
  assert.equal(state.manager.getEffectiveTheme(), 'dark');
});

test('theme: invalid preferences are rejected without initialization or persistence', () => {
  const state = fixture();
  assert.equal(state.manager.setPreference('system'), false);
  assert.equal(state.manager.setPreference('__proto__'), false);
  assert.equal(state.manager.getEffectiveTheme(), null);
  assert.equal(state.values.size, 0);
});

for (const entry of ['citizen.html', 'admin.html', 'barangay.html', 'report-details.html', 'login.html', 'admin-login.html', 'barangay-login.html', 'admin-signup.html']) {
  test(`theme: ${entry} bootstraps synchronously before styles and body`, () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../frontend', entry), 'utf8');
    const script = source.indexOf('<script src="js/shared/themeManager.js"></script>');
    assert.ok(script > 0);
    assert.ok(script < source.indexOf('<link rel="stylesheet"'));
    assert.ok(script < source.indexOf('<body'));
  });
}
