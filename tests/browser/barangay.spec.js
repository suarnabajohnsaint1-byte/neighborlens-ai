const { addReportGps } = require('../support/citizens');
const { test, expect } = require('@playwright/test');
const { adminSession, createOfficial } = require('../support/accounts');
const { JPEG_BYTES, PNG_BYTES } = require('../support/image-fixtures');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const sharp = require('sharp');
const artifacts = path.join(os.tmpdir(), 'neighborlens-barangay-screenshots');
let admin, officialA, officialB, owner, outsideOwner, other, frontend, frontendBase;

async function createReport(base, barangay, description = 'Barangay browser evidence') {
  const body = new FormData();
  for (const [key, value] of Object.entries({ barangay, description })) body.append(key, value);
  addReportGps(body, barangay);
  body.append('images', new File([JPEG_BYTES], 'one.jpg', { type: 'image/jpeg' }));
  body.append('images', new File([PNG_BYTES], 'two.png', { type: 'image/png' }));
  const response = await fetch(base + '/api/reports', { method: 'POST', headers: { Authorization: `Bearer ${(barangay === 'Barangay 2' ? outsideOwner : owner).token}` }, body });
  expect(response.status).toBe(201);
  return response.json();
}

async function login(page, base) {
  await page.bringToFront();
  await page.goto(base + '/barangay-login.html');
  await page.locator('#roleLoginUser').fill(officialA.username);
  await page.locator('#roleLoginPass').fill(officialA.password);
  await page.locator('#roleLoginSubmit').click();
  await expect(page).toHaveURL(/barangay.html/);
  await page.waitForFunction(() => Boolean(window.BarangayPortal?.snapshot()));
  await page.waitForLoadState('load');
  officialA.token = await page.evaluate(() => getSession().apiToken);
}

async function navigate(page, label) {
  const menu = page.locator('#barangayMenu');
  if (await menu.isVisible()) await menu.click();
  await page.locator('#barangaySidebar').getByRole('link', { name: label, exact: true }).click();
}

