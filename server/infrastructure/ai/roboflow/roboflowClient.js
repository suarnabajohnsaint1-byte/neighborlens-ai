const env = require('../../config/env');
const { DamageDetectionError } = require('../../../domain/errors');

function getRoboflowEndpoint(options = {}) {
  const apiKey = options.apiKey || env.ROBOFLOW_API_KEY;
  const model = options.model || env.ROBOFLOW_MODEL || 'damages-detection-ixvjc-zolih';
  const version = options.version || env.ROBOFLOW_VERSION || '3';
  if (!apiKey) return '';
  return `https://detect.roboflow.com/${encodeURIComponent(model)}/${encodeURIComponent(version)}?api_key=${encodeURIComponent(apiKey)}`;
}

function isRoboflowEndpoint(endpoint) {
  return typeof endpoint === 'string' && endpoint.includes('detect.roboflow.com/');
}

async function requestRoboflowInference(buffer, mimeType, options = {}) {
  const endpoint = options.endpoint || getRoboflowEndpoint(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: buffer,
      headers: { 'Content-Type': mimeType },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));

    // Roboflow reports centre-origin boxes; re-express them as top-left origin
    // so a single normalization path serves both providers.
    if (Array.isArray(payload.predictions)) {
      payload.detections = payload.predictions.map(prediction => ({
        class: prediction.class,
        confidence: prediction.confidence,
        bounding_box: {
          x: Number(prediction.x || 0) - Number(prediction.width || 0) / 2,
          y: Number(prediction.y || 0) - Number(prediction.height || 0) / 2,
          width: Number(prediction.width || 0),
          height: Number(prediction.height || 0)
        }
      }));
      payload.model = payload.model || 'Roboflow Hosted YOLOv8';
      payload.inference_status = 'roboflow_hosted';
    }

    if (!response.ok) {
      throw new DamageDetectionError('Inference service returned an error.', 'INFERENCE_HTTP', 502);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getRoboflowEndpoint, isRoboflowEndpoint, requestRoboflowInference };
