const STATUSES = Object.freeze(new Set(['pending', 'ongoing', 'resolved', 'rejected']));
const PRIORITIES = Object.freeze(new Set(['Critical', 'High', 'Medium', 'Low']));
const CLASSIFICATIONS = Object.freeze(new Set(['MAJOR', 'MINOR']));

const REQUIRED_IMAGE_COUNT = 2;

function normalizeStatus(status) {
  return STATUSES.has(status) ? status : null;
}

const { transitions: ALLOWED_TRANSITIONS } = require('../../../shared/reportVocabulary');

function isTerminalStatus(status) {
  return ALLOWED_TRANSITIONS[status]?.length === 0;
}

function canTransition(currentStatus, nextStatus) {
  return (ALLOWED_TRANSITIONS[currentStatus] || []).includes(nextStatus);
}

function checkStatusTransition(currentStatus, nextStatus) {
  if (!STATUSES.has(nextStatus)) return { allowed: false, reason: 'UNKNOWN_STATUS' };
  if (currentStatus === nextStatus) return { allowed: false, reason: 'SAME_STATUS' };
  if (isTerminalStatus(currentStatus)) return { allowed: false, reason: 'TERMINAL' };
  if (!canTransition(currentStatus, nextStatus)) return { allowed: false, reason: 'NOT_ALLOWED' };
  return { allowed: true, reason: null };
}

function hasRequiredImageCount(count) {
  return count === REQUIRED_IMAGE_COUNT;
}

function isWithinJurisdiction(report, user) {
  const assigned = Number(user.barangayId);
  return Number.isSafeInteger(assigned) && assigned > 0 && Number(report.barangay_id) === assigned;
}

const MAX_STATUS_NOTE_LENGTH = 500;

function normalizeStatusNote(note) {
  if (note === undefined || note === null) return { value: null };
  if (typeof note !== 'string') return { error: 'Status note must be text.' };
  const value = note.trim();
  if (value.length > MAX_STATUS_NOTE_LENGTH) {
    return { error: `Status note must be at most ${MAX_STATUS_NOTE_LENGTH} characters.` };
  }
  return { value: value || null };
}

function validateActionProof(status, note, fileCount) {
  if (!Number.isInteger(fileCount) || fileCount < 0 || fileCount > 5) return 'Attach at most five action photos.';
  if (status === 'rejected' && (!note || note.trim().length < 10 || !/[\p{L}\p{N}]/u.test(note))) return 'Provide a rejection reason of at least 10 characters.';
  if (status === 'resolved' && !note) return 'Describe the completed action before resolving this report.';
  if (status === 'resolved' && fileCount === 0) return 'Attach at least one completion photo before resolving this report.';
  if (fileCount && !['ongoing', 'resolved'].includes(status)) return 'Action photos are supported for ongoing and resolved updates.';
  return null;
}

function authorizeReportAccess(report, user) {
  if (user.role === 'citizen' && Number(report.submitted_by) !== Number(user.id)) {
    return { allowed: false, reason: 'NOT_OWNER' };
  }
  if (user.role === 'barangay' && !isWithinJurisdiction(report, user)) {
    return { allowed: false, reason: 'OUTSIDE_JURISDICTION' };
  }
  return { allowed: true, reason: null };
}

function jurisdictionSourceFor(resolvedBarangayId) {
  return resolvedBarangayId ? 'geofence_resolved' : 'citizen_declared';
}

const TRIAGE_BY_SEVERITY = Object.freeze({
  critical: { aiClassification: 'MAJOR', aiPriority: 'Critical' },
  high: { aiClassification: 'MAJOR', aiPriority: 'High' },
  medium: { aiClassification: 'MINOR', aiPriority: 'Medium' },
  low: { aiClassification: 'MINOR', aiPriority: 'Low' }
});

function triageForSeverity(severityLevel) {
  const severity = String(severityLevel ?? '').trim().toLowerCase();

  return Object.hasOwn(TRIAGE_BY_SEVERITY, severity) ? TRIAGE_BY_SEVERITY[severity] : {
    aiClassification: null,
    aiPriority: null
  };
}

function summarizeStatuses(reports) {
  return {
    total: reports.length,
    pending: reports.filter(report => report.status === 'pending').length,
    ongoing: reports.filter(report => report.status === 'ongoing').length,
    resolved: reports.filter(report => report.status === 'resolved').length,
    rejected: reports.filter(report => report.status === 'rejected').length
  };
}

module.exports = {
  STATUSES,
  ALLOWED_TRANSITIONS,
  isTerminalStatus,
  canTransition,
  checkStatusTransition,
  PRIORITIES,
  CLASSIFICATIONS,
  REQUIRED_IMAGE_COUNT,
  TRIAGE_BY_SEVERITY,
  normalizeStatus,
  hasRequiredImageCount,
  authorizeReportAccess,
  isWithinJurisdiction,
  MAX_STATUS_NOTE_LENGTH,
  normalizeStatusNote,
  validateActionProof,
  jurisdictionSourceFor,
  triageForSeverity,
  summarizeStatuses
};
