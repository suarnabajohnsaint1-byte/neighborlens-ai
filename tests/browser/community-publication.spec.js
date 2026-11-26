const { test, expect } = require('@playwright/test');
const { fixedBrowserLocation } = require('../support/browser-geolocation');
const sharp = require('sharp');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
let photos;
const sessions = new WeakMap();

test.beforeAll(async () => {
  photos = await Promise.all([JPEG_BYTES, SECOND_JPEG_BYTES].map(buffer => sharp(buffer).png().toBuffer()));
});

test.beforeEach(async ({ page, context, request }) => {
  await fixedBrowserLocation(page, context, { latitude: 10.6685, longitude: 122.9647, accuracy: 15 });
  const response = await request.post('/__fixture_citizen', { data: { username: `publication_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, password: 'password123', barangay: 'Villamonte' } });
  expect(response.status()).toBe(201);
  const data = await response.json(), session = { ...data.user, apiToken: data.token };
  sessions.set(page, session);
  await page.addInitScript(session => {
    sessionStorage.setItem('up_session', JSON.stringify(session));
    Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
  }, session);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/api/config/reverse-geocode') return route.fulfill({ json: { ok: true, data: { display_name: 'Bacolod City', address: { city: 'Bacolod City', village: 'Villamonte' } } } });
    return route.continue();
  });
  await page.goto('/citizen.html');
  await page.locator('#description').fill('Fictional public road damage');
  await page.locator('#imgInput').setInputFiles(photos.map((buffer, index) => ({ name: `fictional-${index}.png`, mimeType: 'image/png', buffer })));
  await expect(page.locator('#citizenCategory')).toBeEnabled();
  await expect(page.locator('#visionDetectBox [data-assessment-state]')).toBeVisible();
  await page.locator('#citizenCategory').selectOption('Road Damage');
  await expect.poll(() => page.evaluate(() => getDetectedGPS()?.barangay)).toBeTruthy();
});

test('submission automatically queues review without a checkbox or a separate publication request', async ({ page, request }, testInfo) => {
  await expect(page.locator('#requestCommunityPublication')).toHaveCount(0);
  await page.locator('#submitBtn').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `.data/publication-screenshots/automatic-submit-${testInfo.project.name}.png` });
  const shares = [];
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/community/posts') shares.push(req.url()); });
  const saved = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const report = await response.json();
  expect(report.status).toBe('pending'); expect(report.images).toHaveLength(2);
  expect(report.publication.state).toBe('pending_approval');
  expect(shares).toHaveLength(0);
  await expect(page.locator('#notificationPopover')).toBeVisible();
  await expect(page.locator(`.notification-item[data-report-id="${report.id}"]`)).toContainText('Report submitted');
  const headers = { Authorization: `Bearer ${sessions.get(page).apiToken}` };
  const requests = await (await request.get('/api/community/publication-requests', { headers })).json();
  expect(requests.requests.filter(row => row.reportId === report.id)).toHaveLength(1);
  const feed = await (await request.get('/api/community/posts', { headers })).json();
  expect(feed.posts.some(post => post.linkedReport?.id === report.id)).toBe(false);
});

test('submission ignores a second submit while the first request is pending', async ({ page }) => {
  await expect(page.locator('#submitBtn')).toBeEnabled();
  let submissions = 0;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  let releaseRequest;
  const pending = new Promise(resolve => { releaseRequest = resolve; });
  await page.route('**/api/reports', async route => {
    if (route.request().method() === 'POST') {
      submissions++;
      requestStarted();
      await pending;
    }
    await route.continue();
  });
  const saved = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.status() === 201);
  await page.locator('#submitBtn').click();
  await started;
  try {
    await expect(page.locator('#submitBtn')).toBeDisabled();
    await page.locator('#reportForm').dispatchEvent('submit', { cancelable: true });
  } finally {
    releaseRequest();
  }
  await saved;
  await expect(page.locator('#submitBtn')).toContainText('Submitted');
  expect(submissions).toBe(1);
});

test('a lost successful acknowledgement can retry without creating a second report or publication', async ({ page, request }) => {
  let firstReport;
  await page.route('**/api/reports', async route => {
    if (route.request().method() !== 'POST' || firstReport) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    firstReport = await response.json();
    await route.fulfill({ status: 503, json: { error: 'Synthetic lost acknowledgement. Retry the same submission.' } });
  });
  await page.locator('#submitBtn').click();
  await expect(page.locator('#formError')).toContainText('lost acknowledgement');
  await expect(page.locator('#submitBtn')).toBeEnabled();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect((await response.json()).id).toBe(firstReport.id);
  const headers = { Authorization: `Bearer ${sessions.get(page).apiToken}` };
  const reports = await (await request.get('/api/reports', { headers })).json();
  expect(reports.reports).toHaveLength(1);
  const publications = await (await request.get('/api/community/publication-requests', { headers })).json();
  expect(publications.requests).toHaveLength(1);
});

test('accurate in-city GPS cannot publish when the incident barangay cannot be confirmed', async ({ page }) => {
  await page.route('**/api/config/report-area', route => route.fulfill({ json: {
    status: 'AUTHORITATIVE_POLYGONS_PENDING', barangayId: null, boundaryCheckStatus: 'inside_service_area'
  } }));
  let reports = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/reports') reports++;
  });
  await page.locator('#submitBtn').click();
  await expect(page.getByText('Barangay boundary verification is currently unavailable. Try again later.')).toBeVisible();
  expect(reports).toBe(0);
  expect(sessions.get(page).barangay).toBe('Villamonte');
});

test('a failed submission keeps the form recoverable and retry creates exactly one pending report', async ({ page, request }) => {
  let fail = true;
  await page.route('**/api/reports', route => {
    if (route.request().method() !== 'POST' || !fail) return route.continue();
    fail = false;
    return route.fulfill({ status: 503, json: { error: 'Isolated transaction unavailable' } });
  });
  await page.locator('#submitBtn').click();
  await expect(page.locator('#reportForm')).toContainText('Isolated transaction unavailable');
  await expect(page.locator('#submitBtn')).toBeEnabled();
  const headers = { Authorization: `Bearer ${sessions.get(page).apiToken}` };
  expect((await (await request.get('/api/reports', { headers })).json()).reports).toHaveLength(0);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const response = await saved; expect(response.status()).toBe(201);
  expect((await response.json()).publication.state).toBe('pending_approval');
  expect((await (await request.get('/api/reports', { headers })).json()).reports).toHaveLength(1);
});

test('a delayed report acknowledgement cannot reset replacement photos or a new manual description', async ({ page }) => {
  let release, entered = false;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route('**/api/reports', async route => {
    const response = await route.fetch(); entered = true; await waiting; await route.fulfill({ response });
  }, { times: 1 });
  await page.locator('#submitBtn').click();
  try {
    await expect.poll(() => entered).toBe(true);
    await page.locator('#description').fill('New manual description after photo replacement');
    await page.locator('#imgInput').setInputFiles(photos.map((buffer, index) => ({ name: `replacement-${index}.png`, mimeType: 'image/png', buffer })));
    const acknowledged = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
    release();
    expect((await acknowledged).status()).toBe(201);
    await expect(page.locator('#submitBtn')).toHaveText('Submit to AI Analysis');
    await expect(page.locator('#description')).toHaveValue('New manual description after photo replacement');
    await expect(page.locator('#aiResult')).toBeHidden();
    expect(await page.locator('#imgInput').evaluate(input => input.files.length)).toBe(2);
  } finally { release(); }
});

test('refresh shows pending review in Report Details without asking the citizen to share again', async ({ page }) => {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/reports') && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const report = await (await saved).json();
  await page.goto(`/report-details.html?id=${report.id}`);
  await expect(page.locator('.rd-publication')).toContainText('Pending Community Review');
  await expect(page.getByRole('button', { name: 'Share to Community', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.rd-publication')).toContainText('Pending Community Review');
});
