const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const createSqliteAdapter = require('../../server/infrastructure/database/sqlite/sqliteAdapter');

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function clearDbModuleCache() {
  [
    '../../server/infrastructure/config/env',
    '../../server/infrastructure/database',
    '../../server/infrastructure/database/mysql/pool',
    '../../server/infrastructure/database/mysql/mysqlAdapter'
  ].forEach(modulePath => {
    delete require.cache[require.resolve(modulePath)];
  });
}

test('DB_DRIVER defaults to mysql, never to a test database', () => {
  delete process.env.DB_DRIVER;
  clearDbModuleCache();
  const env = freshRequire('../../server/infrastructure/config/env');
  assert.equal(env.DB_DRIVER, 'mysql');
});

test('the runtime never exposes a sqlite driver option', () => {
  clearDbModuleCache();
  const { RUNTIME_DRIVER } = freshRequire('../../server/infrastructure/database');
  assert.equal(RUNTIME_DRIVER, 'mysql');
});

test('an unknown DB_DRIVER fails loudly instead of silently choosing another database', () => {
  clearDbModuleCache();
  const { createDatabase } = freshRequire('../../server/infrastructure/database');

  for (const driver of ['sqlite', 'postgres', 'mysqlx', '']) {
    assert.throws(
      () => createDatabase(driver),
      /Unsupported DB_DRIVER/,
      `driver "${driver}" must be rejected rather than substituted`
    );
  }
});

test('database selection cannot reach the sqlite adapter at all', () => {
  const selector = path.join(__dirname, '..', '..', 'server', 'infrastructure', 'database', 'index.js');
  const source = require('node:fs').readFileSync(selector, 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal(/sqlite/i.test(source), false,
    'runtime database selection must not mention sqlite outside a comment');
});

test('DB_DRIVER=mysql builds the pool without connecting eagerly', () => {
  process.env.DB_DRIVER = 'mysql';
  clearDbModuleCache();
  try {
    const { createDatabase } = freshRequire('../../server/infrastructure/database');
    const db = createDatabase();
    assert.equal(db.driver, 'mysql');
    assert.ok(db.pool);
  } finally {
    delete process.env.DB_DRIVER;
    clearDbModuleCache();
  }
});

test('the mysql adapter honestly reports connection failure when no server is reachable', async () => {
  process.env.DB_DRIVER = 'mysql';
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = '19999';
  process.env.DB_CONNECT_TIMEOUT_MS = '2000';
  clearDbModuleCache();
  try {
    const { createDatabase } = freshRequire('../../server/infrastructure/database');
    const db = createDatabase();
    await assert.rejects(db.ping());
    await db.close().catch(() => {});
  } finally {
    delete process.env.DB_DRIVER;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_CONNECT_TIMEOUT_MS;
    clearDbModuleCache();
  }
});

test('server startup refuses to run when the database is unreachable', async () => {
  process.env.DB_DRIVER = 'mysql';
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = '19999';
  process.env.DB_CONNECT_TIMEOUT_MS = '2000';
  clearDbModuleCache();
  delete require.cache[require.resolve('../../server/app')];
  try {
    const { assertDatabaseReachable } = require('../../server/app');
    await assert.rejects(assertDatabaseReachable(), /Cannot reach the mysql database/);
  } finally {
    const { resetDatabase } = require('../../server/infrastructure/database');
    resetDatabase();
    delete process.env.DB_DRIVER;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_CONNECT_TIMEOUT_MS;
    delete require.cache[require.resolve('../../server/app')];
    clearDbModuleCache();
  }
});

test('the sqlite test adapter satisfies the query/execute contract', async () => {
  const db = createSqliteAdapter();
  assert.equal(db.driver, 'sqlite-test');
  const rows = await db.query('SELECT 1 AS value');
  assert.equal(rows[0].value, 1);
});

test('the sqlite test adapter commits all writes on success', async () => {
  const db = createSqliteAdapter();
  const marker = `tx_commit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await db.withTransaction(async (tx) => {
    await tx.execute(
      'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?)',
      [null, marker, 'test_transaction', null]
    );
  });

  const rows = await db.query('SELECT * FROM audit_logs WHERE action = ?', [marker]);
  assert.equal(rows.length, 1);
});

test('the sqlite test adapter rolls back all writes when the callback throws', async () => {
  const db = createSqliteAdapter();
  const marker = `tx_rollback_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await assert.rejects(db.withTransaction(async (tx) => {
    await tx.execute(
      'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?)',
      [null, marker, 'test_transaction', null]
    );
    throw new Error('deliberate failure to exercise rollback');
  }));

  const rows = await db.query('SELECT * FROM audit_logs WHERE action = ?', [marker]);
  assert.equal(rows.length, 0);
});
