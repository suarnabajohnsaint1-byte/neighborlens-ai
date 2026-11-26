const crypto = require('node:crypto');
const { DamageDetectionError } = require('../errors');
const { isCanonicalDamageCategory, displayLabelFor, reportCategoryFor } = require('./damageCategories');
const { triageForSeverity } = require('./report.rules');

const SUPPORTED_TASKS = Object.freeze(new Set(['detect', 'segment', 'pose', 'obb', 'classify']));
const SUPPORTED_MIME_TYPES = Object.freeze(new Set(['image/jpeg', 'image/png', 'image/webp']));
const SEVERITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MIN_CONFIDENCE = 0.5;

const DETECTION_OUTCOMES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  NO_DETECTION: 'NO_DETECTION',
  UNSUPPORTED_CLASS: 'UNSUPPORTED_CLASS'
});

const ASSESSMENT_STATUS_BY_OUTCOME = Object.freeze({
  ACCEPTED: 'DETECTED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  NO_DETECTION: 'NO_DETECTION',
  UNSUPPORTED_CLASS: 'UNSUPPORTED'
});

function assessmentStatusFor(outcome) {
  return ASSESSMENT_STATUS_BY_OUTCOME[outcome] || 'UNSUPPORTED';
}

// Identified from the magic bytes rather than from a declared content type.
function detectMimeType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  throw new DamageDetectionError('Unsupported or invalid image format.', 'IMAGE_FORMAT');
}

function validateImage(buffer, mimeType, maxBytes = DEFAULT_MAX_BYTES) {
  if (!SUPPORTED_MIME_TYPES.has(mimeType))
    throw new DamageDetectionError('Only JPEG, PNG, and WebP images are supported.', 'IMAGE_FORMAT');
  if (!buffer.length) throw new DamageDetectionError('Image cannot be empty.', 'IMAGE_EMPTY');
  if (buffer.length > maxBytes)
    throw new DamageDetectionError(`Image exceeds the ${maxBytes} byte limit.`, 'IMAGE_TOO_LARGE');
  if (detectMimeType(buffer) !== mimeType)
    throw new DamageDetectionError('Image MIME type does not match its file contents.', 'IMAGE_FORMAT');
}

// Accepts either a 0-1 score or a 0-100 percentage.
function confidenceAsUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
}

function normalizeSeverity(value) {
  const severity = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SEVERITY_LEVELS.includes(severity) ? severity : null;
}

function validDetectionGeometry(item, size = null) {
  const coordinates = item?.polygon_coordinates || item?.polygon || item?.bounding_box || item?.bbox || item?.box;
  if (coordinates === undefined || coordinates === null) return true;
  const number = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value));
  const point = (x, y) => number(x) && number(y) && Number(x) >= 0 && Number(y) >= 0 &&
    (!size || Number(x) <= size.width && Number(y) <= size.height);
  if (Array.isArray(coordinates)) {
    if (coordinates.every(Array.isArray)) return coordinates.length >= 3 && coordinates.every(pair => pair.length === 2 && point(...pair));
    return coordinates.length >= 4 && coordinates.length % 2 === 0 && coordinates.every((value, index) => index % 2 || point(value, coordinates[index + 1]));
  }
  const x = coordinates.x ?? coordinates.left, y = coordinates.y ?? coordinates.top;
  const { width, height } = coordinates;
  return point(x, y) && number(width) && number(height) && Number(width) > 0 && Number(height) > 0 &&
    (!size || Number(x) + Number(width) <= size.width + 0.01 && Number(y) + Number(height) <= size.height + 0.01);
}

// Returns null when the item carries no usable damage type, so malformed
// entries are dropped rather than guessed at.
function normalizeDetection(item) {
  const damageType = String(item?.damage_type || item?.damageType || item?.class || item?.label || '').trim();
  const confidence = confidenceAsUnit(item?.confidence_score ?? item?.confidence ?? item?.score);
  if (!damageType) return null;

  const box = item?.bounding_box || item?.bbox || item?.box;
  const polygon = item?.polygon_coordinates || item?.polygon;
  const coordinates = Array.isArray(polygon) ? polygon : box;
  const boundingBox = Array.isArray(coordinates)
    ? coordinates
    : {
        x: Number(box?.x ?? box?.left ?? 0),
        y: Number(box?.y ?? box?.top ?? 0),
        width: Number(box?.width ?? 0),
        height: Number(box?.height ?? 0)
      };

  return {
    damage_id: String(item?.damage_id || crypto.randomUUID()),
    damage_type: damageType,
    canonical_category: isCanonicalDamageCategory(damageType) ? damageType : null,
    display_category: displayLabelFor(damageType),
    confidence_score: Number(confidence.toFixed(4)),
    raw_confidence_score: confidence,
    severity_level: normalizeSeverity(item?.severity_level ?? item?.severity),
    bounding_box: boundingBox,
    timestamp: item?.timestamp || new Date().toISOString(),
    labels: Array.isArray(item?.labels) ? item.labels.map(String) : [],
    provider_eligible: item?.eligible !== false
  };
}

