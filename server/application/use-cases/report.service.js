const { validateReport, validateImageCount, validateLandmark, validateStatus } = require('./report.validation');
const { randomUUID, createHash } = require('node:crypto');
const { originalAssessment, photoSnapshot, validateSubmissionAssessment } = require('../../domain/reports/submissionAssessment.rules');
const { pairSeveritySuggestion } = require('../../domain/reports/damageDetection.rules');
const { STATUS } = require('../../domain/reports/evidenceSuitability.rules');
const { inspectEvidence, reviewAssessment } = require('./reportEvidence');
const { attachmentUrl } = require('./reportAttachment.service');
const { reportQuery } = require('../../domain/reports/reportQuery.rules');
const {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  PersistenceError
} = require('../../domain/errors');
const { BoundaryCheckStatus, GpsAccuracyStatus, JurisdictionStatus, isFreshGpsFix } = require('../../domain/geofencing/geofence.rules');
const {
  authorizeReportAccess,
  checkStatusTransition,
  normalizeStatusNote,
  validateActionProof,
  jurisdictionSourceFor,
  summarizeStatuses
} = require('../../domain/reports/report.rules');

const ACCESS_MESSAGE = Object.freeze({
  NOT_OWNER: 'You may only view your own reports.',
  OUTSIDE_JURISDICTION: 'Report is outside your barangay.'
});

const TRANSITION_MESSAGE = Object.freeze({
  UNKNOWN_STATUS: 'Invalid report status.',
  SAME_STATUS: 'Report is already in that status.',
  TERMINAL: 'Report is already closed and cannot change status.',
  NOT_ALLOWED: 'That status change is not allowed from the current status.'
});

const AI_NOT_EVALUATED = Object.freeze({
  aiCategory: null,
  aiClassification: null,
  aiPriority: null,
  aiConfidence: null,
  visionDetected: false
});

