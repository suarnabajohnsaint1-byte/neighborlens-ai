const { addReportGps } = require('../support/citizens');
const { fixedBrowserLocation, moveBrowserLocation } = require('../support/browser-geolocation');
const artifactRoot = require('node:path').join(require('node:os').tmpdir(), 'neighborlens-shared-browser-artifacts');
const { test, expect } = require('@playwright/test');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const { adminSession: loginAdminFixture, createOfficial } = require('../support/accounts');
let adminFixture;
const adminSession = baseURL => adminFixture ||= loginAdminFixture(baseURL);
let photos;
let tile;
const libraries = new Map();
const sessions = new WeakMap();
const errors = new WeakMap();
const description = '<img src="invalid" onerror="window.detailsInjected=true"> Road damage reported by the citizen.';
let recentApiRequests = [];
function apiSlot() {
  recentApiRequests = recentApiRequests.filter(time => time > Date.now() - 60000);
  recentApiRequests.push(Date.now());
}

test.beforeAll(async () => {
  photos = await Promise.all([0, 1].map(index => {
    const pixels = Buffer.alloc(160 * 120 * 3);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
      const offset = (y * 160 + x) * 3;
      pixels[offset] = (x + index * 35) % 160 + 30;
      pixels[offset + 1] = (y + index * 25) % 120 + 60;
      pixels[offset + 2] = x % 24 < 12 ? 190 : 70;
    }
    return sharp(pixels, { raw: { width: 160, height: 120, channels: 3 } }).png().toBuffer();
  }));
  tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#526b60' } }).png().toBuffer();
  for (const path of [
    'leaflet@2.0.0-beta.5/dist/leaflet-global.js',
    'leaflet@2.0.0-beta.5/dist/leaflet.css',
    'echarts@6.1.0/dist/echarts.min.js'
  ]) {
    const response = await fetch(`https://${path.startsWith('leaflet@') ? 'cdn.jsdelivr.net/npm' : 'unpkg.com'}/${path}`);
    expect(response.ok).toBe(true);
    libraries.set(`/${path.startsWith('leaflet@') ? 'npm/' : ''}${path}`, { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') });
  }
});

test.beforeEach(async ({ page, request, context }, info) => {
  test.setTimeout(90000);
  recentApiRequests = recentApiRequests.filter(time => time > Date.now() - 60000);
  if (recentApiRequests.length >= 250) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, recentApiRequests[recentApiRequests.length - 250] + 60100 - Date.now())));
    recentApiRequests = recentApiRequests.filter(time => time > Date.now() - 60000);
  }
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiSlot(); });
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
  let session = null;
  const adminAnalyticsOnly = /^(panel analytics splits|admin analytics (ignores|has stable|retries))/.test(info.title);
  if (!adminAnalyticsOnly) {
    const barangay = /same nearby boundaries/.test(info.title)
      ? 'Mansilingan'
      : /admin analytics (renders|refreshes)/.test(info.title)
        ? 'Villamonte'
        : 'Barangay 1';
    const registration = { data: { username: `details_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, password: 'password123', barangay } };
    let response = await request.post('/__fixture_citizen', registration);
    if (response.status() === 429) {
      await new Promise(resolve => setTimeout(resolve, Math.min(60, Number(response.headers()['retry-after']) || 1) * 1000 + 100));
      response = await request.post('/__fixture_citizen', registration);
    }
    expect(response.status()).toBe(201);
    const owner = await response.json();
    session = { ...owner.user, apiToken: owner.token };
    sessions.set(page, session);
  }
  await page.addInitScript(session => {
    if (session && !sessionStorage.getItem('details_test_session_initialized')) {
      sessionStorage.setItem('up_session', JSON.stringify(session));
      sessionStorage.setItem('details_test_session_initialized', '1');
    }
    Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => window.location.origin, set() { } });
  }, session);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['unpkg.com', 'cdn.jsdelivr.net'].includes(url.hostname) && libraries.has(url.pathname)) return route.fulfill(libraries.get(url.pathname));
    if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ body: tile, contentType: 'image/png' });
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/api/config/reverse-geocode') return route.fulfill({ json: { ok: true, data: { display_name: 'Bacolod City', address: { city: 'Bacolod City', village: 'Barangay Central' } } } });
    return route.continue();
  });
});

test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function createReport(page, request, baseURL, { mode = 'broken_streetlight', category = 'Road Damage', proofs = true, text = description, location = 'Citizen-recorded location', barangay = 'Barangay 1', gps = null } = {}) {
  const session = sessions.get(page);
  await request.post('/__phase2_mode', { data: { mode } });
  const evidence = [];
  if (proofs) for (let index = 0; index < 2; index++) {
    const body = new FormData();
    body.append('photoOrder', String(index + 1));
    body.append('images', new File([photos[index]], `photo-${index}.png`, { type: 'image/png' }));
    await apiSlot();
    const response = await fetch(`${baseURL}/api/ai/damage`, { method: 'POST', headers: { Authorization: `Bearer ${session.apiToken}` }, body });
    const result = await response.json();
    expect(result.assessmentProof).toBeTruthy();
    evidence.push(result.assessmentProof);
  }
  const body = new FormData();
  body.append('description', text);
  body.append('location', location);
  body.append('barangay', barangay);
  if (gps) {
    body.append('latitude', String(gps.lat));
    body.append('longitude', String(gps.lon));
    body.append('gpsAccuracy', String(gps.accuracy));
  }
  addReportGps(body, barangay);
  if (proofs) {
    if (category) body.append('citizenCategory', category);
    body.append('assessmentProofs', JSON.stringify(evidence));
  }
  photos.forEach((bytes, index) => body.append('images', new File([bytes], `photo-${index}.png`, { type: 'image/png' })));
  await apiSlot();
  const response = await fetch(`${baseURL}/api/reports`, { method: 'POST', headers: { Authorization: `Bearer ${session.apiToken}` }, body });
  expect(response.status).toBe(201);
  return response.json();
}

async function open(page, report) {
  await page.goto(`/report-details.html?id=${report.id}`);
  await expect(page.locator('#reportDetails')).toBeVisible();
  if (await page.locator('.rd-staff-tools').count()) if (!await page.locator('.rd-staff-tools').evaluate(element => element.open)) await page.locator('.rd-staff-tools > summary').click();
  await expect.poll(() => page.locator('.rd-photo img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
}

function statusPayload(status) {
  return status === 'resolved'
    ? { multipart: { status, note: 'Completed repair with supporting evidence', requestKey: require('node:crypto').randomUUID(), images: { name: 'completion.png', mimeType: 'image/png', buffer: photos[0] } } }
    : { data: { status, ...(status === 'rejected' ? { note: 'Duplicate incident confirmed during review.' } : {}) } };
}

async function adminFilters(page, id, operation) {
  const trigger = page.locator(`[data-sheet-open="${id}"]`);
  if (await trigger.isVisible()) await trigger.click();
  await operation();
  const apply = page.locator(`#${id} [data-sheet-apply]`);
  if (await apply.isVisible()) await apply.click();
}

async function adminNavigate(page, section) {
  const link = page.locator(`.nav-links a[data-section="${section}"]`);
  await expect(page).toHaveURL(/\/admin\.html(?:#.*)?$/);
  await expect(link).toBeAttached();
  if (!await link.isVisible()) await page.locator('#adminMenuButton').click();
  await link.click();
}

async function adminAppearance(page, theme) {
  const control = page.getByRole('switch', { name: 'Dark mode', exact: true });
  if (!await control.isVisible()) await page.locator('#adminMenuButton').click();
  await control.setChecked(theme === 'dark');
  const close = page.locator('#adminSidebar .portal-sidebar-close');
  if (await close.isVisible()) await close.click();
}

async function expectLiveMapTiles(page) {
  const dialog = page.getByRole('dialog', { name: 'Report location' });
  const openMap = !await dialog.isVisible() && await page.locator('#citizenInlineMap').isHidden();
  if (openMap) await page.getByRole('button', { name: 'Open location map' }).click();
  await expect(page.locator('#geoCanvas.leaflet-container')).toBeVisible();
  await expect.poll(() => page.locator('#geoCanvas').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const tiles = [...element.querySelectorAll('.leaflet-tile-loaded')]
      .filter(tile => tile.complete && tile.naturalWidth > 0)
      .map(tile => tile.getBoundingClientRect());
    const corners = [
      [bounds.left + 4, bounds.top + 4], [bounds.right - 4, bounds.top + 4],
      [bounds.left + 4, bounds.bottom - 4], [bounds.right - 4, bounds.bottom - 4]
    ];
    return corners.every(([x, y]) => tiles.some(tile => x >= tile.left && x <= tile.right && y >= tile.top && y <= tile.bottom));
  })).toBe(true);
  if (openMap) await dialog.getByRole('button', { name: 'Close location map' }).click();
}

test('report camera fills the viewport and sends both captures for duplicate validation', async ({ page, request }, info) => {
  await request.post('/__phase2_mode', { data: { mode: 'pothole' } });
  await page.addInitScript(() => {
    localStorage.setItem('neighborlens:theme-preference:v1', 'dark');
    window.cameraTracks = [];
    window.cameraRequests = [];
    window.cameraEffects = [];
    window.cameraVibrations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      for (const name of ['flash', 'flight', 'capture']) {
        if (this.hasAttribute(`data-camera-${name}`)) window.cameraEffects.push([name, options.duration]);
      }
      return animate.call(this, keyframes, options);
    };
    Object.defineProperty(navigator, 'vibrate', { value: duration => window.cameraVibrations.push(duration) });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async constraints => {
          window.cameraRequests.push(constraints.video);
          const canvas = document.createElement('canvas');
          const portrait = innerHeight > innerWidth;
          canvas.width = portrait ? 216 : 384;
          canvas.height = portrait ? 432 : 216;
          const context = canvas.getContext('2d');
          const paint = () => {
            context.fillStyle = '#999c9e';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#394147';
            for (let x = 0; x < canvas.width; x += 24) context.fillRect(x, x % 46, 8, canvas.height * .8);
          };
          paint();
          const stream = canvas.captureStream(12);
          const track = stream.getVideoTracks()[0];
          track.getSettings = () => ({ deviceId: constraints.video.deviceId?.exact || 'rear' });
          window.cameraTracks.push(track);
          requestAnimationFrame(paint);
          return stream;
        },
        enumerateDevices: async () => ['rear', 'front'].map(deviceId => ({ deviceId, kind: 'videoinput' }))
      }
    });
  });
  await page.goto('/citizen.html');
  const trigger = page.getByRole('button', { name: 'Use camera', exact: true }).filter({ visible: true });
  await expect(page.locator('#imgInput')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Upload photos' })).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Capture issue photos' });
  const viewport = page.viewportSize();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveCount(0);
  expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  const video = dialog.locator('video');
  const viewfinder = await video.boundingBox();
  expect(viewfinder).toEqual({ x: 0, y: 0, ...viewport });
  await expect(video).toHaveCSS('object-fit', 'cover');
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeHidden();
  await expect(dialog.getByRole('group', { name: 'Camera zoom' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Capture photo 1' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Flip camera' }).click();
  await expect.poll(() => page.evaluate(() => window.cameraRequests[1]?.deviceId.exact)).toBe('front');
  await expect.poll(() => page.evaluate(() => window.cameraTracks[0].readyState)).toBe('ended');
  await dialog.getByRole('button', { name: 'Capture photo 1' }).click();
  await expect(dialog.getByText('Photo 2 of 2 · Move to another angle')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Retake photo 1' }).locator('img')).toBeVisible();
  expect(await page.evaluate(() => window.cameraEffects)).toEqual([['flash', 180], ['capture', 170], ['flight', 220]]);
  expect(await page.evaluate(() => window.cameraVibrations)).toEqual([12]);
  await page.screenshot({ path: info.outputPath('report-camera.png') });
  await dialog.getByRole('button', { name: 'Retake photo 1' }).click();
  await dialog.getByRole('button', { name: 'Capture photo 1' }).click();
  const scanRequest = page.waitForRequest(req =>
    new URL(req.url()).pathname === '/api/ai/damage' && req.method() === 'POST');
  await dialog.getByRole('button', { name: 'Capture photo 2' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#previewAttachedCount')).toHaveText('2 of 2 photos attached');
  await expect(page.getByRole('button', { name: 'Replace', exact: true })).toHaveCount(0);
  const scan = await scanRequest;
  const body = new Response(scan.postDataBuffer(), { headers: { 'content-type': scan.headers()['content-type'] } });
  const files = (await body.formData()).getAll('images');
  expect(files).toHaveLength(2);
  for (const [index, file] of files.entries()) {
    expect(file.name).toContain(`damage_angle_${index + 1}_`);
    const { width, height } = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
    expect([width, height]).toEqual(viewport.height > viewport.width ? [216, 432] : [384, 216]);
  }
  await expect.poll(() => page.evaluate(() => window.cameraTracks.map(track => track.readyState))).toEqual(['ended', 'ended']);

  await page.locator('#previewActiveBar [data-report-camera]').click();
  await expect(dialog.getByRole('button', { name: 'Capture photo 1' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Retake photo 2' })).toBeDisabled();
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    window.cameraEncodeCount = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      window.cameraEncodeCount++;
      window.finishCameraCapture = () => new Promise(resolve => original.call(this, blob => {
        HTMLCanvasElement.prototype.toBlob = original;
        callback(blob);
        resolve();
      }, ...args));
    };
  });
  await dialog.getByRole('button', { name: 'Capture photo 1' }).click();
  await expect(dialog.getByRole('button', { name: 'Capture photo 1' })).toBeDisabled();
  await dialog.locator('[data-camera-capture]').dispatchEvent('click');
  expect(await page.evaluate(() => window.cameraEncodeCount)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#previewActiveBar [data-report-camera]')).toBeFocused();
  await expect(page.locator('#previewAttachedCount')).toHaveText('2 of 2 photos attached');
  await expect.poll(() => page.evaluate(() => window.cameraTracks.at(-1).readyState)).toBe('ended');
  await page.locator('#previewActiveBar [data-report-camera]').click();
  await expect(dialog.getByRole('button', { name: 'Capture photo 1' })).toBeEnabled();
  await page.evaluate(() => window.finishCameraCapture());
  await expect(dialog.getByRole('button', { name: 'Retake photo 1' }).locator('img')).toBeHidden();
  await expect(dialog.getByText('Photo 1 of 2 · Take a close-up')).toBeVisible();
  const requestsAfterRetake = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/ai/damage' && req.method() === 'POST') requestsAfterRetake.push(req);
  });
  await dialog.getByRole('button', { name: 'Capture photo 1' }).click();
  await expect(dialog.getByRole('button', { name: 'Capture photo 2' })).toBeEnabled();
  expect(requestsAfterRetake).toHaveLength(0);
  const retakeRequest = page.waitForRequest(req => new URL(req.url()).pathname === '/api/ai/damage' && req.method() === 'POST');
  await dialog.getByRole('button', { name: 'Capture photo 2' }).click();
  await expect(dialog).toBeHidden();
  const retake = await retakeRequest;
  const retakeBody = new Response(retake.postDataBuffer(), { headers: { 'content-type': retake.headers()['content-type'] } });
  const retaken = (await retakeBody.formData()).getAll('images');
  expect(retaken).toHaveLength(2);
  expect(retaken[0].name).not.toBe(files[0].name);
  expect(retaken[1].name).not.toBe(files[1].name);

  await expect(page.locator('#visionDetectBox [data-assessment-state="DUPLICATE_EVIDENCE"]')).toBeVisible();
  await expect(page.locator('#gpsStatus')).toContainText('Location detected');
  await page.locator('#description').fill('A pothole in the road beside the crossing.');
  await page.getByRole('button', { name: 'Remove photo 1', exact: true }).click();
  await expect(page.locator('#previewAttachedCount')).toHaveText('1 of 2 photos attached');
  await page.getByRole('button', { name: 'Take second photo' }).click();
  await expect(dialog.getByRole('button', { name: 'Retake photo 1' }).locator('img')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Capture photo 2' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Remove photo 1', exact: true }).click();
  const photoPrompt = page.locator('#dropzoneEmptyState');
  await expect(trigger).toBeVisible();
  await expect(photoPrompt).toHaveCSS('display', 'flex');
  const label = await photoPrompt.locator('.citizen-dropzone-sub').boundingBox();
  const button = await trigger.boundingBox();
  expect(Math.abs(label.x + label.width / 2 - button.x - button.width / 2)).toBeLessThan(1);
  await expect(page.locator('#imgPreviewGrid')).toBeHidden();
  await expect(page.locator('#visionDetectBox')).toBeHidden();
  await expect(page.locator('#gpsStatus')).toContainText('Location detected');
  await expect(page.locator('#description')).toHaveValue('A pothole in the road beside the crossing.');
});

