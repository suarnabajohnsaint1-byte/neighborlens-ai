const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/browser',
    testMatch: '**/citizen-landmark-field.spec.js',
    outputDir: '.data/landmark-browser-results',
    workers: 1,
    timeout: 30000,
    reporter: 'list',

    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },

    projects: [
        {
            name: 'desktop',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 1000 }
            }
        },
        {
            name: 'mobile',
            use: {
                ...devices['Pixel 7']
            }
        }
    ]
});