function createReportService({
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
  publicationService,
  reportReviewRepository,
  reportClock
}) {
  const IMAGE_EXTENSIONS = Object.freeze({
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  });

  function createImageKey(userId, file) {
    if (
      userId === undefined ||
      userId === null ||
      String(userId).trim() === '' ||
      !/^[a-zA-Z0-9_-]+$/.test(String(userId))
    ) {
      throw new ValidationError('Invalid user ID.');
    }

    const mimeType = file?.mimetype || file?.mimeType;
    const extension = IMAGE_EXTENSIONS[mimeType];

    if (!extension) {
      throw new ValidationError('Unsupported image type.');
    }

    return `reports/${userId}/${randomUUID()}${extension}`;
  }

  async function cleanupStoredImages(uploadedRefs = []) {
    if (!Array.isArray(uploadedRefs) || !uploadedRefs.length) return;
    const storage = getImageStorage();

    for (const ref of uploadedRefs) {
      try {
        if (typeof ref === 'string' && ref.startsWith('supabase:')) {
          await storage.remove(ref);
        }
      } catch (error) {
        console.error(`Failed to cleanup stored image reference: ${error?.message || error}`);
      }
    }
  }

  async function storeReportsImage(files, userId, uploadedRefs = []) {
    const storage = getImageStorage();
    const stored = [];

    for (const file of files) {
      const key = createImageKey(userId, file);
      const result = await storage.upload(file, key);

      stored.push({
        imagePath: result.reference,
        fileSize: file.size,
        mimeType: file.mimetype || file.mimeType
      });
      uploadedRefs.push(result.reference);
    }

    return stored;
  }

  async function resolveImageUrl(reference) {
    if (!reference) return null;

    if (typeof reference === 'string' && reference.startsWith('supabase:')) {
      return getImageStorage().getReadUrl(reference);
    }

    return reference;
  }

  async function toImageDto(row, reportId, privateEvidence = false) {
    const reference = row.image_path || row.imagePath;
    const imageUrl = privateEvidence || reference?.startsWith('/uploads/') ? attachmentUrl(reportId, row) : await resolveImageUrl(reference);
    return {
      id: row.id,
      imageOrder: row.image_order ?? row.imageOrder,
      imagePath: imageUrl,
      fileSize: row.file_size ?? row.fileSize,
      mimeType: row.mime_type ?? row.mimeType
    };
  }

  async function withImages(report, imageRows = [], { offset, privateEvidence = false } = {}) {
    if (!report) return report;

    const rows = imageRows?.length ? imageRows : String(report.image_path || '').split(',').filter(Boolean)
      .map((image_path, index) => ({ image_path, image_order: index + 1 }));
    const images = await Promise.all(rows.map(row => toImageDto(row, report.id, privateEvidence)));

    const timeOffset = offset ?? await reportClock?.offsetMinutes(getDatabase()) ?? 0;
    const result = { ...toReportDto(report, timeOffset), images };

    const resolvedPaths = images
      .map((image) => image.imagePath)
      .filter(Boolean)
      .join(',');

    if ('image_path' in result) {
      result.image_path = resolvedPaths;
    }

    if ('imagePath' in result) {
      result.imagePath = resolvedPaths;
    }

    const landmarkRef = report.landmark_image_path || result.landmark_image_path;
    if (landmarkRef) {
      result.landmark = {
        description: report.landmark_description || result.landmark_description || null,
        imagePath: `/api/reports/${report.id}/images/landmark`
      };
    } else {
      result.landmark = null;
    }

    delete result.landmark_image_path;
    delete result.landmark_description;

    return result;
  }

  function toReportDto(report, offset = 0) {
    const fields = ['id', 'description', 'location', 'barangay', 'barangay_id', 'jurisdiction_source',
      'boundary_check_status', 'latitude', 'longitude', 'gps_accuracy', 'image_path', 'ai_category',
      'ai_classification', 'ai_priority', 'ai_confidence', 'vision_detected', 'status', 'submitted_by',
      'created_at', 'updated_at', 'submitted_by_username',
      'landmark_description', 'landmark_image_path'];
    const result = selectFields(report, fields);
    for (const field of ['created_at', 'updated_at']) if (result[field] && reportClock) result[field] = reportClock.utc(result[field], offset);
    const snapshot = report.submission_assessment;
    result.citizenCategory = snapshot?.citizen_category ?? null;
    result.originalAi = originalAiDto(snapshot?.original_ai);
    if (snapshot?.severity_suggestion) result.severitySuggestion = snapshot.severity_suggestion;
    const suggestion = snapshot?.severity_suggestion;
    if (snapshot?.original_ai?.status === 'DETECTED' && snapshot?.evidence_status !== STATUS.REVIEW &&
        suggestion?.source === 'approved_measurement_rule' && ['MINOR', 'MAJOR'].includes(suggestion.classification)) {
      result.suggestedClassification = suggestion.classification;
    }
    if (snapshot?.visual_extents) result.visualExtents = snapshot.visual_extents;
    if (snapshot?.evidence_status === STATUS.REVIEW) result.evidenceStatus = STATUS.REVIEW;
    return result;
  }

  function selectFields(value, fields) {
    return value ? Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])) : null;
  }

  function originalAiDto(original) {
    if (!original) return null;
    const candidate = value => selectFields(value, ['canonical_class', 'display_name', 'confidence', 'accepted']);
    const pairFields = ['status', 'detected', 'canonical_class', 'confidence', 'suggested_category',
      'class_agreement', 'same_report_category', 'shared_report_category'];
    const photoFields = ['status', 'detected', 'canonical_class', 'confidence', 'suggested_category', 'model'];
    const detectionFields = ['canonical_class', 'reported_class', 'confidence', 'eligible'];
    return {
      ...selectFields(original, pairFields),
      candidate: candidate(original.candidate),
      photos: original.photos.map(photo => ({
        ...selectFields(photo, photoFields), candidate: candidate(photo.candidate),
        detections: photo.detections.map(detection => selectFields(detection, detectionFields))
      }))
    };
  }

  function resolveSubmissionAssessment(body, value, evidence, user) {
    const evidenceStatus = evidence.reviewRequired ? { evidence_status: STATUS.REVIEW } : {};
    if (body.assessmentProofs === undefined) {
      if (!value.citizenCategory && !evidence.reviewRequired) return null;
      return { schema_version: 2, citizen_category: value.citizenCategory, original_ai: null, evidence: null, ...evidenceStatus };
    }
    let proofs;
    try {
      proofs = typeof body.assessmentProofs === 'string' ? JSON.parse(body.assessmentProofs) : body.assessmentProofs;
      if (!Array.isArray(proofs) || proofs.length !== 2 || proofs.some(proof => typeof proof !== 'string' || proof.length > 64000)) throw new Error();
    } catch {
      throw new ValidationError('Two original assessment proofs are required.', { code: 'ASSESSMENT_REQUIRED' });
    }
    const claims = [];
    for (const [index, digest] of evidence.hashes.entries()) {
      let claim;
      try { claim = assessmentProof.verifyAssessment(proofs[index]); } catch {
        throw new ValidationError('Assessment proof is invalid or expired. Reassess the photos.', { code: 'ASSESSMENT_INVALID' });
      }
      if (claim.sub !== String(user.id) || claim.photo_order !== index + 1 || claim.evidence_sha256 !== digest) {
        throw new ValidationError('Assessment does not belong to this citizen and evidence.', { code: 'ASSESSMENT_MISMATCH' });
      }
      claims.push(claim);
    }
    const reviewAll = evidence.reviewRequired && (evidence.pairReason || !evidence.photoReasons?.some(Boolean));
    const original = originalAssessment(claims.map((claim, index) =>
      reviewAll || evidence.photoReasons?.[index] ? photoSnapshot(reviewAssessment()) : claim.assessment));
    const suggestion = original.detected
      ? pairSeveritySuggestion(claims.map(claim => claim.severity_suggestion), original.canonical_class) : null;
    const extents = claims.map(claim => claim.visual_extent ?? null);
    const snapshot = {
      schema_version: 1,
      citizen_category: value.citizenCategory,
      original_ai: original,
      ...(extents.some(Boolean) ? { visual_extents: extents } : {}),
      ...(suggestion ? { severity_suggestion: suggestion } : {}),
      ...(original.status === STATUS.REVIEW ? { evidence_status: STATUS.REVIEW } : evidenceStatus),
      evidence: {
        citizen_id: String(user.id),
        photos: claims.map(claim => ({ order: claim.photo_order, sha256: claim.evidence_sha256, proof_id: claim.jti, issued_at: claim.iat }))
      }
    };
    validateSubmissionAssessment(snapshot);
    return snapshot;
  }

  async function resolveDeclaredBarangay(name) {
    if (!name || typeof barangayRepository.findByName !== 'function') return null;
    const match = await barangayRepository.findByName(String(name).trim());
    return match && match.name.toLowerCase() === String(name).trim().toLowerCase() ? match : null;
  }

  class ReportService {
    async previousSubmission(user, requestKey, requestHash, client) {
      if (!requestKey) return null;
      const previous = await auditService.findReportRequest(user.id, requestKey, client);
      if (!previous) return null;
      if (previous.details.request_hash !== requestHash) throw new ConflictError('This submission key belongs to different report content.');
      return Number(previous.entity_id);
    }

    async createReport(body, files, user, landmarkFiles = []) {
      let persisted = false;

      const uploadedRefs = [];

      try {
        return await this.persistReport(
          body,
          files,
          user,
          () => {
            persisted = true;
          },
          uploadedRefs,
          landmarkFiles
        );
      } finally {
        if (!persisted) {
          try {
            await cleanupStoredImages(uploadedRefs);
          } catch (cleanupError) {
            console.error(`Unexpected cleanup error: ${cleanupError?.message || cleanupError}`);
          }
        }

        const shouldDeleteLocalFile = !persisted || config.STORAGE_DRIVER === 'supabase';

        if (shouldDeleteLocalFile) {
          try {
            await imageInput.removeTemporaryFiles(files);
            await imageInput.removeTemporaryFiles(landmarkFiles);
          } catch (unlinkError) {
            console.error(`Unexpected unlink error: ${unlinkError?.message || unlinkError}`);
          }
        }
      }
    }

    async persistReport(body, files, user, markPersisted, uploadedRefs, landmarkFiles = []) {
      const receivedAt = Date.now();
      const parsedReport = validateReport(body, config.MAX_GPS_ACCURACY_METERS);
      if (parsedReport.error) throw new ValidationError(parsedReport.error);

      const parsedImages = validateImageCount(files);
      if (parsedImages.error) throw new ValidationError(parsedImages.error);

      const parsedLandmark = validateLandmark(body, landmarkFiles);
      if (parsedLandmark.error) throw new ValidationError(parsedLandmark.error);

      const value = parsedReport.value;
      const citizen = user?.role === 'citizen';
      const rawFixAt = body.gpsFixAt;
      const gpsFixAt = typeof rawFixAt === 'number' || (typeof rawFixAt === 'string' && /^\d{1,16}$/.test(rawFixAt))
        ? Number(rawFixAt) : null;
      const fileList = parsedImages.value;
      const requestKey = body.requestKey ?? null;
      if (requestKey !== null && (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(requestKey))) throw new ValidationError('Invalid report submission key.');
      let requestHash = null, replayed = false;

      let reportId, preparedPublication, queuedPublication;
      try {
        const images = [];
        for (const file of fileList) images.push(await imageInput.validateReportImage(file));
        const landmarkImageValidated = await imageInput.validateReportImage(parsedLandmark.value.landmarkFile);
        if (requestKey) {
          const payload = [value, body.assessmentProofs ?? null, parsedLandmark.value.landmarkDescription];
          if (rawFixAt !== undefined) payload.push(gpsFixAt);
          const digest = createHash('sha256').update(JSON.stringify(payload));
          for (const image of images) {
            digest.update(image.mimeType);
            digest.update(createHash('sha256').update(image.buffer).digest());
          }
          digest.update(landmarkImageValidated.mimeType);
          digest.update(createHash('sha256').update(landmarkImageValidated.buffer).digest());
          requestHash = digest.digest('hex');
          const previous = await this.previousSubmission(user, requestKey, requestHash);
          if (previous) return { id: previous, reportId: previous, ...(await this.getReport(previous, user)), replayed: true };
        }
        if (citizen) {
          if (!user.residencyVerified || !user.barangayId) {
            throw new ForbiddenError('Your registered residency must be verified before you can submit reports.', { code: 'REPORT_RESIDENCY_REQUIRED' });
          }
          if (value.latitude === null || value.longitude === null || !value.gpsAccuracy || !isFreshGpsFix(gpsFixAt, receivedAt)) {
            throw new ValidationError('Get a fresh, accurate GPS reading before submitting the report.', { code: 'REPORT_LOCATION_RETRY' });
          }
          if (!requestKey && await reportRepository.hasUsedGpsFix(user.id, gpsFixAt)) {
            throw new ConflictError('This GPS reading was already used. Get a new reading to submit another report.', { code: 'REPORT_LOCATION_REUSED' });
          }
        }
        const jurisdiction = await geofenceService.resolveJurisdiction({
          latitude: value.latitude,
          longitude: value.longitude,
          gpsAccuracy: value.gpsAccuracy,
          requireCityPolygon: citizen
        });

        if (jurisdiction.boundaryCheckStatus === BoundaryCheckStatus.OUTSIDE) {
          throw new ValidationError('Report location is outside the Bacolod City service area.');
        }

        if (jurisdiction.gpsAccuracy?.status === GpsAccuracyStatus.UNACCEPTABLE) {
          throw new ValidationError(
            `GPS accuracy radius exceeds maximum allowed threshold of ${config.MAX_GPS_ACCURACY_METERS} meters.`
          );
        }

        const authoritativeBarangay = jurisdiction.barangayId
          ? await barangayRepository.findById(jurisdiction.barangayId)
          : null;
        if (citizen) {
          if (!authoritativeBarangay) {
            const unavailable = jurisdiction.status === JurisdictionStatus.AUTHORITATIVE_POLYGONS_PENDING;
            throw new ValidationError(unavailable ? 'Barangay boundary verification is currently unavailable.'
              : 'Current GPS must confirm a single barangay before you can report. Retry from inside your registered barangay.',
            { code: unavailable ? 'REPORT_LOCATION_UNAVAILABLE' : 'REPORT_LOCATION_RETRY' });
          }
          if (Number(user.barangayId) !== Number(authoritativeBarangay.id)) {
            throw new ForbiddenError('You can only submit reports from inside your registered barangay.', { code: 'REPORT_BARANGAY_MISMATCH' });
          }
        }
        const declaredBarangay = authoritativeBarangay || !['AUTHORITATIVE_POLYGONS_PENDING', 'INVALID_COORDINATES'].includes(jurisdiction.status) ? null : await resolveDeclaredBarangay(value.barangay);
        const reportBarangay = authoritativeBarangay || declaredBarangay;

        let evidence = await inspectEvidence(images, imageInput);
        let submissionAssessment = resolveSubmissionAssessment(body, value, evidence, user);
        const manualReview = evidence.reviewRequired || submissionAssessment?.original_ai?.detected === false;
        const assessment = manualReview ? null : await damageDetectionService.detectForReport(fileList);
        if (assessment?.status === STATUS.REVIEW ||
            (!manualReview && submissionAssessment?.original_ai?.detected && !assessment?.detected)) {
          evidence = { ...evidence, reviewRequired: true };
          submissionAssessment = resolveSubmissionAssessment(body, value, evidence, user);
        }
        const acceptedAssessment = evidence.reviewRequired ? null : assessment;
        const ai = this.resolveAiFields(acceptedAssessment);
        // Signed scans keep the suggestion displayed at capture time, even when
        // submission-time inference yields a different measurement.
        const suggestion = submissionAssessment?.original_ai ? submissionAssessment.severity_suggestion
          : acceptedAssessment?.severitySuggestion;
        if (!submissionAssessment?.original_ai && assessment?.visualExtents) {
          submissionAssessment = {
            ...(submissionAssessment || { schema_version: 2, citizen_category: null, original_ai: null, evidence: null }),
            visual_extents: assessment.visualExtents
          };
        }
        if (suggestion && !submissionAssessment?.severity_suggestion) {
          submissionAssessment = {
            ...(submissionAssessment || { schema_version: 2, citizen_category: null, original_ai: null, evidence: null }),
            severity_suggestion: suggestion
          };
        }
        const verification = evidence.reviewRequired || submissionAssessment?.evidence_status === STATUS.REVIEW
          ? null
          : await damageDetectionService.verifyReportImages(fileList, evidence);

        const storedImages = await storeReportsImage(fileList, user?.id, uploadedRefs);
        const landmarkStored = await storeReportsImage([parsedLandmark.value.landmarkFile], user?.id, uploadedRefs);
        const landmarkImagePath = landmarkStored[0]?.imagePath ?? null;
        if (user?.role === 'citizen' && publicationService) {
          const photos = images.map(image => ({ buffer: image.buffer, mimetype: image.mimeType }));
          preparedPublication = await publicationService.prepareAutomatic(value.description, photos);
        }

        reportId = await getDatabase().withTransaction(async (tx) => {
          const actor = (citizen || requestKey) ? await reportRepository.lockSubmissionActor(user.id, tx) : null;
          if (requestKey) {
            const previous = await this.previousSubmission(user, requestKey, requestHash, tx);
            if (previous) { replayed = true; return previous; }
          }
          if (citizen) {
            if (actor?.status !== 'active' || Number(actor.token_version) !== user.tokenVersion ||
                !actor.residency_confirmed_at || Number(actor.barangay_id) !== Number(reportBarangay.id)) {
              throw new ForbiddenError('Your account or registered residency changed. Sign in again.', { code: 'REPORT_RESIDENCY_REQUIRED' });
            }
            if (await reportRepository.hasUsedGpsFix(user.id, gpsFixAt, tx)) {
              throw new ConflictError('This GPS reading was already used. Get a new reading to submit another report.', { code: 'REPORT_LOCATION_REUSED' });
            }
          }
          if (submissionAssessment?.evidence) {
            await reportRepository.assertUnusedAssessment(user.id, submissionAssessment.evidence.photos.map(photo => photo.proof_id), tx);
            resolveSubmissionAssessment(body, value, evidence, user);
          }
          const { insertId } = await reportRepository.create(
            {
              description: value.description,
              location: value.location,
              barangay: reportBarangay?.name || value.barangay,
              barangayId: reportBarangay?.id ?? null,
              jurisdictionSource: jurisdictionSourceFor(jurisdiction.barangayId),
              boundaryCheckStatus: jurisdiction.boundaryCheckStatus,
              latitude: value.latitude,
              longitude: value.longitude,
              gpsAccuracy: value.gpsAccuracy,
              gpsFixAt: citizen ? gpsFixAt : null,
              imagePath: storedImages.map((image) => image.imagePath).join(','),
              ...ai,
              submissionAssessment,
              submittedBy: user?.id,
              landmarkDescription: parsedLandmark.value.landmarkDescription,
              landmarkImagePath
            },
            tx
          );

          await reportImageRepository.createMany(
            insertId,
            storedImages.map((image, index) => ({
              imagePath: image.imagePath,
              imageOrder: index + 1,
              fileSize: image.fileSize,
              mimeType: image.mimeType
            })),
            tx
          );

          if (verification) {
            const verifiedSuggestion = verification.canonical_category === suggestion?.category ? suggestion : null;
            const agreedSeverity = verifiedSuggestion?.level ?? null;
            await this.persistVerification(insertId, {
              ...verification,
              highest_severity: agreedSeverity,
              triage: verifiedSuggestion ? { classification: verifiedSuggestion.classification, priority: verifiedSuggestion.priority } : null,
              severitySuggestion: verifiedSuggestion ?? null,
              summary: { ...verification.summary, highest_severity: agreedSeverity }
            }, tx);
          }

          await auditService.writeAudit(user?.id, 'create', 'report', insertId, tx, requestKey ? { request_key: requestKey, request_hash: requestHash } : null);
          if (preparedPublication) queuedPublication = await publicationService.enqueueAutomatic(user, insertId, preparedPublication, tx);
          return insertId;
        });
      } catch (error) {
        if (preparedPublication) await publicationService.discardAutomatic(preparedPublication);
        if (error instanceof AppError && !(error instanceof PersistenceError)) {
          throw error;
        }
        throw new PersistenceError('Failed to save report; no changes were persisted.', { cause: error });
      }

      if (replayed) {
        if (preparedPublication) await publicationService.discardAutomatic(preparedPublication);
        return { id: reportId, reportId, ...(await this.getReport(reportId, user)), replayed: true };
      }
      markPersisted();
      if (queuedPublication) publicationService.announceAutomatic(queuedPublication);

      const created = await reportRepository.findById(reportId);
      const images = await reportImageRepository.findByReportId(reportId);
      const result = await withImages(created, images);

      if (notificationService?.notifyReportSubmitted) {
        try {
          await notificationService.notifyReportSubmitted({
            report: created,
            user
          });
        } catch (notifErr) {
          console.error(notifErr);
        }
      }

      return { id: reportId, reportId, ...result, ...(queuedPublication ? { publication: queuedPublication.publication } : {}) };
    }

    resolveAiFields(assessment) {
      if (!assessment) return { ...AI_NOT_EVALUATED };

      return {
        aiCategory: assessment.damage_type || assessment.category || null,
        aiClassification: null,
        aiPriority: null,
        aiConfidence: Math.round(Number(assessment.confidence_score || 0) * 10000) / 100,
        visionDetected: true
      };
    }

    async persistVerification(reportId, verification, tx) {
      const alignment = verification.alignment || {};
      await damageVerificationRepository.create(
        {
          reportId,
          isValidMatch: Boolean(verification.is_valid_match),
          compositeSimilarityScore: verification.composite_similarity_score,
          embeddingSimilarity: verification.embedding_similarity,
          homographyInlierRatio: alignment.inlier_ratio,
          perspectiveAligned: Boolean(alignment.perspective_aligned),
          matchedDamageType: verification.damage_type_consensus,
          highestSeverity: verification.highest_severity,
          model: verification.summary?.model,
          rawPayload: verification
        },
        tx
      );
    }

    async listReports(query = {}, user = {}) {
      if (query.publication !== undefined) {
        if (user.role !== 'admin') throw new ForbiddenError('Only Admin may access the publication review queue.');
        if (query.publication !== 'pending_approval') throw new ValidationError('Invalid publication filter.');
      }
      if (user.role === 'barangay') {
        if (!Number.isSafeInteger(Number(user.barangayId)) || Number(user.barangayId) <= 0) throw new ForbiddenError('A barangay assignment is required.');
        const page = await reportRepository.findPage(reportQuery(query), user.barangayId);
        const images = await reportImageRepository.findByReportIds(page.rows.map(row => row.id));
        const reports = await Promise.all(page.rows.map(row => withImages(row, images.get(row.id) || [], { offset: page.offset, privateEvidence: true })));
        return { reports, stats: page.stats, filteredStats: page.filteredStats, pagination: page.pagination };
      }
      const reports = await reportRepository.findAll({
        role: user.role,
        userId: user.id,
        barangayId: user.barangayId ?? null,
        status: query?.status ? validateStatus(query.status) : null,
        filterBarangay: query?.barangay,
        publication: query.publication
      });

      const reportIds = (reports || [])
        .map((report) => report.id)
        .filter((id) => id !== undefined && id !== null);
      const imagesByReportId = await reportImageRepository.findByReportIds(reportIds);
      const offset = await reportClock?.offsetMinutes(getDatabase()) ?? 0;
      const enriched = await Promise.all(
        (reports || []).map((report) => withImages(report, imagesByReportId.get(report.id) || [], {
          offset, privateEvidence: user?.role === 'citizen'
        }))
      );

      return { reports: enriched, stats: summarizeStatuses(enriched) };
    }

    async getReport(id, user) {
      const report = await this.findAuthorizedReport(id, user);
      const images = await reportImageRepository.findByReportId(report.id);
      const result = await withImages(report, images, { privateEvidence: user?.role === 'citizen' });
      if (reportReviewRepository) result.barangayReview = await reportReviewRepository.latestSeverityStatus(report.id);
      return result;
    }

    async updateReportStatus(id, rawStatus, user, rawNote = null, files = [], requestKey = null) {
      let retained = false;
      const refs = [];
      try {
        if (user?.role !== 'barangay') throw new ForbiddenError('Only the assigned Barangay may change operational report status.');
        const status = validateStatus(rawStatus);
        if (!status) throw new ValidationError('Invalid report status.');

        const note = normalizeStatusNote(rawNote);
        if (note.error) throw new ValidationError(note.error);

        const report = await this.findAuthorizedReport(id, user);
        const policyError = validateActionProof(status, note.value, files.length);
        if (policyError) throw new ValidationError(policyError);
        if (requestKey !== null && (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(requestKey))) {
          throw new ValidationError('Invalid action request key.');
        }
        if (files.length && !requestKey) throw new ValidationError('An action request key is required for proof uploads.');
        const digest = createHash('sha256').update(JSON.stringify([status, note.value]));
        for (const file of files) {
          await imageInput.validateReportImage(file);
          digest.update(createHash('sha256').update((await imageInput.read(file)).buffer).digest());
        }
        const requestHash = digest.digest('hex');
        let stored = [], previousStatus, statusNotification;

        const created = await getDatabase().withTransaction(async (tx) => {
          // Serialize transitions and retries against the same report before storing media.
          const current = await reportRepository.findByIdForUpdate(report.id, tx);
          if (!current || !authorizeReportAccess(current, user).allowed) throw new ForbiddenError('Report is no longer available in your jurisdiction.');
          if (requestKey) {
            const previous = await reportStatusHistoryRepository.byRequest(report.id, requestKey, tx);
            if (previous) {
              if (Number(previous.changed_by) !== Number(user.id) || previous.request_hash !== requestHash) throw new ConflictError('This request key belongs to another action.');
              return false;
            }
          }
          if (current.status !== report.status) throw new ConflictError('Report status changed while you were updating it. Reload and try again.');
          const transition = checkStatusTransition(current.status, status);
          if (!transition.allowed) throw new ValidationError(TRANSITION_MESSAGE[transition.reason] || TRANSITION_MESSAGE.NOT_ALLOWED);
          previousStatus = current.status;
          stored = await storeReportsImage(files, user.id, refs);
          const { affectedRows } = await reportRepository.updateStatus(report.id, status, current.status, tx);
          if (affectedRows !== 1) {
            throw new ConflictError('Report status changed while you were updating it. Reload and try again.');
          }
          const history = await reportStatusHistoryRepository.create(
            {
              reportId: report.id,
              oldStatus: current.status,
              newStatus: status,
              changedBy: user.id,
              note: note.value, requestKey, requestHash
            },
            tx
          );
          if (stored.length) await reportStatusHistoryRepository.addProofs(history.insertId, stored, tx);
          await auditService.writeAudit(user.id, 'status_update', 'report', report.id, tx, {
            from: current.status,
            to: status,
            barangay_id: report.barangay_id ?? null,
            ...(status === 'rejected' ? { reason: note.value } : {})
          });
          if (notificationService?.notifyReportStatusUpdate) {
            statusNotification = await notificationService.notifyReportStatusUpdate({ report: current, newStatus: status, oldStatus: previousStatus, actor: user, note: note.value, client: tx, deferPublish: true });
          }
          return true;
        });
        retained = created;

        if (created) notificationService?.publishReportStatusUpdate?.(statusNotification);

        const updated = await reportRepository.findById(report.id);
        return { ok: true, replayed: !created, ...toReportDto(updated, await reportClock?.offsetMinutes(getDatabase()) ?? 0) };
      } finally {
        if (!retained) await cleanupStoredImages(refs);
        if (!retained || config.STORAGE_DRIVER === 'supabase') await imageInput.removeTemporaryFiles(files);
      }
    }

    async getStatusHistory(id, user) {
      const report = await this.findAuthorizedReport(id, user);
      const rows = await reportStatusHistoryRepository.findByReportId(report.id);
      const proofs = await reportStatusHistoryRepository.proofs(report.id);
      const offset = await reportClock?.offsetMinutes(getDatabase()) ?? 0;
      return rows.map(row => ({
        ...selectFields(row, ['id', 'report_id', 'old_status', 'new_status', 'note']),
        ...(user.role === 'citizen' ? {} : selectFields(row, ['changed_by', 'changed_by_username', 'changed_by_role'])),
        created_at: reportClock ? reportClock.utc(row.created_at, offset) : row.created_at,
        proofs: proofs.filter(image => Number(image.history_id) === Number(row.id)).map(image => ({ id: Number(image.id),
          imageOrder: image.image_order, mimeType: image.mime_type, imagePath: `/api/reports/${report.id}/images/action-${image.id}` }))
      }));
    }

    async findAuthorizedReport(id, user) {
      const report = await reportRepository.findById(id);
      if (!report) throw new NotFoundError('Report not found.');

      const decision = authorizeReportAccess(report, user);
      if (!decision.allowed) {
        throw new ForbiddenError(ACCESS_MESSAGE[decision.reason] || 'You may not access this report.');
      }
      return report;
    }
  }

  return new ReportService();
}

module.exports = { createReportService };