function selectPrimaryDetection(detections) {
  if (!Array.isArray(detections) || !detections.length) return null;
  return detections.slice().sort((a, b) => b.confidence_score - a.confidence_score)[0] || null;
}

function isEligible(detection, minConfidence) {
  return (
    isCanonicalDamageCategory(detection.damage_type) &&
    detection.provider_eligible !== false &&
    (detection.raw_confidence_score ?? detection.confidence_score) >= minConfidence
  );
}

function evaluateDetections(detections, minConfidence) {
  const canonical = detections.filter((item) => isCanonicalDamageCategory(item.damage_type));
  const eligible = canonical.filter((item) => isEligible(item, minConfidence));

  if (eligible.length) {
    return { outcome: DETECTION_OUTCOMES.ACCEPTED, primary: selectPrimaryDetection(eligible), eligible };
  }
  if (canonical.length) {
    return {
      outcome: DETECTION_OUTCOMES.LOW_CONFIDENCE,
      primary: selectPrimaryDetection(canonical),
      eligible
    };
  }
  if (detections.length) {
    return {
      outcome: DETECTION_OUTCOMES.UNSUPPORTED_CLASS,
      primary: selectPrimaryDetection(detections),
      eligible
    };
  }
  return { outcome: DETECTION_OUTCOMES.NO_DETECTION, primary: null, eligible };
}

function maximumSuggestion(suggestions, category) {
  return suggestions.filter(item => item?.source === 'approved_measurement_rule' && item.category === category &&
    normalizeSeverity(item.level)).sort((a, b) =>
    SEVERITY_LEVELS.indexOf(normalizeSeverity(b.level)) - SEVERITY_LEVELS.indexOf(normalizeSeverity(a.level)) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')
  )[0] ?? null;
}

function photoSeveritySuggestion(result) {
  if (!result.detected) return null;
  const category = result.candidate?.canonical_category;
  return maximumSuggestion((result.detections || []).filter(item => item.eligible).map(item => item.severity_suggestion), category);
}

function pairSeveritySuggestion(suggestions, category) {
  return suggestions.length === 2 && suggestions.every(item => item?.source === 'approved_measurement_rule' &&
    item.category === category && normalizeSeverity(item.level) && item.classification === suggestions[0].classification &&
    item.policyVersion === suggestions[0].policyVersion)
    ? maximumSuggestion(suggestions, category) : null;
}

function evaluatePairResults(results) {
  const candidates = results.map((result) => result.candidate);
  const sameClass = Boolean(
    candidates[0] &&
    candidates[1] &&
    isCanonicalDamageCategory(candidates[0].canonical_category) &&
    candidates[0].canonical_category === candidates[1].canonical_category
  );
  const detected = sameClass && results.every((result) => result.detected && result.candidate.accepted);
  const canonicalClass = sameClass ? candidates[0].canonical_category : null;
  const status = sameClass
    ? detected
      ? 'DETECTED'
      : 'LOW_CONFIDENCE'
    : candidates.some(Boolean)
      ? 'PAIR_MISMATCH'
      : results.some((result) => result.reason === DETECTION_OUTCOMES.UNSUPPORTED_CLASS)
        ? 'UNSUPPORTED'
        : 'NO_DETECTION';
  const categories = candidates.map((candidate) => reportCategoryFor(candidate?.canonical_category));
  const sameReportCategory = Boolean(categories[0] && categories[0] === categories[1]);
  const suggestions = results.map(photoSeveritySuggestion);
  const severitySuggestion = detected ? pairSeveritySuggestion(suggestions, canonicalClass) : null;
  const severityConflict = detected && suggestions.every(Boolean) && !severitySuggestion;
  const severity = normalizeSeverity(severitySuggestion?.level);
  const { aiClassification, aiPriority } = triageForSeverity(severity);
  return {
    status,
    detected,
    sameClass,
    canonicalClass,
    severity,
    reportCategory: reportCategoryFor(canonicalClass),
    sameReportCategory,
    sharedReportCategory: sameReportCategory ? categories[0] : null,
    confidence: sameClass
      ? Math.round((candidates[0].confidence + candidates[1].confidence) * 5000) / 10000
      : null,
    triage: severity ? { classification: aiClassification, priority: aiPriority } : null,
    severitySuggestion, severityConflict
  };
}

module.exports = {
  validDetectionGeometry,
  DETECTION_OUTCOMES,
  ASSESSMENT_STATUS_BY_OUTCOME,
  assessmentStatusFor,
  SUPPORTED_TASKS,
  SUPPORTED_MIME_TYPES,
  SEVERITY_LEVELS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MIN_CONFIDENCE,
  detectMimeType,
  validateImage,
  confidenceAsUnit,
  normalizeSeverity,
  normalizeDetection,
  selectPrimaryDetection,
  isEligible,
  evaluateDetections,
  photoSeveritySuggestion,
  pairSeveritySuggestion,
  evaluatePairResults
};
