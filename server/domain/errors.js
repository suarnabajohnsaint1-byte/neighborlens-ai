// Services and domain rules raise these; only the error middleware maps a kind
// onto an HTTP status.

const ErrorKind = Object.freeze({
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PERSISTENCE_FAILURE: 'PERSISTENCE_FAILURE'
});

class AppError extends Error {
  constructor(message, kind, { code = null, cause = undefined, decision = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    if (code) this.code = code;
    if (decision) this.decision = decision;
    if (cause !== undefined) this.cause = cause;
  }
}

class ValidationError extends AppError {
  constructor(message, options) { super(message, ErrorKind.VALIDATION, options); }
}

class UnauthenticatedError extends AppError {
  constructor(message, options) { super(message, ErrorKind.UNAUTHENTICATED, options); }
}

class ForbiddenError extends AppError {
  constructor(message, options) { super(message, ErrorKind.FORBIDDEN, options); }
}

class NotFoundError extends AppError {
  constructor(message, options) { super(message, ErrorKind.NOT_FOUND, options); }
}

class ConflictError extends AppError {
  constructor(message, options) { super(message, ErrorKind.CONFLICT, options); }
}

class PersistenceError extends AppError {
  constructor(message, options) { super(message, ErrorKind.PERSISTENCE_FAILURE, options); }
}

const KIND_BY_STATUS = Object.freeze({
  400: ErrorKind.VALIDATION,
  401: ErrorKind.UNAUTHENTICATED,
  403: ErrorKind.FORBIDDEN,
  404: ErrorKind.NOT_FOUND,
  422: ErrorKind.UNPROCESSABLE,
  502: ErrorKind.PROVIDER_FAILURE,
  503: ErrorKind.PROVIDER_UNAVAILABLE,
  504: ErrorKind.PROVIDER_TIMEOUT
});

const STATUS_BY_KIND = Object.freeze(
  Object.fromEntries(Object.entries(KIND_BY_STATUS).map(([status, kind]) => [kind, Number(status)]))
);

// `statusCode` is derived, kept for callers that still read it; the error
// middleware remains the authority for the response status.
class DamageDetectionError extends AppError {
  constructor(message, code, statusHint = 400) {
    super(message, KIND_BY_STATUS[statusHint] || ErrorKind.VALIDATION, { code });
    this.name = 'DamageDetectionError';
  }

  get statusCode() {
    return STATUS_BY_KIND[this.kind] || 400;
  }
}

module.exports = {
  ErrorKind,
  KIND_BY_STATUS,
  STATUS_BY_KIND,
  AppError,
  ValidationError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PersistenceError,
  DamageDetectionError
};
