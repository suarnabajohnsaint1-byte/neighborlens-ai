const base = require('./playwright.community-regression.config');
module.exports = {
    ...base,
    testMatch: 'shared-reports.spec.js',
    outputDir: '.data/shared-reports/results',
    projects: [{ name: 'shared', use: { viewport: { width: 1440, height: 1000 } } }],
    timeout: 60000,
    use: { reducedMotion: 'reduce', actionTimeout: 10000, trace: 'retain-on-failure' },
    globalTeardown: undefined,
    webServer: undefined
};