test('report camera uses track zoom and focus, respects reduced motion, and refreshes capabilities after switching', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.cameraConstraints = [];
    window.cameraAdjustments = [];
    window.cameraFlashCount = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.hasAttribute('data-camera-flash')) window.cameraFlashCount++;
      return animate.apply(this, args);
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getSupportedConstraints: () => ({ zoom: true, pointsOfInterest: true }),
        enumerateDevices: async () => ['Rear camera', 'Front camera'].map((label, index) => ({ deviceId: index ? 'front' : 'rear', kind: 'videoinput', label })),
        getUserMedia: async ({ video }) => {
          window.cameraConstraints.push(video);
          const front = video.deviceId?.exact === 'front';
          if (front && video.zoom) throw new DOMException('Zoom permission denied', 'NotAllowedError');
          const canvas = document.createElement('canvas');
          canvas.width = 336;
          canvas.height = 448;
          canvas.getContext('2d').fillRect(0, 0, 220, 300);
          const stream = canvas.captureStream(10);
          const track = stream.getVideoTracks()[0];
          const settings = front ? { deviceId: 'front', facingMode: 'user' } : { deviceId: 'rear', facingMode: 'environment', zoom: 1 };
          track.getSettings = () => ({ ...settings });
          track.getCapabilities = () => front ? {} : { zoom: { min: 1, max: 2.6, step: .2 }, focusMode: ['continuous'] };
          track.getConstraints = () => video;
          track.applyConstraints = async constraints => {
            const adjustment = constraints.advanced.at(-1);
            window.cameraAdjustments.push({ adjustment, width: constraints.width });
            await new Promise(resolve => setTimeout(resolve, 15));
            Object.assign(settings, adjustment);
          };
          return stream;
        }
      }
    });
  });
  await page.goto('/citizen.html');
  await page.getByRole('button', { name: 'Use camera', exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture issue photos' });
  const zoom = dialog.getByRole('group', { name: 'Camera zoom' });
  const shutter = dialog.getByRole('button', { name: 'Capture photo 1' });
  await expect(zoom.getByRole('button', { name: '1× zoom' })).toHaveAttribute('aria-pressed', 'true');
  await zoom.getByRole('button', { name: '2× zoom' }).click();
  await expect(zoom.getByRole('button', { name: '2× zoom' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.cameraConstraints[0].zoom)).toBe(true);
  const zoomBox = await zoom.boundingBox(), shutterBox = await shutter.boundingBox();
  expect(zoomBox.y + zoomBox.height).toBeLessThan(shutterBox.y);
  expect(shutterBox.y + shutterBox.height).toBeLessThan(844);

  const touch = await context.newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const gesture = (type, x = []) => touch.send('Input.dispatchTouchEvent', { type, touchPoints: x.map((value, id) => ({ x: value, y: 420, id })) });
  await gesture('touchStart', [145, 245]);
  await gesture('touchMove', [35, 355]);
  await gesture('touchEnd');
  await expect(dialog.locator('[data-camera-zoom-level]')).toHaveText('2.6×');
  await gesture('touchStart', [65, 325]);
  await gesture('touchMove', [125, 265]);
  await gesture('touchEnd');
  await expect(dialog.locator('[data-camera-zoom-level]')).toHaveText('1.4×');
  const video = dialog.locator('video');
  const reticle = dialog.locator('[data-camera-focus]');
  await video.click({ position: { x: 115, y: 340 } });
  await expect(reticle).toBeVisible();
  await expect(reticle).toHaveCSS('left', '115px');
  await expect(reticle).toHaveCSS('top', '340px');
  const adjustments = await page.evaluate(() => window.cameraAdjustments);
  for (const { adjustment, width } of adjustments) {
    expect(adjustment.zoom).toBeGreaterThanOrEqual(1);
    expect(adjustment.zoom).toBeLessThanOrEqual(2.6);
    expect(width).toEqual({ ideal: 1920 });
  }
  expect(adjustments.at(-1).adjustment).toMatchObject({ focusMode: 'continuous', zoom: 1.4 });
  expect(adjustments.at(-1).adjustment.pointsOfInterest[0].y).toBeCloseTo(340 / 844, 3);
  await expect(video).toHaveCSS('transform', 'none');

  await shutter.click();
  await expect(dialog.getByRole('button', { name: 'Capture photo 2' })).toBeEnabled();
  expect(await page.evaluate(() => window.cameraFlashCount)).toBe(0);
  await dialog.getByRole('button', { name: 'Flip camera' }).click();
  await expect(dialog.getByRole('button', { name: 'Capture photo 2' })).toBeEnabled();
  await expect(zoom).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Retake photo 1' }).locator('img')).toBeVisible();
  const calls = await page.evaluate(() => window.cameraConstraints);
  expect(calls[1]).toMatchObject({ deviceId: { exact: 'front' }, zoom: true });
  expect(calls[2]).toMatchObject({ deviceId: { exact: 'front' } });
  expect(calls[2].zoom).toBeUndefined();
  await video.click({ position: { x: 115, y: 340 } });
  await expect(reticle).toBeHidden();
  await dialog.getByRole('button', { name: 'Close camera' }).click();
});

test('report camera handles denied permission and releases a stream granted after closing', async ({ page }) => {
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => {
          if (attempts++ === 0) throw new DOMException('Permission denied', 'NotAllowedError');
          return new Promise(resolve => {
            window.allowCamera = () => {
              const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
              window.lateCameraTrack = track;
              resolve({ getTracks: () => [track] });
            };
          });
        }
      }
    });
  });
  await page.goto('/citizen.html');
  await page.getByRole('button', { name: 'Use camera', exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture issue photos' });
  await expect(dialog.getByRole('status').filter({ hasText: 'Allow camera access' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Capture photo 1' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Starting camera' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close camera' }).click();
  await page.evaluate(() => window.allowCamera());
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.lateCameraTrack.readyState)).toBe('ended');
});

test('citizen navigates from My Reports, refreshes, and sees actual correction, photos, map, and history', async ({ page, request, baseURL }, info) => {
  const report = await createReport(page, request, baseURL);
  await page.goto('/citizen.html#my-reports');
  await expect(page.locator('.sidebar .logo')).toHaveCount(1);
  await expect(page.locator('.sidebar .portal-brand')).toHaveAttribute('aria-label', 'NeighborLens AI home');
  const link = page.locator(`a.report-entry-link[href="report-details.html?id=${report.id}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`report-details.html\\?id=${report.id}$`));
  await expect(page.locator('#reportDetails')).toBeVisible();
  await expect(page.locator('.rd-photos img')).toHaveCount(2);
  await expect.poll(() => page.locator('.rd-photo img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  await expect(page.locator('.rd-damage-title')).toHaveText('Road Damage');
  await expect(page.locator('.rd-summary')).toContainText('Citizen correction');
  await expect(page.locator('.rd-summary')).toContainText('Broken Streetlight');
  await expect(page.locator('.rd-summary')).toContainText('Street Light Damage');
  await expect(page.locator('.rd-description')).toHaveText(description);
  await expect(page.locator('.rd-description img')).toHaveCount(0);
  expect(await page.evaluate(() => window.detailsInjected)).not.toBe(true);
  await expect(page.locator('.rd-header [data-status] strong')).toHaveText('Pending');
  await expect(page.locator('.rd-timeline li')).toHaveCount(1);
  await expect(page.locator('.rd-timeline')).not.toContainText('Ongoing');
  await expect(page.locator('#reportMap.leaflet-container')).toBeVisible();
  await expect(page.locator('#reportMap .leaflet-tile-loaded').first()).toBeVisible();
  await expect(page.locator('#reportMap .leaflet-overlay-pane path').first()).toBeAttached();
  await expect(page.locator('.rd-gps')).toContainText('10.67800');
  await expect(page.locator('.rd-gps')).toContainText('15 m');
  await page.reload();
  await expect(page.locator('.rd-damage-title')).toHaveText('Road Damage');
  await expect(page.locator('.rd-summary')).toContainText('Broken Streetlight');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const overview = await page.locator('.rd-overview').boundingBox();
  const text = await page.locator('.rd-section').first().boundingBox();
  expect(text.y).toBeGreaterThanOrEqual(overview.y + overview.height);
  await fs.mkdir(`${artifactRoot}/report-details-screenshots`, { recursive: true });
  await page.screenshot({ path: `${artifactRoot}/report-details-screenshots/${info.project.name}-details.png`, fullPage: true });
  await page.getByRole('link', { name: 'Back to My Reports' }).click();
  await expect(page.locator('#myReportsSection')).toBeVisible();
  const thumbnail = page.locator('#myReports > div').filter({ has: link }).locator('img').first();
  await expect(thumbnail).toBeVisible();
  const bounds = await thumbnail.boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page).toHaveURL(new RegExp(`report-details.html\\?id=${report.id}$`));
  await expect(page.locator('.rd-damage-title')).toHaveText('Road Damage');
});

test('two evidence photos enlarge accessibly and restore keyboard focus', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await open(page, report);
  const first = page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#enlargedEvidence')).toHaveAttribute('alt', 'Submitted evidence photo 1');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(first).toBeFocused();
  await page.getByRole('button', { name: 'Enlarge submitted evidence photo 2', exact: true }).click();
  await page.getByRole('button', { name: 'Close enlarged photo' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('evidence photo zoom controls support scaling, wheel, dragging, reset, keyboard shortcuts, and image switching', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await open(page, report);
  const first = page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true });
  const second = page.getByRole('button', { name: 'Enlarge submitted evidence photo 2', exact: true });
  const image = page.locator('#enlargedEvidence');
  const zoomIn = page.locator('#zoomIn');
  const zoomOut = page.locator('#zoomOut');
  const resetZoom = page.locator('#resetZoom');

  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(resetZoom).toHaveText('100%');
  await expect(zoomOut).toBeDisabled();
  await expect(zoomIn).toBeEnabled();
  await expect.poll(() => image.evaluate(el => el.style.transform)).toBe('translate(0px, 0px) scale(1)');

  await zoomIn.click();
  await expect(resetZoom).toHaveText('125%');
  await expect(zoomOut).toBeEnabled();
  await expect.poll(() => image.evaluate(el => el.style.transform)).toBe('translate(0px, 0px) scale(1.25)');

  await zoomOut.click();
  await expect(resetZoom).toHaveText('100%');
  await expect(zoomOut).toBeDisabled();

  await zoomIn.click();
  await zoomIn.click();
  await expect(resetZoom).toHaveText('150%');
  await resetZoom.click();
  await expect(resetZoom).toHaveText('100%');
  await expect.poll(() => image.evaluate(el => el.style.transform)).toBe('translate(0px, 0px) scale(1)');

  const box = await image.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(resetZoom).toHaveText('125%');

  await page.mouse.wheel(0, 100);
  await expect(resetZoom).toHaveText('100%');

  await page.keyboard.press('+');
  await expect(resetZoom).toHaveText('125%');
  await page.keyboard.press('+');
  await expect(resetZoom).toHaveText('150%');
  await page.keyboard.press('-');
  await expect(resetZoom).toHaveText('125%');
  await page.keyboard.press('0');
  await expect(resetZoom).toHaveText('100%');

  await zoomIn.click();
  await zoomIn.click();
  await zoomIn.click();
  await zoomIn.click();
  await expect(resetZoom).toHaveText('200%');

  const dragBox = await image.boundingBox();
  const startX = dragBox.x + dragBox.width / 2;
  const startY = dragBox.y + dragBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 40, startY + 30, { steps: 5 });
  await page.mouse.up();

  const transform = await image.evaluate(el => el.style.transform);
  expect(transform).toContain('scale(2)');
  expect(transform).not.toBe('translate(0px, 0px) scale(2)');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(first).toBeFocused();

  await second.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(image).toHaveAttribute('alt', 'Submitted evidence photo 2');
  await expect(resetZoom).toHaveText('100%');
  await expect(zoomOut).toBeDisabled();
  await expect.poll(() => image.evaluate(el => el.style.transform)).toBe('translate(0px, 0px) scale(1)');

  await page.getByRole('button', { name: 'Close enlarged photo' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(second).toBeFocused();
});

test('My Reports paginates actual submissions with search, status, sorting, borderless statuses, and responsive rows', async ({ page, request, baseURL }, info) => {
  const reports = [];
  for (let index = 1; index <= 13; index++) {
    reports.push(await createReport(page, request, baseURL, { mode: ['pothole', 'road_crack', 'clogged_drainage', 'broken_streetlight'][index % 4], text: `List fixture ${String(index).padStart(2, '0')}`, location: 'Citadines Bacolod City, Lacson Street, Mandalagan, Bacolod, Negros Island Region, 6100, Philippines' }));
  }
  const owner = sessions.get(page);
  const admin = (await createOfficial(baseURL, (await adminSession(baseURL)).token, reports[0].barangay, 'details_status')).token;
  for (const [index, status] of ['ongoing', 'resolved', 'rejected'].entries()) {
    const response = await request.patch(`/api/reports/${reports[index].id}/status`, { headers: { Authorization: `Bearer ${admin}` }, ...statusPayload(status) });
    expect(response.status()).toBe(200);
  }
  await page.goto('/citizen.html#my-reports');
  const rows = page.locator('#myReports .mr-row');
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 1-6 of 13 reports');
  await expect(rows).toHaveCount(6);
  await expect(page.locator('.citizen-header-title')).toHaveText('My Reports');
  await expect(page.locator('.citizen-header-desc')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'My Submitted Reports' })).toHaveCount(0);
  await page.getByLabel('Reports per page', { exact: true }).selectOption('3');
  await expect(rows).toHaveCount(3);
  await page.getByLabel('Reports per page', { exact: true }).selectOption('6');
  await expect(rows).toHaveCount(6);
  await expect(page.locator('#myReports .mr-photo')).toHaveCount(12);
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 7-12 of 13 reports');
  await expect(page.locator('#myReportsPagination .portal-page-number')).toHaveText('Page 2 of 3');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 13-13 of 13 reports');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('LIST FIXTURE 01');
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 1-1 of 1 reports');
  await expect(rows).toContainText('List fixture 01');
  await expect(page.locator('#myReportsPagination .portal-page-number')).toHaveText('Page 1 of 1');
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('');
  for (const [value, label] of [['pending', 'Pending'], ['ongoing', 'Ongoing'], ['resolved', 'Resolved'], ['rejected', 'Rejected']]) {
    await page.getByLabel('Report status', { exact: true }).selectOption(value);
    const statuses = page.locator('#myReports .mr-status');
    await expect(statuses.first()).toHaveText(label);
    expect(await statuses.evaluateAll(nodes => nodes.every(node => {
      const style = getComputedStyle(node);
      return ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].every(side => style[side] === '0px')
        && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.padding === '0px';
    }))).toBe(true);
    await rows.first().hover();
    expect(await statuses.first().evaluate(node => getComputedStyle(node).borderTopWidth)).toBe('0px');
  }
  await page.getByLabel('Report status', { exact: true }).selectOption('');
  await page.getByLabel('Sort reports', { exact: true }).selectOption('newest');
  await expect(rows.first().locator('a.report-entry-link')).toHaveAttribute('href', `report-details.html?id=${reports[12].id}`);
  await page.getByLabel('Sort reports', { exact: true }).selectOption('oldest');
  await expect(rows.first().locator('a.report-entry-link')).toHaveAttribute('href', `report-details.html?id=${reports[0].id}`);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('does not exist');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('.mr-empty')).toContainText('No reports match');
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 0 reports');
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('');
  const originalSize = page.viewportSize();
  for (const width of [2560, 1875, 1440, 1280, 1024, 768, 393, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const selector of ['.mr-toolbar', '.mr-row', '.mr-footer']) {
      expect(await page.locator(selector).evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true);
    }
    const header = width > 900
      ? await page.locator('.citizen-header').boundingBox()
      : await page.locator('main').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { x: bounds.x + parseFloat(style.paddingLeft), width: bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
    for (const selector of ['#myReportsSection', '.mr-toolbar', '.mr-row', '.mr-footer']) {
      const bounds = await page.locator(selector).first().boundingBox();
      expect(Math.abs(bounds.x - header.x)).toBeLessThan(1);
      expect(Math.abs(bounds.width - header.width)).toBeLessThan(1);
    }
    if (width <= 640) {
      const row = rows.first();
      const body = await row.locator('.mr-body').boundingBox();
      const photos = await row.locator('.mr-photos').boundingBox();
      const meta = await row.locator('.mr-meta').boundingBox();
      const location = row.locator('.mr-location');
      await expect(location).toHaveText(reports[0].barangay);
      await expect(row.locator('.mr-assessment')).toHaveCount(0);
      expect(Math.abs(photos.y - body.y)).toBeLessThan(2);
      expect(photos.x + photos.width).toBeLessThan(body.x);
      expect(Math.abs(meta.x - body.x)).toBeLessThan(2);
    }
    if (width === 1875 && info.project.name === 'desktop') {
      await page.locator('.citizen-header-title').click();
      await fs.mkdir(`${artifactRoot}/my-reports-screenshots`, { recursive: true });
      await page.screenshot({ path: `${artifactRoot}/my-reports-screenshots/desktop-wide.png`, fullPage: true });
    }
  }
  await page.setViewportSize(originalSize);
  await page.locator('.citizen-header-title').click();
  await fs.mkdir(`${artifactRoot}/my-reports-screenshots`, { recursive: true });
  await page.screenshot({ path: `${artifactRoot}/my-reports-screenshots/${info.project.name}.png`, fullPage: true });
  await rows.first().locator('a.report-entry-link').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`report-details.html\\?id=${reports[0].id}$`));
  await expect(page.locator('#reportDetails')).toBeVisible();
  await expect(page.locator('.rd-location-address')).toContainText('6100, Philippines');
});

test('My Reports clamps a removed page and clears private rows and search state on session loss', async ({ page, request, baseURL }) => {
  for (let index = 0; index < 7; index++) await createReport(page, request, baseURL, { text: 'Private pagination report' });
  await page.goto('/citizen.html#my-reports');
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 1-6 of 7 reports');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.evaluate(() => saveReports(getAllReports().slice(0, 1)));
  await expect(page.locator('#myReportsCount')).toHaveText('Showing 1-1 of 1 reports');
  await expect(page.locator('#myReportsPagination .portal-page-number')).toHaveText('Page 1 of 1');
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('private');
  await page.evaluate(() => { sessionStorage.removeItem('up_session'); clearReportCache(); });
  await expect(page.locator('#myReports')).not.toContainText('Private pagination report');
  await expect(page.locator('#myReports .mr-row')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search reports' })).toHaveValue('');
});

test('My Reports safely renders literal descriptions and locations and labels unavailable legacy evidence', async ({ page, request, baseURL }) => {
  const text = '<img src=invalid onerror="window.listInjected=true">';
  const location = '<svg onload="window.listInjected=true">';
  const report = await createReport(page, request, baseURL, { proofs: false, text, location });
  await page.route('**/api/reports', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.reports = body.reports.map(item => item.id === report.id ? { ...item, barangay: '', images: item.images.slice(0, 1) } : item);
    await route.fulfill({ response, json: body });
  });
  await page.goto('/citizen.html#my-reports');
  await expect(page.locator('#myReports .mr-row')).toHaveCount(1);
  await expect(page.locator('.mr-description')).toHaveText(text);
  await expect(page.locator('.mr-location')).toContainText(location);
  await expect(page.locator('.mr-body img, .mr-body svg')).toHaveCount(0);
  await expect(page.locator('.mr-ai')).toHaveCount(0);
  await expect(page.locator('.mr-photo')).toHaveCount(2);
  await expect(page.locator('.mr-photo img')).toHaveCount(1);
  await expect(page.locator('.mr-photo-empty')).toHaveText('Photo 2 unavailable');
  expect(await page.evaluate(() => window.listInjected)).not.toBe(true);
});

for (const role of ['citizen', 'admin', 'barangay']) {
  test(`${role} portal reuses the branded sidebar, shared width, and existing menu actions`, async ({ page, baseURL }, info) => {
    let owner = sessions.get(page);
    if (role !== 'citizen') {
      const admin = await adminSession(baseURL);
      const login = role === 'admin' ? admin : await createOfficial(baseURL, admin.token, 'Barangay 1', 'sidebar');
      owner = { ...login.user, apiToken: login.token };
      await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), owner);
    }
    await page.goto(`/${role}.html`);
    const sidebar = page.locator('[data-portal-sidebar]');
    await expect(sidebar.locator('.portal-brand')).toHaveAttribute('aria-label', 'NeighborLens AI home');
    await expect(sidebar.locator('.portal-brand-icon')).toHaveCount(0);
    await expect(sidebar.locator('.portal-brand')).toHaveAttribute('href', `${role}.html`);
    await expect(sidebar.locator('#currentUser')).toHaveText(owner.username);
    expect(await sidebar.evaluate(element => window.PortalSidebar.mount(element) === window.PortalSidebar.get(element))).toBe(true);
    await expect(sidebar.locator('.portal-brand')).toHaveCount(1);
    await expect(sidebar.locator('.sidebar-footer')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await fs.mkdir(`${artifactRoot}/shared-sidebar-screenshots`, { recursive: true });
    await page.screenshot({ path: `${artifactRoot}/shared-sidebar-screenshots/${role}-${info.project.name}.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect((await sidebar.boundingBox()).width).toBe(240);
    await page.evaluate(() => document.documentElement.style.setProperty('--portal-sidebar-width', '272px'));
    expect((await sidebar.boundingBox()).width).toBe(272);
    const main = await page.locator('main').boundingBox();
    expect(main.x).toBeGreaterThanOrEqual(272);
    if (role === 'citizen') {
      await sidebar.getByRole('link', { name: 'My Reports', exact: true }).click();
      await expect(page.locator('#myReportsSection')).toBeVisible();
      await sidebar.getByRole('link', { name: 'Submit Report', exact: true }).click();
      await expect(page.locator('#submitSection')).toBeVisible();
    } else if (role === 'admin') {
      await sidebar.locator('li').filter({ hasText: 'All Reports' }).click();
      await expect(page.locator('#reportsSection')).toBeVisible();
      await sidebar.locator('li').filter({ hasText: 'Manage Accounts' }).click();
      await expect(page.locator('#accountsSection')).toBeVisible();
    } else {
      await page.locator('[data-status-filter="pending"]').click();
      await expect(page.locator('[data-status-filter="pending"]')).toHaveAttribute('aria-pressed', 'true');
      await sidebar.getByRole('link', { name: 'Local Reports', exact: true }).click();
      await expect(page.locator('[data-status-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
    }
  });
}

test('shared sidebar remounts once and treats account fields as text', async ({ page }) => {
  await page.goto('/citizen.html');
  const markup = '<img src=x onerror="window.sidebarInjected=true">';
  await page.locator('[data-portal-sidebar]').evaluate((element, username) => {
    window.PortalSidebar.get(element).destroy();
    const instance = window.PortalSidebar.mount(element);
    instance.update({ username, role: 'citizen' });
  }, markup);
  await expect(page.locator('.portal-brand')).toHaveCount(1);
  await expect(page.locator('.sidebar-footer')).toHaveCount(1);
  await expect(page.locator('#currentUser')).toHaveText(markup);
  await expect(page.locator('#currentUser img')).toHaveCount(0);
  expect(await page.evaluate(() => window.sidebarInjected)).not.toBe(true);
  await expect(page.locator('.portal-mobile-header')).toHaveCount(1);
  await expect(page.locator('.portal-mobile-nav')).toHaveCount(1);
  const nav = page.locator(await page.locator('.portal-mobile-header').isVisible() ? '.portal-mobile-nav' : '.portal-sidebar');
  await nav.getByRole('link', { name: 'My Reports', exact: true }).click();
  await expect(page.locator('#myReportsSection')).toBeVisible();
});

test('citizen navigation preserves desktop and mobile layouts without fetching the unopened Community Feed', async ({ page, context }, info) => {
  await fixedBrowserLocation(page, context, { latitude: 10.678, longitude: 122.946, accuracy: 15 }, { simulatedWatch: true });
  const requests = [];
  const address = 'Purok 5, 128 Circumferential Road, Barangay 1, Bacolod City, Negros Occidental, 6100, Philippines';
  await page.route('**/api/config/reverse-geocode?**', route => route.fulfill({
    json: { ok: true, data: { display_name: address, address: { city: 'Bacolod City', village: 'Barangay 1' } } }
  }));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/community/')) requests.push(request.url()); });
  await page.goto('/citizen.html');
  await expect(page.locator('#submitSection')).toBeVisible();
  const liveAddress = page.locator('#gpsStatus .geo-address');
  await expect(liveAddress).toHaveText(address);
  await expectLiveMapTiles(page);
  await page.locator('#description').fill('Keep this citizen description while switching sections.');
  await page.locator('#description').blur();
  const sidebar = page.locator('[data-portal-sidebar]');
  await expect(sidebar.getByRole('link', { name: 'Community Feed', exact: true, includeHidden: true })).toHaveAttribute('href', 'citizen.html#community');
  await expect(sidebar.getByRole('link', { name: 'Community Feed', exact: true, includeHidden: true })).toHaveAttribute('data-section', 'communitySection');
  for (const width of [320, 390, 768, 900, 901, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    const mobile = width <= 900;
    await expect(page.locator('.portal-mobile-header')).toBeVisible({ visible: mobile });
    await expect(page.locator('.portal-mobile-nav')).toBeVisible({ visible: mobile });
    await expect(sidebar).toBeVisible({ visible: !mobile });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const location = await page.locator('#stepLocationCard').boundingBox();
    const photos = await page.locator('#stepPhotosCard').boundingBox();
    const details = await page.locator('#stepDetailsCard').boundingBox();
    expect(details.y).toBeGreaterThanOrEqual(photos.y + photos.height);
    if (mobile) expect(photos.y).toBeGreaterThanOrEqual(location.y + location.height);
    else expect(location.x).toBeGreaterThanOrEqual(photos.x + photos.width);
    if (mobile) {
      const header = await page.locator('.portal-mobile-header').boundingBox();
      const form = await page.locator('.citizen-report-form').boundingBox();
      expect(header.height).toBeLessThanOrEqual(64);
      expect(form.y).toBeGreaterThanOrEqual(header.y + header.height);
      await page.locator('#submitBtn').scrollIntoViewIfNeeded();
      const submit = await page.locator('#submitBtn').boundingBox();
      const bottom = await page.locator('.portal-mobile-nav').boundingBox();
      expect(submit.y + submit.height).toBeLessThanOrEqual(bottom.y);
      await page.evaluate(() => scrollTo(0, 0));
    }
  }
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1440, height: 1000 });
  const nav = page.locator(info.project.name === 'mobile' ? '.portal-mobile-nav' : '.portal-sidebar-navigation');
  await expect(nav.locator('[aria-current]')).toHaveText(info.project.name === 'mobile' ? 'Submit report' : 'Submit Report');
  await nav.getByRole('link', { name: 'My Reports', exact: true }).click();
  await expect(page).toHaveURL(/citizen\.html#my-reports$/);
  await expect(nav.locator('[aria-current]')).toHaveText('My Reports');
  await nav.getByRole('link', { name: info.project.name === 'mobile' ? 'Submit report' : 'Submit Report', exact: true }).click();
  await expect(page.locator('#description')).toHaveValue('Keep this citizen description while switching sections.');
  await expectLiveMapTiles(page);
  await expect(page).toHaveURL(/citizen\.html$/);
  await nav.getByRole('link', { name: 'My Reports', exact: true }).click();
  await page.reload();
  await expect(page.locator('#myReportsSection')).toBeVisible();
  await expect(nav.locator('[aria-current]')).toHaveText('My Reports');
  expect(requests).toEqual([]);
  await fs.mkdir(`${artifactRoot}/citizen-navigation-screenshots`, { recursive: true });
  await page.screenshot({ path: `${artifactRoot}/citizen-navigation-screenshots/${info.project.name}-reports.png`, fullPage: true });
  await nav.getByRole('link', { name: info.project.name === 'mobile' ? 'Submit report' : 'Submit Report', exact: true }).click();
  await expectLiveMapTiles(page);
  await page.screenshot({ path: `${artifactRoot}/citizen-navigation-screenshots/${info.project.name}-submit.png`, fullPage: true });
  await page.locator('#description').fill('Keep this citizen description while switching sections.');
  const trigger = page.getByRole('button', { name: 'Open location map' });
  await expect(page.locator('.citizen-header')).toHaveCSS('border-bottom-width', '0px');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Report location' });
  await expect(dialog).toBeVisible();
  const viewport = page.viewportSize();
  expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  const map = dialog.locator('#geoCanvas');
  await expect(map.locator('.bacolod-city-outline')).toBeAttached();
  await expect(map.locator('.bacolod-barangay-outline')).toHaveCount(1);
  await expect(dialog.getByRole('status')).toHaveText('Brgy. 1');
  await expect(dialog.getByText('Map unavailable.')).toBeHidden();
  const mapSize = await map.boundingBox();
  expect(mapSize.width).toBe(viewport.width);
  expect(mapSize.height).toBeGreaterThan(viewport.height * 0.8);
  const title = await dialog.getByRole('heading').boundingBox();
  const close = await dialog.getByRole('button', { name: 'Close location map' }).boundingBox();
  expect(close.x).toBeGreaterThan(title.x + title.width);
  expect(title.y).toBeLessThan(close.y + close.height);
  await expectLiveMapTiles(page);
  await page.screenshot({ path: `${artifactRoot}/citizen-navigation-screenshots/${info.project.name}-map.png` });
  await dialog.getByRole('button', { name: 'Show report location' }).click();
  await expect(dialog.getByRole('button', { name: 'Show barangay boundary' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator('#citizenInlineMap #geoCanvas')).toHaveCount(1);
  await expect(page.locator('#description')).toHaveValue('Keep this citizen description while switching sections.');

  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 390, height: 650 });
    await moveBrowserLocation(page, context, { latitude: 10.678, longitude: 122.946, accuracy: 50000 });
    await expect(page.locator('#gpsStatus')).toContainText('last accurate location');
    await expect(liveAddress).toBeVisible();
    await expect(liveAddress).toHaveText(address);
    const addressBox = await liveAddress.boundingBox();
    const mapButton = await trigger.boundingBox();
    expect(addressBox.x + addressBox.width).toBeLessThan(mapButton.x);
    expect(mapButton.y).toBeLessThan(addressBox.y + addressBox.height);
    const location = await page.locator('#stepLocationCard').boundingBox();
    expect(location.height).toBeLessThan(150);
    const camera = await page.getByRole('button', { name: 'Use camera', exact: true }).boundingBox();
    const bottom = await page.locator('.portal-mobile-nav').boundingBox();
    expect(camera.y + camera.height).toBeLessThan(bottom.y);
  }
});

test('citizen mobile feed appends posts on scroll and retries without replacing the current cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  const post = id => ({
    id, title: `Community report ${id}`, body: 'Surface damage reported.',
    barangay: 'Villamonte', reactions: { total: 0 }, engagementVersion: 0,
    media: id === 1 ? [{ url: '/api/community/posts/1/media/1' }] : []
  });
  let releasePhoto;
  const photoGate = new Promise(resolve => { releasePhoto = resolve; });
  await page.route('**/api/community/posts/1/media/1', async route => {
    await photoGate;
    await route.fulfill({ body: tile, contentType: 'image/png' });
  });
  await page.route('**/api/community/posts?*', async route => {
    const query = new URL(route.request().url()).searchParams;
    const batch = Number(query.get('page'));
    requests.push(batch);
    if (batch === 2 && requests.filter(page => page === 2).length === 1) {
      return route.fulfill({ status: 503, json: { error: 'Temporary outage' } });
    }
    const searching = query.has('search');
    const ids = searching ? [14] : batch === 1 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [10, 11, 12];
    return route.fulfill({ json: { posts: ids.map(post), pagination: { page: batch, pages: searching ? 1 : 2, total: searching ? 1 : 12 } } });
  });
  await page.goto('/citizen.html#community');
  const cards = page.locator('.cf-posts .cf-post');
  await expect(cards).toHaveCount(10);
  await expect(page.getByRole('navigation', { name: 'Community pages' })).toBeHidden();
  const media = cards.first().locator('.cf-single-photo');
  await expect(media).toHaveClass(/nl-image-loading/);
  releasePhoto();
  await expect(media).toHaveClass(/nl-image-loaded/);
  await cards.first().evaluate(node => { window.firstFeedCard = node; });
  await page.locator('.cf-scroll-end').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Retry loading posts' })).toBeVisible();
  await expect(cards).toHaveCount(10);
  await page.getByRole('button', { name: 'Retry loading posts' }).click();
  await expect(cards).toHaveCount(12);
  await expect(page.getByText('You’re all caught up.')).toBeVisible();
  expect(await cards.first().evaluate(node => node === window.firstFeedCard)).toBe(true);
  expect(requests).toEqual([1, 2, 2]);
  await page.getByRole('searchbox', { name: 'Search community reports' }).first().fill('surface');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Community report 14');
  expect(requests).toEqual([1, 2, 2, 1]);
});

