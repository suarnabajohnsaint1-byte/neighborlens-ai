const { getDatabase } = require('../database');
const { ANALYTICS_DAMAGE_CATEGORIES } = require('../../domain/reports/damageCategories');
const { MANILA_OFFSET_MINUTES } = require('../../domain/reports/reportAnalytics.rules');
const reportClock = require('../database/reportClock');

class ReportAnalyticsRepository {
  async aggregate(range, barangayId = null) {
    const database = getDatabase();
    const mysql = database.driver === 'mysql';
    return database.withTransaction(async client => {
      const offset = await reportClock.offsetMinutes(database, client);
      const shift = MANILA_OFFSET_MINUTES - offset;
      const date = column => mysql ? `DATE_FORMAT(DATE_ADD(${column}, INTERVAL ${shift} MINUTE), '%Y-%m-%d')`
        : `date(${column}, '${shift >= 0 ? '+' : ''}${shift} minutes')`;
      const json = key => mysql ? `JSON_UNQUOTE(JSON_EXTRACT(r.submission_assessment, '$.original_ai.${key}'))`
        : `json_extract(r.submission_assessment, '$.original_ai.${key}')`;
      const primary = `LOWER(TRIM(COALESCE(CASE WHEN ${json('status')} = 'DETECTED' THEN NULLIF(NULLIF(${json('canonical_class')}, ''), 'null') END, r.ai_category, '')))`;
      const parameters = [];
      const mapping = ANALYTICS_DAMAGE_CATEGORIES.map(category => {
        parameters.push(...category.classes, category.key);
        return `WHEN ${primary} IN (${category.classes.map(() => '?').join(', ')}) THEN ?`;
      }).join(' ');
      const start = reportClock.wallTime(range.startUtc, offset);
      const end = reportClock.wallTime(range.endExclusiveUtc, offset);
      const scope = barangayId === null ? '' : ' AND r.barangay_id = ?';
      const scoped = barangayId === null ? [] : [barangayId];
      const catalog = barangayId === null ? await client.query('SELECT id, name FROM barangays ORDER BY name, id') : null;
      const areaColumn = catalog ? ', r.barangay_id AS barangayId' : '';
      const areaGroup = catalog ? ', r.barangay_id' : '';
      const submissions = await client.query(
        `SELECT ${date('r.created_at')} AS day, CASE ${mapping} ELSE 'uncategorized' END AS category, COUNT(*) AS total${areaColumn},
           SUM(CASE WHEN r.status = 'ongoing' THEN 1 ELSE 0 END) AS currentOngoing,
           SUM(CASE WHEN r.status = 'resolved' THEN 1 ELSE 0 END) AS currentResolved
         FROM reports r WHERE r.created_at >= ? AND r.created_at < ?${scope} GROUP BY day, category${areaGroup} ORDER BY day, category`,
        [...parameters, start, end, ...scoped]
      );
      const firstResolution = `SELECT report_id, MIN(created_at) AS resolved_at FROM report_status_history
        WHERE new_status = 'resolved' AND (old_status IS NULL OR old_status <> 'resolved') GROUP BY report_id`;
      const resolutions = await client.query(
        `SELECT ${date('h.resolved_at')} AS day, COUNT(*) AS total${areaColumn} FROM (${firstResolution}) h
         INNER JOIN reports r ON r.id = h.report_id WHERE h.resolved_at >= ? AND h.resolved_at < ?${scope} GROUP BY day${areaGroup} ORDER BY day`,
        [start, end, ...scoped]
      );
      const ongoing = await client.query(
        `SELECT ${date('h.ongoing_at')} AS day, COUNT(*) AS total${areaColumn} FROM (
          SELECT report_id, MIN(created_at) AS ongoing_at FROM report_status_history
          WHERE new_status = 'ongoing' AND (old_status IS NULL OR old_status <> 'ongoing') GROUP BY report_id
        ) h INNER JOIN reports r ON r.id = h.report_id
        WHERE h.ongoing_at >= ? AND h.ongoing_at < ?${scope} GROUP BY day${areaGroup} ORDER BY day`,
        [start, end, ...scoped]
      );
      const missing = await client.query(
        `SELECT COUNT(*) AS total${areaColumn} FROM reports r LEFT JOIN (${firstResolution}) h ON h.report_id = r.id
         WHERE r.status = 'resolved' AND h.resolved_at IS NULL AND r.created_at < ?${scope}${catalog ? ' GROUP BY r.barangay_id' : ''}`, [end, ...scoped]
      );
      return { submissions, resolutions, ongoing, catalog,
        missingResolutionByBarangay: catalog ? missing : null,
        missingResolutionHistory: missing.reduce((total, row) => total + Number(row.total), 0), timestampOffsetMinutes: offset };
    });
  }
}

module.exports = new ReportAnalyticsRepository();
