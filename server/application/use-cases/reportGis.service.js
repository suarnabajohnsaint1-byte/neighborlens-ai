const { gisScope, gisQuery } = require('../../domain/reports/gisQuery.rules');
const vocabulary = require('../../domain/reports/damageCategories');
function createReportGisService({ repository, clock, getDatabase }) {
  return {
    async load(user, input) {
      const scope = gisScope(user), query = gisQuery(input);
      const offset = await clock.offsetMinutes(getDatabase());
      const result = await repository.load(scope, query, offset);
      if (query.extentOnly) {
        const extent = result.extent;
        return { total: Number(extent.total), through: Number(extent.through || 0), bounds: Number(extent.total) ? [Number(extent.west), Number(extent.south), Number(extent.east), Number(extent.north)] : null, boundaryVerified: false };
      }
      const rows = result.rows.slice(0, 200);
      return { reports: rows.map(row => {
        let snapshot = row.submission_assessment;
        if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; } }
        return { id: Number(row.id), latitude: Number(row.latitude), longitude: Number(row.longitude), barangay: row.barangay,
          category: vocabulary.categoryOf({ citizenCategory: snapshot?.citizen_category, originalAi: snapshot?.original_ai, ai_category: row.ai_category }),
          damageType: snapshot ? snapshot.original_ai?.canonical_class || null : row.ai_category,
          status: row.status, classification: vocabulary.classification(row.ai_classification), priority: vocabulary.priority(row.ai_priority),
          description: String(row.description || '').slice(0, 240), location: String(row.location || '').slice(0, 240), createdAt: clock.utc(row.created_at, offset) };
      }), nextCursor: result.rows.length > 200 ? Number(rows[rows.length - 1].id) : null, boundaryVerified: false };
    }
  };
}
module.exports = { createReportGisService };
