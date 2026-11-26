const { getDatabase } = require('../database');
const locked = () => getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';

class CommunityPublicationRepository {
  async admins(db) {
    return db.query(`SELECT id, status, role, token_version FROM users WHERE role = 'admin' ORDER BY id${locked()}`);
  }
  async lockReport(id, db) {
    return (await db.query(`SELECT id, submitted_by, barangay_id, barangay, jurisdiction_source, status, description FROM reports WHERE id = ?${locked()}`, [id]))[0] || null;
  }
  async find(report, db = getDatabase(), lock = false) {
    return (await db.query(`SELECT * FROM community_publication_requests WHERE report_id = ?${lock ? locked() : ''}`, [report]))[0] || null;
  }
  async byKey(user, key, db) {
    return (await db.query('SELECT * FROM community_publication_requests WHERE requested_by = ? AND request_key = ?', [user, key]))[0] || null;
  }
  async workload(db) {
    return db.query("SELECT assigned_admin_id, COUNT(*) AS total FROM community_publication_requests WHERE state = 'pending_approval' GROUP BY assigned_admin_id");
  }
  async create({ report, user, scope, body, key, hash, admin }, db) {
    return db.execute('INSERT INTO community_publication_requests (report_id, requested_by, barangay_id, body, request_key, request_hash, assigned_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [report, user, scope, body, key, hash, admin]);
  }
  async resubmit(id, { body, key, hash, admin }, db) {
    await db.execute("UPDATE community_publication_requests SET state = 'pending_approval', body = ?, request_key = ?, request_hash = ?, assigned_admin_id = ?, reviewed_by = NULL, rejection_reason = NULL, reviewed_at = NULL, requested_at = CURRENT_TIMESTAMP, version = version + 1, attempts = attempts + 1 WHERE id = ? AND state = 'rejected'", [body, key, hash, admin, id]);
    await db.execute('DELETE FROM community_publication_media WHERE request_id = ?', [id]);
  }
  async assign(id, admin, db) {
    await db.execute('UPDATE community_publication_requests SET assigned_admin_id = ?, version = version + 1 WHERE id = ?', [admin, id]);
  }
  async media(id, db = getDatabase()) {
    return db.query('SELECT image_order, storage_reference FROM community_publication_media WHERE request_id = ? ORDER BY image_order', [id]);
  }
  async addMedia(id, reference, order, db) {
    await db.execute('INSERT INTO community_publication_media (request_id, storage_reference, image_order) VALUES (?, ?, ?)', [id, reference, order]);
  }
  async decide(id, version, state, admin, reason, post, db) {
    await db.execute('INSERT INTO community_publication_reviews (request_id, version, reviewer_id, decision, reason) VALUES (?, ?, ?, ?, ?)', [id, version, admin, state, reason]);
    return db.execute("UPDATE community_publication_requests SET state = ?, reviewed_by = ?, rejection_reason = ?, post_id = ?, reviewed_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND state = 'pending_approval' AND version = ?", [state, admin, reason, post, id, version]);
  }
  async queue(db = getDatabase()) {
    return db.query('SELECT report_id, state, assigned_admin_id, version, requested_at FROM community_publication_requests ORDER BY requested_at, id');
  }
  async owned(user, db = getDatabase()) {
    return db.query('SELECT report_id, state, rejection_reason, version, attempts, post_id, body FROM community_publication_requests WHERE requested_by = ?', [user]);
  }
  async history(request, db = getDatabase()) {
    return db.query('SELECT version, reviewer_id, decision, reason, reviewed_at FROM community_publication_reviews WHERE request_id = ? ORDER BY version', [request]);
  }
  async resolveJurisdiction(report, request, barangay, db) {
    await db.execute("UPDATE reports SET barangay_id = ?, barangay = ?, jurisdiction_source = 'admin_assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [barangay.id, barangay.name, report]);
    await db.execute('UPDATE community_publication_requests SET barangay_id = ?, version = version + 1 WHERE id = ?', [barangay.id, request]);
  }
}
module.exports = new CommunityPublicationRepository();
