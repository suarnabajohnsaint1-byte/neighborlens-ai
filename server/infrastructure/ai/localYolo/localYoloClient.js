const { DamageDetectionError } = require('../../../domain/errors');
const { MESSAGE, STATUS } = require('../../../domain/reports/evidenceSuitability.rules');
const env = require('../../config/env');

async function postMultipart(endpoint, parts, timeoutMs) {
  if (process.env.VERCEL && (!endpoint.startsWith('https://') || env.INFERENCE_SHARED_SECRET.length < 32)) {
    throw new DamageDetectionError('Secure inference service is not configured.', 'INFERENCE_NOT_CONFIGURED', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    for (const [name, value] of parts) {
      if (value && value.buffer) {
        form.append(name, new Blob([value.buffer], { type: value.mimeType }), value.filename);
      } else {
        form.append(name, value);
      }
    }
    const headers = env.INFERENCE_SHARED_SECRET ? { 'X-Inference-Key': env.INFERENCE_SHARED_SECRET } : {};
    const response = await fetch(endpoint, { method: 'POST', body: form, headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 422) {
      if (payload.detail?.code === STATUS.INVALID) {
        throw new DamageDetectionError('No supported issue was detected. Retake the photo with the infrastructure issue clearly visible.', STATUS.INVALID, 422);
      }
      if (payload.detail?.code === STATUS.DUPLICATE) {
        throw new DamageDetectionError(MESSAGE[STATUS.DUPLICATE], STATUS.DUPLICATE, 422);
      }
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

async function requestLocalYoloInference(buffer, mimeType, options = {}) {
  const { response, payload } = await postMultipart(options.endpoint, [
    ['image', { buffer, mimeType, filename: 'damage-image' }],
    ['task', options.task || 'detect']
  ], options.timeoutMs || 15000);

  if (!response.ok) {
    if ([400, 415, 422].includes(response.status)) {
      throw new DamageDetectionError('The inference service could not decode the uploaded image.', 'IMAGE_VALIDATION_ERROR');
    }
    throw new DamageDetectionError('Inference service returned an error.', 'INFERENCE_HTTP', 502);
  }
  return payload;
}

async function requestLocalDualInference(buffer1, mimeType1, buffer2, mimeType2, options = {}) {
  const { response, payload } = await postMultipart(options.endpoint, [
    ['image1', { buffer: buffer1, mimeType: mimeType1, filename: 'damage-image1' }],
    ['image2', { buffer: buffer2, mimeType: mimeType2, filename: 'damage-image2' }]
  ], options.timeoutMs || 15000);

  if (!response.ok) {
    if ([400, 415, 422].includes(response.status)) {
      throw new DamageDetectionError('The inference service could not decode the uploaded images.', 'IMAGE_VALIDATION_ERROR');
    }
    throw new DamageDetectionError(
      'Dual inference service returned an error.',
      'INFERENCE_HTTP',
      502
    );
  }
  return payload;
}

module.exports = { requestLocalYoloInference, requestLocalDualInference };
