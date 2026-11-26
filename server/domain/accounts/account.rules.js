const AccountStatus = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended'
});

const ACCOUNT_STATUSES = Object.freeze(new Set(Object.values(AccountStatus)));

const Permission = Object.freeze({
  ADMIN_CREATE: 'admin:create'
});

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MIN_CITIZEN_PASSWORD_LENGTH = 6;

const OFFICIAL_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const MIN_OFFICIAL_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;
const MAX_FULL_NAME_LENGTH = 190;

function isActive(account) {
  return Boolean(account) && (account.status ?? AccountStatus.ACTIVE) === AccountStatus.ACTIVE;
}

function normalizeStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ACCOUNT_STATUSES.has(status) ? status : null;
}

function checkOfficialUsername(username) {
  if (!OFFICIAL_USERNAME_PATTERN.test(username)) {
    return 'Username must be 3 to 64 characters using letters, numbers, dots, dashes, or underscores.';
  }
  return null;
}

function checkOfficialPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_OFFICIAL_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_OFFICIAL_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} UTF-8 bytes.`;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  return null;
}

function checkAdminPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `Administrator passwords must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`;
  }
  return checkOfficialPassword(password);
}

function checkPasswordForRole(role, password) {
  if (role === 'admin') return checkAdminPassword(password);
  if (role === 'barangay') return checkOfficialPassword(password);
  if (typeof password !== 'string' || password.length < MIN_CITIZEN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_CITIZEN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} UTF-8 bytes.`;
  return null;
}

function parseAccountVersion(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number(text);
}

function checkFullName(fullName) {
  if (fullName.length > MAX_FULL_NAME_LENGTH) {
    return `Full name must be at most ${MAX_FULL_NAME_LENGTH} characters.`;
  }
  return null;
}

function sessionMatchesAccount(claims, account) {
  return Boolean(account) &&
    Number(claims?.id) === Number(account.id) &&
    claims.role === account.role &&
    Number(claims.tv ?? 0) === Number(account.token_version ?? 0);
}

module.exports = {
  Permission,
  MIN_ADMIN_PASSWORD_LENGTH,
  checkAdminPassword,
  checkPasswordForRole,
  parseAccountVersion,
  AccountStatus,
  ACCOUNT_STATUSES,
  MIN_OFFICIAL_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_FULL_NAME_LENGTH,
  isActive,
  normalizeStatus,
  checkOfficialUsername,
  checkOfficialPassword,
  checkFullName,
  sessionMatchesAccount
};
