const test = require('node:test');
const assert = require('node:assert/strict');
const { privateMysql } = require('../support/private-mysql');
const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
const { citizenIdentityService } = require('../../server/composition');
const { useTestDatabase, resetDatabase } = require('../../server/infrastructure/database');
const { recordKeys } = require('../../server/infrastructure/repositories/citizenEnrollment.repository');

test('MySQL citizen identity persistence preserves full name, date-only birth date without timezone shift, and derived status', async t => {
  const { pool, adapter, close } = await privateMysql(t);
  try {
    await runMigrations(pool);
    useTestDatabase(adapter);

    const [userRes] = await pool.query(
      "INSERT INTO users (username, password_hash, role, barangay, full_name) VALUES ('test_ocr_user', 'hash', 'citizen', 'Villamonte', 'Test Resident')"
    );
    const userId = userRes.insertId;

    const savedDto = await citizenIdentityService.saveOwnIdentity(userId, {
      documentType: 'PHILSYS',
      idNumber: '1234-5678-9012-3456',
      fullName: 'Alex Morgan Reyes Sample',
      birthDate: '2001-09-15',
      address: 'Villamonte Bacolod City',
      expiryDate: null,
      ocrConfidence: 94.5
    });

    assert.equal(savedDto.fullName, 'Alex Morgan Reyes Sample');
    assert.equal(savedDto.birthDate, '2001-09-15');
    assert.equal(savedDto.documentType, 'PHILSYS');
    assert.equal(savedDto.ocrConfidence, 0.945);
    assert.equal(savedDto.formatCheckStatus, 'pass');
    assert.equal(savedDto.documentValidationStatus, 'pass');
    assert.equal(savedDto.expirationStatus, 'NOT_APPLICABLE');
    assert.equal(savedDto.expiryDate, null);
    assert.equal(savedDto.isExpired, null);

    const [rawRows] = await pool.query('SELECT user_id, full_name, birth_date, document_type, ocr_confidence, expiry_date, is_expired FROM citizen_identities WHERE user_id = ?', [userId]);
    assert.equal(rawRows.length, 1);
    assert.equal(rawRows[0].full_name, 'Alex Morgan Reyes Sample');
    const rawDob = rawRows[0].birth_date instanceof Date ? rawRows[0].birth_date.toISOString().slice(0, 10) : String(rawRows[0].birth_date).slice(0, 10);
    assert.equal(rawDob, '2001-09-15');
    assert.equal(Number(rawRows[0].ocr_confidence), 0.945);
    assert.equal(rawRows[0].expiry_date, null);
    assert.equal(rawRows[0].is_expired, null);

    const updatedDto = await citizenIdentityService.saveOwnIdentity(userId, {
      documentType: 'PHILSYS',
      idNumber: '1234-5678-9012-3456',
      fullName: 'Alex Morgan Reyes Sample Jr.',
      birthDate: '2001-09-16',
      address: 'Villamonte Bacolod City',
      expiryDate: null,
      ocrConfidence: 95.0
    });

    assert.equal(updatedDto.fullName, 'Alex Morgan Reyes Sample Jr.');
    assert.equal(updatedDto.birthDate, '2001-09-16');

    const [updatedRows] = await pool.query('SELECT full_name, birth_date FROM citizen_identities WHERE user_id = ?', [userId]);
    assert.equal(updatedRows[0].full_name, 'Alex Morgan Reyes Sample Jr.');
    const updatedDob = updatedRows[0].birth_date instanceof Date ? updatedRows[0].birth_date.toISOString().slice(0, 10) : String(updatedRows[0].birth_date).slice(0, 10);
    assert.equal(updatedDob, '2001-09-16');
    const readDto = await citizenIdentityService.getOwnIdentity(userId);
    assert.equal(readDto.expirationStatus, 'NOT_APPLICABLE');
    assert.equal(readDto.expiryDate, null);
    assert.equal(readDto.isExpired, null);

    const keys = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const registerWithSameDocument = username => adapter.withTransaction(async tx => {
      const user = await tx.execute(
        "INSERT INTO users (username, password_hash, role, barangay) VALUES (?, 'fixture', 'citizen', 'Villamonte')",
        [username]
      );
      await recordKeys(user.insertId, keys, tx);
    });
    const results = await Promise.allSettled([
      registerWithSameDocument('fixture_document_race_1'),
      registerWithSameDocument('fixture_document_race_2')
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REGISTRATION_ID_ALREADY_USED');
    const [raceUsers] = await pool.query("SELECT id FROM users WHERE username IN ('fixture_document_race_1', 'fixture_document_race_2')");
    assert.equal(raceUsers.length, 1);
    const [storedKeys] = await pool.query('SELECT verification_key FROM citizen_enrollment_keys WHERE user_id = ?', [raceUsers[0].id]);
    assert.equal(storedKeys.length, 3);
  } finally {
    resetDatabase();
    await close();
  }
});
