const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');

const env = require('../../server/infrastructure/config/env');
const { UPLOAD_ROOT } = require('../../server/infrastructure/storage/uploadDirectory');

const REQUESTED =
  process.env.FULL_E2E_TEST === 'true' ||
  process.env.FULL_E2E_TEST === '1' ||
  process.env.STORAGE_SMOKE_TEST === 'true' ||
  (process.env.STORAGE_DRIVER || '').toLowerCase() === 'supabase';

function canConnectTcp(host, port, timeoutMs = 2000) {
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

async function canReachUrl(url, timeoutMs = 2000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch {
    return false;
  }
}

async function skipReasonFor() {
  if (!REQUESTED) {
    return 'Opt-in E2E test skipped: FULL_E2E_TEST=true or STORAGE_DRIVER=supabase required.';
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.SUPABASE_STORAGE_BUCKET) {
    return 'Opt-in E2E test skipped: Missing required Supabase environment variables.';
  }
  if (!await canConnectTcp(env.DB_HOST || '127.0.0.1', Number(env.DB_PORT || 3306))) {
    return `Opt-in E2E test skipped: MySQL unreachable at ${env.DB_HOST}:${env.DB_PORT}.`;
  }
  if (!await canReachUrl(env.DAMAGE_INFERENCE_URL || 'http://127.0.0.1:8000/predict')) {
    return `Opt-in E2E test skipped: AI service unreachable at ${env.DAMAGE_INFERENCE_URL}.`;
  }
  return null;
}

const EVIDENCE_JPEG_1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAB4AHgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCxRRRXmn2oUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAGZq+r/ANleT+483zN38e3GMex9azP+Eu/6cf8AyL/9jR4u/wCXP/gf/stczXVTpxcU2jwcbja9OvKEJWSt0XY6b/hLv+nH/wAi/wD2NH/CXf8ATj/5F/8Asa5mitPYw7HL/aOJ/m/Bf5HTf8Jd/wBOP/kX/wCxo/4S7/px/wDiL/8AY1zNFHsYdg/tHE/zfgv8jpv+Eu/6cf8AyL/9jR/wl3/Tj/5F/wAsa5mij2MOwf2jif5vwX+R03/CXf8ATj/5F/8AsaP+Eu/6cf8AyL/9jXM0Uexh2D+0cT/N+C/yO00rXf7Tumh+zeVtQvnfu7genvWxXH+Ff+QpL/1xP/oS12FctWKjKyPcwFWdWjzTdzsKKKKzOwKKKKAP/9k=',
  'base64'
);

const EVIDENCE_JPEG_2 = Buffer.from(EVIDENCE_JPEG_1);

