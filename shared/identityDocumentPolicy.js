(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IdentityDocumentPolicy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATE_REQUIRED = new Set(['DRIVERS_LICENSE', 'PASSPORT']);
  const NO_DATE_EXPECTED = new Set(['PHILSYS', 'NATIONAL_ID', 'UMID', 'SSS']);
  const DOCUMENT_ALIASES = Object.freeze({
    DRIVER_LICENSE: 'DRIVERS_LICENSE',
    LTO_DRIVER_LICENSE: 'DRIVERS_LICENSE',
    LTO_DRIVERS_LICENSE: 'DRIVERS_LICENSE',
    PHILIPPINE_NATIONAL_ID: 'PHILSYS',
    PHILSYS_NATIONAL_ID: 'PHILSYS',
    PHILIPPINE_IDENTIFICATION_CARD: 'PHILSYS',
    PHILIPPINE_PASSPORT: 'PASSPORT',
    SSS_ID: 'SSS',
    PRC: 'PRC_ID'
  });

  function documentType(value) {
    if (typeof value !== 'string') return '';
    const type = value.trim().toUpperCase().replace(/['’]/g, '').replace(/[\s-]+/g, '_');
    return Object.hasOwn(DOCUMENT_ALIASES, type) ? DOCUMENT_ALIASES[type] : type;
  }

  function expiryRequirement(type) {
    const code = documentType(type);
    if (DATE_REQUIRED.has(code)) return 'required';
    if (NO_DATE_EXPECTED.has(code)) return 'not_applicable';
    return 'optional';
  }

  function enrollmentDocumentType(value) {
    const type = documentType(value);
    if (type === 'PHILSYS' || type === 'NATIONAL_ID') return 'PHILSYS';
    return type === 'DRIVERS_LICENSE' ? type : null;
  }

  function isoCalendarDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
    if (typeof value !== 'string') return null;
    const slash = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const iso = slash ? `${slash[3]}-${slash[1]}-${slash[2]}` : value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
  }

  function expiration(type, value, { referenceDate = new Date(), expiryDatePresent = false } = {}) {
    const requirement = expiryRequirement(type);
    if (value == null || value === '') {
      const status = expiryDatePresent ? 'REVIEW_REQUIRED' : requirement === 'not_applicable' ? 'NOT_APPLICABLE' : 'UNKNOWN';
      return { status, isExpired: null, requiresDate: requirement === 'required' || expiryDatePresent };
    }
    const iso = isoCalendarDate(value);
    const today = isoCalendarDate(referenceDate);
    if (!iso || !today) return { status: 'REVIEW_REQUIRED', isExpired: null, requiresDate: true };
    const isExpired = iso < today;
    return { status: isExpired ? 'EXPIRED' : 'VALID', isExpired, requiresDate: true };
  }

  return Object.freeze({ documentType, enrollmentDocumentType, expiryRequirement, expiration });
});
