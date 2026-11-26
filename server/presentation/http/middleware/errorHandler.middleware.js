const multer = require('multer');
const { ErrorKind, AppError } = require('../../../domain/errors');

const STATUS_BY_KIND = Object.freeze({
  [ErrorKind.VALIDATION]: 400,
  [ErrorKind.UNAUTHENTICATED]: 401,
  [ErrorKind.FORBIDDEN]: 403,
  [ErrorKind.NOT_FOUND]: 404,
  [ErrorKind.CONFLICT]: 409,
  [ErrorKind.UNPROCESSABLE]: 422,
  [ErrorKind.PROVIDER_FAILURE]: 502,
  [ErrorKind.PROVIDER_UNAVAILABLE]: 503,
  [ErrorKind.PROVIDER_TIMEOUT]: 504,
  [ErrorKind.PERSISTENCE_FAILURE]: 500
});

function errorHandler(error, req, res, next) {
  if (error instanceof multer.MulterError || error.message === 'Unexpected field') {
    return res.status(400).json({ error: 'Upload must be a JPEG, PNG, or WebP image under 5 MB.' });
  }

  if (error instanceof AppError) {
    if (error.code === 'INCIDENT_REVIEW_NOT_READY') console.warn('Incident and routing dependency unavailable.', { code: error.code, migration: '017_incidents_and_routing.sql' });
    const body = { error: error.message, message: error.message };
    if (error.code) body.code = error.code;
    if (error.decision) body.decision = error.decision;
    if (error.screening) body.screening = error.screening;
    return res.status(STATUS_BY_KIND[error.kind] || 500).json(body);
  }

  // Raised by middleware that predates the error vocabulary, such as the
  // multer file filter.
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message, message: error.message });
  }

  // Never leak a stack trace, SQL text, or filesystem path to an API client.
  console.error(error);
  res.status(500).json({ error: 'Unexpected server error.' });
}

module.exports = errorHandler;
module.exports.STATUS_BY_KIND = STATUS_BY_KIND;
