const { getDatabase } = require('../database');

class CitizenIdentityRepository {
  async findByUserId(userId, client = getDatabase()) {
    const rows = await client.query('SELECT * FROM citizen_identities WHERE user_id = ?', [userId]);
    return rows[0] || null;
  }

  async findReviewedAddress(userId, client = getDatabase()) {
    const rows = await client.query("SELECT address FROM citizen_identities WHERE user_id = ? AND document_validation_status IN ('pass', 'needs_review')", [userId]);
    return rows[0]?.address || null;
  }

  async upsert({
    userId, documentType, idNumber, fullName, birthDate, address, expiryDate,
    ocrConfidence, formatCheckStatus, documentValidationStatus, isExpired
  }, client = getDatabase()) {
    const params = [
      documentType, idNumber, fullName, birthDate, address, expiryDate,
      ocrConfidence, formatCheckStatus, documentValidationStatus,
      isExpired === null || isExpired === undefined ? null : (isExpired ? 1 : 0)
    ];

    const columns = ['document_type', 'id_number', 'full_name', 'birth_date', 'address', 'expiry_date', 'ocr_confidence', 'format_check_status', 'document_validation_status', 'is_expired'];
    const mysql = (client.driver || getDatabase().driver) === 'mysql';
    const assignments = columns.map(column => `${column} = ${mysql ? `VALUES(${column})` : `excluded.${column}`}`).join(', ');
    await client.execute(
      `INSERT INTO citizen_identities (
        user_id, document_type, id_number, full_name, birth_date, address, expiry_date,
        ocr_confidence, format_check_status, document_validation_status, is_expired
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${mysql ? 'ON DUPLICATE KEY UPDATE' : 'ON CONFLICT(user_id) DO UPDATE SET'} ${assignments}`,
      [userId, ...params]
    );
    return this.findByUserId(userId, client);
  }
}

module.exports = new CitizenIdentityRepository();
