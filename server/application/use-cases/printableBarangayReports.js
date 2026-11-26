const { categoryOf } = require('../../../shared/reportVocabulary');
const { timestamp } = require('../../../shared/manilaDates');

function recordedPurok(row) {
  if (Number(row.location_matches_profile)) return 'Unknown Purok';
  const labels = new Set();
  for (const segment of String(row.location || '').split(/[,;\n]/)) {
    const match = segment.trim().match(/^(?:purok|prk\.?|puk\.?)\s+#?\s*([\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+){0,3})$/iu);
    if (match) labels.add(match[1].toLocaleLowerCase('en-PH'));
  }
  if (labels.size !== 1) return 'Unknown Purok';
  const [label] = labels;
  return 'Purok ' + label.replace(/\b\w/g, letter => letter.toUpperCase());
}

function breakdown(reports, key) {
  const counts = new Map();
  for (const report of reports) counts.set(report[key], (counts.get(report[key]) || 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count, percentage: 100 * count / reports.length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'en-PH', { numeric: true }));
}

function printableBarangayReports({ rows, offset }, scope, filters) {
  const reports = rows.map(row => {
    let assessment = row.submission_assessment;
    if (typeof assessment === 'string') {
      try { assessment = JSON.parse(assessment); } catch { assessment = null; }
    }
    const createdAt = timestamp(row.created_at, offset);
    return {
      id: row.id, barangay: row.barangay, status: row.status, description: row.description,
      ai_classification: row.ai_classification, ai_priority: row.ai_priority,
      created_at: createdAt === null ? null : new Date(createdAt).toISOString(),
      citizenCategory: categoryOf({ citizenCategory: assessment?.citizen_category, originalAi: assessment?.original_ai, ai_category: row.ai_category }),
      purok: recordedPurok(row)
    };
  });
  return { scope, filters, reports, categories: breakdown(reports, 'citizenCategory'), puroks: breakdown(reports, 'purok') };
}

module.exports = { printableBarangayReports };