test('community feed uses tap and hold reactions and edge-to-edge mobile photos', async ({ page, context }, info) => {
  const mobile = info.project.name === 'mobile';
  await page.setViewportSize({ width: mobile ? 390 : 1440, height: 844 });
  const changes = [];
  const post = (id, count) => ({
    id, title: `Evidence report ${id}`, barangay: 'Villamonte',
    reactions: { total: 0, like: 0, heart: 0, mine: null }, engagementVersion: 0,
    media: Array.from({ length: count }, (_, index) => ({ url: `/api/community/posts/${id}/media/${index + 1}` }))
  });
  await page.route('**/api/community/posts?*', route => route.fulfill({
    json: { posts: [post(1, 2), post(2, 1)], barangay: 'Singcang-Airport', pagination: { page: 1, pages: 1, total: 2 } }
  }));
  await page.route('**/api/community/posts/*/media/*', route => route.fulfill({ body: photos[0], contentType: 'image/png' }));
  await page.route('**/api/community/posts/1/reaction', route => {
    const { reaction } = route.request().postDataJSON();
    changes.push(reaction);
    return route.fulfill({
      json: {
        reactions: { total: Number(Boolean(reaction)), like: Number(reaction === 'like'), heart: Number(reaction === 'heart'), mine: reaction },
        engagementVersion: changes.length
      }
    });
  });
  const commentChanges = [];
  const comment = (id, parentId) => ({
    id, parentId, body: parentId ? 'Nested reaction fixture' : 'Original reaction fixture',
    author: { pseudonym: 'QuietOtter' }, visibleReplyCount: parentId ? 0 : 1, reactions: { total: 0, mine: false, type: null }
  });
  await page.route('**/api/community/posts/1/comments?*', route => route.fulfill({
    json: { supportsHeart: true, comments: [comment(21, null), comment(22, 21)], pagination: { page: 1, pages: 1, total: 2 } }
  }));
  await page.route('**/api/community/posts/1/comments/*/reaction', route => {
    const { reaction, reacted } = route.request().postDataJSON();
    const type = reaction ?? (reacted ? 'like' : null);
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    commentChanges.push([id, type]);
    return route.fulfill({ json: { reacted: Boolean(type), reaction: type, total: Number(Boolean(type)) } });
  });
  await page.goto('/citizen.html#community');
  if (mobile) {
    const illustration = page.locator('.cf-mobile-illustration');
    const heading = page.locator('.cf-hero-text');
    await expect(page.locator('[data-community-barangay]')).toHaveText('Singcang-Airport');
    await expect.poll(() => illustration.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const art = await illustration.boundingBox();
      const text = await heading.boundingBox();
      expect(art.x).toBeGreaterThanOrEqual(text.x + text.width);
      expect(art.x + art.width).toBeLessThanOrEqual(width);
      expect(art.width).toBeGreaterThan(width === 390 ? 160 : 120);
    }
  }
  const card = page.locator('[data-post-id="1"]');
  const reaction = card.locator('[data-reaction-target="post"]');
  const picker = card.locator('[data-reaction-target="post"] + .cf-reaction-picker');

  for (const [id, selector] of [[1, '.cf-carousel'], [2, '.cf-single-photo']]) {
    const postCard = page.locator(`[data-post-id="${id}"]`);
    const frame = postCard.locator(selector);
    await expect(frame).toBeVisible();
    const bounds = await frame.boundingBox();
    const parent = await postCard.boundingBox();
    if (mobile) {
      expect(bounds.width).toBeGreaterThanOrEqual(parent.width - 2);
      expect(bounds.width).toBeGreaterThan(340);
      expect(Math.abs(bounds.width - bounds.height)).toBeLessThan(2);
    } else {
      expect(bounds.width).toBeLessThan(parent.width);
    }
  }
  const touch = mobile ? await context.newCDPSession(page) : null;
  const touchEvent = (type, touchPoints = []) => touch.send('Input.dispatchTouchEvent', { type, touchPoints });
  const position = async (button = reaction) => {
    await button.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    if (mobile) await button.tap({ trial: true });
    else await button.click({ trial: true });
    const box = await button.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const quickReact = async () => {
    await position();
    return mobile ? reaction.tap() : reaction.click();
  };
  await quickReact();
  await expect.poll(() => changes.slice()).toEqual(['like']);
  await expect(reaction).toHaveAttribute('aria-pressed', 'true');
  await expect(picker).toBeHidden();

  const point = await position();
  if (mobile) await touchEvent('touchStart', [point]);
  else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  await expect(picker).toBeVisible();
  const like = picker.getByRole('menuitemradio', { name: 'Like' });
  const heart = picker.getByRole('menuitemradio', { name: 'Heart' });
  expect((await like.boundingBox()).y).toBe((await heart.boundingBox()).y);
  expect((await picker.boundingBox()).y).toBeLessThan(point.y);
  if (mobile) await touchEvent('touchEnd');
  else await page.mouse.up();
  await expect(picker).toBeVisible();
  expect(changes).toEqual(['like']);
  if (mobile) await heart.tap();
  else {
    await page.keyboard.press('ArrowRight');
    await expect(heart).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect.poll(() => changes.slice()).toEqual(['like', 'heart']);
  await expect(reaction).toHaveAccessibleName('Heart reaction');
  await quickReact();
  await expect.poll(() => changes.slice()).toEqual(['like', 'heart', null]);
  await expect(reaction).toHaveAttribute('aria-pressed', 'false');
  await expect(picker).toBeHidden();

  await card.locator('.cf-comments-toggle').click();
  for (const id of [21, 22]) {
    const comment = card.locator(`[data-comment-id="${id}"]`);
    const trigger = comment.locator('[data-reaction-target="comment"]');
    const commentPicker = comment.locator('.cf-reaction-picker');
    const point = await position(trigger);
    if (mobile) await touchEvent('touchStart', [point]);
    else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
    await expect(commentPicker).toBeVisible();
    if (mobile) await touchEvent('touchEnd');
    else await page.mouse.up();
    await expect(commentPicker).toBeVisible();
    expect(commentChanges.some(([target]) => target === id)).toBe(false);
    await commentPicker.getByRole('menuitemradio', { name: 'Heart' }).click();
    await expect(trigger).toHaveAccessibleName('Heart comment');
    await expect(trigger).toBeEnabled();
    await expect(trigger.locator('.cf-reaction-total')).toHaveText('1');
    await position(trigger);
    if (mobile) await trigger.tap();
    else await trigger.click();
    await expect(trigger).toHaveAttribute('aria-pressed', 'false');
  }
  expect(commentChanges).toEqual([[21, 'heart'], [21, null], [22, 'heart'], [22, null]]);
  expect(changes).toEqual(['like', 'heart', null]);

  const secondPhoto = card.getByRole('button', { name: 'Go to photo 2' });
  if (mobile) {
    const track = card.getByRole('region', { name: 'Attached images' });
    await track.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const { x, y, width, height } = await track.boundingBox();
    const point = { x: x + width * 0.85, y: y + height / 2 };
    await touchEvent('touchStart', [point]);
    for (const ratio of [0.25, 0.5, 0.7]) {
      await touchEvent('touchMove', [{ ...point, x: point.x - width * ratio }]);
    }
    await touchEvent('touchEnd');
  } else await secondPhoto.click();
  await expect(secondPhoto).toHaveAttribute('aria-pressed', 'true');

  // Leave the vertical swipe last so native scroll momentum cannot consume a later hold.
  const swipeStart = await position();
  if (mobile) {
    await touchEvent('touchStart', [swipeStart]);
    await touchEvent('touchMove', [{ ...swipeStart, y: swipeStart.y - 36 }]);
    await touchEvent('touchEnd');
  } else {
    await page.mouse.move(swipeStart.x, swipeStart.y);
    await page.mouse.down();
    await page.mouse.move(swipeStart.x + 24, swipeStart.y);
    await page.mouse.up();
  }
  await expect(picker).toBeHidden();
  await expect(reaction).toHaveAttribute('aria-pressed', 'false');
  expect(changes).toEqual(['like', 'heart', null]);
});

test('citizen avatar opens a compact appearance and logout dropdown without a redundant mobile sidebar', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/citizen.html');
  const account = page.getByRole('button', { name: 'Citizen account', exact: true });
  const sidebar = page.locator('[data-portal-sidebar]');
  const menu = page.locator('#citizenAccountMenu');
  const logout = page.locator('#portalLogout');
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveCount(0);
  await expect(page.locator('.portal-sidebar-backdrop')).toHaveCount(0);
  await expect(sidebar).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out', exact: true, includeHidden: true })).toHaveCount(1);
  await expect(account).toHaveAttribute('title', 'Citizen');
  await expect(account).toHaveAttribute('aria-controls', 'citizenAccountMenu');
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await account.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('switch', { name: 'Dark mode', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Log out', exact: true })).toHaveCount(1);
  await expect(menu.locator('button')).toHaveCount(1);
  await expect(logout).toBeFocused();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).not.toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main')).not.toHaveAttribute('inert');
  await expect(page.locator('.portal-mobile-nav')).not.toHaveAttribute('inert');
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await fs.mkdir(`${artifactRoot}/citizen-navigation-screenshots`, { recursive: true });
  await page.screenshot({ path: `${artifactRoot}/citizen-navigation-screenshots/${info.project.name}-account.png` });
  await page.keyboard.press('Escape');
  await expect(account).toBeFocused();
  await expect(menu).not.toBeVisible();
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowDown');
  await expect(logout).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).not.toBeVisible();
  await account.click();
  await account.click();
  await expect(menu).not.toBeVisible();
  await account.click();
  await page.getByRole('heading', { name: 'Photos of the issue', exact: true }).click({ position: { x: 2, y: 2 } });
  await expect(menu).not.toBeVisible();
  await account.click();
  await page.locator('.portal-mobile-nav').getByRole('link', { name: 'My Reports', exact: true }).click();
  await expect(menu).not.toBeVisible();
  await expect(sidebar).not.toBeVisible();
  await expect(page.locator('.portal-mobile-nav [aria-current]')).toHaveText('My Reports');
  await account.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('#portalLogout')).toHaveCount(1);
  await expect(menu.locator('#portalLogout')).toHaveCount(0);
  await expect(sidebar).not.toHaveAttribute('aria-modal');
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(sidebar).not.toBeVisible();
  await expect(menu).not.toBeVisible();
  await account.click();
  const bounds = await menu.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await expect(page.locator('#portalLogout')).toHaveCount(1);
  await logout.click();
  await expect(page).toHaveURL(/login\.html$/);
  expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
});

