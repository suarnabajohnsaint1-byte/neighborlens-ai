const config = require('./infrastructure/config/env');
const { getDatabase } = require('./infrastructure/database');
const { getImageStorage } = require('./infrastructure/storage/storageFactory');
const imageInput = require('./infrastructure/storage/imageInput.adapter');
const aiProvider = require('./infrastructure/ai');
const assessmentProof = require('./infrastructure/security/tokenProvider');
const reportRepository = require('./infrastructure/repositories/report.repository');
const barangayRepository = require('./infrastructure/repositories/barangay.repository');
const reportImageRepository = require('./infrastructure/repositories/reportImage.repository');
const reportStatusHistoryRepository = require('./infrastructure/repositories/reportStatusHistory.repository');
const reportAnalyticsRepository = require('./infrastructure/repositories/reportAnalytics.repository');
const { createReportAnalyticsService } = require('./application/use-cases/reportAnalytics.service');
const damageVerificationRepository = require('./infrastructure/repositories/damageVerification.repository');
const auditService = require('./application/use-cases/audit.service');
const { createReportService } = require('./application/use-cases/report.service');
const { createReportAttachmentService } = require('./application/use-cases/reportAttachment.service');
const localEvidence = require('./infrastructure/storage/localEvidence.adapter');
const reportClock = require('./infrastructure/database/reportClock');
const { createGeofenceService } = require('./application/use-cases/geofence.service');
const { createDamageDetectionService } = require('./application/use-cases/damageDetection.service');
const { createDamageUploadAssessment } = require('./application/use-cases/assessDamageUpload');

const userRepository = require('./infrastructure/repositories/user.repository');
const userPermissionRepository = require('./infrastructure/repositories/userPermission.repository');
const adminAccessRequestRepository = require('./infrastructure/repositories/adminAccessRequest.repository');
const passwordHasher = require('./infrastructure/security/passwordHasher');
const { createStreamTicketStore } = require('./infrastructure/security/streamTickets');
const { createAccountService } = require('./application/use-cases/account.service');
const notificationRepository = require('./infrastructure/repositories/notification.repository');
const reportReviewRepository = require('./infrastructure/repositories/reportReview.repository');
const notificationEvents = require('./infrastructure/events/notificationEvents');
const { createNotificationService } = require('./application/use-cases/notification.service');
const { createAuthService } = require('./application/use-cases/auth.service');
const { createCitizenIdentityService } = require('./application/use-cases/citizenIdentity.service');
const { createCitizenEnrollment } = require('./application/use-cases/citizenEnrollment.service');
const { anyKeyUsed, recordKeys, isVerifiedEnrollment, verifiedDocumentUsed } = require('./infrastructure/repositories/citizenEnrollment.repository');
const enrollmentReviews = require('./infrastructure/repositories/citizenEnrollmentReview.repository');
const { createCitizenEnrollmentReview } = require('./application/use-cases/citizenEnrollmentReview.service');
const citizenIdentityRepository = require('./infrastructure/repositories/citizenIdentity.repository');
const { createRegistrationVerifier, createFraudAssessmentClient, verificationUnavailable, normalizeFrame, createKnownReplayCheck } = require('./infrastructure/adapters/registrationVerifier');
const { createCaptureOcr } = require('./infrastructure/adapters/registrationCaptureOcr');
const registrationFraud = require('./infrastructure/config/registrationFraud');
const { loadBacolodBoundary } = require('./infrastructure/adapters/bacolodBoundary');
const geofenceService = createGeofenceService({ config, barangayRepository, loadBoundary: loadBacolodBoundary });

const registrationVerifier = createRegistrationVerifier({
  endpoint: registrationFraud.disabled ? null : process.env.REGISTRATION_VERIFIER_URL,
  secret: registrationFraud.disabled ? null : process.env.REGISTRATION_VERIFIER_SECRET
});
const fraudScreeningRequired = !registrationFraud.disabled && (
  config.NODE_ENV === 'production' || registrationFraud.explicitlyEnabled ||
  process.env.REGISTRATION_FRAUD_URL || !registrationVerifier.available
);
const citizenEnrollmentReview = createCitizenEnrollmentReview({
  repository: enrollmentReviews, audit: auditService.writeAudit.bind(auditService),
  fingerprintKey: process.env.REGISTRATION_FINGERPRINT_KEY,
  reviewerIds: process.env.REGISTRATION_REVIEWER_IDS, keyUsed: anyKeyUsed, documentUsed: verifiedDocumentUsed
});
const citizenEnrollment = createCitizenEnrollment({
  loadBoundary: async () => {
    const { city, version, barangays } = await loadBacolodBoundary();
    return { ...city, boundaryVersion: version, barangayNames: barangays.features.map(feature => feature.properties.name) };
  },
  resolveJurisdiction: position => geofenceService.resolveJurisdiction({
    latitude: position.latitude, longitude: position.longitude, gpsAccuracy: position.accuracy, requireCityPolygon: true
  }),
  findBarangayByName: name => barangayRepository.findByName(name),
  verifier: registrationVerifier,
  fraudAssessor: fraudScreeningRequired ? createFraudAssessmentClient({
    endpoint: process.env.REGISTRATION_FRAUD_URL,
    secret: process.env.REGISTRATION_FRAUD_SECRET,
    verifierSecret: process.env.REGISTRATION_VERIFIER_SECRET
  }) : null,
  captureOcr: registrationFraud.disabled ? createCaptureOcr({
    endpoint: `http://127.0.0.1:${registrationFraud.identityPort}/ocr-capture`,
    secret: process.env.REGISTRATION_FRAUD_SECRET
  }) : null,
  normalizeFrame, verificationUnavailable,
  knownReplay: createKnownReplayCheck(process.env.REGISTRATION_KNOWN_REPLAY_SHA256_FILE),
  allowOutsideScan: registrationFraud.allowOutsideScan,
  allowOutsideEnrollment: registrationFraud.allowOutsideEnrollment,
  basicRegistrationEnabled: registrationFraud.basicEnabled,
  fingerprintKey: process.env.REGISTRATION_FINGERPRINT_KEY,
  keyUsed: anyKeyUsed, documentUsed: verifiedDocumentUsed
});
const authService = createAuthService({
  citizenEnrollment, getDatabase, citizenIdentityRepository, recordKeys, documentUsed: verifiedDocumentUsed,
  consumeReview: enrollmentReviews.consume
});
const citizenIdentityService = createCitizenIdentityService({ isVerifiedEnrollment });

