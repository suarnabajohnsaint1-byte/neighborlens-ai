const { addReportGps } = require('../support/citizens');
const { test, expect } = require('../support/isolated-browser-fixture');
const { adminSession, createOfficial } = require('../support/accounts');
const { PNG_BYTES, JPEG_BYTES } = require('../support/image-fixtures');
const fs = require('node:fs/promises');
const sharp = require('sharp');
let admin, official, owner, outside, reports = [], post, photos;
const libraries = new Map();
// Keep repeated viewport fixtures below the real API request limit.
let nextApiRequestAt = 0;

test.beforeAll(async ({ baseURL, request }) => {
    admin = await adminSession(baseURL);
    official = await createOfficial(baseURL, admin.token, 'Villamonte', 'shared_ui');
    outside = await createOfficial(baseURL, admin.token, 'Mandalagan', 'shared_outside');
    const response = await request.post('/__fixture_citizen', { data: { username: `shared_owner_${Date.now()}`, password: 'Fixture1234', barangay: 'Villamonte' } });
    expect(response.status()).toBe(201); owner = await response.json();
    photos = await Promise.all(['data/raw/damages_road/11.jpg', 'data/raw/street_light/1.jpg'].map(async (path, index) => {
        const source = await fs.readFile(path).catch(() => index ? JPEG_BYTES : PNG_BYTES);
        return sharp(source).resize(index ? 540 : 800, index ? 900 : 500, { fit: 'cover' }).jpeg().toBuffer();
    }));
    for (const path of ['leaflet@2.0.0-beta.5/dist/leaflet-global.js', 'leaflet@2.0.0-beta.5/dist/leaflet.css', 'echarts@6.1.0/dist/echarts.min.js']) {
        const response = await fetch('https://cdn.jsdelivr.net/npm/' + path); expect(response.ok).toBe(true);
        libraries.set('/npm/' + path, { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') });
    }
    for (let index = 0; index < 7; index++) {
        const form = new FormData();
        const location = index < 4 ? 'YLAC Avenue, Purok 2, Villamonte, Bacolod City, 6100, Philippines' : index === 6 ? '10.66850, 122.96470' : 'Villamonte';
        for (const [key, value] of Object.entries({ barangay: 'Villamonte', location, description: `Shared fixture ${index}: Surface damage needs inspection. <script>window.injected=true</script>`, citizenCategory: index % 2 ? 'Street Light Damage' : 'Road Damage', latitude: '10.6685', longitude: '122.9647', gpsAccuracy: '15' })) form.append(key, value);
        addReportGps(form, 'Villamonte');
        photos.forEach((buffer, n) => form.append('images', new Blob([buffer], { type: 'image/jpeg' }), `evidence-${n}.jpg`));
        const result = await fetch(baseURL + '/api/reports', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
        expect(result.status).toBe(201); reports.push(await result.json());
    }
    const proof = new FormData(); proof.append('status', 'ongoing'); proof.append('note', 'Inspection in progress'); proof.append('requestKey', crypto.randomUUID()); proof.append('images', new Blob([photos[0]], { type: 'image/jpeg' }), 'progress.jpg');
    expect((await fetch(`${baseURL}/api/reports/${reports[0].id}/status`, { method: 'PATCH', headers: { Authorization: `Bearer ${official.token}` }, body: proof })).status).toBe(200);
    expect((await request.post(`/api/admin/community-publications/${reports[0].id}/decision`, { headers: { Authorization: `Bearer ${admin.token}` }, data: { state: 'approved', version: reports[0].publication.version } })).status()).toBe(200);
    post = (await (await request.get('/api/community/posts', { headers: { Authorization: `Bearer ${owner.token}` } })).json()).posts[0];
    await fs.mkdir('.data/shared-reports/screenshots', { recursive: true });
});

async function session(page, who, path, theme = 'light') {
    await page.addInitScript(({ who, theme }) => {
        sessionStorage.setItem('up_session', JSON.stringify({ ...who.user, apiToken: who.token }));
        for (const key of ['neighborlens_admin_report_layout', 'neighborlens_report_layout']) if (!localStorage.getItem(key)) localStorage.setItem(key, 'grid');
        Object.defineProperty(window, 'NEIGHBORLENS_API_BASE_URL', { configurable: true, get: () => location.origin, set() {} });
        window.addEventListener('DOMContentLoaded', () => window.PortalTheme?.setPreference(theme), { once: true });
    }, { who, theme });
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        const library = libraries.get(url.pathname) || libraries.get('/npm' + url.pathname);
        if (['unpkg.com', 'cdn.jsdelivr.net'].includes(url.hostname) && library) return route.fulfill(library);
        if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ body: PNG_BYTES, contentType: 'image/png' });
        if (url.hostname !== '127.0.0.1') return route.abort();
        if (url.pathname.startsWith('/api/')) {
            const wait = Math.max(0, nextApiRequestAt - Date.now());
            nextApiRequestAt = Date.now() + wait + 125;
            if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        }
        return route.continue();
    });
    await page.goto(path);
}
async function imagesReady(node) {
    await expect.poll(() => node.locator('img[data-evidence-url]').evaluateAll(images => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
}

test('desktop Citizen and Admin login forms scroll independently of the left panel', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 600 });
    for (const path of ['/login.html', '/admin-login.html']) {
        await page.goto(path);
        const layout = await page.locator('.rl-panel').evaluate(panel => {
            const features = document.querySelector('.rl-features');
            const top = features.getBoundingClientRect().top;
            panel.scrollTop = panel.scrollHeight;
            return { scrolled: panel.scrollTop > 0, leftStayed: top === features.getBoundingClientRect().top };
        });
        expect(layout).toEqual({ scrolled: true, leftStayed: true });
    }
});

