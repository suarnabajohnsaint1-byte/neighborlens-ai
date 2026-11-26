const os = require('node:os');
const path = require('node:path');
const base = require('./playwright.phase2.config');

module.exports = {
  ...base,
  testMatch: 'barangay.spec.js',
  outputDir: path.join(os.tmpdir(), 'neighborlens-barangay-browser-results'),
  use: { ...base.use, timezoneId: 'Asia/Manila', reducedMotion: 'reduce' }
};