test.beforeAll(async ({ baseURL }) => {
  admin = await adminSession(baseURL);
  officialB = await createOfficial(baseURL, admin.token, 'Barangay 2', 'browser_b');
  const response = await fetch(baseURL + '/__fixture_citizen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `browser_owner_${Date.now()}`, password: 'Fixture1234', barangay: 'Barangay 1' }) });
  owner = await response.json();
  const outside = await fetch(baseURL + '/__fixture_citizen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `browser_outside_${Date.now()}`, password: 'Fixture1234', barangay: 'Barangay 2' }) });
  expect(outside.status).toBe(201);
  outsideOwner = await outside.json();
  const app = express();
  app.use('/shared', express.static(path.resolve('shared')));
  app.use(express.static(path.resolve('frontend')));
  frontend = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  frontendBase = `http://127.0.0.1:${frontend.address().port}`;
});

test.afterAll(async () => { if (frontend) await new Promise(resolve => frontend.close(resolve)); });

test.beforeEach(async ({ page, baseURL }) => {
  officialA = await createOfficial(baseURL, admin.token, 'Barangay 1', 'browser_case');
  await page.route('http://127.0.0.1:3000/**', async route => {
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:3000', baseURL) });
    await route.fulfill({ response });
  });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('B01 B02: private evidence loads across origins without a public route or token URL', async ({ page, request, baseURL }) => {
  const report = await createReport(baseURL, 'Barangay 1');
  const photo = report.images[0].imagePath;
  expect((await request.get(photo)).status()).toBe(401);
  expect((await request.get(photo, { headers: { Authorization: `Bearer ${officialB.token}` } })).status()).toBe(403);
  const urls = [];
  page.on('request', request => urls.push(request.url()));
  await login(page, frontendBase);
  await expect.poll(() => page.locator(`[data-report-id="${report.id}"] [data-action="view"]`).count()).toBe(1);
  await page.locator(`[data-report-id="${report.id}"] [data-action="view"]`).click();
  const images = page.locator('#reportDetails img[data-evidence-url]');
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.evaluateAll(nodes => nodes.every(image => image.naturalWidth > 0 && image.src.startsWith('blob:')))).toBe(true);
  expect(urls.some(url => /[?&](token|access_token)=/.test(url))).toBe(false);
  expect(urls.some(url => new URL(url).pathname.startsWith('/uploads/'))).toBe(false);
  await page.locator('#backToReports').click();
  await expect(page).toHaveURL(/barangay\.html/);
  await expect(page.locator(`[data-report-id="${report.id}"] [data-action="view"]`)).toBeVisible();
  if (await page.locator('#barangayMenu').isVisible()) await page.locator('#barangayMenu').click();
  await page.locator('#portalLogout').click();
  await expect(page).toHaveURL(/barangay-login.html/);
  expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
});

test('B02: missing evidence has a stable failure and does not refetch the report list', async ({ page, baseURL }) => {
  const report = await createReport(baseURL, 'Barangay 1', 'Missing evidence fixture');
  await login(page, frontendBase);
  await expect.poll(() => page.locator(`[data-report-id="${report.id}"] [data-action="view"]`).count()).toBe(1);
  let renewals = 0, lists = 0;
  await page.route('**/api/reports/*/images/*', route => route.fulfill({ status: 404, json: { error: 'Missing image fixture' } }));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/reports/${report.id}`) renewals++;
    if (pathname === '/api/reports') lists++;
  });
  await page.locator(`[data-report-id="${report.id}"] [data-action="view"]`).click();
  await expect(page.locator('#reportDetails .evidence-unavailable')).toHaveCount(2);
  expect(renewals).toBe(1);
  expect(lists).toBe(0);
});

test('B03: a delayed list cannot revert a successful status mutation', async ({ page, baseURL }) => {
  const report = await createReport(baseURL, 'Barangay 1', 'Read mutation race');
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => window.BarangayPortal?.snapshot()?.status)).toBe('ready');
  await page.getByRole('button', { name: 'Split Detail view', exact: true }).click();
  await page.locator(`[data-report-id="${report.id}"] .report-card-title`).click();
  if (!await page.locator('.rm-detail-pane .rd-staff-tools').evaluate(element => element.open)) await page.locator('.rm-detail-pane .rd-staff-tools > summary').click();
  await expect(page.locator('.rm-detail-pane').getByRole('button', { name: 'Mark ongoing', exact: true })).toBeVisible();
  let release, arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('http://127.0.0.1:3000/api/reports?*', async route => {
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:3000', baseURL) });
    arrived(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  await page.evaluate(() => { window.oldList = BarangayPortal.refresh(); });
  await received;
  await page.locator('.rm-detail-pane').getByRole('button', { name: 'Mark ongoing', exact: true }).click();
  await expect.poll(() => page.evaluate(id => BarangayPortal.snapshot().data.reports.find(report => report.id === id)?.status, report.id)).toBe('ongoing');
  release();
  await page.evaluate(() => window.oldList);
  expect(await page.evaluate(id => BarangayPortal.snapshot().data.reports.find(report => report.id === id).status, report.id)).toBe('ongoing');
});

test('B04 B05 B06: unknown metadata, rejected status, canonical categories and Manila boundaries are accurate', async ({ page, request, baseURL }) => {
  await request.post('/__phase2_mode', { data: { mode: 'unavailable' } });
  const report = await createReport(baseURL, 'Barangay 1', 'Unknown metadata fixture');
  const rejected = await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${officialA.token}` }, data: { status: 'rejected', note: 'Incident is outside the verified report scope.' } });
  expect(rejected.status()).toBe(200);
  await request.post('/__phase2_mode', { data: { mode: 'pothole' } });
  await login(page, frontendBase);
  const row = page.locator(`[data-report-id="${report.id}"]`);
  await expect(row).toContainText('Unclassified');
  await expect(row).toContainText('Rejected');
  await row.locator('[data-action="view"]').click();
  await expect(page.locator('#reportDetails')).toContainText('Not available');
  await expect(page.locator('#reportDetails')).not.toContainText('80%');
  const selected = await page.evaluate(() => ['2026-10-14T17:00:00Z', '2026-10-15T15:59:59.500Z'].filter(value => {
    const range = ManilaDates.interval('2026-10-15', '2026-10-15');
    return Date.parse(value) >= range.start && Date.parse(value) < range.end;
  }).length);
  expect(selected).toBe(2);
  expect(await page.evaluate(() => ReportVocabulary.category('pothole'))).toBe('Road Damage');
});

test('B10: transient list failures retain truthful totals and expose Retry', async ({ page, baseURL }) => {
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => window.BarangayPortal?.snapshot()?.status)).toBe('ready');
  const total = await page.locator('#statTotal').innerText();
  await page.evaluate(() => document.getElementById('retryReports').addEventListener('click', () => { window.fixtureRetryClicked = true; }, { capture: true, once: true }));
  await page.route('http://127.0.0.1:3000/api/reports?*', async route => {
    if (!await page.evaluate(() => Boolean(window.fixtureRetryClicked))) return route.fulfill({ status: 503, json: { error: 'Fixture outage' } });
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:3000', baseURL) });
    await route.fulfill({ response });
  });
  await page.evaluate(() => BarangayPortal.refresh());
  await expect(page.locator('#statTotal')).toHaveText(total);
  await expect(page.locator('#reportLoadFeedback')).toContainText('last successful');
  await page.locator('#reportLoadFeedback').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#reportLoadFeedback')).toBeHidden();
});

