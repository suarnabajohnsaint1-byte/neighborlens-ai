const artifactRoot = require('node:path').join(require('node:os').tmpdir(), 'neighborlens-shared-browser-artifacts');
const sharp = require('sharp');
const { analyticsRange, summarizeAnalytics } = require('../../server/domain/reports/reportAnalytics.rules');

module.exports = function ({ test, expect, fs, adminSession, createReport }) {
  async function prepare(page, baseURL) {
    const admin = await adminSession(baseURL);
    await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
    return admin;
  }

  function fixture(days, { count = 0, missing = 0 } = {}) {
    const range = analyticsRange(days);
    return summarizeAnalytics(range, { submissions: count ? [{ day: range.endDate, category: 'pothole', total: count }] : [],
      resolutions: [], missingResolutionHistory: missing, timestampOffsetMinutes: 0 });
  }

  async function ready(page) {
    await expect(page.locator('#adminAnalytics')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#reportTrendsChart canvas, #reportCategoriesChart canvas')).toHaveCount(2);
  }

  async function navigate(page, label) {
    const menu = page.locator('#adminMenuButton');
    if (await menu.isVisible()) await menu.click();
    await page.locator('#adminSidebar').getByRole('link', { name: label, exact: true }).click();
  }

  test('admin analytics renders real line, bars and pie at 375, 768 and 1440 in both themes', async ({ page, request, baseURL }, info) => {
    await createReport(page, request, baseURL, { mode: 'pothole', barangay: 'Villamonte', text: 'Analytics browser report' });
    await createReport(page, request, baseURL, { mode: 'road_crack', barangay: 'Villamonte', text: 'Analytics road crack report' });
    await prepare(page, baseURL);
    let calls = 0;
    let response;
    page.on('request', request => { if (request.url().includes('/api/admin/analytics/reports?')) calls++; });
    page.on('response', async value => { if (value.url().includes('/api/admin/analytics/reports?') && value.ok()) response = await value.json(); });
    await page.goto('/admin.html#overview');
    await ready(page);
    await expect(page.locator('#overviewSection')).toHaveCount(0);
    await expect(page.locator('#analyticsSection').getByText('View chart data', { exact: true })).toBeVisible();
    await expect(page.locator('[data-analytics-totals]')).toBeVisible();
    expect(calls).toBe(1);
    await page.evaluate(() => { window.overviewTrend = echarts.getInstanceByDom(document.getElementById('reportTrendsChart')); });
    await navigate(page, 'Analytics');
    await expect(page).toHaveURL(/#analytics$/);
    await expect(page.locator('#adminSidebar a[href$="#analytics"]')).toHaveAttribute('aria-current', 'location');
    await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible();
    await ready(page);
    expect(await page.evaluate(() => window.overviewTrend === echarts.getInstanceByDom(document.getElementById('reportTrendsChart')))).toBe(true);
    expect(calls).toBe(1);
    await expect(page.locator('[data-analytics-days="30"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => Boolean(response)).toBe(true);
    await expect(page.locator('[data-analytics-total="submitted"]')).toHaveText(String(response.totals.submitted));
    await expect(page.locator('[data-analytics-total="ongoing"]')).toHaveText(String(response.totals.ongoing));
    await expect(page.locator('[data-analytics-daily]')).toBeVisible();
    await page.getByRole('combobox', { name: 'Daily events scope' }).selectOption('city');
    const daily = page.locator('[data-analytics-daily]');
    const pagination = page.getByRole('navigation', { name: 'Daily report events pagination' });
    await expect(daily.locator('tr')).toHaveCount(10);
    await expect(pagination.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await pagination.getByRole('button', { name: 'Next page' }).click();
    await expect(pagination).toContainText('11-20 of 30 days');
    await expect(daily.locator('tr th').first()).toHaveText(response.daily[10].date);
    await pagination.getByRole('combobox', { name: 'Rows per page' }).selectOption('20');
    await expect(daily.locator('tr')).toHaveCount(20);
    await pagination.getByRole('button', { name: 'Next page' }).click();
    await expect(pagination).toContainText('21-30 of 30 days');
    await expect(pagination.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(calls).toBe(1);
    await expect(page.locator('[data-analytics-categories] tr')).toHaveCount(response.categories.length);
    const options = await page.evaluate(() => ({
      trend: echarts.getInstanceByDom(document.getElementById('reportTrendsChart')).getOption(),
      category: echarts.getInstanceByDom(document.getElementById('reportCategoriesChart')).getOption()
    }));
    expect(options.trend.series.map(series => series.type)).toEqual(['line', 'line', 'line']);
    expect(options.trend.series[0].data).toEqual(response.daily.map(day => day.submitted));
    expect(options.trend.series[1].data).toEqual(response.daily.map(day => day.ongoing));
    expect(options.trend.series[2].data).toEqual(response.daily.map(day => day.resolved));
    expect(options.trend.series.every(series => !series.areaStyle)).toBe(true);
    expect(options.category.series[0].type).toBe('bar');
    expect(options.category.series[0]).toMatchObject({ barWidth: 8, showBackground: true, itemStyle: { borderRadius: 4 } });
    expect(options.category.xAxis[0].type).toBe('value');
    expect(options.category.yAxis[0].type).toBe('category');
    expect(options.category.series[0].data.map(entry => entry.value)).toEqual(response.categories.map(category => category.count));
    expect(options.category.yAxis[0].data).toEqual(response.categories.map(category => category.label));
    const categoryStyle = page.getByRole('group', { name: 'Category chart style' });
    const pieButton = categoryStyle.getByRole('button', { name: 'Pie' });
    const barsButton = categoryStyle.getByRole('button', { name: 'Bars' });
    const categoryChart = page.locator('#reportCategoriesChart');
    const shares = page.getByRole('list', { name: 'Category shares' });
    const currentCategory = () => categoryChart.evaluate(element => echarts.getInstanceByDom(element).getOption().series[0].type);
    await expect(barsButton).toHaveAttribute('aria-pressed', 'true');
    await expect(shares).toBeHidden();
    const chartStyle = page.getByRole('combobox', { name: 'Trend chart style' });
    const trendSeries = () => page.locator('#reportTrendsChart').evaluate(element => {
      const option = echarts.getInstanceByDom(element).getOption();
      return option.series.map(({ type, smooth, data, itemStyle }) => [type, Boolean(smooth), data, itemStyle.color]);
    });
    await expect(chartStyle).toHaveValue('line');
    for (const [style, type] of [['curve', 'line'], ['bar', 'bar'], ['line', 'line']]) {
      await chartStyle.selectOption(style);
      await expect.poll(trendSeries).toEqual(options.trend.series.map(series => [type, style === 'curve', series.data, series.itemStyle.color]));
    }
    expect(calls).toBe(1);
    await chartStyle.selectOption('curve');
    await fs.mkdir(`${artifactRoot}/admin-analytics-screenshots`, { recursive: true });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
        await expect.poll(() => page.locator('#reportTrendsChart').evaluate(element => echarts.getInstanceByDom(element).getWidth() === element.clientWidth)).toBe(true);
        await expect.poll(() => page.locator('#reportCategoriesChart').evaluate((element, keys) => {
          const style = getComputedStyle(element);
          return echarts.getInstanceByDom(element).getOption().series[0].data.every((item, index) =>
            item.itemStyle.color === style.getPropertyValue(`--report-category-${ReportPresentation.categoryIconName(keys[index])}`).trim());
        }, response.categories.map(category => category.key))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const styleControl = await chartStyle.boundingBox();
        const periodControl = await page.getByRole('group', { name: 'Analytics period' }).boundingBox();
        expect(styleControl.y).toBe(periodControl.y);
        expect(styleControl.height).toBe(periodControl.height);
        expect(await page.locator('.analytics-tables :is(th, td)').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth))).toBe(true);
        const line = await page.locator('#reportTrendsChart').boundingBox();
        const bar = await page.locator('#reportCategoriesChart').boundingBox();
        expect(bar.height).toBe(width <= 600 ? 190 : 144);
        const counts = await categoryChart.evaluate(element => {
          const chart = echarts.getInstanceByDom(element);
          return chart.getZr().storage.getDisplayList()
            .filter(item => item.type === 'tspan' && /^[0-9]+$/.test(item.style.text))
            .map(item => [item.style.text, item.transform[4] - element.clientWidth]);
        });
        expect(counts.sort()).toEqual(response.categories.map(category => [String(category.count), -4]).sort());
        const stats = await page.locator('.admin-stats').boundingBox();
        if (stats) expect(line.y).toBeGreaterThan(stats.y + stats.height);
        await expect(page.locator('#gridHeader')).toBeHidden();
        if (width === 1440) {
          expect(bar.y).toBeLessThan(line.y + line.height);
          expect(Math.abs(line.y - bar.y)).toBeLessThan(40);
          expect(line.width / bar.width).toBeGreaterThan(1.3);
          expect(line.width / bar.width).toBeLessThan(1.8);
        } else expect(bar.y).toBeGreaterThan(line.y + line.height);
        const image = await page.locator('#reportTrendsChart').screenshot();
        const statsPixels = await sharp(image).stats();
        expect(Math.max(...statsPixels.channels.slice(0, 3).map(channel => channel.stdev))).toBeGreaterThan(1);
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: `${artifactRoot}/admin-analytics-screenshots/analytics-${width}-${theme}-${info.project.name}.png`, fullPage: true });
        await pieButton.press('Enter');
        await expect(pieButton).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(currentCategory).toBe('pie');
        await expect(page.locator('.analytics-pie-total strong')).toHaveText(String(response.totals.submitted));
        await expect(shares.locator('li')).toHaveCount(response.categories.length);
        await expect(shares.locator('strong')).toHaveText(response.categories.map(category => `${Math.round(category.percentage * 10) / 10}%`));
        expect(await categoryChart.evaluate(element => {
          const option = echarts.getInstanceByDom(element).getOption();
          return option.series[0].data.map(item => [item.name, item.value]);
        }))
          .toEqual(response.categories.filter(category => category.count > 0).map(category => [category.label, category.count]));
        expect(await categoryChart.evaluate(element => echarts.getInstanceByDom(element).getOption().tooltip[0].show)).toBe(false);
        await expect(shares.locator('.analytics-category-share')).toHaveText(response.categories.map(category => `${category.count} · ${Math.round(category.percentage * 10) / 10}%`));
        expect(await shares.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.locator('section[aria-labelledby="reportCategoriesHeading"]').screenshot({ path: `${artifactRoot}/admin-analytics-screenshots/pie-${width}-${theme}-${info.project.name}.png` });
        await barsButton.click();
        await expect.poll(currentCategory).toBe('bar');
        await expect(shares).toBeHidden();
      }
    }
    expect(calls).toBe(1);
    const before = calls;
    await page.locator('[data-analytics-days="7"]').click();
    await ready(page);
    await expect(page.locator('[data-analytics-days="7"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(pagination).toContainText('1-7 of 7 days');
    await expect.poll(() => page.evaluate(() => echarts.getInstanceByDom(document.getElementById('reportTrendsChart')).getOption().series[0].data.length)).toBe(7);
    expect(calls).toBe(before + 1);
    await page.reload();
    await ready(page);
    await expect(page.locator('[data-analytics-days="7"]')).toHaveAttribute('aria-pressed', 'true');
    expect(calls).toBe(before + 2);
  });

  test('panel analytics splits daily counts by barangay and paginates without changing city totals', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    const range = analyticsRange(30);
    const catalog = [{ id: 1, name: 'Vista Alegre' }, { id: 2, name: 'Estefania' },
      ...Array.from({ length: 11 }, (_, index) => ({ id: index + 3, name: `Barangay ${index + 1}` }))];
    const data = summarizeAnalytics(range, { catalog, submissions: [
      { day: range.endDate, barangayId: 1, category: 'pothole', total: 2, currentOngoing: 0, currentResolved: 1 },
      { day: range.endDate, barangayId: 2, category: 'road_crack', total: 1, currentOngoing: 1, currentResolved: 0 }
    ], ongoing: [{ day: range.endDate, barangayId: 2, total: 1 }],
    resolutions: [{ day: range.endDate, barangayId: 1, total: 1 }], missingResolutionHistory: 0 });
    await page.route('**/api/admin/analytics/reports?*', route => route.fulfill({ json: data }));
    await page.goto('/admin.html#overview');
    await ready(page);
    await expect(page.locator('#analyticsBarangayChart canvas')).toHaveCount(1);
    await expect(page.locator('[data-analytics-total="submitted"]')).toHaveText('3');
    const table = page.locator('#analyticsDailyTable');
    const vista = table.getByRole('row').filter({ hasText: 'Vista Alegre' });
    const estefania = table.getByRole('row').filter({ hasText: 'Estefania' });
    await expect(vista.getByRole('cell')).toHaveText(['Vista Alegre', '2', '0', '1']);
    await expect(estefania.getByRole('cell')).toHaveText(['Estefania', '1', '1', '0']);
    const scope = page.getByRole('combobox', { name: 'Daily events scope' });
    await scope.selectOption({ label: 'Vista Alegre' });
    await expect(estefania).toHaveCount(0);
    await scope.selectOption('city');
    await expect(table.getByRole('cell', { name: 'All barangays' })).toHaveCount(10);
    await page.locator('[data-analytics-area-panel]').getByText('View barangay breakdown').click();
    const areaRows = page.locator('[data-analytics-area-rows] tr');
    await expect(areaRows).toHaveCount(10);
    await page.getByRole('button', { name: 'Next barangays' }).click();
    await expect(areaRows).toHaveCount(3);
    await page.getByRole('combobox', { name: 'Barangays per page' }).selectOption('5');
    await expect(areaRows).toHaveCount(5);
    await expect(page.locator('#analyticsBarangayPageNumber')).toHaveText('Page 1 of 3');
    await expect(page.locator('[data-analytics-total="submitted"]')).toHaveText('3');
    await page.getByRole('combobox', { name: 'Barangay', exact: true }).selectOption({ label: 'Vista Alegre' });
    await page.getByRole('button', { name: 'Pie', exact: true }).click();
    await expect(page.locator('.analytics-pie-total strong')).toHaveText('2');
  });

  test('admin analytics ignores stale range responses and reuses chart instances through navigation', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    let release;
    const calls = [];
    await page.route('**/api/admin/analytics/reports?*', async route => {
      const days = Number(new URL(route.request().url()).searchParams.get('days'));
      calls.push(days);
      if (days === 7) await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: fixture(days, { count: days }) }).catch(() => {});
    });
    await page.goto('/admin.html#analytics');
    await ready(page);
    await page.locator('[data-analytics-days="7"]').click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.locator('[data-analytics-days="90"]').click();
    await ready(page);
    release();
    await expect.poll(() => page.evaluate(() => echarts.getInstanceByDom(document.getElementById('reportTrendsChart')).getOption().series[0].data.length)).toBe(90);
    await expect(page.locator('[data-analytics-days="90"]')).toHaveAttribute('aria-pressed', 'true');
    expect(calls).toEqual([30, 7, 90]);
    await page.evaluate(() => { window.analyticsChartIdentity = echarts.getInstanceByDom(document.getElementById('reportTrendsChart')); showAdminSection('reportsSection'); });
    await expect(page.locator('#adminAnalytics')).toBeHidden();
    await page.goBack();
    await ready(page);
    expect(await page.evaluate(() => window.analyticsChartIdentity === echarts.getInstanceByDom(document.getElementById('reportTrendsChart')))).toBe(true);
    expect(calls).toEqual([30, 7, 90]);
    expect(await page.locator('#adminAnalytics').evaluate(element => PortalAnalyticsDashboard.mount(element) === PortalAnalyticsDashboard.mount(element))).toBe(true);
    await page.locator('#adminAnalytics').evaluate(element => PortalAnalyticsDashboard.mount(element).destroy());
    expect(await page.evaluate(() => echarts.getInstanceByDom(document.getElementById('reportTrendsChart')))).toBeUndefined();
  });

  test('admin analytics has stable error, retry, empty and unavailable-history states', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    let failed = true;
    let missing = false;
    await page.route('**/api/admin/analytics/reports?*', route => failed ? route.fulfill({ status: 503, json: { error: 'Analytics unavailable' } })
      : route.fulfill({ json: fixture(Number(new URL(route.request().url()).searchParams.get('days')), { missing: missing ? 2 : 0 }) }));
    await page.goto('/admin.html#analytics');
    await expect(page.locator('#adminAnalytics')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('[data-analytics-message]')).toContainText('unavailable');
    await expect(page.locator('[data-analytics-message]')).not.toContainText('No reports');
    const before = await page.locator('.analytics-row').boundingBox();
    failed = false;
    await page.locator('[data-analytics-retry]').click();
    await ready(page);
    await expect(page.locator('[data-analytics-message]')).toHaveText('No reports in this period.');
    expect((await page.locator('.analytics-row').boundingBox()).height).toBe(before.height);
    missing = true;
    await page.locator('[data-analytics-days="7"]').click();
    await ready(page);
    await expect(page.locator('[data-analytics-history]')).toContainText('2 resolved reports have no dated resolution history');
    await expect.poll(() => page.evaluate(() => echarts.getInstanceByDom(document.getElementById('reportTrendsChart'))
      .getOption().series.find(series => series.name === 'Resolved').data.every(value => value === null))).toBe(true);
    await expect(page.locator('[data-analytics-daily]')).toContainText('Unavailable (0 dated)');
    await expect(page.locator('[data-analytics-total="resolved"]')).toHaveText('Unavailable');
  });

  test('admin analytics retries a failed ECharts download without duplicate initialization', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    await page.route('**/echarts@6.1.0/dist/echarts.min.js', route => route.abort());
    let requests = 0;
    page.on('request', request => { if (request.url().includes('/api/admin/analytics/reports?')) requests++; });
    await page.goto('/admin.html#analytics');
    await expect(page.locator('#adminAnalytics')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('[data-analytics-message]')).toContainText('Charts could not be loaded');
    expect(requests).toBe(1);
    await page.unroute('**/echarts@6.1.0/dist/echarts.min.js');
    await page.locator('[data-analytics-retry]').click();
    await ready(page);
    expect(requests).toBe(2);
    expect(await page.locator('#reportTrendsChart canvas').count()).toBe(1);
  });

  test('admin analytics refreshes after committed status events without losing filters, page or document', async ({ page, request, baseURL }) => {
    const report = await createReport(page, request, baseURL, { barangay: 'Villamonte', text: 'Realtime analytics source' });
    const admin = await prepare(page, baseURL);
    await page.goto('/admin.html#analytics');
    await ready(page);
    await page.locator('[data-analytics-barangay]').selectOption({ label: 'Villamonte' });
    await page.locator('[data-analytics-days="7"]').click();
    await ready(page);
    await page.evaluate(() => { window.analyticsDocument = document; window.analyticsScroll = scrollY; });
    const updated = page.waitForResponse(response => response.url().includes('/api/admin/analytics/reports?days=7') && response.ok());
    const responsible = await require('../support/accounts').createOfficial(baseURL, admin.token, report.barangay, 'analytics_status');
    const response = await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${responsible.token}` }, multipart: {
      status: 'resolved', note: 'Completed repair', requestKey: require('node:crypto').randomUUID(),
      images: { name: 'completion.png', mimeType: 'image/png', buffer: require('../support/image-fixtures').PNG_BYTES }
    } });
    expect(response.status()).toBe(200);
    const payload = await (await updated).json();
    await ready(page);
    expect(payload.totals.knownResolved).toBeGreaterThanOrEqual(1);
    await expect(page.locator('[data-analytics-barangay] option:checked')).toHaveText('Villamonte');
    await expect(page.locator('[data-analytics-days="7"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document === window.analyticsDocument && scrollY === window.analyticsScroll)).toBe(true);
    await expect(page.locator('#analyticsSection #adminAnalytics')).toBeVisible();
    await expect(page.locator('[data-analytics-days="7"]')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('combobox', { name: 'Daily events scope' }).selectOption({ label: 'Villamonte' });
    await expect(page.locator('[data-analytics-daily]')).toContainText('Villamonte');
  });
};
