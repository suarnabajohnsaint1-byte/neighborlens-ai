const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const env = require('./infrastructure/config/env');
const registrationFraud = require('./infrastructure/config/registrationFraud');
const { getDatabase } = require('./infrastructure/database');

const authRoutes = require('./presentation/http/routes/auth.routes');
const reportsRoutes = require('./presentation/http/routes/reports.routes');
const aiRoutes = require('./presentation/http/routes/ai.routes');
const adminRoutes = require('./presentation/http/routes/admin.routes');
const identityRoutes = require('./presentation/http/routes/identity.routes');
const notificationRoutes = require('./presentation/http/routes/notification.routes');
const barangayRoutes = require('./presentation/http/routes/barangay.routes');
const communityRoutes = require('./presentation/http/routes/community.routes');
const errorHandler = require('./presentation/http/middleware/errorHandler.middleware');
const { createRegistrationIngress } = require('./presentation/http/middleware/registrationIngress.middleware');
const { createRequestRateLimit } = require('./presentation/http/middleware/requestRateLimit.middleware');

const { PROJECT_ROOT, UPLOAD_URL_PREFIX } = require('./infrastructure/storage/uploadDirectory');

const FRONTEND_ROOT = path.join(PROJECT_ROOT, 'frontend');

const app = express();
if (process.env.VERCEL) app.set('trust proxy', 1);

app.use((req, res, next) => {
  const origin = req.get('Origin');

  const allowed = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const local = process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin || '');

  const disabledOriginCheck = process.env.DISABLE_ORIGIN_CHECK === 'true' && process.env.NODE_ENV === 'development';
  const host = req.get('host');
  // The authenticated tunnel terminates HTTPS and preserves the public Host on its loopback request.
  const sameOrigin = origin === `${req.protocol}://${host}` ||
    (registrationFraud.isolatedEnrollment && registrationFraud.isLoopbackSocket(req) && origin === `https://${host}`);

  if (!disabledOriginCheck && origin && !sameOrigin && !allowed.includes(origin) && !local) {
    return res.status(403).json({ error: 'Origin is not allowed.' });
  }

  res.vary('Origin');
  if (origin) res.header('Access-Control-Allow-Origin', origin);
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'same-origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', createRequestRateLimit({ maximum: 600 }));
app.use(['/api/auth/register', '/api/auth/login', '/api/auth/citizen/login', '/api/auth/admin/login', '/api/auth/barangay/login', '/api/identity'], createRegistrationIngress());
app.use(express.json({ limit: '100kb' }));

const PUBLIC_ROOT_FILES = Object.freeze(new Set([
  'index.html',
  'login.html',
  'admin-login.html',
  'admin-signup.html',
  'barangay-login.html',
  'citizen.html',
  'report-details.html',
  'admin.html',
  'barangay.html',
  'favicon.ico'
]));

app.use('/js', express.static(path.join(FRONTEND_ROOT, 'js')));
app.use('/styles', express.static(path.join(FRONTEND_ROOT, 'styles')));
app.use('/assets', express.static(path.join(FRONTEND_ROOT, 'assets')));
app.use('/components', express.static(path.join(FRONTEND_ROOT, 'components')));
app.use('/shared', express.static(path.join(PROJECT_ROOT, 'shared')));
app.use(UPLOAD_URL_PREFIX, (req, res) => res.status(404).json({ error: 'Use the authorized report attachment endpoint.' }));

app.get('/:page([a-zA-Z0-9_.-]+)', (req, res, next) => {
  const file = req.params.page;
  if (PUBLIC_ROOT_FILES.has(file)) {
    return res.sendFile(path.join(FRONTEND_ROOT, file));
  }
  next();
});

app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/login.htm', (_req, res) => res.redirect('/login.html'));
app.get('/api/health', (req, res) => res.json({
  ok: true, service: 'neighborlens-api',
  ...(registrationFraud.disabled && registrationFraud.basicEnabled && registrationFraud.isLoopbackSocket(req)
    ? { isolatedOcrEnrollment: true } : {})
}));

