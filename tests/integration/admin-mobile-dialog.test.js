const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ReportDialog = require('../../frontend/js/shared/reportDialog.js');
const ReportDetailsView = require('../../frontend/js/reports/reportDetailsView.js');
const ReportDetailsApi = require('../../frontend/js/shared/reportDetailsApi.js');
const PortalComponents = require('../../frontend/js/shared/portalComponents.js');

function element(attributes = {}, parent = null) {
  const listeners = new Map();
  const classes = new Set(String(attributes.class || '').split(' ').filter(Boolean));
  const node = {
    attributes: { ...attributes }, parent, hidden: false, textContent: '', isConnected: true, focused: 0,
    style: {}, dataset: {}, children: [],
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    getAttribute: name => node.attributes[name] ?? null,
    setAttribute: (name, value) => { node.attributes[name] = String(value); },
    removeAttribute: name => { delete node.attributes[name]; },
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)),
    dispatch(type, event = {}) { (listeners.get(type) || []).forEach(fn => fn({ type, target: node, preventDefault() { this.defaultPrevented = true; }, ...event })); },
    listenerCount: type => (listeners.get(type) || []).length,
    focus() { node.focused += 1; node.ownerDocument && (node.ownerDocument.activeElement = node); },
    replaceChildren() { node.children = []; },
    append(child) { node.children.push(child); },
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => {
        if (part.startsWith('.')) return classes.has(part.slice(1));
        const attribute = part.match(/^\[([\w-]+)\]$/);
        return Boolean(attribute && Object.hasOwn(node.attributes, attribute[1]));
      });
    },
    closest(selector) { let current = node; while (current) { if (current.matches(selector)) return current; current = current.parent; } return null; },
    querySelector(selector) {
      const stack = [...node.children];
      while (stack.length) { const child = stack.shift(); if (child.matches(selector)) return child; stack.push(...child.children); }
      return null;
    }
  };
  if (parent) parent.children.push(node);
  return node;
}