test('citizen Report Details puts Log out in the avatar menu after opening a report from My Reports', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL, { proofs: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/citizen.html#my-reports');
  await page.getByRole('link', { name: `View details for report ${report.id}` }).click();
  await expect(page.locator('#reportDetails')).toBeVisible();

  const account = page.getByRole('button', { name: 'Citizen account', exact: true });
  const menu = page.locator('#citizenAccountMenu');
  const logout = page.getByRole('button', { name: 'Log out', exact: true, includeHidden: true });
  await account.click();
  await expect(menu.getByRole('switch', { name: 'Dark mode', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Log out', exact: true })).toBeFocused();
  await expect(logout).toHaveCount(1);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#detailsSidebar').getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.reload();
  await expect(page.locator('#reportDetails')).toBeVisible();
  await account.click();
  await menu.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/login\.html$/);
  expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
});

test('mobile branding and report filters remain visible while scrolling without redundant portal badges', async ({ page, request, baseURL }, info) => {
  for (let index = 0; index < 7; index++) await createReport(page, request, baseURL, { text: `Sticky navigation report ${index}` });
  await page.goto('/citizen.html#my-reports');
  await expect(page.locator('#myReports .mr-row')).toHaveCount(6);
  for (const width of [320, 393, 768, 900]) {
    await page.setViewportSize({ width, height: 640 });
    await page.evaluate(() => scrollTo(0, 0));
    const brand = page.locator('.portal-mobile-brand');
    await expect(brand).toHaveAccessibleName('NeighborLens AI home');
    await expect(brand.locator('.portal-brand-icon')).toHaveCount(0);
    await expect(page.locator('.citizen-header')).toBeVisible();
    await page.evaluate(() => scrollTo(0, 360));
    await expect.poll(() => page.locator('.portal-mobile-header').evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0);
    const header = await page.locator('.portal-mobile-header').boundingBox();
    await expect.poll(() => page.locator('.mr-toolbar').evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(Math.round(header.height));
    const toolbar = await page.locator('.mr-toolbar').boundingBox();
    const bottom = await page.locator('.portal-mobile-nav').boundingBox();
    expect(toolbar.y + toolbar.height).toBeLessThan(bottom.y);
    expect(Math.round(bottom.y + bottom.height)).toBe(640);
    for (const selector of ['#myReportsSearch', '#myReportsStatus', '#myReportsSort']) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds.y).toBeGreaterThanOrEqual(header.height);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
    }
    await page.getByRole('button', { name: 'Citizen account', exact: true }).click();
    await expect(page.locator('#citizenAccountMenu')).toBeVisible();
    await expect(page.locator('#portalLogout')).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('Sticky navigation report 3');
  await expect(page.locator('#myReports .mr-row')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill('');
  await expect(page.locator('#myReports .mr-row')).toHaveCount(6);
  await page.setViewportSize({ width: 393, height: 844 });
  await page.evaluate(() => scrollTo(0, 320));
  await fs.mkdir(`${artifactRoot}/citizen-navigation-screenshots`, { recursive: true });
  await page.screenshot({ path: `${artifactRoot}/citizen-navigation-screenshots/${info.project.name}-sticky-reports.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('.citizen-header')).toBeVisible();
  await expect(page.locator('.portal-sidebar .portal-brand-icon')).toHaveCount(0);
});

test('citizen submits camera captures without an address input and sees the saved address in Report Details', async ({ page, request, context }) => {
  await fixedBrowserLocation(page, context, { latitude: 10.678, longitude: 122.946, accuracy: 15 });
  await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
  await page.addInitScript(sources => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => {
          const frames = await Promise.all(sources.map(async source => {
            const image = new Image();
            image.src = `data:image/png;base64,${source}`;
            await image.decode();
            return image;
          }));
          const canvas = document.createElement('canvas');
          canvas.width = frames[0].width;
          canvas.height = frames[0].height;
          const context = canvas.getContext('2d');
          let angle = 0;
          const stream = canvas.captureStream(24);
          const paint = () => {
            context.drawImage(frames[angle], 0, 0);
            if (stream.active) requestAnimationFrame(paint);
          };
          paint();
          window.switchCameraFixtureAngle = () => new Promise(resolve => {
            angle = 1;
            const video = document.querySelector('#reportCameraDialog video');
            video.requestVideoFrameCallback(() => video.requestVideoFrameCallback(resolve));
          });
          return stream;
        }
      }
    });
  }, photos.map(buffer => buffer.toString('base64')));
  await page.goto('/citizen.html');
  await expect(page.locator('#location')).toHaveCount(0);
  await expect(page.getByText('Registered / Report Location', { exact: false })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getDetectedGPS()?.address)).toBe('Bacolod City');
  await page.locator('#description').fill('The road is damaged; keep my explanation and recorded location.');
  await page.getByRole('button', { name: 'Use camera', exact: true }).filter({ visible: true }).click();
  const camera = page.getByRole('dialog', { name: 'Capture issue photos' });
  await camera.getByRole('button', { name: 'Capture photo 1' }).click();
  await expect(camera.getByRole('button', { name: 'Capture photo 2' })).toBeEnabled();
  await page.evaluate(() => window.switchCameraFixtureAngle());
  await camera.getByRole('button', { name: 'Capture photo 2' }).click();
  await expect(camera).toBeHidden();
  await expect(page.locator('#citizenCategory')).toBeEnabled();
  await page.locator('#citizenCategory').selectOption('Road Damage');
  await expect(page.locator('#visionDetectBox [data-assessment-state]')).toBeVisible();
  await expect(page.locator('#submitBtn')).toBeEnabled();
  const response = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const submission = await response;
  expect(submission.status()).toBe(201);
  const report = await submission.json();
  expect(report.location).toBe('Bacolod City');
  expect(report.description).toBe('The road is damaged; keep my explanation and recorded location.');
  expect(report.originalAi.canonical_class).toBe('broken_streetlight');
  expect(report.citizenCategory).toBe('Road Damage');
  const nav = page.locator(await page.locator('.portal-mobile-nav').isVisible() ? '.portal-mobile-nav' : '.portal-sidebar');
  await nav.getByRole('link', { name: 'My Reports', exact: true }).click();
  await page.locator(`a.report-entry-link[href="report-details.html?id=${report.id}"]`).click();
  await expect(page.locator('.rd-location-address')).toHaveText('Bacolod City');
  await expect(page.locator('#reportDetails')).toContainText('The road is damaged; keep my explanation and recorded location.');
  await page.reload();
  await expect(page.locator('.rd-location-address')).toHaveText('Bacolod City');
  await expect(page.locator('#reportMap.leaflet-container')).toBeVisible();
  await expect(page.locator('.rd-photo img')).toHaveCount(2);
});

test('sidebar preserves role navigation and the reference layout across screen sizes', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await open(page, report);
  await expect(page.locator('#detailsSidebar .logo')).toHaveCount(1);
  await expect(page.locator('#detailsSidebar .portal-brand')).toHaveAttribute('aria-label', 'NeighborLens AI home');
  await expect(page.locator('#detailsSidebar .portal-brand-icon')).toHaveCount(0);
  await expect(page.locator('#detailsNav a[aria-current="location"]')).toHaveText('My Reports');
  await expect(page.locator('#detailsNav a').first()).toHaveAttribute('href', 'citizen.html');
  await expect(page.locator('#currentUser')).toHaveText(sessions.get(page).username);
  for (const width of [1600, 1280, 1024, 768, 393, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const main = await page.locator('#detailsContent').boundingBox();
    const description = await page.locator('.rd-description-section').boundingBox();
    const location = await page.locator('.rd-location').boundingBox();
    const review = await page.locator('section[aria-labelledby="reviewHeading"]').boundingBox();
    if (width > 1200) {
      const sidebar = await page.locator('#detailsSidebar').boundingBox();
      expect(main.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
      expect(Math.abs(description.y - location.y)).toBeLessThan(1);
      expect(location.x).toBeGreaterThanOrEqual(description.x + description.width);
    } else {
      expect(location.y).toBeGreaterThanOrEqual(description.y + description.height);
    }
    expect(review.y).toBeGreaterThanOrEqual(Math.max(description.y + description.height, location.y + location.height));
    await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible({ visible: false });
    for (const element of await page.locator('.rd-facts, .rd-gps, .rd-metadata, .rd-navigation').all()) {
      expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
  }
});

test('mobile sidebar traps focus, closes accessibly, resizes safely, and navigates', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await page.setViewportSize({ width: 393, height: 852 });
  const admin = await adminSession(baseURL);
  await page.addInitScript(session => {
    if (!location.pathname.endsWith('admin-login.html')) sessionStorage.setItem('up_session', JSON.stringify(session));
  }, { ...admin.user, apiToken: admin.token });
  await open(page, report);
  const toggle = page.locator('#openSidebar');
  const close = page.getByRole('button', { name: 'Close navigation', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Portal sidebar' })).toBeVisible();
  await expect(close).toBeFocused();
  expect(await page.locator('#detailsContent').evaluate(node => node.inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('link', { name: 'NeighborLens AI home' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'NeighborLens AI home' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('#detailsContent').evaluate(node => node.inert)).toBe(false);
  expect(await page.locator('#detailsSidebar').evaluate(node => node.inert)).toBe(true);
  await toggle.click();
  await page.locator('#sidebarBackdrop').click({ position: { x: 350, y: 100 } });
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('#detailsSidebar')).not.toHaveAttribute('aria-modal');
  expect(await page.locator('#detailsContent').evaluate(node => node.inert)).toBe(false);
  await expect(page.locator('#detailsSidebar').getByRole('link', { name: 'All Reports', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 393, height: 852 });
  await toggle.click();
  await page.getByRole('link', { name: 'All Reports', exact: true }).click();
  await expect(page.locator('#reportsSection')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.rd-header h1')).toHaveText(`Report #${report.id}`);
  await expect(page.locator('.rd-review-form, .rd-severity, .rd-summary')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.waitForURL('**/admin-login.html');
  adminFixture = null;
  expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
});

test('map enlargement is interactive, reversible, and does not change recorded GPS', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await open(page, report);
  const inlineBoundary = page.locator('#mapWrap .bacolod-barangay-outline');
  await expect(inlineBoundary).toHaveCount(1);
  await page.getByRole('button', { name: 'Enlarge map', exact: true }).click();
  await expect(page.locator('#mapWrap')).toHaveClass(/is-expanded/);
  const map = page.getByRole('dialog', { name: 'Report location' });
  await expect(map.locator('#reportMap .bacolod-city-outline')).toBeAttached();
  await expect(map.getByRole('status')).toHaveText('Brgy. 1');
  await expect(map.locator('#reportMap .bacolod-barangay-outline')).toHaveCount(1);
  await expect(map.locator('#reportMap .leaflet-marker-icon')).toBeVisible();
  expect(await map.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize() });
  await map.getByRole('button', { name: 'Show report location' }).click();
  await expect(map.getByRole('button', { name: 'Show barangay boundary' })).toBeVisible();
  await map.locator('#reportMap').getByRole('button', { name: 'Zoom in' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mapWrap')).not.toHaveClass(/is-expanded/);
  await expect(inlineBoundary).toHaveCount(1);
  await expect(page.locator('.rd-gps')).toContainText('10.67800');
});

test('saved Report Details shows the same nearby boundaries inline and fullscreen', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL, {
    barangay: 'Mansilingan',
    gps: {
      lat: 10.65613,
      lon: 122.99357,
      accuracy: 51.06
    }
  });

  let areaRequests = 0;

  await page.route('**/api/config/report-area', async route => {
    if (route.request().method() !== 'POST') {
      return route.continue();
    }

    await route.fulfill({
      status: 200,
      json: {
        status: 'AUTHORITATIVE_POLYGONS_PENDING',
        boundaryCheckStatus: null,
        barangayId: null,
        boundary: null
      }
    });
  });

  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/config/report-area') {
      areaRequests++;
    }
  });

  await open(page, report);

  const wrap = page.locator('#mapWrap');
  const label = 'Near Estefania / Vista Alegre boundary \u00b7 Map reference';

  await expect(wrap.locator('.bacolod-nearby-outline')).toHaveCount(2);
  await expect(wrap.getByRole('status')).toHaveText(label);
  await expect(page.locator('.rd-gps')).toContainText('Mansilingan');

  await page.getByRole('button', {
    name: 'Enlarge map',
    exact: true
  }).click();

  const dialog = page.getByRole('dialog', {
    name: 'Report location'
  });

  await expect(dialog.getByRole('status')).toHaveText(label);
  await expect(dialog.locator('.bacolod-nearby-outline')).toHaveCount(2);

  await page.keyboard.press('Escape');

  await expect(wrap.getByRole('status')).toHaveText(label);
  await expect(wrap.locator('.bacolod-nearby-outline')).toHaveCount(2);

  expect(areaRequests).toBe(1);
});

for (const role of ['admin', 'barangay']) {
  test(`${role} uses the same authorized details view without proof material`, async ({ page, request, baseURL }) => {
    const report = await createReport(page, request, baseURL, { barangay: 'Barangay 1' });
    const admin = await adminSession(baseURL);
    const login = role === 'admin' ? admin : await createOfficial(baseURL, admin.token, 'Barangay 1', 'details_browser');
    const session = { ...login.user, apiToken: login.token };
    await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), session);
    await open(page, report);
    if (role === 'barangay') await expect(page.locator('.rd-summary')).toContainText('Citizen correction');
    else { await expect(page.locator('.rd-header h1')).toHaveText(`Report #${report.id}`); await expect(page.locator('.rd-activity')).toBeVisible(); await expect(page.locator('.rd-summary')).toHaveCount(0); }
    await expect(page.locator('#backToReports')).toHaveAttribute('href', role === 'admin' ? 'admin.html#reports' : `${role}.html`);
    await expect(page.locator('#detailsNav a')).toHaveCount(5);
    await expect(page.locator('#detailsNav a').last()).toHaveAttribute('href', `${role}.html#analytics`);
    if (role === 'admin') await expect(page.locator('.rd-review-form, .rd-staff-tools')).toHaveCount(0);
    else await expect(page.locator('.rd-review-form')).toBeVisible();
    await expect(page.locator('#detailsNav a').first()).toHaveAttribute('href', role === 'admin' ? 'admin.html#accounts' : `${role}.html#reports`);
    await expect(page.locator('body')).not.toContainText('proof_id');
    await page.getByRole('button', { name: 'Enlarge map', exact: true }).click();
    const map = page.getByRole('dialog', { name: 'Report location' });
    await expect(map.locator('#reportMap .bacolod-city-outline')).toBeAttached();
    await map.getByRole('button', { name: 'Restore map size' }).click();
    await expect(page.locator('#mapWrap #reportMap')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('up_reports'))).toBeNull();
  });
}

