const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const config = require('../../server/infrastructure/config/env');
const { inspectLocalMigration017 } = require('../../server/infrastructure/database/mysql/preflight017');
const { tableSnapshot } = require('./migration-recovery-fixtures');
const { captureJsonNumbers } = require('./mysql-json-numbers');

(async () => {
  if (config.DB_DRIVER !== 'mysql' || config.DB_TARGET !== 'local' || config.NODE_ENV === 'production' || config.DB_HOST !== '127.0.0.1' || !Number.isInteger(config.DB_PORT) || config.DB_PORT < 1 || config.DB_PORT > 65535) throw new Error('Only the verified loopback local development database is allowed.');
  const connection = await mysql.createConnection({ host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER, password: config.DB_PASSWORD, database: config.DB_NAME, dateStrings: true });
  try {
    const before = await inspectLocalMigration017(connection, config);
    assert.equal(before.ready, true, 'Strict preflight must pass before this migration backup.');
    const fingerprints = await tableSnapshot(connection);
    const jsonNumbers = await captureJsonNumbers(connection);
    const directory = path.resolve('.data/backups', `local-migration-recovery-${Date.now()}`);
    await fs.mkdir(directory, { recursive: true });
    const dump = path.join(directory, 'before-017-018.sql');
    const numbersFile = path.join(directory, 'native-json-numbers.sql');
    await fs.writeFile(numbersFile, jsonNumbers.sql);
    const binary = process.env.MYSQLDUMP_EXE || 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe';
    await new Promise((resolve, reject) => {
      const child = spawn(binary, [`--host=${config.DB_HOST}`, `--port=${config.DB_PORT}`, `--user=${config.DB_USER}`, '--single-transaction', '--routines', '--events', '--triggers', '--no-tablespaces', '--set-gtid-purged=OFF', `--result-file=${dump}`, config.DB_NAME], { windowsHide: true, stdio: 'ignore', env: { ...process.env, MYSQL_PWD: config.DB_PASSWORD } });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local backup utility failed.')));
    });
    const bytes = await fs.readFile(dump);
    assert.ok(bytes.length > 100 && bytes.subarray(-1024).toString('utf8').includes('Dump completed'), 'Backup completion marker is missing.');
    const after = await inspectLocalMigration017(connection, config);
    assert.equal(after.ready, true); assert.deepEqual(after.counts, before.counts); assert.deepEqual(after.checksums, before.checksums);
    assert.deepEqual(await tableSnapshot(connection, fingerprints), fingerprints, 'Local records changed during backup; repeat in a maintenance window.');
    const manifest = { capturedAt: new Date().toISOString(), target: { host: config.DB_HOST, port: config.DB_PORT, database: config.DB_NAME }, identity: before.identity, dump, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), jsonNumbers: { file: numbersFile, sha256: createHash('sha256').update(jsonNumbers.sql).digest('hex'), statements: jsonNumbers.statements, numericValues: jsonNumbers.numericValues }, counts: before.counts, checksums: before.checksums, applicationFingerprints: fingerprints, pending: before.pending, migration017: before.migration017, migration018: before.migration018, databaseWritesPerformed: false };
    const manifestPath = path.join(directory, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ manifest: manifestPath, dump, sha256: manifest.sha256, bytes: bytes.length, databaseWritesPerformed: false }, null, 2));
  } finally { await connection.end(); }
})().catch(error => { console.error(`${error.code || 'BACKUP_FAILED'}: ${error.message.split('\n')[0]}`); process.exitCode = 1; });
