const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

/**
 * End-to-end verification against the real MySQL runtime.
 *
 * This file deliberately refuses to fall back to the SQLite test adapter. If
 * MySQL is not reachable the whole suite is SKIPPED with a stated reason, so a
 * green run can never be mistaken for MySQL runtime proof.
 *
 * Run with node tests/support/run-isolated-mysql.js --e2e to migrate a private
 * loopback database and provision its first administrator using the real bootstrap.
 */

const REQUESTED = (process.env.DB_DRIVER || '').toLowerCase() === 'mysql';

function envConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'neighborlens_ai'
  };
}

function canConnect({ host, port }, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = net.connect(port, host);
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

const config = envConfig();

async function skipReasonFor() {
  if (!REQUESTED) {
    return 'BLOCKED: DB_DRIVER is not "mysql"; this suite never substitutes SQLite for a MySQL runtime claim.';
  }
  try {
    const guard = require('../support/local-test-target');
    guard.assertLoopbackHost(config.host);
    guard.assertTestDatabase(config.database);
  } catch {
    return 'BLOCKED: real MySQL E2E requires an isolated loopback database ending in _test.';
  }
  if (!await canConnect(config)) {
    return `BLOCKED: no MySQL server reachable at ${config.host}:${config.port}.`;
  }
  return null;
}

/**
 * A single gated suite: reachability is decided at run time, and the app is
 * required only once MySQL is confirmed, because importing it opens the
 * configured database.
 */
test('real MySQL runtime end-to-end', async (t) => {
  const skipReason = await skipReasonFor();
  if (skipReason) return t.skip(skipReason);

  const { startSignedEnrollment } = require('../support/signed-enrollment');
  const { addReportGps } = require('../support/citizens');
  const enrollment = await startSignedEnrollment();
  t.after(enrollment.close);
  const app = require('../../server/app');
  const { getDatabase } = require('../../server/infrastructure/database');

  let server;
  let baseUrl;

  const { login, createOfficial } = require('../support/accounts');
  const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
  const stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  function jpegFile(name, bytes = JPEG_BYTES) {
    return new File([bytes], name, { type: 'image/jpeg' });
  }
  async function register(username) {
    const data = await enrollment.registrationPayload(baseUrl, { username, password: 'password123' });
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    assert.equal(response.status, 201);
    return response.json();
  }

  const setUp = async () => {
    await new Promise(resolve => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  };

  const tearDown = async () => {
    await new Promise(resolve => server.close(resolve));
    await getDatabase().close().catch(() => {});
  };

  await setUp();
  t.after(tearDown);

  await t.test('the running adapter really is the MySQL driver', async () => {
    const db = getDatabase();
    assert.equal(db.driver, 'mysql');
    assert.equal(await db.ping(), true);
  });

  await t.test('registration then identity persistence survives a reload from MySQL', async () => {
    const username = `e2e_identity_${stamp()}`;
    const { token, user } = await register(username);
    assert.equal(user.residencyVerified, true);

    // Facts only: the three conclusions below must come from the server.
    const saved = await fetch(`${baseUrl}/api/identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        documentType: 'PHILSYS',
        idNumber: '1234-5678-9012-3456',
        fullName: 'E2E Test Resident',
        birthDate: '1990-01-01',
        address: 'Test Address, Bacolod City',
        expiryDate: '2019-01-01',
        ocrConfidence: 88,
        isExpired: false,
        documentValidationStatus: 'pass'
      })
    });
    assert.equal(saved.status, 403);

    const reloaded = await fetch(`${baseUrl}/api/identity/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const { identity } = await reloaded.json();

    assert.equal(identity.isExpired, false);
    assert.equal(identity.documentValidationStatus, 'pass');
    assert.equal(identity.formatCheckStatus, 'pass');
    assert.equal(identity.fullName, 'Synthetic Test Citizen');
  });

  await t.test('an authenticated report submission persists report, images, and geofence status in MySQL', async () => {
    const username = `e2e_report_${stamp()}`;
    const { token } = await register(username);

    const description = `E2E MySQL report ${stamp()}`;
    const form = new FormData();
    form.append('description', description);
    form.append('barangay', 'Barangay 1');
    addReportGps(form);
    form.append('images', jpegFile('e2e-1.jpg'));
    form.append('images', jpegFile('e2e-2.jpg', SECOND_JPEG_BYTES));

    const created = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    assert.equal(created.status, 201);
    const report = await created.json();
    assert.equal(report.boundary_check_status, 'inside_service_area');

    // Read straight out of MySQL, bypassing the API, to prove it landed.
    const db = getDatabase();
    const rows = await db.query('SELECT * FROM reports WHERE id = ?', [report.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, description);

    const images = await db.query('SELECT * FROM report_images WHERE report_id = ? ORDER BY image_order', [report.id]);
    assert.equal(images.length, 2);
    assert.deepEqual(images.map(image => image.image_order), [1, 2]);
  });

  await t.test('MySQL enforces the report foreign key and the two-image order invariant', async () => {
    const db = getDatabase();

    await assert.rejects(
      db.execute(
        'INSERT INTO report_images (report_id, image_path, image_order) VALUES (?, ?, ?)',
        [99999999, '/uploads/orphan.jpg', 1]
      ),
      'an image row must not attach to a non-existent report'
    );
  });

  await t.test('a provisioned Barangay official can persist a status update and its history row', async () => {
    const { token: citizenToken } = await register(`e2e_status_${stamp()}`);

    const form = new FormData();
    form.append('description', `E2E status report ${stamp()}`);
    form.append('barangay', 'Barangay 1');
    addReportGps(form);
    form.append('images', jpegFile('s1.jpg'));
    form.append('images', jpegFile('s2.jpg', SECOND_JPEG_BYTES));

    const created = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenToken}` },
      body: form
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const session = await login(baseUrl, process.env.BOOTSTRAP_ADMIN_USERNAME || process.env.ADMIN_USERNAME,
      process.env.BOOTSTRAP_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD, 'admin');
    assert.equal(session.user.role, 'admin');
    const responsible = await createOfficial(baseUrl, session.token, 'Barangay 1', 'runtime_status');
    const proof = new FormData();
    proof.append('status', 'ongoing');
    proof.append('note', 'Inspection started');
    proof.append('requestKey', crypto.randomUUID());
    proof.append('images', jpegFile('progress.jpg'));
    const updated = await fetch(`${baseUrl}/api/reports/${id}/status`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${responsible.token}` }, body: proof
    });
    assert.equal(updated.status, 200);

    const db = getDatabase();
    const [row] = await db.query('SELECT status FROM reports WHERE id = ?', [id]);
    assert.equal(row.status, 'ongoing');

    const history = await db.query('SELECT * FROM report_status_history WHERE report_id = ?', [id]);
    assert.equal(history.length, 1);
    assert.equal(history[0].old_status, 'pending');
    assert.equal(history[0].new_status, 'ongoing');
  });
});
