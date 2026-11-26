const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const jwt = require('jsonwebtoken');
const tokens = require('../infrastructure/security/tokenProvider');
const env = require('../infrastructure/config/env');
const { createRequestRateLimit } = require('../presentation/http/middleware/requestRateLimit.middleware');
const { createUploadCapacity } = require('../presentation/http/middleware/uploadCapacity.middleware');
function response() {
  const value = new EventEmitter();
  value.set = () => value; value.status = code => { value.code = code; return value; }; value.json = body => { value.body = body; return value; };
  return value;
}
test('upload capacity rejects excess in-flight work and releases exactly once on disconnect or finish', () => {
  const middleware = createUploadCapacity(1);
  const first = response(); let accepted = 0;
  middleware({}, first, () => accepted++);
  const blocked = response(); middleware({}, blocked, () => accepted++);
  assert.equal(blocked.code, 429); assert.equal(accepted, 1);
  first.emit('close'); first.emit('finish');
  const second = response(); middleware({}, second, () => accepted++);
  const stillBlocked = response(); middleware({}, stillBlocked, () => accepted++);
  assert.equal(stillBlocked.code, 429); assert.equal(accepted, 2);
  second.emit('finish'); middleware({}, response(), () => accepted++); assert.equal(accepted, 3);
});
test('request limits cannot be bypassed with spoofed forwarded addresses and recover after expiry', () => {
  let now = 0; const limit = createRequestRateLimit({ maximum: 1, clock: () => now });
  const request = address => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': address } });
  let accepted = 0; limit(request('1.2.3.4'), response(), () => accepted++);
  const denied = response(); limit(request('9.8.7.6'), denied, () => accepted++);
  assert.equal(denied.code, 429); now = 60001; limit(request('9.8.7.6'), response(), () => accepted++); assert.equal(accepted, 2);
});
test('session tokens pin the algorithm and reject wrong purpose while retaining existing issuerless legacy sessions', () => {
  const user = { id: 5, username: 'fictional', role: 'citizen' };
  const issued = tokens.issue(user); const decoded = tokens.verify(issued);
  assert.equal(decoded.iss, 'neighborlens-api'); assert.equal(decoded.aud, 'neighborlens-session');
  const legacy = jwt.sign(user, env.JWT_SECRET, { expiresIn: '1m' }); assert.equal(tokens.verify(legacy).id, 5);
  for (const options of [{ algorithm: 'HS384' }, { issuer: 'wrong' }, { audience: 'neighborlens-report-assessment' }]) assert.throws(() => tokens.verify(jwt.sign(user, env.JWT_SECRET, { expiresIn: '1m', ...options })));
  assert.throws(() => tokens.verify(tokens.issueAssessment({ id: 5 })));
});
test('production refuses known development JWT signing defaults', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server/infrastructure/config/env')"], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'neighborlens-dev-secret' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /JWT_SECRET/);
});

test('production rejects known insecure JWT secrets longer than 32 characters', () => {
  const longInsecureSecrets = [
    'this-is-a-jwt-secret-that-is-definitely-not-secure-and-everyone-knows-it',
    'please-dont-use-this-as-your-jwt-secret-it-is-insecure',
    'use-something-more-secure-instead-of-this-example-secret',
  ];

  for (const secret of longInsecureSecrets) {
    const result = spawnSync(process.execPath, ['-e', `require('./server/infrastructure/config/env')`, { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret }, encoding: 'utf8' }]);
    assert.notEqual(result.status, 0, `Expected ${secret} to be rejected in production`);
    assert.match(result.stderr, /JWT_SECRET/, `Expected error mentioning JWT_SECRET for ${secret}`);
  }
});

test('production accepts custom secure JWT secrets longer than 32 characters', () => {
  const secureSecrets = [
    'a'.repeat(64),
    'MySuperSecureSecretKey1234567890ab',
    'another-very-secure-and-private-jwt-signing-key',
  ];

  for (const secret of secureSecrets) {
    const result = spawnSync(process.execPath, ['-e', `require('./server/infrastructure/config/env')`, { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret }, encoding: 'utf8' }]);
    assert.equal(result.status, 0, `Expected ${secret.substring(0, 20)}... to be accepted in production`);
  }
});

test('production rejects known insecure JWT secrets case-insensitively', () => {
  const insecureSecrets = ['SECRET', 'SUPER-SECRET', 'Jwt-Secret'];

  for (const secret of insecureSecrets) {
    const result = spawnSync(process.execPath, ['-e', `require('./server/infrastructure/config/env')`, { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret }, encoding: 'utf8' }]);
    assert.notEqual(result.status, 0, `Expected ${secret} (case-insensitive) to be rejected in production`);
  }
});

test('missing persona rows never derive public attribution or avatars from private account IDs', () => {
  const rules = require('../domain/community/community.rules');
  for (const id of [1, 42, 99999]) {
    const author = rules.author({ is_official: false, author_id: id, post_id: 12 });
    assert.equal(author.pseudonym, 'Anonymous resident'); assert.equal(author.avatarVariant, 0);
  }
  const source = require('node:fs').readFileSync(require.resolve('../infrastructure/security/communityPersona'), 'utf8');
  assert.match(source, /randomInt/); assert.doesNotMatch(source, /userId|postId|Math\.random/);
});

test('role changes between credential validation and session issuance cannot create a wrong-portal token', async () => {
  const repository = require('../infrastructure/repositories/user.repository');
  const { authService: service } = require('../composition');
  const audit = require('../application/use-cases/audit.service');
  const hasher = require('../infrastructure/security/passwordHasher');
  const previous = { findByUsername: repository.findByUsername, findSessionState: repository.findSessionState, audit: audit.writeAudit };
  repository.findByUsername = async () => ({ id: 5, role: 'citizen', status: 'active', password_hash: hasher.hash('Fixture1234') });
  repository.findSessionState = async () => ({ id: 5, role: 'admin', status: 'active' });
  audit.writeAudit = async () => {};
  try { await assert.rejects(service.login('fictional', 'Fixture1234', 'citizen'), /Invalid username or password/); }
  finally { repository.findByUsername = previous.findByUsername; repository.findSessionState = previous.findSessionState; audit.writeAudit = previous.audit; }
});

test('registration rejects malformed payloads and bcrypt-truncated password inputs before persistence', async () => {
  const { authService: service } = require('../composition');
  for (const input of [null, [], { username: 'fictional', password: 'a'.repeat(73) }, { username: 'fictional', password: '\u00e9'.repeat(40) }]) await assert.rejects(service.registerCitizen(input), /Registration must|72 UTF-8 bytes/);
});
