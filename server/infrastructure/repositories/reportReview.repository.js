const { getDatabase } = require('../database');

class ReportReviewRepository {
  async citizenComments(postId, before, client) {
    return client.query(`SELECT c.id, c.body, c.parent_id, c.created_at, cp.display_name, cp.avatar_variant FROM community_comments c LEFT JOIN community_personas cp ON cp.post_id = c.post_id AND cp.user_id = c.author_id WHERE c.post_id = ? AND c.is_official = 0 AND c.deleted_at IS NULL${before ? ' AND c.id < ?' : ''} ORDER BY c.id DESC LIMIT 31`, [postId, ...(before ? [before] : [])]);
  }
  async messageRequest(reportId, senderId, key, client = getDatabase()) {
    return (await client.query('SELECT * FROM report_coordination_messages WHERE report_id = ? AND sender_id = ? AND request_key = ?', [reportId, senderId, key]))[0] || null;
  }
  async createMessage(reportId, user, body, key, client) {
    return client.execute('INSERT INTO report_coordination_messages (report_id, sender_id, sender_role, body, request_key) VALUES (?, ?, ?, ?, ?)', [reportId, user.id, user.role, body, key]);
  }
  async messages(reportId, before, limit, client = getDatabase()) {
    return client.query(`SELECT m.id, m.body, m.sender_id, m.sender_role, m.created_at, u.username FROM report_coordination_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.report_id = ?${before ? ' AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`, [reportId, ...(before ? [before] : []), limit]);
  }
  async unread(reportId, userId, client = getDatabase()) {
    const [row] = await client.query('SELECT COUNT(*) AS total FROM report_coordination_messages WHERE report_id = ? AND (sender_id IS NULL OR sender_id <> ?) AND id > COALESCE((SELECT last_message_id FROM report_coordination_reads WHERE report_id = ? AND user_id = ?), 0)', [reportId, userId, reportId, userId]);
    return Number(row.total);
  }
  async readMessage(reportId, messageId, client = getDatabase()) {
    return (await client.query('SELECT id FROM report_coordination_messages WHERE report_id = ? AND id = ?', [reportId, messageId]))[0];
  }
  async markRead(reportId, userId, messageId, client) {
    const previous = (await client.query('SELECT last_message_id FROM report_coordination_reads WHERE report_id = ? AND user_id = ?', [reportId, userId]))[0];
    if (previous) return client.execute('UPDATE report_coordination_reads SET last_message_id = ? WHERE report_id = ? AND user_id = ?', [Math.max(Number(previous.last_message_id), messageId), reportId, userId]);
    return client.execute('INSERT INTO report_coordination_reads (report_id, user_id, last_message_id) VALUES (?, ?, ?)', [reportId, userId, messageId]);
  }
  async recipients(report, sender, client) {
    if (sender.role === 'admin') {
      return client.query("SELECT id, role, barangay_id AS barangayId FROM users WHERE status = 'active' AND role = 'barangay' AND barangay_id = ? AND id <> ?", [report.barangay_id, sender.id]);
    }
    return client.query(`SELECT u.id, u.role FROM users u
      WHERE u.status = 'active' AND u.role = 'admin' AND u.id <> ?
        AND (EXISTS (SELECT 1 FROM report_coordination_messages m
          WHERE m.report_id = ? AND m.sender_id = u.id AND m.sender_role = 'admin')
        OR NOT EXISTS (SELECT 1 FROM report_coordination_messages m
          WHERE m.report_id = ? AND m.sender_role = 'admin'))`, [sender.id, report.id, report.id]);
  }
  async severityHistory(reportId, client = getDatabase()) {
    return client.query('SELECT s.*, u.username FROM report_severity_reviews s LEFT JOIN users u ON u.id = s.reviewed_by WHERE report_id = ? ORDER BY s.id DESC LIMIT 50', [reportId]);
  }
  async latestSeverityStatus(reportId, client = getDatabase()) {
    const [row] = await client.query('SELECT classification FROM report_severity_reviews WHERE report_id = ? ORDER BY id DESC LIMIT 1', [reportId]);
    return !row ? 'pending' : row.classification ? 'confirmed' : 'review_required';
  }
  async severityRequest(reportId, key, client) {
    return (await client.query('SELECT * FROM report_severity_reviews WHERE report_id = ? AND request_key = ?', [reportId, key]))[0];
  }
  async saveSeverity(report, user, value, client) {
    const result = await client.execute('INSERT INTO report_severity_reviews (report_id, reviewed_by, category, classification, priority, previous_classification, previous_priority, reason, evidence, policy_version, recommendation, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [report.id, user.id, value.category, value.classification, value.priority, report.ai_classification, report.ai_priority, value.reason, JSON.stringify(value.evidence), value.policyVersion, value.recommendation, value.requestKey, value.requestHash]);
    await client.execute('UPDATE reports SET ai_classification = ?, ai_priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [value.classification, value.priority, report.id]);
    return result;
  }
}

module.exports = new ReportReviewRepository();
