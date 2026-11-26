const userRepository = require('../../infrastructure/repositories/user.repository');
const passwordHasher = require('../../infrastructure/security/passwordHasher');
const tokenProvider = require('../../infrastructure/security/tokenProvider');
const auditService = require('./audit.service');
const { AppError, PersistenceError, ValidationError, UnauthenticatedError, ForbiddenError, ConflictError } = require('../../domain/errors');
const { isActive, sessionMatchesAccount } = require('../../domain/accounts/account.rules');

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 190;
const MAX_FULL_NAME_LENGTH = 190;
const MAX_BARANGAY_LENGTH = 150;
const MIN_CITIZEN_PASSWORD_LENGTH = 6;
const DEFAULT_CITIZEN_BARANGAY = 'Barangay 1';
const INVALID_CREDENTIALS = 'Invalid username or password.';
const SESSION_ENDED = 'Your session has ended. Please sign in again.';
const ACCOUNT_SUSPENDED = 'This account is suspended. Contact the system administrator.';

let timingHash = null;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asPassword(value) {
  return typeof value === 'string' ? value : '';
}

function assertWithinLimits({ username, fullName, barangay }) {
  if (username.length > MAX_USERNAME_LENGTH) {
    throw new ValidationError(`Username must be at most ${MAX_USERNAME_LENGTH} characters.`);
  }
  if (String(fullName || '').length > MAX_FULL_NAME_LENGTH) {
    throw new ValidationError(`Full name must be at most ${MAX_FULL_NAME_LENGTH} characters.`);
  }
  if (barangay.length > MAX_BARANGAY_LENGTH) {
    throw new ValidationError(`Barangay must be at most ${MAX_BARANGAY_LENGTH} characters.`);
  }
}

function enrollmentStatus(record) {
  if (record.enrollment_tier === 'ACTIVE_LIMITED') return { accountStatus: 'ACTIVE_LIMITED', identityStatus: 'UNVERIFIED' };
  if (record.enrollment_tier === 'FULLY_VERIFIED') return { accountStatus: 'FULLY_VERIFIED', identityStatus: 'VERIFIED' };
  return {};
}

function toSafeUser(record) {
  if (!record) return null;
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    barangay: record.barangay,
    barangay_id: record.barangay_id ?? null,
    ...(record.role === 'citizen' ? { residencyVerified: Boolean(record.residency_confirmed_at) } : {}),
    ...enrollmentStatus(record)
  };
}

function verifyAgainstDecoy(password) {
  if (!timingHash) timingHash = passwordHasher.hash('neighborlens-timing-equalizer');
  passwordHasher.verify(password, timingHash);
}

class AuthService {
  constructor({ citizenEnrollment, getDatabase, citizenIdentityRepository, recordKeys, documentUsed, consumeReview }) {
    Object.assign(this, { citizenEnrollment, getDatabase, citizenIdentityRepository, recordKeys, documentUsed, consumeReview });
  }

  issueToken(user) {
    return tokenProvider.issue(user);
  }

  verifyToken(token) {
    return tokenProvider.verify(token);
  }

  async resolveSession(claims) {
    const account = claims?.id ? await userRepository.findSessionState(claims.id) : null;
    if (!sessionMatchesAccount(claims, account) || !isActive(account)) {
      throw new UnauthenticatedError(SESSION_ENDED);
    }
    return {
      id: account.id,
      username: account.username,
      role: account.role,
      barangay: account.barangay,
      barangayId: account.barangay_id ?? null,
      ...(account.role === 'citizen' ? { residencyVerified: Boolean(account.residency_confirmed_at) } : {}),
      tokenVersion: Number(account.token_version ?? 0),
      ...enrollmentStatus(account)
    };
  }

  async authenticateToken(token) {
    let claims;
    try {
      claims = this.verifyToken(token);
    } catch {
      throw new UnauthenticatedError('Invalid or expired token.');
    }
    const user = await this.resolveSession(claims);
    return { ...user, sessionExpiresAt: claims.exp * 1000 };
  }

