const Excel = require('exceljs');
const vocabulary = require('../../../shared/reportVocabulary');
const clock = require('../database/reportClock');

function text(value) { return value == null ? '' : String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 32767); }
function date(value, offset) {
  if (!value) return null;
  const timestamp = Date.parse(clock.utc(value, offset));
  return Number.isFinite(timestamp) ? new Date(timestamp + 480 * 60000) : null;
}
function snapshot(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function style(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17212F' } };
  sheet.eachRow((row, index) => {
    if (index > 1) row.font = { name: 'Calibri', size: 11 };
    row.alignment = { vertical: 'top', wrapText: true };
  });
}
async function generate({ rows, offset, context }) {
  const workbook = new Excel.Workbook();
  workbook.creator = 'NeighborLens AI';
  const reports = workbook.addWorksheet('Reports');
  reports.columns = [
    ['Report ID', 16], ['Description', 55], ['Category', 25], ['Detected Issue Type', 25], ['Classification', 18],
    ['Priority', 16], ['Status', 16], ['Barangay', 25], ['Location / Address', 45], ['Latitude', 18], ['Longitude', 18],
    ['Submitted (Asia/Manila)', 25], ['Last Updated (Asia/Manila)', 25], ['Image Count', 15], ['Original AI Status', 22], ['AI Suggested Category', 25]
  ].map(([header, width]) => ({ header, width }));
  const counts = { pending: 0, ongoing: 0, resolved: 0, rejected: 0, MAJOR: 0, MINOR: 0, UNCLASSIFIED: 0 }, categories = new Map();
  for (const row of rows) {
    const assessment = snapshot(row.submission_assessment);
    const normalized = vocabulary.categoryOf({ citizenCategory: assessment?.citizen_category, originalAi: assessment?.original_ai, ai_category: row.ai_category });
    const category = !assessment && normalized === 'Uncategorized' && row.ai_category ? String(row.ai_category) : normalized;
    const classification = vocabulary.classification(row.ai_classification) || 'UNCLASSIFIED';
    if (Object.hasOwn(counts, row.status)) counts[row.status]++;
    if (Object.hasOwn(counts, classification)) counts[classification]++;
    categories.set(category, (categories.get(category) || 0) + 1);
    const original = assessment?.original_ai;
    const legacyDetected = Number(row.vision_detected) === 1 && vocabulary.isCanonicalDamageCategory(row.ai_category);
    const damage = assessment ? original?.status === 'DETECTED' ? original.canonical_class : null : legacyDetected ? row.ai_category : null;
    reports.addRow([text(`RPT-${row.id}`), text(row.description), text(category), text(damage), text(classification), text(row.ai_priority), text(row.status),
      text(row.barangay), text(row.location), row.latitude == null ? null : Number(row.latitude), row.longitude == null ? null : Number(row.longitude),
      date(row.created_at, offset), date(row.updated_at, offset), Number(row.image_count), text(original?.status || (legacyDetected ? 'DETECTED' : '')), text(original?.suggested_category)]);
  }
  reports.autoFilter = { from: 'A1', to: 'P1' };
  for (const index of [12, 13]) reports.getColumn(index).numFmt = 'yyyy-mm-dd hh:mm:ss';
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ header: 'Measure', width: 35 }, { header: 'Value', width: 65 }];
  summary.addRows([['Report scope', text(context.scope)], ['Portal', text(context.role)], ['Exported (Asia/Manila)', new Date(context.now.getTime() + 480 * 60000)],
    ['Total reports', rows.length], ...Object.entries(counts), ...[...categories].map(([key, count]) => [`Category: ${key}`, count]),
    ...Object.entries(context.filters).map(([key, value]) => [`Filter: ${key}`, text(value)]), ['Matching result', rows.length ? 'All matching authorized records' : 'No records matched the selected filters'], ['Consistency', 'Single bounded database SELECT; no pagination truncation']]);
  summary.getCell('B4').numFmt = 'yyyy-mm-dd hh:mm:ss';
  style(reports); style(summary);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
module.exports = { generate, text, date };
