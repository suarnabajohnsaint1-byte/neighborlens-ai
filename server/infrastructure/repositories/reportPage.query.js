const vocabulary = require('../../../shared/reportVocabulary');
const dates = require('../../../shared/manilaDates');
const clock = require('../database/reportClock');

function categoryExpression(mysql) {
  const json = key => mysql ? `JSON_UNQUOTE(JSON_EXTRACT(r.submission_assessment, '$.${key}'))` : `json_extract(r.submission_assessment, '$.${key}')`;
  const citizen = `NULLIF(NULLIF(${json('citizen_category')}, ''), 'null')`;
  const source = `LOWER(TRIM(COALESCE(${citizen}, CASE WHEN r.submission_assessment IS NOT NULL THEN CASE WHEN ${json('original_ai.status')} = 'DETECTED' THEN ${json('original_ai.canonical_class')} ELSE '' END ELSE r.ai_category END, '')))`;
  const values = [];
  const cases = vocabulary.AI_REPORT_CATEGORIES.map(group => {
    const classes = vocabulary.ANALYTICS_DAMAGE_CATEGORIES.filter(item => vocabulary.category(item.classes[0]) === group).flatMap(item => item.classes);
    values.push(group.toLowerCase(), ...classes, group);
    return `WHEN ${source} IN (${[group, ...classes].map(() => '?').join(', ')}) THEN ?`;
  });
  return { sql: `CASE ${cases.join(' ')} ELSE 'Uncategorized' END`, values };
}

function classificationExpression(mysql) {
  const json = key => mysql ? `JSON_UNQUOTE(JSON_EXTRACT(r.submission_assessment, '$.${key}'))` : `json_extract(r.submission_assessment, '$.${key}')`;
  const suggestion = `CASE WHEN ${json('severity_suggestion.source')} = 'approved_measurement_rule' AND ${json('original_ai.status')} = 'DETECTED' AND COALESCE(${json('evidence_status')}, '') <> 'REVIEW' AND ${json('severity_suggestion.classification')} IN ('MINOR', 'MAJOR') THEN ${json('severity_suggestion.classification')} END`;
  return `COALESCE(CASE WHEN UPPER(TRIM(r.ai_classification)) IN ('MINOR', 'MAJOR') THEN UPPER(TRIM(r.ai_classification)) END, ${suggestion})`;
}

function matching(query, offset, mysql, dateColumn = 'r.created_at') {
  const where = [], values = [];
  if (query.status !== 'all') { where.push('r.status = ?'); values.push(query.status); }
  if (query.classification !== 'all') {
    where.push(`COALESCE(${classificationExpression(mysql)}, 'UNCLASSIFIED') = ?`);
    values.push(query.classification);
  }
  if (query.priority !== 'all') {
    where.push(query.priority === 'Unprioritized' ? 'r.ai_priority IS NULL' : 'r.ai_priority = ?');
    if (query.priority !== 'Unprioritized') values.push(query.priority);
  }
  if (query.category !== 'all') {
    if (vocabulary.AI_REPORT_CATEGORIES.includes(query.category) || query.category === 'Uncategorized') {
      const category = categoryExpression(mysql); where.push(`${category.sql} = ?`); values.push(...category.values, query.category);
    } else { where.push('LOWER(TRIM(r.ai_category)) = ?'); values.push(query.category.toLowerCase()); }
  }
  const range = dates.interval(query.dateFrom, query.dateTo);
  if (range.start !== null) { where.push(`${dateColumn} >= ?`); values.push(clock.wallTime(new Date(range.start).toISOString(), offset)); }
  if (range.end !== null) { where.push(`${dateColumn} < ?`); values.push(clock.wallTime(new Date(range.end).toISOString(), offset)); }
  if (query.search) {
    const citizenCategory = mysql ? "JSON_UNQUOTE(JSON_EXTRACT(r.submission_assessment, '$.citizen_category'))" : "json_extract(r.submission_assessment, '$.citizen_category')";
    const displayId = mysql ? "CONCAT('RPT_SRV_', r.id)" : "'RPT_SRV_' || CAST(r.id AS TEXT)";
    const columns = ['r.description', 'r.location', 'r.barangay', 'u.username', 'r.ai_category', citizenCategory, displayId, mysql ? 'CAST(r.id AS CHAR)' : 'CAST(r.id AS TEXT)'];
    where.push(`(${columns.map(column => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '!'`).join(' OR ')})`);
    const term = query.search.toLowerCase().replace(/[!%_]/g, character => `!${character}`);
    values.push(...columns.map(() => `%${term}%`));
  }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', values };
}

async function findReportPage(database, query, barangayId) {
  return database.withTransaction(async client => {
    const offset = await clock.offsetMinutes(database, client);
    const filter = matching(query, offset, database.driver === 'mysql');
    const classification = classificationExpression(database.driver === 'mysql');
    const from = 'FROM reports r LEFT JOIN users u ON u.id = r.submitted_by WHERE r.barangay_id = ?';
    const scope = [barangayId];
    const [count] = await client.query(`SELECT COUNT(*) AS total ${from}${filter.sql}`, [...scope, ...filter.values]);
    const total = Number(count.total), pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const priority = query.sort === 'priority' ? "CASE r.ai_priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ASC, " : '';
    const rows = await client.query(`SELECT r.*, u.username AS submitted_by_username ${from}${filter.sql} ORDER BY ${priority}r.created_at ${direction}, r.id ${direction} LIMIT ? OFFSET ?`,
      [...scope, ...filter.values, query.pageSize, (page - 1) * query.pageSize]);
    const [summary] = await client.query(`SELECT COUNT(*) AS total, COALESCE(SUM(r.status = 'pending'),0) AS pending,
      COALESCE(SUM(r.status = 'ongoing'),0) AS ongoing, COALESCE(SUM(r.status = 'resolved'),0) AS resolved,
      COALESCE(SUM(r.status = 'rejected'),0) AS rejected, COALESCE(SUM(${classification} = 'MAJOR'),0) AS major,
      COALESCE(SUM(${classification} = 'MINOR'),0) AS minor ${from}`, scope);
    const [filtered] = await client.query(`SELECT COUNT(*) AS total, COALESCE(SUM(r.status = 'pending'),0) AS pending,
      COALESCE(SUM(r.status = 'ongoing'),0) AS ongoing, COALESCE(SUM(r.status = 'resolved'),0) AS resolved,
      COALESCE(SUM(${classification} = 'MAJOR'),0) AS major,
      COALESCE(SUM(${classification} = 'MINOR'),0) AS minor ${from}${filter.sql}`, [...scope, ...filter.values]);
    return { rows, offset, pagination: { page, pages, pageSize: query.pageSize, total },
      stats: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number(value)])),
      filteredStats: Object.fromEntries(Object.entries(filtered).map(([key, value]) => [key, Number(value)])) };
  });
}

module.exports = { findReportPage, matching };
