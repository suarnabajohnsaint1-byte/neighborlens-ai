const { DamageDetectionError, ValidationError, ErrorKind } = require('../../domain/errors');
const { photoSnapshot } = require('../../domain/reports/submissionAssessment.rules');
const { STATUS } = require('../../domain/reports/evidenceSuitability.rules');
const { inspectEvidence, reviewAssessment } = require('./reportEvidence');
const { DETECTION_HINT, hasRegionScreening, readDetectionHint, addPairedDetectionPreview } = require('./detectionPreview');
const {
  DETECTION_OUTCOMES,
  SUPPORTED_TASKS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MIN_CONFIDENCE,
  detectMimeType,
  validateImage,
  normalizeDetection,
  validDetectionGeometry,
  confidenceAsUnit,
  isEligible,
  evaluateDetections,
  evaluatePairResults,
  photoSeveritySuggestion,
  assessmentStatusFor
} = require('../../domain/reports/damageDetection.rules');
const {
  isCanonicalDamageCategory,
  displayLabelFor,
  reportCategoryFor,
  AI_REPORT_CATEGORIES
} = require('../../domain/reports/damageCategories');
const { triageForSeverity } = require('../../domain/reports/report.rules');
const { measurementSuggestion } = require('../../domain/reports/reportSeverity.rules');
const { readVisualExtent } = require('../../domain/reports/visualExtent');

const SCREENING_REASONS = Object.freeze({
  face_overlap: 'FACE_OVERLAP',
  unrelated_subject_overlap: 'UNRELATED_SUBJECT_OVERLAP',
  evidence_screening_unavailable: 'EVIDENCE_SCREENING_UNAVAILABLE'
});

