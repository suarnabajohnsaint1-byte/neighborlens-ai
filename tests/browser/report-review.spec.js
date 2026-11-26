const { addReportGps } = require('../support/citizens');
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { adminSession, createOfficial } = require('../support/accounts');
const { PNG_BYTES, JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const libraries = new Map();
const sharp = require('sharp');
let visualPhotos;
let admin, official, peer, owner, outside;

async function resetRateLimits(request) {
  expect((await request.post('/__phase2_reset_rate_limits')).status()).toBe(204);
}

test.beforeAll(async ({ baseURL, request }) => {
  visualPhotos = await Promise.all([0, 1].map(index => { const pixels = Buffer.alloc(640 * 480 * 3); for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) { const noise = (x * 17 + y * 31 + x * y) % 43; const crack = Math.abs(x - 310 - Math.sin(y / 42 + index) * 48) < 8; const value = crack ? 24 : 120 + noise; const offset = (y * 640 + x) * 3; pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value - 4; } return sharp(pixels, { raw: { width: 640, height: 480, channels: 3 } }).jpeg().toBuffer(); }));
  for (const path of ['leaflet@2.0.0-beta.5/dist/leaflet-global.js', 'leaflet@2.0.0-beta.5/dist/leaflet.css']) {
    const asset = await fetch(`https://cdn.jsdelivr.net/npm/${path}`); expect(asset.ok).toBe(true); libraries.set('/npm/' + path, { body: Buffer.from(await asset.arrayBuffer()), contentType: asset.headers.get('content-type') });
  }
  await resetRateLimits(request);
  admin = await adminSession(baseURL);
  official = await createOfficial(baseURL, admin.token, 'Villamonte', 'review_ui');
  peer = await createOfficial(baseURL, admin.token, 'Villamonte', 'review_peer');
  outside = await createOfficial(baseURL, admin.token, 'Mandalagan', 'review_other');
  const response = await request.post('/__fixture_citizen', { data: { username: `review_owner_${Date.now()}`, password: 'ReviewFixture1234', barangay: 'Villamonte' } });
  expect(response.status()).toBe(201); owner = await response.json();
});

test.beforeEach(async ({ request }) => { await resetRateLimits(request); });

