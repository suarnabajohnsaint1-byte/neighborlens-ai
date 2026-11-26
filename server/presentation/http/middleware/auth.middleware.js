const { authService } = require('../../../composition');
const { AppError } = require('../../../domain/errors');

const LIMITED_ACCOUNT_ROUTES = new Set([
  'GET /api/me', 'GET /api/auth/me/account', 'GET /api/identity/me', 'GET /api/reports',
  'POST /api/auth/me/password', 'POST /api/auth/logout'
]);

function rejectLimitedAccount(res) {
  return res.status(403).json({ error: 'This action requires a verified account.', code: 'IDENTITY_VERIFICATION_REQUIRED' });
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function rejectUnauthenticated(res, error) {
  const message = error instanceof AppError ? error.message : 'Invalid or expired token.';
  return res.status(401).json({ error: message, message });
}

async function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = await authService.authenticateToken(token);
  } catch (error) {
    if (error instanceof AppError) return rejectUnauthenticated(res, error);
    return next(error);
  }
  if (req.user.accountStatus === 'ACTIVE_LIMITED' &&
      !LIMITED_ACCOUNT_ROUTES.has(`${req.method} ${req.originalUrl.split('?')[0]}`)) {
    return rejectLimitedAccount(res);
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}

function requireStreamTicket(ticketStore) {
  return async (req, res, next) => {
    const claims = ticketStore.consume(req.query?.ticket);
    if (!Number.isFinite(claims?.expiresAt) || claims.expiresAt <= Date.now()) {
      return res.status(401).json({ error: 'Stream ticket is missing, used, or expired.' });
    }
    try {
      req.user = await authService.resolveSession(claims);
      req.sessionExpiresAt = claims.expiresAt;
    } catch (error) {
      if (error instanceof AppError) return rejectUnauthenticated(res, error);
      return next(error);
    }
    if (req.user.accountStatus === 'ACTIVE_LIMITED') return rejectLimitedAccount(res);
    return next();
  };
}

module.exports = { requireAuth, requireRole, requireStreamTicket };
