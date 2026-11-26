const { test, expect } = require('@playwright/test');
const { fixedBrowserLocation } = require('../support/browser-geolocation');
const sharp = require('sharp');
const fs = require('node:fs/promises');

let photos;
const pageErrors = new WeakMap();
test.beforeAll(async () => {
  photos = await Promise.all(
    [false, true].map(async (inverse) => {
      const pixels = Buffer.alloc(128 * 128 * 3);
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const value = x % 32 < 16 !== inverse ? 40 : 210;
          pixels.fill(value, (y * 128 + x) * 3, (y * 128 + x + 1) * 3);
        }
      }
      return sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } })
        .png()
        .toBuffer();
    })
  );
});

test.beforeEach(async ({ page, context, request }) => {
  await fixedBrowserLocation(page, context, { latitude: 10.678, longitude: 122.946, accuracy: 15 });
  pageErrors.set(page, []);
  page.on('pageerror', (error) => pageErrors.get(page).push(error.message));
  const response = await request.post('/__fixture_citizen', {
    data: {
      username: `browser_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      password: 'password123',
      barangay: 'Barangay 1'
    }
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  await page.addInitScript(
    (session) => {
      sessionStorage.setItem('up_session', JSON.stringify(session));
      Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', {
        configurable: true,
        get: () => window.location.origin,
        set() {}
      });
    },
    { ...body.user, username: body.user.username, role: 'citizen', apiToken: body.token }
  );
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/api/config/reverse-geocode')
      return route.fulfill({
        json: {
          ok: true,
          data: {
            display_name: 'Bacolod City',
            address: { city: 'Bacolod City', village: 'Barangay 1' }
          }
        }
      });
    return route.continue();
  });
  await page.goto('/citizen.html');
  await expect(page.locator('#imgInput')).toBeAttached();
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

function result(canonical, confidence = 0.8, status = 'DETECTED') {
  const category =
    canonical === 'clogged_drainage'
      ? 'Flooding / Drainage'
      : canonical === 'broken_streetlight'
        ? 'Street Light Damage'
        : 'Road Damage';
  const label = canonical
    .split('_')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
  const accepted = status === 'DETECTED';
  return {
    status,
    detected: accepted,
    report_category: category,
    candidate: { canonical_category: canonical, display_category: label, confidence, accepted },
    detections: [
      {
        damage_type: canonical,
        canonical_category: canonical,
        display_category: label,
        confidence_score: confidence,
        eligible: accepted,
        severity_level: null
      }
    ],
    triage: null,
    model: 'NeighborLens YOLOv8',
    image_size: { width: 128, height: 128 }
  };
}

function pairPayload(...results) {
  return { photos: results.map(result => ({ result })) };
}

async function scan(page, answers) {
  await page.route('**/api/ai/damage', (route) =>
    route.fulfill({ json: pairPayload(...answers) })
  );
  await page.locator('#imgInput').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: photos[0] },
    { name: 'second.png', mimeType: 'image/png', buffer: photos[1] }
  ]);
  await expect(page.locator('[data-assessment-state]')).toBeVisible();
}

test('low scene similarity remains advisory and a valid report submits', async ({ page }, info) => {
  await page.locator('#description').fill('Citizen description must stay intact');
  await scan(page, [result('road_crack', 0.605), result('road_crack', 0.344)]);
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute('data-assessment-state', 'DETECTED');
  await expect(page.locator('[data-scene-advisory]')).toContainText('could not verify a scene match');
  await expect(page.locator('#visionDetectBox')).toContainText('60.5%');
  await expect(page.locator('#description')).toHaveValue('Citizen description must stay intact');
  await expect(page.locator('#visionDetectBox')).not.toContainText('Priority:');
  await expect.poll(() => page.evaluate(() => window.getDetectedGPS()?.accuracy)).toBe(15);
  await fs.mkdir('.data/phase-1b-browser-screenshots', { recursive: true });
  await page
    .locator('#visionDetectBox')
    .screenshot({ path: `.data/phase-1b-browser-screenshots/${info.project.name}.png` });
  await page.locator('#citizenCategory').selectOption('Road Damage');
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/api/reports') && response.request().method() === 'POST'
  );
  await page.locator('#submitBtn').click();
  expect((await saved).status()).toBe(201);
});

test('different road classes share a category without class agreement', async ({ page }) => {
  await scan(page, [result('pothole'), result('road_crack')]);
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'PAIR_MISMATCH'
  );
  await expect(page.locator('#visionDetectBox')).toContainText('Shared Report Category: Road Damage');
  await expect(page.locator('#visionDetectBox')).toContainText('Damage Agreement: No');
});

test('provisional predictions retain low confidence and never acquire priority', async ({ page }) => {
  await scan(page, [result('pothole', 0.8), result('pothole', 0.2, 'LOW_CONFIDENCE')]);
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'LOW_CONFIDENCE'
  );
  await expect(page.locator('#visionDetectBox')).toContainText('Candidate Category: Road Damage');
  await expect(page.locator('#visionDetectBox')).toContainText('Yes (provisional)');
  await expect(page.locator('#visionDetectBox')).not.toContainText('Priority:');
});

test('identical bytes with different names are rejected by the real assessment route', async ({ page }) => {
  await page.locator('#imgInput').setInputFiles(['first.png', 'renamed.png'].map(name => ({ name, mimeType: 'image/png', buffer: photos[0] })));
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute('data-assessment-state', 'DUPLICATE_EVIDENCE');
  await expect(page.locator('#visionDetectBox')).toContainText('two different angles');
  await expect(page.locator('#visionDetectBox')).not.toContainText('same scene');
  await page.locator('#citizenCategory').selectOption('Road Damage');
  await page.locator('#description').fill('The otherwise complete form has duplicate photos.');
  await expect(page.locator('#submitBtn')).toBeDisabled();
});

test('corrupt images terminate with validation error before inference', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/damage', (route) => {
    calls += 1;
    return route.abort();
  });
  await page.locator('#imgInput').setInputFiles([
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid') },
    { name: 'second.png', mimeType: 'image/png', buffer: photos[0] }
  ]);
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'VALIDATION_ERROR'
  );
  expect(calls).toBe(0);
});

test('older responses cannot overwrite a replacement or manual description', async ({ page }) => {
  const pending = [];
  await page.route('**/api/ai/damage', (route) => {
    pending.push(route);
  });
  const files = (prefix) =>
    photos.map((buffer, index) => ({ name: `${prefix}-${index}.png`, mimeType: 'image/png', buffer }));
  await page.locator('#description').fill('Manual citizen content');
  await page.locator('#imgInput').setInputFiles(files('old'));
  await expect.poll(() => pending.length).toBe(1);
  await page.locator('#imgInput').setInputFiles(files('new'));
  await expect.poll(() => pending.length).toBe(2);
  await pending[1].fulfill({ json: pairPayload(result('pothole'), result('pothole')) });
  await expect(page.locator('#visionDetectBox')).toContainText('Pothole detected in both photos');
  await pending[0].fulfill({ json: pairPayload(result('road_crack'), result('road_crack')) });
  await expect(page.locator('#visionDetectBox')).not.toContainText('Road Crack');
  await expect(page.locator('#description')).toHaveValue('Manual citizen content');
});

test('provider timeout remains distinct from no detection', async ({ page }) => {
  await page.route('**/api/ai/damage', (route) =>
    route.fulfill({ status: 504, json: { error: 'Inference request timed out.', code: 'INFERENCE_TIMEOUT' } })
  );
  await page
    .locator('#imgInput')
    .setInputFiles(photos.map((buffer, index) => ({ name: `${index}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'AI_SERVICE_ERROR'
  );
  await expect(page.locator('.citizen-assessment-summary')).toHaveText('AI assessment is currently unavailable.');
  await expect(page.locator('#visionDetectBox')).toContainText('You can retry later or submit for manual barangay review.');
});

test('no detection in both images stays separate from provider errors', async ({ page }) => {
  await scan(page, [
    { status: 'NO_DETECTION', detected: false, candidate: null, detections: [], triage: null },
    { status: 'NO_DETECTION', detected: false, candidate: null, detections: [], triage: null }
  ]);
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'NO_DETECTION'
  );
  await expect(page.locator('#visionDetectBox')).toContainText('Candidate Category: Not confirmed');
  await expect(page.locator('#visionDetectBox')).not.toContainText('Priority:');
});

test('unsupported class retains its original identifier and confidence', async ({ page }) => {
  const unsupported = {
    status: 'UNSUPPORTED',
    detected: false,
    candidate: null,
    report_category: null,
    detections: [{ damage_type: 'car', confidence_score: 0.95, canonical_category: null, eligible: false }]
  };
  await scan(page, [unsupported, unsupported]);
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'UNSUPPORTED'
  );
  await expect(page.locator('#visionDetectBox')).toContainText('car (95%)');
});

test('Node image validation rejection stays separate from provider unavailable', async ({ page }) => {
  await page.route('**/api/ai/damage', (route) =>
    route.fulfill({ status: 400, json: { error: 'Invalid uploaded image.', code: 'IMAGE_VALIDATION_ERROR' } })
  );
  await page
    .locator('#imgInput')
    .setInputFiles(photos.map((buffer, index) => ({ name: `${index}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute(
    'data-assessment-state',
    'VALIDATION_ERROR'
  );
  await expect(page.locator('#visionDetectBox')).toContainText('Replace the invalid photo');
});