test('legacy overview opens Analytics and the Admin report list paginates and opens shared details', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  const owner = sessions.get(page);
  const admin = await adminSession(baseURL);
  const session = { ...admin.user, apiToken: admin.token };
  await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), session);
  const rows = Array.from({ length: 27 }, (_, index) => ({
    id: index === 0 ? report.id : report.id + 10000 + index,
    description: `Road damage ${index}`, barangay: index < 20 ? 'Villamonte' : 'Barangay 2',
    citizenCategory: 'Road Damage', ai_category: 'Road Damage', ai_priority: 'High', ai_classification: 'MAJOR',
    submitted_by: owner.id, submitted_by_username: owner.username, submitted_by_role: 'citizen',
    status: index % 3 === 0 ? 'resolved' : 'pending', created_at: new Date(Date.UTC(2026, 9, 15, 12, 30 - index)).toISOString()
  }));
  await page.route('**/api/reports', route => route.request().method() === 'GET' ? route.fulfill({ json: { reports: rows } }) : route.continue());
  await page.goto('/admin.html#overview');
  await expect(page.locator('#adminPageTitle')).toHaveText('Analytics');
  await expect(page.locator('#hierarchyGrid')).toHaveCount(0);
  await expect(page.locator('#statTotal')).toHaveText('27');
  await adminNavigate(page, 'reportsSection');
  await expect(page.locator('#reportsSection')).toBeVisible();
  await page.locator('#reportsSection [data-query="pageSize"]').selectOption('10');
  const reportRows = page.locator('#reportsSection [data-report-id]:visible');
  await expect(reportRows).toHaveCount(10);
  await expect(page.locator('#reportsPrev')).toBeDisabled();
  await page.locator('#reportsNext').click();
  await expect(page.locator('#reportsPageInfo')).toHaveText('11-20 of 27 reports');
  await page.locator('#reportsPrev').click();
  await page.locator('#adminSearch').fill('Road damage 0');
  await expect(reportRows).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await reportRows.first().locator('[data-action="view"]').click();
  await expect(page).toHaveURL(new URL(`/report-details.html?id=${report.id}`, baseURL).href);
  await expect(page.locator('#reportDetails .rd-header')).toContainText(`Report #${report.id}`);
});

