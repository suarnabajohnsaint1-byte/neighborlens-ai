const artifactRoot = require('node:path').join(require('node:os').tmpdir(), 'neighborlens-shared-browser-artifacts');
module.exports = function ({ test, expect, fs, sessions, getPhotos, createReport, adminSession }) {
  async function expectReachable(page, button) {
    await button.scrollIntoViewIfNeeded();
    expect(await button.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return element === target || element.contains(target);
    })).toBe(true);
  }

  test('Citizen login design uses shared controls and remains responsive in both themes', async ({ page }, info) => {
    await page.goto('/login.html');
    await expect(page.getByRole('heading', { name: 'Citizen Login', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.cl-backdrop').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByLabel('Password', { exact: true }).fill('temporary-value');
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    await expect(page.locator('#loginPass')).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    await expect(page.locator('#loginPass')).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
    await page.locator('#loginPass').fill('');
    await expect(page.locator('#loginHelp')).toBeVisible();
    await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
    await fs.mkdir(`${artifactRoot}/login-design-screenshots`, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
      for (const width of [320, 430, 768, 1440]) {
        await page.setViewportSize({ width, height: 960 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expectReachable(page, page.locator('#citizenLoginSubmit'));
        await page.mouse.move(0, 0);
        if (theme === 'light') await expect(page.locator('#citizenLoginSubmit')).toHaveCSS('background-color', 'rgb(8, 122, 248)');
        if (width === 430 || width === 1440) await page.screenshot({ path: `${artifactRoot}/login-design-screenshots/citizen-${width}-${theme}-${info.project.name}.png`, fullPage: true });
      }
    }
    await page.getByRole('link', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#signupSection')).toBeVisible();
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('Citizen login shares Admin card sizing with one continuous backdrop', async ({ page }, info) => {
    await page.setViewportSize({ width: 1672, height: 941 });
    const sizing = badge => page.evaluate(badge => {
      const panel = document.querySelector('.rl-panel');
      const style = getComputedStyle(panel);
      return {
        width: panel.getBoundingClientRect().width,
        padding: style.padding,
        radius: style.borderRadius,
        badge: document.querySelector(badge).getBoundingClientRect().width,
        title: getComputedStyle(document.querySelector('.rl-panel h1')).fontSize,
        field: document.querySelector('.rl-frame').getBoundingClientRect().height,
        submit: document.querySelector('.rl-submit').getBoundingClientRect().height
      };
    }, badge);
    await page.goto('/admin-login.html');
    const adminSizing = await sizing('.rl-badge');
    await page.goto('/login.html');
    await page.evaluate(() => PortalTheme.setPreference('light'));
    await page.evaluate(() => document.fonts.ready);
    const scene = page.locator('.cl-scene');
    await expect(scene.locator('img')).toHaveCount(1);
    await expect.poll(() => page.locator('.cl-backdrop').evaluate(image => image.complete && image.naturalWidth === 1672 && image.naturalHeight === 941)).toBe(true);
    const panel = await page.locator('.rl-panel').boundingBox();
    const brand = await page.locator('.rl-brand').boundingBox();
    const features = await page.locator('.rl-features').boundingBox();
    expect(await sizing('.cl-community-badge')).toEqual(adminSizing);
    expect(Math.abs(panel.y - 117)).toBeLessThan(4);
    expect(panel.width).toBe(540);
    expect(panel.height).toBeLessThan(720);
    expect(Math.abs(brand.x - 232)).toBeLessThan(4);
    expect(Math.abs(features.y - 182)).toBeLessThan(4);
    await expectReachable(page, page.locator('#citizenLoginSubmit'));
    await page.locator('#loginUser').blur();
    await fs.mkdir(`${artifactRoot}/login-design-screenshots`, { recursive: true });
    await page.screenshot({ path: `${artifactRoot}/login-design-screenshots/citizen-reference-${info.project.name}.png`, fullPage: true });
    for (const width of [320, 430, 768, 1024, 1280, 1440, 1920, 2518]) {
      await page.setViewportSize({ width, height: 941 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const panel = await page.locator('.rl-panel').boundingBox();
      const features = await page.locator('.rl-features').boundingBox();
      if (width <= 900) {
        expect(features.y).toBeGreaterThanOrEqual(panel.y + panel.height);
        expect(panel.width).toBe(Math.min(width, 600) - 32);
        const heading = await page.locator('.cl-login-heading').boundingBox();
        const { badge } = await sizing('.cl-community-badge');
        expect(Math.abs(badge - Math.min(220, heading.width * 0.85))).toBeLessThan(1);
      }
      else expect(features.x + features.width).toBeLessThan(panel.x);
      expect((await sizing('.cl-community-badge')).field).toBe(55);
      expect((await sizing('.cl-community-badge')).submit).toBe(56);
      await expectReachable(page, page.locator('#citizenLoginSubmit'));
    }
  });

  test('Citizen login copy stays separated from the illustration and autofill follows both themes', async ({ page }, info) => {
    await page.goto('/login.html');
    const client = await page.context().newCDPSession(page);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument');
    for (const selector of ['#loginUser', '#loginPass']) {
      await page.locator(selector).fill('sample-value');
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['autofill'] });
      expect(await page.locator(selector).evaluate(input => input.matches(':autofill'))).toBe(true);
    }
    await fs.mkdir(`${artifactRoot}/login-design-screenshots`, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
      const colors = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return { ink: root.getPropertyValue('--color-text-primary').trim(), field: getComputedStyle(document.body).getPropertyValue('--rl-field').trim() };
      });
      const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')})`;
      for (const selector of ['#loginUser', '#loginPass']) {
        await page.locator(selector).focus();
        await expect(page.locator(selector)).toHaveCSS('-webkit-text-fill-color', rgb(colors.ink));
        await expect(page.locator(selector)).toHaveCSS('box-shadow', `${rgb(colors.field)} 0px 0px 0px 1000px inset`);
      }
      await expect(page.locator('.rl-feature p').first()).toHaveCSS('color', theme === 'light' ? 'rgb(64, 89, 141)' : 'rgb(154, 170, 192)');
      await expect(page.locator('.rl-feature h2').first()).toHaveCSS('color', 'rgb(8, 28, 73)');
      await expect(page.locator('.rl-brand-tagline')).toHaveCSS('color', 'rgb(64, 89, 141)');
      await expect(page.locator('.rl-panel h1')).toHaveCSS('color', rgb(colors.ink));
      const scrim = await page.locator('.rl-features').evaluate(element => {
        const style = getComputedStyle(element, '::before');
        return { background: style.backgroundColor, pointerEvents: style.pointerEvents, filter: style.filter };
      });
      expect(scrim.background).toBe('rgba(255, 255, 255, 0.68)');
      expect(scrim.pointerEvents).toBe('none');
      await expect.poll(() => page.locator('.rl-features').evaluate(element => getComputedStyle(element, '::before').filter)).toBe('blur(20px)');
      for (const width of [430, 1672]) {
        await page.setViewportSize({ width, height: 941 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.locator('.cl-backdrop')).toHaveCSS('filter', 'none');
        await expect(page.locator('.cl-backdrop')).toHaveCSS('opacity', '1');
        await expect.poll(() => page.locator('.cl-scene').evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe(width <= 900 ? 'rgba(237, 247, 255, 0.85)' : 'rgba(0, 0, 0, 0)');
        await expectReachable(page, page.locator('#citizenLoginSubmit'));
        await page.locator('#loginPass').blur();
        await page.screenshot({ path: `${artifactRoot}/login-design-screenshots/citizen-contrast-${width}-${theme}-${info.project.name}.png`, fullPage: true });
      }
    }
    await client.detach();
  });

  test('Citizen login retries once, submits once, and remembers only the username', async ({ page }) => {
    const owner = sessions.get(page);
    await page.addInitScript(() => { if (location.pathname.endsWith('/login.html')) sessionStorage.removeItem('up_session'); });
    let requests = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/citizen/login') requests++; });
    await page.route('**/api/auth/citizen/login', route => route.fulfill({ status: 503, json: { message: 'Login temporarily unavailable' } }));
    await page.goto('/login.html');
    await page.locator('#loginUser').fill(owner.username);
    await page.locator('#loginPass').fill('password123');
    await page.locator('#loginRemember').check();
    await page.locator('#citizenLoginSubmit').click();
    await expect(page.locator('#loginMsg')).toContainText('unavailable');
    expect(requests).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
    await page.unroute('**/api/auth/citizen/login');
    await page.locator('#citizenLoginSubmit').click();
    await expect(page).toHaveURL(/citizen\.html$/);
    expect(requests).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem('neighborlens:remembered-username:citizen'))).toBe(owner.username);
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('password123')))).toBe(false);
    await page.goto('/login.html');
    await expect(page.locator('#loginUser')).toHaveValue(owner.username);
    await expect(page.locator('#loginPass')).toHaveValue('');
    await expect(page.locator('#loginRemember')).toBeChecked();
  });

  test('primary CTAs use the shared blue and stay reachable on mobile in Citizen and Admin', async ({ page, baseURL }) => {
    await page.addInitScript(() => localStorage.setItem('neighborlens:theme-preference:v1', 'light'));
    await page.goto('/citizen.html');
    for (const width of [320, 430, 768]) {
      await page.setViewportSize({ width, height: 700 });
      const button = page.locator('#submitBtn');
      await expectReachable(page, button);
      await page.mouse.move(0, 0);
      await expect(button).toHaveCSS('background-color', 'rgb(6, 101, 208)');
      const cta = await button.boundingBox();
      const nav = await page.locator('.portal-mobile-nav').boundingBox();
      expect(cta.y + cta.height).toBeLessThanOrEqual(nav.y);
    }
    const admin = await adminSession(baseURL);
    await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), { ...admin.user, apiToken: admin.token });
    await page.goto('/admin.html');
    await page.locator('#adminMenuButton').click();
    await page.locator('.nav-links a[data-section="accountsSection"]').click();
    await page.locator('#addOfficialBtn').click();
    const save = page.locator('#accountModal button[type="submit"]');
    for (const width of [320, 430, 768]) {
      await page.setViewportSize({ width, height: 700 });
      await expectReachable(page, save);
      await page.mouse.move(0, 0);
      await expect(save).toHaveCSS('background-color', 'rgb(8, 122, 248)');
    }
  });

  test('Admin login keeps the same bright illustration in dark mode with readable scene copy', async ({ page }, info) => {
    await page.goto('/admin-login.html');
    await fs.mkdir(`${artifactRoot}/login-design-screenshots`, { recursive: true });
    const sceneColors = () => page.locator('.rl-scene').evaluate(element => {
      const scene = getComputedStyle(element);
      return { background: scene.backgroundColor, image: scene.backgroundImage, filter: scene.filter, opacity: scene.opacity, veil: getComputedStyle(element, '::after').backgroundColor };
    });
    for (const width of [430, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => PortalTheme.setPreference('light'));
      const light = await sceneColors();
      await page.evaluate(() => PortalTheme.setPreference('dark'));
      expect(await sceneColors()).toEqual(light);
      await expect(page.locator('.rl-feature h2').first()).toHaveCSS('color', 'rgb(8, 28, 73)');
      await expect(page.locator('.rl-feature p').first()).toHaveCSS('color', 'rgb(64, 89, 141)');
      await expect(page.locator('.rl-panel')).toHaveCSS('background-color', 'rgb(20, 25, 38)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expectReachable(page, page.locator('#roleLoginSubmit'));
      await page.screenshot({ path: `${artifactRoot}/login-design-screenshots/admin-bright-scene-${width}-${info.project.name}.png`, fullPage: true });
    }
  });

  test('Admin login reuses the shared controls and submits only once', async ({ page }) => {
    await page.goto('/admin-login.html');
    await page.setViewportSize({ width: 430, height: 700 });
    await page.locator('#roleLoginUser').fill('admin');
    await page.locator('#roleLoginPass').fill('admin123');
    await page.locator('#roleLoginRemember').check();
    expect(await page.evaluate(() => {
      const form = document.getElementById('roleLoginForm');
      return LoginControls.get(form) === LoginControls.mount(form, {});
    })).toBe(true);
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    await expect(page.locator('#roleLoginPass')).toHaveAttribute('type', 'text');
    let logins = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/admin/login') logins++; });
    await expectReachable(page, page.locator('#roleLoginSubmit'));
    await page.locator('#roleLoginSubmit').click();
    await expect(page).toHaveURL(/admin\.html$/);
    expect(logins).toBe(1);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('up_session')).role)).toBe('admin');
    expect(await page.evaluate(() => localStorage.getItem('neighborlens:remembered-username:admin'))).toBe('admin');
  });

  test('Citizen two-photo scan keeps its document, form, files, and map with one damage request', async ({ page, request }) => {
    await request.post('/__phase2_mode', { data: { mode: 'pothole' } });
    await page.goto('/citizen.html');
    await page.locator('#description').fill('Keep the citizen description while scanning.');
    await page.evaluate(() => { window.citizenIdentity = { document, form: document.getElementById('reportForm'), map: document.getElementById('geoCanvas') }; });
    const documents = [];
    let scans = 0;
    page.on('request', request => {
      if (request.resourceType() === 'document') documents.push(request.url());
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/ai/damage') scans++;
    });
    await page.locator('#imgInput').setInputFiles([0, 1].map(index => ({ name: `angle-${index}.png`, mimeType: 'image/png', buffer: getPhotos()[index] })));
    await expect(page.locator('[data-assessment-state]')).toHaveAttribute('data-assessment-state', 'DETECTED');
    expect(scans).toBe(1);
    expect(documents).toEqual([]);
    expect(await page.evaluate(() => document === window.citizenIdentity.document && document.getElementById('reportForm') === window.citizenIdentity.form && document.getElementById('geoCanvas') === window.citizenIdentity.map && document.getElementById('imgInput').files.length === 2)).toBe(true);
    await expect(page.locator('#description')).toHaveValue('Keep the citizen description while scanning.');
  });

  test('Citizen report refresh preserves unchanged rows and displays later API data', async ({ page, request, baseURL }) => {
    const report = await createReport(page, request, baseURL, { text: 'Initial citizen report' });
    let updated = false;
    await page.route('**/api/reports', async route => {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ json: { ...body, reports: body.reports.map(row => row.id === report.id && updated ? { ...row, description: 'Citizen report updated from API' } : row) } });
    });
    await page.goto('/citizen.html#my-reports');
    await expect(page.locator('#myReports')).toContainText('Initial citizen report');
    await page.evaluate(() => { window.citizenRowIdentity = document.querySelector('.mr-row'); });
    await page.evaluate(() => { loadMyReports(); return syncReportsFromBackend(); });
    expect(await page.evaluate(() => window.citizenRowIdentity === document.querySelector('.mr-row'))).toBe(true);
    updated = true;
    await page.evaluate(() => syncReportsFromBackend());
    await expect(page.locator('#myReports')).toContainText('Citizen report updated from API');
    await page.locator('a.report-entry-link').click();
    await expect(page.locator('#reportDetails')).toBeVisible();
    await page.goBack();
    await expect(page.locator('.mr-row')).toBeVisible();
  });
};
