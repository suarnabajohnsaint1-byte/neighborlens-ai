const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { privateMysql } = require('../support/private-mysql');
const { sourceRunner, tableSnapshot, schemaSnapshot, seedMigrationRecovery } = require('../support/migration-recovery-fixtures');
const runner = require('../../server/infrastructure/database/mysql/migrationRunner');
const { inspectLocalMigration017 } = require('../../server/infrastructure/database/mysql/preflight017');

test('historical migration recovery and forward uniqueness on private MySQL', { timeout: 300000 }, async t => {
  const database = await privateMysql(t), pools = [];
  const migrations = await runner.listMigrationFiles();
  const options = database.pool.pool.config.connectionConfig;
  let number = 0, finalSchema;
  async function create(name, baseline) {
    const dbName = `recovery_${name}`;
    await database.pool.query(`CREATE DATABASE ${mysql.escapeId(dbName)}`);
    const pool = mysql.createPool({ host: '127.0.0.1', port: options.port, user: 'root', database: dbName, dateStrings: true }); pools.push(pool);
    if (baseline) await (await sourceRunner(path.join(database.directory, `source-${++number}`), baseline)).runMigrations(pool);
    return pool;
  }
  async function ledger(pool) { return (await pool.query('SELECT * FROM schema_migrations ORDER BY id'))[0]; }
  async function index(pool) { return (await pool.query("SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'community_posts' AND index_name = 'community_post_report'"))[0]; }
  async function minimal(pool, duplicate = false) {
    await pool.query("INSERT INTO users (id, username, password_hash, role, barangay, barangay_id, status) VALUES (1, 'synthetic_migration_owner', 'not-a-login-credential', 'citizen', 'Barangay 1', 1, 'active')");
    await pool.query("INSERT INTO reports (id, description, barangay, barangay_id, submitted_by) VALUES (1, 'Synthetic migration evidence', 'Barangay 1', 1, 1)");
    for (let i = 0; i < (duplicate ? 2 : 1); i++) await pool.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) VALUES (1, 1, ?, 1, ?, ?)', ['Synthetic public content', `fixture-${i}`, 'a'.repeat(64)]);
  }
  try {
    await t.test('fresh installation executes the complete migration sequence and is idempotent', async () => {
      const pool = await create('fresh');
      const result = await runner.runMigrations(pool);
      assert.deepEqual(result.applied, migrations);
      assert.deepEqual(result.applied.filter(name => /^02[2-4]_/.test(name)), [
        '022_citizen_enrollment_tier.sql',
        '023_citizen_residency_confirmation.sql',
        '024_report_gps_fix.sql'
      ]);
      assert.deepEqual(await index(pool), [{ INDEX_NAME: 'community_post_report', NON_UNIQUE: 0, COLUMN_NAME: 'report_id', SEQ_IN_INDEX: 1 }]);
      assert.deepEqual((await runner.runMigrations(pool)).applied, []);
      finalSchema = await schemaSnapshot(pool);
    });
    for (const variant of [
      { name: 'historical', seed: true },
      { name: 'existing_index', seed: true, indexed: true },
      { name: 'newer_lf', newer001: true, newer009: true, ending: '\n', seed: true },
      { name: 'newer_crlf', newer001: true, newer009: true, ending: '\r\n' },
      { name: 'mixed_one', newer001: true },
      { name: 'mixed_nine', newer009: true }
    ]) await t.test(`${variant.name} history preserves data and ledger while reaching the fresh schema`, async () => {
      const pool = await create(variant.name, { through: '016', ...variant });
      if (variant.indexed) await pool.query('ALTER TABLE community_posts ADD UNIQUE KEY community_post_report (report_id)');
      if (variant.seed) {
        assert.equal((await seedMigrationRecovery(pool, database.directory)).reports, 120);
        assert.equal((await seedMigrationRecovery(pool, database.directory)).replayed, true);
        const { candidate } = require('../../server/domain/reports/incident.rules');
        const [reports] = await pool.query('SELECT * FROM reports WHERE id <= 50 ORDER BY id');
        let pairs = 0;
        for (let i = 0; i < reports.length; i++) for (let j = i + 1; j < reports.length; j++) if (candidate(reports[i], reports[j])?.kind === 'possible_duplicate') pairs++;
        assert.equal(pairs, 25);
      }
      const before = await tableSnapshot(pool), beforeLedger = await ledger(pool);
      const beforePostSchema = (await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'];
      const readiness = await inspectLocalMigration017(pool, { DB_DRIVER: 'mysql', DB_TARGET: 'local', NODE_ENV: 'development', DB_HOST: '127.0.0.1', DB_PORT: options.port, DB_NAME: pool.pool.config.connectionConfig.database }, { expectedDataDirectory: database.directory });
      assert.equal(readiness.ready, false);
      assert.deepEqual(readiness.failures, ['Exactly migrations 017 and 018 must be pending in that order for this procedure.']);
      assert.deepEqual((await runner.runMigrations(pool)).applied, migrations.slice(16));
      assert.deepEqual(await tableSnapshot(pool, before), before);
      assert.deepEqual((await ledger(pool)).slice(0, 16), beforeLedger);
      assert.deepEqual(await schemaSnapshot(pool), finalSchema);
      if (variant.indexed || variant.newer009) assert.equal((await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'], beforePostSchema);
      assert.deepEqual((await runner.runMigrations(pool)).applied, []);
      if (variant.seed) {
        for (const [state, expected] of [['approved', 40], ['pending_approval', 40], ['rejected', 40]]) assert.equal(Number((await pool.execute('SELECT COUNT(*) AS n FROM community_publication_requests WHERE state = ?', [state]))[0][0].n), expected);
        assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM community_publication_reviews'))[0][0].n), 80);
        assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM community_comments WHERE parent_id IS NOT NULL'))[0][0].n), 30);
        t.diagnostic('Preserved 44 synthetic accounts, 120 reports, 240 images, 120 publication decisions, 80 reviews, 60 comments/replies and 20 messages; all original table row fingerprints matched.');
      }
    });
    await t.test('a valid existing differently named unique index is retained without adding a redundant index', async () => {
      const pool = await create('alternate_index', { through: '017' }); await minimal(pool);
      await pool.query('ALTER TABLE community_posts ADD UNIQUE KEY deployment_report_unique (report_id)');
      const before = await tableSnapshot(pool), ddl = (await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'];
      await runner.runMigrations(pool);
      assert.deepEqual(await index(pool), []);
      assert.equal((await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'], ddl);
      assert.deepEqual(await tableSnapshot(pool, before), before);
    });
    await t.test('duplicate report references stop 018 without deleting posts or recording success', async () => {
      const pool = await create('duplicate_posts', { through: '017' }); await minimal(pool, true);
      const before = await tableSnapshot(pool), history = await ledger(pool);
      await assert.rejects(runner.runMigrations(pool), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.deepEqual(await tableSnapshot(pool, before), before); assert.deepEqual(await ledger(pool), history); assert.deepEqual(await index(pool), []);
    });
    for (const [name, definition] of [
      ['nonunique', 'KEY community_post_report (report_id)'],
      ['composite', 'UNIQUE KEY community_post_report (report_id, author_id)'],
      ['wrong_column', 'UNIQUE KEY community_post_report (request_key)'],
      ['prefix', 'UNIQUE KEY community_post_report (request_key(10))'],
      ['invisible', 'UNIQUE KEY community_post_report (report_id) INVISIBLE']
    ]) await t.test(`conflicting ${name} named index fails closed with the original index and records intact`, async () => {
      const pool = await create(name, { through: '017' }); await minimal(pool);
      await pool.query(`ALTER TABLE community_posts ADD ${definition}`);
      const before = await tableSnapshot(pool), ddl = (await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'], history = await ledger(pool);
      await assert.rejects(runner.runMigrations(pool), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
      assert.deepEqual(await tableSnapshot(pool, before), before); assert.deepEqual(await ledger(pool), history);
      assert.equal((await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'], ddl);
    });
    await t.test('multiple null report references remain valid while repeated non-null references are rejected', async () => {
      const pool = await create('nullable_reports', { through: '017' }); await minimal(pool);
      for (const key of ['null-one', 'null-two']) await pool.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) VALUES (1, 1, ?, NULL, ?, ?)', ['Synthetic independent post', key, 'b'.repeat(64)]);
      const before = await tableSnapshot(pool); await runner.runMigrations(pool); assert.deepEqual(await tableSnapshot(pool, before), before);
      await assert.rejects(pool.execute('INSERT INTO community_posts (barangay_id, author_id, body, report_id, request_key, request_hash) VALUES (1, 1, ?, 1, ?, ?)', ['Synthetic duplicate', 'blocked', 'c'.repeat(64)]), error => error.code === 'ER_DUP_ENTRY');
    });
    await t.test('an index committed before a failed ledger insert is safely verified on retry', async () => {
      const pool = await create('interrupted', { through: '017' }); await minimal(pool);
      const before = await tableSnapshot(pool), history = await ledger(pool);
      const interrupted = { query: (...args) => pool.query(...args), async getConnection() {
        const connection = await pool.getConnection();
        return { query(sql, params) { if (sql.startsWith('INSERT INTO schema_migrations')) throw new Error('Simulated interruption before ledger insert.'); return connection.query(sql, params); }, release: () => connection.release() };
      } };
      await assert.rejects(runner.runMigrations(interrupted), /Simulated interruption/);
      assert.equal((await index(pool)).length, 1); assert.deepEqual(await ledger(pool), history);
      const ddl = (await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'];
      assert.deepEqual((await runner.runMigrations(pool)).applied, migrations.slice(17));
      assert.equal((await pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'], ddl);
      assert.deepEqual(await tableSnapshot(pool, before), before);
    });
    await t.test('modified versioned SQL cannot validate a deployed checksum or advance its ledger', async () => {
      const pool = await create('tampered_history', { through: '016', newer009: true });
      const source = path.join(database.directory, `source-${++number}`), copied = await sourceRunner(source);
      const history = require('../../server/infrastructure/database/mysql/migrationHistory.json');
      await fs.appendFile(path.join(source, 'migration-history/009_community_feed', `${history['009_community_feed.sql'][0]}.sql`), '\nSELECT 123;\n');
      const before = await ledger(pool);
      await assert.rejects(copied.runMigrations(pool), /Historical migration source integrity mismatch/);
      assert.deepEqual(await ledger(pool), before);
    });
    await t.test('the synthetic data factory refuses an unverified target before inserting records', async () => {
      let queried = 0;
      const fake = { query: async () => { queried++; return [[{ directory: 'C:/ProgramData/MySQL/production/', name: 'production' }]]; } };
      await assert.rejects(seedMigrationRecovery(fake, database.directory)); assert.equal(queried, 1);
    });
  } finally { for (const pool of pools) await pool.end(); await database.close(); }
});
