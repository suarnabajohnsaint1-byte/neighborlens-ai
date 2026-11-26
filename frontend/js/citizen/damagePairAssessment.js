(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../../shared/reportVocabulary') : root.ReportVocabulary);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DamagePairAssessment = api;
})(typeof self !== 'undefined' ? self : this, function (vocabulary) {
  'use strict';

  const STATES = Object.freeze({
    DETECTED: 'DETECTED',
    LOW_CONFIDENCE: 'LOW_CONFIDENCE',
    NO_DETECTION: 'NO_DETECTION',
    PAIR_MISMATCH: 'PAIR_MISMATCH',
    UNSUPPORTED: 'UNSUPPORTED',
    AUTH_ERROR: 'AUTH_ERROR',
    AI_SERVICE_ERROR: 'AI_SERVICE_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INVALID_EVIDENCE: 'INVALID_EVIDENCE',
    DUPLICATE_EVIDENCE: 'DUPLICATE_EVIDENCE',
    EVIDENCE_REVIEW_REQUIRED: 'EVIDENCE_REVIEW_REQUIRED'
  });

  const BLOCKED = [STATES.AUTH_ERROR, STATES.INVALID_EVIDENCE, STATES.DUPLICATE_EVIDENCE, STATES.VALIDATION_ERROR];

  const REVIEW_REASONS = Object.freeze({
    EVIDENCE_VERIFIER_UNAVAILABLE: 'Automatic evidence verification is unavailable.',
    EVIDENCE_RELEVANCE_UNVERIFIED: 'Evidence relevance has not been verified.',
    SIMILAR_VIEWS: 'The photos may show the same angle. Take a different view or send them for Barangay review.',
    PHOTO_SUITABILITY_UNCERTAIN: 'At least one photo may be unsuitable as evidence. Retake it or send it for Barangay review.',
    BELOW_CONFIDENCE_THRESHOLD: 'At least one photo scored below the required confidence threshold.',
    DETECTION_INELIGIBLE: 'The AI service marked a detection in at least one photo as ineligible.',
    FACE_OVERLAP: 'Retake the photo with the damage clearly visible, or submit it for Barangay review.',
    UNRELATED_SUBJECT_OVERLAP: 'Retake the photo and center the infrastructure damage.',
    EVIDENCE_SCREENING_UNAVAILABLE: 'The photo check is unavailable. Retake the photos or submit them for Barangay review.',
    EVIDENCE_REVIEW_REQUIRED: 'The AI could not confirm the evidence. Retake the photos or submit them for Barangay review.'
  });

  const STATE_LABELS = Object.freeze({
    DETECTED: 'Damage Detected',
    LOW_CONFIDENCE: 'Low Confidence',
    NO_DETECTION: 'No Damage Detected',
    PAIR_MISMATCH: 'Photos Disagree',
    UNSUPPORTED: 'Unsupported Damage Type',
    AUTH_ERROR: 'Sign-in Required',
    AI_SERVICE_ERROR: 'AI Service Unavailable',
    VALIDATION_ERROR: 'Invalid Photo',
    INVALID_EVIDENCE: 'Unsuitable photos',
    DUPLICATE_EVIDENCE: 'Duplicate photos',
    EVIDENCE_REVIEW_REQUIRED: 'Evidence needs review'
  });

  // Display bands only. Eligibility and signed evidence decisions come from the backend.
  function confidenceLevel(score) {
    if (!Number.isFinite(score) || score < 0 || score > 1) return null;
    if (score >= 0.80) return 'High';
    return score >= 0.50 ? 'Moderate' : 'Low';
  }

  function percent(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 1000) / 10 : null;
  }

  function photoOf(entry, index) {
    if (!entry || !entry.ok) {
      return {
        index,
        state: BLOCKED.includes(entry?.error?.state)
          ? entry.error.state
          : STATES.AI_SERVICE_ERROR,
        canonicalClass: null,
        displayName: null,
        confidence: null,
        accepted: false,
        detections: [],
        boxes: [],
        imageSize: null,
        triage: null,
        reportCategory: null,
        modelInfo: null,
        error: entry?.error?.message || 'The AI service did not return a result.',
        errorCode: entry?.error?.code || null,
        rawResult: null
        , assessmentProof: entry?.error?.assessmentProof || null,
        correctionCategories: entry?.error?.correctionCategories || []
      };
    }
    const result = entry.result;
    const candidate = ['DETECTED', 'LOW_CONFIDENCE'].includes(result.status)
      ? result.candidate || null
      : null;
    const accepted = Boolean(
      candidate?.accepted && result.status === STATES.DETECTED && result.detected !== false
    );
    const suggestedClass = result.status === STATES.EVIDENCE_REVIEW_REQUIRED &&
      vocabulary?.isCanonicalDamageCategory(result.suggested_class) ? result.suggested_class : null;
    const detections = (Array.isArray(result.detections) ? result.detections : [])
      .filter((item) => item && item.canonical_category)
      .map((item) => ({
        canonicalClass: item.canonical_category,
        displayName: item.display_category,
        confidence: Number(item.confidence_score),
        eligible: Boolean(item.eligible),
        severity: item.severity_level || null,
        bbox: item.bounding_box || null
      }));
    const eligible = detections.filter((item) => item.eligible);
    return {
      index,
      state:
        candidate && result.status === STATES.DETECTED && !accepted ? STATES.LOW_CONFIDENCE : result.status,
      canonicalClass: candidate ? candidate.canonical_category : null,
      displayName: candidate ? candidate.display_category : null,
      suggestedClass,
      singlePhotoPreview: result.single_photo_preview === true,
      suggestedEligible: Boolean(suggestedClass && result.suggested_eligible === true),
      suggestedConfidence: suggestedClass ? result.suggested_confidence ?? result.suggested_box?.confidence ?? null : null,
      evidenceReason: [STATES.EVIDENCE_REVIEW_REQUIRED, STATES.LOW_CONFIDENCE].includes(result.status) && Object.hasOwn(REVIEW_REASONS, result.evidence_reason)
        ? result.evidence_reason : null,
      evidenceRelevance: result.evidence_relevance || null,
      faceOverlap: result.status === STATES.EVIDENCE_REVIEW_REQUIRED && result.evidence_reason === 'FACE_OVERLAP',
      suggestedBox: suggestedClass && result.suggested_box ? {
        canonicalClass: suggestedClass,
        displayName: vocabulary.DISPLAY_LABELS[suggestedClass],
        confidence: result.suggested_box.confidence,
        bbox: result.suggested_box.bounding_box
      } : null,
      confidence:
        candidate &&
          candidate.confidence != null &&
          candidate.confidence !== '' &&
          Number.isFinite(Number(candidate.confidence))
          ? Number(candidate.confidence)
          : null,
      accepted,
      detections,
      boxes: accepted ? eligible : [],
      imageSize: result.image_size || null,
      triage: accepted ? result.triage || null : null,
      reportCategory: result.report_category || null,
      modelInfo: result.model_info || null,
      modelName: result.model || null,
      error: null,
      rawResult: result
      , assessmentProof: result.assessmentProof || null,
      correctionCategories: result.correctionCategories || []
    };
  }

  function previewBoxesFor(photo, state, previewClass) {
    if (state === STATES.DETECTED) return photo.boxes;
    if (state === STATES.EVIDENCE_REVIEW_REQUIRED && photo.singlePhotoPreview && photo.suggestedBox) {
      return [{ ...photo.suggestedBox, eligible: false }];
    }
    if (!previewClass) return [];
    const candidates = photo.suggestedBox ? [photo.suggestedBox] : photo.detections;
    const best = candidates
      .filter(box => box.canonicalClass === previewClass && Number.isFinite(box.confidence) &&
        box.bbox?.width > 0 && box.bbox?.height > 0)
      .sort((a, b) => b.confidence - a.confidence)[0];
    return best ? [{ ...best, eligible: false }] : [];
  }

  function pairState(photos) {
    const blocked = BLOCKED.find(state => photos.some(photo => photo.state === state));
    if (blocked) return blocked;
    if (photos.some(photo => photo.state === STATES.EVIDENCE_REVIEW_REQUIRED)) return STATES.EVIDENCE_REVIEW_REQUIRED;
    if (photos.some((photo) => photo.state === STATES.AI_SERVICE_ERROR)) return STATES.AI_SERVICE_ERROR;
    const withClass = photos.filter((photo) => photo.canonicalClass);
    if (!withClass.length) {
      return photos.some((photo) => photo.state === STATES.UNSUPPORTED)
        ? STATES.UNSUPPORTED
        : photos.some((photo) => photo.state === STATES.LOW_CONFIDENCE)
          ? STATES.LOW_CONFIDENCE
          : STATES.NO_DETECTION;
    }
    if (withClass.length !== photos.length) return STATES.PAIR_MISMATCH;
    if (new Set(withClass.map((photo) => photo.canonicalClass)).size !== 1) return STATES.PAIR_MISMATCH;
    return photos.every((photo) => photo.state === STATES.DETECTED && photo.accepted)
      ? STATES.DETECTED
      : STATES.LOW_CONFIDENCE;
  }

  function modelOf(photos) {
    const source = photos.find((photo) => photo.modelInfo) || null;
    const info = source ? source.modelInfo : null;
    const fallbackName = photos.find((photo) => photo.modelName)?.modelName || null;
    const name = info?.name || fallbackName;
    const releaseLabel = info?.release_label || info?.version || null;
    const label = [name, releaseLabel].filter(Boolean).join(', ') || null;
    return {
      name,
      version: info?.version || null,
      releaseLabel,
      checkpoint: info?.checkpoint || null,
      targetEligible: typeof info?.target_eligible === 'boolean' ? info.target_eligible : null,
      label,
      displayName: vocabulary?.aiModelDisplayName(label, info) ?? label
    };
  }

  function summaryFor(state, photos, displayName, weakDisagreement) {
    const described = photos
      .map(
        (photo) =>
          `Photo ${photo.index + 1}: ${photo.displayName || STATE_LABELS[photo.state] || photo.state}`
      )
      .join('; ');
    switch (state) {
      case STATES.DETECTED:
        return `${displayName} detected in both photos.`;
      case STATES.LOW_CONFIDENCE:
        return displayName
          ? `Both photos suggest ${displayName}. At least one photo did not meet the detection requirements. The report will go to Barangay review.`
          : 'The model returned low-confidence results without a supported candidate class. Report will be routed for manual barangay review.';
      case STATES.PAIR_MISMATCH:
        return weakDisagreement
          ? 'The AI could not verify the damage from these photos. Describe the issue for Barangay review or retake the photos.'
          : `The AI returned different assessments for these photos (${described}). Report will be routed for manual barangay review.`;
      case STATES.NO_DETECTION:
        return 'The model found no supported damage in either photo. Report will be routed for manual barangay review.';
      case STATES.UNSUPPORTED:
        return 'The model returned a class outside the supported damage categories. Report will be routed for manual barangay review.';
      case STATES.AUTH_ERROR:
        return (
          photos.find((photo) => photo.state === STATES.AUTH_ERROR)?.error || 'Authentication is required.'
        );
      case STATES.VALIDATION_ERROR:
        return (
          photos.find((photo) => photo.state === STATES.VALIDATION_ERROR)?.error ||
          'A selected photo is invalid.'
        );
      case STATES.INVALID_EVIDENCE:
      case STATES.DUPLICATE_EVIDENCE:
        return photos.find(photo => photo.state === state).error;
      case STATES.EVIDENCE_REVIEW_REQUIRED:
        return 'The AI could not confirm the damage from these photos. Retake them or submit for manual Barangay review.';
      default:
        return photos.find((photo) => photo.error)?.error || 'The AI service could not assess the photos.';
    }
  }

  function assessPair(entries, sceneMatch = null) {
    const photos = (Array.isArray(entries) ? entries : []).slice(0, 2).map(photoOf);
    while (photos.length < 2) photos.push(photoOf(null, photos.length));
    const state = pairState(photos);
    const weakDisagreement = state === STATES.PAIR_MISMATCH && photos.some(photo => !photo.accepted);
    const sameClass = Boolean(
      photos[0].canonicalClass && photos[0].canonicalClass === photos[1].canonicalClass
    );
    const [firstHint, secondHint] = photos.map(photo => photo.suggestedClass || photo.canonicalClass);
    const previewClass = [STATES.LOW_CONFIDENCE, STATES.EVIDENCE_REVIEW_REQUIRED].includes(state) &&
      vocabulary.isCanonicalDamageCategory(firstHint) && firstHint === secondHint &&
      !photos.some(photo => photo.faceOverlap || photo.singlePhotoPreview) ? firstHint : null;
    const suggestion = previewClass ? {
      canonicalClass: previewClass,
      displayName: vocabulary.displayLabelFor(previewClass),
      category: vocabulary.reportCategoryFor(previewClass)
    } : null;
    const agreed = state === STATES.DETECTED || state === STATES.LOW_CONFIDENCE;
    const canonicalClass = agreed ? photos[0].canonicalClass : null;
    const displayName = agreed ? photos[0].displayName : null;
    const scores = (canonicalClass || suggestion)
      ? photos.map(photo => photo.suggestedConfidence ?? photo.confidence) : [];
    const confidence = scores.length === 2 && scores.every(Number.isFinite)
      ? Math.round(((scores[0] + scores[1]) / 2) * 10000) / 10000 : null;
    const pairReason = Array.isArray(entries) && entries.some(entry => entry?.pairReviewReason === 'SIMILAR_VIEWS')
      ? 'SIMILAR_VIEWS' : null;
    const reviewReasons = [STATES.EVIDENCE_REVIEW_REQUIRED, STATES.LOW_CONFIDENCE].includes(state)
      ? [...new Set([pairReason, ...photos.map(photo => photo.evidenceReason ||
        (!pairReason && photo.state === STATES.EVIDENCE_REVIEW_REQUIRED ? STATES.EVIDENCE_REVIEW_REQUIRED : null))].filter(Boolean))]
        .map(code => {
          const slots = photos.filter(photo => photo.evidenceReason === code);
          const message = code === 'PHOTO_SUITABILITY_UNCERTAIN' && slots.length === 1
            ? `Photo ${slots[0].index + 1} may be unsuitable. Retake it or send it for Barangay review.`
            : REVIEW_REASONS[code];
          return { code, message };
        }) : [];
    const lead =
      state === STATES.DETECTED ? photos.slice().sort((a, b) => b.confidence - a.confidence)[0] : null;
    const detected = state === STATES.DETECTED;
    const suppliedSeverity = entries?.[0]?.severitySuggestion;
    const severitySuggestion = detected && suppliedSeverity?.source === 'approved_measurement_rule' &&
      suppliedSeverity.category === canonicalClass && ['MAJOR', 'MINOR'].includes(suppliedSeverity.classification)
      ? suppliedSeverity : null;
    const model = modelOf(photos);
    const sameReportCategory = Boolean(
      photos[0].reportCategory && photos[0].reportCategory === photos[1].reportCategory
    );
    const evidenceFlagged = [STATES.INVALID_EVIDENCE, STATES.DUPLICATE_EVIDENCE, STATES.EVIDENCE_REVIEW_REQUIRED].includes(state);
    const previewSceneMatch = state === STATES.EVIDENCE_REVIEW_REQUIRED && previewClass ? sceneMatch : null;
    if (evidenceFlagged) {
      sceneMatch = null;
      for (const photo of photos) photo.boxes = [];
    }
    for (const photo of photos) {
      photo.previewBoxes = previewBoxesFor(photo, state, previewClass).map(box => ({
        ...box, confidenceLevel: confidenceLevel(box.confidence)
      }));
    }
    const sceneAdvisory = evidenceFlagged ? null :
      !sceneMatch || !Number.isFinite(sceneMatch.score)
        ? 'Scene comparison is unavailable. The photos have not been verified as the same scene.'
        : sceneMatch.matched
          ? null
          : 'The AI could not verify a scene match from these views. This advisory does not block submission.';

    return {
      state,
      stateLabel: weakDisagreement ? 'Damage unverified' : STATE_LABELS[state],
      weakDisagreement,
      evidenceFlagged,
      detected,
      inconclusive: !detected,
      suggestion,
      reviewReasons,
      canonicalClass,
      displayName,
      category:
        agreed &&
          sameClass &&
          photos[0].reportCategory &&
          photos[0].reportCategory === photos[1].reportCategory
          ? photos[0].reportCategory
          : null,
      severitySuggestion,
      severityReason: entries?.[0]?.severityReason ?? null,
      classification: severitySuggestion?.classification ?? null,
      priority: severitySuggestion?.priority ?? null,
      confidence,
      confidencePercent: percent(confidence),
      confidenceLevel: confidenceLevel(confidence),
      sameClass,
      sameReportCategory,
      sharedReportCategory: sameReportCategory ? photos[0].reportCategory : null,
      provisionalAgreement: Boolean(suggestion),
      agreement: agreed && sameClass,
      sceneMatch: sceneMatch || null,
      previewSceneMatch,
      sceneAdvisory,
      photos,
      model,
      summary: summaryFor(state, photos, displayName, weakDisagreement),
      submittable: !BLOCKED.includes(state)
    };
  }

  return { STATES, STATE_LABELS, assessPair, percent, confidenceLevel };
});
