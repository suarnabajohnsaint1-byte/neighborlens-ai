const { getPool, closePool } = require('./pool');
const passwordHasher = require('../../security/passwordHasher');
const createMysqlAdapter = require('./mysqlAdapter');
const { createAdminBootstrapService } = require('../../../application/use-cases/adminBootstrap.service');
const initializationRepository = require('../../repositories/adminInitialization.repository');
const userRepository = require('../../repositories/user.repository');
const userPermissionRepository = require('../../repositories/userPermission.repository');
const auditService = require('../../../application/use-cases/audit.service');
const { checkAdminPassword, MIN_ADMIN_PASSWORD_LENGTH } = require('../../../domain/accounts/account.rules');

const FORBIDDEN_PASSWORDS = new Set(['admin123', 'password', 'changeme', 'administrator']);

function readBootstrapCredentials(env = process.env) {
  const username = String(env.BOOTSTRAP_ADMIN_USERNAME || '').trim();
  const password = String(env.BOOTSTRAP_ADMIN_PASSWORD || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) {
    throw new Error('Set BOOTSTRAP_ADMIN_USERNAME (3 to 64 letters, numbers, dots, dashes, or underscores).');
  }
  if (
    checkAdminPassword(password) ||
    FORBIDDEN_PASSWORDS.has(password.toLowerCase())
  ) {
    throw new Error(`Set BOOTSTRAP_ADMIN_PASSWORD to at least ${MIN_ADMIN_PASSWORD_LENGTH} characters and at most 72 UTF-8 bytes with letters and numbers; default passwords are refused.`);
  }
  return { username, password };
}

async function bootstrapAdmin(pool, env = process.env) {
  return createAdminBootstrapService({
    database: createMysqlAdapter(pool), initializationRepository, userRepository,
    userPermissionRepository, passwordHasher, auditService
  }).initialize(() => readBootstrapCredentials(env));
}

async function main() {
  try {
    const { created, username } = await bootstrapAdmin(getPool());
    console.log(created
      ? `created administrator "${username}"`
      : `administrator "${username}" preserved; initialization recorded; use operator recovery for account changes`);
  } catch (error) {
    console.error(`admin bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main();
}

module.exports = { bootstrapAdmin, readBootstrapCredentials, MIN_ADMIN_PASSWORD_LENGTH };
