const { createHash } = require('node:crypto');
const { STATUS, suitability, compareViews, rejectEvidence } = require('../../domain/reports/evidenceSuitability.rules');

async function inspectEvidence(images, imageInput) {
  const hashes = images.map(image => createHash('sha256').update(image.buffer).digest('hex'));
  if (new Set(hashes).size !== hashes.length) rejectEvidence(STATUS.DUPLICATE);

  const fingerprints = await Promise.all(images.map(image => imageInput.evidenceFingerprint(image)));
  const photoStatuses = fingerprints.map(suitability);
  const invalidIndex = photoStatuses.indexOf(STATUS.INVALID);
  if (invalidIndex !== -1) {
    const oneInvalidInPair = photoStatuses.length === 2 && photoStatuses[1 - invalidIndex] !== STATUS.INVALID;
    rejectEvidence(STATUS.INVALID, oneInvalidInPair ? invalidIndex + 1 : null);
  }
  const pairStatus = fingerprints.length === 2 ? compareViews(...fingerprints) : STATUS.PASSED;
  if (pairStatus === STATUS.DUPLICATE) rejectEvidence(STATUS.DUPLICATE);

  const photoReasons = photoStatuses.map(status => status === STATUS.REVIEW ? 'PHOTO_SUITABILITY_UNCERTAIN' : null);
  const pairReason = pairStatus === STATUS.REVIEW ? 'SIMILAR_VIEWS' : null;
  return { hashes, photoReasons, pairReason, reviewRequired: Boolean(pairReason || photoReasons.some(Boolean)) };
}

function reviewAssessment() {
  return { status: STATUS.REVIEW, detected: false, confidence: null, candidate: null, detections: [] };
}

module.exports = { inspectEvidence, reviewAssessment };