async function report(baseURL, visual = false, citizen = owner, proofs) {
  const body = new FormData();
  if (proofs) body.append('assessmentProofs', JSON.stringify(proofs));
  for (const [key, value] of Object.entries({ requestKey: randomUUID(), description: 'Controlled report workflow browser fixture', citizenCategory: 'Road Damage', barangay: 'Villamonte', latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15' })) body.append(key, value);
  addReportGps(body, 'Villamonte');
  for (const [bytes, type, name] of (visual ? visualPhotos.map((photo, index) => [photo, 'image/jpeg', `road-${index}.jpg`]) : [[PNG_BYTES, 'image/png', 'one.png'], [JPEG_BYTES, 'image/jpeg', 'two.jpg']])) body.append('images', new Blob([bytes], { type }), name);
  const response = await fetch(baseURL + '/api/reports', { method: 'POST', headers: { Authorization: `Bearer ${citizen.token}` }, body });
  expect(response.status).toBe(201);
  return response.json();
}

async function open(page, user, id, destination = `/report-details.html?id=${id}`) {
  await page.addInitScript(session => {
    sessionStorage.setItem('up_session', JSON.stringify(session));
    Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
  }, { ...user.user, apiToken: user.token });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdn.jsdelivr.net' && libraries.has(url.pathname)) return route.fulfill(libraries.get(url.pathname));
    if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ body: PNG_BYTES, contentType: 'image/png' });
    return ['127.0.0.1', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto(destination);
  if (destination.startsWith('/report-details.html')) await expect(page.locator('#reportDetails')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const role of ['admin', 'barangay']) {
  test(`${role} notification click commits the read before navigating and restores the correct badge`, async ({ page, baseURL, request }) => {
    const recipient = role === 'admin' ? admin : official;
    const sender = role === 'admin' ? official : admin;
    const headers = { Authorization: `Bearer ${recipient.token}` };
    const items = [];
    for (let i = 0; i < 3; i++) items.push(await report(baseURL));
    expect((await request.post('/api/notifications/mark-all-read', { headers })).ok()).toBe(true);
    for (const [i, item] of items.entries()) {
      expect((await request.post(`/api/reports/${item.id}/messages`, {
        headers: { Authorization: `Bearer ${sender.token}` },
        data: { body: `Unread coordination message ${i}`, requestKey: randomUUID() }
      })).ok()).toBe(true);
    }
    const destination = `/${role}.html`;
    await open(page, recipient, items[0].id, destination);
    const bell = page.locator(`#${role}ActivityBell`);
    const badge = page.locator(`#${role}ActivityBadge`);
    const list = page.locator(`#${role}ActivityList`);
    await expect(badge).toHaveText('3');
    for (const [index, item] of items.entries()) {
      await bell.click();
      const link = list.locator(`a[href="report-details.html?id=${item.id}#report-conversation"]`);
      await expect(link.locator('..')).toHaveClass(/unread/);
      const id = (await link.getAttribute('data-read-report')).slice(13);
      if (!index) {
        await page.route(`**/api/notifications/${id}/read`, route => route.fulfill({ status: 503, json: { error: 'Controlled read failure' } }), { times: 1 });
        await link.click();
        await expect(list).toContainText('Notifications could not be marked as read.');
        await expect(badge).toHaveText('3');
        await expect(link.locator('..')).toHaveClass(/unread/);
      }
      const response = page.waitForResponse(res => res.url().endsWith(`/api/notifications/${id}/read`));
      await link.click();
      expect((await response).ok()).toBe(true);
      await expect(page.locator('#report-conversation')).toBeFocused();
      const data = await (await request.get('/api/notifications?limit=100', { headers })).json();
      expect(data.notifications.find(row => String(row.id) === id).readAt).toBeTruthy();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/${role}\\.html`));
      if (index < 2) await expect(badge).toHaveText(String(2 - index));
      else await expect(badge).toBeHidden();
    }
    await bell.click();
    const alreadyRead = list.locator(`a[href="report-details.html?id=${items[0].id}#report-conversation"]`);
    await expect(alreadyRead.locator('..')).not.toHaveClass(/unread/);
    await alreadyRead.click();
    await expect(page.locator('#report-conversation')).toBeFocused();
    await page.goBack();
    await bell.click();
    await expect(alreadyRead).toBeVisible();
    await expect(badge).toBeHidden();
  });
}

test('staff wheel zoom keeps the painted image under the cursor without drift', async ({ page, baseURL }) => {
  const item = await report(baseURL, true);
  await open(page, admin, item.id);
  await page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true }).click();
  const image = page.locator('#enlargedEvidence');
  await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
  for (const fraction of [0.2, 0.5, 0.8]) {
    const point = await image.evaluate((node, fraction) => {
      const rect = node.getBoundingClientRect();
      const fit = Math.min(rect.width / node.naturalWidth, rect.height / node.naturalHeight);
      return {
        x: rect.x + rect.width / 2 + (fraction - 0.5) * node.naturalWidth * fit,
        y: rect.y + rect.height / 2 + (fraction - 0.5) * node.naturalHeight * fit
      };
    }, fraction);
    await page.mouse.move(point.x, point.y);
    for (const delta of [-100, -100, 100, 100]) {
      const previous = await image.evaluate(node => node.style.transform);
      await page.mouse.wheel(0, delta);
      await expect.poll(() => image.evaluate(node => node.style.transform)).not.toBe(previous);
      const projected = await image.evaluate((node, fraction) => {
        const rect = node.getBoundingClientRect();
        const fit = Math.min(rect.width / node.naturalWidth, rect.height / node.naturalHeight);
        return {
          x: rect.x + rect.width / 2 + (fraction - 0.5) * node.naturalWidth * fit,
          y: rect.y + rect.height / 2 + (fraction - 0.5) * node.naturalHeight * fit
        };
      }, fraction);
      expect(Math.hypot(projected.x - point.x, projected.y - point.y)).toBeLessThan(2);
    }
  }
});

test('Barangay touch pinch keeps an off-center image feature under the gesture', async ({ page, baseURL }, info) => {
  test.skip(!info.project.use.hasTouch, 'Requires a touch-enabled browser project.');
  const item = await report(baseURL, true);
  await open(page, official, item.id);
  await page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true }).tap();
  const image = page.locator('#enlargedEvidence');
  await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
  const feature = () => image.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const fit = Math.min(rect.width / node.naturalWidth, rect.height / node.naturalHeight);
    return { x: rect.x + rect.width / 2 - 0.18 * node.naturalWidth * fit, y: rect.y + rect.height / 2 };
  });
  const start = await feature();
  const session = await page.context().newCDPSession(page);
  const pair = radius => [{ x: start.x - radius, y: start.y, id: 1 }, { x: start.x + radius, y: start.y, id: 2 }];
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pair(20) });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pair(44) });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => image.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a)).toBeGreaterThan(2);
    const after = await feature();
    expect(Math.hypot(after.x - start.x, after.y - start.y)).toBeLessThan(2);
    const reset = page.getByRole('button', { name: 'Reset zoom' });
    await expect.poll(() => reset.evaluate(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    })).toBe(true);
    await reset.tap();
    await expect.poll(() => image.evaluate(node => node.style.transform)).toBe('translate(0px, 0px) scale(1)');
  } finally { await session.detach(); }
});

test('staff severity counters reflect confirmed Minor and Major without counting unassessed reports', async ({ page, context, baseURL, request }) => {
  const items = await Promise.all([report(baseURL), report(baseURL), report(baseURL)]);
  const barangay = await context.newPage();
  await open(page, admin, items[0].id, '/admin.html');
  await open(barangay, official, items[0].id, '/barangay.html');
  const counters = ['#statMinor', '#statMajor'];
  const baseline = [];
  for (const portal of [page, barangay]) {
    const counts = [];
    for (const selector of counters) {
      await expect(portal.locator(selector)).toHaveText(/^\d+$/);
      counts.push(Number(await portal.locator(selector).textContent()));
    }
    baseline.push(counts);
  }
  const headers = { Authorization: `Bearer ${official.token}` };
  for (const [index, classification] of ['MINOR', 'MAJOR', null].entries()) {
    const route = `/api/reports/${items[index].id}`;
    if (classification) {
      const result = await request.post(route + '/severity', { headers, data: {
        category: 'pothole', classification, evidence: { safety_impact: 'Observed conditions during the controlled inspection.' },
        reason: 'Test fixture for the verified severity counter.', expectedReviewId: 0, requestKey: randomUUID()
      } });
      expect(result.status()).toBe(200);
    }
    expect((await (await request.get(route, { headers })).json()).ai_classification).toBe(classification);
  }
  for (const [index, portal] of [page, barangay].entries()) {
    await portal.reload();
    for (const [column, selector] of counters.entries()) {
      await expect(portal.locator(selector)).toHaveText(String(baseline[index][column] + 1));
    }
  }
});

test('staff dashboards deliver private message notifications and recover unread state on reconnect', async ({ page, browser, baseURL, request }) => {
  const item = await report(baseURL);
  const firstContact = await report(baseURL);
  const barangayContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  const adminContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  const outsideContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  try {
    const brgy = await barangayContext.newPage(), dashboard = await adminContext.newPage();
    const adminTab = await adminContext.newPage(), other = await outsideContext.newPage();
    for (const portal of [dashboard, brgy, other]) await portal.addInitScript(() => {
      const NativeSource = window.EventSource;
      window.EventSource = class extends NativeSource {
        constructor(...args) {
          super(...args);
          window.testStaffStream = this;
          window.testNotificationEvents = [];
          this.addEventListener('message', event => window.testNotificationEvents.push(JSON.parse(event.data)));
        }
      };
    });
    await Promise.all([
      open(brgy, official, item.id, '/barangay.html'),
      open(dashboard, admin, item.id, '/admin.html'),
      open(adminTab, admin, item.id, '/admin.html'),
      open(other, outside, item.id, '/barangay.html'),
      open(page, admin, item.id)
    ]);
    await Promise.all([dashboard, brgy, other].map(portal => portal.waitForFunction(() => window.testStaffStream?.readyState === EventSource.OPEN)));
    const brgyBell = brgy.locator('#barangayActivityBell');
    await brgyBell.click();
    const brgyList = brgy.locator('#barangayActivityList');
    await expect(brgyList).not.toContainText('Loading notifications');
    await page.locator('.rd-message-form textarea').fill('Private coordination from the Admin browser');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const target = `a[href="report-details.html?id=${item.id}#report-conversation"]`;
    const notice = brgyList.locator(target);
    await expect(notice).toBeVisible();
    await expect.poll(() => brgy.evaluate(id => window.testNotificationEvents.filter(event => event.reportId === id).length, item.id)).toBe(1);
    await expect(brgy.locator('#barangayActivityBadge')).toBeVisible();
    await expect(notice).not.toContainText('Private coordination from the Admin browser');
    const notificationId = (await notice.getAttribute('data-read-report')).slice(13);
    await other.locator('#barangayActivityBell').click();
    await expect(other.locator('#barangayActivityList')).toContainText('No notifications yet');
    expect(await other.evaluate(id => window.testNotificationEvents.some(event => event.reportId === id), item.id)).toBe(false);
    expect((await request.patch(`/api/notifications/${notificationId}/read`, { headers: { Authorization: `Bearer ${outside.token}` } })).status()).toBe(404);
    expect((await request.get(`/api/reports/${item.id}/review`, { headers: { Authorization: `Bearer ${outside.token}` } })).status()).toBe(403);
    await notice.click();
    await expect(brgy.locator('#report-conversation')).toBeFocused();
    await expect(brgy.locator('.rd-coordination-messages')).toContainText('Private coordination from the Admin browser');
    await expect.poll(async () => {
      const response = await request.get('/api/notifications?limit=100', { headers: { Authorization: `Bearer ${official.token}` } });
      return Boolean((await response.json()).notifications.find(row => String(row.id) === notificationId)?.readAt);
    }).toBe(true);
    await brgy.locator('.rd-message-form textarea').fill('Barangay reply sent over a live Admin stream');
    await brgy.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => dashboard.evaluate(id => window.testNotificationEvents.filter(event => event.reportId === id).length, item.id)).toBe(1);
    await expect(dashboard.locator('#adminActivityBadge')).toBeVisible();
    await expect(adminTab.locator('#adminActivityBadge')).toBeVisible();
    await dashboard.locator('#adminActivityBell').click();
    await dashboard.locator('#adminActivityMarkAll').click();
    await expect(dashboard.locator('#adminActivityBadge')).toBeHidden();
    await expect(adminTab.locator('#adminActivityBadge')).toBeHidden();
    await dashboard.keyboard.press('Escape');
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    await dashboard.route('**/api/notifications/stream-ticket', async route => { await paused; await route.continue(); });
    try {
      await dashboard.evaluate(() => { window.testStaffStream.close(); window.testStaffStream.dispatchEvent(new Event('error')); });
      await brgy.locator('.rd-message-form textarea').fill('Barangay reply sent while the Admin stream is offline');
      await brgy.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(brgy.locator('.rd-coordination-messages')).toContainText('Barangay reply sent while the Admin stream is offline');
    } finally { release(); }
    await expect(dashboard.locator('#adminActivityBadge')).toBeVisible({ timeout: 15000 });
    await dashboard.locator('#adminActivityBell').click();
    await expect(dashboard.locator('#adminActivityList').locator(target)).toHaveCount(2);
    const adminNotice = dashboard.locator('#adminActivityList .unread').locator(target);
    await expect(adminNotice).toHaveCount(1);
    await adminNotice.click();
    await expect(dashboard.locator('#report-conversation')).toBeFocused();
    await expect(dashboard.locator('.rd-coordination-messages')).toContainText('Barangay reply sent while the Admin stream is offline');
    await dashboard.goto('/admin.html');
    await dashboard.locator('#adminActivityBell').click();
    await expect(dashboard.locator('#adminActivityList .unread').locator(target)).toHaveCount(0);
    await brgy.goto('/barangay.html');
    await brgyBell.click();
    await expect(brgyList.locator(target).locator('..')).not.toHaveClass(/unread/);
    await dashboard.waitForFunction(() => window.testStaffStream?.readyState === EventSource.OPEN);
    await brgy.goto(`/report-details.html?id=${firstContact.id}`);
    await expect(brgy.locator('.rd-coordination-messages')).toContainText('No internal messages yet');
    await brgy.locator('.rd-message-form textarea').fill('First message from Barangay on a new report');
    await brgy.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => dashboard.evaluate(id => window.testNotificationEvents.filter(event => event.reportId === id).length, firstContact.id)).toBe(1);
    await expect(dashboard.locator('#adminActivityBadge')).toBeVisible();
    await dashboard.locator('#adminActivityList a[href="report-details.html?id=' + firstContact.id + '#report-conversation"]').click();
    await expect(dashboard.locator('#report-conversation')).toBeFocused();
    await expect(dashboard.locator('.rd-coordination-messages')).toContainText('First message from Barangay on a new report');
  } finally {
    await Promise.all([barangayContext.close(), adminContext.close(), outsideContext.close()]);
  }
});

async function refreshData(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('reports:mutation', { detail: { phase: 'saved', id: new URL(location.href).searchParams.get('id') } })));
}

test('Barangay confirms a possible duplicate while Citizen and Admin receive monitoring views', async ({ page, baseURL, request }) => {
  const first = await report(baseURL), second = await report(baseURL);
  await open(page, official, first.id);
  const section = page.locator('.rd-incident-review');
  await expect(section).toContainText('Possible duplicate review');
  await section.getByText('Possible duplicate review', { exact: true }).click();
  await section.getByLabel('Possible incident report').selectOption(String(second.id));
  await section.getByLabel('Inspection decision').selectOption('confirmed');
  await section.getByLabel('Review reason').first().fill('Inspection confirmed the same unresolved damage in both submitted reports.');
  await section.getByRole('button', { name: 'Save duplicate review', exact: true }).click();
  await expect(section).toContainText(`Linked to incident report #${second.id}`);
  const progress = await request.get(`/api/reports/${first.id}/incident-review`, { headers: { Authorization: `Bearer ${owner.token}` } });
  expect(progress.status()).toBe(200); expect((await progress.json()).incident.canonicalReportId).toBe(second.id);
  const citizenPage = await page.context().newPage(); await open(citizenPage, owner, first.id);
  await expect(citizenPage.locator('.rd-incident-review')).toContainText('Your original report remains pending');
  await expect(citizenPage.locator('.rd-incident-review :is(form, details), .rd-message-form, .rd-severity, .rd-operational-actions')).toHaveCount(0);
  const adminPage = await page.context().newPage(); await open(adminPage, admin, first.id);
  await expect(adminPage.locator('.rd-incident-review')).toContainText(`Linked to incident report #${second.id}`);
  await expect(adminPage.getByText('Correct report jurisdiction', { exact: true })).toHaveCount(0);
  await expect(adminPage.locator('.rd-review-form, .rd-severity')).toHaveCount(0);
  await citizenPage.close(); await adminPage.close();

});

test('Admin suppresses only the missing-incident-setup card while keeping genuine errors visible', async ({ page, baseURL }) => {
  const item = await report(baseURL); await open(page, admin, item.id);
  await expect(page.locator('.rd-incident-review')).toBeHidden();
  await page.route(`**/api/reports/${item.id}/incident-review`, route => route.fulfill({ status: 503, json: {
    code: 'INCIDENT_REVIEW_NOT_READY', error: 'Incident and routing review requires database migration 017. Contact the installation operator.'
  } }));
  const dependency = page.waitForResponse(response => response.url().endsWith(`/api/reports/${item.id}/incident-review`) && response.status() === 503);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('reports:mutation', { detail: { phase: 'saved', id: String(id) } })), item.id);
  await dependency;
  await expect(page.locator('.rd-incident-review')).toBeHidden();
  await expect(page.getByText(/requires database migration 017/)).not.toBeVisible();
  await expect(page.locator('.rd-message-form')).toBeVisible();
  expect(await page.locator('.rd-incident-review').evaluate(node => node.getBoundingClientRect().height)).toBe(0);
  await page.unroute(`**/api/reports/${item.id}/incident-review`);
  await page.route(`**/api/reports/${item.id}/incident-review`, route => route.fulfill({ status: 500, json: { error: 'Controlled incident service failure.' } }));
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('reports:mutation', { detail: { phase: 'saved', id: String(id) } })), item.id);
  await expect(page.locator('.rd-incident-review')).toBeHidden();
  await expect(page.locator('.rd-incident-error')).toHaveText('Controlled incident service failure.');
  await expect(page.locator('.rd-incident-error')).toBeVisible();
  await expect(page.locator('.rd-incident-review form, .rd-review-form, .rd-severity')).toHaveCount(0);
  await page.unroute(`**/api/reports/${item.id}/incident-review`);
  const recovered = page.waitForResponse(response => response.url().endsWith(`/api/reports/${item.id}/incident-review`) && response.status() === 200);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('reports:mutation', { detail: { phase: 'saved', id: String(id) } })), item.id);
  await recovered;
  await expect(page.locator('.rd-incident-error')).toHaveCount(0);
  await expect(page.locator('.rd-incident-review')).toBeHidden();
});

