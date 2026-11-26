const { getDatabase } = require('../database');
const { matching } = require('./reportPage.query');
class BarangayOperationsRepository {
  async gis(scope, query, offset) {
    const db = getDatabase();
    const filter = matching(query, offset, db.driver === 'mysql');
    return db.query(`SELECT r.id, r.barangay, r.latitude, r.longitude, r.status, r.ai_category, r.ai_classification, r.submission_assessment
      FROM reports r LEFT JOIN users u ON u.id = r.submitted_by WHERE r.barangay_id = ?${filter.sql}
      ORDER BY r.id DESC LIMIT ? OFFSET ?`, [scope, ...filter.values, query.pageSize + 1, (query.page - 1) * query.pageSize]);
  }
  async activity(scope, query, offset) {
    const db = getDatabase();
    const where = ["a.entity_type = 'report'", 'r.barangay_id = ?', "a.action IN ('create','status_update','classification_update','assign','reassign','review')"];
    const values = [scope];
    if (query.action) { where.push('a.action = ?'); values.push(query.action); }
    if (query.start) { where.push('a.created_at >= ?'); values.push(query.start); }
    if (query.end) { where.push('a.created_at < ?'); values.push(query.end); }
    if (query.search) { where.push('CAST(r.id AS CHAR) = ?'); values.push(query.search.replace(/^#/, '')); }
    const from = `FROM audit_logs a JOIN reports r ON r.id = a.entity_id LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')}`;
    const [count] = await db.query(`SELECT COUNT(*) AS total ${from}`, values);
    const rows = await db.query(`SELECT a.id, a.action, a.entity_id AS report_id, a.created_at, a.details, u.role AS actor_role ${from}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...values, query.pageSize, (query.page - 1) * query.pageSize]);
    return { rows, total: Number(count.total), offset };
  }
}
module.exports = new BarangayOperationsRepository();
