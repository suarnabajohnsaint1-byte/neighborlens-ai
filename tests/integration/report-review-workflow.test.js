const test = require('node:test');
const { startTestServer, testDatabase } = require('../support/test-app');
const { reportReviewScenarios } = require('../support/report-review-scenarios');

test('report coordination, severity and rejection on isolated SQLite', async t => {
  const { server, baseUrl } = await startTestServer();
  try { await reportReviewScenarios(t, { base: baseUrl, database: testDatabase() }); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
