const { enrollmentDocumentType, expiration } = require('../../../shared/identityDocumentPolicy');
const { deriveFormatCheckStatus } = require('../../domain/identity/identity.rules');
const { validateIdentityDto } = require('./identity.validation');

const REQUIRED_FACTS = ['documentType', 'idNumber', 'fullName', 'birthDate', 'address'];

function verifiedFacts(value, now) {
  const facts = validateIdentityDto(value || {}).value;
  if (!facts || REQUIRED_FACTS.some(field => !facts[field]) ||
      facts.birthDate > new Date(now).toISOString().slice(0, 10)) return null;
  const type = enrollmentDocumentType(facts.documentType);
  if (!type) return null;
  const formatMatches = type === 'DRIVERS_LICENSE'
    ? /^[A-Z]\d{2}[-\s]?\d{2}[-\s]?\d{6}$/i.test(facts.idNumber)
    : deriveFormatCheckStatus(type, facts.idNumber) === 'pass';
  if (!formatMatches) return null;
  const validity = expiration(facts.documentType, facts.expiryDate, { referenceDate: new Date(now) });
  if (validity.requiresDate && validity.status !== 'VALID') return null;
  return {
    ...facts,
    documentType: type,
    formatCheckStatus: 'pass',
    documentValidationStatus: 'pass',
    isExpired: validity.isExpired
  };
}

function normalizedValue(field, value) {
  if (field === 'idNumber') return value.replace(/[-\s]/g, '').toUpperCase();
  return value.normalize('NFC').toUpperCase().replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
}

function comparableFacts(facts) {
  return [...REQUIRED_FACTS, 'expiryDate'].map(field => normalizedValue(field, facts[field] || ''));
}

module.exports = { verifiedFacts, comparableFacts, normalizedValue };
