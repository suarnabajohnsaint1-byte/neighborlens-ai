const { getDatabase } = require('../database');
const { matching } = require('./reportPage.query');
const clock = require('../database/reportClock');
const { MAX_REPORTS } = require('../../domain/reports/reportExport.rules');
const { ValidationError } = require('../../domain/errors');

async function load({ scope, query, barangay, publication, printable }) {
  const database = getDatabase();
  return database.withTransaction(async client => {
    const offset = await clock.offsetMinutes(database, client);
    const timing = publication ? '(SELECT p.requested_at FROM community_publication_requests p WHERE p.report_id = r.id)' : 'r.created_at';
    const filter = matching(query, offset, database.driver === 'mysql', timing);
    const conditions = [], values = [];
    if (publication) conditions.push("EXISTS (SELECT 1 FROM community_publication_requests p WHERE p.report_id = r.id AND p.state = 'pending_approval')");
    if (scope !== null) { conditions.push('r.barangay_id = ?'); values.push(scope); }
    if (barangay !== 'all') { conditions.push('r.barangay = ?'); values.push(barangay); }
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const priority = query.sort === 'priority' ? "CASE r.ai_priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, " : '';
    const bytes = field => database.driver === 'mysql' ? `OCTET_LENGTH(COALESCE(${field}, ''))` : `LENGTH(CAST(COALESCE(${field}, '') AS BLOB))`;
    const rows = await client.query(`WITH candidates AS (SELECT r.id, r.description, r.location, r.barangay, r.latitude, r.longitude,
      r.ai_category, r.ai_classification, r.ai_priority, r.vision_detected, r.status, r.created_at, r.updated_at, r.submission_assessment, ${timing} AS list_requested_at,
      ${printable ? 'CASE WHEN LOWER(TRIM(r.location)) = LOWER(TRIM(identity.address)) THEN 1 ELSE 0 END AS location_matches_profile,' : ''}
      CASE WHEN (SELECT COUNT(*) FROM report_images i WHERE i.report_id = r.id) > 0
        THEN (SELECT COUNT(*) FROM report_images i WHERE i.report_id = r.id)
        WHEN r.image_path IS NOT NULL AND r.image_path <> '' THEN 1 ELSE 0 END AS image_count
      FROM reports r LEFT JOIN users u ON u.id = r.submitted_by
      ${printable ? 'LEFT JOIN citizen_identities identity ON identity.user_id = r.submitted_by' : ''}
      WHERE 1 = 1${conditions.length ? ' AND ' + conditions.join(' AND ') : ''}${filter.sql}
      ORDER BY ${priority}${timing} ${direction}, r.id ${direction} LIMIT ?),
      budget AS (SELECT COUNT(*) AS export_count, COALESCE(SUM(${['description', 'location', 'barangay', 'submission_assessment'].map(bytes).join(' + ')}), 0) AS export_bytes FROM candidates)
      SELECT c.*, budget.export_count, budget.export_bytes FROM budget LEFT JOIN candidates c
      ON budget.export_count <= ${MAX_REPORTS} AND budget.export_bytes <= 8388608
      ORDER BY ${query.sort === 'priority' ? "CASE c.ai_priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, " : ''}c.list_requested_at ${direction}, c.id ${direction}`, [...values, ...filter.values, MAX_REPORTS + 1]);
    if (Number(rows[0]?.export_count) > MAX_REPORTS || Number(rows[0]?.export_bytes) > 8388608) throw new ValidationError(`Export limit is ${MAX_REPORTS} reports and 8 MiB of text. Narrow the filters or date range.`);
    return { rows: rows.filter(row => row.id != null), offset };
  });
}

module.exports = { load };
