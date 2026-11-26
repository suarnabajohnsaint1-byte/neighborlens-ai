const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  testMatch: 'phase-1b.spec.js',
  outputDir: '.data/phase-1b-browser-results',
  workers: 1,
  globalTeardown: './tests/support/phase-1b-browser-teardown.js',
  timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4318',
    permissions: ['geolocation'],
    geolocation: { latitude: 10.678, longitude: 122.946, accuracy: 15 },
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: 'node tests/support/phase-1b-browser-server.js',
    url: 'http://127.0.0.1:4318/api/health',
    reuseExistingServer: false
  }
});
