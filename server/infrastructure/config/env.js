const path = require('node:path');
const os = require('node:os');

const knownInsecureJwtSecrets = new Set([
  'secret',
  'password',
  'jwt-secret',
  'my-secret-key',
  'super-secret-key',
  'change-me',
  'default-jwt-secret',
  'example-secret',
  'my_secret',
  'supersecret',
  'jwt_secret',
  'super_secret',
  'super-secret',
  'development-only-change-me',
  'this-is-a-jwt-secret-that-is-definitely-not-secure-and-everyone-knows-it',
  'please-dont-use-this-as-your-jwt-secret-it-is-insecure',
  'use-something-more-secure-instead-of-this-example-secret'
]);

if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET?.trim() ?? '';

  if (
    secret.length < 32 ||
    knownInsecureJwtSecrets.has(secret.toLowerCase())
  ) {
    throw new Error('A strong JWT_SECRET is required in production.');
  }
}
const projectRoot = path.resolve(__dirname, '../../..');
const requestedUploads = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'storage/uploads');
const relativeUploads = path.relative(projectRoot, requestedUploads);
const outsideProject = relativeUploads.startsWith(`..${path.sep}`) || path.isAbsolute(relativeUploads);

module.exports = {
  REPORT_SEVERITY_POLICY: process.env.REPORT_SEVERITY_POLICY_JSON ? JSON.parse(process.env.REPORT_SEVERITY_POLICY_JSON) : {},
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  JWT_SECRET: process.env.JWT_SECRET || 'development-only-change-me',

  DB_DRIVER: (process.env.DB_DRIVER || 'mysql').toLowerCase(),
  DB_TARGET: (process.env.DB_TARGET || 'local').toLowerCase(),

  DB_HOST: process.env.DB_HOST || '127.0.0.1',
  DB_PORT: Number(process.env.DB_PORT || 3306),
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_NAME: process.env.DB_NAME || 'neighborlens_ai',
  DB_CONNECTION_LIMIT: Number(process.env.DB_CONNECTION_LIMIT || 10),

  DB_CONNECT_TIMEOUT_MS: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),

  //for production
  DB_SSL_MODE: (process.env.DB_SSL_MODE || 'DISABLED').toUpperCase(),
  DB_SSL_CA: process.env.DB_SSL_CA || '',

  UPLOAD_DIR: process.env.VERCEL
    ? path.join(os.tmpdir(), 'neighborlens', 'private-evidence')
    : (outsideProject ? requestedUploads : path.join(os.homedir(), '.neighborlens', 'private-evidence')),
  LEGACY_UPLOAD_DIR: requestedUploads,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  DEFAULT_ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  DEFAULT_ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  DEMO_CITIZEN_USERNAME: process.env.DEMO_CITIZEN_USERNAME || 'citizen',
  DEMO_CITIZEN_PASSWORD: process.env.DEMO_CITIZEN_PASSWORD || '1',
  DAMAGE_INFERENCE_URL: process.env.DAMAGE_INFERENCE_URL || (process.env.VERCEL ? '' : 'http://127.0.0.1:8000/predict'),
  DAMAGE_INFERENCE_PROVIDER: process.env.DAMAGE_INFERENCE_PROVIDER || 'local',
  INFERENCE_SHARED_SECRET: process.env.INFERENCE_SHARED_SECRET || '',
  ROBOFLOW_API_KEY: process.env.ROBOFLOW_API_KEY || '',
  ROBOFLOW_MODEL: process.env.ROBOFLOW_MODEL || 'damages-detection-ixvjc-zolih',
  ROBOFLOW_VERSION: process.env.ROBOFLOW_VERSION || '3',
  DAMAGE_MODEL: process.env.DAMAGE_MODEL || 'unreported',
  DAMAGE_TASK: process.env.DAMAGE_TASK || 'detect',
  DAMAGE_MIN_CONFIDENCE: Number(process.env.DAMAGE_MIN_CONFIDENCE || 0.3),
  DAMAGE_PAIR_INFERENCE_URL: process.env.DAMAGE_PAIR_INFERENCE_URL || (process.env.VERCEL ? '' : 'http://127.0.0.1:8000/api/v1/damage/verify-pair'),

  BACOLOD_BBOX: {
    minLat: Number(process.env.BACOLOD_BBOX_MIN_LAT || 10.45),
    maxLat: Number(process.env.BACOLOD_BBOX_MAX_LAT || 10.90),
    minLng: Number(process.env.BACOLOD_BBOX_MIN_LNG || 122.75),
    maxLng: Number(process.env.BACOLOD_BBOX_MAX_LNG || 123.20)
  },
  MAX_GPS_ACCURACY_METERS: Number(process.env.MAX_GPS_ACCURACY_METERS || 100),

  STORAGE_DRIVER: process.env.STORAGE_DRIVER || 'local',

  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
};
