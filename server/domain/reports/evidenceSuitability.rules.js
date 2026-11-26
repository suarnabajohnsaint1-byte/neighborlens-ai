const { DamageDetectionError } = require('../errors');

const STATUS = Object.freeze({
  PASSED: 'PASSED',
  INVALID: 'INVALID_EVIDENCE',
  DUPLICATE: 'DUPLICATE_EVIDENCE',
  REVIEW: 'EVIDENCE_REVIEW_REQUIRED'
});

const MESSAGE = Object.freeze({
  [STATUS.INVALID]: 'Use clear photos of the infrastructure issue. Replace screenshots, graphics, or blank images.',
  [STATUS.DUPLICATE]: 'These photos appear to be copies of the same view. Retake the issue from two different angles.',
  [STATUS.REVIEW]: 'The photos could not be verified as two suitable views. You can retake them or submit for manual Barangay review.'
});

function suitability({ pixels, width }) {
  let flat = 0;
  let neutral = 0;
  let bright = 0;
  const buckets = new Uint16Array(4096);
  let dominant = 0;
  const count = pixels.length / 3;
  const stride = width * 3;
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 8) neutral++;
    if (Math.min(r, g, b) >= 232) bright++;
    const bucket = ((r >> 4) << 8) + ((g >> 4) << 4) + (b >> 4);
    dominant = Math.max(dominant, ++buckets[bucket]);
    if (i % stride === stride - 3 || i + stride >= pixels.length) continue;
    let uniform = true;
    for (let c = i; c < i + 3; c++) {
      if (Math.abs(pixels[c] - pixels[c + 3]) > 2 || Math.abs(pixels[c] - pixels[c + stride]) > 2) uniform = false;
    }
    if (uniform) flat++;
  }
  const flatShare = flat / ((width - 1) * (count / width - 1));
  const dominantShare = dominant / count;
  const monochromeScreen = neutral / count >= 0.82 && bright / count >= 0.06 && bright / count <= 0.33 && dominantShare >= 0.49 && flatShare >= 0.45;
  if (monochromeScreen) return STATUS.INVALID;
  if (flatShare >= 0.88) {
    const [first, second, third] = buckets.sort().subarray(-3);
    if ((first + second + third) / count >= 0.93) return STATUS.INVALID;
  }
  if (dominantShare >= 0.48 && flatShare >= 0.45) return STATUS.REVIEW;
  return STATUS.PASSED;
}

function compareViews(first, second) {
  const ratio = Math.abs(Math.log(first.aspectRatio / second.aspectRatio));
  if (ratio > 0.07) return STATUS.PASSED;
  let difference = 0;
  let close = 0;
  for (let i = 0; i < first.pixels.length; i += 3) {
    const delta = Math.max(
      Math.abs(first.pixels[i] - second.pixels[i]),
      Math.abs(first.pixels[i + 1] - second.pixels[i + 1]),
      Math.abs(first.pixels[i + 2] - second.pixels[i + 2])
    );
    difference += delta;
    if (delta <= 12) close++;
  }
  const count = first.pixels.length / 3;
  const mean = difference / count;
  const closeShare = close / count;
  if (ratio <= 0.015 && mean <= 4 && closeShare >= 0.96) return STATUS.DUPLICATE;
  if (mean <= 12 && closeShare >= 0.64) return STATUS.REVIEW;
  return STATUS.PASSED;
}

function rejectEvidence(status, photoOrder) {
  const message = photoOrder ? `Photo ${photoOrder}: ${MESSAGE[status]}` : MESSAGE[status];
  throw new DamageDetectionError(message, status, 422);
}

module.exports = { STATUS, MESSAGE, suitability, compareViews, rejectEvidence };
