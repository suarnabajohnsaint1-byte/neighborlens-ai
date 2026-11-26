const base = require('./playwright.phase1b.config');
const { devices } = require('@playwright/test');
const iphone = devices['iPhone 13'];
const confidenceCases = /high Road Crack|review preview boxes for matching|single-photo preview|@severity|@relevance|@location/;

module.exports = {
  ...base,
  projects: [
    ...base.projects,
    { name: 'iPhone WebKit', grep: confidenceCases, use: { ...iphone } },
    { name: 'Messenger UA WebKit', grep: confidenceCases, use: {
      ...iphone, userAgent: iphone.userAgent + ' [FBAN/MessengerForiOS;FBAV/500.0]'
    } }
  ],
  testMatch: 'phase-2.spec.js',
  outputDir: '.data/phase-2-browser-results',
  webServer: { ...base.webServer, env: { PHASE2_BROWSER: '1' } }
};
