const { isAiReportCategory, isCanonicalDamageCategory, reportCategoryFor, displayLabelFor } = require('./damageCategories');
const { ValidationError } = require('../errors');
const { isDeepStrictEqual } = require('node:util');
const { evaluatePairResults, DETECTION_OUTCOMES } = require('./damageDetection.rules');
const { STATUS } = require('./evidenceSuitability.rules');

const PHOTO_STATUSES = Object.freeze(['DETECTED', 'LOW_CONFIDENCE', 'NO_DETECTION', 'UNSUPPORTED', 'AI_UNAVAILABLE', STATUS.REVIEW]);

function photoSnapshot(result) {
  if (!PHOTO_STATUSES.includes(result?.status)) throw new ValidationError('Invalid assessment status.');
  const candidate = result.candidate;
  return {
    status: result.status,
    detected: result.status === 'DETECTED' && result.detected === true,
    canonical_class: result.status === 'DETECTED' ? result.canonical_category : null,
    candidate: candidate ? {
      canonical_class: candidate.canonical_category,
      display_name: displayLabelFor(candidate.canonical_category),
      confidence: candidate.confidence,
      accepted: candidate.accepted === true
    } : null,
    confidence: result.confidence ?? null,
    suggested_category: reportCategoryFor(candidate?.canonical_category),
    model: result.model || null,
    detections: (result.detections || []).map(item => ({
      canonical_class: item.canonical_category || null,
      reported_class: item.damage_type || null,
      confidence: item.confidence_score ?? null,
      eligible: item.eligible === true
    }))
  };
}

function validConfidence(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function validPhoto(photo) {
  if (!photo || !PHOTO_STATUSES.includes(photo.status) || typeof photo.detected !== 'boolean') return false;
  if (!validConfidence(photo.confidence) || !Array.isArray(photo.detections)) return false;
  if (photo.model !== null && typeof photo.model !== 'string') return false;
  if (photo.canonical_class !== null && !isCanonicalDamageCategory(photo.canonical_class)) return false;
  const candidate = photo.candidate;
  if (candidate && (
    !isCanonicalDamageCategory(candidate.canonical_class) ||
    !validConfidence(candidate.confidence) ||
    typeof candidate.accepted !== 'boolean'
  )) return false;
  if (photo.suggested_category !== reportCategoryFor(candidate?.canonical_class)) return false;
  if (photo.detected !== (photo.status === 'DETECTED')) return false;
  if (photo.detected && (!candidate?.accepted || photo.canonical_class !== candidate.canonical_class)) return false;
  if (!photo.detected && (photo.canonical_class !== null || candidate?.accepted)) return false;
  if (['AI_UNAVAILABLE', 'NO_DETECTION', 'UNSUPPORTED', STATUS.REVIEW].includes(photo.status) && candidate) return false;
  if (['AI_UNAVAILABLE', STATUS.REVIEW].includes(photo.status) && (photo.confidence !== null || photo.detections.length)) return false;
  return photo.detections.every(item =>
    validConfidence(item.confidence) && typeof item.eligible === 'boolean' &&
    (item.canonical_class === null || isCanonicalDamageCategory(item.canonical_class)) &&
    (item.reported_class === null || typeof item.reported_class === 'string')
  );
}

function originalAssessment(photos) {
  if (!Array.isArray(photos) || photos.length !== 2 || !photos.every(validPhoto)) throw new ValidationError('Malformed original assessment.');
  photos = photos.map(photo => ({
    status: photo.status, detected: photo.detected, canonical_class: photo.canonical_class,
    candidate: photo.candidate ? {
      canonical_class: photo.candidate.canonical_class,
      display_name: displayLabelFor(photo.candidate.canonical_class),
      confidence: photo.candidate.confidence,
      accepted: photo.candidate.accepted
    } : null,
    confidence: photo.confidence, suggested_category: photo.suggested_category, model: photo.model,
    detections: photo.detections.map(item => ({
      canonical_class: item.canonical_class, reported_class: item.reported_class,
      confidence: item.confidence, eligible: item.eligible
    }))
  }));
  const unavailable = photos.some(photo => photo.status === 'AI_UNAVAILABLE');
  const reviewRequired = photos.some(photo => photo.status === STATUS.REVIEW);
  const pair = evaluatePairResults(photos.map(photo => ({
    detected: photo.detected,
    candidate: photo.candidate ? {
      canonical_category: photo.candidate.canonical_class,
      confidence: photo.candidate.confidence,
      accepted: photo.candidate.accepted
    } : null,
    confidence_score: photo.confidence,
    reason: photo.status === 'UNSUPPORTED' ? DETECTION_OUTCOMES.UNSUPPORTED_CLASS : null,
    triage: null,
    detections: []
  })));
  const status = reviewRequired ? STATUS.REVIEW : unavailable ? 'AI_UNAVAILABLE'
    : pair.status === 'NO_DETECTION' && photos.some(photo => photo.status === 'LOW_CONFIDENCE') ? 'LOW_CONFIDENCE'
      : pair.status;
  const candidateClass = unavailable || reviewRequired ? null : pair.canonicalClass;
  const confidence = candidateClass && photos.every(photo => photo.candidate.confidence !== null)
    ? pair.confidence : null;
  return {
    status,
    detected: status === 'DETECTED',
    canonical_class: status === 'DETECTED' ? candidateClass : null,
    candidate: candidateClass ? { canonical_class: candidateClass, confidence, accepted: status === 'DETECTED' } : null,
    confidence,
    suggested_category: reportCategoryFor(candidateClass),
    class_agreement: !unavailable && !reviewRequired && pair.sameClass,
    same_report_category: pair.sameReportCategory,
    shared_report_category: pair.sharedReportCategory,
    photos
  };
}

function validateSubmissionAssessment(value) {
  if (value === null || value === undefined) return;
  const fail = () => { throw new ValidationError('Malformed submission assessment.'); };
  if (value.schema_version === 2) {
    const manualEvidence = value.evidence_status === STATUS.REVIEW && value.citizen_category === null;
    const measuredSeverity = value.citizen_category === null && value.severity_suggestion?.source === 'approved_measurement_rule';
    const observed = value.citizen_category === null && Array.isArray(value.visual_extents) &&
      value.visual_extents.length === 2 && value.visual_extents.some(item => item?.source === 'opencv_visual_extent');
    if ((!manualEvidence && !measuredSeverity && !observed && !isAiReportCategory(value.citizen_category)) || value.original_ai !== null || value.evidence !== null) fail();
    return;
  }
  if (value.schema_version !== 1 || (value.citizen_category !== null && !isAiReportCategory(value.citizen_category))) fail();
  const evidence = value.evidence;
  if (!evidence || typeof evidence.citizen_id !== 'string' || !/^\d+$/.test(evidence.citizen_id) || !Array.isArray(evidence.photos) || evidence.photos.length !== 2) fail();
  if (!evidence.photos.every((photo, index) =>
    photo.order === index + 1 && /^[a-f0-9]{64}$/.test(photo.sha256) &&
    typeof photo.proof_id === 'string' && photo.proof_id.length > 0 && Number.isInteger(photo.issued_at)
  )) fail();
  if (evidence.photos[0].proof_id === evidence.photos[1].proof_id) fail();
  const original = originalAssessment(value.original_ai?.photos);
  if (!isDeepStrictEqual(original, value.original_ai)) fail();
}

module.exports = { photoSnapshot, originalAssessment, validateSubmissionAssessment };
