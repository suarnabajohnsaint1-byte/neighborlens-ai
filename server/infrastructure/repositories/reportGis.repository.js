const { getDatabase } = require('../database');
const { matching } = require('./reportPage.query');
class ReportGisRepository {
  async load(scope, query, offset) {
    const database = getDatabase();
    const filter = matching(query, offset, database.driver === 'mysql');
    const scopeSql = scope === null ? '' : ' AND r.barangay_id = ?';
    const values = [...(scope === null ? [] : [scope]), ...filter.values];
    const from = `FROM reports r LEFT JOIN users u ON u.id = r.submitted_by WHERE r.latitude BETWEEN -90 AND 90 AND r.longitude BETWEEN -180 AND 180${scopeSql}${filter.sql}`;
    if (query.extentOnly) {
      const [extent] = await database.query(`SELECT MIN(r.latitude) AS south, MAX(r.latitude) AS north, MIN(r.longitude) AS west, MAX(r.longitude) AS east, MAX(r.id) AS through, COUNT(*) AS total ${from}`, values);
      return { extent, rows: [] };
    }
    const [west, south, east, north] = query.bounds;
    const rows = await database.query(`SELECT r.id, r.barangay, r.latitude, r.longitude, r.status, r.ai_category, r.ai_classification, r.ai_priority, r.submission_assessment, r.description, r.location, r.created_at ${from}
      AND r.longitude BETWEEN ? AND ? AND r.latitude BETWEEN ? AND ? AND r.id > ?${query.through === null ? '' : ' AND r.id <= ?'} ORDER BY r.id ASC LIMIT 201`,
    [...values, west, east, south, north, query.after, ...(query.through === null ? [] : [query.through])]);
    return { rows };
  }
}
module.exports = new ReportGisRepository();
