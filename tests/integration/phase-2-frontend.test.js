const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function browser({ response = { reports: [] } } = {}) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const context = vm.createContext({ localStorage: storage, sessionStorage: storage, console, FormData, File, AbortController, setTimeout, clearTimeout,
    getSession: () => ({ role: 'citizen', id: 1, apiToken: 'test-token' }),
    fetch: async () => ({ ok: true, json: async () => response }),
    CustomEvent: class { constructor(name) { this.name = name; } },
    window: { ReportVocabulary: require('../../shared/reportVocabulary'), ManilaDates: require('../../shared/manilaDates'), dispatchEvent() {}, addEventListener() {}, NEIGHBORLENS_API_BASE_URL: 'http://isolated.test' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/shared/reports.js'), 'utf8'), context);
  return context;
}

test('Phase 2 generic description category rules remain backward-compatible', () => {
  const context = browser();
  for (const [description, category] of [['pothole', 'Road Damage'], ['drain', 'Flooding / Drainage'], ['power', 'Electrical'], ['fallen tree', 'Fallen Tree'], ['trash', 'Sanitation'], ['bridge', 'Structural'], ['issue', 'Infrastructure']]) {
    assert.equal(context.detectCategory(description), category);
  }
});

test('Phase 2 category filters use citizen selection without rewriting original or generic labels', () => {
  const context = browser();
  const rows = [{ aiCategory: 'broken_streetlight', citizenCategory: 'Road Damage' }, { aiCategory: 'Electrical' }, { aiCategory: 'Fallen Tree' }];
  assert.equal(context.filterReports(rows, { category: 'Road Damage' }).length, 1);
  assert.equal(context.filterReports(rows, { category: 'Electrical' }).length, 1);
  assert.equal(context.filterReports(rows, { category: 'Fallen Tree' }).length, 1);
  assert.equal(rows[0].aiCategory, 'broken_streetlight');
});

test('shared report search matches reporter, barangay, identifiers and categories consistently', () => {
  const context = browser();
  const report = { id: 'RPT_SRV_54', backendId: 54, submittedBy: 'citizen-2', barangay: 'Villamonte',
    description: 'Damaged pavement', location: 'YLAC Avenue', citizenCategory: 'Road Damage', aiCategory: 'Pothole' };
  for (const term of [' CITIZEN-2 ', 'Villamonte', 'rpt_srv_54', '54', 'pavement', 'ylac', 'Road Damage', 'Pothole', '']) {
    assert.equal(context.reportMatchesSearch(report, term), true);
    assert.equal(context.filterReports([report], { search: term }).length, 1);
  }
  assert.equal(context.reportMatchesSearch(report, 'no-match'), false);
  assert.equal(context.filterReports([report], { search: 'no-match' }).length, 0);
  assert.equal(context.reportMatchesSearch({}, 'citizen-2'), false);
  assert.equal(report.submittedBy, 'citizen-2');
});

test('Phase 2 shared review markup exposes distinct values even without accepted submission-time inference', () => {
  const context = browser();
  const markup = context.aiDetailsMarkup({ visionDetected: false, citizenCategory: 'Road Damage', status: 'pending', originalAi: {
    status: 'LOW_CONFIDENCE', canonical_class: null, candidate: { canonical_class: 'broken_streetlight' }, confidence: 0.2,
    suggested_category: 'Street Light Damage', photos: []
  } });
  for (const value of ['LOW_CONFIDENCE', 'broken_streetlight', 'Road Damage', 'Street Light Damage', 'pending', '20%']) assert.ok(markup.includes(value));
  assert.ok(markup.includes('Citizen category differs'));
  assert.ok(markup.includes('Not available'));
  assert.ok(!markup.includes('verified'));
});

test('Phase 2 snapshot markup escapes untrusted text and never invents unavailable confidence', () => {
  const context = browser();
  const markup = context.submissionAssessmentMarkup({ citizenCategory: '<script>alert(1)</script>', status: 'pending', originalAi: { status: 'AI_UNAVAILABLE', canonical_class: null, confidence: null, suggested_category: null, photos: [] } });
  assert.ok(markup.includes('&lt;script&gt;'));
  assert.ok(!markup.includes('<script>'));
  assert.ok(!markup.includes('0%'));
  assert.ok(!markup.includes('80%'));
});

test('Phase 2 authorized reload mapping persists original and citizen values independently', async () => {
  const originalAi = { status: 'DETECTED', canonical_class: 'pothole', suggested_category: 'Road Damage', confidence: 0.9, photos: [] };
  const context = browser({ response: { reports: [{ id: 42, ai_category: 'pothole', citizenCategory: 'Flooding / Drainage', originalAi, description: 'Citizen wording', submitted_by: 1 }] } });
  await context.syncReportsFromBackend();
  await context.syncReportsFromBackend();
  const rows = context.getAllReports();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].citizenCategory, 'Flooding / Drainage');
  assert.equal(rows[0].originalAi.canonical_class, 'pothole');
  assert.equal(rows[0].description, 'Citizen wording');
});

test('Phase 2 assessment proofs are sent transiently but never saved in browser report storage', async () => {
  const context = browser({ response: { id: 42, citizenCategory: 'Road Damage', originalAi: { status: 'DETECTED', canonical_class: 'pothole' } } });
  const report = context.addReport({ description: 'Citizen wording', citizenCategory: 'Road Damage', submittedById: 1, assessmentProofs: ['private-one', 'private-two'] });
  await report.syncPromise;
  const serialized = context.localStorage.getItem('up_reports');
  assert.ok(!serialized.includes('private-one'));
  assert.ok(!serialized.includes('assessmentProofs'));
  assert.equal(context.getAllReports()[0].citizenCategory, 'Road Damage');
});
