(function () {
  'use strict';

  const DAMAGE_PATH = '/api/ai/damage';

  class AiClientError extends Error {
    constructor(state, message, status = null, code = null) {
      super(message);
      this.name = 'AiClientError';
      this.state = state;
      this.status = status;
      this.code = code;
    }
  }

  function damageEndpoint() {
    if (typeof window.neighborLensApiUrl !== 'function') {
      throw new AiClientError('AI_SERVICE_ERROR', 'The NeighborLens API base URL is not configured.');
    }
    return window.neighborLensApiUrl(DAMAGE_PATH);
  }

  function sessionToken() {
    const session = typeof window.getSession === 'function' ? window.getSession() : null;
    return session?.apiToken || '';
  }

  async function requestAssessment(form) {
    const token = sessionToken();
    if (!token) {
      throw new AiClientError(
        'AUTH_ERROR',
        'Your session is not signed in to the NeighborLens API. Please log out and sign in again.'
      );
    }

    let response;
    try {
      response = await fetch(damageEndpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
    } catch (error) {
      if (error instanceof AiClientError) throw error;
      throw new AiClientError('AI_SERVICE_ERROR', 'Cannot reach the NeighborLens API.');
    }

    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      throw new AiClientError('AUTH_ERROR', body.error || 'Authentication is required.', response.status);
    }
    if (!response.ok) {
      if ([400, 413, 415, 422].includes(response.status)) {
        const evidenceError = ['INVALID_EVIDENCE', 'DUPLICATE_EVIDENCE'].includes(body.code);
        throw new AiClientError(
          evidenceError ? body.code : 'VALIDATION_ERROR',
          body.error || 'The selected image is invalid.',
          response.status,
          body.code || 'IMAGE_VALIDATION_ERROR'
        );
      }
      const error = new AiClientError(
        'AI_SERVICE_ERROR',
        body.error || `The AI service returned HTTP ${response.status}.`,
        response.status,
        body.code || null
      );
      error.assessmentProof = body.assessmentProof || null;
      error.correctionCategories = body.correctionCategories || [];
      throw error;
    }

    return body;
  }

  function readPhoto(result, assessmentProof, correctionCategories) {
    if (!result || !['DETECTED', 'LOW_CONFIDENCE', 'NO_DETECTION', 'UNSUPPORTED', 'EVIDENCE_REVIEW_REQUIRED'].includes(result.status)) {
      throw new AiClientError('AI_SERVICE_ERROR', 'The AI service returned no assessment.');
    }
    return { ...result, assessmentProof: assessmentProof || null, correctionCategories: correctionCategories || [] };
  }

  async function detectDamage(file, photoOrder = 1) {
    if (!file) throw new AiClientError('AI_SERVICE_ERROR', 'No damage photo was supplied.');
    const form = new FormData();
    form.append('images', file, file.name || 'damage-photo.jpg');
    form.append('photoOrder', String(photoOrder));
    const body = await requestAssessment(form);
    return readPhoto(body.primary || body.results?.[0], body.assessmentProof, body.correctionCategories);
  }

  async function detectPhotos(files) {
    try {
      if (files.length !== 2) throw new AiClientError('VALIDATION_ERROR', 'Take two photos from different angles.');
      const form = new FormData();
      form.append('assessment', 'pair');
      files.forEach((file, index) => form.append('images', file, file.name || `damage-photo-${index + 1}.jpg`));
      const body = await requestAssessment(form);
      if (!Array.isArray(body.photos) || body.photos.length !== 2) {
        throw new AiClientError('AI_SERVICE_ERROR', 'The AI service returned no pair assessment.');
      }
      return body.photos.map(({ result, failure, assessmentProof, correctionCategories }) => failure
        ? { ok: false, error: { state: 'AI_SERVICE_ERROR', message: failure.error, code: failure.code, assessmentProof, correctionCategories } }
        : { ok: true, pairReviewReason: body.pairReviewReason, severitySuggestion: body.severitySuggestion, severityReason: body.severityReason,
            result: readPhoto(result, assessmentProof, correctionCategories) });
    } catch (error) {
      return files.map(() => ({ ok: false, error }));
    }
  }

  window.YoloDamageDetector = { detectDamage, detectPhotos, AiClientError };
})();
