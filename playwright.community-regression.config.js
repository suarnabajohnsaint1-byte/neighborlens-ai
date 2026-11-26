const base = require('./playwright.phase1b.config');
module.exports = {
  ...base,
  testMatch: ['phase-1b.spec.js', 'phase-2.spec.js', 'report-details.spec.js'],
  outputDir: '.data/community-regression-results',
  globalTeardown: './tests/support/community-browser-teardown.js',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4331' },
  webServer: { ...base.webServer, url: 'http://127.0.0.1:4331/api/health', env: { PHASE2_PREVIEW_PORT: '4331', PHASE2_BROWSER: '1' } }
};
