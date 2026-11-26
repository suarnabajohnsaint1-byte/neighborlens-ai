const test = require('node:test');
const assert = require('node:assert/strict');
const { privateMysql } = require('../support/private-mysql');
const { listMigrationFiles, readMigration, runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');

test('panel migrations preserve legacy addresses and reports and enforce one report per citizen GPS fix', { timeout: 90_000 }, async t => {
  const { pool, adapter, close } = await privateMysql(t);
  t.after(close);
  await pool.query(`CREATE TABLE schema_migrations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, filename VARCHAR(255) NOT NULL UNIQUE,
    checksum VARCHAR(64) NOT NULL, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const name of (await listMigrationFiles()).filter(name => name < '023_')) {
    const migration = await readMigration(name);
    for (const statement of migration.statements) await pool.query(statement);
    await adapter.execute('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [name, migration.checksum]);
  }
  const addCitizen = async name => (await adapter.execute(
    "INSERT INTO users (username, password_hash, role, barangay, barangay_id) VALUES (?, 'fixture', 'citizen', 'Barangay 1', 1)", [name]
  )).insertId;
  const first = await addCitizen('panel-citizen-a');
  const second = await addCitizen('panel-citizen-b');
  await adapter.execute('INSERT INTO citizen_identities (user_id, address) VALUES (?, ?)', [first, 'Legacy test address']);
  await adapter.execute("INSERT INTO reports (description, barangay, submitted_by) VALUES ('Existing report', 'Barangay 1', ?)", [first]);

  assert.deepEqual((await runMigrations(pool)).applied, ['023_citizen_residency_confirmation.sql', '024_report_gps_fix.sql']);
  assert.deepEqual((await runMigrations(pool)).applied, []);
  assert.equal((await adapter.query('SELECT residency_confirmed_at FROM users WHERE id = ?', [first]))[0].residency_confirmed_at, null);
  assert.equal((await adapter.query('SELECT address FROM citizen_identities WHERE user_id = ?', [first]))[0].address, 'Legacy test address');
  assert.equal((await adapter.query('SELECT gps_fix_at FROM reports WHERE submitted_by = ?', [first]))[0].gps_fix_at, null);

  const insert = user => adapter.execute("INSERT INTO reports (description, barangay, submitted_by, gps_fix_at) VALUES ('Fresh report', 'Barangay 1', ?, 1795526400000)", [user]);
  const results = await Promise.allSettled([insert(first), insert(first)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ER_DUP_ENTRY');
  await insert(second);
});
