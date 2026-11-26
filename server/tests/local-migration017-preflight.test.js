const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const runner = require('../infrastructure/database/mysql/migrationRunner');
const { inspectLocalMigration017 } = require('../infrastructure/database/mysql/preflight017');

const settings = { DB_DRIVER: 'mysql', DB_TARGET: 'local', NODE_ENV: 'development', DB_HOST: '127.0.0.1', DB_PORT: 3306, DB_NAME: 'readiness_fixture' };
async function useHistoricalCatalog(t, last = '018_community_report_uniqueness.sql') {
  const files = (await runner.listMigrationFiles()).filter(file => file <= last);
  t.mock.method(runner, 'listMigrationFiles', async () => files);
}
async function fixture(options = {}) {
  const files = (await runner.listMigrationFiles()).filter(file => file < '017_');
  if (!options.pending019) files.push('019_community_comment_reaction_types.sql');
  const ledger = await Promise.all(files.map(async filename => ({ filename, checksum: (await runner.readMigration(filename)).checksum })));
  if (options.drift) ledger.find(row => row.filename === options.drift).checksum = '0'.repeat(64);
  const tables = ['users', 'reports', 'barangays', 'community_posts', 'community_publication_requests', 'user_permissions', 'schema_migrations'].map(name => ({ name, engine: 'InnoDB' }));
  if (options.partial) tables.push({ name: 'report_incidents', engine: 'InnoDB' });
  let reads = 0;
  const connection = { async query(sql) {
    reads++; assert.match(sql, /^SELECT /);
    if (sql.startsWith('SELECT @@hostname')) return [[{ hostname: options.hostname || os.hostname(), directory: options.directory || 'C:/private-readiness-fixture/', port: 3306, databaseName: settings.DB_NAME, serverUuid: 'fixture-uuid', version: options.version || '8.0.46' }]];
    if (sql.startsWith('SELECT filename')) return [ledger];
    if (sql.startsWith('SELECT TABLE_NAME')) return [tables];
    if (sql.startsWith('SELECT COLUMN_TYPE') && sql.includes("column_name = 'report_id'")) return [[{ type: 'int unsigned', nullable: 'YES' }]];
    if (sql.startsWith('SELECT COLUMN_TYPE')) return [[{ type: 'int unsigned', keyType: 'PRI' }]];
    if (sql.startsWith('SELECT COLUMN_NAME')) return [options.partial ? [{ COLUMN_NAME: 'discussion_post_id' }] : []];
    if (sql.startsWith('SELECT cc.')) return [[{ name: 'chk_user_permissions_name', expression: "(`permission` = 'admin:create')" }]];
    if (sql.startsWith('SELECT NON_UNIQUE')) return [options.conflictingIndex ? [{ NON_UNIQUE: 1 }] : []];
    if (sql.includes('duplicate_reports')) return [[{ total: options.duplicates ? 2 : 0 }]];
    if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 3 }]];
    throw new Error('Unexpected readiness query.');
  } };
  return { connection, reads: () => reads };
}
test('local preflight is read-only and permits only a complete checksum-matched pre-017 state', async t => {
  await useHistoricalCatalog(t);
  const db = await fixture(); const result = await inspectLocalMigration017(db.connection, settings);
  assert.equal(result.ready, true); assert.deepEqual(result.failures, []); assert.deepEqual(result.pending, ['017_incidents_and_routing.sql', '018_community_report_uniqueness.sql']); assert.equal(result.databaseWritesPerformed, false);
});
test('local preflight does not authorize migration 019 under the 017–018 procedure', async () => {
  const db = await fixture({ pending019: true });
  const result = await inspectLocalMigration017(db.connection, settings);
  assert.equal(result.ready, false);
  assert.deepEqual(result.failures, ['Exactly migrations 017 and 018 must be pending in that order for this procedure.']);
});
test('local preflight allows a private instance only when its data directory matches exactly', async t => {
  await useHistoricalCatalog(t);
  const expectedDataDirectory = path.join(os.tmpdir(), 'mysql-preflight-fixture');
  const matching = await fixture({ directory: expectedDataDirectory + path.sep });
  assert.equal((await inspectLocalMigration017(matching.connection, settings, { expectedDataDirectory })).ready, true);

  const mismatch = await fixture({ directory: path.join(expectedDataDirectory, 'other') });
  await assert.rejects(inspectLocalMigration017(mismatch.connection, settings, { expectedDataDirectory }), /verified private MySQL instance/);
  assert.equal(mismatch.reads(), 1);

  const linuxPath = await fixture({ directory: '/tmp/mysql-preflight-fixture/' });
  await assert.rejects(inspectLocalMigration017(linuxPath.connection, settings), /verified local Windows instance/);
  assert.equal(linuxPath.reads(), 1);
});
for (const name of ['001_init_schema.sql', '009_community_feed.sql']) test(`local preflight refuses historical checksum drift in ${name}`, async () => {
  const db = await fixture({ drift: name }); const result = await inspectLocalMigration017(db.connection, settings);
  assert.equal(result.ready, false); assert.ok(result.failures.some(message => message.includes(name)));
});
test('remote, hosted, production and invalid port settings are rejected before database access', async () => {
  for (const change of [{ DB_HOST: 'aiven.example' }, { DB_TARGET: 'aiven' }, { NODE_ENV: 'production' }, { DB_PORT: NaN }, { DB_PORT: 0 }, { DB_PORT: 65536 }]) {
    const db = await fixture(); await assert.rejects(inspectLocalMigration017(db.connection, { ...settings, ...change })); assert.equal(db.reads(), 0);
  }
});
test('local preflight refuses an unexpected server identity and incomplete migration 017', async () => {
  const foreign = await fixture({ hostname: 'unrelated-server' }); await assert.rejects(inspectLocalMigration017(foreign.connection, settings), /identity|verified local/i);
  const partial = await fixture({ partial: true }); const result = await inspectLocalMigration017(partial.connection, settings);
  assert.equal(result.ready, false); assert.ok(result.failures.some(message => message.includes('partial application')));
});
test('local preflight requires a MySQL version that enforces CHECK constraints', async t => {
  await useHistoricalCatalog(t);
  for (const version of ['8.0.15', '8.0.15-commercial', 'unknown', '10.11.0-MariaDB']) {
    const db = await fixture({ version }); const result = await inspectLocalMigration017(db.connection, settings);
    assert.equal(result.ready, false); assert.ok(result.failures.some(message => message.includes('CHECK')));
  }
  const db = await fixture({ version: '8.0.46-commercial' });
  assert.equal((await inspectLocalMigration017(db.connection, settings)).ready, true);
});

test('local preflight rejects conflicting report indexes and duplicate report references before migration', async () => {
  for (const options of [{ conflictingIndex: true }, { duplicates: true }]) {
    const db = await fixture(options); const result = await inspectLocalMigration017(db.connection, settings);
    assert.equal(result.ready, false); assert.ok(result.failures.some(message => message.includes('018')));
  }
});
