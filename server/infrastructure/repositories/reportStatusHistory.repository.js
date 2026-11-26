const { getDatabase } = require('../database');

class ReportStatusHistoryRepository {
  async create({ reportId, oldStatus, newStatus, changedBy, note = null, requestKey = null, requestHash = null }, client = getDatabase()) {
    if (requestKey) return client.execute(
      'INSERT INTO report_status_history (report_id, old_status, new_status, changed_by, note, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [reportId, oldStatus || null, newStatus, changedBy, note, requestKey, requestHash]
    );
    return client.execute(
      'INSERT INTO report_status_history (report_id, old_status, new_status, changed_by, note) VALUES (?, ?, ?, ?, ?)',
      [reportId, oldStatus || null, newStatus, changedBy, note]
    );
  }

  async byRequest(reportId, requestKey, client = getDatabase()) {
    const rows = await client.query('SELECT id, changed_by, request_hash FROM report_status_history WHERE report_id = ? AND request_key = ?', [reportId, requestKey]);
    return rows[0] || null;
  }

  async addProofs(historyId, images, client = getDatabase()) {
    for (const [index, image] of images.entries()) await client.execute(
      'INSERT INTO report_action_proofs (history_id, image_path, image_order, mime_type, file_size) VALUES (?, ?, ?, ?, ?)',
      [historyId, image.imagePath, index + 1, image.mimeType, image.fileSize]
    );
  }

  async proofs(reportId, client = getDatabase()) {
    try {
      return await client.query(`SELECT p.* FROM report_action_proofs p
        JOIN report_status_history h ON h.id = p.history_id WHERE h.report_id = ? ORDER BY h.id, p.image_order`, [reportId]);
    } catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE' || error.sqlState === '42S02' || error.message?.includes('no such table')) return [];
      throw error;
    }
  }

  async findByReportId(reportId, client = getDatabase()) {
    return client.query(
      `SELECT h.id, h.report_id, h.old_status, h.new_status, h.changed_by, h.note, h.created_at,
              u.username AS changed_by_username, u.role AS changed_by_role
       FROM report_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.report_id = ?
       ORDER BY h.id ASC`,
      [reportId]
    );
  }
}

module.exports = new ReportStatusHistoryRepository();
