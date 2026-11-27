const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { parseEnv } = require('node:util');

const [envFile, port, qrCommand, hostname] = process.argv.slice(2);
const loopback = /^(?:127\.0\.0\.1|localhost|::1|\[::1\])$/i;
const quickHost = /^[a-z0-9-]+\.trycloudflare\.com$/;

function checkOrigin() {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1', port, path: '/api/health', timeout: 2000,
      headers: { Host: 'neighborlens-mobile-preflight.invalid' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 4096) request.destroy(new Error('The service on the local port failed the access check.'));
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          if (response.statusCode === 200 && health.service === 'neighborlens-api' && health.isolatedOcrEnrollment === true) {
            resolve();
            return;
          }
        } catch {
          // An unrelated local process may return a non-JSON response.
        }
        reject(new Error('Restart npm run server with the isolated OCR settings before opening a tunnel.'));
      });
    });
    request.on('timeout', () => request.destroy(new Error('Timed out checking the local server access guard.')));
    request.on('error', error => reject(error.code === 'ECONNREFUSED'
      ? new Error('Start npm run server before opening a tunnel.') : error));
  });
}

async function main() {
  const original = await fs.readFile(envFile, 'utf8');
  const config = parseEnv(original);
  if (config.NODE_ENV !== 'development' || config.VERCEL || !loopback.test(config.HOST || '') ||
      !loopback.test(config.DB_HOST || '127.0.0.1') || (config.DB_DRIVER || 'mysql') !== 'mysql' ||
      (config.DB_TARGET || 'local') !== 'local' || !/^[a-zA-Z0-9_]+_test$/.test(config.DB_NAME || '') ||
      Number(config.PORT || 3000) !== Number(port) || config.REGISTRATION_BASIC_CITIZEN_ENABLED !== 'true' ||
      config.REGISTRATION_FRAUD_SCREENING_ENABLED !== 'false' || (config.IDENTITY_RESEARCH_MODEL || 'none') !== 'none') {
    throw new Error('Mobile testing requires loopback development, a local MySQL _test database, and OCR-only registration.');
  }
  const qr = require(path.join(path.dirname(qrCommand), 'node_modules', 'qrcode-terminal'));
  if (!hostname) {
    await checkOrigin();
    return;
  }
  if (!quickHost.test(hostname)) throw new Error('Cloudflare did not return a valid Quick Tunnel hostname.');

  const loginUrl = `https://${hostname}/login.html`;
  await checkProtectedLink(loginUrl);
  console.log(`Mobile registration: ${loginUrl}`);
  // The installed .cmd shim ignores --small. Use the same package's compact renderer.
  qr.generate(loginUrl, { small: true }, output => {
    const padding = '\u2588'.repeat(3);
    const rows = output.trimEnd().split('\n').map(row => padding + row + padding);
    const border = '\u2588'.repeat(rows[0].length);
    console.log('\x1b[97;40m' + [border, border, ...rows, border, border].join('\n') + '\x1b[0m');
  });
}

async function checkProtectedLink(loginUrl) {
  const deadline = Date.now() + 45_000;
  do {
    try {
      const response = await fetch(loginUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const destination = new URL(location, loginUrl);
        if (destination.origin === 'https://login.trycloudflare.com' &&
            destination.pathname === '/authorize' &&
            destination.searchParams.get('hostname') === new URL(loginUrl).hostname &&
            destination.searchParams.get('state')) return;
      }
      if (response.ok && (await response.text()).includes('Citizen Login')) {
        throw new Error('Cloudflare exposed the login page without email verification. Stop this connector immediately.');
      }
    } catch (error) {
      if (error.message.startsWith('Cloudflare exposed')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  throw new Error('Cloudflare email protection could not be verified. No shareable QR was issued.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