  async login(usernameInput, passwordInput, portal = 'citizen') {
    if (!['citizen', 'admin', 'barangay'].includes(portal)) throw new UnauthenticatedError(INVALID_CREDENTIALS);
    const username = trimmed(usernameInput);
    const password = asPassword(passwordInput);

    const account = username ? await userRepository.findByUsername(username) : null;
    if (!account) {
      verifyAgainstDecoy(password);
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
    if (!passwordHasher.verify(password, account.password_hash)) {
      await auditService.writeAudit(null, 'login_failed', 'user', account.id);
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
    if (account.role !== portal) {
      await auditService.writeAudit(null, 'login_failed', 'user', account.id);
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
    if (!isActive(account)) {
      await auditService.writeAudit(account.id, 'login_blocked', 'user', account.id, undefined, { reason: 'suspended' });
      throw new ForbiddenError(ACCOUNT_SUSPENDED, { code: 'ACCOUNT_SUSPENDED' });
    }

    const session = await userRepository.findSessionState(account.id);
    if (!session || session.role !== portal || !isActive(session) || Number(session.token_version ?? 0) !== Number(account.token_version ?? 0)) {
      await auditService.writeAudit(null, 'login_failed', 'user', account.id);
      throw new UnauthenticatedError(INVALID_CREDENTIALS);
    }
    let tokenVersion = Number(session.token_version ?? 0);
    if (portal === 'citizen') {
      await this.getDatabase().withTransaction(async tx => {
        const changed = await userRepository.replaceCitizenSession(account.id, tokenVersion, tx);
        if (!changed.affectedRows) throw new UnauthenticatedError('Your login changed. Sign in again.');
        await auditService.writeAudit(account.id, 'login', 'user', account.id, tx);
      });
      tokenVersion += 1;
    } else await auditService.writeAudit(account.id, 'login', 'user', account.id);
    const safeUser = toSafeUser(session);
    return { token: this.issueToken({ ...safeUser, token_version: tokenVersion }), user: safeUser };
  }

  async registerCitizen(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ValidationError('Registration must be an object.');
    if (['role', 'isAdmin', 'permissions', 'barangayId', 'barangay_id', 'isVerified', 'accountStatus', 'identityStatus', 'enrollmentTier', 'enrollment_tier', 'status', 'token_version'].some(field => Object.hasOwn(payload, field))) throw new ValidationError('Registration contains unsupported account fields.');
    const username = trimmed(payload.username);
    const password = asPassword(payload.password);
    const barangay = trimmed(payload.barangay) || DEFAULT_CITIZEN_BARANGAY;

    if (username.length < MIN_USERNAME_LENGTH) {
      throw new ValidationError(`Username must be at least ${MIN_USERNAME_LENGTH} characters.`);
    }
    if (password.length < MIN_CITIZEN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_CITIZEN_PASSWORD_LENGTH} characters.`);
    }
    if (Buffer.byteLength(password, 'utf8') > 72) throw new ValidationError('Password must be at most 72 UTF-8 bytes.');
    assertWithinLimits({ username, barangay });
    return this.citizenEnrollment.enroll(payload, async ({ facts, keys, reviewId, residence, limited = false }) => {
      const session = await this.getDatabase().withTransaction(async tx => {
        if (limited && await this.documentUsed(facts, tx)) {
          throw new ConflictError('This document is already associated with an account.', { code: 'REGISTRATION_ID_ALREADY_USED' });
        }
        if (reviewId && !await this.consumeReview(reviewId, Date.now(), tx)) {
          throw new ForbiddenError('This review application is no longer available.', { code: 'REGISTRATION_PROOF_REQUIRED' });
        }
        const result = await userRepository.create({
          username, passwordHash: passwordHasher.hash(password), role: 'citizen',
          barangay: residence?.name ?? barangay, barangayId: residence?.id,
          fullName: facts.fullName, enrollmentTier: limited ? 'ACTIVE_LIMITED' : 'FULLY_VERIFIED'
        }, tx);
        const userId = Number(result.insertId);
        await this.recordKeys(userId, keys, tx);
        await this.citizenIdentityRepository.upsert({ ...facts, userId }, tx);
        if (residence && !limited) await userRepository.confirmCitizenResidence(userId, residence, tx);
        await auditService.writeAudit(userId, 'register', 'user', userId, tx, limited ? { identityStatus: 'UNVERIFIED' } : undefined);
        if (reviewId) await auditService.writeAudit(userId, 'activate', 'citizen_enrollment_review', reviewId, tx);
        return userRepository.findSessionState(userId, tx);
      }).catch(error => {
        if (error instanceof AppError) throw error;
        throw new PersistenceError('Registration could not be saved. Please try again.',
          { code: 'REGISTRATION_PERSISTENCE_FAILED' });
      });
      const user = { ...toSafeUser(session), full_name: facts.fullName };
      return { token: this.issueToken({ ...user, token_version: session.token_version }), user,
        identity: { documentValidationStatus: facts.documentValidationStatus } };
    });
  }

  async getAllUsers() {
    return userRepository.findAll();
  }
}

module.exports.createAuthService = dependencies => new AuthService(dependencies);
module.exports.toSafeUser = toSafeUser;
module.exports.MAX_USERNAME_LENGTH = MAX_USERNAME_LENGTH;
module.exports.MAX_FULL_NAME_LENGTH = MAX_FULL_NAME_LENGTH;
module.exports.MAX_BARANGAY_LENGTH = MAX_BARANGAY_LENGTH;
