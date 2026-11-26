const { getDatabase } = require('../database');
const { ConflictError } = require('../../domain/errors');

async function anyKeyUsed(keys, db = getDatabase()) {
  const placeholders = keys.map(() => '?').join(', ');
  const rows = await db.query(`SELECT 1 FROM citizen_enrollment_keys WHERE verification_key IN (${placeholders}) LIMIT 1`, keys);
  return rows.length > 0;
}

async function verifiedDocumentUsed({ documentType, idNumber }, db = getDatabase()) {
  const number = idNumber.replace(/[-\s]/g, '').toUpperCase();
  const rows = await db.query(`SELECT 1 FROM citizen_identities i
    JOIN users u ON u.id = i.user_id AND u.enrollment_tier <> 'ACTIVE_LIMITED'
    WHERE (i.document_type = ? OR (? = 'PHILSYS' AND i.document_type = 'NATIONAL_ID'))
    AND UPPER(REPLACE(REPLACE(i.id_number, '-', ''), ' ', '')) = ?
    AND EXISTS (SELECT 1 FROM citizen_enrollment_keys k WHERE k.user_id = i.user_id)
    LIMIT 1`, [documentType, documentType, number]);
  return rows.length > 0;
}

async function recordKeys(userId, keys, db) {
  try {
    for (const key of keys) {
      await db.execute('INSERT INTO citizen_enrollment_keys (verification_key, user_id) VALUES (?, ?)', [key, userId]);
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || [1555, 2067].includes(error.errcode)) {
      throw new ConflictError('This document or capture is already associated with an account.',
        { code: 'REGISTRATION_ID_ALREADY_USED' });
    }
    throw error;
  }
}

async function isVerifiedEnrollment(userId, db = getDatabase()) {
  const rows = await db.query(`SELECT 1 FROM citizen_enrollment_keys k JOIN users u ON u.id = k.user_id
    WHERE k.user_id = ? AND u.enrollment_tier <> 'ACTIVE_LIMITED' LIMIT 1`, [userId]);
  return rows.length > 0;
}

module.exports = { anyKeyUsed, recordKeys, isVerifiedEnrollment, verifiedDocumentUsed };
