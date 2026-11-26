const { getDatabase } = require('../database');
const { validateSubmissionAssessment } = require('../../domain/reports/submissionAssessment.rules');
const { ConflictError } = require('../../domain/errors');
const { findReportPage } = require('./reportPage.query');

function snapshotOf(row) {
  if (!row) return row;
  if (typeof row.submission_assessment === 'string') row.submission_assessment = JSON.parse(row.submission_assessment);
  return row;
}

class ReportRepository {
  async lockSubmissionActor(userId, client) {
    const lock = getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';
    const [actor] = await client.query(`SELECT id, status, token_version, barangay_id, residency_confirmed_at
      FROM users WHERE id = ?${lock}`, [userId]);
    return actor;
  }

  async hasUsedGpsFix(userId, gpsFixAt, client = getDatabase()) {
    const rows = await client.query('SELECT 1 FROM reports WHERE submitted_by = ? AND gps_fix_at = ? LIMIT 1', [userId, gpsFixAt]);
    return rows.length > 0;
  }

  async findPage(query, barangayId, database = getDatabase()) {
    const result = await findReportPage(database, query, barangayId);
    return { ...result, rows: result.rows.map(snapshotOf) };
  }

  async create({
    description, location, barangay, barangayId = null, jurisdictionSource = 'citizen_declared',
    boundaryCheckStatus = 'service_area_unknown', latitude, longitude, gpsAccuracy = null, gpsFixAt = null, imagePath,
    aiCategory, aiClassification, aiPriority, aiConfidence, visionDetected, submittedBy, submissionAssessment = null,
    landmarkDescription = null, landmarkImagePath = null
  }, client = getDatabase()) {
    validateSubmissionAssessment(submissionAssessment);
    return client.execute(
      `INSERT INTO reports (
        description, location, barangay, barangay_id, jurisdiction_source, boundary_check_status,
        latitude, longitude, gps_accuracy, gps_fix_at, image_path, ai_category, ai_classification, ai_priority,
        ai_confidence, vision_detected, submitted_by, submission_assessment,
        landmark_description, landmark_image_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        description, location, barangay, barangayId, jurisdictionSource, boundaryCheckStatus,
        latitude, longitude, gpsAccuracy, gpsFixAt, imagePath, aiCategory, aiClassification, aiPriority,
        aiConfidence, visionDetected ? 1 : 0, submittedBy, submissionAssessment ? JSON.stringify(submissionAssessment) : null,
        landmarkDescription || null, landmarkImagePath || null
      ]
    );
  }

  async findById(id, client = getDatabase()) {
    const rows = await client.query('SELECT * FROM reports WHERE id = ?', [id]);
    return snapshotOf(rows[0]) || null;
  }

  async findByIdForUpdate(id, client) {
    const lock = getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';
    const rows = await client.query(`SELECT * FROM reports WHERE id = ?${lock}`, [id]);
    return snapshotOf(rows[0]) || null;
  }

  async findAll({ role, userId, barangayId, status, filterBarangay, publication }, client = getDatabase()) {
    const filters = [];
    const values = [];
    if (publication) filters.push("EXISTS (SELECT 1 FROM community_publication_requests p WHERE p.report_id = r.id AND p.state = 'pending_approval')");

    if (role === 'barangay') {
      filters.push('r.barangay_id = ?');
      values.push(barangayId ?? null);
    }
    if (role === 'citizen') {
      filters.push('r.submitted_by = ?');
      values.push(userId);
    }
    if (status) {
      filters.push('r.status = ?');
      values.push(status);
    }
    if (filterBarangay && role === 'admin') {
      filters.push('r.barangay = ?');
      values.push(filterBarangay);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = await client.query(
      `SELECT r.*, u.username AS submitted_by_username
       FROM reports r
       LEFT JOIN users u ON u.id = r.submitted_by
       ${where}
       ORDER BY r.created_at DESC, r.id DESC`,
      values
    );
    return rows.map(snapshotOf);
  }

  async assertUnusedAssessment(userId, proofIds, client = getDatabase()) {
    const locking = getDatabase().driver === 'mysql' ? ' FOR UPDATE' : '';
    await client.query(`SELECT id FROM users WHERE id = ?${locking}`, [userId]);
    const rows = await client.query(`SELECT submission_assessment FROM reports WHERE submitted_by = ? AND submission_assessment IS NOT NULL${locking}`, [userId]);
    if (rows.some(row => snapshotOf(row).submission_assessment.evidence?.photos?.some(photo => proofIds.includes(photo.proof_id)))) {
      throw new ConflictError('This assessment has already been submitted.', { code: 'ASSESSMENT_REPLAY' });
    }
  }

  async updateStatus(id, status, expectedStatus = null, client = getDatabase()) {
    if (expectedStatus === null) {
      return client.execute('UPDATE reports SET status = ? WHERE id = ?', [status, id]);
    }
    return client.execute(
      'UPDATE reports SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?',
      [status, id, expectedStatus]
    );
  }
}

module.exports = new ReportRepository();
