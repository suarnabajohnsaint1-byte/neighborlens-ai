(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CitizenSubmissionReadiness = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const UploadState = Object.freeze({
        IDLE: 'IDLE',
        PREVIEW_LOADING: 'PREVIEW_LOADING',
        AI_SCANNING: 'AI_SCANNING',
        READY: 'READY',
        ERROR: 'ERROR'
    });

    function readinessError({ photoCount, scanState, assessment, category, description }) {
        if (photoCount !== 2) return 'Report rejected: you must provide exactly 2 issue photos.';
        if (![UploadState.READY, UploadState.ERROR].includes(scanState) || !assessment) {
            return 'Report rejected: both photos must be scanned before submitting.';
        }
        if (!assessment.submittable) {
            if (assessment.state === 'VALIDATION_ERROR') return 'Replace the invalid photo before submitting.';
            if (['INVALID_EVIDENCE', 'DUPLICATE_EVIDENCE'].includes(assessment.state)) return assessment.summary;
            return 'Your NeighborLens API session is missing or expired. Log out and sign in again before submitting.';
        }
        if (!category) return 'Please select an issue category.';
        if (!description?.trim()) return 'Please describe the issue.';
        return null;
    }

    return { UploadState, readinessError };
});
