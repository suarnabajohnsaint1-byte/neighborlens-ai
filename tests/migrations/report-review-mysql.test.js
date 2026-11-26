const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { privateMysql } = require('../support/private-mysql');
const { reportReviewScenarios } = require('../support/report-review-scenarios');

test('report coordination, severity and rejection on verified private MySQL', { timeout: 180000 }, async t => {
  const database = await privateMysql(t); let server;
  try {
    process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.STORAGE_DRIVER = 'local'; process.env.UPLOAD_DIR = path.join(database.directory, 'uploads');
    const runner = require('../../server/infrastructure/database/mysql/migrationRunner');
    await runner.runMigrations(database.pool);
    assert.deepEqual((await runner.runMigrations(database.pool)).applied, []);
    require('../../server/infrastructure/database').useTestDatabase(database.adapter);
    const app = require('../../server/app'); server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    await reportReviewScenarios(t, { base: `http://127.0.0.1:${server.address().port}`, database: database.adapter });
    await assert.rejects(database.pool.execute("INSERT INTO report_coordination_messages (report_id, sender_role, body, request_key) VALUES (999999, 'admin', 'Invalid foreign key', 'invalid-foreign-key')"), /foreign key/i);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await database.close(); }
});