test('B07 B08: Barangay full-page details retain permitted actions, synchronize and return to the list', async ({ page, request, baseURL }) => {
  const report = await createReport(baseURL, 'Barangay 1', 'Shared review fixture');
  await login(page, frontendBase);
  const opener = page.locator(`[data-report-id="${report.id}"] [data-action="view"]`);
  await opener.click();
  const dialog = page.locator('#reportDetails');
  await expect(dialog).toBeVisible();
  if (!await dialog.locator('.rd-staff-tools').evaluate(element => element.open)) await dialog.locator('.rd-staff-tools > summary').click();
  await expect(dialog.getByRole('button', { name: 'Mark ongoing' })).toBeVisible();
    await dialog.locator('.rd-review-form textarea').focus();
    await page.keyboard.press('Tab');
    expect(await dialog.locator('.rd-review-form').evaluate(element => element.contains(document.activeElement))).toBe(true);
    await dialog.locator('.rd-review-form textarea').fill('Disposable crew note');
  await dialog.getByRole('button', { name: 'Mark ongoing' }).click();
  await expect(dialog.locator('.rd-status')).toContainText('Ongoing');
  expect((await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${officialA.token}` }, multipart: {
    status: 'resolved', note: 'Completed repair', requestKey: require('node:crypto').randomUUID(),
    images: { name: 'completion.png', mimeType: 'image/png', buffer: PNG_BYTES }
  } })).status()).toBe(200);
  await page.reload();
  await expect(dialog.locator('.rd-status')).toContainText('Resolved');
  await expect(dialog.locator('.rd-review-form')).toHaveCount(0);
  await page.locator('#backToReports').click();
  await expect(opener).toBeVisible();
  const next = await createReport(baseURL, 'Barangay 1', 'Standalone Barangay actions');
  await page.goto(frontendBase + `/report-details.html?id=${next.id}`);
  if (!await page.locator('.rd-staff-tools').evaluate(element => element.open)) await page.locator('.rd-staff-tools > summary').click();
  await expect(page.locator('.rd-review-form')).toBeVisible();
});

test('B11: real pagination restores query, page and period; Local Reports restores all statuses', async ({ page, baseURL }) => {
  const term = `Pagination-${Date.now()}`;
  for (let index = 0; index < 14; index++) await createReport(baseURL, 'Barangay 1', `${term} fixture ${index}`);
  await createReport(baseURL, 'Barangay 2', 'Outside pagination fixture');
  await login(page, frontendBase);
  await page.getByRole('combobox', { name: 'Reports per page', exact: true }).selectOption('10');
  await page.locator('#reportSearch').fill(term);
  await expect(page.locator('#reportsPageInfo')).toHaveText('1-10 of 14 reports');
  await page.locator('#reportsNext').click();
  await expect(page.locator('#reportsPageInfo')).toHaveText('11-14 of 14 reports');
  const total = await page.locator('#statTotal').innerText();
  await navigate(page, 'Analytics');
  await page.locator('[data-analytics-days="7"]').click();
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  await page.reload();
  await expect(page).toHaveURL(/#analytics$/);
  await expect(page.locator('[data-analytics-days="7"]')).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(page.locator('#reportSearch')).toHaveValue(term);
  await expect(page.locator('#reportsPageInfo')).toHaveText('11-14 of 14 reports');
  await expect(page.locator('#statTotal')).toHaveText(total);
  await page.locator('[data-status-filter="resolved"]').click();
  await expect(page.locator('#reportsBody')).toContainText('No reports match');
  if (await page.locator('#barangayMenu').isVisible()) await page.locator('#barangayMenu').click();
  await page.locator('#barangaySidebar a[data-status="all"]').click();
  await expect(page.locator('#reportsPageInfo')).toHaveText('1-10 of 14 reports');
  const state = await page.evaluate(() => BarangayPortal.snapshot());
  expect(state.query.status).toBe('all');
  expect(state.data.reports.every(report => report.barangay === 'Barangay 1')).toBe(true);
});

test('shared Barangay charts reflect all assigned rows and refresh after an allowed transition without reload', async ({ page, request, baseURL }) => {
  const report = await createReport(baseURL, 'Barangay 1', 'Graph workflow report');
  await createReport(baseURL, 'Barangay 2', 'Graph workflow out-of-jurisdiction report');
  await login(page, frontendBase);
  await expect(page.locator('[data-analytics-overview]')).toHaveCount(0);
  await expect(page.locator('[data-analytics-totals]')).toBeHidden();
  await navigate(page, 'Analytics');
  await expect(page).toHaveURL(/#analytics$/);
  await expect(page.locator('#barangaySidebar a[href$="#analytics"]')).toHaveAttribute('aria-current', 'location');
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible();
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  const payload = await (await request.get('/api/reports/analytics?days=30', { headers: { Authorization: `Bearer ${officialA.token}` } })).json();
  const points = await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('reportTrendsChart')).getOption().series[0].data);
  expect(points).toEqual(payload.daily.map(day => day.submitted));
  await expect(page.locator('[data-analytics-total="submitted"]')).toHaveText(String(payload.totals.submitted));
  await expect(page.locator('[data-analytics-categories]')).toBeVisible();
  await expect(page.locator('[data-analytics-daily] tr')).toHaveCount(10);
  await navigate(page, 'Local Reports');
  await expect(page.locator('#barangayAnalytics')).toBeHidden();
  await page.locator('#reportSearch').fill('Graph workflow report');
  await page.getByRole('button', { name: 'Split Detail view', exact: true }).click();
  await page.locator(`[data-report-id="${report.id}"] .report-card-title`).click();
  if (!await page.locator('.rm-detail-pane .rd-staff-tools').evaluate(element => element.open)) await page.locator('.rm-detail-pane .rd-staff-tools > summary').click();
  await expect(page.locator('.rm-detail-pane').getByRole('button', { name: 'Resolve report', exact: true })).toBeVisible();
  let documents = 0;
  page.on('request', request => { if (request.resourceType() === 'document') documents++; });
  await page.evaluate(() => { window.savedDocument = document; });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reports/analytics' && response.ok());
  await page.locator('.rm-detail-pane textarea[name="note"]').fill('Completed repair');
  await page.locator('.rm-detail-pane input[type="file"]').setInputFiles({ name: 'completion.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await page.locator('.rm-detail-pane').getByRole('button', { name: 'Resolve report', exact: true }).click();
  await expect(page.locator('.rm-detail-pane .rd-status')).toContainText('Resolved');
  await page.getByRole('button', { name: 'Cards view', exact: true }).click();
  await expect(page.locator(`[data-report-id="${report.id}"] .report-card-status`)).toContainText('Resolved');
  const saved = await (await request.get(`/api/reports/${report.id}`, { headers: { Authorization: `Bearer ${officialA.token}` } })).json();
  expect(saved.status).toBe('resolved');
  const history = await (await request.get(`/api/reports/${report.id}/history`, { headers: { Authorization: `Bearer ${officialA.token}` } })).json();
  expect(history.history.some(entry => entry.new_status === 'resolved' || entry.newStatus === 'resolved')).toBe(true);
  expect((await request.get(`/api/reports/${report.id}`, { headers: { Authorization: `Bearer ${officialB.token}` } })).status()).toBe(403);
  await navigate(page, 'Analytics');
  const updated = await (await refreshed).json();
  expect(updated.totals.knownResolved).toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-analytics-total="resolved"]')).toHaveText(String(updated.totals.resolved));
  expect(documents).toBe(0);
  expect(await page.evaluate(() => savedDocument === document)).toBe(true);
});

test('B09: cards, charts, mobile filters and drawer fit 320, 375, 768, 1024 and 1440 in both themes', async ({ page, baseURL }, info) => {
  test.slow();
  const report = await createReport(baseURL, 'Barangay 1', 'Long content ' + 'infrastructure-condition-'.repeat(30));
  // Advance only the animation frames needed for layout, so the report poll cannot interrupt a render.
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  await navigate(page, 'Analytics');
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  await page.clock.runFor(32);
  await expect(page.locator('#barangayAnalytics canvas')).toHaveCount(2);
  await expect(page.locator('#reportCategoriesChart')).toHaveCSS('height', page.viewportSize().width <= 600 ? '190px' : '144px');
  expect(await page.locator('#reportCategoriesChart').evaluate(element => echarts.getInstanceByDom(element).getOption().series[0]))
    .toMatchObject({ barWidth: 8, showBackground: true });
  const chartStyle = page.getByRole('combobox', { name: 'Trend chart style' });
  await chartStyle.selectOption('bar');
  const pie = page.getByRole('group', { name: 'Category chart style' }).getByRole('button', { name: 'Pie' });
  await pie.click();
  await page.locator('.report-card-title').first().evaluate(element => {
    element.textContent = 'Long legacy infrastructure damage title '.repeat(12);
  });
  const reportReads = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/reports' || pathname === '/api/reports/analytics') reportReads.push(pathname);
  });
  await fs.mkdir(artifacts, { recursive: true });
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
      await page.clock.runFor(32);
      await expect.poll(() => page.locator('#reportTrendsChart').evaluate(element => echarts.getInstanceByDom(element).getWidth() === element.clientWidth)).toBe(true);
      await expect.poll(() => page.locator('#reportTrendsChart').evaluate(element => {
        const style = getComputedStyle(element);
        const series = echarts.getInstanceByDom(element).getOption().series;
        return series.every(item => item.type === 'bar') && series.map(item => [item.name, item.itemStyle.color]).slice(1).every(([name, color], index) =>
          name === ['Ongoing', 'Resolved'][index] && color === style.getPropertyValue(index === 0 ? '--report-indicator-yellow' : '--report-indicator-green').trim()) && series.length === 3;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const styleControl = await chartStyle.boundingBox();
      const periodControl = await page.getByRole('group', { name: 'Analytics period' }).boundingBox();
      expect(styleControl.y).toBe(periodControl.y);
      expect(styleControl.height).toBe(periodControl.height);
      await expect(pie).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => page.locator('#reportCategoriesChart').evaluate(element => {
        const options = echarts.getInstanceByDom(element).getOption();
        return options.series[0].type === 'pie' && !options.animation && !options.series[0].emphasis.scale;
      })).toBe(true);
      await expect(page.getByRole('list', { name: 'Category shares' })).toBeVisible();
      const screenshot = await page.locator('#reportTrendsChart').screenshot();
      expect(Math.max(...(await sharp(screenshot).stats()).channels.slice(0, 3).map(channel => channel.stdev))).toBeGreaterThan(1);
      await navigate(page, 'Local Reports');
      await expect(page.locator('#barangayAnalytics')).toBeHidden();
      const icons = page.locator('.portal-report-stat:not([data-metric="total"]) > .portal-report-stat-icon');
      expect(await icons.evaluateAll(elements => elements.map(icon => {
        const style = getComputedStyle(icon, '::before');
        return [style.getPropertyValue('--iconify-mask').includes('data:image/svg+xml'), style.backgroundColor === getComputedStyle(icon.parentElement.querySelector('.portal-report-stat-value')).color];
      }))).toEqual(Array.from({ length: 5 }, () => [true, true]));
      expect(await page.locator('#reportsBody').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(width <= 640 ? 1 : width <= 1100 ? 2 : 3);
      const card = page.locator('#reportsBody .report-card').first();
      await expect(card.locator('.report-card-title')).toHaveCSS('font-size', '14px');
      expect(await card.evaluate(node => getComputedStyle(node).borderRadius === getComputedStyle(node).getPropertyValue('--radius-md').trim())).toBe(true);
      await expect(card.locator('.mr-photo')).toHaveCSS('height', '200px');
      await expect(card.locator('.report-card-footer')).toHaveCSS('border-top-width', '0px');
      await expect(card.locator('.report-card-description')).toBeVisible();
      expect((await card.boundingBox()).height).toBeLessThanOrEqual(500);
      expect((await card.locator('.report-card-open').boundingBox()).height).toBeGreaterThanOrEqual(width <= 600 ? 36 : 44);
      await page.screenshot({ path: path.join(artifacts, `populated-${width}-${theme}-${info.project.name}.png`), fullPage: true });
      await navigate(page, 'Analytics');
      await expect(chartStyle).toHaveValue('bar');
      await expect(pie).toHaveAttribute('aria-pressed', 'true');
    }
    await navigate(page, 'Local Reports');
    if (width < 900) {
      await page.locator('#barangayMenu').click();
      await expect(page.locator('#barangaySidebar')).toHaveAttribute('aria-modal', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('#barangayMenu')).toBeFocused();
      await page.locator('[data-sheet-open="barangayFilters"]').click();
      await expect(page.locator('#barangayFilters')).toHaveAttribute('aria-modal', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-sheet-open="barangayFilters"]')).toBeFocused();
    }
    await navigate(page, 'Analytics');
  }
  expect(reportReads).toEqual([]);
  await navigate(page, 'Local Reports');
  await page.locator('#reportSearch').fill('No such long content fixture');
  await page.clock.runFor(300);
  await page.clock.resume();
  await expect(page.locator('#reportsBody')).toContainText('No reports match');
  await page.screenshot({ path: path.join(artifacts, `empty-${info.project.name}.png`), fullPage: true });
  await page.route('http://127.0.0.1:3000/api/reports?*', route => route.fulfill({ status: 503, json: { error: 'Fixture outage' } }));
  await page.evaluate(() => BarangayPortal.refresh());
  await expect(page.locator('#reportLoadFeedback')).toContainText('last successful');
  await page.screenshot({ path: path.join(artifacts, `error-${info.project.name}.png`), fullPage: true });
});

test('B11: repeated status navigation and browser history issue one bounded read per selection', async ({ page }) => {
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  const requests = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/reports') requests.push(url.searchParams.get('status')); });
  for (const status of ['pending', 'ongoing', 'resolved']) {
    await page.locator(`[data-status-filter="${status}"]`).click();
    await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  }
  expect(requests).toEqual(['pending', 'ongoing', 'resolved']);
  await page.goBack();
  await expect(page.locator('[data-status-filter="ongoing"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  expect(requests).toEqual(['pending', 'ongoing', 'resolved', 'ongoing']);
  await page.evaluate(() => dispatchEvent(new Event('DOMContentLoaded')));
  expect(requests).toHaveLength(4);
});

test('B10: first-load outages show Unavailable and access denial clears previously authorized rows', async ({ page }) => {
  let unavailable = true;
  await page.route('http://127.0.0.1:3000/api/reports?*', async route => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: 'Fixture outage' } });
    return route.fallback();
  });
  await login(page, frontendBase);
  await expect(page.locator('#statTotal')).toHaveText('Unavailable');
  await expect(page.locator('#barangayResolutionProgress')).toBeHidden();
  await expect(page.locator('#reportsBody')).toContainText('Report data unavailable');
  unavailable = false;
  await page.locator('#retryReports').click();
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  await expect(page.locator('#reportsBody .report-card').first()).toBeVisible();
  await page.route('http://127.0.0.1:3000/api/reports?*', route => route.fulfill({ status: 403, json: { error: 'Assignment revoked' } }));
  await page.evaluate(() => BarangayPortal.refresh());
  await expect(page.locator('#statTotal')).toHaveText('Unavailable');
  await expect(page.locator('#reportsBody .report-card')).toHaveCount(0);
  await expect(page.locator('#barangayResolutionProgress')).toBeHidden();
});

test('overall resolution progress stays scoped across filters, refresh and shared Admin cards', async ({ page, context, request, baseURL }, info) => {
  const report = await createReport(baseURL, 'Barangay 1', 'Shared compact card workflow');
  await createReport(baseURL, 'Barangay 2', 'Outside progress scope');
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  const initial = await page.evaluate(() => BarangayPortal.snapshot().data.stats);
  await expect(page.locator('#barangayResolutionProgress')).toHaveCount(0);
  await page.locator('#reportSearch').fill('No matching progress fixture');
  await expect(page.locator('#reportsBody')).toContainText('No reports match');
  await page.reload();
  await expect(page.locator('#reportsBody')).toContainText('No reports match');
  const result = await request.patch(`/api/reports/${report.id}/status`, {
    headers: { Authorization: `Bearer ${officialA.token}` }, multipart: {
      status: 'resolved', note: 'Isolated progress verification', requestKey: require('node:crypto').randomUUID(),
      images: { name: 'completion.png', mimeType: 'image/png', buffer: PNG_BYTES }
    }
  });
  expect(result.status()).toBe(200);
  await page.evaluate(() => BarangayPortal.refresh());
  await page.locator('#clearFilters').click();
  await expect(page.locator('#reportsBody .report-card').first()).toBeVisible();
  const adminPage = await context.newPage();
  await adminPage.addInitScript(({ session, apiBase }) => {
    sessionStorage.setItem('up_session', JSON.stringify(session));
    Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { get: () => apiBase, set() {} });
  }, { session: { ...admin.user, apiToken: admin.token }, apiBase: baseURL });
  await adminPage.goto(frontendBase + '/admin.html#reports');
  await expect(adminPage.locator('#adminResolutionProgress')).toHaveCount(0);
  await expect(adminPage.locator('#hierarchyGrid')).toHaveCount(0);
  await adminPage.locator('#adminSearch').fill('Shared compact card workflow');
  await adminPage.getByRole('button', { name: 'Cards view', exact: true }).click();
  const card = adminPage.locator(`#adminReportCards [data-report-id="${report.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.report-card-title')).toHaveCSS('font-size', '14px');
  await expect(card.locator('.mr-photo')).toHaveCSS('height', '200px');
  await expect(card.getByRole('button', { name: `Print report ${report.id}` })).toBeVisible();
  const details = card.getByRole('button', { name: `View details for report ${report.id}` });
  await expect.poll(() => card.locator('img').evaluate(image => image.naturalWidth > 0 && image.src.startsWith('blob:'))).toBe(true);
  for (const theme of ['light', 'dark']) {
    await adminPage.evaluate(theme => PortalTheme.setPreference(theme), theme);
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await fs.mkdir(artifacts, { recursive: true });
    await adminPage.screenshot({ path: path.join(artifacts, `shared-admin-cards-${theme}-${info.project.name}.png`), fullPage: true });
  }
  await details.click();
  await expect(adminPage.locator('#reportDetails .rd-status')).toBeVisible();
  await expect(adminPage).toHaveURL(/report-details\.html\?id=\d+$/);
  await adminPage.close();
});

test('analytics failure and Retry leave successful reports and summaries usable', async ({ page }) => {
  let unavailable = true;
  let listReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reports') listReads++; });
  await page.route('http://127.0.0.1:3000/api/reports/analytics?*', route => unavailable
    ? route.fulfill({ status: 503, json: { error: 'Isolated analytics outage' } }) : route.fallback());
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  const total = await page.locator('#statTotal').innerText();
  expect(Number(total)).toBeGreaterThan(0);
  await expect(page.locator('#reportsBody .report-card').first()).toBeVisible();
  await navigate(page, 'Analytics');
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'error');
  const before = listReads;
  unavailable = false;
  await page.locator('[data-analytics-retry]').click();
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#barangayAnalytics canvas')).toHaveCount(2);
  await navigate(page, 'Local Reports');
  await expect(page.locator('#statTotal')).toHaveText(total);
  expect(listReads).toBe(before);
});

test('report-list failure and Retry leave successful analytics usable', async ({ page }) => {
  let unavailable = true;
  let analyticsReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reports/analytics') analyticsReads++; });
  await page.route('http://127.0.0.1:3000/api/reports?*', route => unavailable
    ? route.fulfill({ status: 503, json: { error: 'Isolated list outage' } }) : route.fallback());
  await login(page, frontendBase);
  await expect(page.locator('#statTotal')).toHaveText('Unavailable');
  await navigate(page, 'Analytics');
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#barangayAnalytics canvas')).toHaveCount(2);
  await navigate(page, 'Local Reports');
  const before = analyticsReads;
  unavailable = false;
  await page.locator('#retryReports').click();
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  await expect(page.locator('#reportsBody .report-card').first()).toBeVisible();
  expect(analyticsReads).toBe(before);
});

test('older filter and range responses cannot overwrite newer selections', async ({ page, baseURL }) => {
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  let listArrived, releaseList, rangeArrived, releaseRange, listSettled, rangeSettled;
  const listReceived = new Promise(resolve => { listArrived = resolve; });
  const listGate = new Promise(resolve => { releaseList = resolve; });
  const rangeReceived = new Promise(resolve => { rangeArrived = resolve; });
  const rangeGate = new Promise(resolve => { releaseRange = resolve; });
  const listFinished = new Promise(resolve => { listSettled = resolve; });
  const rangeFinished = new Promise(resolve => { rangeSettled = resolve; });
  await page.route('http://127.0.0.1:3000/api/reports?*', async route => {
    if (new URL(route.request().url()).searchParams.get('search') !== 'older-selection') return route.fallback();
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:3000', baseURL) });
    listArrived(); await listGate;
    try { await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|handled/i.test(error.message)) throw error; }
    finally { listSettled(); }
  });
  await page.route('http://127.0.0.1:3000/api/reports/analytics?days=7', async route => {
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:3000', baseURL) });
    rangeArrived(); await rangeGate;
    try { await route.fulfill({ response }); } catch (error) { if (!/closed|cancel|abort|handled/i.test(error.message)) throw error; }
    finally { rangeSettled(); }
  });
  try {
    await page.locator('#reportSearch').fill('older-selection');
    await listReceived;
    await page.locator('#reportSearch').fill('newer-selection');
    await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
    await navigate(page, 'Analytics');
    await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-analytics-days="7"]').click();
    await rangeReceived;
    await page.locator('[data-analytics-days="90"]').click();
    await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  } finally { releaseList(); releaseRange(); }
  await Promise.all([listFinished, rangeFinished]);
  await expect(page.locator('[data-analytics-days="90"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('reportTrendsChart')).getOption().series[0].data.length)).toBe(90);
  await navigate(page, 'Local Reports');
  await expect(page.locator('#reportSearch')).toHaveValue('newer-selection');
  expect(await page.evaluate(() => BarangayPortal.snapshot().query.search)).toBe('newer-selection');
});

test('approved grid keeps aggregate tabs, equal-height cards, evidence identity and modal query state', async ({ page, baseURL }) => {
  const term = `Approved-grid-${Date.now()}`;
  for (let index = 0; index < 3; index++) await createReport(baseURL, 'Barangay 1', `${term} fixture ${index}`);
  await page.route('http://127.0.0.1:3000/api/reports?*', async route => {
    const response = await route.fetch({ url: route.request().url().replace('http://127.0.0.1:3000', baseURL) });
    const data = await response.json();
    if (data.reports?.length) data.reports[0] = { ...data.reports[0], originalAi: null, citizenCategory: null,
      aiCategory: 'A legacy infrastructure issue with a long title that must wrap without moving the card footer' };
    await route.fulfill({ response, json: data });
  });
  await login(page, frontendBase);
  await expect.poll(() => page.evaluate(() => BarangayPortal.snapshot().status)).toBe('ready');
  await expect(page.locator('#barangaySidebar nav a')).toHaveText(['Local Reports', 'Community Feed', 'GIS Map', 'Activity Logs', 'Analytics']);
  await expect(page.locator('.portal-report-stat > .portal-report-stat-icon')).toHaveCount(6);
  await expect(page.getByRole('combobox', { name: 'Reports per page', exact: true })).toHaveValue('3');
  const cards = page.locator('#reportsBody .report-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.locator('[data-action]')).toHaveCount(3);
  await expect(cards.locator('.mr-assessment, .mr-description')).toHaveCount(0);
  const state = await page.evaluate(() => BarangayPortal.snapshot());
  expect(state.data.stats.total).toBeGreaterThan(3);
  await expect(page.locator('[data-status-filter="all"]')).toHaveText(`All (${state.data.stats.total})`);
  await expect(page.locator('[data-status-filter="pending"]')).toHaveText(`Pending (${state.data.stats.pending})`);
  const heights = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
  const footers = await cards.evaluateAll(nodes => nodes.map(node => node.querySelector('footer').getBoundingClientRect().bottom - node.getBoundingClientRect().top));
  expect(Math.max(...footers) - Math.min(...footers)).toBeLessThan(2);
  expect(await cards.first().locator('h3').evaluate(node => node.clientHeight <= Number.parseFloat(getComputedStyle(node).lineHeight) * 2 + 1)).toBe(true);
  await page.evaluate(() => { window.gridCard = document.querySelector('.report-card'); window.gridPhoto = gridCard.querySelector('img'); });
  let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/reports') reads++; });
  await page.evaluate(() => dispatchEvent(new Event('DOMContentLoaded')));
  await page.evaluate(() => BarangayPortal.refresh());
  expect(reads).toBe(1);
  expect(await page.evaluate(() => gridCard === document.querySelector('.report-card') && gridPhoto === gridCard.querySelector('img'))).toBe(true);
  await page.locator('#reportSearch').fill(term);
  await expect(page.locator('#reportsPageInfo')).toHaveText('1-3 of 3 reports');
  const before = await page.evaluate(() => BarangayPortal.snapshot().query);
  const opener = cards.first().locator('[data-action="view"]');
  const id = await cards.first().getAttribute('data-report-id');
  await opener.click();
  await expect(page.locator('#reportDetails .rd-header')).toContainText(`Report #${id}`);
  await expect(page.locator('#reportDetails .rd-photos img')).toHaveCount(2);
  await page.locator('#backToReports').click();
  await expect(opener).toBeVisible();
  expect(await page.evaluate(() => BarangayPortal.snapshot().query)).toEqual(before);
  await navigate(page, 'Analytics');
  await expect(page.locator('#barangayAnalytics')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { name: 'Report breakdown', exact: true })).toBeVisible();
  await page.locator('[data-analytics-days="90"]').click();
  const pages = page.getByRole('navigation', { name: 'Daily report events pagination' });
  await expect(pages).toContainText('1-10 of 90 days');
  await pages.getByRole('combobox', { name: 'Days per page' }).selectOption('50');
  await pages.getByRole('button', { name: 'Next page' }).click();
  await expect(pages).toContainText('51-90 of 90 days');
  await expect(page.locator('[data-analytics-daily] tr')).toHaveCount(40);
  await expect(pages.getByRole('button', { name: 'Next page' })).toBeDisabled();
});