test('admin report notifications track read activity and link to the shared details', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  const owner = sessions.get(page);
  const admin = await adminSession(baseURL);
  const session = { ...admin.user, apiToken: admin.token };
  await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), session);
  await page.goto('/admin.html');
  await expect(page.locator('#adminActivityBadge')).toBeVisible();
  await page.locator('#adminActivityBell').click();
  await expect(page.locator('#adminActivityPopover')).toBeVisible();
  const item = page.locator(`#adminActivityList a[href="report-details.html?id=${report.id}"]`);
  await expect(item).toBeVisible();
  await page.locator('#adminActivityMarkAll').click();
  await expect(page.locator('#adminActivityBadge')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#adminActivityPopover')).toBeHidden();
  await page.reload();
  await expect(page.locator('#statTotal')).not.toHaveText('0');
  await expect(page.locator('#adminActivityBadge')).toBeHidden();
  await page.locator('#adminActivityBell').click();
  await item.click();
  await expect(page.locator('#adminReportDialog .rd-publication')).toBeVisible();
  await expect(page.locator('#adminReportDialog [data-report-dialog-title]')).toContainText(`#${report.id}`);
});

test('Admin monitors assigned Barangay updates without operational controls or a document reload', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  const admin = await adminSession(baseURL), official = await createOfficial(baseURL, admin.token, report.barangay, 'monitoring_actions');
  await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
  await open(page, report);
  const documents = []; page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  await expect(page.locator('.rd-review-form, .rd-severity, .rd-summary, .rd-staff-tools')).toHaveCount(0);
  expect((await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${admin.token}` }, data: { status: 'ongoing' } })).status()).toBe(403);
  for (const status of ['ongoing', 'resolved']) {
    const changed = await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${official.token}` }, ...statusPayload(status) }); expect(changed.status()).toBe(200);
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('reports:mutation', { detail: { phase: 'saved', id: String(id) } })), report.id);
    await expect(page.locator('.rd-status')).toContainText(status === 'ongoing' ? 'Ongoing' : 'Resolved');
    await expect(page.locator('.rd-review-form')).toHaveCount(0);
  }
  await expect(page.locator('.rd-timeline')).toContainText('Completed repair with supporting evidence');
  expect(documents).toEqual([]);
});

