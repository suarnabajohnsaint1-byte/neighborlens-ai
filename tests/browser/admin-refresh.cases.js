const artifactRoot = require('node:path').join(require('node:os').tmpdir(), 'neighborlens-shared-browser-artifacts');
module.exports = function ({ test, expect, adminSession, sessions, createReport, fs }) {
  async function prepare(page, baseURL) {
    const admin = await adminSession(baseURL);
    await page.addInitScript(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
    return admin;
  }

  function reports(owner) {
    return Array.from({ length: 25 }, (_, index) => ({
      id: 90000 + index, description: `Refresh report ${index}`, barangay: 'Villamonte',
      submitted_by: owner.id, submitted_by_username: owner.username, submitted_by_role: 'citizen', citizenCategory: 'Road Damage',
      status: 'pending', created_at: new Date(Date.UTC(2026, 9, 15, 12, index)).toISOString()
    }));
  }

  test('admin reports finds reporter names consistently before and after a hard refresh', async ({ page, baseURL }) => {
    await prepare(page, baseURL);

    const entries = [
      ...reports({ id: 42, username: 'citizen-2' }),
      {
        ...reports({ id: 43, username: 'other-citizen' })[0],
        id: 99999
      }
    ];

    await page.route('**/api/reports', route =>
      route.fulfill({ json: { reports: entries } })
    );

    await page.goto('/admin.html#reports');

    await expect(page.locator('#statTotal')).toHaveText('26');

    await page.locator('#reportsSection [data-query="pageSize"]')
      .selectOption('10');

    await page.locator('#adminSearch').fill('citizen-2');

    const rows = page.locator(
      '#reportsSection [data-report-id]:visible'
    );

    await expect(page.locator('#reportsPageInfo'))
      .toHaveText('1-10 of 25 reports');

    await expect(rows).toHaveCount(10);

    await expect(page.locator('#reportsPageNumber'))
      .toHaveText('Page 1 of 3');

    const client = await page.context().newCDPSession(page);

    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', {
      cacheDisabled: true
    });

    await page.reload();

    await expect(page.locator('#adminSearch'))
      .toHaveValue('citizen-2');

    await expect(page.locator('#reportsPageInfo'))
      .toHaveText('1-10 of 25 reports');

    await expect(rows).toHaveCount(10);

    await expect(page.locator('#reportsPageNumber'))
      .toHaveText('Page 1 of 3');

    await expect(
      page.locator('#reportsSection [data-report-id="99999"]:visible')
    ).toHaveCount(0);

    await page.evaluate(() => {
      window.reporterRow = document.querySelector('#adminReportsBody tr');
      return refreshReports();
    });

    expect(await page.evaluate(() =>
      window.reporterRow ===
      document.querySelector('#adminReportsBody tr')
    )).toBe(true);

    await client.detach();
  });

  test('admin report details reuses the dashboard menu and keeps All Reports active', async ({ page, request, baseURL }, info) => {
    const report = await createReport(page, request, baseURL, {
      text: 'Shared admin navigation report'
    });

    await prepare(page, baseURL);

    await page.goto('/admin.html#reports');

    await page.locator('#adminSearch')
      .fill('Shared admin navigation report');

    const menu = await page
      .locator('.portal-sidebar-navigation a')
      .evaluateAll(links => links.map(link => ({
        label: link.textContent.trim(),
        href: link.getAttribute('href')
      })));

    expect(menu).toHaveLength(5);

    const row = page.locator(
      `#reportsSection [data-report-id="${report.id}"]:visible`
    );

    await expect(row).toHaveCount(1);

    await row.locator('[data-action="view"]').click();

    await expect(page).toHaveURL(
      new URL(`/report-details.html?id=${report.id}`, baseURL).href
    );

    if (info.project.name === 'mobile') await page.locator('#openSidebar').click();
    await page.locator('#detailsNav')
      .getByRole('link', {
        name: 'Manage Accounts',
        exact: true
      }).click();

    await expect(page).toHaveURL(/admin\.html#accounts$/);
    await expect(page.locator('#accountsSection')).toBeVisible();
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    if (info.project.name === 'mobile') await page.locator('#adminMenuButton').click();
    await page.locator('.portal-sidebar-navigation').getByRole('link', { name: 'All Reports', exact: true }).click();
    await expect(page.locator('#reportsSection')).toBeVisible();
    await expect(page.locator('.portal-sidebar-navigation [aria-current="location"]')).toHaveText('All Reports');
    expect(documents).toEqual([]);
  });

  test('admin hard refresh preserves reports filters, pagination and the first visible section', async ({ page, baseURL }, info) => {
    await prepare(page, baseURL);
    await page.route('**/api/reports', route => route.fulfill({ json: { reports: reports(sessions.get(page)) } }));
    await page.goto('/admin.html');
    await page.evaluate(() => showAdminSection('reportsSection'));
    await expect(page.locator('.report-management[data-role="admin"]')).toBeVisible();
    await expect(page.locator('#adminReportCount')).toHaveText('25 reports');
    await page.locator('#reportsSection [data-query="pageSize"]').selectOption('10');
    if (!await page.locator('#adminFilterBarangay').isVisible()) await page.locator('[data-sheet-open="reportFilters"]').click();
    await expect(page.locator('#adminFilterBarangay')).toBeVisible();
    await page.locator('#adminFilterBarangay').selectOption('Villamonte');
    const apply = page.locator('#reportFilters [data-sheet-apply]');
    if (await apply.isVisible()) await apply.click();
    await page.locator('#adminFilterSort').selectOption('oldest');
    const close = page.locator('#reportFilters [data-sheet-close]').first();
    if (await close.isVisible()) await close.click();
    await page.locator('#reportsNext').click();
    await expect(page.locator('#reportsPageNumber')).toHaveText('Page 2 of 3');
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.addInitScript(() => {
      window.visibleAdminSections = [];
      const observer = new MutationObserver(() => {
        for (const section of document.querySelectorAll('main > section')) {
          if (getComputedStyle(section).display !== 'none') window.visibleAdminSections.push(section.id);
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    await expect(page.locator('#reportsSection')).toBeVisible();
    await expect(page.locator('#adminFilterBarangay')).toHaveValue('Villamonte');
    await expect(page.locator('#adminFilterSort')).toHaveValue('oldest');
    await expect(page.locator('#reportsPageNumber')).toHaveText('Page 2 of 3');
    expect(await page.evaluate(() => window.visibleAdminSections.every(section => section === 'reportsSection'))).toBe(true);
    await fs.mkdir(`${artifactRoot}/admin-refresh-screenshots`, { recursive: true });
    await page.screenshot({ path: `${artifactRoot}/admin-refresh-screenshots/restored-${info.project.name}.png`, fullPage: true });
    await client.detach();
  });

  test('admin refresh keeps last valid data and DOM during a temporary service outage', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    let failed = false;
    await page.route('**/api/reports', route => failed ? route.fulfill({ status: 503 }) : route.fulfill({ json: { reports: reports(sessions.get(page)) } }));
    await page.goto('/admin.html#reports');
    await expect(page.locator('#statTotal')).toHaveText('25');
    await page.evaluate(() => { window.firstReportRow = document.querySelector('#adminReportsBody tr'); });
    failed = true;
    await page.evaluate(() => syncReportsFromBackend());
    await expect(page.locator('#adminReportsFeedback')).toBeVisible();
    await expect(page.locator('#statTotal')).toHaveText('25');
    expect(await page.evaluate(() => window.firstReportRow === document.querySelector('#adminReportsBody tr'))).toBe(true);
    failed = false;
    await page.locator('#adminReportsFeedback button').click();
    await expect(page.locator('#adminReportsFeedback')).toBeHidden();
  });

  test('community review refresh preserves cards during loading and temporary failure', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    const entries = reports(sessions.get(page));
    let failed = false;
    let started;
    let release;
    await page.route('**/api/admin/community-publications', route => route.fulfill({
      json: {
        requests: entries.map(report => ({ reportId: report.id, state: 'pending_approval', requestedAt: report.created_at })),
        pendingCount: entries.length
      }
    }));
    await page.route('**/api/reports**', async route => {
      if (route.request().url().includes('publication=')) {
        if (started) {
          started();
          await new Promise(resolve => { release = resolve; });
        }
        if (failed) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
      }
      return route.fulfill({ json: { reports: entries } });
    });
    await page.goto('/admin.html#reports');
    await page.evaluate(() => openPendingPosts());
    await page.getByRole('button', { name: 'Cards view', exact: true }).click();
    const cards = page.locator('#adminReportCards .report-card');
    await expect(cards).toHaveCount(5);
    await page.evaluate(() => { window.reviewCardBeforeRefresh = document.querySelector('#adminReportCards .report-card'); });
    for (const fail of [false, true, false]) {
      failed = fail;
      const pending = new Promise(resolve => { started = resolve; });
      await page.evaluate(() => { window.reviewRefreshCheck = loadAdminReviewReports(); });
      await pending;
      try {
        await expect(cards).toHaveCount(5);
        expect(await page.evaluate(() => window.reviewCardBeforeRefresh === document.querySelector('#adminReportCards .report-card'))).toBe(true);
      } finally {
        started = null;
        release();
      }
      await page.evaluate(() => window.reviewRefreshCheck);
      await expect(cards).toHaveCount(5);
      expect(await page.evaluate(() => window.reviewCardBeforeRefresh === document.querySelector('#adminReportCards .report-card'))).toBe(true);
    }
  });

  test('admin refresh restores account tabs, report filters and history navigation', async ({ page, baseURL }) => {
    await prepare(page, baseURL);
    await page.route('**/api/reports', route => route.fulfill({ json: { reports: reports(sessions.get(page)) } }));
    await page.goto('/admin.html');
    await page.evaluate(() => showAdminSection('accountsSection'));
    await page.locator('[data-account-tab="admin"]').click();
    await page.locator('#accountSearch').fill('admin');
    if (!await page.locator('#accountStatusFilter').isVisible()) await page.locator('[data-sheet-open="accountFilters"]').click();
    await page.locator('#accountStatusFilter').selectOption('active');
    await page.reload();
    await expect(page.locator('#accountsSection')).toBeVisible();
    await expect(page.locator('[data-account-tab="admin"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#accountSearch')).toHaveValue('admin');
    await expect(page.locator('#accountStatusFilter')).toHaveValue('active');
    await page.evaluate(() => showAdminSection('reportsSection'));

    await expect(page.locator('#reportsSection')).toBeVisible();

    await page.locator('#reportsSection [data-query="pageSize"]')
      .selectOption('10');

    if (!await page.locator('#adminFilterBarangay').isVisible()) {
      await page.locator('[data-sheet-open="reportFilters"]').click();
    }

    await page.locator('#adminFilterBarangay')
      .selectOption('Villamonte');

    const apply = page.locator('#reportFilters [data-sheet-apply]');

    if (await apply.isVisible()) {
      await apply.click();
    }

    const close = page.locator('#reportFilters [data-sheet-close]').first();

    if (await close.isVisible()) {
      await close.click();
    }

    await page.locator('#reportsNext').click();

    await expect(page.locator('#reportsPageNumber'))
      .toHaveText('Page 2 of 3');

    await page.reload();

    await expect(page.locator('#reportsSection')).toBeVisible();

    await expect(page.locator('#adminFilterBarangay'))
      .toHaveValue('Villamonte');

    await expect(page.locator('#reportsPageNumber'))
      .toHaveText('Page 2 of 3');
    await page.evaluate(() => showAdminSection('logsSection'));
    await page.reload();
    await expect(page.locator('#logsSection')).toBeVisible();
    await page.evaluate(() => showAdminSection('gisMapSection'));
    await expect(page.locator('#gisMapSection')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#logsSection')).toBeVisible();
  });

  test('admin receives new reports and status changes through live events without polling or navigation', async ({ page, request, baseURL }) => {
    const admin = await prepare(page, baseURL);
    await page.addInitScript(() => {
      const interval = window.setInterval;
      window.setInterval = (operation, delay, ...args) => delay === 10000 ? 0 : interval(operation, delay, ...args);
    });
    const connected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notifications/stream' && response.status() === 200);
    await page.goto('/admin.html#reports');
    await connected;
    await expect(page.locator('#statTotal')).not.toHaveText('...');
    const text = `Live dashboard update ${Date.now()}`;
    await page.locator('#adminSearch').fill(text);
    await page.evaluate(() => { window.liveAdminDocument = document; });
    const documents = [];
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    const report = await createReport(page, request, baseURL, { text });
    await expect(page.locator('#reportsSection')).toContainText(text);
    const responsible = await require('../support/accounts').createOfficial(baseURL, admin.token, report.barangay, 'refresh_status');
    const response = await request.patch(`/api/reports/${report.id}/status`, { headers: { Authorization: `Bearer ${responsible.token}` }, data: { status: 'ongoing' } });
    expect(response.status()).toBe(200);
    await expect(page.locator('#reportsSection')).toContainText('Ongoing');
    expect(await page.evaluate(() => window.liveAdminDocument === document)).toBe(true);
    expect(documents).toEqual([]);
  });
};