test('ordinary Admin does not get an incident panel for routing history without a linked incident', async ({ page, request, baseURL }) => {
  const item = await report(baseURL);
  const flag = await request.post(`/api/reports/${item.id}/routing-flags`, { headers: { Authorization: `Bearer ${official.token}` }, data: {
    reason: 'Inspection requests verified jurisdiction review for the recorded location.', evidenceImageIds: [item.images[0].id], expectedRoutingVersion: 0, requestKey: randomUUID()
  } });
  expect(flag.status()).toBe(200);
  await open(page, admin, item.id);
  const response = await request.get(`/api/reports/${item.id}/incident-review`, { headers: { Authorization: `Bearer ${admin.token}` } });
  const data = await response.json(); expect(data.incident).toBeNull(); expect(data.canAssignJurisdiction).toBe(false); expect(data.history.length).toBeGreaterThan(0);
  await expect(page.locator('.rd-incident-review')).toBeHidden();
  await expect(page.locator('.rd-review-form, .rd-severity, .rd-incident-review form')).toHaveCount(0);
});

test('automatic discussion updates preserve existing rows, draft focus and scroll without a Refresh button', async ({ page, request, baseURL }) => {
  await page.clock.install();
  const item = await report(baseURL), headers = { Authorization: `Bearer ${admin.token}` };
  const post = await require('../support/publication').approvePublication(baseURL, item.id, admin, owner);
  for (let index = 0; index < 3; index++) expect((await request.post(`/api/reports/${item.id}/messages`, { headers, data: {
    body: `Initial message ${index}\n${'Inspection detail.\n'.repeat(20)}`, requestKey: randomUUID()
  } })).status()).toBe(200);
  expect((await request.post(`/api/community/posts/${post.id}/comments`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { body: 'Initial public comment.', requestKey: randomUUID() } })).status()).toBe(200);
  await open(page, admin, item.id);
  await expect(page.locator('.rd-coordination-message')).toHaveCount(3);
  await expect(page.locator('.rd-citizen-comment')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  const firstMessage = await page.locator('.rd-coordination-message').first().elementHandle();
  const firstComment = await page.locator('.rd-citizen-comment').first().elementHandle();
  await page.locator('.rd-message-form textarea').fill('Keep this unfinished draft while updates arrive.');
  await page.locator('.rd-coordination-messages').evaluate(node => { node.scrollTop = 32; });
  await page.clock.runFor(10050);
  expect((await request.post(`/api/reports/${item.id}/messages`, { headers: { Authorization: `Bearer ${official.token}` }, data: { body: 'Automatic incoming Barangay update.', requestKey: randomUUID() } })).status()).toBe(200);
  expect((await request.post(`/api/community/posts/${post.id}/comments`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { body: 'Automatic new public comment.', requestKey: randomUUID() } })).status()).toBe(200);
  await expect.poll(async () => {
    await page.clock.runFor(10000);
    return Promise.all([page.locator('.rd-coordination-message').count(), page.locator('.rd-citizen-comment').count()]);
  }).toEqual([4, 2]);
  expect(await firstMessage.evaluate(node => node.isConnected)).toBe(true);
  expect(await firstComment.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator('.rd-message-form textarea')).toHaveValue('Keep this unfinished draft while updates arrive.');
  await expect(page.locator('.rd-message-form textarea')).toBeFocused();
  expect(await page.locator('.rd-coordination-messages').evaluate(node => node.scrollTop)).toBe(32);
});