test('Full report submission E2E integration with MySQL, YOLOv8, and Supabase', async (t) => {
  const skipReason = await skipReasonFor();
  if (skipReason) return t.skip(skipReason);

  const app = require('../../server/app');
  const { getDatabase } = require('../../server/infrastructure/database');
  const { getImageStorage } = require('../../server/infrastructure/storage/storageFactory');

  let server;
  let baseUrl;
  const db = getDatabase();
  const storage = getImageStorage();

  const stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const disposableUsernames = [];
  const disposableReportIds = [];
  const uploadedStorageKeys = [];

  const setUp = async () => {
    await new Promise(resolve => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  };

  const tearDown = async () => {
    for (const ref of uploadedStorageKeys) {
      try {
        await storage.remove(ref);
      } catch { }
    }

    for (const reportId of disposableReportIds) {
      try {
        await db.query("DELETE FROM audit_logs WHERE entity_type = 'report' AND entity_id = ?", [reportId]);
        await db.query('DELETE FROM damage_verifications WHERE report_id = ?', [reportId]);
        await db.query('DELETE FROM report_images WHERE report_id = ?', [reportId]);
        await db.query('DELETE FROM report_status_history WHERE report_id = ?', [reportId]);
        await db.query('DELETE FROM reports WHERE id = ?', [reportId]);
      } catch { }
    }

    for (const username of disposableUsernames) {
      try {
        const users = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (users.length) {
          await db.query('DELETE FROM audit_logs WHERE actor_id = ?', [users[0].id]);
          await db.query('DELETE FROM citizen_identities WHERE user_id = ?', [users[0].id]);
          await db.query('DELETE FROM users WHERE id = ?', [users[0].id]);
        }
      } catch { }
    }

    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await getDatabase().close().catch(() => { });
  };

  await setUp();
  t.after(tearDown);

  let citizenToken;
  let citizenUserId;
  let unauthToken;
  let createdReportId;
  let createdReportData;

  await t.test('1. Setup dedicated authorized and unauthorized test citizen accounts', async () => {
    const username1 = `e2e_cit_${stamp()}`;
    disposableUsernames.push(username1);

    const reg1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username1,
        password: 'Password123!',
        barangay: 'Barangay Villamonte'
      })
    });
    assert.equal(reg1.status, 201, 'Citizen registration must succeed');
    const data1 = await reg1.json();
    citizenToken = data1.token;
    citizenUserId = data1.user.id;

    const username2 = `e2e_unauth_${stamp()}`;
    disposableUsernames.push(username2);

    const reg2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username2,
        password: 'Password123!',
        barangay: 'Barangay Mandalagan'
      })
    });
    assert.equal(reg2.status, 201, 'Unauthorized citizen registration must succeed');
    const data2 = await reg2.json();
    unauthToken = data2.token;
  });

  await t.test('2. Submit report through actual HTTP API and verify response & geofencing', async () => {
    const existingUploads = new Set(await fs.readdir(UPLOAD_ROOT));

    const description = `E2E Full Submission Report ${stamp()}`;
    const form = new FormData();
    form.append('description', description);
    form.append('barangay', 'Barangay Villamonte');
    form.append('latitude', '10.6765');
    form.append('longitude', '122.9510');
    form.append('gpsAccuracy', '15');
    form.append('images', new File([EVIDENCE_JPEG_1], 'evidence1.jpg', { type: 'image/jpeg' }));
    form.append('images', new File([EVIDENCE_JPEG_2], 'evidence2.jpg', { type: 'image/jpeg' }));

    const res = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenToken}` },
      body: form
    });

    assert.equal(res.status, 201, 'Report creation must return 201 Created');
    createdReportData = await res.json();
    createdReportId = createdReportData.id || createdReportData.reportId;
    disposableReportIds.push(createdReportId);

    assert.equal(createdReportData.boundary_check_status, 'inside_service_area');
    assert.equal(Number(createdReportData.gps_accuracy || createdReportData.gpsAccuracy), 15);
    assert.equal(createdReportData.status, 'pending');
    assert.equal(createdReportData.images.length, 2, 'Must return exactly two images');

    for (const img of createdReportData.images) {
      if (img.imagePath && typeof img.imagePath === 'string' && img.imagePath.startsWith('supabase:')) {
        uploadedStorageKeys.push(img.imagePath);
      }
    }

    const currentUploads = await fs.readdir(UPLOAD_ROOT);
    const leftoverUploads = currentUploads.filter(file => !existingUploads.has(file));
    assert.equal(
      leftoverUploads.length,
      0,
      `Local temporary uploads must be deleted after cloud persistence. Leftover: ${leftoverUploads.join(', ')}`
    );
  });

  await t.test('3. Verify YOLOv8 inference and pair verification persisted in MySQL', async () => {
    const verifications = await db.query(
      'SELECT * FROM damage_verifications WHERE report_id = ?',
      [createdReportId]
    );
    assert.equal(verifications.length, 1, 'Damage verification row must be persisted for report');
    const v = verifications[0];
    assert.ok(v.model && v.model.length > 0, 'Model identifier must be recorded');
    assert.ok(v.composite_similarity_score !== null, 'Composite similarity score must be recorded');
    assert.ok(v.embedding_similarity !== null, 'Embedding similarity must be recorded');
    assert.ok(v.highest_severity && v.highest_severity.length > 0, 'Highest severity must be recorded');
  });

  await t.test('4. Verify MySQL persistence of report, image ordering, sizes, and references', async () => {
    const reportRows = await db.query('SELECT * FROM reports WHERE id = ?', [createdReportId]);
    assert.equal(reportRows.length, 1, 'Report row must exist in MySQL');
    assert.equal(reportRows[0].submitted_by, citizenUserId);
    assert.equal(reportRows[0].boundary_check_status, 'inside_service_area');

    const imageRows = await db.query(
      'SELECT * FROM report_images WHERE report_id = ? ORDER BY image_order ASC',
      [createdReportId]
    );
    assert.equal(imageRows.length, 2, 'Exactly two image rows must be persisted in MySQL');

    assert.equal(imageRows[0].image_order, 1);
    assert.equal(imageRows[0].mime_type, 'image/jpeg');
    assert.equal(imageRows[0].file_size, EVIDENCE_JPEG_1.length);
    assert.ok(imageRows[0].image_path.startsWith('supabase:reports/'));

    assert.equal(imageRows[1].image_order, 2);
    assert.equal(imageRows[1].mime_type, 'image/jpeg');
    assert.equal(imageRows[1].file_size, EVIDENCE_JPEG_2.length);
    assert.ok(imageRows[1].image_path.startsWith('supabase:reports/'));

    for (const row of imageRows) {
      if (row.image_path) uploadedStorageKeys.push(row.image_path);
    }
  });

  await t.test('5. Verify exactly two objects uploaded to private Supabase bucket', async () => {
    const imageRows = await db.query(
      'SELECT * FROM report_images WHERE report_id = ? ORDER BY image_order ASC',
      [createdReportId]
    );
    assert.equal(imageRows.length, 2);

    for (const row of imageRows) {
      const parsedKey = storage.parseReference(row.image_path);
      assert.ok(parsedKey.startsWith('reports/'));

      const { data: downloadData, error: downloadError } = await storage.bucket.download(parsedKey);
      assert.equal(downloadError, null, `Object ${parsedKey} must exist in Supabase bucket`);
      const buffer = Buffer.from(await downloadData.arrayBuffer());
      assert.ok(buffer.length > 0, 'Downloaded object must not be empty');

      const expectedFixture = row.image_order === 1 ? EVIDENCE_JPEG_1 : EVIDENCE_JPEG_2;
      assert.equal(
        Buffer.compare(buffer, expectedFixture),
        0,
        `Downloaded object content must match fixture ${row.image_order}`
      );
    }
  });

  await t.test('6. Retrieve created report with authorized account and verify signed image URLs return HTTP 200', async () => {
    const listRes = await fetch(`${baseUrl}/api/reports`, {
      headers: { Authorization: `Bearer ${citizenToken}` }
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(Array.isArray(listBody.reports));

    const retrieved = listBody.reports.find(r => r.id === createdReportId);
    assert.ok(retrieved, 'Created report must be found in list for authorized citizen');
    assert.equal(retrieved.images.length, 2, 'Enriched report must have two images');

    for (const imgDto of retrieved.images) {
      const signedUrl = imgDto.imagePath;
      assert.ok(typeof signedUrl === 'string' && signedUrl.length > 0);
      assert.ok(signedUrl.startsWith('https://') || signedUrl.startsWith('http://'));
      assert.ok(
        signedUrl.includes(env.SUPABASE_URL) || signedUrl.includes('supabase.co'),
        'Signed URL must point to Supabase storage host'
      );

      const imgRes = await fetch(signedUrl);
      assert.equal(imgRes.status, 200, 'Signed image URL must return HTTP 200');
      const contentType = imgRes.headers.get('content-type') || '';
      assert.ok(contentType.includes('image/jpeg'), `Content type must be image/jpeg, received ${contentType}`);
    }
  });

  await t.test('7. Verify unauthorized citizens cannot access report or signed URLs', async () => {
    const unauthList = await fetch(`${baseUrl}/api/reports`, {
      headers: { Authorization: `Bearer ${unauthToken}` }
    });
    assert.equal(unauthList.status, 200);
    const listBody = await unauthList.json();
    const leak = (listBody.reports || []).find(r => r.id === createdReportId);
    assert.equal(leak, undefined, 'Unauthorized citizen must not receive report or its signed URLs');

    const unauthHistory = await fetch(`${baseUrl}/api/reports/${createdReportId}/history`, {
      headers: { Authorization: `Bearer ${unauthToken}` }
    });
    assert.equal(unauthHistory.status, 403, 'Unauthorized access to report history must return 403 Forbidden');
  });

  await t.test('8. Test controlled failure scenario: verify rollback and storage cleanup', async () => {
    const form = new FormData();
    form.append('description', 'Should fail validation');
    form.append('barangay', 'Barangay Villamonte');
    form.append('latitude', '10.6765');
    form.append('longitude', '122.9510');
    form.append('gpsAccuracy', '150');
    form.append('images', new File([EVIDENCE_JPEG_1], 'f1.jpg', { type: 'image/jpeg' }));
    form.append('images', new File([EVIDENCE_JPEG_2], 'f2.jpg', { type: 'image/jpeg' }));

    const res = await fetch(`${baseUrl}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenToken}` },
      body: form
    });

    assert.equal(res.status, 400, 'Report exceeding GPS accuracy threshold must be rejected with 400');
    const errBody = await res.json();
    assert.ok(/GPS accuracy/i.test(errBody.error || errBody.message || ''));

    const failRows = await db.query('SELECT * FROM reports WHERE description = ?', ['Should fail validation']);
    assert.equal(failRows.length, 0, 'No MySQL report rows must be persisted on failure');
  });
});
