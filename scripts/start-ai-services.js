const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { root, python, damageArgs, damageHost, damagePort } = require('./start-ai');

const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const identityHost = '127.0.0.1';

function endpoint(host, port) {
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${port}/health`;
}

async function readHealth(service) {
  try {
    const response = await fetch(endpoint(service.host, service.port), {
      headers: service.headers, redirect: 'error', signal: AbortSignal.timeout(1500)
    });
    if (response.ok) return await response.json();
    await response.body?.cancel();
  } catch {
    // A starting process may not have bound its socket yet.
  }
  return null;
}

function occupied({ host, port }) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(true) : reject(error));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(false)));
  });
}

function serviceConfiguration({ damageOnly, identityOnly }) {
  const services = [];

  // YOLO Damage Detection
  if (!identityOnly) {
    const profile = hash(damageArgs);

    services.push({
      name: 'Damage',
      host: damageHost,
      port: damagePort,
      args: damageArgs,
      env: {
        NEIGHBORLENS_DAMAGE_PROFILE: profile
      },
      compatible: health =>
        health?.service === 'neighborlens-yolo-api' &&
        health.protocol === 1 &&
        health.ok === true &&
        health.profile === profile
    });
  }

  // Identity and OCR Service
  if (!damageOnly) {
    const registration = require(
      '../server/infrastructure/config/registrationFraud'
    );

    if (registration.unsafeOptOut) {
      console.warn(
        '[AI:Identity/OCR] Starting AI services with normal enrollment enforcement.'
      );
    }

    const fraud = !registration.disabled;

    const model = fraud
      ? process.env.IDENTITY_RESEARCH_MODEL || 'none'
      : 'none';

    const port = registration.identityPort;
    const secret = process.env.REGISTRATION_FRAUD_SECRET || '';

    if (!/^[\x20-\x7e]{32,}$/.test(secret)) {
      throw new Error(
        '[AI:Identity/OCR] Set REGISTRATION_FRAUD_SECRET to a private ASCII secret of at least 32 characters.'
      );
    }

    const profile = hash([
      process.env.REGISTRATION_CAPTURE_TESSERACT,
      model,
      fraud,
      model === 'none'
        ? null
        : process.env.IDENTITY_RESEARCH_DEVICE,

      model === 'freuid-a31'
        ? [
            process.env.FREUID_ASSETS,
            process.env.FREUID_RESEARCH_LAYOUT
          ]
        : null,

      model === 'trufor'
        ? [
            process.env.TRUFOR_SOURCE,
            process.env.TRUFOR_WEIGHTS_ARCHIVE
          ]
        : null
    ]);

    services.push({
      name: 'Identity/OCR',
      host: identityHost,
      port,

      args: [
        '-m',
        'uvicorn',
        'ai.identity.forensics_api:app',
        '--host',
        identityHost,
        '--port',
        String(port),
        '--no-access-log',
        '--no-proxy-headers'
      ],

      env: {
        NEIGHBORLENS_IDENTITY_PROFILE: profile,
        REGISTRATION_FRAUD_SCREENING_ENABLED: String(fraud),
        IDENTITY_RESEARCH_MODEL: model
      },

      headers: {
        Authorization: `Bearer ${secret}`
      },

      compatible: health =>
        health?.service === 'neighborlens-identity-api' &&
        health.protocol === 1 &&
        health.ocr === true &&
        health.fraud === fraud &&
        health.model === model &&
        health.profile === profile,

      identity: true,
      fraud,
      model
    });
  }

  return services;
}

async function launch(options = {}) {
  const services = serviceConfiguration(options);
  if (services.some(({ port }) => !Number.isInteger(port) || port < 1 || port > 65535) ||
      new Set(services.map(({ port }) => port)).size !== services.length) {
    throw new Error('[AI] Configure distinct valid AI_PORT and IDENTITY_API_PORT values.');
  }
  const conflicts = await Promise.all(services.map(async service => {
    if (!await occupied(service)) return null;
    const health = await readHealth(service);
    if (!service.compatible(health)) {
      return `[AI:${service.name}] Port ${service.port} is occupied by an incompatible or unready service. Free the port or configure a different port.`;
    }
    service.reused = true;
    return null;
  }));
  if (conflicts.some(Boolean)) throw new Error(conflicts.filter(Boolean).join('\n'));
  if (services.some(service => !service.reused) && !existsSync(python)) {
    throw new Error('[AI] Python was not found in the project virtual environment.');
  }

  const owned = [];
  const stop = new AbortController();
  let failure;
  function shutdown() {
    if (stop.signal.aborted) return;
    stop.abort();
    for (const { child } of owned) {
      child.stdin.end();
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform === 'win32') process.once('SIGBREAK', shutdown);
  try {
    await Promise.all(services.map(async service => {
      if (!service.reused) {
        const instance = randomUUID();
        const child = spawn(python, service.args, {
          cwd: root, env: { ...process.env, ...service.env, NEIGHBORLENS_AI_INSTANCE: instance },
          windowsHide: true, stdio: ['pipe', 'inherit', 'inherit']
        });
        child.stdin.on('error', () => {});
        const done = new Promise(resolve => child.once('close', resolve));
        owned.push({ child, done });
        function failed(reason) {
          if (stop.signal.aborted) return;
          failure = new Error(`[AI:${service.name}] Stopped before shutdown (${reason}). Check the service output above.`);
          shutdown();
        }
        child.once('error', error => failed(error.code || 'SPAWN_ERROR'));
        child.once('exit', (code, signal) => failed(code ?? signal ?? 'EXIT'));
        const deadline = Date.now() + 60_000;
        while (!stop.signal.aborted) {
          const health = await readHealth(service);
          if (service.compatible(health) && health.instance === instance) break;
          if (Date.now() >= deadline) {
            failed('READINESS_TIMEOUT');
            break;
          }
          await delay(250, null, { signal: stop.signal }).catch(() => {});
        }
      }
      if (stop.signal.aborted) return;
      console.log(`[AI:${service.name}] Ready on port ${service.port}${service.reused ? ' (existing compatible service)' : ''}`);
      if (service.identity) {
        console.log('[AI:OCR] Tesseract available');
        console.log(`[AI:Fraud] ${service.fraud ? `Enabled (model: ${service.model})` : 'Disabled by configuration'}`);
      }
    }));
    if (!stop.signal.aborted) console.log('[AI] All required services ready');
    await Promise.all(owned.map(({ done }) => done));
    if (failure) throw failure;
  } finally {
    shutdown();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    if (process.platform === 'win32') process.removeListener('SIGBREAK', shutdown);
  }
}

module.exports = { launch };
if (require.main === module) {
  launch({ identityOnly: process.argv.includes('--identity-only') }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