test('full regression visual matrix covers staff roles, all statuses, six widths and both themes', async ({ page, baseURL, request }, info) => {
  test.setTimeout(240000);
  const fs = require('node:fs/promises');
  const directory = '.data/qa-full-2026-10-27/visual'; await fs.mkdir(directory, { recursive: true });
  const registration = await request.post('/__fixture_citizen', { data: { username: `matrix_${randomUUID().slice(0, 8)}`, password: 'VisualFixture1234', barangay: 'Villamonte' } });
  expect(registration.status()).toBe(201); const citizen = await registration.json();
  const worker = await createOfficial(baseURL, admin.token, 'Villamonte', 'matrix_staff');
  const diagnostics = { exceptions: [], consoleErrors: [], failedRequests: [], serverErrors: [], layouts: [] };
  page.on('pageerror', error => diagnostics.exceptions.push(error.message));
  page.on('console', message => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => diagnostics.failedRequests.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText }));
  page.on('response', response => { if (response.url().startsWith(baseURL) && response.status() >= 500) diagnostics.serverErrors.push({ url: response.url(), status: response.status() }); });
  for (const status of ['pending', 'ongoing', 'resolved', 'rejected']) {
    const item = await report(baseURL, true, citizen), headers = { Authorization: `Bearer ${worker.token}` };
    if (['ongoing', 'resolved'].includes(status)) expect((await request.patch(`/api/reports/${item.id}/status`, { headers, data: { status: 'ongoing', requestKey: randomUUID() } })).status()).toBe(200);
    if (status === 'resolved') expect((await request.patch(`/api/reports/${item.id}/status`, { headers, multipart: { status, note: 'Completed repair with verified completion evidence.', requestKey: randomUUID(), images: { name: 'proof.png', mimeType: 'image/png', buffer: PNG_BYTES } } })).status()).toBe(200);
    if (status === 'rejected') expect((await request.patch(`/api/reports/${item.id}/status`, { headers, data: { status, note: 'Inspection established this report is ineligible for action.', requestKey: randomUUID() } })).status()).toBe(200);
    for (const [role, actor] of [['admin', admin], ['barangay', worker]]) {
      await open(page, actor, item.id);
      await expect(page.locator('[data-review-feedback]')).toHaveText('');
      await expect(page.locator('.rd-status strong')).toHaveText(status[0].toUpperCase() + status.slice(1));
      if (role === 'admin' || ['resolved', 'rejected'].includes(status)) await expect(page.locator('.rd-review-form')).toHaveCount(0);
      else await expect(page.locator('.rd-review-form')).toBeVisible();
      await expect(page.locator('.rd-damage-assessment [data-current-classification]')).toHaveText('Not assessed');
      await expect(page.locator('.rd-severity-form')).toHaveCount(
        role === 'barangay' ? 1 : 0);
      for (const theme of ['light', 'dark']) for (const width of [390, 768, 1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => window.PortalTheme.setPreference(value), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        if (width >= 1280) {
          const bounds = await page.locator('.rd-staff-top').evaluate(node => [...node.querySelectorAll('.rd-photo, .rd-summary, .rd-description-section, .rd-location')].map(item => { const { top, bottom } = item.getBoundingClientRect(); return { top, bottom }; }));
          const rows = role === 'barangay' ? [bounds.slice(0, 3), bounds.slice(3)] : [bounds];
          expect(rows.map(row => row.length)).toEqual(role === 'barangay' ? [3, 2] : [4]);
          for (const row of rows) {
            expect(Math.max(...row.map(box => box.top)) - Math.min(...row.map(box => box.top))).toBeLessThan(2);
            expect(Math.max(...row.map(box => box.bottom)) - Math.min(...row.map(box => box.bottom))).toBeLessThan(2);
          }
          if (role === 'barangay') expect(rows[1][0].top).toBeGreaterThan(rows[0][0].bottom);
        }
        diagnostics.layouts.push({ role, status, theme, width, overflow }); expect(overflow).toBe(false);
        await page.screenshot({ path: `${directory}/${info.project.name}-${role}-${status}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
  await fs.writeFile(`${directory}/${info.project.name}-diagnostics.json`, JSON.stringify(diagnostics, null, 2));
  expect(diagnostics.exceptions).toEqual([]); expect(diagnostics.serverErrors).toEqual([]);
});

test('Barangay flags incorrect routing with report evidence without transferring the report', async ({ page, baseURL, request }) => {
  const item = await report(baseURL); await open(page, official, item.id);
  const section = page.locator('.rd-incident-review');
  await section.getByText('Flag incorrect jurisdiction', { exact: true }).click();
  const form = section.locator('form').filter({ has: page.getByRole('button', { name: 'Request jurisdiction review', exact: true }) });
  await form.getByLabel('Review reason').fill('The recorded location requires a verified administrative jurisdiction review.');
  await form.getByLabel(`Supporting location photos for report #${item.id}`).selectOption({ index: 0 });
  await form.getByRole('button', { name: 'Request jurisdiction review', exact: true }).click();
  await expect(section).toContainText('jurisdiction flagged');
  const loaded = await request.get(`/api/reports/${item.id}`, { headers: { Authorization: `Bearer ${official.token}` } }); expect(loaded.status()).toBe(200); expect((await loaded.json()).barangay).toBe('Villamonte');
});

test('background report refresh updates Citizen incident progress without changing the original report', async ({ page, baseURL, request }) => {
  const first = await report(baseURL), second = await report(baseURL);
  await open(page, owner, first.id);
  await expect(page.locator('.rd-incident-review')).toBeHidden();
  const saved = await request.post(`/api/reports/${first.id}/duplicate-review`, { headers: { Authorization: `Bearer ${official.token}` }, data: {
    targetReportId: second.id, decision: 'confirmed', reason: 'Inspection confirmed both submissions describe the same physical damage.',
    expectedIncidentVersion: 0, expectedTargetIncidentVersion: 0, requestKey: randomUUID()
  } });
  expect(saved.status()).toBe(200);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('reports:mutation', { detail: { phase: 'saved', id: String(id) } })), first.id);
  await expect(page.locator('.rd-incident-review')).toBeVisible();
  await expect(page.locator('.rd-incident-review')).toContainText(`Linked to incident report #${second.id}`);
  await expect(page.locator('.rd-status')).toContainText('Pending');
});

test('Automatic refresh queued during a citizen comment request reloads the latest persisted thread', async ({ page, baseURL, request }) => {
  const item = await report(baseURL);
  const post = await require('../support/publication').approvePublication(baseURL, item.id, admin, owner);
  const added = await request.post(`/api/community/posts/${post.id}/comments`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { body: 'Comment removed while staff refresh is in flight.', requestKey: randomUUID() } });
  expect(added.status()).toBe(200); const comment = (await added.json()).comment;
  await open(page, admin, item.id);
  await expect(page.locator('.rd-citizen-comment')).toHaveCount(1);
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), received = new Promise(resolve => { started = resolve; });
  await page.route(`**/api/reports/${item.id}/citizen-comments`, async route => {
    const response = await route.fetch(); started(); await held; await route.fulfill({ response });
  }, { times: 1 });
  await refreshData(page); await received;
  const removed = await request.delete(`/api/community/posts/${post.id}/comments/${comment.id}`, { headers: { Authorization: `Bearer ${owner.token}` } }); expect(removed.status()).toBe(200);
  await refreshData(page); release();
  await expect(page.locator('.rd-citizen-comment-list')).toHaveText('No citizen comments yet.');
});

