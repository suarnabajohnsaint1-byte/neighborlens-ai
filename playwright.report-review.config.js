const base = require('./playwright.publication.config');
module.exports = { ...base, testMatch: 'report-review.spec.js', outputDir: '.data/report-review-browser-results', timeout: 60000 };
