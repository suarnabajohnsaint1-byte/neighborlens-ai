const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const sharp = require('sharp');
const { AppError, ErrorKind, ValidationError } = require('../../domain/errors');
const { interpretFraudAssessment } = require('../../domain/identity/idScreening');

function verificationUnavailable() {
  return new AppError('Identity verification is temporarily unavailable. Please try again later.',
    ErrorKind.PROVIDER_UNAVAILABLE, { code: 'REGISTRATION_VERIFICATION_UNAVAILABLE' });
}

function privateEndpoint(endpoint) {
  try {
    const candidate = new URL(endpoint);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname);
    if (loopback && !candidate.username && !candidate.password && !candidate.search && !candidate.hash &&
        ['http:', 'https:'].includes(candidate.protocol)) return candidate;
  } catch {
    // Missing configuration leaves registration closed.
  }
  return null;
}

function captureBody({ frames, captureId }) {
  const body = new FormData();
  body.set('captureId', captureId);
  for (const frame of frames) body.append('frames', new Blob([frame], { type: 'image/jpeg' }), 'capture.jpg');
  return body;
}

async function readSignedAssessment(response, header, secret, captureId, frames) {
  if (!response.ok || !response.body) throw verificationUnavailable();
  const signature = response.headers.get(header) || '';
  if (!/^[a-f0-9]{64}$/.test(signature)) throw verificationUnavailable();
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 4096) throw verificationUnavailable();
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, length);
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw verificationUnavailable();
  const result = JSON.parse(body.toString('utf8'));
  const exactFrames = frames.map(frame => createHash('sha256').update(frame).digest('hex'));
  if (result.captureId !== captureId || !Array.isArray(result.framesSha256) ||
      result.framesSha256.length !== exactFrames.length ||
      !exactFrames.every((hash, index) => hash === result.framesSha256[index])) throw verificationUnavailable();
  return result;
}

function createRegistrationVerifier({ endpoint, secret, fetchImpl = fetch }) {
  const url = privateEndpoint(endpoint);
  return {
    available: Boolean(url && typeof secret === 'string' && secret.length >= 32),
    async verify({ frames, captureId }) {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
          body: captureBody({ frames, captureId }),
          redirect: 'error',
          signal: AbortSignal.timeout(12000)
        });
        return await readSignedAssessment(response, 'x-registration-verifier-signature', secret, captureId, frames);
      } catch {
        // Never log response bodies, images, or extracted fields.
      }
      throw verificationUnavailable();
    }
  };
}

function createFraudAssessmentClient({ endpoint, secret, verifierSecret, fetchImpl = fetch }) {
  const url = privateEndpoint(endpoint);
  const available = Boolean(url && typeof secret === 'string' && secret.length >= 32 && secret !== verifierSecret);
  return {
    available,
    async assess({ frames, captureId }) {
      if (!available) throw verificationUnavailable();
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
          body: captureBody({ frames, captureId }),
          redirect: 'error',
          signal: AbortSignal.timeout(12000)
        });
        const result = await readSignedAssessment(response, 'x-registration-fraud-signature', secret, captureId, frames);
        return interpretFraudAssessment(result);
      } catch (error) {
        throw verificationUnavailable();
      }
    }
  };
}

async function normalizeFrame(bytes) {
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 4_000_000 });
    const { format, width, height } = await image.metadata();
    if (format !== 'jpeg' || Math.min(width, height) < 300) throw new Error();
    return await image.autoOrient().jpeg({ quality: 94 }).toBuffer();
  } catch {
    throw new ValidationError('Capture a clear government ID photo with the live camera.');
  }
}

function createKnownReplayCheck(file) {
  if (!file) return () => false;
  let entries;
  try {
    entries = readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!entries.length || entries.some(digest => !/^[a-f0-9]{64}$/.test(digest))) throw new Error();
  } catch {
    return () => {
      throw new AppError('The ID fraud check is temporarily unavailable.',
        ErrorKind.PROVIDER_UNAVAILABLE, { code: 'REGISTRATION_FRAUD_UNAVAILABLE' });
    };
  }
  const digests = new Set(entries);
  return frame => digests.has(createHash('sha256').update(frame).digest('hex'));
}

module.exports = {
  createRegistrationVerifier, createFraudAssessmentClient, verificationUnavailable, normalizeFrame,
  createKnownReplayCheck, privateEndpoint, captureBody, readSignedAssessment
};
