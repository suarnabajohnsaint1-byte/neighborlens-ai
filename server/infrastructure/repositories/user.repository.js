const { getDatabase } = require('../database');
const { ConflictError } = require('../../domain/errors');

const SAFE_COLUMNS = 'id, username, role, barangay, barangay_id, full_name, status, created_at';

const ACCOUNT_COLUMNS = `u.id, u.username, u.role, u.full_name, u.status, u.account_version, u.created_at, u.updated_at,
  u.barangay_id, COALESCE(b.name, u.barangay) AS barangay`;

function isUniqueConstraintError(error) {
  return error.code === 'ER_DUP_ENTRY' || /UNIQUE/i.test(error.message || '');
}

class UserRepository {
  async findByUsername(username, client = getDatabase()) {
    const rows = await client.query('SELECT * FROM users WHERE username = ?', [username]);
    return rows[0] || null;
  }

  async findById(id, client = getDatabase()) {
    const rows = await client.query(`SELECT ${SAFE_COLUMNS} FROM users WHERE id = ?`, [id]);
    return rows[0] || null;
  }

  async findCredentialsById(id, client = getDatabase()) {
    const rows = await client.query(
      'SELECT id, username, role, status, password_hash, token_version, account_version FROM users WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  async findSessionState(id, client = getDatabase()) {
    const rows = await client.query(
      `SELECT u.id, u.username, u.role, u.status, u.token_version, u.barangay_id, u.enrollment_tier, u.residency_confirmed_at,
              COALESCE(b.name, u.barangay) AS barangay
       FROM users u
       LEFT JOIN barangays b ON b.id = u.barangay_id
       WHERE u.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  async findAll(client = getDatabase()) {
    return client.query(`SELECT ${SAFE_COLUMNS} FROM users ORDER BY username`);
  }

  async findAccountsByRole(role, client = getDatabase()) {
    return client.query(
      `SELECT ${ACCOUNT_COLUMNS}
       FROM users u
       LEFT JOIN barangays b ON b.id = u.barangay_id
       WHERE u.role = ?
       ORDER BY u.username`,
      [role]
    );
  }

  async findAccountById(id, client = getDatabase()) {
    const rows = await client.query(
      `SELECT ${ACCOUNT_COLUMNS}
       FROM users u
       LEFT JOIN barangays b ON b.id = u.barangay_id
       WHERE u.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  async create({ username, passwordHash, role, barangay, barangayId = null, fullName, enrollmentTier = 'LEGACY' }, client = getDatabase()) {
    try {
      return await client.execute(
        `INSERT INTO users (username, password_hash, role, barangay, barangay_id, full_name, enrollment_tier)
         VALUES (?, ?, ?, ?, COALESCE(?, (SELECT id FROM barangays WHERE name = NULLIF(?, ''))), ?, ?)`,
        [username, passwordHash, role, barangay, barangayId, barangay, fullName, enrollmentTier]
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictError('Username already exists.', { cause: error });
      }
      throw error;
    }
  }

  async updateOfficialProfile(id, expectedVersion, { fullName, barangayId, barangay, revokeSessions }, client = getDatabase()) {
    return client.execute(
      `UPDATE users
       SET full_name = ?, barangay_id = ?, barangay = ?,
           token_version = token_version + ?, account_version = account_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND role = 'barangay' AND account_version = ?`,
      [fullName, barangayId, barangay, revokeSessions ? 1 : 0, id, expectedVersion]
    );
  }

  async updateOfficialStatus(id, expectedVersion, status, client = getDatabase()) {
    return client.execute(
      `UPDATE users
       SET status = ?, token_version = token_version + 1, account_version = account_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND role = 'barangay' AND account_version = ? AND status <> ?`,
      [status, id, expectedVersion, status]
    );
  }

  async updateOfficialPassword(id, expectedVersion, passwordHash, client = getDatabase()) {
    return client.execute(
      `UPDATE users
       SET password_hash = ?, token_version = token_version + 1, account_version = account_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND role = 'barangay' AND account_version = ?`,
      [passwordHash, id, expectedVersion]
    );
  }

  async updateOwnPassword(id, expectedVersion, passwordHash, client = getDatabase()) {
    return client.execute(
      `UPDATE users
       SET password_hash = ?, token_version = token_version + 1, account_version = account_version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND account_version = ?`,
      [passwordHash, id, expectedVersion]
    );
  }

  async updateOwnFullName(id, expectedVersion, fullName, client = getDatabase()) {
    return client.execute(
      `UPDATE users
       SET full_name = ?, account_version = account_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND account_version = ?`,
      [fullName, id, expectedVersion]
    );
  }

  async revokeSessions(id, client = getDatabase()) {
    return client.execute(
      'UPDATE users SET token_version = token_version + 1 WHERE id = ?',
      [id]
    );
  }

  async replaceCitizenSession(id, version, client) {
    return client.execute(
      "UPDATE users SET token_version = token_version + 1 WHERE id = ? AND role = 'citizen' AND status = 'active' AND token_version = ?",
      [id, version]
    );
  }

  async confirmCitizenResidence(id, { cityVersion, barangayVersion }, client) {
    await client.execute(`UPDATE users SET residency_confirmed_at = CURRENT_TIMESTAMP,
      residency_city_version = ?, residency_barangay_version = ? WHERE id = ?`, [cityVersion, barangayVersion, id]);
  }
}

module.exports = new UserRepository();
