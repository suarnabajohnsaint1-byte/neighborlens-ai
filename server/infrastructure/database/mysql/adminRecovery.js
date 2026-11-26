const { getPool, closePool } = require('./pool');
const passwordHasher = require('../../security/passwordHasher');
const { checkAdminPassword } = require('../../../domain/accounts/account.rules');

const COMMANDS = Object.freeze(['grant-admin-create', 'reset-password', 'reactivate']);
const MIN_RECOVERY_PASSWORD_LENGTH = 12;

function readRecoveryRequest(argv = process.argv.slice(2), env = process.env) {
  const [command, username] = argv;
  if (!COMMANDS.includes(command) || !username) {
    throw new Error(`Usage: npm run admin:recovery -- <${COMMANDS.join('|')}> <admin-username>`);
  }
  const operator = String(env.RECOVERY_OPERATOR || '').trim();
  const reason = String(env.RECOVERY_REASON || '').trim();
  if (operator.length < 3 || reason.length < 10) {
    throw new Error('Set RECOVERY_OPERATOR (who is acting) and RECOVERY_REASON (at least 10 characters) for the audit trail.');
  }
  if (env.RECOVERY_CONFIRM !== username) {
    throw new Error('Set RECOVERY_CONFIRM to the exact target username to confirm this recovery action.');
  }
  let password = null;
  if (command === 'reset-password') {
    password = String(env.RECOVERY_NEW_PASSWORD || '');
    if (checkAdminPassword(password)) {
      throw new Error(`Set RECOVERY_NEW_PASSWORD to at least ${MIN_RECOVERY_PASSWORD_LENGTH} characters and at most 72 UTF-8 bytes with letters and numbers.`);
    }
  }
  return { command, username, operator, reason, password };
}

async function runRecovery(pool, request) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, username, status FROM users WHERE username = ? AND role = 'admin' FOR UPDATE",
      [request.username]
    );
    if (!rows.length) throw new Error('No administrator account has that username.');
    const target = rows[0];

    if (request.command === 'grant-admin-create') {
      await connection.query(
        `INSERT INTO user_permissions (user_id, permission, granted_by)
         SELECT ?, 'admin:create', NULL FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = 'admin:create')`,
        [target.id, target.id]
      );
    } else if (request.command === 'reset-password') {
      await connection.query(
        `UPDATE users SET password_hash = ?, token_version = token_version + 1, account_version = account_version + 1
         WHERE id = ? AND role = 'admin'`,
        [passwordHasher.hash(request.password), target.id]
      );
    } else {
      await connection.query(
        `UPDATE users SET status = 'active', token_version = token_version + 1, account_version = account_version + 1
         WHERE id = ? AND role = 'admin'`,
        [target.id]
      );
    }

    await connection.query(
      'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details) VALUES (NULL, ?, ?, ?, ?)',
      [`recovery_${request.command.replace(/-/g, '_')}`, 'user', target.id, JSON.stringify({ operator: request.operator, reason: request.reason })]
    );
    await connection.commit();
    return { username: target.username, command: request.command };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function main() {
  try {
    const result = await runRecovery(getPool(), readRecoveryRequest());
    console.log(`recovery ${result.command} completed for administrator "${result.username}"`);
  } catch (error) {
    console.error(`admin recovery failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main();
}

module.exports = { readRecoveryRequest, runRecovery, COMMANDS };
