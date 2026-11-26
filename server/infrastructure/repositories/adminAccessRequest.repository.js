const { getDatabase } = require('../database');
const { ConflictError } = require('../../domain/errors');

const PUBLIC_COLUMNS = 'id, username, full_name, reason, status, reviewed_by, reviewed_at, created_user_id, created_at';

class AdminAccessRequestRepository {
  async create({ username, fullName, passwordHash, reason }, client = getDatabase()) {
    try {
      return await client.execute(
        'INSERT INTO admin_access_requests (username, full_name, password_hash, reason) VALUES (?, ?, ?, ?)',
        [username, fullName, passwordHash, reason]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' || /UNIQUE constraint failed/i.test(error.message || '')) {
        throw new ConflictError('A request for that username is already waiting for approval.');
      }
      throw error;
    }
  }

  async hasPendingForUsername(username, client = getDatabase()) {
    const rows = await client.query(
      "SELECT id FROM admin_access_requests WHERE LOWER(username) = LOWER(?) AND status = 'pending' LIMIT 1",
      [username]
    );
    return rows.length > 0;
  }

  async findPending(client = getDatabase()) {
    return client.query(
      `SELECT ${PUBLIC_COLUMNS} FROM admin_access_requests WHERE status = 'pending' ORDER BY created_at ASC, id ASC`
    );
  }

  async findForDecision(id, client = getDatabase()) {
    const locking = getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';
    const rows = await client.query(
      `SELECT id, username, full_name, password_hash, status FROM admin_access_requests WHERE id = ?${locking}`,
      [id]
    );
    return rows[0] || null;
  }

  async findById(id, client = getDatabase()) {
    const rows = await client.query(`SELECT ${PUBLIC_COLUMNS} FROM admin_access_requests WHERE id = ?`, [id]);
    return rows[0] || null;
  }

  async decide(id, { status, reviewerId, createdUserId = null }, client = getDatabase()) {
    return client.execute(
      `UPDATE admin_access_requests
       SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, created_user_id = ?, password_hash = ''
       WHERE id = ? AND status = 'pending'`,
      [status, reviewerId, createdUserId, id]
    );
  }
}

module.exports = new AdminAccessRequestRepository();
