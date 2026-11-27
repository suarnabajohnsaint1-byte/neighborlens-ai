const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const previewPort = process.env.PHASE2_PREVIEW_PORT;
const enrollmentFixture = process.env.NEIGHBORLENS_ENROLLMENT_FIXTURE === '1' && previewPort === '4318';
if (previewPort) process.env.JWT_SECRET = randomBytes(32).toString('hex');
if (enrollmentFixture) {
  process.env.REGISTRATION_FRAUD_SCREENING_ENABLED = 'true';
  process.env.REGISTRATION_VERIFIER_URL = 'http://127.0.0.1:4318/__fixture_verify_id';
  process.env.REGISTRATION_VERIFIER_SECRET = randomBytes(32).toString('hex');
  process.env.REGISTRATION_FRAUD_URL = 'http://127.0.0.1:4318/__fixture_screen_id';
  process.env.REGISTRATION_FRAUD_SECRET = randomBytes(32).toString('hex');
  process.env.REGISTRATION_FINGERPRINT_KEY = randomBytes(32).toString('hex');
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-browser-'));
process.env.TEST_DB_FILE = path.join(directory, 'browser.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.STORAGE_DRIVER = 'local';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.DEMO_CITIZEN_USERNAME = process.env.DEMO_CITIZEN_USERNAME || 'citizen';
process.env.DEMO_CITIZEN_PASSWORD = process.env.DEMO_CITIZEN_PASSWORD || '1';
fs.mkdirSync(process.env.UPLOAD_DIR);

const phase2Browser = process.env.PHASE2_BROWSER === '1';
let rateLimitOffset = 0;
if (phase2Browser) {
  // Advance only rate-limit clocks between cases that share this server.
  const middleware = require('../../server/presentation/http/middleware/requestRateLimit.middleware');
  const createLimit = middleware.createRequestRateLimit;
  middleware.createRequestRateLimit = ({ clock = Date.now, ...options } = {}) =>
    createLimit({ ...options, clock: () => clock() + rateLimitOffset });
}

const { createTestApp, testDatabase, DamageDetectionError } = require('./test-app');
const { installFixtureBarangay, seedCitizen } = require('./citizens');
let phase2Mode = 'pothole';
const app = createTestApp(phase2Browser ? { inference: async () => {
  if (phase2Mode === 'unavailable') throw new DamageDetectionError('Isolated provider failure', 'INFERENCE_NETWORK', 502);
  return { model: 'NeighborLens YOLOv8m neighborlens_yolov8m_v9',
    model_info: {
      name: 'NeighborLens YOLOv8m', architecture: 'YOLOv8m', version: 'neighborlens_yolov8m_v9',
      release_label: 'v9', checkpoint: 'production/best.pt', target_eligible: false
    },
    min_confidence: 0.3,
    ...(phase2Mode === 'pothole' ? { visual_extent: { source: 'opencv_visual_extent', version: '1', category: 'pothole',
      quality: 'EXPERIMENTAL', reason: 'CANDIDATE_MASK_ONLY', region: [20,20,60,60], grid: [60,60],
      features: { candidate_area_px2: 180, crop_fraction: .05, components: 1, largest_component_fraction: 1, threshold_stability_iou: .8 }
    } } : {}),
    image_size: { width: 100, height: 100 },
    detections: phase2Mode === 'none' ? [] : [{
      damage_type: phase2Mode === 'low' ? 'pothole' : phase2Mode,
      confidence_score: phase2Mode === 'low' ? 0.2 : 0.9,
      bounding_box: { x: 20, y: 20, width: 60, height: 60 }
    }] };
} } : {});
app.post('/__fixture_citizen', async (req, res, next) => {
  try {
    const { username, password, barangay, reporting = true } = req.body;
    res.status(201).json(await seedCitizen({ username, password, barangay, reporting }, testDatabase()));
  } catch (error) { next(error); }
});
if (phase2Browser) {
  const { resetNotificationRateLimits } = require('../../server/presentation/http/middleware/rateLimiter.middleware');
  app.post('/__phase2_reset_rate_limits', (_req, res) => {
    rateLimitOffset += 60_000;
    resetNotificationRateLimits();
    res.sendStatus(204);
  });
  app.post('/__phase2_mode', (req, res) => {
    if (!['pothole', 'road_crack', 'clogged_drainage', 'broken_streetlight', 'low', 'none', 'unavailable'].includes(req.body?.mode)) return res.sendStatus(400);
    phase2Mode = req.body.mode;
    res.json({ ok: true });
  });
}
const server = http.createServer((req, res) => {
  if (enrollmentFixture && req.method === 'POST' && ['/__fixture_verify_id', '/__fixture_screen_id'].includes(req.url)) {
    require('./enrollment-verifier-fixture')(req, res);
    return;
  }
  if (previewPort && req.url === '/js/shared/api.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/shared/api.js'), 'utf8');
    res.end(source.replace('const API_BASE_URL = `http://${hostname}:3000`;', 'const API_BASE_URL = window.location.origin;'));
    return;
  }
  app(req, res);
});
Promise.resolve(enrollmentFixture ? installFixtureBarangay('Villamonte', testDatabase()) : null)
  .then(() => server.listen(Number(previewPort || 4318), '127.0.0.1'));
if (process.send) server.once('listening', () => process.send({ port: server.address().port }));
app.post('/__phase1b_shutdown', (req, res) => {
  cleanup();
  res.json({ ok: true });
  stop();
});
let stopping = false;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  testDatabase().close();
  if (
    path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()) &&
    path.basename(directory).startsWith('neighborlens-browser-')
  ) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  cleaned = true;
}
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    cleanup();
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
