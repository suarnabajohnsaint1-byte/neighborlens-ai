const test = require('node:test');
const assert = require('node:assert/strict');
const { privateMysql } = require('../support/private-mysql');
const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
const repository = require('../../server/infrastructure/repositories/damageVerification.repository');

test('migration 015 preserves existing severity, stores unknown as SQL NULL and remains repeatable', { timeout: 120000 }, async t => {
  const database = await privateMysql(t);
  try {
    await runMigrations(database.pool);
    await database.pool.query('ALTER TABLE damage_verifications MODIFY COLUMN highest_severity VARCHAR(20) NOT NULL');
    await database.pool.query("DELETE FROM schema_migrations WHERE filename = '015_nullable_verification_severity.sql'");
    const [created] = await database.pool.query("INSERT INTO reports (description, barangay, ai_classification, ai_priority) VALUES ('QA migration fixture', 'Villamonte', NULL, NULL)");
    await repository.create({ reportId: created.insertId, highestSeverity: 'low', rawPayload: { highest_severity: 'low' } }, database.adapter);
    const [before] = await database.pool.query('SELECT * FROM damage_verifications');
    assert.deepEqual((await runMigrations(database.pool)).applied, ['015_nullable_verification_severity.sql']);
    const [after] = await database.pool.query('SELECT * FROM damage_verifications');
    assert.deepEqual(after, before);
    await repository.create({ reportId: created.insertId, highestSeverity: null, rawPayload: { highest_severity: null } }, database.adapter);
    const [unknown] = await repository.findByReportId(created.insertId, database.adapter);
    assert.equal(unknown.highest_severity, null);
    assert.equal(unknown.raw_payload.highest_severity, null);
    assert.deepEqual((await runMigrations(database.pool)).applied, []);
    await assert.rejects(repository.create({ reportId: 999999, highestSeverity: null, rawPayload: {} }, database.adapter), error => error.code === 'ER_NO_REFERENCED_ROW_2');
  } finally { await database.close(); }
});
