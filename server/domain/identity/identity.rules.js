const { documentType: normalizeDocumentType, expiration } = require('../../../shared/identityDocumentPolicy');

// "pass" indicates ONLY that the implemented document format and expiry checks
// succeeded. It does NOT represent government authenticity verification.

const RECOGNIZED_DOC_TYPES = Object.freeze(new Set([
  'PHILSYS',
  'NATIONAL_ID',
  'DRIVERS_LICENSE',
  'PASSPORT',
  'UMID',
  'SSS',
  'PHILHEALTH',
  'PRC_ID',
  'POSTAL_ID',
  'VOTERS_ID',
  'SENIOR_CITIZEN',
  'PWD'
]));

const PHILSYS_REGEX = /^\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}$/;
const PHILHEALTH_REGEX = /^\d{2}[-\s]?\d{9}[-\s]?\d$/;

function deriveIsExpired(expiryDate, referenceDate = new Date()) {
  return expiration(null, expiryDate, { referenceDate }).isExpired;
}

function deriveFormatCheckStatus(documentType, idNumber) {
  if (idNumber === null || idNumber === undefined || typeof idNumber !== 'string' || idNumber.trim() === '') {
    return 'unknown';
  }

  const trimmedId = idNumber.trim();

  if (documentType === null || documentType === undefined || typeof documentType !== 'string') {
    return 'unknown';
  }

  const normalizedType = normalizeDocumentType(documentType);
  if (!normalizedType || normalizedType === 'UNKNOWN' || !RECOGNIZED_DOC_TYPES.has(normalizedType)) {
    return 'unknown';
  }

  if (normalizedType === 'PHILSYS' || normalizedType === 'NATIONAL_ID') {
    return PHILSYS_REGEX.test(trimmedId) ? 'pass' : 'fail';
  }

  if (normalizedType === 'PHILHEALTH') {
    return PHILHEALTH_REGEX.test(trimmedId) ? 'pass' : 'fail';
  }

  if (normalizedType === 'UMID' && !/^\d{4}[-\s]?\d{7}[-\s]?\d$/.test(trimmedId)) return 'fail';
  if (normalizedType === 'SSS' && !/^\d{2}[-\s]?\d{7}[-\s]?\d$/.test(trimmedId)) return 'fail';
  return 'needs_review';
}

function deriveDocumentValidationStatus({
  documentType,
  idNumber,
  fullName,
  birthDate,
  address,
  formatCheckStatus,
  expiryDate,
  isExpired
}) {
  const normalizedDocumentType = normalizeDocumentType(documentType);
  const hasRequiredFields =
    Boolean(normalizedDocumentType) &&
    normalizedDocumentType !== 'UNKNOWN' &&
    Boolean(idNumber) &&
    Boolean(fullName) &&
    Boolean(birthDate) &&
    Boolean(address);

  if (!hasRequiredFields) {
    return 'needs_review';
  }

  const validity = expiration(documentType, expiryDate);
  if (isExpired === true || validity.isExpired === true) {
    return 'fail';
  }

  if (formatCheckStatus === 'fail') {
    return 'fail';
  }
  if (validity.requiresDate && validity.status !== 'VALID') {
    return 'needs_review';
  }

  if (formatCheckStatus === 'pass') {
    return 'pass';
  }

  return 'needs_review';
}

module.exports = {
  RECOGNIZED_DOC_TYPES,
  PHILSYS_REGEX,
  PHILHEALTH_REGEX,
  deriveIsExpired,
  deriveFormatCheckStatus,
  deriveDocumentValidationStatus
};
