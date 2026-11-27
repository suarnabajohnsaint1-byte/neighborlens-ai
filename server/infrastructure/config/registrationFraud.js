const config = require('./env');
const { isIP } = require('node:net');
const setting = process.env.REGISTRATION_FRAUD_SCREENING_ENABLED;
function isLoopbackAddress(value) {
  if (typeof value !== 'string') return false;
  const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const canonical = new URL(`http://[${address}]`).hostname;
  return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/.test(canonical);
}

const isLoopbackHost = value => value?.toLowerCase() === 'localhost' || isLoopbackAddress(value);
const isLoopbackSocket = req => isLoopbackAddress(req.socket.remoteAddress) && isLoopbackAddress(req.socket.localAddress);

const development = process.env.NODE_ENV === 'development' && !process.env.VERCEL;
const isolated = development && isLoopbackHost(config.HOST) && isLoopbackHost(config.DB_HOST) &&
  config.DB_DRIVER === 'mysql' && config.DB_TARGET === 'local' && /^[a-zA-Z0-9_]+_test$/.test(config.DB_NAME);
const disabled = isolated && setting === 'false';
const basicEnabled = isolated && process.env.REGISTRATION_BASIC_CITIZEN_ENABLED === 'true' &&
  (disabled || (!process.env.REGISTRATION_VERIFIER_URL && !process.env.REGISTRATION_VERIFIER_SECRET));
const allowOutsideScan = isolated && process.env.REGISTRATION_ALLOW_OUTSIDE_BACOLOD_SCAN === 'true';


module.exports = {
  disabled,
  unsafeOptOut: development && setting === 'false' && !isolated,
  explicitlyEnabled: setting === 'true' || (setting === 'false' && !disabled),
  basicEnabled,
  allowOutsideScan,
  allowOutsideEnrollment: disabled && basicEnabled && allowOutsideScan,
  identityPort: Number(process.env.IDENTITY_API_PORT || 8001),
  isolatedEnrollment: disabled || basicEnabled || allowOutsideScan,
  isLoopbackSocket
};