test('Admin and Barangay share report summary icon sizes, status colors and compact layouts', async ({ browser, baseURL }) => {
    const snapshots = {};
    for (const { role, who, section } of [{ role: 'admin', who: admin, section: 'overview' }, { role: 'barangay', who: official, section: 'reports' }]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try {
            await session(page, who, `${baseURL}/${role}.html#${section}`);
            const summary = page.locator('[data-report-summary]');
            const cards = summary.locator('.portal-report-stat');
            await expect(cards).toHaveCount(6);
            for (const width of [1440, 360]) {
                await page.setViewportSize({ width, height: 900 });
                for (const theme of ['light', 'dark']) {
                    await page.evaluate(theme => PortalTheme.setPreference(theme), theme);
                    expect(await summary.evaluate(el => el.scrollWidth === el.clientWidth)).toBe(true);
                    const icons = await cards.evaluateAll(nodes => nodes.map(card => {
                        const icon = card.querySelector('.portal-report-stat-icon');
                        const style = getComputedStyle(icon, '::before');
                        const { y, height } = icon.getBoundingClientRect();
                        const bounds = card.getBoundingClientRect();
                        return { metric: card.dataset.metric, mask: style.maskImage, color: style.backgroundColor, height, cardHeight: bounds.height,
                            centered: Math.abs(y + height / 2 - bounds.y - bounds.height / 2) < 1 };
                    }));
                    expect(icons.every(icon => icon.centered && icon.mask.includes('data:image/svg+xml'))).toBe(true);
                    const common = icons.filter(icon => !['ongoing', 'pendingPosts'].includes(icon.metric));
                    if (role === 'admin') snapshots[`${width}-${theme}`] = common;
                    else expect(common).toEqual(snapshots[`${width}-${theme}`]);
                    if (theme === 'dark') {
                        const tokens = await summary.evaluate(element => {
                            const style = getComputedStyle(element);
                            return ['--color-bg', '--color-sidebar', '--color-surface', '--color-text-primary', '--color-primary', '--report-category-pothole']
                                .map(token => style.getPropertyValue(token).trim().toLowerCase());
                        });
                        expect(tokens).toEqual(['#080b10', '#090d14', '#141926', '#e8edf5', '#087af8', '#fb923c']);
                }
                }
            }
            if (role === 'admin') {
                await page.getByRole('button', { name: /Total reports/ }).click();
                await expect(page).toHaveURL(/#reports$/);
            }
        } finally { await page.close(); }
    }
});

test('Admin phone sections share aligned headers, controls, pagination and GIS legend', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await session(page, admin, `${baseURL}/admin.html#overview`);
    async function checkHeader(title) {
        await expect(page.locator('#adminPageTitle')).toHaveText(title);
        const [heading, description, menu, bell] = await Promise.all([
            '#adminPageTitle', '#adminPageDescription', '#adminMenuButton', '.notification-bell-btn'
        ].map(selector => page.locator(selector).boundingBox()));
        expect(Math.abs(menu.y - bell.y)).toBeLessThan(1);
        expect(menu.height).toBe(44);
        expect(bell.height).toBe(44);
        expect(heading.y).toBeLessThan(menu.y + menu.height);
        expect(description).toBeNull();
        expect(heading.x).toBeGreaterThanOrEqual(menu.x + menu.width);
        expect(heading.x + heading.width).toBeLessThanOrEqual(bell.x);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await checkHeader('Analytics');
    const stats = page.locator('#adminAnalytics [data-analytics-totals]');
    await expect(stats).toBeVisible();
    expect(await stats.evaluate(el => el.scrollWidth === el.clientWidth)).toBe(true);
    await page.evaluate(() => showAdminSection('accountsSection'));
    await checkHeader('Barangay Management');
    await expect(page.locator('#addAdminBtn')).toBeVisible();
    const accountButtons = await page.locator('#accountsSection .portal-action-grid > button:visible').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    expect(accountButtons).toEqual([44, 44, 44]);
    await page.evaluate(() => showAdminSection('logsSection'));
    await checkHeader('System Activity Logs');
    await expect(page.locator('#auditPageNumber')).toHaveText(/Page 1 of /);
    const arrows = await page.locator('#logsSection .portal-page-buttons').boundingBox();
    expect(arrows.width).toBeLessThan(220);
    expect(Math.abs(arrows.x + arrows.width / 2 - 180)).toBeLessThan(1);
    await page.evaluate(() => showAdminSection('reportsSection'));
    await checkHeader('All Reports');
    await expect(page.locator('#adminSearch')).toHaveAttribute('placeholder', 'Search reports');
    const actions = page.locator('.rm-actions:visible');
    await expect(actions).toHaveCSS('display', 'grid');
    const actionWidths = await actions.locator(':scope > button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
    expect(Math.max(...actionWidths) - Math.min(...actionWidths)).toBeLessThan(1);
    const viewButtons = await page.locator('.rm-actions .portal-view-btn:visible').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    expect(viewButtons).toEqual([36, 36, 36, 36]);
    expect(await actions.locator('.portal-view-btn').evaluateAll(buttons => new Set(buttons.map(button => button.offsetTop)).size)).toBe(1);
    const date = page.locator('#adminFilterDateFrom');
    await expect(date).toBeHidden();
    await page.locator('[data-sheet-open="reportFilters"]').click();
    await expect(date).toBeVisible();
    await date.fill('2020-01-01');
    await page.locator('#reportFilters [data-sheet-apply]').click();
    await expect(date).toBeHidden();
    await expect(date).toHaveValue('2020-01-01');
    await page.evaluate(() => showAdminSection('gisMapSection'));
    await checkHeader('GIS Map');
    const legend = page.locator('#adminGisLegend');
    await expect(legend.locator(':scope > span')).toHaveCount(6);
    const styles = await legend.locator(':scope > span').evaluateAll(items => items.map(item => ({
        font: getComputedStyle(item).fontSize,
        width: item.firstElementChild.getBoundingClientRect().width,
        mask: getComputedStyle(item.firstElementChild).maskImage
    })));
    expect(new Set(styles.map(style => style.font))).toEqual(new Set(['13px']));
    expect(styles.every(style => style.width === 16 && style.mask.includes('data:image/svg+xml'))).toBe(true);
    await expect(page.locator('#adminGisMapCanvas .leaflet-control-zoom-in .bx-plus')).toBeVisible();
});

for (const role of ['admin', 'barangay']) {
    test(`${role} GIS shows the selected outline on OpenStreetMap`, async ({ page, baseURL }) => {
        const viewport = { width: role === 'admin' ? 1440 : 390, height: 850 };
        await page.setViewportSize(viewport);
        await session(page, role === 'admin' ? admin : official, `${baseURL}/${role}.html#gis-map`);
        const outline = page.locator('.bacolod-city-outline');
        const area = page.locator('.bacolod-barangay-outline');
        const locator = page.getByRole('group', { name: 'Map area' });
        const select = locator.getByLabel('Barangay');
        const cluster = page.getByRole('button', { name: /^7 reports in Villamonte:/ });
        await expect(outline).toHaveCount(1);
        await expect(select.locator('option')).toHaveCount(62);
        await expect(cluster).toBeVisible();
        await expect(select).toHaveValue('');
        await expect(area).toHaveCount(0);
        await expect(locator.getByRole('button')).toHaveCount(0);
        await select.selectOption('villamonte');
        await expect(area).toHaveCount(1);
        await expect(page.locator('.leaflet-tile-loaded[src*="tile.openstreetmap.org"]').first()).toBeVisible();
        await expect(locator).toContainText('Showing Villamonte');
        const status = await locator.getByText('Showing Villamonte').boundingBox();
        const field = await select.boundingBox();
        expect(Math.abs(status.y + status.height / 2 - field.y - field.height / 2)).toBeLessThan(1);
        const color = await locator.getByText('Showing Villamonte').evaluate(element => element.style.getPropertyValue('--gis-area-color'));
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        await expect.poll(() => cluster.evaluate(element => element.style.getPropertyValue('--gis-area-color'))).toBe(color);
        const expand = page.getByRole('button', { name: 'Open fullscreen map' });
        await expect(page.locator('.leaflet-top.leaflet-right').getByRole('button', { name: 'Open fullscreen map' })).toBeVisible();
        await expand.click();
        const dialog = page.getByRole('dialog', { name: 'GIS Map' });
        expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
        await expect(dialog.locator('.bacolod-city-outline')).toHaveCount(1);
        await expect(dialog.locator('.bacolod-barangay-outline')).toHaveCount(1);
        await select.selectOption('mandalagan');
        await expect(locator).toContainText('Showing Mandalagan');
        await expect(area).toHaveCount(1);
        await expect(cluster).toHaveCount(0);
        await select.selectOption('');
        await expect(area).toHaveCount(0);
        await expect(dialog.locator('.leaflet-tile-loaded[src*="tile.openstreetmap.org"]').first()).toBeVisible();
        await expect(cluster).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(expand).toBeFocused();
        await expect(outline).toBeVisible();
    });
}

test('staff can read and print filtered reports on desktop and mobile', async ({ browser, baseURL }) => {
    for (const { role, who, width } of [
        { role: 'admin', who: admin, width: 1440 },
        { role: 'barangay', who: official, width: 320 }
    ]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await session(page, who, `${baseURL}/${role}.html#reports`, role === 'barangay' ? 'dark' : 'light');
            const barangay = role === 'barangay';
            const originalTitle = await page.title();
            const print = page.getByRole('button', { name: 'Print all', exact: true });
            await expect(print).toBeEnabled();
            await page.getByRole('button', { name: 'Compact view', exact: true }).click();
            const list = page.locator('.rm-report-cards[data-layout="text"]');
            const compactCard = list.locator('.report-card--compact').first();
            await expect(compactCard).toBeVisible();
            await imagesReady(compactCard);
            const thumbnail = await compactCard.locator('img').boundingBox();
            expect(thumbnail.width).toBe(64);
            expect(thumbnail.height).toBe(72);
            await page.evaluate(() => { window.printCalls = 0; window.print = () => { window.printCalls++; }; });
            const waitForPrint = count => expect.poll(() => page.evaluate(() => window.printCalls), { intervals: [100] }).toBe(count);
            if (barangay) {
                const menu = await page.locator('#barangayMenu').boundingBox();
                const bell = await page.locator('.notification-bell-btn').boundingBox();
                expect(menu.y).toBe(bell.y);
                expect(menu.height).toBe(bell.height);
            }
            await page.getByRole('combobox', { name: 'Reports per page' }).selectOption('3');
            await expect(list.locator('.report-card--compact')).toHaveCount(3);
            await print.click();
            await waitForPrint(1);
            const printSection = page.locator('.rm-print-section');
            if (barangay) {
                await expect(page.locator('#barangayPrintSummary, [data-print-confirm]')).toHaveCount(0);
                await expect(printSection).toContainText('7 matching reports');
                await expect(printSection.locator('.rm-breakdown li').first()).toHaveText('Road Damage4');
                await expect(printSection).toContainText('57.1%');
                await expect(printSection).toContainText('42.9%');
            }
            await expect(printSection.locator('article')).toHaveCount(7);
            await page.evaluate(() => dispatchEvent(new Event('afterprint')));
            const status = page.locator('.rm-tabs button[data-report-status="ongoing"]');
            await status.click();
            await expect(list.locator('.report-card--compact')).toHaveCount(1);
            await expect(list).toContainText('Ongoing');
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

            await print.click();
            await waitForPrint(2);
            if (barangay) await expect(printSection).toContainText('1 matching report');
            await expect(printSection).toBeHidden();
            await page.emulateMedia({ media: 'print' });
            await expect(printSection).toBeVisible();
            await expect(printSection.locator('article')).toHaveCount(1);
            await expect(printSection).toContainText('Ongoing');
            await expect(printSection).toContainText('<script>window.injected=true</script>');
            await expect(printSection).toContainText('Inspection in progress');
            await expect(printSection).toContainText('Damage category');
            await expect(printSection).toContainText('YLAC Avenue, Purok 2, Villamonte, Bacolod City, 6100, Philippines');
            await expect(printSection).not.toContainText(/Latitude|Longitude|GPS accuracy|10\.66850|122\.96470|YOLO|Confidence/);
            await expect(printSection.locator('article')).toHaveCSS('border-top-width', '0px');
            if (barangay) await expect(printSection).toContainText('Purok 2');
            else {
                await expect(printSection).toContainText('Published to Community Feed');
                await expect(printSection).toContainText(owner.user.username);
            }
            await expect(printSection.getByAltText('Evidence photo', { exact: false })).toHaveCount(2);
            await expect(printSection.getByAltText('Proof of action 1')).toBeVisible();
            await imagesReady(printSection);
            const first = await printSection.getByAltText('Evidence photo 1').boundingBox();
            const second = await printSection.getByAltText('Evidence photo 2').boundingBox();
            expect(first.y).toBe(second.y);
            expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
            expect(first.height).toBeCloseTo(second.height);
            expect(second.height).toBeGreaterThan(230);
            expect(second.height).toBeLessThan(260);
            await expect(page).toHaveTitle(barangay ? 'Barangay Villamonte - Barangay reports' : 'NeighborLens AI - All Reports');
            await expect(printSection.locator('.rm-print-brand')).toHaveText('NeighborLens AI');
            await expect(printSection.locator('.rm-print-brand img')).toHaveCount(0);
            await expect(printSection.locator('button, a, script')).toHaveCount(0);
            await expect(page.locator('.report-management')).toBeHidden();
            await page.screenshot({ path: `.data/shared-reports/screenshots/${role}-report-print.png`, fullPage: true });
            const pdf = await page.pdf({ format: barangay ? 'Letter' : 'A4', displayHeaderFooter: true,
                path: `.data/shared-reports/screenshots/${role}-report-print.pdf` });
            const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b/g);
            expect(pages.length).toBeLessThanOrEqual(2);
            await page.evaluate(() => dispatchEvent(new Event('afterprint')));
            await expect(printSection).toHaveCount(0);
            await expect(page).toHaveTitle(originalTitle);
            await page.emulateMedia({ media: 'screen' });
            await page.locator('.rm-tabs button[data-report-status="all"]').click();
            await page.getByRole('searchbox', { name: /search reports|search keyword/i }).fill('Shared fixture 6');
            const card = list.locator(`.report-card--compact[data-report-id="${reports[6].id}"]`);
            const id = await card.getAttribute('data-report-id');
            await card.getByRole('button', { name: `Print report ${id}`, exact: true }).click();
            await waitForPrint(3);
            await expect(page).toHaveTitle(barangay ? 'Barangay Villamonte - Report details' : 'NeighborLens AI - Report details');
            await expect(printSection.locator('article')).toHaveCount(1);
            await expect(printSection.locator('article')).toHaveAttribute('data-report-id', id);
            await expect(printSection).toContainText('Street address not recorded.');
            await expect(printSection).not.toContainText('10.66850, 122.96470');
            await page.evaluate(() => dispatchEvent(new Event('afterprint')));
            await page.route(`**/api/reports/${id}/history`, route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
            await card.getByRole('button', { name: `Print report ${id}`, exact: true }).click();
            await expect(page.locator('.rm-print-feedback')).toContainText(`Report #${id} activity could not be loaded`);
            await expect(printSection).toHaveCount(0);
            await waitForPrint(3);
            await expect(card).toHaveCSS('cursor', 'pointer');
            await card.click({ position: { x: 2, y: 2 } });
            await expect(page).toHaveURL(new RegExp(`report-details\\.html\\?id=${id}$`));
        } finally {
            await page.close();
        }
    }
});

async function zoom(page, container, selector = '.rd-photo') {
    const trigger = container.locator(selector).first(); await imagesReady(trigger);
    await trigger.click();
    const dialog = page.locator('.rd-dialog[open]'); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('125%');
    await dialog.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
}

test('community actions derive from backend permissions and support keyboard, refresh and own comments', async ({ browser, baseURL, request }) => {
    for (const [role, who] of [['citizen', owner], ['barangay', official]]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        try {
            await session(page, who, `${baseURL}/${role}.html#community`);
            const card = page.locator(`[data-post-id="${post.id}"]`); await expect(card).toBeVisible();
            const trigger = card.getByRole('button', { name: 'Manage your post', exact: true });
            if (role === 'barangay') {
                const status = page.getByLabel('Report status', { exact: true });
                await status.selectOption('rejected');
                await expect(card).toHaveCount(0);
                await status.selectOption('ongoing');
                await expect(card).toBeVisible();
                const oldest = page.waitForResponse(response => new URL(response.url()).searchParams.get('sort') === 'oldest');
                await page.getByRole('tab', { name: 'Oldest', exact: true }).click();
                expect((await oldest).ok()).toBe(true);
                await expect(page.getByRole('tab', { name: 'Oldest', exact: true })).toHaveAttribute('aria-selected', 'true');
                await expect(card.locator('[data-action="post-options"], button[aria-label="Post options"]')).toHaveCount(0);
                expect((await request.delete(`/api/community/posts/${post.id}`, { headers: { Authorization: `Bearer ${who.token}` } })).status()).toBe(403);
            } else {
                await trigger.focus(); await page.keyboard.press('Enter'); await expect(trigger).toHaveAttribute('aria-expanded', 'true');
                const menu = card.getByRole('menu', { name: 'Post actions' }); await expect(menu).toBeVisible();
                const bounds = await menu.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
                await expect(menu.getByRole('menuitem', { name: 'Delete post', exact: true })).toBeFocused();
                await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute('aria-expanded', 'false');
                await trigger.click(); await card.locator('h3').click(); await expect(menu).toBeHidden();
                await page.evaluate(() => CommunityFeed.refresh()); await trigger.click(); await expect(menu).toBeVisible(); await page.keyboard.press('Escape');
                await trigger.click();
                await page.screenshot({ path: '.data/shared-reports/screenshots/citizen-menu-mobile.png' });
                await page.keyboard.press('Escape');
            }
            await card.locator('[data-action="comments"]').click();
            const body = `Own comment ${role}`; await card.locator('.cf-comment-form input').fill(body); await card.locator('.cf-comment-form button[type="submit"]').click();
            const comment = card.locator('.cf-comment').filter({ has: page.locator('.cf-comment-body', { hasText: body }) });
            await expect(comment.getByRole('button', { name: 'Edit', exact: true })).toBeVisible(); await expect(comment.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
            await comment.getByRole('button', { name: 'Edit', exact: true }).click();
            await page.locator('#communityEditDialog textarea').fill(body + ' edited');
            await page.locator('#communityEditDialog button[type="submit"]').click();
            await expect(comment.locator('.cf-comment-body')).toHaveText(body + ' edited');
            await comment.getByRole('button', { name: 'Delete', exact: true }).click();
            await page.locator('#communityEditDialog button[type="submit"]').click();
            await expect(card.locator('.cf-comment-body').filter({ hasText: body })).toHaveCount(0);
        } finally { await page.close(); }
    }
    expect((await request.get(`/api/reports/${reports[0].id}`, { headers: { Authorization: `Bearer ${outside.token}` } })).status()).toBe(403);
    const otherResponse = await request.post('/__fixture_citizen', { data: { username: `other_owner_${Date.now()}`, password: 'Fixture1234', barangay: 'Villamonte' } });
    const other = await otherResponse.json();
    expect((await request.delete(`/api/community/posts/${post.id}`, { headers: { Authorization: `Bearer ${other.token}` } })).status()).toBe(403);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
        await session(page, owner, `${baseURL}/citizen.html#community`);
        const card = page.locator(`[data-post-id="${post.id}"]`);
        await card.locator('[data-action="post-options"]').click();
        await page.screenshot({ path: '.data/shared-reports/screenshots/citizen-menu-desktop.png' });
        let deletes = 0; page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/community/posts/${post.id}`) deletes++; });
        await card.locator('[data-action="delete"]').click();
        await page.locator('#communityEditDialog button[type="submit"]').click();
        await expect(card).toHaveCount(0); expect(deletes).toBe(1);
    } finally { await page.close(); }
});

for (const width of [1440, 768, 390, 375, 1280, 1671]) for (const theme of ['light', 'dark']) {
    test(`shared reports ${width} ${theme}: equivalent cards, controls, details and zoom`, async ({ browser, baseURL }) => {
        const measurements = [], columnMeasurements = [];
        for (const [role, who, path] of [['admin', admin, '/admin.html#reports'], ['barangay', official, '/barangay.html']]) {
            const page = await browser.newPage({ viewport: { width, height: 1000 } });
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            try {
                await session(page, who, baseURL + path, theme);
                const section = page.locator(role === 'admin' ? '#reportsSection' : '.barangay-reports');
                const cards = section.locator('.rm-report-cards .report-card'); await expect(cards.first()).toBeVisible();
                await section.getByRole('combobox', { name: 'Reports per page', exact: true }).selectOption('10');
                await expect(cards).toHaveCount(7); await imagesReady(cards.first());
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
                measurements.push(await section.locator('.rm-toolbar .portal-search').evaluate(node => ({ height: node.getBoundingClientRect().height, input: getComputedStyle(node.querySelector('input')).fontSize })));
                await section.screenshot({ path: `.data/shared-reports/screenshots/${role}-${width}-${theme}-cards.png` });
                const search = section.locator('input[type="search"]'); await search.fill('Shared fixture 0'); await expect(cards).toHaveCount(1);
                await section.getByRole('button', { name: 'List view', exact: true }).click();
                const entries = width > 900 ? section.locator('.rm-table tbody [data-report-id]') : cards;
                await expect(entries).toHaveCount(1); await expect(search).toHaveValue('Shared fixture 0');
                await imagesReady(entries.first());
                if (width > 900) expect(await section.locator('.rm-table th').allTextContents()).toEqual(role === 'admin' ? ['Date', 'Photo', 'Issue', 'Barangay', 'Severity', 'Priority', 'Operational status', 'Publication status', 'Actions'] : ['Date', 'Photo', 'Issue', 'Severity', 'Priority', 'Operational status', 'Actions']);
                if (width > 900) columnMeasurements.push(await section.locator('.rm-table th').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.column, node.getBoundingClientRect().width]))));
                if (width > 900) expect(await section.locator('.rm-table th, .rm-table .rm-label').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
                await section.screenshot({ path: `.data/shared-reports/screenshots/${role}-${width}-${theme}-list.png` });
                await entries.first().locator('[data-action="view"]').click();
                await expect(page).toHaveURL(new RegExp(`/report-details\\.html\\?id=${reports[0].id}$`));
                const details = page.locator('#reportDetails');
                if (role === 'barangay') await expect(details.locator('.rd-damage-title')).toHaveText('Road Damage');
                else { await expect(details.locator('.rd-header h1')).toHaveText(`Report #${reports[0].id}`); await expect(details.locator('.rd-review-form, .rd-summary, .rd-severity')).toHaveCount(0); }
                await expect(details.locator('.rd-action-photo')).toHaveCount(1);
                await expect(page.locator('#adminReportDialog[open], #reportModal[open]')).toHaveCount(0);
                await zoom(page, details); await zoom(page, details, '.rd-action-photo');
                await page.evaluate(() => scrollTo(0, 0));
                await page.screenshot({ path: `.data/shared-reports/screenshots/${role}-${width}-${theme}-details.png` });
                await page.locator('#backToReports').click();
                await expect(search).toHaveValue('Shared fixture 0');
                await section.getByRole('button', { name: 'Split Detail view', exact: true }).click();
                await cards.first().locator('.report-card-title').click();
                if (role === 'barangay') await expect(section.locator('.rm-detail-pane .rd-damage-title')).toHaveText('Road Damage');
                else { await expect(section.locator('.rm-detail-pane .rd-header h1')).toHaveText(`Report #${reports[0].id}`); await expect(section.locator('.rm-detail-pane .rd-review-form, .rm-detail-pane .rd-summary')).toHaveCount(0); }
                await zoom(page, section.locator('.rm-detail-pane'));
                await cards.first().locator('[data-action="view"]').click();
                await expect(page).toHaveURL(new RegExp(`/report-details\\.html\\?id=${reports[0].id}$`));
                expect(await page.evaluate(() => window.injected)).not.toBe(true); expect(errors).toEqual([]);
            } finally { await page.close(); }
        }
        expect(measurements[0]).toEqual(measurements[1]);
        if (width > 900) for (const id of ['date', 'photo', 'classification', 'priority', 'status', 'actions']) expect(columnMeasurements[0][id]).toBeCloseTo(columnMeasurements[1][id], 0);
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        try {
            await session(page, owner, `${baseURL}/report-details.html?id=${reports[0].id}`, theme);
            const details = page.locator('#reportDetails'); await expect(details.locator('.rd-damage-title')).toHaveText('Road Damage');
            await expect(details.locator('.rd-review-form')).toHaveCount(0); await zoom(page, details); await zoom(page, details, '.rd-action-photo');
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: `.data/shared-reports/screenshots/citizen-${width}-${theme}-details.png`, fullPage: true });
        } finally { await page.close(); }
    });
}

