const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLoopbackHost, assertTestDatabase } = require('../../tests/support/local-test-target');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('database test guards accept only loopback targets and explicit test database names', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.doesNotThrow(() => assertLoopbackHost(host));
  for (const host of ['database.example.com', 'mysql.example.aivencloud.com', '', '127.0.0.1.example.com']) assert.throws(() => assertLoopbackHost(host), /loopback/);
  assert.doesNotThrow(() => assertTestDatabase('neighborlens_qa_test'));
  for (const name of ['neighborlens_ai', 'defaultdb', 'invalid`_test', '']) assert.throws(() => assertTestDatabase(name), /dedicated database/);
});

test('the destructive MySQL test helper refuses a hosted target before connecting or issuing SQL', async () => {
  const file = path.resolve(__dirname, '../../tests/support/mysql-test-db.js');
  const source = fs.readFileSync(file, 'utf8');
  const load = createRequire(file);
  let connections = 0;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, __dirname: path.dirname(file), process: { env: { DB_HOST: 'mysql.example.aivencloud.com', DB_NAME: 'neighborlens_ai', MYSQL_TEST_DB_NAME: 'qa_guard_test' } },
    require: name => name === 'mysql2/promise' ? { createConnection: async () => { connections++; return { query: async () => {}, end: async () => {} }; } } : load(name) });
  await assert.rejects(module.exports.recreateTestDatabase(), /loopback/);
  assert.equal(connections, 0);
});
