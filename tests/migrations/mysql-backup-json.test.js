const test = require('node:test');
const assert = require('node:assert/strict');
const { privateMysql } = require('../support/private-mysql');
const { captureJsonNumbers } = require('../support/mysql-json-numbers');
const { parseStatements } = require('../../server/infrastructure/database/mysql/migrationRunner');

test('private backup numeric sidecar restores exact native JSON numbers without timestamp changes', { timeout: 90000 }, async t => {
  const database = await privateMysql(t);
  try {
    const pool = database.pool;
    await pool.query('CREATE TABLE synthetic_backup (id INT PRIMARY KEY, payload JSON, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)');
    await pool.query(`INSERT INTO synthetic_backup VALUES (1, JSON_OBJECT('tiny', CAST('1.2383761108049694e-18' AS DOUBLE), 'values', JSON_ARRAY(CAST('-4.6035886114468605e-17' AS DOUBLE), CAST('18446744073709551615' AS UNSIGNED), CAST('-9223372036854775808' AS SIGNED), CAST('123.4500' AS DECIMAL(10,4)), true, null, 'private synthetic text'), 'quoted"key', CAST('5.590112535682853e-19' AS DOUBLE)), '2026-09-01 00:00:00')`);
    const before = (await pool.query('SELECT id, CAST(payload AS CHAR) AS document, updated_at FROM synthetic_backup'))[0];
    const sidecar = await captureJsonNumbers(pool);
    assert.equal(sidecar.numericValues, 6); assert.ok(sidecar.statements > 0);
    await pool.query('UPDATE synthetic_backup SET payload = CAST(payload AS CHAR), updated_at = updated_at');
    const intermediate = (await pool.query('SELECT id, CAST(payload AS CHAR) AS document, updated_at FROM synthetic_backup'))[0];
    assert.notEqual(intermediate[0].document, before[0].document, 'Fixture must reproduce native JSON text round-trip precision drift.');
    for (const sql of parseStatements(sidecar.sql)) await pool.query(sql);
    assert.deepEqual((await pool.query('SELECT id, CAST(payload AS CHAR) AS document, updated_at FROM synthetic_backup'))[0], before);
    await pool.query('CREATE TRIGGER synthetic_backup_guard BEFORE UPDATE ON synthetic_backup FOR EACH ROW SET NEW.updated_at = NEW.updated_at');
    await assert.rejects(captureJsonNumbers(pool), /reviewed handling of table triggers/);
  } finally { await database.close(); }
});