test('shared table lifecycle preserves rows, switches layouts, exposes honest states and disposes delegated listeners', async ({ page, baseURL }) => {
    await session(page, admin, `${baseURL}/admin.html#reports`);
    await expect(page.locator('#adminReportCards .report-card').first()).toBeVisible();
    const result = await page.evaluate(report => {
        const section = document.createElement('section'), list = document.createElement('div'), views = document.createElement('div');
        views.innerHTML = ['grid', 'row', 'split'].map(mode => `<button data-view-mode="${mode}">${mode}</button>`).join('');
        section.append(views, list); document.body.append(section);
        let opens = 0;
        const config = { section, list, views, apiBase: neighborLensApiUrl('/'), columns: ReportManagement.portalColumns.barangay, storageKey: 'isolated-component-layout', onOpen: () => opens++ };
        const table = ReportManagement.createTable(config);
        const same = table === ReportManagement.createTable(config);
        table.render({ reports: [], status: 'loading' }); const loading = list.textContent;
        table.render({ reports: [], status: 'error' }); const error = list.textContent;
        table.render({ reports: [], status: 'ready' }); const empty = list.textContent;
        table.render({ reports: [report], status: 'ready' }); const card = list.firstElementChild;
        table.render({ reports: [report], status: 'loading' }); const identity = card === list.firstElementChild;
        card.querySelector('[data-action="view"]').click();
        views.querySelector('[data-view-mode="row"]').click(); const row = section.querySelector('tbody tr');
        const rowText = row.textContent; row.querySelector('[data-action="view"]').click();
        table.destroy(); const disposed = !section.querySelector('.rm-report-table') && !list.children.length;
        const again = ReportManagement.createTable(config); again.render({ reports: [report], status: 'ready' });
        views.querySelector('[data-view-mode="grid"]').click(); list.querySelector('[data-action="view"]').click();
        again.destroy(); section.remove();
        return { same, loading, error, empty, identity, rowText, disposed, opens };
    }, reports[0]);
    expect(result.same).toBe(true); expect(result.loading).toContain('Loading'); expect(result.error).toContain('unavailable'); expect(result.empty).toContain('No reports');
    expect(result.identity).toBe(true); expect(result.rowText).toContain('Road Damage'); expect(result.disposed).toBe(true); expect(result.opens).toBe(3);
});

