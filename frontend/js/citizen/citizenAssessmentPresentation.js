(function (root, factory) {
    const commonJS = typeof module === 'object' && module.exports;
    const api = commonJS
        ? factory(require('./damagePairAssessment'), require('../../../shared/reportVocabulary'), require('./citizenSeverityPresentation'))
        : factory(root.DamagePairAssessment, root.ReportVocabulary, root.CitizenSeverityPresentation);
    if (commonJS) module.exports = api;
    else root.CitizenAssessmentPresentation = api;
})(typeof self !== 'undefined' ? self : this, function (assessment, vocabulary, severityPresentation) {
    'use strict';

    function damageLabel(canonicalClass) {
        return vocabulary.isCanonicalDamageCategory(canonicalClass) ? vocabulary.displayLabelFor(canonicalClass) : '';
    }

    function assessmentSummary(result) {
        if (!result.submittable) return result.summary;
        if (result.state === 'AI_SERVICE_ERROR') return 'AI assessment is currently unavailable.';
        if (result.photos.some(photo => photo.faceOverlap)) return 'No conclusive damage detection.';

        const [first, second] = result.photos.map(photo => {
            const canonicalClass = photo.suggestedClass || photo.canonicalClass;
            return {
                canonicalClass,
                label: damageLabel(canonicalClass),
                eligible: photo.suggestedClass ? photo.suggestedEligible || photo.singlePhotoPreview : photo.accepted,
                number: photo.index + 1
            };
        });
        if (first.label && second.label && first.canonicalClass !== second.canonicalClass) {
            return 'The photos suggest different damage types.';
        }
        if (first.label && second.label && first.eligible && second.eligible) {
            return `${first.label} detected in both photos.`;
        }
        const eligible = [first, second].find(photo => photo.label && photo.eligible);
        if (eligible) return `AI suggests ${eligible.label} in Photo ${eligible.number}.`;
        if (first.label && second.label) return `AI suggests ${first.label} in both photos.`;
        return 'No conclusive damage detection.';
    }

    function formatPercent(value) {
        const percent = assessment.percent(value);
        return percent === null ? '' : `${percent}%`;
    }

    function describePhoto(photo, hideCandidate = false) {
        const state = assessment.STATE_LABELS[photo.state] || photo.state;
        if (hideCandidate || ['AUTH_ERROR', 'AI_SERVICE_ERROR', 'VALIDATION_ERROR'].includes(photo.state)) {
            return state;
        }
        if (!photo.canonicalClass) {
            const predictions = (photo.rawResult?.detections || []).map(item => `${item.damage_type || item.class || 'Unknown class'} (${formatPercent(item.confidence_score ?? item.confidence)})`).join(', ');
            return predictions ? `${state}: ${predictions}` : state;
        }
        return `${state}: ${photo.displayName || damageLabel(photo.canonicalClass)} · ${formatPercent(photo.confidence)}`;
    }

    function describeSceneMatch(sceneMatch) {
        if (!sceneMatch || !Number.isFinite(sceneMatch.score)) return 'Not available';
        if (sceneMatch.method === 'grayscale_correlation') return `${sceneMatch.score}% pixel similarity (advisory)`;
        return `${sceneMatch.score}% (${sceneMatch.matched ? 'likely match' : 'match unverified'})`;
    }

    function describeAssessmentPhoto(result, photo) {
        if (photo.accepted || result.suggestion || photo.singlePhotoPreview) {
            const score = photo.suggestedConfidence ?? photo.confidence;
            const name = photo.displayName || result.suggestion?.displayName || damageLabel(photo.canonicalClass || photo.suggestedClass);
            return [name, formatPercent(score), assessment.confidenceLevel(score)].filter(Boolean).join(' · ');
        }
        return describePhoto(photo, result.weakDisagreement);
    }

    const ASSESSMENT_THEMES = {
        DETECTED: 'success',
        LOW_CONFIDENCE: 'warning',
        PAIR_MISMATCH: 'warning',
        UNSUPPORTED: 'warning',
        NO_DETECTION: 'info',
        AUTH_ERROR: 'danger',
        AI_SERVICE_ERROR: 'danger',
        VALIDATION_ERROR: 'danger',
        INVALID_EVIDENCE: 'danger',
        DUPLICATE_EVIDENCE: 'danger',
        EVIDENCE_REVIEW_REQUIRED: 'warning'
    };

    const ASSESSMENT_FOOTERS = {
        AUTH_ERROR: ' Your NeighborLens API session is missing or expired. Log out and sign in again to run the AI assessment and submit reports.',
        AI_SERVICE_ERROR: 'You can retry later or submit for manual barangay review.',
        VALIDATION_ERROR: 'Replace the invalid photo before submitting. No damage assessment was confirmed.'
    };

    function renderAssessment(result, { escapeHtml, priorityBadge }) {
        const summary = assessmentSummary(result);
        const needsReview = result.state === 'EVIDENCE_REVIEW_REQUIRED';
        const suggestion = result.suggestion;
        const hasPreview = Boolean(suggestion || result.photos.some(photo => photo.singlePhotoPreview));
        const confidenceLevel = result.confidenceLevel;
        const isLow = confidenceLevel === 'Low';
        const confidenceTones = { High: 'success', Moderate: 'warning' };
        const confidenceTone = confidenceTones[confidenceLevel];
        const tone = confidenceTone || ASSESSMENT_THEMES[result.state] || ASSESSMENT_THEMES.AI_SERVICE_ERROR;
        const cardAttributes = `class="citizen-assessment" data-assessment-state="${escapeHtml(result.state)}"
            data-assessment-tone="${isLow ? 'neutral' : tone}"`;
        const reasons = result.reviewReasons.map(({ code, message }) =>
            `<p class="citizen-assessment-note" data-review-reason="${escapeHtml(code)}">${escapeHtml(message)}</p>`
        ).join('');
        const evidenceVerified = !needsReview && result.photos.every(photo => photo.evidenceRelevance === 'VERIFIED');
        const similarViews = result.reviewReasons.some(({ code }) => code === 'SIMILAR_VIEWS');
        const evidenceLabel = evidenceVerified ? 'Verified' : similarViews ? 'Needs review' : needsReview || isLow ? 'Pending' : 'Unverified';
        const showEvidenceInDetails = needsReview && hasPreview && !similarViews;
        const evidenceStatus = `<p class="citizen-assessment-note"><span>Evidence verification:</span> <strong>${evidenceLabel}</strong></p>`;
        const severityStatus = severityPresentation.renderSeverity(result, escapeHtml);
        if (result.evidenceFlagged && !hasPreview) {
            return `<div ${cardAttributes} role="status">
                <strong class="citizen-assessment-title">${escapeHtml(needsReview ? 'AI Damage Assessment' : result.stateLabel)}</strong>
                <p class="citizen-assessment-summary">${escapeHtml(summary)}</p>
                ${needsReview ? evidenceStatus : ''}
                ${needsReview ? severityStatus : ''}
                ${reasons}
            </div>`;
        }
        const isError = !result.submittable || result.state === 'AI_SERVICE_ERROR';
        const confidenceText = confidenceLevel ? `${formatPercent(result.confidence)} · ${confidenceLevel}` : 'Unavailable';
        const canonicalClass = suggestion?.canonicalClass || result.canonicalClass;
        const category = suggestion?.category || result.category;
        const damageAgreement = result.provisionalAgreement ? 'Yes (provisional)' : result.agreement ? 'Yes' : 'No';
        const model = result.model || {};
        const modelText = model.displayName
            ? `${model.displayName}${model.targetEligible === false ? ' ' : ''}`
            : 'Not reported';

        const row = (label, value) => `<div><span style="color:var(--text-dim);">${label}:</span> <strong>${escapeHtml(value)}</strong></div>`;
        const title = result.detected ? 'AI evidence consistent'
            : confidenceLevel ? `Overall: ${confidenceText}`
            : result.state === 'LOW_CONFIDENCE' ? 'Low confidence'
                : hasPreview || ['NO_DETECTION', 'AI_SERVICE_ERROR'].includes(result.state) ? ''
                    : result.weakDisagreement ? 'Damage unverified' : result.stateLabel;

        return `
            <div ${cardAttributes}>
                <div class="citizen-assessment-heading">
                    <strong class="citizen-assessment-title">AI Damage Assessment</strong>
                    ${title ? `<span class="citizen-assessment-tone">${escapeHtml(title)}</span>` : ''}
                </div>
                <p class="citizen-assessment-summary">${escapeHtml(summary)}</p>
                ${showEvidenceInDetails ? '' : evidenceStatus}
                ${result.detected ? `<p class="citizen-assessment-note citizen-assessment-tone">Overall AI confidence: ${escapeHtml(confidenceText)}</p>` : ''}
                ${severityStatus}
                ${needsReview ? '' : reasons}
                <details class="citizen-assessment-details">
                  <summary>Detection details</summary>
                  ${showEvidenceInDetails ? evidenceStatus : ''}
                  ${needsReview ? reasons : ''}
                  <div class="citizen-assessment-grid">
                    ${!needsReview && !result.detected ? row('Detection status', result.state === 'AI_SERVICE_ERROR' ? 'AI_UNAVAILABLE' : result.state) : ''}
                    ${row(result.detected ? 'Category' : 'Candidate Category', category || 'Not confirmed')}
                    ${!category && result.sameReportCategory ? row('Shared Report Category', result.sharedReportCategory) : ''}
                    ${row('Class', suggestion?.displayName || result.displayName || damageLabel(canonicalClass))}
                    ${row(result.detected ? 'Canonical Class' : 'Candidate Class', canonicalClass || '')}
                    <div><span style="color:var(--text-dim);">Overall AI confidence:</span> <strong data-confidence-level="${escapeHtml(confidenceLevel)}" class="citizen-assessment-tone">${escapeHtml(confidenceText)}</strong></div>
                    ${result.detected && result.priority ? `<div><span style="color:var(--text-dim);">Priority:</span> ${priorityBadge(result.priority)}</div>` : ''}
                  </div>
                  <div class="citizen-assessment-photos">
                    ${result.photos.map(photo => `<div><span style="color:var(--text-dim);">Photo ${photo.index + 1}:</span> ${escapeHtml(describeAssessmentPhoto(result, photo))}</div>`).join('')}
                    <div><span style="color:var(--text-dim);">Damage Agreement:</span> ${isError ? '' : damageAgreement}</div>
                    <div><span style="color:var(--text-dim);">Scene Match:</span> ${escapeHtml(describeSceneMatch(needsReview ? result.previewSceneMatch : result.sceneMatch))}</div>
                    ${(result.previewSceneMatch || result.sceneMatch)?.method === 'grayscale_correlation' ? '<div>Pixel similarity compares framing and appearance. The physical location and defect identity remain unverified.</div>' : ''}
                    ${result.sceneAdvisory ? `<div data-scene-advisory>${escapeHtml(result.sceneAdvisory)}</div>` : ''}
                    <div><span style="color:var(--text-dim);">Model:</span> ${escapeHtml(modelText)}</div>
                  </div>
                </details>
                ${ASSESSMENT_FOOTERS[result.state] ? `<div class="citizen-assessment-footer citizen-assessment-tone">
                    ${ASSESSMENT_FOOTERS[result.state]}
                    ${result.state === 'AUTH_ERROR' ? `<div style="margin-top:8px;"><button type="button" class="btn-logout" onclick="logout()">Log out and sign in again</button></div>` : ''}
                </div>` : ''}
            </div>`;
    }

    return { assessmentSummary, describeAssessmentPhoto, describeSceneMatch, renderAssessment };
});
