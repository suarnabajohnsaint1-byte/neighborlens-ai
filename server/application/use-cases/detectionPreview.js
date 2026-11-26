const { STATUS } = require('../../domain/reports/evidenceSuitability.rules');
const { validDetectionGeometry } = require('../../domain/reports/damageDetection.rules');
const { isCanonicalDamageCategory } = require('../../domain/reports/damageCategories');

const DETECTION_HINT = Symbol('detectionHint');
const PAVEMENT_CLASSES = new Set(['pothole', 'road_crack']);
const DIAGNOSTIC_CONFIDENCE_FLOOR = 0.05;
const PREVIEW_STATES = new Set([STATUS.REVIEW, 'NO_DETECTION', 'LOW_CONFIDENCE', 'UNSUPPORTED']);
const SCREENING_FAILURES = new Set(['FACE_OVERLAP', 'UNRELATED_SUBJECT_OVERLAP', 'EVIDENCE_SCREENING_UNAVAILABLE']);

function hasRegionScreening(payload) {
  return ['region-v1', 'region-v2'].includes(payload.evidence_screening);
}

function readDetectionHint(payload, primary, size, minConfidence) {
  if (!hasRegionScreening(payload) || payload.evidence_relevance !== 'UNAVAILABLE') return null;
  const hint = payload.detection_preview ?? (primary?.canonical_category ? {
    source: 'original', class: primary.canonical_category,
    confidence: primary.confidence_score, bounding_box: primary.bounding_box
  } : null);
  if (
      !['original', 'contrast'].includes(hint?.source) || !isCanonicalDamageCategory(hint.class) ||
      !Number.isFinite(hint.confidence) || hint.confidence < DIAGNOSTIC_CONFIDENCE_FLOOR || hint.confidence > 1 ||
      !size || !validDetectionGeometry({ bounding_box: hint.bounding_box }, size) ||
      !(hint.bounding_box?.width > 0 && hint.bounding_box?.height > 0)) return null;

  if (hint.source === 'original' && (primary?.canonical_category !== hint.class ||
      primary.confidence_score !== hint.confidence)) return null;
  if (hint.source === 'contrast' && (primary?.eligible ||
      !PAVEMENT_CLASSES.has(hint.class) || hint.confidence < minConfidence)) return null;
  return {
    ...hint,
    bounding_box: hint.source === 'original' ? primary.bounding_box : hint.bounding_box,
    size,
    eligible: hint.source === 'original' && primary.eligible,
    screenedForStreetlightLookalikes: payload.evidence_screening === 'region-v2'
  };
}

function matchingPreview(photos, hints) {
  if (hints.some(hint => !hint) || hints[0].class !== hints[1].class) return false;
  const uncertain = photos.filter(({ result }) => result.evidence_reason === 'PHOTO_SUITABILITY_UNCERTAIN');
  if (uncertain.length && (uncertain.length === photos.length || !hints.every(hint => hint.eligible))) return false;
  const category = hints[0].class;
  const streetlight = category === 'broken_streetlight';
  // Streetlight false positives can agree across views, even with eligible boxes.
  const modernStreetlightScreening = streetlight && hints.every(hint => hint.screenedForStreetlightLookalikes);
  const minAnchor = streetlight ? (modernStreetlightScreening ? 0.80 : 0.88)
    : PAVEMENT_CLASSES.has(category) ? 0.50 : 0.80;
  return hints.every(hint => hint.eligible && (!streetlight || (modernStreetlightScreening && hint.confidence >= 0.70))) ||
    (category === 'road_crack' && hints.every(hint => hint.source === 'contrast' && hint.scale_agreement === true)) ||
    hints.some(hint => hint.eligible && hint.confidence >= minAnchor);
}

function individualPreview(result, hint) {
  if (!hint?.eligible || result.evidence_reason === 'PHOTO_SUITABILITY_UNCERTAIN') return false;
  const minConfidence = PAVEMENT_CLASSES.has(hint.class) ||
    (hint.class === 'broken_streetlight' && hint.screenedForStreetlightLookalikes) ? 0.80 : 0.88;
  return hint.confidence >= minConfidence;
}

function addPairedDetectionPreview(photos) {
  if (photos.some(({ result }) => !PREVIEW_STATES.has(result.status) || SCREENING_FAILURES.has(result.evidence_reason))) return;
  const hints = photos.map(({ result }) => result[DETECTION_HINT]);
  const matched = matchingPreview(photos, hints);
  // A single box does not imply class agreement or select the report category.
  const single = !matched && (!hints[0] || !hints[1] || hints[0].class !== hints[1].class);

  photos.forEach(({ result }, index) => {
    const hint = hints[index];
    if (!matched && !(single && individualPreview(result, hint))) return;
    Object.assign(result, {
      suggested_class: hint.class,
      suggested_confidence: hint.confidence,
      suggested_eligible: false,
      ...(!matched ? { single_photo_preview: true } : {}),
      suggested_box: { confidence: hint.confidence, bounding_box: hint.bounding_box },
      image_size: hint.size
    });
  });
}

module.exports = { DETECTION_HINT, hasRegionScreening, readDetectionHint, addPairedDetectionPreview };
