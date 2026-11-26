const { expiration } = require('../../../shared/identityDocumentPolicy');
const { validateIdentityDto } = require('./identity.validation');
const citizenIdentityRepository = require('../../infrastructure/repositories/citizenIdentity.repository');
const auditService = require('./audit.service');
const { ForbiddenError, ValidationError } = require('../../domain/errors');
const {
  deriveIsExpired,
  deriveFormatCheckStatus,
  deriveDocumentValidationStatus
} = require('../../domain/identity/identity.rules');

function toDto(record) {
  if (!record) return null;
  const validity = expiration(record.document_type, record.expiry_date);
  return {
    documentType: record.document_type,
    idNumber: record.id_number,
    fullName: record.full_name,
    birthDate: record.birth_date,
    address: record.address,
    expiryDate: record.expiry_date,
    ocrConfidence: record.ocr_confidence === null ? null : Number(record.ocr_confidence),
    formatCheckStatus: record.format_check_status,
    documentValidationStatus: record.document_validation_status,
    expirationStatus: validity.status,
    isExpired: validity.isExpired,
    updatedAt: record.updated_at
  };
}

class CitizenIdentityService {
  constructor({ isVerifiedEnrollment }) {
    this.isVerifiedEnrollment = isVerifiedEnrollment;
  }

  deriveIsExpired(expiryDate, referenceDate = new Date()) {
    return deriveIsExpired(expiryDate, referenceDate);
  }

  deriveFormatCheckStatus(documentType, idNumber) {
    return deriveFormatCheckStatus(documentType, idNumber);
  }

  deriveDocumentValidationStatus(input) {
    return deriveDocumentValidationStatus(input);
  }

  async saveOwnIdentity(userId, dto) {
    if (await this.isVerifiedEnrollment(userId)) {
      throw new ForbiddenError('Verified identity details require a new identity review to change.');
    }
    const parsed = validateIdentityDto(dto);
    if (parsed.error) throw new ValidationError(parsed.error);

    const facts = parsed.value;
    const isExpired = expiration(facts.documentType, facts.expiryDate).isExpired;
    const formatCheckStatus = this.deriveFormatCheckStatus(facts.documentType, facts.idNumber);
    const documentValidationStatus = this.deriveDocumentValidationStatus({
      ...facts,
      formatCheckStatus,
      isExpired
    });

    const saved = await citizenIdentityRepository.upsert({
      userId,
      ...facts,
      formatCheckStatus,
      documentValidationStatus,
      isExpired
    });

    await auditService.writeAudit(userId, 'save', 'citizen_identity', userId);
    return toDto(saved);
  }

  async getOwnIdentity(userId) {
    return toDto(await citizenIdentityRepository.findByUserId(userId));
  }
}

module.exports.createCitizenIdentityService = dependencies => new CitizenIdentityService(dependencies);
