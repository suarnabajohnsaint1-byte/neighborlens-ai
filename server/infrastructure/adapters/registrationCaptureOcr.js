const { AppError, ErrorKind } = require('../../domain/errors');
const { privateEndpoint, captureBody, readSignedAssessment } = require('./registrationVerifier');

function createCaptureOcr({ endpoint, secret, fetchImpl = fetch, warn = console.warn }) {
  const url = privateEndpoint(endpoint);
  function unavailable(reason) {
    warn('Capture OCR unavailable', { reason });
    return new AppError('Server-side ID reading is unavailable. Check the local Identity/OCR service and retry.',
      ErrorKind.PROVIDER_UNAVAILABLE, { code: 'REGISTRATION_CAPTURE_OCR_UNAVAILABLE' });
  }

  return async (frame, captureId) => {
    if (!url || typeof secret !== 'string' || !/^[\x20-\x7e]{32,}$/.test(secret)) {
      throw unavailable('INVALID_CONFIGURATION');
    }
    const frames = [frame];
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        body: captureBody({ frames, captureId }),
        redirect: 'error',
        signal: AbortSignal.timeout(12000)
      });
    } catch (error) {
      throw unavailable(error.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_FAILED');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw unavailable(`HTTP_${response.status}`);
    }
    try {
      const evidence = await readSignedAssessment(response, 'x-registration-ocr-signature', secret, captureId, frames);
      const document = evidence.captureDocument;
      const supportedNumber = typeof document?.idNumber === 'string' &&
        ((document.documentType === 'DRIVERS_LICENSE' && /^[A-Z][0-9]{10}$/.test(document.idNumber)) ||
          (document.documentType === 'PHILSYS' && /^[0-9]{16}$/.test(document.idNumber)));
      if (typeof evidence.searchInterfaceDetected !== 'boolean' || (document !== null && !supportedNumber)) {
        throw new Error();
      }
      return evidence;
    } catch {
      throw unavailable('INVALID_SIGNED_RESPONSE');
    }
  };
}

module.exports = { createCaptureOcr };
