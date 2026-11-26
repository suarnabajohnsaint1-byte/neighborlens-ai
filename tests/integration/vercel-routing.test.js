const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const config = require('../../vercel.json');

function destination(url) {
  const route = config.routes.find(item => new RegExp(item.src).test(url));
  return route?.dest ? url.replace(new RegExp(route.src), route.dest) : null;
}

test('Vercel routes only supported pages, API function and public assets', () => {
  const expected = new Map([
    ['/', 'frontend/login.html'],
    ['/api/health', 'api/index.js'],
    ['/api/auth/admin/login', 'api/index.js'],
    ['/login.html', 'frontend/login.html'],
    ['/citizen.html', 'frontend/citizen.html'],
    ['/admin.html', 'frontend/admin.html'],
    ['/barangay.html', 'frontend/barangay.html'],
    ['/js/shared/api.js', 'frontend/js/shared/api.js'],
    ['/styles/style.css', 'frontend/styles/style.css'],
    ['/assets/admin-assets-login/assets/icons/eye.svg', 'frontend/assets/admin-assets-login/assets/icons/eye.svg'],
    ['/shared/reportVocabulary.js', 'shared/reportVocabulary.js']
  ]);
  for (const [url, file] of expected) {
    assert.equal(destination(url), `/${file}`);
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  for (const url of ['/.env', '/server/app.js', '/shared/private.js', '/package.json']) {
    assert.equal(destination(url), null);
  }
  assert.deepEqual(config.builds.map(item => item.use).filter(value => value === '@vercel/node'), ['@vercel/node']);
});

test('browser API URLs use the deployed HTTPS origin and local development port', () => {
  const source = fs.readFileSync(path.join(root, 'frontend/js/shared/api.js'), 'utf8');
  for (const [protocol, origin, expected] of [
    ['https:', 'https://neighborlens-ai.vercel.app', 'https://neighborlens-ai.vercel.app/api/health'],
    ['http:', 'http://127.0.0.1:5500', 'http://127.0.0.1:3000/api/health']
  ]) {
    const window = { location: { protocol, origin, hostname: new URL(origin).hostname } };
    vm.runInNewContext(source, { window, setTimeout, clearTimeout, AbortController, FormData });
    assert.equal(window.neighborLensApiUrl('/api/health'), expected);
  }
});

test('Vercel forwarded HTTPS origin reaches the health route', async () => {
  const app = require('../../server/app');
  const previous = app.get('trust proxy');
  app.set('trust proxy', 1);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const hostname = `127.0.0.1:${server.address().port}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`, {
      headers: {
        Origin: `https://${hostname}`,
        'X-Forwarded-Proto': 'https'
      }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    app.set('trust proxy', previous);
  }
});

test('Vercel cold start uses writable temporary upload storage', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const os = require('node:os');
    const fs = require('node:fs');
    const app = require('./server/app');
    const { UPLOAD_ROOT } = require('./server/infrastructure/storage/uploadDirectory');
    assert.equal(UPLOAD_ROOT, path.join(os.tmpdir(), 'neighborlens', 'private-evidence'));
    assert.ok(fs.statSync(UPLOAD_ROOT).isDirectory());
    assert.equal(typeof app, 'function');
  `], {
    cwd: root,
    env: {
      ...process.env,
      VERCEL: '1',
      NODE_ENV: 'production',
      JWT_SECRET: 'vercel-cold-start-test-secret-32-characters',
      UPLOAD_DIR: 'uploads',
      STORAGE_DRIVER: 'supabase'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
