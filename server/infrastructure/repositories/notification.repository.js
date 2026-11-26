const { getDatabase } = require('../database');

class NotificationRepository {
  async create({ userId, reportId, title, message, type }, client = getDatabase()) {
    const result = await client.execute(
      `INSERT INTO notifications (user_id, report_id, title, message, type)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, reportId, title, message, type]
    );
    return {
      id: result.insertId,
      userId,
      reportId,
      title,
      message,
      type,
      readAt: null
    };
  }

  async findByUserId(userId, { limit = 50, offset = 0 } = {}, client = getDatabase()) {
    const rows = await client.query(
      `SELECT id, user_id, report_id, title, message, type, read_at, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      reportId: row.report_id,
      title: row.title,
      message: row.message,
      type: row.type,
      readAt: row.read_at,
      createdAt: row.created_at
    }));
  }

  async findById(id, userId = null, client = getDatabase()) {
    const params = [id];
    let sql = `SELECT id, user_id, report_id, title, message, type, read_at, created_at
       FROM notifications
       WHERE id = ?`;
    if (userId !== null && userId !== undefined) {
      sql += ` AND user_id = ?`;
      params.push(userId);
    }
    const rows = await client.query(sql, params);
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      reportId: row.report_id,
      title: row.title,
      message: row.message,
      type: row.type,
      readAt: row.read_at,
      createdAt: row.created_at
    };
  }

  async countUnread(userId, client = getDatabase()) {
    const rows = await client.query(
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE user_id = ? AND read_at IS NULL`,
      [userId]
    );
    return Number(rows[0]?.count || 0);
  }

  async markAsRead(id, userId, client = getDatabase()) {
    const result = await client.execute(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND read_at IS NULL`,
      [id, userId]
    );
    return result.affectedRows > 0;
  }

  async markAllAsRead(userId, client = getDatabase()) {
    const result = await client.execute(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND read_at IS NULL`,
      [userId]
    );
    return result.affectedRows;
  }
}

module.exports = new NotificationRepository();