function dialogFixture({ role = 'admin' } = {}) {
  const document = { body: { style: { overflow: 'auto' } }, activeElement: null, defaultView: { scrollY: 480, scrolled: [], scrollTo(x, y) { this.scrolled.push(y); } } };
  const dialog = element();
  dialog.ownerDocument = document;
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatch('close'); };
  dialog.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 });
  const title = element({ 'data-report-dialog-title': '' }, dialog);
  const state = element({ 'data-report-dialog-state': '' }, dialog);
  const content = element({ 'data-report-dialog-content': '' }, dialog);
  const close = element({ 'data-report-dialog-close': '' }, dialog);
  [title, state, content, close].forEach(node => { node.ownerDocument = document; });
  const opener = element();
  opener.ownerDocument = document;
  const calls = { load: [], mount: [], destroyed: 0, fetch: [], reviewed: [] };
  let mapExpanded = false;
  let pending = null;
  const details = {
    signature: ReportDetailsView.signature,
    validId: ReportDetailsApi.validId,
    accessMessage: ReportDetailsApi.accessMessage,
    load: (id, options) => { calls.load.push({ id, options }); return pending ? pending.promise : Promise.resolve({ report: { id: Number(id) }, history: [], historyAvailable: true }); },
    mount: (container, data, options) => {
      calls.mount.push({ data, options });
      container.append(element());
      return { isMapExpanded: () => mapExpanded, collapseMap: () => { mapExpanded = false; }, destroy: () => { calls.destroyed += 1; container.replaceChildren(); } };
    }
  };
  let response = { ok: true, status: 200, json: async () => ({}) };
  const controller = ReportDialog.create({
    dialog, client: details, view: details, api: route => `http://api.test${route}`,
    session: () => ({ role, apiToken: 'token-1' }),
    fetchImpl: async (url, options) => { calls.fetch.push({ url, options }); return response; },
    mutate: async (id, status, note) => {
      calls.fetch.push({ url: `http://api.test/api/reports/${id}/status`, options: { method: 'PATCH', headers: { Authorization: 'Bearer token-1' }, body: JSON.stringify(note ? { status, note } : { status }) } });
      if (!response.ok) { const error = new Error('Denied'); error.status = response.status; throw error; }
      return response.json();
    },
    onReviewed: id => calls.reviewed.push(id)
  });
  return { controller, dialog, document, opener, content, state, title, close, calls,
    expandMap: () => { mapExpanded = true; },
    defer() { let resolve; pending = { promise: new Promise(done => { resolve = done; }) }; return value => { const current = pending; pending = null; resolve(value); return current.promise; }; },
    respond: value => { response = value; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('shared admin dialog loads the shared report view with admin review and prefixed ids', async () => {
  const app = dialogFixture();
  assert.equal(app.controller.open('21', app.opener), true);
  await flush();
  assert.equal(app.dialog.open, true);
  assert.equal(app.calls.load[0].id, '21');
  assert.equal(app.title.textContent, 'Report #21');
  const { options } = app.calls.mount[0];
  assert.equal(options.role, 'admin');
  assert.equal(options.idPrefix, 'dialogReport');
  assert.equal(options.showTitle, false);
  assert.equal(typeof options.onReview, 'function');
  assert.equal(app.document.body.style.overflow, 'hidden');
  assert.equal(app.state.hidden, true);
});

test('shared dialog passes the authenticated barangay role to shared capabilities', async () => {
  const app = dialogFixture({ role: 'barangay' });
  app.controller.open('5', app.opener);
  await flush();
  assert.equal(app.calls.mount[0].options.role, 'barangay');
});

test('closing restores scroll, body overflow and opener focus exactly once', async () => {
  const app = dialogFixture();
  app.controller.open('7', app.opener);
  await flush();
  app.close.dispatch('click');
  assert.equal(app.dialog.open, false);
  assert.equal(app.calls.destroyed, 1);
  assert.equal(app.content.children.length, 0);
  assert.equal(app.document.body.style.overflow, 'auto');
  assert.deepEqual(app.document.defaultView.scrolled, [480]);
  assert.equal(app.opener.focused, 1);
  app.dialog.dispatch('close');
  assert.equal(app.opener.focused, 1);
  assert.equal(app.controller.isOpen(), false);
});

test('escape collapses an expanded map before closing the dialog', async () => {
  const app = dialogFixture();
  app.controller.open('7', app.opener);
  await flush();
  app.expandMap();
  app.dialog.dispatch('cancel');
  assert.equal(app.dialog.open, true);
  app.dialog.dispatch('cancel');
  assert.equal(app.dialog.open, false);
  assert.equal(app.calls.destroyed, 1);
});

test('invalid report ids never open the dialog', () => {
  const app = dialogFixture();
  for (const id of [null, '', '0', 'abc', '1e3', '-4']) assert.equal(app.controller.open(id, app.opener), false);
  assert.equal(app.dialog.open, false);
  assert.equal(app.calls.load.length, 0);
});

test('a load that finishes after the dialog closed is discarded', async () => {
  const app = dialogFixture();
  const resolve = app.defer();
  app.controller.open('9', app.opener);
  app.controller.close();
  await resolve({ report: { id: 9 }, history: [], historyAvailable: true });
  await flush();
  assert.equal(app.calls.mount.length, 0);
  assert.equal(app.calls.load[0].options.signal.aborted, true);
});

test('opening another report while open replaces content without stacking dialogs', async () => {
  const app = dialogFixture();
  app.controller.open('1', app.opener);
  await flush();
  app.controller.open('2', app.opener);
  await flush();
  assert.equal(app.calls.destroyed, 1);
  assert.equal(app.content.children.length, 1);
  assert.equal(app.controller.current(), '2');
  app.controller.close();
  assert.equal(app.document.body.style.overflow, 'auto');
});

test('review saves through the authorized API, notifies the list and reloads the shared view', async () => {
  const app = dialogFixture();
  app.controller.open('12', app.opener);
  await flush();
  await app.calls.mount[0].options.onReview('resolved', 'Fixed');
  const [call] = app.calls.fetch;
  assert.equal(call.url, 'http://api.test/api/reports/12/status');
  assert.equal(call.options.method, 'PATCH');
  assert.equal(call.options.headers.Authorization, 'Bearer token-1');
  assert.deepEqual(JSON.parse(call.options.body), { status: 'resolved', note: 'Fixed' });
  assert.deepEqual(app.calls.reviewed, ['12']);
  assert.equal(app.calls.load.length, 2);
});

test('a denied review replaces the view with the access message', async () => {
  const app = dialogFixture();
  app.controller.open('12', app.opener);
  await flush();
  app.respond({ ok: false, status: 403, json: async () => ({}) });
  await app.calls.mount[0].options.onReview('ongoing', '');
  assert.equal(app.state.textContent, 'You do not have access to this report.');
  assert.equal(app.content.children.length, 0);
  assert.deepEqual(app.calls.reviewed, []);
});

test('the dialog delegates evidence loading instead of adding another renewal lifecycle', async () => {
  const app = dialogFixture();
  app.controller.open('12', app.opener);
  await flush();
  assert.equal(app.calls.mount[0].options.onImageError, undefined);
});

test('report links are parsed only for report details urls', () => {
  const link = href => ({ getAttribute: () => href });
  assert.equal(ReportDialog.reportIdFromLink(link('report-details.html?id=44')), '44');
  assert.equal(ReportDialog.reportIdFromLink(link('https://evil.test/report-details.html?id=44')), null);
  assert.equal(ReportDialog.reportIdFromLink(link('admin.html#reports')), null);
});

test('shared view loader enforces ids, sessions, access and identity', async () => {
  const api = route => `http://api.test${route}`;
  const session = { apiToken: 'token' };
  await assert.rejects(ReportDetailsApi.load('x', { api, session }), { status: 404, reportDetails: true });
  await assert.rejects(ReportDetailsApi.load('3', { api, session: null }), { status: 401 });
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
  await assert.rejects(ReportDetailsApi.load('3', { api, session, fetchImpl: async () => respond(403, {}) }), { message: 'You do not have access to this report.' });
  await assert.rejects(ReportDetailsApi.load('3', { api, session, fetchImpl: async () => respond(200, { id: 4, history: [] }) }), { message: 'Report details could not be verified.' });
  const seen = [];
  const data = await ReportDetailsApi.load('3', { api, session, fetchImpl: async (url, options) => { seen.push([url, options.headers.Authorization]); return url.endsWith('/history') ? respond(200, { history: [{ status: 'pending' }] }) : respond(200, { id: 3 }); } });
  assert.equal(data.report.id, 3);
  assert.equal(data.historyAvailable, true);
  assert.deepEqual(seen.map(([url]) => url), ['http://api.test/api/reports/3', 'http://api.test/api/reports/3/history']);
  assert.ok(seen.every(([, auth]) => auth === 'Bearer token'));
});

function sheetFixture(matches = true) {
  const handlers = {};
  const body = element();
  body.style = { overflow: '' };
  const document = { body, activeElement: null, handlers,
    defaultView: { matchMedia: () => ({ matches, addEventListener() {} }) },
    createElement: () => element(),
    addEventListener: (type, fn) => { handlers[type] = fn; } };
  const toolbar = element();
  const trigger = element({ 'data-sheet-open': 'reportFilters', class: 'portal-filter-toggle' }, toolbar);
  trigger.dataset.sheetOpen = 'reportFilters';
  const badge = element({ class: 'portal-filter-count' }, trigger);
  const sheet = element({ 'data-sheet': '', id: 'reportFilters' });
  sheet.id = 'reportFilters';
  const closeButton = element({ 'data-sheet-close': '' }, sheet);
  const clearButton = element({ 'data-sheet-clear': '' }, sheet);
  const applyButton = element({ 'data-sheet-apply': '' }, sheet);
  [trigger, closeButton, clearButton, applyButton, sheet].forEach(node => { node.ownerDocument = document; });
  document.getElementById = id => id === 'reportFilters' ? sheet : null;
  document.querySelectorAll = selector => selector === '[data-sheet-open="reportFilters"]' ? [trigger] : [];
  const cleared = [];
  const sheets = PortalComponents.sheets(document, { onClear: { reportFilters: () => cleared.push('reportFilters') } });
  const click = target => handlers.click({ target, preventDefault() {} });
  return { document, sheets, trigger, badge, sheet, closeButton, clearButton, applyButton, cleared, click, body };
}

test('filter sheet opens as a modal sheet, locks scroll and moves focus on mobile', () => {
  const app = sheetFixture();
  app.click(app.trigger);
  assert.equal(app.sheet.classList.contains('is-open'), true);
  assert.equal(app.sheet.getAttribute('role'), 'dialog');
  assert.equal(app.sheet.getAttribute('aria-modal'), 'true');
  assert.equal(app.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(app.body.style.overflow, 'hidden');
  assert.equal(app.closeButton.focused, 1);
  assert.equal(app.sheets.active(), 'reportFilters');
});

test('filter sheet clear runs the shared clear logic and apply closes with focus restored', () => {
  const app = sheetFixture();
  app.click(app.trigger);
  app.click(app.clearButton);
  assert.deepEqual(app.cleared, ['reportFilters']);
  assert.equal(app.sheets.active(), 'reportFilters');
  app.click(app.applyButton);
  assert.equal(app.sheets.active(), null);
  assert.equal(app.sheet.getAttribute('role'), null);
  assert.equal(app.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(app.body.style.overflow, '');
  assert.equal(app.trigger.focused, 1);
});

test('filter sheet closes on Escape and stays inline on desktop', () => {
  const app = sheetFixture();
  app.click(app.trigger);
  app.document.handlers.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(app.sheets.active(), null);
  const desktop = sheetFixture(false);
  desktop.click(desktop.trigger);
  assert.equal(desktop.sheets.active(), null);
  assert.equal(desktop.body.style.overflow, '');
});

test('filter sheet count badge announces active filters', () => {
  const app = sheetFixture();
  app.sheets.setCount('reportFilters', 2);
  assert.equal(app.badge.hidden, false);
  assert.equal(app.badge.textContent, '2');
  assert.equal(app.trigger.getAttribute('aria-label'), 'Filters, 2 active');
  app.sheets.setCount('reportFilters', 0);
  assert.equal(app.badge.hidden, true);
  assert.equal(app.trigger.getAttribute('aria-label'), 'Filters');
});

function adminApp() {
  const nodes = new Map();
  const handlers = {};
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, style: {}, dataset: {},
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, contains: () => false, closest: () => ({ hidden: false }), focus() {} });
    return nodes.get(id);
  };
  const opened = [];
  const session = { id: 9, username: 'admin', role: 'admin', barangay: '', apiToken: 'token-admin' };
  const values = new Map([['up_session', JSON.stringify(session)]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const location = { pathname: '/admin.html', href: 'http://127.0.0.1/admin.html#reports' };
  const context = vm.createContext({ console, URLSearchParams, localStorage: storage, sessionStorage: storage,
    getSession: () => session, fetch: async () => ({ ok: true, json: async () => ({ reports: [] }) }),
    document: { addEventListener: (type, fn) => { handlers[type] = fn; }, getElementById: id => id === 'logBox' ? null : node(id), querySelectorAll: () => [], querySelector: () => null },
    CustomEvent: class {}, setTimeout() {}, clearTimeout() {},
    window: { matchMedia: () => ({ matches: false }), ReportCard: require('../../frontend/js/shared/reportCard'), ReportVocabulary: require('../../shared/reportVocabulary'), ManilaDates: require('../../shared/manilaDates'), addEventListener() {}, dispatchEvent() {}, location, NEIGHBORLENS_API_BASE_URL: 'http://isolated.test',
      ReportDialog: { create: () => ({ open: (id, trigger) => { opened.push({ id, trigger }); return true; } }), reportIdFromLink: ReportDialog.reportIdFromLink },
      ReportDetailsView } });
  context.window.neighborLensApiUrl = route => `http://isolated.test${route}`;
  for (const file of ['shared/portalComponents.js', 'shared/reports.js', 'admin/admin_logic.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), context);
  }
  context.setupAdminReportDialog();
  return { context, node, opened, handlers, location };
}

function adminReport(id, status = 'pending') {
  return { id: `RPT_SRV_${id}`, backendId: id, description: `Report ${id}`, barangay: 'Villamonte', submittedById: 1,
    submittedBy: 'citizen', submittedByRole: 'citizen', status, createdAt: new Date(Date.UTC(2026, 9, id)).toISOString(), citizenCategory: 'Road Damage' };
}

test('opening report details from the admin list preserves page, filters and location', () => {
  const app = adminApp();
  app.context.saveReports(Array.from({ length: 24 }, (_, index) => adminReport(index + 1, index % 2 ? 'ongoing' : 'pending')));
  app.context.window.setFilter('pending');
  app.context.window.changeReportsPage(1);
  const before = { page: app.node('reportsPageNumber').textContent, rows: app.node('adminReportsBody').innerHTML, count: app.node('adminReportCount').textContent };
  assert.equal(before.page, 'Page 2 of 3');
  app.context.adminViewReport('RPT_SRV_3');
  assert.equal(app.opened.length, 1);
  assert.equal(app.opened[0].id, '3');
  assert.equal(app.location.href, 'http://127.0.0.1/admin.html#reports');
  assert.equal(app.node('reportsPageNumber').textContent, before.page);
  assert.equal(app.node('adminReportsBody').innerHTML, before.rows);
  assert.equal(app.node('adminReportCount').textContent, before.count);
});

test('normal Admin report links retain full-page navigation and explicit publication review opens the review dialog', () => {
  const app = adminApp();
  const link = { getAttribute: () => 'report-details.html?id=8', dataset: {}, closest: selector => selector.startsWith('a[') ? link : null };
  const event = extra => ({ button: 0, target: { closest: selector => link.closest(selector) }, preventDefault() { this.defaultPrevented = true; }, ...extra });
  const plain = event();
  app.handlers.click(plain);
  assert.equal(plain.defaultPrevented, undefined);
  assert.equal(app.opened.length, 0);
  link.dataset.publicationReview = 'true';
  const review = event();
  app.handlers.click(review);
  assert.equal(review.defaultPrevented, true);
  assert.equal(app.opened.at(-1).id, '8');
  const newTab = event({ ctrlKey: true });
  app.handlers.click(newTab);
  assert.equal(newTab.defaultPrevented, undefined);
  assert.equal(app.opened.length, 1);
});