test('an existing table replaces its static loading row when actual report data arrives', async ({ page, baseURL }) => {
    await session(page, admin, `${baseURL}/admin.html#reports`);
    await expect(page.locator('#adminReportCards .report-card').first()).toBeVisible();
    const result = await page.evaluate(report => {
        const section = document.createElement('section'), wrapper = document.createElement('div'), table = document.createElement('table'), list = document.createElement('div'), views = document.createElement('div');
        views.innerHTML = '<button data-view-mode="row">List</button>';
        table.innerHTML = '<tbody><tr><td>Loading placeholder</td></tr></tbody>';
        wrapper.append(table); section.append(views, wrapper, list); document.body.append(section);
        const component = ReportManagement.createTable({ section, list, table, views, columns: ReportManagement.portalColumns.admin, storageKey: 'qa-existing-table', apiBase: location.origin, onOpen() {} });
        views.firstElementChild.click();
        component.render({ reports: [report], status: 'ready' });
        const result = { rows: table.tBodies[0].rows.length, text: table.tBodies[0].textContent };
        component.destroy(); section.remove();
        return result;
    }, reports[0]);
    expect(result.rows).toBe(1); expect(result.text).not.toContain('Loading placeholder');
});

test('Admin preserves list query and pagination on reload, and the Pending Posts card opens the real review queue', async ({ page, baseURL }) => {
    await session(page, admin, `${baseURL}/admin.html#reports`);
    const section = page.locator('#reportsSection');
    await expect(section.locator('.report-card').first()).toBeVisible();
    await section.getByRole('combobox', { name: 'Reports per page', exact: true }).selectOption('3');
    await section.getByRole('button', { name: 'List view', exact: true }).click();
    await page.locator('#adminSearch').fill('Shared fixture');
    await expect(section.locator('.rm-table tbody [data-report-id]')).toHaveCount(3);
    await page.locator('#reportsNext').click(); await expect(page.locator('#reportsPageNumber')).toHaveText('Page 2 of 3');
    await page.reload();
    await expect(page.locator('#adminSearch')).toHaveValue('Shared fixture');
    await expect(page.locator('#reportsPageNumber')).toHaveText('Page 2 of 3');
    await expect(section.getByRole('combobox', { name: 'Reports per page', exact: true })).toHaveValue('3');
    await page.locator('#pendingPostsCard').click();
    await expect(page.locator('#adminReportsTitle')).toHaveText('Community Publication Review');
    await section.getByRole('combobox', { name: 'Reports per page', exact: true }).selectOption('10');
    await expect(section.locator('.rm-table tbody [data-report-id]')).toHaveCount(6);
    await expect(section.locator('th[data-column="date"]')).toHaveText('Requested');
    const viewAction = section.locator('[data-action="view"]').first();
    const reportId = await viewAction.locator('xpath=ancestor::tr').getAttribute('data-report-id');
    await viewAction.click();
    await expect(page).toHaveURL(new RegExp(`/report-details\\.html\\?id=${reportId}$`));
    await expect(page.locator('#reportDetails')).toBeVisible();
    await page.locator('#backToReports').click();
    await expect(page.locator('#adminReportsTitle')).toHaveText('Community Publication Review');
    const reviewAction = section.locator('[data-action="review"]').first();
    await expect(reviewAction.locator('.bx.bxs-file')).toHaveCount(1);
    await expect(reviewAction).toHaveClass(/rm-review-action/);
    await expect(reviewAction).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(page.locator('#statPendingPosts')).toHaveText('6');
    await imagesReady(reviewAction.locator('xpath=ancestor::tr'));
    await page.screenshot({ path: '.data/shared-reports/screenshots/admin-review-actions.png' });
    await reviewAction.click();
    const modal = page.locator('#adminReportDialog');
    await expect(modal.locator('.rd-publication')).toContainText('Pending Community Review');
    const claim = modal.getByRole('button', { name: 'Claim review', exact: true });
    if (await claim.isVisible()) await claim.click();
    await modal.getByRole('button', { name: 'Approve & Publish', exact: true }).click();
    await modal.locator('.portal-confirm').getByRole('button', { name: 'Approve & Publish', exact: true }).click();
    await expect(page.locator('#statPendingPosts')).toHaveText('5');
    await expect(modal.locator('.rd-publication')).toContainText('Published to Community Feed');
});
