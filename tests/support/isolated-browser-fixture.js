const { fork } = require('node:child_process');
const { once } = require('node:events');
const { test, expect } = require('@playwright/test');

// A replacement Playwright worker must also receive a fresh fixture database.
const isolated = test.extend({
  fixtureOrigin: [async ({}, use) => {
    const child = fork(require.resolve('./phase-1b-browser-server'), [], {
      env: { ...process.env, PHASE2_BROWSER: '1', PHASE2_PREVIEW_PORT: '0' },
      windowsHide: true
    });
    const exited = once(child, 'exit');
    try {
      const [{ port }] = await Promise.race([
        once(child, 'message'), exited.then(() => { throw new Error('Fixture server exited before startup'); })
      ]);
      const origin = 'http://127.0.0.1:' + port;
      try { await use(origin); }
      finally { await fetch(origin + '/__phase1b_shutdown', { method: 'POST' }); }
    } finally {
      if (child.connected) child.disconnect();
      await exited;
    }
  }, { scope: 'worker' }],
  baseURL: async ({ fixtureOrigin }, use) => use(fixtureOrigin)
});

module.exports = { test: isolated, expect };
