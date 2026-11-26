const base = require("./playwright.phase1b.config");
module.exports = {
  ...base,
  testMatch: "registration.spec.js",
  outputDir: process.env.REGISTRATION_TEST_URL
    ? ".data/registration-mysql-browser-results"
    : ".data/registration-functional-results",
  timeout: 120000,
  globalTeardown: process.env.REGISTRATION_TEST_URL
    ? undefined
    : base.globalTeardown,
  use: {
    ...base.use,
    baseURL: process.env.REGISTRATION_TEST_URL || base.use.baseURL,
    actionTimeout: 10000,
  },
  webServer: process.env.REGISTRATION_TEST_URL
    ? undefined
    : { ...base.webServer, command: "node --env-file=.env tests/support/phase-1b-browser-server.js", env: { ...process.env, PHASE2_PREVIEW_PORT: "4318" } },
};
