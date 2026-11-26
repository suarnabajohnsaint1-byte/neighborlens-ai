const base = require('./playwright.phase2.config');

module.exports = {
  ...base,
  testMatch: 'report-details.spec.js',
  outputDir: '.data/report-details-browser-results'
};
