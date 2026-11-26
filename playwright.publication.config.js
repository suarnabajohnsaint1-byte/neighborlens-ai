const base = require('./playwright.phase1b.config');
module.exports = {
  ...base,
  testMatch: 'community-publication.spec.js',
  outputDir: '.data/publication-browser-results',
  globalTeardown: './tests/support/community-browser-teardown.js',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4331' },
  webServer: { ...base.webServer, url: 'http://127.0.0.1:4331/api/health', env: { PHASE2_PREVIEW_PORT: '4331', PHASE2_BROWSER: '1' } }
};
