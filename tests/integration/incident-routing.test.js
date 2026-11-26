const test = require('node:test');
process.env.TEST_DB_FILE = require('node:path').join(require('node:os').tmpdir(), `neighborlens-incident-${require('node:crypto').randomUUID()}.sqlite`);
const { startTestServer, testDatabase } = require('../support/test-app');
const { incidentRoutingScenarios } = require('../support/incident-routing-scenarios');
test('incident linking and controlled routing on isolated SQLite', async t => {
  const { server, baseUrl } = await startTestServer();
  try { await incidentRoutingScenarios(t, { base: baseUrl, database: testDatabase() }); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
