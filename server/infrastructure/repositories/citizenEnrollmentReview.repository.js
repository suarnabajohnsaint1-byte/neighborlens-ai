const { getDatabase } = require('../database');

async function create({ reference, tokenKey, boundaryVersion, classification, imageKeys, expiresAt, now }) {
  const db = getDatabase();
  // Retain decisions in the audit log. Expired applications can no longer be redeemed.
  await db.execute('DELETE FROM citizen_enrollment_reviews WHERE expires_at <= ?', [now]);
  await db.execute(`INSERT INTO citizen_enrollment_reviews
    (reference, token_key, state, boundary_version, screening, frame_keys, expires_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
  [reference, tokenKey, boundaryVersion, classification, JSON.stringify(imageKeys), expiresAt]);
}

async function findByToken(tokenKey) {
  const rows = await getDatabase().query('SELECT * FROM citizen_enrollment_reviews WHERE token_key = ?', [tokenKey]);
  return rows[0];
}

async function list(now, after) {
  return getDatabase().query(`SELECT id, reference, boundary_version, screening, expires_at
    FROM citizen_enrollment_reviews WHERE state = 'pending' AND expires_at > ? AND id > ?
    ORDER BY id LIMIT 50`, [now, after]);
}

async function decide({ reference, state, factsKey, subjectKey, now, classification, decisionExpiresAt }, audit) {
  return getDatabase().withTransaction(async tx => {
    const updated = await tx.execute(`UPDATE citizen_enrollment_reviews
      SET state = ?, facts_key = ?, subject_key = ?, screening = COALESCE(?, screening), expires_at = ?
      WHERE reference = ? AND state = 'pending' AND expires_at > ?`,
    [state, factsKey, subjectKey, classification, decisionExpiresAt, reference, now]);
    if (updated.affectedRows !== 1) return false;
    const [row] = await tx.query('SELECT id FROM citizen_enrollment_reviews WHERE reference = ?', [reference]);
    await audit(row.id, tx);
    return true;
  });
}

async function consume(id, now, tx) {
  const result = await tx.execute(`UPDATE citizen_enrollment_reviews
    SET state = 'used', facts_key = NULL, subject_key = NULL, frame_keys = '[]'
    WHERE id = ? AND state = 'approved' AND expires_at > ?`, [id, now]);
  return result.affectedRows === 1;
}

module.exports = { create, findByToken, list, decide, consume };