// Display convenience only. A returned address is NOT evidence that a point
// falls within a given barangay; that question belongs to the geofence service
// and its authoritative polygons.
app.post('/api/config/report-area', require('./presentation/http/middleware/auth.middleware').requireAuth,
  createRequestRateLimit({ maximum: 120 }), async (req, res, next) => {
    try {
      const { latitude, longitude, gpsAccuracy } = req.body || {};
      const resolution = await require('./composition').geofenceService.resolveJurisdiction({
        latitude, longitude, gpsAccuracy, requireCityPolygon: req.user.role === 'citizen'
      });
      res.set('Cache-Control', 'no-store').json({
        status: resolution.status,
        boundaryCheckStatus: resolution.boundaryCheckStatus,
        barangayId: resolution.barangayId,
        boundary: resolution.boundary
      });
    } catch (error) { next(error); }
  });

app.get('/api/config/reverse-geocode', createRequestRateLimit({ maximum: 60 }), async (req, res) => {
  const { lat, lon } = req.query;
  if (typeof lat !== 'string' || typeof lon !== 'string' || !lat.trim() || !lon.trim() || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) {
    return res.status(400).json({ ok: false, error: 'Latitude and longitude are required.' });
  }
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1&accept-language=en`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NeighborLensAI/1.0 (contact@neighborlens.local)' }, signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: 'Reverse geocode upstream failure' });
    }
    return res.json({ ok: true, data: await response.json() });
  } catch (error) {
    // The upstream URL and raw network error stay in the server log.
    console.error('Reverse geocode failed:', error.message);
    return res.status(502).json({ ok: false, error: 'Reverse geocode lookup failed.' });
  }
});

app.use('/api', authRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/identity', identityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/barangays', barangayRoutes);
app.use('/api/community', communityRoutes);

app.use(errorHandler);

// A running server must always mean the real database is behind it, so startup
// fails rather than degrading to another store.
async function assertDatabaseReachable() {
  const database = getDatabase();
  try {
    await database.ping();
  } catch (error) {
    throw new Error(
      `Cannot reach the ${database.driver} database at ${env.DB_HOST}:${env.DB_PORT}. ` +
      `Start MySQL and run "npm run migrate:mysql" before starting the API. (${error.code || error.message})`
    );
  }
  return database;
}

// Named startHttpServer rather than `listen` so it never shadows Express's own
// app.listen on the exported app.
async function startHttpServer({ port = env.PORT, host = env.HOST } = {}) {
  const localOnly = registrationFraud.isolatedEnrollment;
  const server = app.listen(port, localOnly ? '127.0.0.1' : host);
  await once(server, 'listening');
  let ipv6;
  if (localOnly) {
    try {
      ipv6 = app.listen(server.address().port, '::1');
      await once(ipv6, 'listening');
    } catch (error) {
      ipv6 = undefined;
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
        server.close();
        throw error;
      }
      console.warn('IPv6 loopback is unavailable. IPv4 loopback is ready.');
    }
    if (ipv6) server.once('close', () => ipv6.close());
  }
  const { address, port: listeningPort } = server.address();
  const addresses = localOnly ? ['localhost', address, ...(ipv6 ? ['[::1]'] : [])] :
    [address.includes(':') ? `[${address}]` : address];
  console.log(`NeighborLens API running at ${addresses.map(name => `http://${name}:${listeningPort}`).join(', ')}`);

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    server.close(async () => {
      try {
        await getDatabase().close();
      } catch (error) {
        console.error('Failed to close the database cleanly.', error.message);
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

async function start(options = {}) {
  if (env.NODE_ENV === 'development' &&
      (process.env.ALLOW_OUTSIDE_BACOLOD_TEST !== undefined || process.env.CITIZEN_ID_UPLOAD_TEST !== undefined)) {
    console.warn('Remove unsupported .env settings ALLOW_OUTSIDE_BACOLOD_TEST and CITIZEN_ID_UPLOAD_TEST. Use REGISTRATION_ALLOW_OUTSIDE_BACOLOD_SCAN for isolated registration.');
  }
  if (registrationFraud.unsafeOptOut) {
    console.warn('OCR-only enrollment requires a loopback server and a dedicated loopback MySQL database ending in _test. Signed screening remains required.');
  }
  await assertDatabaseReachable();
  return startHttpServer(options);
}

if (require.main === module) {
  start().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = app;
module.exports.start = start;
module.exports.assertDatabaseReachable = assertDatabaseReachable;