test('admin synchronization preserves unchanged DOM, updates API fields, and recovers visibly from errors', async ({ page, request, baseURL }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  const report = await createReport(page, request, baseURL, { text: 'Initial server description' });
  const admin = await adminSession(baseURL);
  await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
  let changed = false;
  let failed = false;
  const counts = new Map();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/reports' || path.startsWith('/api/admin/')) counts.set(path, (counts.get(path) || 0) + 1);
  });
  await page.route('**/api/reports', async route => {
    if (failed) return route.fulfill({ status: 503, json: { message: 'Temporary outage' } });
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({
      json: {
        ...body, reports: body.reports.filter(row => row.id === report.id).map(row => changed ? {
          ...row,
          description: 'Updated from the backend API', location: 'Updated report location', latitude: '10.675', longitude: '122.945', updated_at: '2026-10-15 12:00:00'
        } : row)
      }
    });
  });
  await page.goto('/admin.html#reports');
  await expect(page.locator('#adminReportsBody:visible, #adminReportCards:visible')).toContainText('Initial server description');
  await page.evaluate(() => { window.adminRowIdentity = document.querySelector('#reportsSection [data-report-id]'); });
  await page.evaluate(() => syncReportsFromBackend());
  expect(await page.evaluate(() => window.adminRowIdentity === document.querySelector('#reportsSection [data-report-id]'))).toBe(true);
  const beforeStorage = counts.get('/api/reports');
  await page.evaluate(() => {
    window.adminStorageRenders = 0;
    onReportsChanged(() => window.adminStorageRenders++);
    window.dispatchEvent(new StorageEvent('storage', { key: 'up_reports' }));
  });
  expect(await page.evaluate(() => window.adminStorageRenders)).toBe(1);
  expect(counts.get('/api/reports')).toBe(beforeStorage);
  const beforeInit = Object.fromEntries(counts);
  await page.evaluate(() => window.dispatchEvent(new Event('DOMContentLoaded')));
  expect(Object.fromEntries(counts)).toEqual(beforeInit);
  await page.clock.resume();
  changed = true;
  await page.evaluate(() => syncReportsFromBackend());
  await expect(page.locator('#adminReportsBody:visible, #adminReportCards:visible')).toContainText('Updated from the backend API');
  expect(await page.evaluate(() => { const report = getAllReports()[0]; return [report.location, report.lat, report.lng]; })).toEqual(['Updated report location', 10.675, 122.945]);
  failed = true;
  await page.evaluate(() => syncReportsFromBackend());
  await expect(page.locator('#adminReportsFeedback')).toBeVisible();
  await expect(page.locator('#adminReportsFeedback')).toContainText('could not be loaded');
  failed = false;
  await page.locator('#adminReportsFeedback').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#adminReportsBody:visible, #adminReportCards:visible')).toContainText('Updated from the backend API');
  await expect(page.locator('#adminReportsFeedback')).toBeHidden();
});

test('admin shared components stay responsive and follow the selected theme', async ({ page, request, baseURL }, info) => {
  test.setTimeout(60000);
  await createReport(page, request, baseURL, { text: 'A long description of the reported road damage that must wrap inside the mobile report card without hiding the issue or location.' });
  const admin = await adminSession(baseURL);
  await createOfficial(baseURL, admin.token, 'Villamonte', 'responsive');
  await page.addInitScript(session => {
    sessionStorage.setItem('up_session', JSON.stringify(session));
    localStorage.setItem('neighborlens:theme-preference:v1', 'light');
  }, { ...admin.user, apiToken: admin.token });
  await page.goto('/admin.html#reports');
  await expect(page.locator('#reportsSection [data-report-id]').first()).toBeVisible();
  await fs.mkdir(`${artifactRoot}/admin-components-screenshots`, { recursive: true });
  for (const width of [320, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const appearance of ['light', 'dark']) {
      await adminAppearance(page, appearance);
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      const row = width > 900 ? page.locator('#reportsSection [data-report-id]').first() : page.locator('#adminReportCards .report-card').first();
      await row.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width <= 900) {
        await expect(row).toHaveCSS('background-color', appearance === 'light' ? 'rgb(255, 255, 255)' : 'rgb(20, 25, 38)');
        const overflow = await row.locator('td').evaluateAll(cells => cells.some(cell => cell.scrollWidth > cell.clientWidth + 1));
        expect(overflow).toBe(false);
      }
      if (width === 430 || width === 1440) await page.screenshot({ path: `${artifactRoot}/admin-components-screenshots/reports-${width}-${appearance}-${info.project.name}.png` });
    }
  }
  await page.setViewportSize({ width: 430, height: 960 });
  for (const appearance of ['light', 'dark']) {
    const surface = appearance === 'light' ? 'rgb(255, 255, 255)' : 'rgb(20, 25, 38)';
    await adminAppearance(page, appearance);
    await adminNavigate(page, 'accountsSection');
    await expect(page.locator('#brgyAccountsBody')).toContainText('Villamonte');
    const account = page.locator('#brgyAccountsBody tr').first();
    await expect(account).toHaveCSS('background-color', surface);
    expect(await account.locator('td').evaluateAll(cells => cells.some(cell => cell.scrollWidth > cell.clientWidth + 1))).toBe(false);
    await page.getByRole('button', { name: 'My Account', exact: true }).click();
    await expect(page.locator('#accountModal')).toBeVisible();
    expect(await page.locator('#accountModal .modal-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.locator('#accountModal input').first()).toHaveCSS('background-color', surface);
    await page.evaluate(() => closeAccountModal());
    await adminNavigate(page, 'analyticsSection');
    await expect(page.locator('#analyticsSection .analytics-panel').first()).toHaveCSS('background-color', surface);
    await page.locator('#adminActivityBell').click();
    await expect(page.locator('#adminActivityPopover')).toBeVisible();
    await expect(page.locator('#adminActivityPopover')).toHaveCSS('background-color', surface);
    const bounds = await page.locator('#adminActivityPopover').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(430);
    await page.keyboard.press('Escape');
  }
});

for (const appearance of ['light', 'dark']) {
  test(`admin reports preserve ${appearance} theme and show uploaded evidence thumbnails`, async ({ page, request, baseURL }, info) => {
    const text = `Visual evidence ${appearance} ${Date.now()}`;
    const report = await createReport(page, request, baseURL, { text });
    const admin = await adminSession(baseURL);
    await page.addInitScript(({ session, appearance }) => {
      sessionStorage.setItem('up_session', JSON.stringify(session));
      localStorage.setItem('neighborlens:theme-preference:v1', appearance);
      const observer = new MutationObserver(() => {
        if (document.body) { window.firstBodyTheme = document.documentElement.dataset.theme; observer.disconnect(); }
      });
      observer.observe(document, { childList: true, subtree: true });
    }, { session: { ...admin.user, apiToken: admin.token }, appearance });
    await page.emulateMedia({ colorScheme: appearance === 'light' ? 'dark' : 'light' });
    const inference = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/ai/')) inference.push(request.url()); });
    await page.goto('/admin.html#reports');
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    await page.locator('#adminSearch').fill(text);
    await expect(page.locator('#reportsSection [data-report-id]')).toHaveCount(1);
    const image = page.locator('.rm-thumbnail img, #adminReportCards .report-card img');
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect(image).toHaveAttribute('data-evidence-url', new URL(report.images[0].imagePath, baseURL).href);
    await fs.mkdir(`${artifactRoot}/admin-overview-screenshots`, { recursive: true });
    await page.screenshot({ path: `${artifactRoot}/admin-overview-screenshots/reports-${appearance}-${info.project.name}.png` });
    await page.locator('#reportsSection [data-action="view"]').first().click();
    await expect(page.locator('#reportDetails .rd-header')).toContainText(`Report #${report.id}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    expect(await page.evaluate(() => window.firstBodyTheme)).toBe(appearance);
    await page.screenshot({ path: `${artifactRoot}/admin-overview-screenshots/details-${appearance}-${info.project.name}.png` });
    await page.locator('#backToReports').click();
    await page.goto(`/report-details.html?id=${report.id}`);
    await expect(page.locator('#reportDetails')).toBeVisible();
    await page.reload();
    await expect(page.locator('#reportDetails')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    await page.locator('#backToReports').click();
    await expect(page.locator('#reportsSection')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    expect(inference).toEqual([]);
  });
}

test('admin report thumbnail failure keeps a stable placeholder', async ({ page, request, baseURL }) => {
  const text = `Unavailable evidence ${Date.now()}`;
  const report = await createReport(page, request, baseURL, { text });
  const admin = await adminSession(baseURL);
  await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
  await page.route('**/api/reports', async route => {
    const response = await route.fetch();
    const data = await response.json();
    return route.fulfill({ json: { ...data, reports: data.reports.filter(row => row.id === report.id) } });
  });
  let attempts = 0;
  await page.route(`**${report.images[0].imagePath}`, route => { attempts++; return route.fulfill({ status: 404, body: '' }); });
  await page.goto('/admin.html#reports');
  await expect(page.locator('#reportsSection [data-report-id]')).toHaveCount(1);
  const thumbnail = page.locator('.rm-thumbnail, #adminReportCards .mr-photo');
  await thumbnail.scrollIntoViewIfNeeded();
  await expect(thumbnail.locator('.evidence-unavailable')).toHaveText('Photo unavailable');
  await expect(thumbnail.locator('img')).toBeHidden();
  const bounds = await thumbnail.boundingBox();
  if (page.viewportSize().width > 900) { expect(bounds.width).toBe(56); expect(bounds.height).toBe(42); }
  else { expect(bounds.width).toBe(88); expect(bounds.height).toBe(88); }
  expect(attempts).toBe(1);
});

for (const role of ['citizen', 'barangay']) {
  test(`outside ${role} account cannot open another report`, async ({ page, request, baseURL }) => {
    const report = await createReport(page, request, baseURL);
    const response = await request.post('/__fixture_citizen', { data: { username: `outside_${Date.now()}`, password: 'password123', barangay: 'Barangay B', reporting: false } });
    const other = await response.json();
    const account = role === 'citizen' ? other : await createOfficial(baseURL, (await adminSession(baseURL)).token, 'Barangay 2', 'outside');
    const session = { ...account.user, apiToken: account.token };
    await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), session);
    await page.goto(`/report-details.html?id=${report.id}`);
    await expect(page.locator('#reportState')).toContainText('do not have access');
    await expect(page.locator('#reportDetails')).toBeEmpty();
    await expect(page.locator('.rd-photos img')).toHaveCount(0);
  });
}

test('only actual server status changes appear after refreshing', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  const owner = sessions.get(page);
  const admin = (await createOfficial(baseURL, (await adminSession(baseURL)).token, report.barangay, 'details_status')).token;
  await open(page, report);
  await expect(page.locator('.rd-timeline li')).toHaveCount(1);
  for (const [index, status] of ['ongoing', 'resolved'].entries()) {
    const response = await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${admin}` }, ...statusPayload(status) });
    expect(response.status()).toBe(200);
    await page.reload();
    await expect(page.locator('.rd-timeline li')).toHaveCount(index + 2);
    if (status === 'ongoing') await expect(page.locator('.rd-timeline')).not.toContainText('Resolved');
  }
  await expect(page.locator('.rd-header [data-status] strong')).toHaveText('Resolved');
});

