const { fixedBrowserLocation, moveBrowserLocation } = require('../support/browser-geolocation');
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const { adminSession, createOfficial } = require('../support/accounts');
const { evidenceFile, JPEG_BYTES, SECOND_JPEG_BYTES, PNG_BYTES } = require('../support/image-fixtures');
let adminFixture;
async function staffSession(baseURL, role, barangay) {
  const admin = await (adminFixture ||= adminSession(baseURL));
  const staff = role === 'admin' ? admin : await createOfficial(baseURL, admin.token, barangay, 'category_review');
  return { ...staff.user, apiToken: staff.token };
}

let photos;
const sessions = new WeakMap();
const errors = new WeakMap();
let recentApiRequests = [];

test.beforeAll(async () => {
  photos = await Promise.all([JPEG_BYTES, SECOND_JPEG_BYTES].map(buffer => sharp(buffer).png().toBuffer()));
});

test.beforeEach(async ({ page, request, context }, info) => {
  test.setTimeout(90000);
  await fixedBrowserLocation(page, context, { latitude: 10.6685, longitude: 122.9647, accuracy: 15 }, { simulatedWatch: info.title.includes('Citizen location map') });
  recentApiRequests = recentApiRequests.filter(time => time > Date.now() - 60000);
  if (recentApiRequests.length >= 250) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, recentApiRequests[recentApiRequests.length - 250] + 60100 - Date.now())));
    recentApiRequests = recentApiRequests.filter(time => time > Date.now() - 60000);
  }
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) recentApiRequests.push(Date.now()); });
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
  await request.post('/__phase2_mode', { data: { mode: 'pothole' } });
  const response = await request.post('/__fixture_citizen', { data: { username: `phase2_browser_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, password: 'password123', barangay: 'Villamonte' } });
  expect(response.status()).toBe(201);
  const body = await response.json();
  const session = { ...body.user, apiToken: body.token, role: 'citizen' };
  sessions.set(page, session);
  await page.addInitScript(session => {
    if (!sessionStorage.getItem('phase2_session_initialized')) {
      sessionStorage.setItem('up_session', JSON.stringify(session));
      sessionStorage.setItem('phase2_session_initialized', '1');
    }
    Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => window.location.origin, set() {} });
  }, session);
  // WebKit also routes blob: URLs when a wildcard intercepts local photo previews.
  await page.route(/^https?:\/\//, route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/api/config/reverse-geocode') return route.fulfill({ json: { ok: true, data: { display_name: 'Bacolod City', address: { city: 'Bacolod City', village: 'Barangay Central' } } } });
    return route.continue();
  });
  await page.goto('/citizen.html');
  await expect(page.locator('#imgInput')).toBeAttached();
});

test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function scan(page) {
  await page.locator('#imgInput').setInputFiles(photos.map((buffer, index) => ({ name: `photo-${index + 1}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('#citizenCategory')).toBeEnabled();
  await expect(page.locator('#visionDetectBox [data-assessment-state]')).toBeVisible();
}

async function submit(page) {
  await expect.poll(() => page.evaluate(() => getDetectedGPS()?.barangay)).toBeTruthy();
  await expect(page.locator('#location')).toHaveCount(0);
  const location = await page.evaluate(() => resolveReportLocation(getDetectedGPS(), getSession()));
  const response = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const result = await response;
  expect(result.status()).toBe(201);
  const report = await result.json();
  expect(report.location).toBe(location);
  return report;
}

test('accepts the suggestion with exactly three mapped choices and no subtype selector', async ({ page }) => {
  await scan(page);
  await expect(page.locator('#citizenCategory')).toHaveValue('Road Damage');
  expect(await page.locator('#citizenCategory option').allTextContents()).toEqual(['Select category', 'Street Light Damage', 'Flooding / Drainage', 'Road Damage']);
  await expect(page.locator('#visionDetectBox')).toContainText('pothole');
  await expect(page.locator('#visionDetectBox')).toContainText('AI evidence consistent');
  await expect(page.locator('.citizen-assessment-summary')).toHaveText('Pothole detected in both photos.');
  await expect(page.locator('#visionDetectBox')).toContainText('Evidence verification: Verified');
  await expect(page.locator('.citizen-preview-frame .detection-overlay > div').first())
    .toHaveCSS('border-top-color', 'rgb(0, 230, 118)');
  await expect(page.locator('#visionDetectBox')).toContainText(/NeighborLens[- ]AI/);
  await expect(page.locator('#visionDetectBox')).not.toContainText('NeighborLens YOLOv8m, v9');
  await expect(page.locator('[name="citizenDamageType"]')).toHaveCount(0);
  const report = await submit(page);
  expect(report.citizenCategory).toBe('Road Damage');
  expect(report.originalAi.canonical_class).toBe('pothole');
  expect(report.originalAi.photos.map(photo => photo.model)).toEqual(Array(2).fill('NeighborLens YOLOv8m neighborlens_yolov8m_v9'));
  await expect(page.locator('#aiResult')).toContainText(/NeighborLens[- ]AI/);
  expect(report.status).toBe('pending');
});

test('Camo Studio evidence never shows a detection or submits a report', async ({ page, request }) => {
  await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
  await page.locator('#imgInput').setInputFiles(['camo-studio.png', 'camo-studio-second.png'].map(name => ({
    name, mimeType: 'image/png', buffer: evidenceFile(name)
  })));
  const panel = page.locator('[data-assessment-state]');
  await expect(panel).toHaveAttribute('data-assessment-state', 'INVALID_EVIDENCE');
  await expect(panel).toContainText('Replace screenshots');
  await expect(panel).not.toContainText('Broken Streetlight');
  await expect(page.locator('.detection-overlay')).toHaveCount(0);
  const submissions = [];
  page.on('request', outbound => {
    if (outbound.url().endsWith('/api/reports') && outbound.method() === 'POST') submissions.push(outbound);
  });
  await page.locator('#description').fill('This screenshot must be rejected.');
  await page.locator('#citizenCategory').selectOption('Street Light Damage');
  await expect(page.locator('#submitBtn')).toBeDisabled();
  await page.locator('#reportForm').dispatchEvent('submit', { cancelable: true });
  await expect(page.locator('#formError')).toContainText('Use clear photos of the infrastructure issue.');
  expect(submissions).toHaveLength(0);
});

test('an authoritative portrait rejection leaves retake available and blocks report submission', async ({ page }) => {
  await page.route('**/api/ai/damage', route => route.fulfill({
    status: 422,
    json: { code: 'INVALID_EVIDENCE', error: 'No supported issue was detected. Retake the photo with the infrastructure issue clearly visible.' }
  }));
  await page.locator('#imgInput').setInputFiles([
    { name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: evidenceFile('public-portrait.jpg') },
    { name: 'other-view.jpg', mimeType: 'image/jpeg', buffer: SECOND_JPEG_BYTES }
  ]);
  const panel = page.locator('[data-assessment-state]');
  await expect(panel).toHaveAttribute('data-assessment-state', 'INVALID_EVIDENCE');
  await expect(panel).toContainText('No supported issue was detected');
  await expect(page.locator('.detection-overlay')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retake photos' })).toBeVisible();
  await expect(page.locator('#submitBtn')).toBeDisabled();
});

for (const [scenario, secondClass] of [
  ['matching clogged drainage', 'clogged_drainage'],
  ['different classes', 'road_crack'],
  ['no second detection', null]
]) {
  test(`review preview boxes for ${scenario}`, async ({ page }) => {
    await page.route('**/api/ai/damage', route => route.fulfill({
      json: {
        evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED',
        photos: ['clogged_drainage', secondClass].map((suggested_class, index) => ({
          result: suggested_class ? {
            status: 'EVIDENCE_REVIEW_REQUIRED', detected: false, suggested_class, detections: [],
            evidence_reason: 'EVIDENCE_RELEVANCE_UNVERIFIED',
            image_size: { width: 100, height: 100 },
            model_info: { name: 'NeighborLens YOLOv8m', architecture: 'YOLOv8m', release_label: 'v9' },
            suggested_box: { confidence: index === 0 ? 0.637 : 0.815, bounding_box: { x: 20, y: 20, width: 60, height: 60 } }
          } : { status: 'NO_DETECTION', detected: false, detections: [] },
          correctionCategories: ['Road Damage', 'Flooding / Drainage', 'Street Light Damage']
        }))
      }
    }));
    const detection = page.waitForResponse('**/api/ai/damage');
    await page.locator('#imgInput').setInputFiles([JPEG_BYTES, SECOND_JPEG_BYTES].map((buffer, index) => ({
      name: `angle-${index}.jpg`, mimeType: 'image/jpeg', buffer
    })));
    expect((await (await detection).json()).evidenceStatus).toBe('EVIDENCE_REVIEW_REQUIRED');
    const panel = page.locator('#visionDetectBox');
    const boxes = page.locator('.citizen-preview-frame .detection-overlay > div');
    if (secondClass === 'clogged_drainage') {
      await expect(page.locator('#citizenCategory')).toHaveValue('Flooding / Drainage');
      await expect(page.getByRole('radio', { name: 'Clogged Drainage' })).toBeChecked();
      await expect(page.locator('#submitBtn')).toBeEnabled();
      await expect(boxes).toHaveText(['Clogged Drainage 63.7%', 'Clogged Drainage 81.5%']);
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('AI Damage Assessment');
      await expect(panel).toContainText('AI suggests Clogged Drainage in both photos.');
      await expect(panel.locator('[data-damage-severity]')).toHaveText('Not assessed');
      await expect(panel.locator('select')).toHaveCount(0);
      await expect(panel.locator('details')).not.toHaveAttribute('open', '');
      await panel.getByText('Detection details').click();
      await expect(panel.locator('[data-review-reason="EVIDENCE_RELEVANCE_UNVERIFIED"]')).toBeVisible();
      await expect(panel).toContainText('Candidate Category: Flooding / Drainage');
      await expect(panel).toContainText('Overall AI confidence: 72.6%');
      await expect(panel).toContainText('Photo 1: Clogged Drainage · 63.7% · Moderate');
      await expect(panel).toContainText('Damage Agreement: Yes (provisional)');
      await expect(panel).toContainText(/Model: .*NeighborLens[- ]AI/);
      await expect(page.locator('#description')).toHaveValue('Possible issue in both photos: Clogged Drainage.');
      await expect(boxes.first()).toHaveCSS('border-top-color', 'rgb(245, 166, 35)');
      await expect(boxes.nth(1)).toHaveCSS('border-top-color', 'rgb(0, 230, 118)');
      await page.locator('#previewFrame1').click();
      await expect(page.locator('#citizenEvidenceSubtitle')).toHaveText('Clogged Drainage · 63.7% · Moderate');
      const enlargedBox = page.locator('#citizenEvidenceDialog .detection-overlay > div');
      await expect(enlargedBox).toBeVisible();
      await expect(enlargedBox).toHaveCSS('border-top-color', 'rgb(245, 166, 35)');
      const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      await expect(page.locator('#citizenEvidenceDialog .rd-dialog-hints')).toContainText(touch ? 'Pinch to zoom' : 'Scroll to zoom');
      await expect(panel).toContainText('pixel similarity (advisory)');
    } else {
      await expect(page.locator('#citizenCategory')).toHaveValue('');
      await expect(page.locator('#submitBtn')).toBeDisabled();
      await expect(panel).toContainText('Evidence verification: Pending');
      await expect(panel.locator('.citizen-assessment-summary')).toHaveText(secondClass
        ? 'The photos suggest different damage types.' : 'No conclusive damage detection.');
      await expect(boxes).toHaveCount(0);
      await expect(page.locator('#description')).toHaveValue('');
    }
  });
}

test('review preview boxes for matching streetlight show low gray and high green', async ({ page }) => {
  await page.route('**/api/ai/damage', route => route.fulfill({ json: {
    evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED',
    photos: [0.24, 0.92].map(confidence => ({ result: {
      status: 'EVIDENCE_REVIEW_REQUIRED', detected: false,
      suggested_class: 'broken_streetlight', detections: [],
      suggested_box: { confidence, bounding_box: { x: 20, y: 20, width: 60, height: 60 } },
      image_size: { width: 100, height: 100 }
    } }))
  } }));
  await scan(page);
  const boxes = page.locator('.citizen-preview-frame .detection-overlay > div');
  await expect(boxes).toHaveText(['Broken Streetlight 24%', 'Broken Streetlight 92%']);
  await expect(boxes.first()).toHaveCSS('border-top-color', 'rgb(203, 213, 225)');
  await expect(boxes.nth(1)).toHaveCSS('border-top-color', 'rgb(0, 230, 118)');
  await expect(page.locator('[data-damage-severity]')).toHaveText('Not assessed');
  await page.locator('#previewFrame1').click();
  await expect(page.locator('#citizenEvidenceDialog .detection-overlay > div')).toHaveCSS('border-top-color', 'rgb(203, 213, 225)');
});

test('single-photo preview keeps its box without selecting a report category', async ({ page }) => {
  await page.route('**/api/ai/damage', route => route.fulfill({ json: {
    evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED',
    photos: [
      { result: {
        status: 'EVIDENCE_REVIEW_REQUIRED', detected: false, single_photo_preview: true,
        suggested_class: 'clogged_drainage', suggested_confidence: 0.91, detections: [],
        image_size: { width: 100, height: 100 },
        suggested_box: { confidence: 0.91, bounding_box: { x: 20, y: 20, width: 60, height: 60 } }
      } },
      { result: { status: 'NO_DETECTION', detected: false, detections: [] } }
    ]
  } }));
  await scan(page);
  const panel = page.locator('#visionDetectBox');
  await expect(panel.locator('.citizen-assessment-summary')).toHaveText('AI suggests Clogged Drainage in Photo 1.');
  await expect(page.locator('#previewFrame1 .detection-overlay > div')).toHaveText('Clogged Drainage 91%');
  await expect(page.locator('#previewFrame2 .detection-overlay > div')).toHaveCount(0);
  await expect(page.locator('#citizenCategory')).toHaveValue('');
  await expect(panel.getByText('Evidence needs review', { exact: true })).toBeHidden();
  await expect(panel.getByText('Pending', { exact: true })).toBeHidden();
  await panel.getByText('Detection details').click();
  await expect(panel.getByText('Pending', { exact: true })).toBeVisible();
});

for (const classification of ['MAJOR', 'MINOR']) test(`Citizen card shows ${classification} before detection details @severity`, async ({ page }) => {
  const result = {
    status: 'DETECTED', detected: true, evidence_relevance: 'VERIFIED', canonical_category: 'pothole',
    display_category: 'Pothole', report_category: 'Road Damage', confidence: 0.94,
    candidate: { canonical_category: 'pothole', display_category: 'Pothole', confidence: 0.94, accepted: true },
    detections: []
  };
  await page.route('**/api/ai/damage', route => route.fulfill({ json: {
    severitySuggestion: { classification, category: 'pothole', source: 'approved_measurement_rule', policyVersion: 'test-policy' },
    photos: [{ result }, { result }]
  } }));
  await scan(page);
  const card = page.locator('#visionDetectBox');
  await expect(card.locator('[data-damage-severity]')).toHaveText(classification === 'MAJOR' ? 'Major' : 'Minor');
  await expect(card).toContainText('AI suggestion · Validated measurements');
  await expect(card.locator('.visual-extent')).toHaveCount(0);
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  await expect(card).toContainText('Overall AI confidence: 94%');
  await expect(card).toContainText('Evidence verification: Verified');
  await expect(card).toContainText('Validated measurements · policy test-policy');
});

test('a mixed pair with overlapping subject evidence shows retake guidance without any classification @relevance', async ({ page }) => {
  const result = reason => ({
    status: 'EVIDENCE_REVIEW_REQUIRED', evidence_relevance: 'UNVERIFIED', evidence_reason: reason, detections: [], candidate: null
  });
  await page.route('**/api/ai/damage', route => route.fulfill({ json: {
    evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED',
    photos: ['UNRELATED_SUBJECT_OVERLAP', 'EVIDENCE_VERIFIER_UNAVAILABLE'].map(reason => ({ result: result(reason) }))
  } }));
  await scan(page);
  const card = page.locator('#visionDetectBox');
  await expect(card).toContainText('Retake the photo and center the infrastructure damage.');
  await expect(card.locator('[data-damage-severity]')).toHaveText('Not assessed');
  await expect(page.locator('.citizen-preview-frame .detection-overlay > div')).toHaveCount(0);
  await expect(page.locator('#citizenCategory')).toHaveValue('');
});

test('Citizen location map shows the selected reference with OpenStreetMap tiles and follows GPS outside Bacolod @location', async ({ page, context }) => {
  const assets = await Promise.all(['leaflet-global.js', 'leaflet.css']
    .map(async file => {
      const url = `https://cdn.jsdelivr.net/npm/leaflet@2.0.0-beta.5/dist/${file}`;
      const response = await fetch(url);
      expect(response.ok).toBe(true);
      return [url, { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') }];
    }));
  for (const [url, payload] of assets) await page.route(url, route => route.fulfill(payload));
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: PNG_BYTES }));
  await page.route('**/api/config/report-area', route => route.fulfill({ json: {
    status: 'AUTHORITATIVE_POLYGONS_PENDING', barangayId: null
  } }));
  await moveBrowserLocation(page, context, { latitude: 10.695, longitude: 122.965, accuracy: 15 });
  let releaseAddress;
  const outsideAddress = new Promise(resolve => { releaseAddress = resolve; });
  await page.route('https://photon.komoot.io/reverse?**', route => {
    const lat = Number(new URL(route.request().url()).searchParams.get('lat'));
    return lat === 7.7723 ? route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: {
      features: [{ properties: {
        district: 'Base Camp', city: 'Maramag', state: 'Bukidnon', postcode: '8714', country: 'Philippines'
      } }]
    } }) : route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.route('**/api/config/reverse-geocode?**', async route => {
    const latitude = Number(new URL(route.request().url()).searchParams.get('lat'));
    if (latitude === 10.7202) await outsideAddress;
    if ([7.7723, 7.77].includes(latitude)) return route.fulfill({ status: 429 });
    if (latitude === 7.78) return route.fulfill({ json: { ok: true, data: {
      display_name: 'Maramag, Bukidnon, Philippines', address: { town: 'Maramag', province: 'Bukidnon' }
    } } });
    if (latitude === 10.6834706) return route.fulfill({ json: { ok: true, data: {
      display_name: 'Hyacinth Street, Estefania, Bacolod City',
      address: { village: 'Estefania', city: 'Bacolod City' }
    } } });
    const atCitadines = latitude === 10.7008;
    await route.fulfill({ json: { ok: true, data: {
      display_name: atCitadines ? 'Citadines Bacolod City, Lacson Street, Mandalagan, Bata, Bacolod City' : 'Mandalagan, Bacolod City',
      address: { city: 'Bacolod City', village: atCitadines ? 'Bata' : 'Mandalagan' }
    } } });
  });
  await page.goto('/citizen.html');
  await expect(page.locator('.geo-address')).toHaveText('Mandalagan, Bacolod City');
  const inline = page.locator('#citizenInlineMap');
  await expect(inline.locator('.bacolod-barangay-outline')).toHaveCount(1);
  if (page.viewportSize().width > 900) await expect(inline.locator('.bacolod-barangay-outline')).toBeVisible();
  const open = page.getByRole('button', { name: 'Open location map' });
  await open.click();
  const map = page.getByRole('dialog', { name: 'Report location' });
  const label = map.getByText('Brgy. Mandalagan \u00b7 Map reference', { exact: true });
  const polygon = map.locator('.bacolod-barangay-outline');
  await expect(polygon).toHaveCount(1);
  await expect(label).toBeVisible();
  await expect(map.locator('.leaflet-tile-loaded[src*="tile.openstreetmap.org"]').first()).toBeVisible();
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await map.getByRole('button', { name: 'Show report location' }).click();
  await expect(map.getByRole('button', { name: 'Show barangay boundary' })).toBeVisible();
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await map.getByRole('button', { name: 'Show barangay boundary' }).click();
  await expect(map.getByRole('button', { name: 'Show report location' })).toBeVisible();
  await moveBrowserLocation(page, context, { latitude: 10.6834706, longitude: 122.9905235, accuracy: 15 });
  await expect(map.getByRole('status')).toHaveText('Near Estefania / Mandalagan boundary \u00b7 Map reference');
  await expect(map.locator('.bacolod-nearby-outline')).toHaveCount(2);
  await map.getByRole('button', { name: 'Show report location' }).click();
  await expect(map.getByRole('button', { name: 'Show nearby boundaries' })).toBeVisible();
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await map.getByRole('button', { name: 'Show nearby boundaries' }).click();

  await map.getByRole('button', { name: 'Close location map' }).click();
  await expect(inline.locator('.bacolod-nearby-outline')).toHaveCount(2);
  if (page.viewportSize().width > 900) await expect(inline.getByRole('status')).toHaveText('Near Estefania / Mandalagan boundary \u00b7 Map reference');
  await open.click();

  // Move the same GPS fix 0.001 degrees east, clearly inside Estefania in the reference.
  await moveBrowserLocation(page, context, { latitude: 10.6834706, longitude: 122.9915235, accuracy: 15 });
  await expect(map.getByRole('status')).toHaveText('Brgy. Estefania \u00b7 Map reference');
  await expect(polygon).toHaveCount(1);
  await expect(map.locator('.bacolod-nearby-outline')).toHaveCount(0);
  await moveBrowserLocation(page, context, { latitude: 10.6685, longitude: 122.9647, accuracy: 15 });
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await expect(map.getByRole('status')).toHaveText('Brgy. Villamonte \u00b7 Map reference');
  await expect(polygon).toHaveCount(1);
  await expect(map.locator('.leaflet-tooltip')).toHaveCount(0);
  await moveBrowserLocation(page, context, { latitude: 10.6685, longitude: 122.9647, accuracy: 500 });
  await expect(page.locator('#gpsStatus')).toContainText('last accurate location');
  await expect(polygon).toHaveCount(1);
  await expect(map.locator('.leaflet-tooltip')).toHaveCount(0);
  await moveBrowserLocation(page, context, { latitude: 10.6685, longitude: 122.9647, accuracy: 15 });
  await expect(map.getByRole('status')).toHaveText('Brgy. Villamonte \u00b7 Map reference');

  // The interior ring in the Villamonte reference is occupied by Montevista.
  await moveBrowserLocation(page, context, { latitude: 10.668654, longitude: 122.9711347, accuracy: 15 });
  await expect(map.getByRole('status')).toHaveText('Brgy. Montevista \u00b7 Map reference');
  await expect(polygon).toHaveCount(1);
  await moveBrowserLocation(page, context, { latitude: 10.7008, longitude: 122.9633, accuracy: 15 });
  await expect(page.locator('.geo-address')).toHaveText('Citadines Bacolod City, Lacson Street, Bata, Bacolod City');
  try {
    await moveBrowserLocation(page, context, { latitude: 10.7202, longitude: 122.5621, accuracy: 150 });
    await expect(page.locator('#gpsStatus')).toContainText('last accurate location');
    await moveBrowserLocation(page, context, { latitude: 10.7202, longitude: 122.5621, accuracy: 15 });
    await expect(map.getByText('Outside Bacolod City', { exact: true })).toBeVisible();
    await expect(polygon).toHaveCount(0);
    await expect(map.getByRole('button', { name: 'Show report location' })).toBeHidden();
    const marker = map.locator('.leaflet-marker-icon');
    await marker.click();
    await expect(map.locator('.leaflet-popup-content')).toContainText('10.72020, 122.56210');
  } finally {
    releaseAddress();
  }
  await moveBrowserLocation(page, context, { latitude: 7.78, longitude: 125.03, accuracy: 15 });
  const outsideLocation = page.locator('#gpsStatus .citizen-loc-brgy-title');
  await expect(outsideLocation).toHaveText('Maramag, Bukidnon, Philippines');
  await expect(page.locator('#gpsStatus .geo-warning-banner')).toHaveCount(0);
  await expect(map.getByText('Outside Bacolod City', { exact: true })).toBeVisible();
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await moveBrowserLocation(page, context, { latitude: 7.7723, longitude: 124.98683, accuracy: 15 });
  await expect(outsideLocation).toHaveText('Base Camp, Maramag, Bukidnon, 8714, Philippines');
  await expect(page.locator('#gpsStatus')).not.toContainText('7.77230');
  await moveBrowserLocation(page, context, { latitude: 7.77, longitude: 124.99, accuracy: 15 });
  await expect(page.locator('#gpsStatus')).toContainText('Address unavailable. View location on map.');
  await expect(page.locator('#gpsStatus')).not.toContainText('7.77000');
  await expect(map.locator('.leaflet-marker-icon')).toBeVisible();
  await moveBrowserLocation(page, context, { latitude: 10.695, longitude: 122.965, accuracy: 15 });
  await expect(label).toBeVisible();
  await expect(polygon).toHaveCount(1);

  await map.getByRole('button', { name: 'Close location map' }).click();
  await expect(open).toBeFocused();
  await expect(page.locator('#citizenInlineMap #geoCanvas')).toHaveCount(1);
  await expect(inline.locator('.bacolod-barangay-outline')).toHaveCount(1);
});

test('high Road Crack confidence stays green while evidence needs review', async ({ page }) => {
  await page.route('**/api/ai/damage', route => route.fulfill({ json: {
    evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED',
    photos: [0.825, 0.826].map(confidence => ({ result: {
      status: 'EVIDENCE_REVIEW_REQUIRED', detected: false, evidence_relevance: 'UNAVAILABLE',
      evidence_reason: 'EVIDENCE_VERIFIER_UNAVAILABLE', suggested_class: 'road_crack', suggested_eligible: false,
      visual_extent: { category: 'road_crack', quality: 'EXPERIMENTAL', version: '1', grid: [80,75],
        features: { skeleton_length_px: 39.2, branch_clusters: 2 } },
      suggested_box: { confidence, bounding_box: { x: 8, y: 10, width: 80, height: 75 } },
      image_size: { width: 100, height: 100 }, detections: []
    } }))
  } }));
  await scan(page);
  const boxes = page.locator('.citizen-preview-frame .detection-overlay > div');
  await expect(boxes).toHaveText(['Road Crack 82.5%', 'Road Crack 82.6%']);
  for (const box of await boxes.all()) await expect(box).toHaveCSS('border-top-color', 'rgb(0, 230, 118)');
  const panel = page.locator('#visionDetectBox');
  await expect(panel.getByText('Overall: 82.6% · High', { exact: true })).toBeVisible();
  const card = panel.locator('[data-assessment-state]');
  await expect(card).toHaveAttribute('data-assessment-tone', 'success');
  await expect(card.locator('.citizen-assessment-summary')).toHaveText('AI suggests Road Crack in both photos.');
  await expect(card).not.toContainText('Your barangay can review');
  await expect(card).not.toContainText('Awaiting confirmation after submission');
  await panel.getByText('Detection details').click();
  await expect(panel.locator('[data-confidence-level="High"]')).toHaveText('82.6% · High');
  await expect(panel.locator('.visual-extent')).toHaveCount(0);
  await expect(panel.locator('[data-damage-severity]')).toHaveText('Not assessed');
  await expect(panel.locator('[data-severity-basis]')).toHaveText('Insufficient severity evidence.');
  await expect(panel.locator('select')).toHaveCount(0);
  await expect(panel).toContainText('Photo 1: Road Crack · 82.5% · High');
  await expect(panel).toContainText('Photo 2: Road Crack · 82.6% · High');
  await expect(panel).toContainText('Evidence verification: Pending');
  await expect(panel.getByText('Pending', { exact: true })).toHaveCount(1);
  await page.locator('#previewFrame2').click();
  await expect(page.locator('#citizenEvidenceSubtitle')).toHaveText('Road Crack · 82.6% · High');
  await expect(page.locator('#citizenEvidenceDialog .detection-overlay > div')).toHaveCSS('border-top-color', 'rgb(0, 230, 118)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('borderline duplicate evidence is submitted as pending manual review', async ({ page }) => {
  const modified = await sharp(JPEG_BYTES).linear(1, 8).jpeg({ quality: 85 }).toBuffer();
  await page.locator('#description').fill('Please inspect the report evidence.');
  const detection = page.waitForResponse('**/api/ai/damage');
  await page.locator('#imgInput').setInputFiles([JPEG_BYTES, modified].map((buffer, index) => ({
    name: `angle-${index}.jpg`, mimeType: 'image/jpeg', buffer
  })));
  expect((await (await detection).json()).evidenceStatus).toBe('EVIDENCE_REVIEW_REQUIRED');
  await expect(page.locator('#visionDetectBox').getByText('Needs review', { exact: true })).toBeVisible();
  await page.locator('#visionDetectBox summary').click();
  await expect(page.locator('[data-review-reason="SIMILAR_VIEWS"]')).toContainText('The photos may show the same angle.');
  await expect(page.locator('.citizen-preview-frame .detection-overlay > div').first())
    .toHaveCSS('border-top-color', 'rgb(0, 230, 118)');
  await expect(page.locator('#citizenCategory')).toHaveValue('Road Damage');
  await expect(page.locator('#submitBtn')).toBeEnabled();
  const report = await submit(page);
  expect(report.status).toBe('pending');
  expect(report.evidenceStatus).toBe('EVIDENCE_REVIEW_REQUIRED');
  expect(report.originalAi.detected).toBe(false);
});

test('citizen submits a manual category when the inference response has no signed proof', async ({ page, request }) => {
  await request.post('/__phase2_mode', { data: { mode: 'unavailable' } });
  await page.route('**/api/ai/damage', route => route.fulfill({ status: 503, json: { error: 'Synthetic AI outage' } }));
  await page.locator('#description').fill('Road crack reported during an AI outage.');
  await scan(page);
  await page.locator('#citizenCategory').selectOption('Road Damage');
  await expect(page.locator('#visionDetectBox')).toContainText('AI_UNAVAILABLE');
  const report = await submit(page);
  expect(report.citizenCategory).toBe('Road Damage');
  expect(report.originalAi).toBeNull();
  expect(report.publication.state).toBe('pending_approval');
});

test('corrects a suggestion, preserves description, and survives rerenders and reload', async ({ page, request }, info) => {
  await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
  await page.locator('#description').fill('The road is damaged, not the light.');
  await scan(page);
  await page.locator('#citizenCategory').selectOption('Road Damage');
  await page.locator('#citizenCategory').dispatchEvent('change');
  await expect(page.locator('#citizenCategory')).toHaveValue('Road Damage');
  await expect(page.locator('#citizenCategoryExplanation')).toContainText('Street Light Damage');
  await expect(page.locator('#description')).toHaveValue('The road is damaged, not the light.');
  const selector = await page.locator('#citizenCategory').boundingBox();
  const note = await page.locator('#citizenCategoryExplanation').boundingBox();
  expect(note.y).toBeGreaterThanOrEqual(selector.y + selector.height);
  expect(selector.x + selector.width).toBeLessThanOrEqual(page.viewportSize().width);
  await fs.mkdir('.data/phase-2-browser-screenshots', { recursive: true });
  await page.screenshot({ path: `.data/phase-2-browser-screenshots/${info.project.name}-correction.png`, fullPage: true });
  const report = await submit(page);
  expect(report.originalAi.suggested_category).toBe('Street Light Damage');
  expect(report.citizenCategory).toBe('Road Damage');
  await page.reload();
  await expect.poll(() => page.evaluate(id => getAllReports().find(report => report.backendId === id)?.citizenCategory, report.id)).toBe('Road Damage');
  const persisted = await page.evaluate(() => sessionStorage.getItem('up_reports'));
  expect(await page.evaluate(() => localStorage.getItem('up_reports'))).toBeNull();
  expect(persisted).not.toContain('assessmentProof');
  expect(persisted).not.toContain('proof_id');
});

test('matching low-confidence photos prefill the issue and submit for manual review', async ({ page, request }) => {
  await request.post('/__phase2_mode', { data: { mode: 'low' } });
  await scan(page);
  await expect(page.getByRole('radio', { name: 'Pothole' })).toBeChecked();
  await expect(page.locator('#citizenCategory')).toHaveValue('Road Damage');
  await expect(page.locator('#description')).toHaveValue('Possible issue in both photos: Pothole.');
  await expect(page.locator('[data-review-reason="BELOW_CONFIDENCE_THRESHOLD"]')).toBeVisible();
  await expect(page.locator('#submitBtn')).toBeEnabled();
  const report = await submit(page);
  expect(report.citizenCategory).toBe('Road Damage');
  expect(report.status).toBe('pending');
  expect(report.originalAi.status).toBe('LOW_CONFIDENCE');
  expect(report.originalAi.detected).toBe(false);
  expect(report.originalAi.canonical_class).toBeNull();
});

for (const [mode, status] of [['none', 'NO_DETECTION'], ['unavailable', 'AI_UNAVAILABLE']]) {
  test(`${status} requires an issue category before submission`, async ({ page, request }) => {
    await request.post('/__phase2_mode', { data: { mode } });
    await page.locator('#description').fill('Report without a category correction.');
    await scan(page);
    await expect(page.locator('#citizenCategory')).toHaveValue('');
    await expect(page.locator('#submitBtn')).toBeDisabled();
    await page.locator('#reportForm').dispatchEvent('submit', { cancelable: true });
    await expect(page.locator('#formError')).toContainText('Please select an issue category.');
  });
}

for (const [mode, status] of [['low', 'LOW_CONFIDENCE'], ['none', 'NO_DETECTION'], ['unavailable', 'AI_UNAVAILABLE']]) {
  test(`${status} permits manual category without invented accepted AI evidence`, async ({ page, request }) => {
    await request.post('/__phase2_mode', { data: { mode } });
    await page.locator('#description').fill('Citizen-written clarification.');
    await scan(page);
    await expect(page.locator('#citizenCategory')).toHaveValue(mode === 'low' ? 'Road Damage' : '');
    await expect(page.locator('#visionDetectBox')).toContainText(status);
    await page.locator('#citizenCategory').selectOption('Flooding / Drainage');
    const report = await submit(page);
    expect(report.originalAi.status).toBe(status);
    expect(report.originalAi.detected).toBe(false);
    expect(report.originalAi.canonical_class).toBeNull();
    expect(report.status).toBe('pending');
    expect(report.citizenCategory).toBe('Flooding / Drainage');
    expect(report.description).toBe('Citizen-written clarification.');
  });
}

test('submit tracks missing fields and photo removal on an otherwise valid report', async ({ page }) => {
  const button = page.locator('#submitBtn');
  const description = page.locator('#description');
  const category = page.locator('#citizenCategory');
  await expect(button).toBeDisabled();
  await description.fill('  ');
  await scan(page);
  await expect(category).toHaveValue('Road Damage');
  await expect(button).toBeDisabled();
  await page.locator('#reportForm').dispatchEvent('submit', { cancelable: true });
  await expect(page.locator('#formError')).toContainText('Please describe the issue.');
  await description.fill('The pothole is near the intersection.');
  await expect(button).toBeEnabled();
  await category.selectOption('');
  await expect(button).toBeDisabled();
  await page.locator('[data-cat-id="pothole"]').click();
  await expect(button).toBeEnabled();
  await page.evaluate(() => window.deleteCitizenPhoto(0));
  await expect(button).toBeDisabled();
});

test('replacement invalidates prior correction but preserves citizen-written description', async ({ page, request }) => {
  await scan(page);
  await page.locator('#citizenCategory').selectOption('Flooding / Drainage');
  await page.locator('#description').fill('Manual clarification must remain.');
  await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
  await scan(page);
  await expect(page.locator('#citizenCategory')).toHaveValue('Street Light Damage');
  await expect(page.locator('#description')).toHaveValue('Manual clarification must remain.');
  const report = await submit(page);
  expect(report.originalAi.canonical_class).toBe('broken_streetlight');
  expect(report.citizenCategory).toBe('Street Light Damage');
});

test('replacement updates AI-generated description rather than retaining old AI text', async ({ page, request }) => {
  await scan(page);
  expect(await page.locator('#description').inputValue()).toContain('Pothole');
  await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
  await scan(page);
  expect(await page.locator('#description').inputValue()).toContain('Broken Streetlight');
  expect(await page.locator('#description').inputValue()).not.toContain('Pothole');
});

test('older real signed responses cannot restore a stale correction or AI assessment', async ({ page, request }) => {
  await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
  const held = [];
  let intercepted = 0;
  await page.route('**/api/ai/damage', async route => {
    intercepted++;
    const response = await route.fetch();
    if (intercepted === 1) {
      await new Promise(resolve => held.push(() => route.fulfill({ response }).then(resolve)));
    } else await route.fulfill({ response });
  });
  await page.locator('#description').fill('Manual description across pending responses.');
  await page.locator('#imgInput').setInputFiles(photos.map((buffer, index) => ({ name: `old-${index}.png`, mimeType: 'image/png', buffer })));
  await expect.poll(() => held.length).toBe(1);
  await request.post('/__phase2_mode', { data: { mode: 'pothole' } });
  await scan(page);
  await page.locator('#citizenCategory').selectOption('Flooding / Drainage');
  await Promise.all(held.map(release => release()));
  await expect(page.locator('#citizenCategory')).toHaveValue('Flooding / Drainage');
  await expect(page.locator('#visionDetectBox')).toContainText('pothole');
  await expect(page.locator('#description')).toHaveValue('Manual description across pending responses.');
  const report = await submit(page);
  expect(report.originalAi.canonical_class).toBe('pothole');
});

test('unbound transport errors permit manual category submission without creating fake proofs', async ({ page }) => {
  await page.route('**/api/ai/damage', route => route.abort());
  await page.locator('#description').fill('Network failed during preview.');
  await page.locator('#imgInput').setInputFiles(photos.map((buffer, index) => ({ name: `network-${index}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('[data-assessment-state]')).toHaveAttribute('data-assessment-state', 'AI_SERVICE_ERROR');
  await expect(page.locator('#submitBtn')).toBeDisabled();
  await page.locator('#citizenCategory').selectOption('Road Damage');
  const report = await submit(page);
  expect(report.citizenCategory).toBe('Road Damage');
  expect(report.originalAi).toBeNull();
});

for (const role of ['barangay', 'admin']) {
test(`${role} reviewer sees original and citizen categories separately`, async ({ page, baseURL }, info) => {
  const description = '<img src="invalid" onerror="window.phase2Injected=true"> Citizen clarification';
  await page.locator('#description').fill(description);
  await scan(page);
  await page.locator('#citizenCategory').selectOption('Street Light Damage');
  const report = await submit(page);
  expect(report.description).toBe(description);
  const reviewer = await staffSession(baseURL, role, report.barangay);
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), reviewer);
  await page.goto(`/report-details.html?id=${report.id}`);
  const details = page.locator('#reportDetails');
  await expect(details).toBeVisible();
  if (role === 'barangay') {
  if (!await details.locator('.rd-staff-tools').evaluate(element => element.open)) await details.locator('.rd-staff-tools > summary').click();
  await expect(details.locator('.rd-summary')).toContainText('Street Light Damage');
  await expect(details.locator('.rd-summary')).toContainText('Road Damage');
  await expect(details.locator('.rd-summary')).toContainText('Pothole');
  await expect(details.locator('.rd-summary .rd-note')).toContainText('Citizen correction');
  } else await expect(details.locator('.rd-staff-tools, .rd-summary, .rd-review-form')).toHaveCount(0);
  await expect(details.locator('.rd-status')).toContainText('Pending');
  await expect(details.locator('.rd-description')).toHaveText(description);
  expect(await page.evaluate(() => window.phase2Injected)).not.toBe(true);
  await expect(details.locator('img[src="invalid"]')).toHaveCount(0);
  await expect(details).not.toContainText('Provisional Candidate');
  expect(await details.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await fs.mkdir('.data/phase-2-browser-screenshots', { recursive: true });
  await details.screenshot({ path: `.data/phase-2-browser-screenshots/${info.project.name}-${role}.png` });
  await page.evaluate(() => logout());
  await page.waitForURL(/(?:admin-|barangay-)?login\.html$/);
  if (role === 'admin') adminFixture = null;
  expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('up_reports'))).toBeNull();
});
}

for (const firstRole of ['admin', 'barangay', 'citizen']) {
test(`${firstRole} logout then another account cannot reuse prior report data`, async ({ page, request, baseURL }) => {
  const description = 'Private report from the first account.';
  await page.locator('#description').fill(description);
  await scan(page);
  const report = await submit(page);
  const first = firstRole === 'citizen' ? sessions.get(page) : await staffSession(baseURL, firstRole, report.barangay);
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), first);
  await page.goto(`/report-details.html?id=${report.id}`);
  await expect(page.locator('#reportDetails')).toContainText(description);
  await page.evaluate(() => { localStorage.setItem('theme-preference', 'dark'); logout(); });
  await page.waitForURL(/(?:admin-|barangay-)?login\.html$/);
  if (firstRole === 'admin') adminFixture = null;
  expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
  const role = firstRole === 'citizen' ? 'citizen' : 'barangay';
  let second;
  if (role === 'citizen') {
    const response = await request.post('/__fixture_citizen', { data: { username: `phase2_switch_${Date.now()}`, password: 'password123', barangay: 'Mandalagan' } });
    expect(response.status()).toBe(201);
    const data = await response.json(); second = { ...data.user, apiToken: data.token };
  } else second = await staffSession(baseURL, role, 'Mandalagan');
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), second);
  await page.goto(`/${role}.html`);
  await expect(page.locator(role === 'citizen' ? '#myReportsSection' : '.report-management')).toBeAttached();
  const denied = await request.get(`/api/reports/${report.id}`, {
    headers: { Authorization: `Bearer ${second.apiToken}` }, maxRetries: 1
  });
  expect(denied.status()).toBe(403);
  await expect(page.locator(role === 'citizen' ? '#myReports' : '#reportsBody')).not.toContainText(description);
  expect(await page.evaluate(() => localStorage.getItem('theme-preference'))).toBe('dark');
  expect(await page.evaluate(() => sessionStorage.getItem('up_reports') || '')).not.toContain(description);
});
}

for (const role of ['admin', 'barangay']) {
test(`${role} category filter matches its current query vocabulary`, async ({ page, request, baseURL }) => {
  const reviewer = await staffSession(baseURL, role, sessions.get(page).barangay);
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), reviewer);
  await page.goto(`/${role}.html${role === 'admin' ? '#reports' : ''}`);
  const choices = await page.locator(role === 'admin' ? '#adminFilterCategory option' : '#filterCategory option').allTextContents();
  const categories = ['Road Damage', 'Flooding / Drainage', 'Street Light Damage'];
  if (role === 'admin') categories.push('Electrical', 'Fallen Tree', 'Sanitation', 'Structural', 'Infrastructure');
  else {
    categories.push('Uncategorized');
    const unsupported = await request.get('/api/reports?category=Electrical', { headers: { Authorization: `Bearer ${reviewer.apiToken}` } });
    expect(unsupported.status()).toBe(400);
  }
  for (const category of categories) expect(choices).toContain(category);
});

test(`${role} unchanged category preserves the accepted suggestion and original result`, async ({ page, baseURL }) => {
  await scan(page);
  const report = await submit(page);
  const reviewer = await staffSession(baseURL, role, report.barangay);
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), reviewer);
  await page.goto(`/report-details.html?id=${report.id}`);
  const summary = page.locator('#reportDetails .rd-summary');
  if (role === 'barangay') {
    await expect(summary).toContainText('NeighborLens-AI YOLOv8m');
    await expect(summary).toContainText('Road Damage');
    await expect(summary).toContainText('Pothole');
    await expect(summary).toContainText('Suggestion accepted');
    await expect(summary).not.toContainText('Citizen correction');
  } else {
    await expect(page.locator('.rd-header h1')).toHaveText(`Report #${report.id}`);
    await expect(page.locator('.rd-metadata')).toContainText('NeighborLens-AI YOLOv8m');
    await expect(summary).toHaveCount(0);
    await expect(page.locator('.rd-review-form, .rd-severity')).toHaveCount(0);
  }
});
}
