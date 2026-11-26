const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const mysql = require('mysql2/promise');
const config = require('../../config/env');
const runner = require('./migrationRunner');

function assertLocalSettings(settings) {
  if (settings.DB_DRIVER !== 'mysql' || settings.DB_TARGET !== 'local' || settings.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(settings.DB_HOST) || !Number.isInteger(settings.DB_PORT) || settings.DB_PORT < 1 || settings.DB_PORT > 65535) throw new Error('Only a verified local development MySQL configuration is allowed.');
}

async function inspectLocalMigration017(connection, settings, { expectedDataDirectory } = {}) {
  assertLocalSettings(settings);
  const [[identity]] = await connection.query('SELECT @@hostname AS hostname, @@datadir AS directory, @@port AS port, @@server_uuid AS serverUuid, DATABASE() AS databaseName, VERSION() AS version');
  const directoryMatches = expectedDataDirectory === undefined
    ? /^[A-Za-z]:[\\/]/.test(identity.directory)
    : path.isAbsolute(expectedDataDirectory) && path.isAbsolute(identity.directory) && path.relative(expectedDataDirectory, identity.directory) === '';
  if (identity.hostname.toLowerCase() !== os.hostname().toLowerCase() || !directoryMatches || Number(identity.port) !== settings.DB_PORT || identity.databaseName !== settings.DB_NAME) {
    throw new Error(expectedDataDirectory === undefined
      ? 'Configured database is not the verified local Windows instance.'
      : 'Configured database does not match the verified private MySQL instance.');
  }
  const failures = [], files = await runner.listMigrationFiles();
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(identity.version);
  if (identity.version.includes('MariaDB') || !version || Number(version[1]) < 8 || Number(version[1]) === 8 && Number(version[2]) === 0 && Number(version[3]) < 16) failures.push('MySQL 8.0.16 or later is required for enforced CHECK constraints.');
  const [ledger] = await connection.query('SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename');
  const checksums = [];
  for (const row of ledger) {
    const current = files.includes(row.filename) ? await runner.readMigration(row.filename) : null;
    let migration = null;
    try { migration = await runner.readAppliedMigration(row.filename, row.checksum); } catch (error) { failures.push(error.message); }
    const matched = Boolean(migration);
    checksums.push({ filename: row.filename, recorded: row.checksum, current: current?.checksum || null, validatedSource: migration?.source || null, matched });
    if (!matched) failures.push(`Historical migration checksum or source mismatch: ${row.filename}`);
  }
  const pending = files.filter(filename => !ledger.some(row => row.filename === filename));
  if (JSON.stringify(pending) !== JSON.stringify(['017_incidents_and_routing.sql', '018_community_report_uniqueness.sql'])) failures.push('Exactly migrations 017 and 018 must be pending in that order for this procedure.');
  if (files.filter(filename => filename < '017_').some(filename => !ledger.some(row => row.filename === filename))) failures.push('An earlier migration dependency is missing from the ledger.');
  const [tables] = await connection.query("SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
  const featureTables = ['report_incidents', 'report_incident_members', 'report_routing_versions', 'report_coordination_events', 'community_post_aliases', 'report_incident_lock'];
  if (featureTables.some(name => tables.some(table => table.name === name))) failures.push('Migration 017 tables already exist; investigate partial application instead of retrying.');
  if (tables.some(table => table.engine !== 'InnoDB')) failures.push('A non-InnoDB table requires a separately reviewed backup/locking strategy.');
  const dependencies = [];
  for (const table of ['users', 'reports', 'barangays', 'community_posts', 'community_publication_requests']) {
    const [columns] = await connection.query('SELECT COLUMN_TYPE AS type, COLUMN_KEY AS keyType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, 'id']);
    const valid = columns.length === 1 && columns[0].type === 'int unsigned' && columns[0].keyType === 'PRI';
    dependencies.push({ table, referenceKeyValid: valid });
    if (!valid) failures.push(`Unexpected migration 017 reference key: ${table}.id`);
  }
  const [discussion] = await connection.query("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'community_publication_requests' AND column_name = 'discussion_post_id'");
  if (discussion.length) failures.push('The discussion column already exists; investigate partial application.');
  const [constraints] = await connection.query("SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expression FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'user_permissions'");
  if (!constraints.some(row => row.name === 'chk_user_permissions_name' && row.expression.includes('admin:create') && !row.expression.includes('report:assign-jurisdiction'))) failures.push('Unexpected user_permissions check constraint.');
  const [reportColumn] = await connection.query("SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'community_posts' AND column_name = 'report_id'");
  const [index] = await connection.query("SELECT NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, SUB_PART, EXPRESSION, INDEX_TYPE, IS_VISIBLE, COLLATION FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'community_posts' AND index_name = 'community_post_report' ORDER BY SEQ_IN_INDEX");
  const [[duplicates]] = await connection.query('SELECT COUNT(*) AS total FROM (SELECT report_id FROM community_posts WHERE report_id IS NOT NULL GROUP BY report_id HAVING COUNT(*) > 1) duplicate_reports');
  const columnReady = reportColumn.length === 1 && reportColumn[0].type === 'int unsigned' && reportColumn[0].nullable === 'YES';
  const indexReady = index.length === 0 || index.length === 1 && index[0].NON_UNIQUE === 0 && index[0].COLUMN_NAME === 'report_id' && index[0].SEQ_IN_INDEX === 1 && index[0].SUB_PART === null && index[0].EXPRESSION === null && index[0].INDEX_TYPE === 'BTREE' && index[0].IS_VISIBLE === 'YES' && index[0].COLLATION === 'A';
  const uniqueness = { columnReady, namedIndexPresent: index.length > 0, namedIndexValid: indexReady, duplicateGroups: Number(duplicates.total) };
  if (!columnReady || !indexReady || uniqueness.duplicateGroups !== 0) failures.push('Migration 018 requires the expected report reference, no conflicting named index, and no duplicate non-null report references.');
  const counts = {};
  for (const table of tables) counts[table.name] = Number((await connection.query(`SELECT COUNT(*) AS total FROM ${mysql.escapeId(table.name)}`))[0][0].total);
  const migration = await runner.readMigration('017_incidents_and_routing.sql');
  const reconciliation = await runner.readMigration('018_community_report_uniqueness.sql');
  return { capturedAt: new Date().toISOString(), identity, ready: failures.length === 0, failures, checksums, pending, dependencies, uniqueness, tableCount: tables.length, counts, migration017: { sha256: migration.checksum, statements: migration.statements.length }, migration018: { sha256: reconciliation.checksum, statements: reconciliation.statements.length }, databaseWritesPerformed: false };
}

async function main() {
  assertLocalSettings(config);
  const connection = await mysql.createConnection({ host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER, password: config.DB_PASSWORD, database: config.DB_NAME, dateStrings: true });
  try {
    const result = await inspectLocalMigration017(connection, config);
    const directory = path.resolve('.data/migration-recovery-2026-10-27');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'strict-preflight.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ready: result.ready, failures: result.failures, pending: result.pending, dependencies: result.dependencies, uniqueness: result.uniqueness, migration017: result.migration017, migration018: result.migration018, databaseWritesPerformed: false }, null, 2));
    if (!result.ready) process.exitCode = 2;
  } finally { await connection.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { inspectLocalMigration017 };
