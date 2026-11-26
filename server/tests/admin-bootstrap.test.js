const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminBootstrapService } = require('../application/use-cases/adminBootstrap.service');
const { readBootstrapCredentials } = require('../infrastructure/database/mysql/bootstrapAdmin');
const { readRecoveryRequest } = require('../infrastructure/database/mysql/adminRecovery');
const { checkPasswordForRole } = require('../domain/accounts/account.rules');

function fixture({ initialized = false, existing = null } = {}) {
  const events = [];
  const service = createAdminBootstrapService({
    database: { withTransaction: async work => { events.push('begin'); const result = await work({ fixture: true }); events.push('commit'); return result; } },
    initializationRepository: {
      lock: async tx => { assert.ok(tx.fixture); events.push('lock'); return { initialized_at: initialized ? '2026-10-19' : null }; },
      complete: async (id, source, tx) => { assert.ok(tx.fixture); events.push(['complete', id, source]); }
    },
    userRepository: {
      findAccountsByRole: async (role, tx) => { assert.equal(role, 'admin'); assert.ok(tx.fixture); return existing ? [existing] : []; },
      create: async (data, tx) => { assert.ok(tx.fixture); assert.equal(data.passwordHash, 'fixture-hash'); events.push(['create', data.role]); return { insertId: 42 }; }
    },
    userPermissionRepository: { grant: async (id, permission, actor, tx) => { assert.ok(tx.fixture); events.push(['grant', id, permission, actor]); } },
    passwordHasher: { hash: value => { assert.equal(value, 'FictionalPassword2026!'); return 'fixture-hash'; } },
    auditService: { writeAudit: async (actor, action, entity, id, tx) => { assert.ok(tx.fixture); events.push(['audit', actor, action, entity, id]); } }
  });
  return { service, events };
}

test('bootstrap initializes through the shared repositories in one locked transaction', async () => {
  const { service, events } = fixture();
  assert.deepEqual(await service.initialize(() => ({ username: 'fictional_operator', password: 'FictionalPassword2026!' })), { created: true, username: 'fictional_operator' });
  assert.deepEqual(events, ['begin', 'lock', ['create', 'admin'], ['grant', 42, 'admin:create', null], ['complete', 42, 'bootstrap'], ['audit', null, 'admin_bootstrap', 'user', 42], 'commit']);
});

test('initialized bootstrap refuses before reading credentials or changing accounts', async () => {
  const { service, events } = fixture({ initialized: true });
  await assert.rejects(service.initialize(() => { throw new Error('Credentials must not be read'); }), /already initialized/);
  assert.deepEqual(events, ['begin', 'lock']);
});

test('legacy Admin discovered after migration is preserved without granting permissions', async () => {
  const { service, events } = fixture({ existing: { id: 7, username: 'legacy_admin' } });
  assert.deepEqual(await service.initialize(() => { throw new Error('Credentials must not be read'); }), { created: false, username: 'legacy_admin' });
  assert.deepEqual(events, ['begin', 'lock', ['complete', 7, 'legacy'], 'commit']);
});

test('bootstrap credentials enforce existing username and shared Admin password rules', () => {
  const valid = { BOOTSTRAP_ADMIN_USERNAME: 'fixture_admin', BOOTSTRAP_ADMIN_PASSWORD: 'FictionalPassword2026!' };
  assert.equal(readBootstrapCredentials(valid).username, 'fixture_admin');
  for (const password of ['admin123', '123456789012', 'onlylettershere', 'A1' + 'é'.repeat(36)]) {
    assert.throws(() => readBootstrapCredentials({ ...valid, BOOTSTRAP_ADMIN_PASSWORD: password }), /BOOTSTRAP_ADMIN_PASSWORD/);
  }
  assert.throws(() => readBootstrapCredentials({ ...valid, BOOTSTRAP_ADMIN_USERNAME: 'invalid username' }), /BOOTSTRAP_ADMIN_USERNAME/);
});

test('all password mutation policies reject strings beyond bcrypt UTF-8 byte capacity', () => {
  for (const role of ['admin', 'barangay', 'citizen']) {
    assert.match(checkPasswordForRole(role, 'A1' + 'é'.repeat(36)), /72 UTF-8 bytes/);
    assert.equal(checkPasswordForRole(role, 'A1' + 'é'.repeat(35)), null);
  }
});

test('operator recovery requires confirmation, attribution and a byte-safe new password', () => {
  const env = { RECOVERY_OPERATOR: 'Fictional operator', RECOVERY_REASON: 'Isolated recovery validation', RECOVERY_CONFIRM: 'fixture_admin' };
  assert.equal(readRecoveryRequest(['reactivate', 'fixture_admin'], env).command, 'reactivate');
  assert.throws(() => readRecoveryRequest(['reactivate', 'fixture_admin'], { ...env, RECOVERY_CONFIRM: 'other' }), /exact target username/);
  assert.throws(() => readRecoveryRequest(['reactivate', 'fixture_admin'], { ...env, RECOVERY_OPERATOR: '' }), /RECOVERY_OPERATOR/);
  assert.throws(() => readRecoveryRequest(['reset-password', 'fixture_admin'], { ...env, RECOVERY_NEW_PASSWORD: 'A1' + 'é'.repeat(36) }), /72 UTF-8 bytes/);
  assert.throws(() => readRecoveryRequest(['create-admin', 'fixture_admin'], env), /Usage/);
});
