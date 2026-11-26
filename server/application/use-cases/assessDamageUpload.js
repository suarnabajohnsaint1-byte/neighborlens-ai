const { ValidationError } = require('../../domain/errors');
const { STATUS } = require('../../domain/reports/evidenceSuitability.rules');

function createDamageUploadAssessment({ aiProvider, damageDetectionService }) {
  return async function assessDamageUpload(files, user, { assessment, photoOrder } = {}) {
    if (!files.length) throw new ValidationError('At least one report image is required.');

    const defaults = aiProvider.detectionDefaults();
    if (assessment === 'pair') {
      if (photoOrder !== undefined) throw new ValidationError('Provide pair evidence without a single photo order.');
      return { batch: await damageDetectionService.assessCitizenPair(files, user, defaults) };
    }
    if (photoOrder !== undefined) {
      if (files.length !== 1) throw new ValidationError('One ordered photo is required for an assessment proof.');
      return { preview: await damageDetectionService.assessCitizenPhoto(files[0], user, photoOrder, defaults) };
    }

    const evidence = await damageDetectionService.checkEvidence(files, { preserveFormatError: true });
    if (evidence.reviewRequired) {
      return { batch: { ok: true, count: 0, primary: null, results: [], status: STATUS.REVIEW } };
    }

    const { minConfidence, model, task } = defaults;
    const results = await Promise.all(files.map(file => damageDetectionService.processDamageImage(file, {
      minConfidence, model, task
    })));
    const primary = damageDetectionService.selectPrimaryResult(results);
    return {
      batch: {
        ok: true,
        count: results.length,
        primary,
        results,
        summary: primary ? {
          model: primary.summary?.model || model,
          task: primary.summary?.task || task,
          damage_type: primary.damage_type,
          confidence_score: primary.confidence_score,
          severity_level: primary.severity_level
        } : null
      }
    };
  };
}

module.exports = { createDamageUploadAssessment };