const notificationService = createNotificationService({ notificationRepository, notificationEvents });
const damageDetectionService = createDamageDetectionService({ aiProvider, imageInput, assessmentProof, severityPolicy: config.REPORT_SEVERITY_POLICY });
const assessDamageUpload = createDamageUploadAssessment({ aiProvider, damageDetectionService });
const communityPublicationService = require('./application/use-cases/communityPublication.service').createCommunityPublicationService({
  getDatabase,
  barangays: barangayRepository,
  reportImages: reportImageRepository,
  reportClock,
  incidents: require('./infrastructure/repositories/incident.repository'),
  assignJurisdiction: (user, id, input) => incidentService.assign(id, user, input),
  repository: require('./infrastructure/repositories/communityPublication.repository'),
  community: require('./infrastructure/repositories/community.repository'),
  media: require('./infrastructure/storage/communityMedia.adapter'),
  audit: auditService,
  notifications: notificationService,
  events: notificationEvents
});
const reportService = createReportService({
  config,
  getDatabase,
  getImageStorage,
  imageInput,
  reportRepository,
  barangayRepository,
  reportImageRepository,
  reportStatusHistoryRepository,
  damageVerificationRepository,
  auditService,
  geofenceService,
  damageDetectionService,
  assessmentProof,
  notificationService,
  publicationService: communityPublicationService,
  reportReviewRepository,
  reportClock
});

const accountService = createAccountService({
  getDatabase,
  userRepository,
  userPermissionRepository,
  adminAccessRequestRepository,
  barangayRepository,
  passwordHasher,
  tokenProvider: assessmentProof,
  auditService,
  sessionEvents: notificationEvents
});
const reportAttachmentService = createReportAttachmentService({ reportService, reportImageRepository, reportStatusHistoryRepository, localEvidence, getImageStorage });
const reportReviewService = require('./application/use-cases/reportReview.service').createReportReviewService({
  community: require('./infrastructure/repositories/community.repository'),
  incidents: require('./infrastructure/repositories/incident.repository'),
  getDatabase, reportService, reports: reportRepository, repository: reportReviewRepository,
  audit: auditService, notifications: notificationRepository, events: notificationEvents, clock: reportClock,
  policy: config.REPORT_SEVERITY_POLICY
});
const incidentService = require('./application/use-cases/incident.service').createIncidentService({
  getDatabase, repository: require('./infrastructure/repositories/incident.repository'), reports: reportRepository, reportService, permissions: userPermissionRepository, barangays: barangayRepository, geofence: geofenceService, images: reportImageRepository, community: require('./infrastructure/repositories/community.repository'), notifications: notificationRepository, events: notificationEvents, audit: auditService
});
const streamTickets = createStreamTicketStore();
const reportAnalyticsService = createReportAnalyticsService({ reportAnalyticsRepository });
const barangayOperationsService = require('./application/use-cases/barangayOperations.service').createBarangayOperationsService({
  repository: require('./infrastructure/repositories/barangayOperations.repository'), clock: reportClock, getDatabase
});
const reportGisService = require('./application/use-cases/reportGis.service').createReportGisService({
  repository: require('./infrastructure/repositories/reportGis.repository'), clock: reportClock, getDatabase
});
const { createCommunityService } = require('./application/use-cases/community.service');
const communityService = createCommunityService({
  publications: communityPublicationService,
  incidents: require('./infrastructure/repositories/incident.repository'),
  reportClock,
  persona: require('./infrastructure/security/communityPersona'),
  getDatabase,
  repository: require('./infrastructure/repositories/community.repository'),
  citizenIdentities: require('./infrastructure/repositories/citizenIdentity.repository'),
  barangays: barangayRepository,
  reports: reportRepository,
  reportImages: reportImageRepository,
  localEvidence,
  getImageStorage,
  media: require('./infrastructure/storage/communityMedia.adapter'),
  audit: auditService,
  events: notificationEvents
});

module.exports = {
  authService,
  citizenIdentityService,
  citizenEnrollment,
  citizenEnrollmentReview,
  assessDamageUpload,
  reportExportService: require('./application/use-cases/reportExport.service').createReportExportService({ repository: require('./infrastructure/repositories/reportExport.repository'), workbook: require('./infrastructure/export/reportWorkbook'), audit: auditService }),
  reportGisService,
  reportService,
  reportReviewService,
  incidentService,
  reportAttachmentService,
  geofenceService,
  damageDetectionService,
  notificationService,
  accountService,
  streamTickets,
  reportAnalyticsService,
  barangayOperationsService,
  communityService,
  communityPublicationService
};