function providerRelevance(payload) {
  const state = payload?.evidence_relevance;
  if (state === 'REJECTED') {
    throw new DamageDetectionError('Replace the unsuitable evidence photo.', 'INVALID_EVIDENCE', 422);
  }
  return state === 'VERIFIED' || state === 'UNVERIFIED' ? state : 'UNAVAILABLE';
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function effectiveMinConfidence(configured, providerThreshold) {
  const base = finiteOrNull(configured) ?? DEFAULT_MIN_CONFIDENCE;
  const provider = finiteOrNull(providerThreshold);
  return provider === null ? base : Math.max(base, provider);
}

function imageSizeOf(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function modelInfoOf(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    name: value.name ? String(value.name) : null,
    architecture: value.architecture ? String(value.architecture) : null,
    version: value.version ? String(value.version) : null,
    release_label: value.release_label ? String(value.release_label) : null,
    checkpoint: value.checkpoint ? String(value.checkpoint) : null,
    target_eligible: typeof value.target_eligible === 'boolean' ? value.target_eligible : null,
    classes: value.classes && typeof value.classes === 'object' ? value.classes : null
  };
}

function createDamageDetectionService({ aiProvider, imageInput: imageInputPort, assessmentProof, severityPolicy = {} }) {
  const readImageInput = (input) => imageInputPort.read(input);
  class DamageDetectionService {
    async checkEvidence(inputs, options) {
      const images = [];
      for (const input of inputs) images.push(await imageInputPort.validateReportImage(input, options));
      return inspectEvidence(images, imageInputPort);
    }

    async assessCitizenPair(files, user, options = {}) {
      if (files.length !== 2 || user?.role !== 'citizen') throw new ValidationError('Two citizen evidence photos are required.');
      const evidence = await this.checkEvidence(files);
      const photos = await Promise.all(files.map((file, index) =>
        this.assessCheckedPhoto(file, user, index + 1, evidence.hashes[index], Boolean(evidence.photoReasons[index] || evidence.pairReason),
          { ...options, includeReviewPreview: true, evidenceReviewReason: evidence.photoReasons[index] })
      ));
      const reviewRequired = photos.some(photo => photo.result.status === STATUS.REVIEW);
      const pair = evaluatePairResults(photos.map(photo => photo.result));
      addPairedDetectionPreview(photos);
      return { photos, ...this.severityResult(pair.severitySuggestion, reviewRequired, pair.severityConflict),
        pairReviewReason: evidence.pairReason, evidenceStatus: reviewRequired ? STATUS.REVIEW : STATUS.PASSED };
    }

    severityResult(suggestion, reviewRequired = false, conflict = false) {
      return {
        severitySuggestion: suggestion,
        severityStatus: suggestion ? 'ASSESSED' : reviewRequired || conflict ? 'REVIEW_REQUIRED' : 'NOT_ASSESSED',
        severityReason: suggestion?.reasonCode ?? (conflict ? 'CONFLICTING_SEVERITY' : reviewRequired ? 'EVIDENCE_REVIEW_REQUIRED' : 'INSUFFICIENT_SEVERITY_EVIDENCE')
      };
    }

    async assessCitizenPhoto(input, user, photoOrder, options = {}) {
      if (![1, 2].includes(Number(photoOrder)) || user?.role !== 'citizen') throw new ValidationError('Invalid assessment evidence order.');
      const evidence = await this.checkEvidence([input]);
      return this.assessCheckedPhoto(input, user, Number(photoOrder), evidence.hashes[0], evidence.reviewRequired,
        { ...options, evidenceReviewReason: evidence.photoReasons[0] });
    }

    async assessCheckedPhoto(input, user, photoOrder, hash, reviewRequired, options) {
      let result = { ...reviewAssessment(), evidence_reason: options.evidenceReviewReason };
      let failure = null;
      try {
        if (!reviewRequired || options.includeReviewPreview) {
          result = await this.processDamageImage(input, {
            ...options,
            requireAssessmentEvidence: true,
            reviewRequired
          });
        }
      } catch (error) {
        if (![ErrorKind.PROVIDER_FAILURE, ErrorKind.PROVIDER_UNAVAILABLE, ErrorKind.PROVIDER_TIMEOUT].includes(error.kind)) throw error;
        if (!reviewRequired) {
          failure = { status: error.statusCode || 503, code: error.code, error: 'The AI service could not assess this photo.' };
          result = { status: 'AI_UNAVAILABLE', detected: false, confidence: null, candidate: null, detections: [] };
        }
      }
      const proof = assessmentProof.issueAssessment({
        sub: String(user.id), photo_order: photoOrder,
        evidence_sha256: hash,
        assessment: photoSnapshot(result),
        ...(result.visual_extent ? { visual_extent: result.visual_extent } : {}),
        severity_suggestion: photoSeveritySuggestion(result)
      });
      return { result, failure, assessmentProof: proof, correctionCategories: AI_REPORT_CATEGORIES };
    }

    async processDamageImage(imageInput, options = {}) {
      const started = Date.now();
      const image = await readImageInput(imageInput);
      validateImage(image.buffer, image.mimeType, options.maxBytes || DEFAULT_MAX_BYTES);

      const defaults = aiProvider.detectionDefaults();
      const task = options.task || defaults.task || 'detect';
      if (!SUPPORTED_TASKS.has(task)) {
        throw new DamageDetectionError(`Unsupported YOLO task: ${task}.`, 'TASK_UNSUPPORTED');
      }

      const requestInference =
        options.inferenceClient ||
        ((buffer, mimeType) =>
          aiProvider.requestInference(buffer, mimeType, {
            endpoint: options.endpoint,
            timeoutMs: options.timeoutMs,
            task
          }));

      const payload = await requestInference(image.buffer, image.mimeType);
      return this.normalizeResult(payload, { started, task, image, options, defaults });
    }

    normalizeResult(payload, { started, task, image, options, defaults }) {
      if (!['detections', 'predictions', 'results'].some(field => Array.isArray(payload?.[field]))) {
        throw new DamageDetectionError('Inference response has no detection evidence.', 'INFERENCE_RESPONSE', 502);
      }
      const relevance = providerRelevance(payload);
      const rawDetections = payload?.detections || payload?.predictions || payload?.results || [];
      if (!Array.isArray(rawDetections)) {
        throw new DamageDetectionError(
          'Inference response has no detection array.',
          'INFERENCE_RESPONSE',
          502
        );
      }
      const size = imageSizeOf(payload?.image_size);
      if (payload?.image_size != null && !size || rawDetections.some(item => !validDetectionGeometry(item, size))) {
        throw new DamageDetectionError('Inference response has invalid image coordinates.', 'INFERENCE_RESPONSE', 502);
      }
      if (options.requireAssessmentEvidence && rawDetections.some(item => {
        const confidence = item?.confidence_score ?? item?.confidence ?? item?.score;
        const damageType = item?.damage_type || item?.damageType || item?.class || item?.label;
        const classes = ['damage_type', 'damageType', 'class', 'label', 'canonical_category']
          .filter(field => item?.[field] !== undefined).map(field => item[field]);
        const confidences = ['confidence_score', 'confidence', 'score']
          .filter(field => item?.[field] !== undefined).map(field => item[field]);
        return typeof damageType !== 'string' || !isCanonicalDamageCategory(damageType.trim()) ||
          classes.some(value => typeof value !== 'string' || !isCanonicalDamageCategory(value.trim()) || value.trim() !== damageType.trim()) ||
          confidence === undefined || confidences.some(value => !['number', 'string'].includes(typeof value) || String(value).trim() === '' ||
            !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100 || confidenceAsUnit(value) !== confidenceAsUnit(confidence)) ||
          (item?.eligible !== undefined && typeof item.eligible !== 'boolean');
      })) {
        throw new DamageDetectionError('Inference response has invalid detection evidence.', 'INFERENCE_RESPONSE', 502);
      }

      const minConfidence = effectiveMinConfidence(
        options.minConfidence ?? defaults.minConfidence,
        payload?.min_confidence
      );
      const normalized = rawDetections
        .map(raw => {
          const item = normalizeDetection(raw);
          if (!item) return item;
          const suggestion = item.canonical_category
            ? measurementSuggestion(item.canonical_category, raw.severity_measurement, severityPolicy) : null;
          // Legacy provider levels remain in raw_detection_data for diagnostics.
          return { ...item, severity_level: suggestion?.level ?? null, ...(suggestion ? { severity_suggestion: suggestion } : {}) };
        })
        .filter(Boolean)
        .map((item) => ({ ...item, eligible: isEligible(item, minConfidence) }));
      const { outcome, primary, eligible } = evaluateDetections(normalized, minConfidence);
      const detected = outcome === DETECTION_OUTCOMES.ACCEPTED;
      const extent = readVisualExtent(payload.visual_extent, primary, size);
      if (payload.inference_status === 'evidence_review_required' && Object.hasOwn(SCREENING_REASONS, payload.reason)) {
        return { ok: true, ...reviewAssessment(), inconclusive: true, reason: STATUS.REVIEW,
          evidence_relevance: 'UNVERIFIED', evidence_reason: SCREENING_REASONS[payload.reason] };
      }
      const withheld = relevance !== 'VERIFIED';
      const detectionHint = options.includeReviewPreview
        ? readDetectionHint(payload, primary, size, minConfidence) : null;
      if (options.reviewRequired || (withheld && (detected || detectionHint ||
          (hasRegionScreening(payload) && primary?.canonical_category)))) {
        // Screened hints are evaluated for display after both assessment proofs are signed.
        const hint = primary?.canonical_category && !withheld ? primary : null;
        const box = hint?.bounding_box;
        const hasPreviewBox = options.includeReviewPreview && box?.width > 0 && box.height > 0;
        return {
          ok: true, ...reviewAssessment(), inconclusive: true, reason: STATUS.REVIEW,
          evidence_relevance: relevance,
          ...(detectionHint ? { [DETECTION_HINT]: detectionHint, model_info: modelInfoOf(payload.model_info) } : {}),
          ...(extent && !options.reviewRequired ? { visual_extent: extent } : {}),
          evidence_reason: options.evidenceReviewReason || (relevance === 'UNAVAILABLE' ? 'EVIDENCE_VERIFIER_UNAVAILABLE'
            : relevance === 'UNVERIFIED' ? 'EVIDENCE_RELEVANCE_UNVERIFIED' : null),
          ...(hint ? { suggested_class: hint.canonical_category } : {}),
          ...(options.includeReviewPreview && hint ? {
            suggested_confidence: hint.confidence_score,
            suggested_eligible: hint.eligible
          } : {}),
          ...(hasPreviewBox ? {
            image_size: size,
            model_info: modelInfoOf(payload?.model_info),
            suggested_box: { confidence: hint.confidence_score, bounding_box: box }
          } : {})
        };
      }
      const canonicalCategory = detected ? primary.canonical_category : null;
      const candidateCategory = primary?.canonical_category ?? null;
      const confidence = primary ? primary.confidence_score : null;
      const model = String(payload?.model || options.model || defaults.model || 'unreported');

      const severitySuggestion = photoSeveritySuggestion({ detected, candidate: primary, detections: normalized });
      const severityLevel = severitySuggestion?.level ?? null;
      const triage = triageForSeverity(severityLevel);

      return {
        ok: true,
        status: assessmentStatusFor(outcome),
        ...(extent ? { visual_extent: extent } : {}),
        evidence_relevance: relevance,
        detected,
        ...this.severityResult(severitySuggestion),
        inconclusive: !detected,
        reason: detected ? null : outcome,
        ...(outcome === DETECTION_OUTCOMES.LOW_CONFIDENCE ? {
          evidence_reason: (primary.raw_confidence_score ?? primary.confidence_score) < minConfidence
            ? 'BELOW_CONFIDENCE_THRESHOLD' : 'DETECTION_INELIGIBLE'
        } : {}),
        report_category: candidateCategory ? reportCategoryFor(candidateCategory) : null,
        candidate:
          primary && primary.canonical_category
            ? {
                canonical_category: primary.canonical_category,
                display_category: primary.display_category,
                confidence: primary.confidence_score,
                accepted: detected
              }
            : null,
        triage:
          triage && triage.aiClassification
            ? { classification: triage.aiClassification, priority: triage.aiPriority }
            : null,
        image_size: imageSizeOf(payload?.image_size),
        model_info: modelInfoOf(payload?.model_info),
        category: canonicalCategory || 'Inconclusive',
        canonical_category: canonicalCategory,
        display_category: canonicalCategory ? displayLabelFor(canonicalCategory) : 'Inconclusive',
        confidence,
        source:
          outcome === DETECTION_OUTCOMES.UNSUPPORTED_CLASS ? 'yolo_backend_unsupported' : 'yolo_backend',
        model,
        damage_id: detected ? primary.damage_id : null,
        damage_type: canonicalCategory,
        confidence_score: confidence ?? 0,
        severity_level: severityLevel,
        bounding_box: detected ? primary.bounding_box : null,
        timestamp: primary?.timestamp || new Date().toISOString(),
        detections: normalized,
        summary: {
          detection_count: normalized.length,
          accepted_count: eligible.length,
          rejected_count: normalized.length - eligible.length,
          inference_status: outcome.toLowerCase(),
          min_confidence: minConfidence,
          model,
          task,
          processing_ms: Date.now() - started
        },
        raw_detection_data: payload,
        metadata: { source: image.source, mime_type: image.mimeType }
      };
    }

    selectPrimaryResult(results) {
      return (
        results
          .slice()
          .sort(
            (a, b) =>
              Number(b.detected) - Number(a.detected) ||
              Number(b.confidence_score) - Number(a.confidence_score)
          )[0] || null
      );
    }

    async detectForReport(files) {
      const results = [];
      for (const file of files) {
        try {
          results.push(await this.processDamageImage(file, {}));
        } catch (error) {
          if (error?.kind === ErrorKind.UNPROCESSABLE || (error?.kind === ErrorKind.VALIDATION && /^IMAGE_/.test(error.code || ''))) throw error;
        }
      }

      const extents = results.map(result => result.visual_extent ?? null);
      const observations = extents.length === 2 && extents.some(Boolean) ? { visualExtents: extents } : {};
      if (results.some(result => result.status === STATUS.REVIEW)) return { ...reviewAssessment(), ...observations };
      if (results.length !== 2) return null;
      const pair = evaluatePairResults(results);
      if (!pair.detected) return null;
      return { ...this.selectPrimaryResult(results), ...observations, ...this.severityResult(pair.severitySuggestion, false, pair.severityConflict),
        severity_level: pair.severitySuggestion?.level ?? null, triage: pair.severitySuggestion ? pair.triage : null };
    }

    async verifyReportImages(files, evidence) {
      if (!Array.isArray(files) || files.length !== 2) return null;
      try {
        const verification = await this.verifyDamagePair(files[0], files[1], { evidence });
        return verification.status === STATUS.REVIEW ? null : verification;
      } catch (error) {
        if (error?.kind === ErrorKind.UNPROCESSABLE || (error?.kind === ErrorKind.VALIDATION && /^IMAGE_/.test(error.code || ''))) throw error;
        return null;
      }
    }

    async verifyDamagePair(firstInput, secondInput, options = {}) {
      const started = Date.now();
      const first = await readImageInput(firstInput);
      const second = await readImageInput(secondInput);
      const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
      validateImage(first.buffer, first.mimeType, maxBytes);
      validateImage(second.buffer, second.mimeType, maxBytes);
      const evidence = options.evidence || await this.checkEvidence([firstInput, secondInput]);
      if (evidence.reviewRequired) return { ok: true, ...reviewAssessment(), scene_status: 'UNAVAILABLE' };

      const requestPair =
        options.inferenceClient ||
        ((b1, m1, b2, m2) =>
          aiProvider.requestPairInference(b1, m1, b2, m2, {
            endpoint: options.endpoint,
            timeoutMs: options.timeoutMs
          }));

      const payload = await requestPair(first.buffer, first.mimeType, second.buffer, second.mimeType);
      return this.normalizePairResult(payload, started, options);
    }

    normalizePairResult(payload, started, options = {}) {
      const relevance = providerRelevance(payload);
      const summary = payload.summary || {};
      const compositeScore = Number(
        summary.composite_similarity_score ?? payload.composite_similarity_score ?? 0
      );
      const embeddingSim = Number(summary.embedding_similarity ?? payload.embedding_similarity ?? 0);
      const consensusType = summary.damage_type_consensus || payload.damage_type_consensus || null;
      const alignment = summary.alignment ||
        payload.alignment || { perspective_aligned: false, good_matches_count: 0, inlier_ratio: 0 };

      const rawDets1 = payload.image1_detections || [];
      const rawDets2 = payload.image2_detections || [];
      if (Array.isArray(payload.image1_detections) !== Array.isArray(payload.image2_detections)) {
        throw new DamageDetectionError('Inference response is missing one photo assessment.', 'INFERENCE_RESPONSE', 502);
      }
      if (payload.status === STATUS.REVIEW && [payload.image1_assessment, payload.image2_assessment]
        .some(photo => photo?.inference_status === 'evidence_review_required' && Object.hasOwn(SCREENING_REASONS, photo.reason))) {
        return { ok: true, ...reviewAssessment(), inconclusive: true, reason: STATUS.REVIEW, scene_status: 'UNAVAILABLE' };
      }
      const defaults = aiProvider.detectionDefaults();
      const photos = [rawDets1, rawDets2].map((detections, index) =>
        this.normalizeResult(
          {
            detections,
            visual_extent: payload[`image${index + 1}_assessment`]?.visual_extent,
            image_size: payload[`image${index + 1}_assessment`]?.image_size,
            min_confidence: payload.min_confidence,
            model: payload.model,
            model_info: payload.model_info,
            evidence_relevance: payload.evidence_relevance,
            evidence_screening: payload.evidence_screening
          },
          { started, task: 'detect', image: {}, options, defaults }
        )
      );
      const [dets1, dets2] = photos.map((photo) => photo.detections);
      const hasPhotoEvidence =
        Array.isArray(payload.image1_detections) && Array.isArray(payload.image2_detections);
      const pair = hasPhotoEvidence ? evaluatePairResults(photos) : null;

      const isMatch = Boolean(payload?.is_valid_match ?? summary.is_valid_match);
      const canonicalConsensus = isCanonicalDamageCategory(consensusType) ? consensusType : null;
      const unsupported = pair ? pair.status === 'UNSUPPORTED' : Boolean(consensusType && !canonicalConsensus);
      if (photos.some(photo => photo.status === STATUS.REVIEW) ||
          (!hasPhotoEvidence && relevance !== 'VERIFIED' && isMatch && canonicalConsensus && payload.detected !== false)) {
        const extents = photos.map(photo => photo.visual_extent ?? null);
        return { ok: true, ...reviewAssessment(), inconclusive: true, reason: STATUS.REVIEW, scene_status: 'UNAVAILABLE',
          ...(extents.some(Boolean) ? { visualExtents: extents } : {}) };
      }
      const isDetected = pair
        ? pair.detected
        : isMatch && Boolean(canonicalConsensus) && payload?.detected !== false;
      const canonicalClass = pair ? pair.canonicalClass : canonicalConsensus;
      const category = isDetected ? canonicalClass : 'Inconclusive';
      const highestSev = pair?.severitySuggestion?.level ?? null;
      const sceneStatus = ['MATCH', 'MISMATCH', 'UNAVAILABLE'].includes(summary.scene_status)
        ? summary.scene_status
        : finiteOrNull(summary.composite_similarity_score ?? payload.composite_similarity_score) === null
          ? 'UNAVAILABLE'
          : isMatch
            ? 'MATCH'
            : 'MISMATCH';

      return {
        ok: true,
        detected: isDetected,
        inconclusive: !isDetected,
        status:
          pair?.status ||
          (isDetected ? 'DETECTED' : consensusType && !canonicalConsensus ? 'UNSUPPORTED' : 'NO_DETECTION'),
        category,
        canonical_category: isDetected ? canonicalClass : null,
        display_category: isDetected ? displayLabelFor(canonicalClass) : 'Inconclusive',
        confidence: pair ? pair.confidence : finiteOrNull(payload.confidence),
        report_category: pair?.reportCategory || (isDetected ? reportCategoryFor(canonicalClass) : null),
        candidate: canonicalClass
          ? {
              canonical_category: canonicalClass,
              display_category: displayLabelFor(canonicalClass),
              confidence: pair ? pair.confidence : finiteOrNull(payload.confidence),
              accepted: isDetected
            }
          : null,
        triage: highestSev ? pair.triage : null,
        ...this.severityResult(pair?.severitySuggestion ?? null, false, pair?.severityConflict),
        class_agreement: pair ? pair.sameClass : isDetected,
        provisional_class_agreement: Boolean(pair?.sameClass && !isDetected),
        same_report_category: pair?.sameReportCategory || false,
        shared_report_category: pair?.sharedReportCategory || null,
        scene_status: sceneStatus,
        agreement: isDetected,
        is_valid_match: isMatch,
        reason: isDetected
          ? null
          : unsupported
            ? DETECTION_OUTCOMES.UNSUPPORTED_CLASS
            : pair?.status === 'LOW_CONFIDENCE'
              ? 'LOW_CONFIDENCE'
              : 'NO_CONSENSUS',
        source: unsupported ? 'yolo_backend_unsupported' : 'yolo_backend',
        composite_similarity_score: compositeScore,
        embedding_similarity: embeddingSim,
        damage_type_consensus: pair ? canonicalClass : consensusType,
        highest_severity: highestSev,
        alignment: {
          perspective_aligned: Boolean(alignment.perspective_aligned),
          good_matches_count: Number(alignment.good_matches_count || 0),
          inlier_ratio: Number(alignment.inlier_ratio || 0),
          homography_matrix: alignment.homography_matrix || null
        },
        image1_detections: dets1,
        image2_detections: dets2,
        image1_assessment: photos[0],
        image2_assessment: photos[1],
        summary: {
          is_valid_match: isMatch,
          composite_similarity_score: compositeScore,
          embedding_similarity: embeddingSim,
          damage_type_consensus: pair ? canonicalClass : consensusType,
          scene_status: sceneStatus,
          highest_severity: highestSev,
          model: String(payload.model || aiProvider.detectionDefaults().model || 'unreported'),
          processing_ms: Date.now() - started
        },
        raw_payload: payload
      };
    }
  }

  const service = new DamageDetectionService();
  return Object.assign(service, { DamageDetectionError, normalizeDetection, detectMimeType });
}

module.exports = { createDamageDetectionService };