test('lost message acknowledgement retries the same request without duplicate persistence', async ({ page, baseURL }) => {
  const item = await report(baseURL); await open(page, admin, item.id);
  await expect(page.locator('[data-review-feedback]')).toHaveText('');
  await page.route(`**/api/reports/${item.id}/messages`, async route => {
    const saved = await route.fetch(); expect(saved.status()).toBe(200);
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled lost acknowledgement.' }) });
  }, { times: 1 });
  await page.locator('.rd-message-form textarea').fill('Preserve this message exactly once after a lost acknowledgement.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('[data-review-feedback]')).toContainText('Controlled lost acknowledgement.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.rd-coordination-message')).toHaveCount(1);
  await page.reload(); await expect(page.locator('.rd-coordination-message')).toHaveCount(1);
});

test('staff proof selection reuses EvidenceZoom and rejection requires a confirmed reason', async ({ page, request, baseURL }, info) => {
  const item = await report(baseURL); await open(page, official, item.id);
  if (!await page.locator('.rd-staff-tools').evaluate(element => element.open)) await page.locator('.rd-staff-tools > summary').click();
  const form = page.locator('.rd-review-form');
  const chooser = page.waitForEvent('filechooser'); await form.getByRole('button', { name: 'Choose action photos', exact: true }).click();
  await (await chooser).setFiles([{ name: 'action.png', mimeType: 'image/png', buffer: PNG_BYTES }]);
  const preview = form.getByRole('button', { name: 'Enlarge selected action photo 1', exact: true });
  await expect.poll(() => preview.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await preview.click(); await expect(page.getByRole('dialog', { name: 'Evidence photo' })).toBeVisible();
  await page.keyboard.press('Escape'); await form.getByRole('button', { name: 'Remove action photo 1', exact: true }).click();
  await expect(form.locator('.rd-selected-proof')).toHaveCount(0);
  await form.getByRole('button', { name: 'Reject report', exact: true }).click();
  await expect(form.locator('[role="status"]')).toContainText('at least 10 characters');
  await form.locator('textarea[name="note"]').fill('Duplicate incident already covered by another verified report.');
  await form.getByRole('button', { name: 'Reject report', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reject report?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.rd-status')).toContainText('Pending');
  await form.getByRole('button', { name: 'Reject report', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reject report?' }).getByRole('button', { name: 'Reject report', exact: true }).click();
  await expect(page.locator('.rd-status')).toContainText('Rejected');
  await expect(page.locator('.rd-timeline')).toContainText('Duplicate incident already covered');
  await expect(page.locator('.rd-review-form')).toHaveCount(0);
  const notifications = await request.get('/api/notifications', { headers: { Authorization: `Bearer ${owner.token}` } });
  expect(JSON.stringify(await notifications.json())).toContain('Duplicate incident already covered');
  await page.screenshot({ path: `.data/remediation-2026-10-26/rejected-${info.project.name}.png`, fullPage: true });
});

test('Admin and assigned Barangay exchange escaped internal messages while Citizen has no access', async ({ page, browser, request, baseURL }) => {
  const item = await report(baseURL); await open(page, admin, item.id);
  await expect(page.locator('[data-review-feedback]')).toHaveText('');
  const text = '<img src=x onerror="window.reviewInjected=true"> Please inspect this report.';
  await page.locator('.rd-message-form textarea').fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.rd-coordination-messages')).toContainText(text);
  await expect(page.locator('.rd-coordination-messages img')).toHaveCount(0);
  const context = await browser.newContext({ baseURL }); const staff = await context.newPage();
  try {
    await open(staff, official, item.id);
    await expect(staff.locator('.rd-coordination-messages')).toContainText(text);
    await staff.locator('.rd-message-form textarea').fill('Inspection scheduled by the assigned Barangay.');
    await staff.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(staff.locator('.rd-coordination-messages')).toContainText('Inspection scheduled');
    await refreshData(page);
    await expect(page.locator('.rd-coordination-message')).toHaveCount(2);
    expect(await page.evaluate(() => window.reviewInjected)).toBeUndefined();
  } finally { await context.close(); }
  expect((await request.get(`/api/reports/${item.id}/review`, { headers: { Authorization: `Bearer ${outside.token}` } })).status()).toBe(403);
  await open(page, owner, item.id);
  await expect(page.locator('.rd-workflow-grid')).toHaveCount(0);
  expect((await request.get(`/api/reports/${item.id}/review`, { headers: { Authorization: `Bearer ${owner.token}` } })).status()).toBe(403);
});

test('Barangay operates an unassessed report without creating a severity assessment', async ({ page, request, baseURL }) => {
  const proofs = [];
  for (const [index, buffer] of [PNG_BYTES, JPEG_BYTES].entries()) {
    const preview = await request.post('/api/ai/damage', { headers: { Authorization: `Bearer ${owner.token}` }, multipart: {
      photoOrder: String(index + 1), images: { name: index ? 'two.jpg' : 'one.png', mimeType: index ? 'image/jpeg' : 'image/png', buffer }
    } });
    expect(preview.status()).toBe(200); proofs.push((await preview.json()).assessmentProof);
  }
  const item = await report(baseURL, false, owner, proofs), assessments = [];
  page.on('request', value => { if (new URL(value.url()).pathname.endsWith('/severity')) assessments.push(value.url()); });
  await open(page, official, item.id);
  await expect(page.locator('[data-review-feedback]')).toHaveText('');
  await expect(page.locator('.rd-damage-assessment [data-current-classification]')).toHaveText('Not assessed');
  await expect(page.getByRole('button', { name: 'Save assessment', exact: true })).toBeVisible();
  await expect(page.locator('.rd-summary')).toContainText('Reported Damage');
  await expect(page.locator('.rd-summary')).toContainText('Original YOLO prediction');
  await expect(page.locator('.rd-summary')).toContainText('Pothole');
  await expect(page.locator('.rd-summary')).toContainText('Original AI confidence');
  await expect(page.locator('.rd-summary')).toContainText('90%');
  const initial = await request.get(`/api/reports/${item.id}`, { headers: { Authorization: `Bearer ${official.token}` } });
  expect(initial.status()).toBe(200); const original = await initial.json(); expect(original.ai_classification).toBeNull();
  const form = page.locator('.rd-review-form');
  await expect(form.getByRole('button', { name: 'Reject report', exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Mark ongoing', exact: true }).click();
  await expect(page.locator('.rd-status')).toContainText('Ongoing');
  const ongoing = page.locator('.rd-review-form');
  await ongoing.getByRole('button', { name: 'Resolve report', exact: true }).click();
  await expect(ongoing.locator('[role="status"]')).toContainText('Add an action description and at least one completion photo.');
  await ongoing.locator('textarea[name="note"]').fill('Completed repair with the required completion evidence.');
  await ongoing.locator('input[type="file"]').setInputFiles({ name: 'completion.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(ongoing.locator('.rd-selected-proof')).toHaveCount(1);
  await ongoing.getByRole('button', { name: 'Resolve report', exact: true }).click();
  await expect(page.locator('.rd-status')).toContainText('Resolved');
  await expect(page.locator('.rd-review-form')).toHaveCount(0);
  await expect(page.locator('.rd-damage-assessment [data-current-classification]')).toHaveText('Not assessed');
  const saved = await request.get(`/api/reports/${item.id}`, { headers: { Authorization: `Bearer ${official.token}` } });
  const current = await saved.json(); expect(current.ai_classification).toBeNull(); expect(current.ai_priority).toBeNull();
  expect(current.originalAi).toEqual(original.originalAi); expect(current.ai_confidence).toBe(original.ai_confidence);
  const history = await request.get(`/api/reports/${item.id}/history`, { headers: { Authorization: `Bearer ${official.token}` } });
  const events = (await history.json()).history;
  expect(events.map(value => value.new_status)).toEqual(['ongoing', 'resolved']);
  expect(events.at(-1).proofs).toHaveLength(1); expect(assessments).toEqual([]);
});

test('existing severity history survives report viewing and refresh', async ({ page, request, baseURL }) => {
  const item = await report(baseURL), headers = { Authorization: `Bearer ${official.token}` };
  const saved = await request.post(`/api/reports/${item.id}/severity`, { headers, data: {
    category: 'pothole', classification: 'MAJOR', evidence: { safety_impact: 'Historical inspected obstruction recorded before UI removal.' },
    reason: 'Preserve the existing historical reviewer assessment.', expectedReviewId: 0, requestKey: randomUUID()
  } });
  expect(saved.status()).toBe(200);
  const before = (await saved.json()).severityHistory;
  await open(page, official, item.id); await expect(page.locator('[data-review-feedback]')).toHaveText('');
  await expect(page.locator('.rd-damage-assessment [data-current-classification]')).toHaveText('Major');
  await refreshData(page);
  await page.reload(); await expect(page.locator('[data-review-feedback]')).toHaveText('');
  const loaded = await request.get(`/api/reports/${item.id}/review`, { headers });
  expect((await loaded.json()).severityHistory).toEqual(before);
  await page.getByText('Severity review history (1)').click();
  await expect(page.locator('.rd-severity-history')).toContainText('Preserve the existing historical reviewer assessment.');
});

test('staff see signed visual observations on the saved report @severity', async ({ page, baseURL, request }) => {
  await request.post('/__phase2_mode', { data: { mode: 'pothole' } });
  const headers = { Authorization: `Bearer ${owner.token}` };
  function photos() {
    const body = new FormData();
    [JPEG_BYTES, SECOND_JPEG_BYTES].forEach((bytes, i) => body.append('images', new Blob([bytes], { type: 'image/jpeg' }), `view-${i}.jpg`));
    return body;
  }
  const capture = photos();
  capture.append('assessment', 'pair');
  const scan = await fetch(baseURL + '/api/ai/damage', { method: 'POST', headers, body: capture });
  expect(scan.status).toBe(200);
  const pair = await scan.json();
  const body = photos();
  body.append('assessmentProofs', JSON.stringify(pair.photos.map(p => p.assessmentProof)));
  body.append('description', 'Controlled visual observation fixture');
  body.append('barangay', 'Villamonte');
  addReportGps(body, 'Villamonte');
  body.append('citizenCategory', 'Road Damage');
  const response = await fetch(baseURL + '/api/reports', { method: 'POST', headers, body });
  expect(response.status).toBe(201);
  const item = await response.json();
  for (const user of [official, admin]) {
    await open(page, user, item.id);
    const panel = page.locator('.rd-damage-assessment');
    await expect(panel.locator('.visual-extent')).toContainText('5% of the detection crop');
    await expect(panel.locator('[data-current-classification]')).toHaveText('Not assessed');
    await expect(panel.locator('form')).toHaveCount(user === official ? 1 : 0);
  }
});

test('Barangay confirms and corrects severity while Admin and Citizen see the saved result @severity', async ({ page, context, baseURL }) => {
  const item = await report(baseURL, true);
  await open(page, official, item.id);
  const panel = page.locator('.rd-damage-assessment');
  const form = panel.locator('form');
  await expect(panel.locator('[data-current-classification]')).toHaveText('Not assessed');
  for (const [classification, label, priority] of [['MAJOR', 'Major', 'Critical'], ['MINOR', 'Minor', 'Medium']]) {
    await form.getByLabel('Damage type').selectOption('pothole');
    await form.getByLabel('Classification').selectOption(classification);
    await form.getByLabel('Priority').selectOption(priority);
    await form.getByLabel('Measured depth (mm)').fill('22.5');
    await form.getByLabel('Observed safety impact').fill('Observed road damage during a controlled inspection.');
    await form.getByLabel('Reviewer reason').fill(`Recorded a ${label} classification for the controlled inspection.`);
    await form.getByRole('button', { name: 'Save assessment' }).click();
    await expect(panel.locator('[data-current-classification]')).toHaveText(label);
    await expect(panel.locator('[data-current-priority]')).toHaveText(priority);
    await expect(panel.locator('[data-barangay-review]')).toHaveText('Confirmed');
  }
  await page.getByText('Severity review history (2)').click();
  await expect(panel.locator('details')).toContainText('Major (Critical) → Minor (Medium)');
  await expect(panel.locator('details')).toContainText('Measured depth (mm): 22.5');
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (const user of [admin, owner]) {
    const viewer = await context.newPage();
    try {
      await open(viewer, user, item.id);
      const severity = viewer.locator('.rd-damage-assessment');
      await expect(severity.locator('[data-current-classification]')).toHaveText('Minor');
      await expect(severity.locator('[data-barangay-review]')).toHaveText('Confirmed');
      await expect(severity.locator('form')).toHaveCount(0);
      if (user === admin) await expect(severity.getByText('Severity review history (2)')).toBeVisible();
      else await expect(severity.locator('.rd-severity-history')).toHaveCount(0);
    } finally { await viewer.close(); }
  }
});

for (const role of ['admin', 'barangay']) test(`${role} matches the required report overview and persists real public comments and private conversation`, async ({ page, request, baseURL }, info) => {
  const item = await report(baseURL, true), token = { Authorization: `Bearer ${admin.token}` }, ownerHeaders = { Authorization: `Bearer ${owner.token}` };
  const moderation = `/api/admin/community-publications/${item.id}`;
  const detail = await request.get(moderation, { headers: token }); expect(detail.status()).toBe(200);
  const publication = (await detail.json()).publication;
  const decision = await request.post(moderation + '/decision', { headers: token, data: { state: 'approved', version: publication.version } }); expect(decision.status()).toBe(200);
  const posts = await request.get('/api/community/posts', { headers: ownerHeaders });
  const post = (await posts.json()).posts.find(post => post.linkedReport?.id === item.id); expect(post).toBeTruthy();
  const citizenComments = [];
  for (const body of ['Residents reported an unsafe crack near the public road.', 'Please provide an inspection update for this location.', '<img src=x onerror="window.commentInjected=true"> Literal citizen comment.']) {
    const added = await request.post(`/api/community/posts/${post.id}/comments`, { headers: ownerHeaders, data: { body, requestKey: randomUUID() } }); expect(added.status()).toBe(200); citizenComments.push((await added.json()).comment);
  }
  const reply = await request.post(`/api/community/posts/${post.id}/comments`, { headers: ownerHeaders, data: {
    body: 'Reply from a resident following the same public discussion.', parentCommentId: citizenComments[1].id, requestKey: randomUUID()
  } });
  expect(reply.status()).toBe(200);
  for (const [user, body] of [[admin, 'Good morning. Please check the status of this report.'], [official, 'The Barangay received this report and will schedule an inspection.'], [admin, 'Please share the inspection schedule when it is available.']]) {
    const sent = await request.post(`/api/reports/${item.id}/messages`, { headers: { Authorization: `Bearer ${user.token}` }, data: { body, requestKey: randomUUID() } }); expect(sent.status()).toBe(200);
  }
  await open(page, role === 'admin' ? admin : official, item.id);
  await expect(page.locator('.rd-citizen-comment')).toHaveCount(4);
  await expect(page.locator('.rd-coordination-message')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: role === 'admin' ? 'Message Barangay' : 'Message Admin', exact: true })).toBeVisible();
  await expect(page.locator('.rd-citizen-comments :is(textarea, input, [contenteditable], button:not([data-comments-earlier]))')).toHaveCount(0);
  expect(await page.evaluate(() => window.commentInjected)).toBeUndefined();
  if (role === 'admin') {
    await expect(page.locator('.rd-staff-tools, .rd-operational-actions, .rd-severity, .rd-summary, .rd-review-form')).toHaveCount(0);
    for (const status of ['ongoing', 'resolved', 'rejected']) expect((await request.patch(`/api/reports/${item.id}/status`, { headers: token, data: { status, note: 'Admin cannot change the Barangay workflow.' } })).status()).toBe(403);
    expect((await request.post(`/api/reports/${item.id}/severity`, { headers: token, data: { classification: 'MAJOR' } })).status()).toBe(403);
  } else await expect(page.locator('.rd-staff-tools')).toHaveAttribute('open', '');
  await page.setViewportSize({ width: 1733, height: 907 });
  const boxes = await page.locator('.rd-staff-top').evaluate(node => [...node.children].map(child => { const b = child.getBoundingClientRect(); return { x: b.x, y: b.y, bottom: b.bottom }; }));
  const rows = role === 'admin' ? [boxes] : [boxes.slice(0, 2), boxes.slice(2)];
  expect(rows.map(row => row.length)).toEqual(role === 'admin' ? [3] : [2, 2]);
  for (const row of rows) {
    for (let index = 1; index < row.length; index++) {
      expect(row[index].x).toBeGreaterThan(row[index - 1].x);
      expect(Math.abs(row[index].y - row[0].y)).toBeLessThan(2);
    }
  }
  if (role === 'barangay') expect(rows[1][0].y).toBeGreaterThan(rows[0][0].bottom);
  const bottom = await page.locator('.rd-staff-columns').evaluate(node => [...node.children].map(child => child.getBoundingClientRect().x)); expect(bottom[0]).toBeLessThan(bottom[1]);
  for (const width of [1733, 1440, 768, 375]) {
    await page.setViewportSize({ width, height: 907 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const meta = page.locator('.rd-citizen-comment.is-reply .rd-comment-meta');
    await expect(meta).toContainText(/^Reply\s+\S/);
    const gap = await meta.evaluate(node => {
      const label = node.querySelector('.rd-reply-label').getBoundingClientRect(), author = node.querySelector('strong').getBoundingClientRect();
      return Math.abs(label.top - author.top) < 8 ? author.left - label.right : author.top - label.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(3);

    if (width === 375) {
      await page.getByRole('button', { name: 'Next photo', exact: true }).click();
      await expect(page.locator('.rd-carousel-position')).toHaveText('Photo 2 of 2');
      await page.getByRole('button', { name: 'Previous photo', exact: true }).click();
      await expect(page.locator('.rd-carousel-position')).toHaveText('Photo 1 of 2');
    }
    await page.screenshot({ path: `.data/remediation-2026-10-26/reference-${role}-${info.project.name}-${width}.png`, fullPage: true });
  }
  const removed = await request.delete(`/api/community/posts/${post.id}/comments/${citizenComments[0].id}`, { headers: ownerHeaders }); expect(removed.status()).toBe(200);
  await refreshData(page);
  await expect(page.locator('.rd-citizen-comment')).toHaveCount(3);
  await expect(page.locator('.rd-citizen-comment-list')).not.toContainText('Residents reported an unsafe crack');
  await expect(page.locator('.rd-citizen-comment-list img[src="x"]')).toHaveCount(0);
  await page.locator('.rd-message-form textarea').fill('Additional follow-up from the reference layout.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.rd-coordination-message')).toHaveCount(4);
  await page.reload(); await expect(page.locator('.rd-coordination-message')).toHaveCount(4); await expect(page.locator('.rd-citizen-comment')).toHaveCount(3);
});