for (const [mode, label] of [['low', 'Low confidence'], ['none', 'No detection'], ['unavailable', 'AI unavailable']]) {
  test(`${label} never becomes a confirmed original detection`, async ({ page, request, baseURL }) => {
    const report = await createReport(page, request, baseURL, { mode, category: 'Flooding / Drainage' });
    await open(page, report);
    await expect(page.locator('.rd-summary')).toContainText(label);
    await expect(page.locator('.rd-summary')).not.toContainText('Original YOLO prediction');
    await expect(page.locator('.rd-summary')).not.toContainText('Suggestion accepted');
  });
}

test('legacy report does not invent an original assessment or missing second image', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL, { proofs: false });
  await page.route(`**/api/reports/${report.id}`, route => route.fulfill({ json: { ...report, images: [report.images[0]] } }));
  await open(page, report);
  await expect(page.locator('.rd-photos button')).toHaveCount(2);
  await expect(page.locator('.rd-photos img')).toHaveCount(1);
  await expect(page.locator('[data-photo="2"]')).toBeDisabled();
  await expect(page.locator('.rd-summary')).toContainText('No original AI assessment was recorded');
  await expect(page.locator('.rd-summary')).not.toContainText('80%');
});

test('private attachment failure is bounded without refetching its parent report', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  let failed = false;
  let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/reports/${report.id}`) reads++; });
  await page.route(`**${report.images[0].imagePath}`, route => {
    if (!failed) { failed = true; return route.fulfill({ status: 403, headers: { 'Cache-Control': 'no-store' } }); }
    return route.continue();
  });
  await page.goto(`/report-details.html?id=${report.id}`);
  await expect(page.locator('.evidence-unavailable')).toHaveCount(1);
  expect(reads).toBe(1);
});

test('missing, invalid, and deleted reports clear all details safely', async ({ page, request, baseURL }) => {
  await page.goto('/report-details.html?id=99999999');
  await expect(page.locator('#reportState')).toContainText('Report not found');
  await page.goto('/report-details.html?id=invalid');
  await expect(page.locator('#reportState')).toContainText('valid report link');
  const report = await createReport(page, request, baseURL);
  await open(page, report);
  await page.route(`**/api/reports/${report.id}`, route => route.fulfill({ status: 404, json: { error: 'Report not found.' } }));
  await page.reload();
  await expect(page.locator('#reportState')).toContainText('Report not found');
  await expect(page.locator('#reportDetails')).toBeEmpty();
});

test('missing GPS and unavailable history do not create a map position or review events', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await page.route(`**/api/reports/${report.id}`, route => route.fulfill({ json: { ...report, latitude: null, longitude: null } }));
  await page.route(`**/api/reports/${report.id}/history`, route => route.fulfill({ status: 503 }));
  await open(page, report);
  await expect(page.locator('#mapStatus')).toContainText('No recorded coordinates');
  await expect(page.locator('#reportMap')).not.toHaveClass(/leaflet-container/);
  await expect(page.locator('.rd-timeline li')).toHaveCount(1);
  await expect(page.locator('#reportDetails')).toContainText('Review history could not be loaded');
});

test('logout clears rendered photos and report content before leaving the page', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await open(page, report);
  await page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true }).click();
  await page.keyboard.press('Escape');
  const state = await page.evaluate(() => {
    document.getElementById('detailsLogout').click();
    return { content: document.getElementById('reportDetails').innerHTML, source: document.getElementById('enlargedEvidence')?.getAttribute('src') ?? null };
  });
  expect(state).toEqual({ content: '', source: null });
  await page.waitForURL('**/login.html');
});

test('expired enlarged cloud evidence renews once through an authorized read', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  let reads = 0;
  await page.route(`**/api/reports/${report.id}`, async route => {
    const response = await route.fetch();
    const saved = await response.json();
    reads++;
    saved.images[0].imagePath = baseURL + '/isolated-cloud.png?signature=' + reads;
    await route.fulfill({ response, json: saved });
  });
  await page.route('**/isolated-cloud.png?*', route => route.fulfill({ body: photos[0], contentType: 'image/png' }));
  await open(page, report);
  await page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true }).click();
  await page.locator('#enlargedEvidence').dispatchEvent('error');
  await expect(page.locator('#enlargedEvidence')).toHaveAttribute('src', /signature=2$/);
  await expect.poll(() => page.locator('#enlargedEvidence').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(reads).toBe(2);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('history authorization denial clears the whole view even if the first report read succeeded', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  await page.route(`**/api/reports/${report.id}/history`, route => route.fulfill({ status: 403 }));
  await page.goto(`/report-details.html?id=${report.id}`);
  await expect(page.locator('#reportState')).toContainText('do not have access');
  await expect(page.locator('#reportDetails')).toBeEmpty();
});

test('delayed report response cannot render after the authenticated account changes', async ({ page, request, baseURL }) => {
  const report = await createReport(page, request, baseURL);
  let release;
  await page.route(`**/api/reports/${report.id}`, async route => {
    const response = await route.fetch();
    await new Promise(resolve => { release = () => route.fulfill({ response }).then(resolve); });
  });
  await page.goto(`/report-details.html?id=${report.id}`);
  await expect.poll(() => Boolean(release)).toBe(true);
  const response = await request.post('/__fixture_citizen', { data: { username: `late_${Date.now()}`, password: 'password123', barangay: 'Barangay B', reporting: false } });
  const other = await response.json();
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...other.user, apiToken: other.token });
  await release();
  await expect(page.locator('#reportState')).toContainText('session changed');
  await expect(page.locator('#reportDetails')).toBeEmpty();
});

test('Citizen My Reports remains visible when an Admin tab refreshes, navigates and logs out', async ({ page, context, request, baseURL }) => {
  const report = await createReport(page, request, baseURL, { text: 'Owned report survives other portal tabs' });
  const admin = await adminSession(baseURL);
  await page.goto('/citizen.html#my-reports');
  await expect(page.locator('#myReports')).toContainText('Owned report survives other portal tabs');
  const documents = [];
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  const adminPage = await context.newPage();
  await adminPage.addInitScript(session => {
    sessionStorage.setItem('up_session', JSON.stringify(session));
    Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() { } });
  }, { ...admin.user, apiToken: admin.token });
  await adminPage.goto('/admin.html#reports');
  await expect(adminPage.locator('#reportsSection')).toContainText('Owned report survives other portal tabs');
  await adminPage.evaluate(() => syncReportsFromBackend());
  await expect(page.locator('#myReports .mr-row')).toHaveCount(1);
  await expect(page.locator('#myReports')).toContainText('Owned report survives other portal tabs');
  expect(await page.evaluate(() => getReportLoadState().status)).toBe('ready');
  expect(documents).toEqual([]);
  await page.reload();
  await expect(page.locator('#myReports')).toContainText('Owned report survives other portal tabs');
  await adminPage.reload();
  await expect(adminPage.locator('#reportsSection')).toContainText('Owned report survives other portal tabs');
  await adminPage.goto(`/report-details.html?id=${report.id}`);
  await expect(adminPage.locator('#reportDetails')).toBeVisible();
  await adminPage.evaluate(() => logout());
  await adminPage.waitForURL('**/admin-login.html');
  adminFixture = null;
  expect(await adminPage.evaluate(() => sessionStorage.getItem('up_reports'))).toBeNull();
  await page.evaluate(() => syncReportsFromBackend());
  await expect(page.locator('#myReports')).toContainText('Owned report survives other portal tabs');
  expect(await page.evaluate(() => getReportLoadState().status)).toBe('ready');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('up_session')).role)).toBe('citizen');
  expect(documents).toHaveLength(1);
  await adminPage.close();
});

require('./theme.cases')({ test, expect, fs, sessions, createReport, open, expectLiveMapTiles, getPhotos: () => photos, adminSession, createOfficial });
require('./auth-design.cases')({ test, expect, fs, sessions, createReport, adminSession, getPhotos: () => photos });
require('./admin-refresh.cases')({ test, expect, fs, sessions, createReport, adminSession });
require('./admin-analytics.cases')({ test, expect, fs, createReport, adminSession });

test('Admin UI uses section headings, boxed account confirmation, paginated logs, and semantic GIS pins', async ({ page, baseURL }) => {
  await page.goto('/admin-login.html');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.locator('#roleLoginPass')).toHaveAttribute('type', 'text');
  await expect(page.locator('#roleLoginEye i')).toHaveClass(/bx-hide/);
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(page.locator('#roleLoginPass')).toHaveAttribute('type', 'password');
  const admin = await adminSession(baseURL);
  await page.goto('/login.html');
  await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
  await page.goto('/admin.html#accounts');
  await expect(page.locator('#adminPageTitle')).toHaveText('Barangay Management');
  await expect(page.locator('#adminContent input[type="search"]:visible')).toHaveCount(1);
  await expect(page.locator('.portal-system-logo').first()).toHaveAttribute('alt', 'NeighborLens AI');
  const menuIcon = await page.locator('#adminMenuButton i').evaluate(icon => getComputedStyle(icon, '::before').maskImage);
  expect(menuIcon).toContain('data:image/svg+xml');

  for (const [label, barangay] of [['Add Administrator', false], ['Add Barangay Account', true]]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.locator('#accUsername').fill('ui_check_account');
    if (barangay) await page.locator('#accBarangay').selectOption({ label: 'Villamonte' });
    await page.locator('#accPassword').fill('TemporaryPassword123');
    await page.getByLabel('Confirm password', { exact: true }).fill('MismatchedPassword123');
    await page.getByRole('button', { name: 'Save Account', exact: true }).click();
    await expect(page.locator('#accPasswordConfirmError')).toHaveText('Passwords do not match.');
    await expect(page.locator('#accPasswordConfirm')).toBeFocused();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }

  await page.goto('/admin.html#logs');
  await expect(page.locator('#adminPageTitle')).toHaveText('System Activity Logs');
  const request = page.waitForRequest(url => new URL(url.url()).searchParams.get('limit') === '5' && new URL(url.url()).pathname === '/api/admin/audit-logs');
  await page.locator('#auditPageSize').selectOption('5');
  await request;
  await expect(page.locator('#auditPageNumber')).toHaveText(/Page 1 of /);
  const tones = await page.evaluate(() => [
    { status: 'pending', classification: 'MAJOR' },
    { status: 'ongoing', classification: 'MINOR' },
    { status: 'resolved', classification: 'MAJOR' },
    { status: 'rejected' }
  ].map(item => {
    const markup = document.createElement('template');
    markup.innerHTML = ReportGisPresentation.marker({ id: 1, ...item }).html;
    return [markup.content.querySelector('.gis-pin').dataset.tone, markup.content.querySelector('.gis-marker-status').dataset.status];
  }));
  expect(tones).toEqual([['major', 'pending'], ['minor', 'ongoing'], ['resolved', 'resolved'], ['rejected', 'rejected']]);
});
