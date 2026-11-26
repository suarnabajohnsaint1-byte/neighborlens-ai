const { ValidationError } = require('../errors');
const { categoryOf } = require('./damageCategories');

function identifier(value, zero = false) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || (!zero && Number(value) < 1)) throw new ValidationError('Invalid record version or identifier.');
  return Number(value);
}
function reason(value) {
  if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 500 || !/[\p{L}\p{N}]/u.test(value)) throw new ValidationError('Provide a meaningful correction or review reason of 10 to 500 characters.');
  return value.trim();
}
function key(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) throw new ValidationError('A valid request key is required.');
  return value;
}
function coordinates(report) {
  const lat = Number(report.latitude), lon = Number(report.longitude), accuracy = Number(report.gps_accuracy);
  return report.latitude != null && report.longitude != null && report.gps_accuracy != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100 ? { lat, lon } : null;
}
function category(report) {
  return categoryOf({ citizenCategory: report.submission_assessment?.citizen_category, originalAi: report.submission_assessment?.original_ai, ai_category: report.ai_category });
}
function candidate(source, target) {
  const a = coordinates(source), b = coordinates(target);
  const damage = report => report.submission_assessment?.original_ai?.canonical_class || report.ai_category;
  const known = ['pothole', 'road_crack', 'broken_streetlight', 'clogged_drainage'];
  if (known.includes(damage(source)) && known.includes(damage(target)) && damage(source) !== damage(target)) return null;
  if (!a || !b || category(source) === 'Uncategorized' || category(source) !== category(target)) return null;
  const rad = degrees => degrees * Math.PI / 180;
  const d = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  const meters = 6371000 * 2 * Math.atan2(Math.sqrt(d), Math.sqrt(1 - d));
  const hours = Math.abs(new Date(source.created_at).getTime() - new Date(target.created_at).getTime()) / 3600000;
  if (meters > 75 || !Number.isFinite(hours) || hours > 24 * 30) return null;
  const hashes = report => (report.submission_assessment?.evidence?.photos || []).map(photo => photo.sha256).filter(Boolean);
  const evidenceMatch = hashes(source).some(hash => hashes(target).includes(hash));
  const closed = ['resolved', 'rejected'].includes(target.status);
  return { reportId: Number(target.id), status: target.status, distanceMeters: Math.round(meters), hoursApart: Math.round(hours), evidenceMatch, kind: closed ? 'possible_recurrence' : 'possible_duplicate', signals: ['location', 'category', 'time', ...(evidenceMatch ? ['evidence_hash'] : []), closed ? 'closed_incident' : 'unresolved_incident'] };
}
module.exports = { identifier, reason, key, coordinates, candidate };
