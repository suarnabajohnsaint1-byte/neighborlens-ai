const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const root = path.resolve(__dirname, '../..');
const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: node --env-file=.env tests/support/verify-migration-backup.js BACKUP_MANIFEST.json');
const output = path.join(root, '.data', `migration-backup-verification-${Date.now()}`);
const config = require(path.join(root, 'server/infrastructure/config/env'));
const runner = require(path.join(root, 'server/infrastructure/database/mysql/migrationRunner'));
const { privateMysql } = require(path.join(root, 'tests/support/private-mysql'));
const { tableSnapshot, schemaSnapshot } = require(path.join(root, 'tests/support/migration-recovery-fixtures'));
const { inspectLocalMigration017 } = require(path.join(root, 'server/infrastructure/database/mysql/preflight017'));
(async () => {
  assert.equal(config.DB_DRIVER, 'mysql'); assert.equal(config.DB_TARGET, 'local'); assert.notEqual(config.NODE_ENV, 'production'); assert.equal(config.DB_HOST, '127.0.0.1'); assert.equal(config.DB_PORT, 3306);
  const backup = JSON.parse(await fsp.readFile(path.resolve(manifestPath), 'utf8'));
  assert.equal(backup.target.host, config.DB_HOST); assert.equal(backup.target.port, config.DB_PORT); assert.equal(backup.target.database, config.DB_NAME);
  await fsp.mkdir(output, { recursive: true });
  const local = await mysql.createConnection({ host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER, password: config.DB_PASSWORD, database: config.DB_NAME, dateStrings: true });
  let isolated;
  try {
    const [[identity]] = await local.query('SELECT @@hostname AS hostname, @@server_uuid AS uuid, @@datadir AS directory');
    assert.equal(identity.hostname.toLowerCase(), os.hostname().toLowerCase()); assert.equal(identity.uuid, backup.identity.serverUuid); assert.match(identity.directory, /^[A-Za-z]:/);
    await local.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const actualBefore = await tableSnapshot(local), actualLedger = (await local.query('SELECT * FROM schema_migrations ORDER BY id'))[0];
    const readiness = await inspectLocalMigration017(local, config); assert.equal(readiness.ready, true, JSON.stringify(readiness.failures));
    await local.rollback();
    const bytes = await fsp.readFile(backup.dump), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, backup.sha256); assert.ok(path.resolve(backup.dump).startsWith(path.resolve('.data/backups') + path.sep)); assert.ok(!/^\s*(CREATE DATABASE|USE\s)/mi.test(bytes.toString('utf8')));
    isolated = await privateMysql({ diagnostic: console.log });
    const port = isolated.pool.pool.config.connectionConfig.port;
    await new Promise((resolve, reject) => {
      const child = spawn('C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe', ['--host=127.0.0.1', `--port=${port}`, '--user=root', '--binary-mode', '--default-character-set=utf8mb4', '--database=community_isolated'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const input = fs.createReadStream(backup.dump); input.pipe(child.stdin); input.once('error', reject); child.stdin.once('error', reject); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Private restore failed.')));
    });
    if (backup.jsonNumbers) {
      assert.equal(path.dirname(path.resolve(backup.jsonNumbers.file)), path.dirname(path.resolve(backup.dump)));
      const numericSql = await fsp.readFile(backup.jsonNumbers.file);
      assert.equal(crypto.createHash('sha256').update(numericSql).digest('hex'), backup.jsonNumbers.sha256);
      const client = await isolated.pool.getConnection();
      try { for (const statement of runner.parseStatements(numericSql.toString('utf8'))) await client.query(statement); }
      finally { client.release(); }
    }
    const before = await tableSnapshot(isolated.pool);
    const differences = Object.keys(before).filter(name => JSON.stringify(before[name]) !== JSON.stringify(actualBefore[name])).map(name => ({ table: name, backup: before[name], current: actualBefore[name] }));
    await fsp.writeFile(path.join(output, 'backup-current-comparison.json'), JSON.stringify({ capturedAt: new Date().toISOString(), differences }, null, 2));
    assert.equal(differences.length, 0, 'Backup differs from current local application records. Take a fresh backup before approval.');
    const ledger = (await isolated.pool.query('SELECT * FROM schema_migrations ORDER BY id'))[0];
    assert.deepEqual(ledger, actualLedger, 'Backup migration history differs from the current local ledger.');
    for (const [name, count] of Object.entries(backup.counts)) if (name !== 'schema_migrations') assert.equal(before[name].rows, count);
    const postDDL = (await isolated.pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'];
    const applied = await runner.runMigrations(isolated.pool);
    assert.deepEqual(applied.applied, ['017_incidents_and_routing.sql', '018_community_report_uniqueness.sql']);
    assert.deepEqual(await tableSnapshot(isolated.pool, before), before);
    assert.equal((await isolated.pool.query('SHOW CREATE TABLE community_posts'))[0][0]['Create Table'], postDDL);
    const afterLedger = (await isolated.pool.query('SELECT * FROM schema_migrations ORDER BY id'))[0]; assert.deepEqual(afterLedger.slice(0, 16), ledger); assert.equal(afterLedger.length, 18);
    assert.deepEqual((await runner.runMigrations(isolated.pool)).applied, []);
    await fsp.writeFile(path.join(output, 'backup-upgraded-schema.json'), JSON.stringify(await schemaSnapshot(isolated.pool), null, 2));
    await local.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    assert.deepEqual(await tableSnapshot(local, actualBefore), actualBefore); assert.deepEqual((await local.query('SELECT * FROM schema_migrations ORDER BY id'))[0], actualLedger); await local.rollback();
    const result = { capturedAt: new Date().toISOString(), backupSha256: sha256, restoredTables: Object.keys(backup.counts).length, originalTableFingerprintsPreserved: before, appliedOnPrivateCloneOnly: applied.applied, originalLedgerPreserved: true, existingIndexDDLUnchanged: true, rerunIdempotent: true, configuredLocalDataAndLedgerUnchanged: true, configuredLocalLedgerRows: actualLedger.length, configuredLocalWritesPerformed: false };
    await fsp.writeFile(path.join(output, 'backup-upgrade-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ evidenceDirectory: output, backupMatchesCurrentLocalSnapshot: true, backupHashVerified: true, all27CountsVerified: true, all26ApplicationTableFingerprintsPreserved: true, appliedOnPrivateCloneOnly: applied.applied, existingIndexDDLUnchanged: true, originalLedgerPreserved: true, configuredLocalLedgerRows: actualLedger.length, configuredLocalWritesPerformed: false }, null, 2));
  } finally { await local.end(); if (isolated) await isolated.close(); }
})().catch(error => { console.error(`${error.code || 'VERIFICATION_FAILED'}: ${error.message.split('\n')[0]}`); process.exitCode = 1; });
