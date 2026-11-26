const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.env.TEST_DB_FILE) process.env.TEST_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-integration-')), 'test.sqlite');
if (!process.env.UPLOAD_DIR) {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-test-evidence-'));
  process.env.UPLOAD_DIR = evidence;
  process.once('exit', () => {
    if (path.dirname(evidence) === path.resolve(os.tmpdir()) && path.basename(evidence).startsWith('neighborlens-test-evidence-')) fs.rmSync(evidence, { recursive: true, force: true });
  });
}
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.DEMO_CITIZEN_USERNAME = process.env.DEMO_CITIZEN_USERNAME || 'citizen';
process.env.DEMO_CITIZEN_PASSWORD = process.env.DEMO_CITIZEN_PASSWORD || '1';
const { useTestDatabase } = require('../../server/infrastructure/database');
const createSqliteAdapter = require('../../server/infrastructure/database/sqlite/sqliteAdapter');
const { damageDetectionService } = require('../../server/composition');
const { DamageDetectionError } = require('../../server/domain/errors');

// The SQLite adapter is installed here, by hand, before the app is required.
// Nothing in the request path can select it, so a passing test is
// isolated-integration evidence and never MySQL runtime proof.
let sharedDatabase = null;

function testDatabase() {
  if (!sharedDatabase) {
    sharedDatabase = createSqliteAdapter();
    useTestDatabase(sharedDatabase);
  }
  return sharedDatabase;
}

// Stands in for a YOLO service that is not running. Report creation must still
// succeed against it, which is what proves detection is a best-effort step.
function unavailableDetector() {
  return async () => {
    throw new DamageDetectionError('Inference request failed: fetch failed', 'INFERENCE_NETWORK', 502);
  };
}

const originalProcessDamageImage = damageDetectionService.processDamageImage.bind(damageDetectionService);
const originalVerifyDamagePair = damageDetectionService.verifyDamagePair.bind(damageDetectionService);

/**
 * Replaces both provider calls for the whole process.
 *
 * `respond` stands in for single-image inference and receives (buffer, mimeType).
 * `pairRespond` stands in for the dual-image check; when omitted the pair
 * provider behaves as unavailable, which is the state a report is created in
 * when no inference service is running. Returns a restore function.
 */
function stubInference(respond, pairRespond = null) {
  const verifiedFixture = handler => async (...args) => ({ evidence_relevance: 'VERIFIED', ...await handler(...args) });
  damageDetectionService.processDamageImage = (imageInput, options = {}) =>
    originalProcessDamageImage(imageInput, { ...options, inferenceClient: verifiedFixture(respond) });

  damageDetectionService.verifyDamagePair = (first, second, options = {}) => {
    if (!pairRespond) {
      return Promise.reject(new DamageDetectionError('Dual inference request failed: fetch failed', 'INFERENCE_NETWORK', 502));
    }
    return originalVerifyDamagePair(first, second, { ...options, inferenceClient: verifiedFixture(pairRespond) });
  };

  return () => {
    damageDetectionService.processDamageImage = originalProcessDamageImage;
    damageDetectionService.verifyDamagePair = originalVerifyDamagePair;
  };
}

function createTestApp({ inference = unavailableDetector(), pairInference = null } = {}) {
  testDatabase();
  stubInference(inference, pairInference);
  return require('../../server/app');
}

async function startTestServer(options = {}) {
  const app = createTestApp(options);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, () => resolve(listening));
  });
  return { app, server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// Seed existing citizens for tests of unrelated endpoints.
async function seedExistingCitizen({ username, password, barangay }) {
  const users = require('../../server/infrastructure/repositories/user.repository');
  const passwordHasher = require('../../server/infrastructure/security/passwordHasher');
  const { authService } = require('../../server/composition');
  await users.create({ username, passwordHash: passwordHasher.hash(password), barangay, role: 'citizen', fullName: null }, testDatabase());
  return authService.login(username, password, 'citizen');
}

module.exports = {
  createTestApp,
  startTestServer,
  seedExistingCitizen,
  testDatabase,
  stubInference,
  unavailableDetector,
  DamageDetectionError
};
