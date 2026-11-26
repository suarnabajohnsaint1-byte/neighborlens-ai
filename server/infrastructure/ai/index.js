const env = require('../config/env');
const { DamageDetectionError } = require('../../domain/errors');
const { requestLocalYoloInference, requestLocalDualInference } = require('./localYolo/localYoloClient');
const { getRoboflowEndpoint, isRoboflowEndpoint, requestRoboflowInference } = require('./roboflow/roboflowClient');

const DEFAULT_LOCAL_ENDPOINT = process.env.VERCEL ? '' : 'http://127.0.0.1:8000/predict';
const DEFAULT_PAIR_ENDPOINT = process.env.VERCEL ? '' : 'http://127.0.0.1:8000/api/v1/damage/verify-pair';
const DEFAULT_TIMEOUT_MS = 15_000;

function singleImageEndpoint(explicitEndpoint) {
  const providerDefault = env.DAMAGE_INFERENCE_PROVIDER === 'local'
    ? (env.DAMAGE_INFERENCE_URL || DEFAULT_LOCAL_ENDPOINT)
    : (getRoboflowEndpoint() || env.DAMAGE_INFERENCE_URL || DEFAULT_LOCAL_ENDPOINT);

  return explicitEndpoint || env.DAMAGE_INFERENCE_URL || providerDefault;
}

function pairEndpoint(explicitEndpoint) {
  let endpoint = explicitEndpoint || env.DAMAGE_PAIR_INFERENCE_URL;
  if (!endpoint && env.DAMAGE_INFERENCE_URL) {
    endpoint = `${env.DAMAGE_INFERENCE_URL.replace(/\/predict\/?$/, '')}/api/v1/damage/verify-pair`;
  }
  return endpoint || DEFAULT_PAIR_ENDPOINT;
}

// Keeps fetch/abort errors and the endpoint URL out of anything a service can
// surface to an API client.
function asDetectionError(error, label) {
  if (error.name === 'AbortError') {
    return new DamageDetectionError(`${label} request timed out.`, 'INFERENCE_TIMEOUT', 504);
  }
  if (error instanceof DamageDetectionError) return error;
  return new DamageDetectionError(`${label} request failed: ${error.message}`, 'INFERENCE_NETWORK', 502);
}

async function requestInference(buffer, mimeType, options = {}) {
  const endpoint = singleImageEndpoint(options.endpoint);
  if (!endpoint) throw new DamageDetectionError('Damage inference endpoint is not configured.', 'INFERENCE_NOT_CONFIGURED', 503);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    return isRoboflowEndpoint(endpoint)
      ? await requestRoboflowInference(buffer, mimeType, { endpoint, timeoutMs })
      : await requestLocalYoloInference(buffer, mimeType, { endpoint, timeoutMs, task: options.task });
  } catch (error) {
    throw asDetectionError(error, 'Inference');
  }
}

async function requestPairInference(buffer1, mimeType1, buffer2, mimeType2, options = {}) {
  const endpoint = pairEndpoint(options.endpoint);
  if (!endpoint) throw new DamageDetectionError('Damage inference endpoint is not configured.', 'INFERENCE_NOT_CONFIGURED', 503);

  try {
    return await requestLocalDualInference(buffer1, mimeType1, buffer2, mimeType2, {
      endpoint,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
    });
  } catch (error) {
    throw asDetectionError(error, 'Dual inference');
  }
}

function detectionDefaults() {
  return {
    provider: env.DAMAGE_INFERENCE_PROVIDER || 'local',
    model: env.DAMAGE_MODEL,
    task: env.DAMAGE_TASK,
    minConfidence: env.DAMAGE_MIN_CONFIDENCE
  };
}

module.exports = { requestInference, requestPairInference, detectionDefaults, singleImageEndpoint, pairEndpoint };
