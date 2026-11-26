const { getDatabase } = require('../database');
const lock = () => getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';
const snapshot = row => row && { ...row, submission_assessment: typeof row.submission_assessment === 'string' ? JSON.parse(row.submission_assessment) : row.submission_assessment };

class IncidentRepository {
  async ready(db = getDatabase()) {
    if (getDatabase().driver === 'mysql') return (await db.query("SHOW TABLES LIKE 'report_incident_lock'")).length > 0;
    try { await db.query('SELECT id FROM report_incident_lock WHERE id = 1'); return true; }
    catch (error) { if (error.code === 'ER_NO_SUCH_TABLE' || /no such table: report_incident_lock/.test(error.message)) return false; throw error; }
  }
  async lock(db) { await db.query(`SELECT id FROM report_incident_lock WHERE id = 1${lock()}`); }
  async report(id, db = getDatabase()) { return snapshot((await db.query(`SELECT * FROM reports WHERE id = ?${lock()}`, [id]))[0]); }
  async membership(id, db = getDatabase(), current = false) { return (await db.query(`SELECT i.* FROM report_incidents i JOIN report_incident_members m ON m.incident_id = i.id WHERE m.report_id = ?${current ? lock() : ''}`, [id]))[0] || null; }
  async members(id, db) { return (await db.query(`SELECT r.* FROM reports r JOIN report_incident_members m ON m.report_id = r.id WHERE m.incident_id = ? ORDER BY r.id${lock()}`, [id])).map(snapshot); }
  async candidates(report, db) {
    return (await db.query('SELECT * FROM reports WHERE barangay_id = ? AND id <> ? AND latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? ORDER BY created_at DESC, id DESC LIMIT 201', [report.barangay_id, report.id, Number(report.latitude) - 0.001, Number(report.latitude) + 0.001, Number(report.longitude) - 0.001, Number(report.longitude) + 0.001])).map(snapshot);
  }
  async version(id, db) { return Number((await db.query(`SELECT version FROM report_routing_versions WHERE report_id = ?${lock()}`, [id]))[0]?.version || 0); }
  async advance(id, db) {
    const upsert = getDatabase().driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE version = version + 1' : 'ON CONFLICT(report_id) DO UPDATE SET version = version + 1';
    await db.execute(`INSERT INTO report_routing_versions (report_id, version) VALUES (?, 1) ${upsert}`, [id]);
  }
  async prior(id, key, db) { return (await db.query(`SELECT * FROM report_coordination_events WHERE report_id = ? AND request_key = ?${lock()}`, [id, key]))[0]; }
  async record(id, actor, kind, key, hash, reason, details, db) {
    return db.execute('INSERT INTO report_coordination_events (report_id, actor_id, kind, request_key, request_hash, reason, details) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, actor, kind, key, hash, reason, JSON.stringify(details)]);
  }
  async history(id, db) { return db.query('SELECT id, actor_id, kind, reason, details, created_at FROM report_coordination_events WHERE report_id = ? ORDER BY id DESC LIMIT 50', [id]); }
  async createIncident(report, actor, db) {
    const result = await db.execute('INSERT INTO report_incidents (canonical_report_id, barangay_id, created_by) VALUES (?, ?, ?)', [report.id, report.barangay_id, actor]);
    await this.link(report.id, result.insertId, db);
    return this.membership(report.id, db, true);
  }
  async link(report, incident, db) { await db.execute('INSERT INTO report_incident_members (report_id, incident_id) VALUES (?, ?)', [report, incident]); }
  async advanceIncident(id, db) { await db.execute('UPDATE report_incidents SET version = version + 1 WHERE id = ?', [id]); }
  async routingAdministrators(permission, db) { return db.query("SELECT p.user_id AS id FROM user_permissions p JOIN users u ON u.id = p.user_id WHERE p.permission = ? AND u.role = 'admin' AND u.status = 'active'", [permission]); }
  async posts(incident, db) { return db.query(`SELECT p.id FROM community_posts p JOIN report_incident_members m ON m.report_id = p.report_id WHERE m.incident_id = ? AND p.deleted_at IS NULL AND (p.is_official = 1 OR EXISTS (SELECT 1 FROM community_publication_legacy l WHERE l.post_id = p.id) OR EXISTS (SELECT 1 FROM community_publication_requests a WHERE a.post_id = p.id AND a.state = 'approved')) ORDER BY p.id`, [incident]); }
  async setCanonical(incident, post, db) {
    await db.execute('UPDATE report_incidents SET canonical_post_id = ?, version = version + 1 WHERE id = ?', [post, incident]);
    await db.execute("UPDATE community_publication_requests SET discussion_post_id = ? WHERE state = 'approved' AND report_id IN (SELECT report_id FROM report_incident_members WHERE incident_id = ?)", [post, incident]);
  }
  async alias(post, canonical, incident, db) { await db.execute('INSERT INTO community_post_aliases (post_id, canonical_post_id, incident_id) VALUES (?, ?, ?)', [post, canonical, incident]); }
  async aliasOf(post, db = getDatabase()) { return (await db.query('SELECT canonical_post_id FROM community_post_aliases WHERE post_id = ?', [post]))[0]?.canonical_post_id || null; }
  async publishedPost(post, scope, db) {
    return (await db.query(`SELECT p.id FROM community_posts p LEFT JOIN community_publication_requests a ON a.post_id = p.id AND a.state = 'approved' LEFT JOIN community_publication_legacy l ON l.post_id = p.id WHERE p.id = ? AND p.barangay_id = ? AND p.deleted_at IS NULL AND (p.is_official = 1 OR a.id IS NOT NULL OR l.post_id IS NOT NULL)${lock()}`, [post, scope]))[0] || null;
  }
  async discussion(report, db) {
    const incident = await this.membership(report, db);
    if (incident?.canonical_post_id) return Number(incident.canonical_post_id);
    return null;
  }
  async relocate(report, barangay, db) {
    await db.execute("UPDATE reports SET barangay_id = ?, barangay = ?, jurisdiction_source = 'admin_assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [barangay.id, barangay.name, report.id]);
    await db.execute('UPDATE community_publication_requests SET barangay_id = ?, version = version + 1 WHERE report_id = ?', [barangay.id, report.id]);
    await db.execute('UPDATE community_posts SET barangay_id = ? WHERE report_id = ?', [barangay.id, report.id]);
    await this.advance(report.id, db);
  }
  async relocateIncident(incident, barangay, db) { await db.execute('UPDATE report_incidents SET barangay_id = ?, version = version + 1 WHERE id = ?', [barangay, incident]); }
  async recipients(report, previous, db) { return db.query("SELECT id FROM users WHERE status = 'active' AND ((role = 'barangay' AND (barangay_id = ? OR barangay_id = ?)) OR (role = 'citizen' AND id = ?))", [previous, report.barangay_id, report.submitted_by]); }
}
module.exports = new IncidentRepository();
