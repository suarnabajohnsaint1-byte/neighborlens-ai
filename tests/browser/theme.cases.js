const artifactRoot = require('node:path').join(require('node:os').tmpdir(), 'neighborlens-shared-browser-artifacts');
module.exports = function registerThemeTests({ test, expect, fs, sessions, createReport, open, expectLiveMapTiles, getPhotos, adminSession, createOfficial }) {
  const key = 'neighborlens:theme-preference:v1';
  const widths = [320, 375, 390, 430, 542, 768, 1024, 1440];

  async function choose(page, preference) {
    if (preference === 'auto') {
      await page.evaluate(() => PortalTheme.setPreference('auto'));
      await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
      return;
    }
    if (await page.locator('.portal-mobile-header').isVisible() && !await page.locator('#citizenAccountMenu').isVisible()) {
      await page.getByRole('button', { name: 'Citizen account', exact: true }).click();
    }
    const switchControl = page.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true });
    const isChecked = await switchControl.isChecked();
    if (preference === 'dark' && !isChecked) {
      await switchControl.click();
    } else if (preference === 'light' && isChecked) {
      await switchControl.click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', preference === 'auto' ? /light|dark/ : preference);
  }

  async function contrastPairs(page) {
    return page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      function luminance(token) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = style.getPropertyValue(`--color-${token}`).trim();
        context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }
      const textPairs = [
        ...['text-primary', 'text-secondary', 'text-muted'].flatMap(text => ['bg', 'surface', 'surface-raised'].map(surface => [text, surface])),
        ['accent', 'surface'], ['accent', 'surface-selected'], ['accent', 'accent-subtle'],
        ['accent-contrast', 'accent'], ['success', 'success-subtle'], ['warning', 'warning-subtle'],
        ['danger', 'danger-subtle'], ['info-text', 'info-surface'], ['input-text', 'input-bg'],
        ['input-placeholder', 'input-bg'], ['map-control-text', 'map-control-bg'], ['media-label-text', 'media-label-bg']
      ];
      const boundaryPairs = [['focus-ring', 'bg'], ['focus-ring', 'surface']];
      return [...textPairs.map(pair => [...pair, 4.5]), ...boundaryPairs.map(pair => [...pair, 3])].map(([foreground, background, minimum]) => {
        const a = luminance(foreground);
        const b = luminance(background);
        return { foreground, background, minimum, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    });
  }

  for (const appearance of ['light', 'dark']) {
    test(`theme: ${appearance} preserves detected, provisional, no-detection, provider-error and validation feedback`, async ({ page, request }, info) => {
      await page.goto('/citizen.html');
      await choose(page, appearance);
      await page.keyboard.press('Escape');
      await page.locator('#description').fill('Preserve this explanation in every AI feedback state.');
      for (const [mode, state, tone] of [
        ['pothole', 'DETECTED', 'success'], ['low', 'LOW_CONFIDENCE', 'neutral'],
        ['none', 'NO_DETECTION', 'info'], ['unavailable', 'AI_SERVICE_ERROR', 'danger']
      ]) {
        await request.post('/__phase2_mode', { data: { mode } });
        await page.locator('#imgInput').setInputFiles(getPhotos().map((buffer, index) => ({ name: `feedback-${index}.png`, mimeType: 'image/png', buffer })));
        const panel = page.locator('[data-assessment-state]');
        await expect(panel).toHaveAttribute('data-assessment-state', state);
        await expect(panel).toHaveAttribute('data-assessment-tone', tone);
        const expectedBackground = await panel.evaluate((element, tone) => {
          const sample = document.createElement('span');
          sample.style.backgroundColor = tone === 'neutral'
            ? 'color-mix(in srgb, #cbd5e1 20%, var(--surface))'
            : `var(--color-${tone}-subtle)`;
          element.append(sample);
          const color = getComputedStyle(sample).backgroundColor;
          sample.remove();
          return color;
        }, tone);
        await expect(panel).toHaveCSS('background-color', expectedBackground);
        await expect(page.locator('#description')).toHaveValue('Preserve this explanation in every AI feedback state.');
        await fs.mkdir(`${artifactRoot}/theme-results`, { recursive: true });
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${artifactRoot}/theme-results/${info.project.name}-${appearance}-${state}.png` });
      }
      let submissions = 0;
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/reports') submissions++; });
      await page.locator('#imgInput').setInputFiles([{ name: 'only-one.png', mimeType: 'image/png', buffer: getPhotos()[0] }]);
      await expect(page.locator('#submitBtn')).toBeDisabled();
      await page.locator('#reportForm').dispatchEvent('submit', { cancelable: true });
      await expect(page.locator('#formError')).toContainText('exactly 2');
      expect(submissions).toBe(0);
    });

    test(`theme: ${appearance} styles actual GPS accuracy warnings and denied-location errors without changing the threshold`, async ({ page, context }) => {
      await context.setGeolocation({ latitude: 10.678, longitude: 122.946, accuracy: 150 });
      await page.goto('/citizen.html');
      await choose(page, appearance);
      await page.keyboard.press('Escape');
      await expect(page.locator('#gpsStatus .geo-brgy').filter({ hasText: 'accuracy is too low' })).toContainText('need ≤100m');
      expect(await page.evaluate(() => MAX_REPORT_LOCATION_ACCURACY_METERS)).toBe(100);
      await page.evaluate(async () => {
        navigator.geolocation.getCurrentPosition = (_, fail) => fail({ code: 1, message: 'Permission denied' });
        navigator.geolocation.watchPosition = (_, fail) => { fail({ code: 1, message: 'Permission denied' }); return 0; };
        await runAutoGeofence();
      });
      await expect(page.locator('.geo-status--error')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
    });

    test(`theme: ${appearance} covers form, GPS, map, keyboard focus, and responsive account controls`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto('/citizen.html');
      await choose(page, appearance);
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      await expectLiveMapTiles(page);
      await page.locator('#description').fill('Keep this text while changing appearance.');
      await page.locator('#description').blur();
      await choose(page, appearance === 'light' ? 'dark' : 'light');
      await choose(page, appearance);
      await page.keyboard.press('Escape');
      await expect(page.locator('#description')).toHaveValue('Keep this text while changing appearance.');
      const contrast = await contrastPairs(page);
      for (const pair of contrast) expect(pair.ratio, `${appearance}: ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(pair.minimum);
      await fs.mkdir(`${artifactRoot}/theme-results`, { recursive: true });
      await fs.writeFile(`${artifactRoot}/theme-results/${info.project.name}-${appearance}-contrast.json`, JSON.stringify(contrast, null, 2));
      for (const width of widths) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => scrollTo(0, 0));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(page.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true })).toHaveCount(1);
        if (width <= 900) {
          await page.getByRole('button', { name: 'Citizen account', exact: true }).click();
          const menu = await page.locator('#citizenAccountMenu').boundingBox();
          expect(menu.x).toBeGreaterThanOrEqual(0);
          expect(menu.x + menu.width).toBeLessThanOrEqual(width);
          await expect(page.locator('#geoCanvas')).toBeHidden();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('button', { name: 'Citizen account', exact: true })).toBeFocused();
          await page.locator('#submitBtn').scrollIntoViewIfNeeded();
          const submit = await page.locator('#submitBtn').boundingBox();
          const bottom = await page.locator('.portal-mobile-nav').boundingBox();
          expect(submit.y + submit.height).toBeLessThanOrEqual(bottom.y);
        }
      }
      await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1440, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      if (info.project.name === 'mobile') await page.getByRole('button', { name: 'Citizen account', exact: true }).click();
      await page.screenshot({ path: `${artifactRoot}/theme-results/${info.project.name}-${appearance}-submission.png` });
      await page.keyboard.press('Escape');
      await page.locator('#description').focus();
      expect(await page.locator('#description').evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
      if (info.project.name === 'mobile') await page.getByRole('button', { name: 'Open location map' }).click();
      await expect(page.locator('#geoCanvas .leaflet-tile-loaded').first()).toHaveCSS('filter', 'none');
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      if (info.project.name === 'mobile') await page.getByRole('button', { name: 'Close location map' }).click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await page.locator('#submitBtn').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    });

    test(`theme: ${appearance} covers report rows, correction, Details, image dialog, and map enlargement`, async ({ page, request, baseURL }, info) => {
      const report = await createReport(page, request, baseURL, { text: 'Preserved theme regression report' });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto('/citizen.html#my-reports');
      await expect(page.locator('.mr-row')).toHaveCount(1);
      await expect(page.locator('.mr-correction')).toContainText('Citizen correction');
      await choose(page, appearance);
      await page.keyboard.press('Escape');
      await expect(page.locator('.mr-status')).toHaveText('Pending');
      await fs.mkdir(`${artifactRoot}/theme-results`, { recursive: true });
      await page.screenshot({ path: `${artifactRoot}/theme-results/${info.project.name}-${appearance}-reports.png` });
      await page.locator('a.report-entry-link').click();
      await expect(page.locator('#reportDetails')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      await expect(page.locator('#reportDetails')).toContainText('Preserved theme regression report');
      if (await page.locator('.portal-mobile-header').isVisible()) await page.getByRole('button', { name: 'Citizen account', exact: true }).click();
      await expect(page.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: `${artifactRoot}/theme-results/${info.project.name}-${appearance}-details.png`, fullPage: true });
      await page.getByRole('button', { name: 'Enlarge submitted evidence photo 1', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.screenshot({ path: `${artifactRoot}/theme-results/${info.project.name}-${appearance}-evidence.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Enlarge map', exact: true }).click();
      await expect(page.locator('#mapWrap')).toHaveClass(/is-expanded/);
      await page.getByRole('button', { name: 'Close location map', exact: true }).click();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      const session = sessions.get(page);
      const response = await request.get(`/api/reports/${report.id}`, { headers: { Authorization: `Bearer ${session.apiToken}` } });
      const body = await response.json();
      const persisted = body.report || body;
      expect(persisted.originalAi).toEqual(report.originalAi);
      expect(persisted.citizenCategory).toBe(report.citizenCategory);
      expect(persisted.description).toBe(report.description);
    });
  }

  test('theme: first-render theme is resolved before body paint and survives actual refresh and navigation', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(key => {
      if (!sessionStorage.getItem('theme_test_initialized')) {
        localStorage.setItem(key, 'dark');
        sessionStorage.setItem('theme_test_initialized', '1');
      }
      const observer = new MutationObserver(() => {
        if (document.body && !window.firstBodyTheme) {
          window.firstBodyTheme = document.documentElement.dataset.theme;
          observer.disconnect();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }, key);
    await page.goto('/citizen.html');
    expect(await page.evaluate(() => window.firstBodyTheme)).toBe('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await choose(page, 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => window.firstBodyTheme)).toBe('light');
  });

  test('theme: automatic follows system changes and manual selection remains an override', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/citizen.html');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await choose(page, 'auto');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await choose(page, 'light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await choose(page, 'auto');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('auto');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('theme: switching keeps evidence, manual correction, description, and the Leaflet instance intact', async ({ page, request }) => {
    await request.post('/__phase2_mode', { data: { mode: 'broken_streetlight' } });
    await page.goto('/citizen.html');
    await expectLiveMapTiles(page);
    await page.locator('#description').fill('Keep manual correction and both evidence images.');
    await page.locator('#imgInput').setInputFiles(getPhotos().map((buffer, index) => ({ name: `theme-${index}.png`, mimeType: 'image/png', buffer })));
    await expect(page.locator('#citizenCategory')).toBeEnabled();
    await page.locator('#citizenCategory').selectOption('Road Damage');
    await expect(page.locator('#visionDetectBox [data-assessment-state]')).toHaveAttribute('data-assessment-state', 'DETECTED');
    await page.evaluate(() => {
      window.themeIdentity = {
        map: document.getElementById('geoCanvas'),
        mapId: document.getElementById('geoCanvas')._leaflet_id,
        form: document.getElementById('reportForm'),
        photos: [...document.querySelectorAll('#imgPreviewGrid img')].map(image => image.src),
        gps: JSON.stringify(getDetectedGPS()),
        original: document.getElementById('visionDetectBox').innerHTML,
        session: sessionStorage.getItem('up_session')
      };
    });
    for (const value of ['light', 'dark', 'auto']) await choose(page, value);
    expect(await page.evaluate(() => {
      const state = window.themeIdentity;
      return state.map === document.getElementById('geoCanvas') && state.mapId === document.getElementById('geoCanvas')._leaflet_id
        && state.form === document.getElementById('reportForm')
        && JSON.stringify(state.photos) === JSON.stringify([...document.querySelectorAll('#imgPreviewGrid img')].map(image => image.src))
        && state.gps === JSON.stringify(getDetectedGPS()) && state.original === document.getElementById('visionDetectBox').innerHTML
        && state.session === sessionStorage.getItem('up_session');
    })).toBe(true);
    await expect(page.locator('#description')).toHaveValue('Keep manual correction and both evidence images.');
    await expect(page.locator('#citizenCategory')).toHaveValue('Road Damage');
  });

  test('theme: actual cross-tab changes synchronize appearance without sharing authentication or losing form text', async ({ page, context }) => {
    await page.goto('/citizen.html');
    await page.locator('#description').fill('Keep this tab-specific citizen description.');
    const second = await context.newPage();
    const failures = [];
    second.on('pageerror', error => failures.push(error.message));
    await second.addInitScript(session => {
      sessionStorage.setItem('up_session', JSON.stringify(session));
      Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
    }, sessions.get(page));
    await second.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1') return route.abort();
      if (url.pathname === '/api/config/reverse-geocode') return route.fulfill({ json: { ok: true, data: { display_name: 'Bacolod City', address: { city: 'Bacolod City' } } } });
      return route.continue();
    });
    try {
      await second.goto('/citizen.html');
      await choose(page, 'dark');
      await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(second.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true })).toBeChecked();
      await choose(second, 'light');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true })).not.toBeChecked();
      await expect(page.locator('#description')).toHaveValue('Keep this tab-specific citizen description.');
      await expect(second.locator('#description')).toHaveValue('');
      expect(failures).toEqual([]);
    } finally { await second.close(); }
  });

  test('theme: blocked storage permits in-memory appearance; restored storage permits existing logout', async ({ page }) => {
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
      window.themeStorageDescriptor = descriptor;
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } });
    });
    await page.goto('/citizen.html');
    await choose(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.evaluate(() => Object.defineProperty(window, 'localStorage', window.themeStorageDescriptor));
    if (await page.locator('.portal-mobile-header').isVisible() && !await page.locator('#citizenAccountMenu').isVisible()) {
      await page.getByRole('button', { name: 'Citizen account', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(/login\.html$/);
  });

  for (const role of ['citizen', 'admin', 'barangay']) {
    test(`theme: ${role} defaults to light on dark systems and preserves saved dark mode across pages`, async ({ page, baseURL }) => {
      let session = sessions.get(page);
      if (role !== 'citizen') {
        const admin = await adminSession(baseURL);
        const login = role === 'admin' ? admin : await createOfficial(baseURL, admin.token, 'Barangay 1', 'theme_default');
        session = { ...login.user, apiToken: login.token };
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (document.body && !window.firstBodyTheme) {
            window.firstBodyTheme = document.documentElement.dataset.theme;
            observer.disconnect();
          }
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      await page.goto(role === 'citizen' ? '/login.html' : `/${role}-login.html`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await page.evaluate(() => window.firstBodyTheme)).toBe('light');
      await page.evaluate(session => sessionStorage.setItem('up_session', JSON.stringify(session)), session);
      await page.goto(`/${role}.html`);
      await expect(page).toHaveURL(new RegExp(`/${role}\\.html$`));
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await page.evaluate(() => window.firstBodyTheme)).toBe('light');
      expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
      expect(await page.evaluate(() => PortalTheme.getPreference())).toBe('light');
      await expect(page.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true })).toHaveCount(1);
      await page.evaluate(() => PortalTheme.setPreference('dark'));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await page.evaluate(() => window.firstBodyTheme)).toBe('dark');
      await page.goto('/report-details.html?id=1');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await page.evaluate(() => window.firstBodyTheme)).toBe('dark');
    });
  }
};
