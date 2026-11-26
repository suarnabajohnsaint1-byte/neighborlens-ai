const { AppError, ErrorKind, PersistenceError } = require('../../../domain/errors');

function communityError(error, message) {
  if (error instanceof AppError) return error;
  if (error?.code === 'ER_NO_SUCH_TABLE' && /\bcommunity_publication_(requests|media|reviews|legacy)\b/.test(error.sqlMessage || error.message || '')) {
    return new AppError('Community publication is temporarily unavailable. An administrator must complete the database setup.', ErrorKind.PROVIDER_UNAVAILABLE, { code: 'COMMUNITY_SETUP_REQUIRED' });
  }
  return new PersistenceError(message);
}

module.exports = communityError;
