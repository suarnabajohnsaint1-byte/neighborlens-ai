const test = require('node:test');
const assert = require('node:assert/strict');
const list = require('../../frontend/js/citizen/myReports');
const reportStore = require('../../frontend/js/shared/reports');
const session = { id: 1, username: 'owner', role: 'citizen' };
const report = (id, changes = {}) => ({ id: `RPT_SRV_${id}`, backendId: id, submittedById: 1, submittedByRole: 'citizen',
  createdAt: `2026-10-${String(id).padStart(2, '0')}T10:00:00Z`, status: 'pending', description: `Issue ${id}`, ...changes });
const detected = { status: 'DETECTED', detected: true, canonical_class: 'pothole', confidence: 0.9, suggested_category: 'Road Damage', photos: [] };

test('citizen list: six reports per page with correct total and boundaries', () => {
  const reports = Array.from({ length: 13 }, (_, index) => report(index + 1));
  const first = list.selectReports(reports, {}, session);
  assert.equal(first.items.length, 6);
  assert.deepEqual([first.from, first.to, first.total, first.pageCount], [1, 6, 13, 3]);
  const last = list.selectReports(reports, { page: 3 }, session);
  assert.deepEqual(last.items.map(item => item.backendId), [1]);
  assert.deepEqual([last.from, last.to], [13, 13]);
});

test('citizen list: status filter and literal case-insensitive search precede pagination', () => {
  const reports = [report(1, { status: 'resolved', location: 'Villamonte' }), report(2, { status: 'resolved', location: 'Other' }), report(3)];
  const result = list.selectReports(reports, { status: 'resolved', query: '  VILLAMONTE ', page: 8 }, session);
  assert.deepEqual(result.items.map(item => item.backendId), [1]);
  assert.equal(result.page, 1);
  assert.equal(result.total, 1);
});

test('citizen list: search covers description, category, original class, and report ID', () => {
  const item = report(1, { description: 'Near the school', citizenCategory: 'Flooding / Drainage', originalAi: detected });
  for (const query of ['SCHOOL', 'Drainage', 'Pothole', 'RPT_SRV_1']) {
    assert.equal(list.selectReports([item], { query }, session).total, 1);
  }
  assert.equal(list.selectReports([item], { query: '[' }, session).total, 0);
});

test('citizen list: newest and oldest sorting do not mutate cached reports', () => {
  const reports = [report(2), report(1), report(3)];
  assert.deepEqual(list.selectReports(reports, {}, session).items.map(item => item.backendId), [3, 2, 1]);
  assert.deepEqual(list.selectReports(reports, { sort: 'oldest' }, session).items.map(item => item.backendId), [1, 2, 3]);
  assert.deepEqual(reports.map(item => item.backendId), [2, 1, 3]);
});

test('citizen list: invalid and absent dates sort last without creating dates', () => {
  const reports = [report(1, { createdAt: null }), report(2, { createdAt: 'invalid' }), report(3)];
  for (const sort of ['newest', 'oldest']) assert.equal(list.selectReports(reports, { sort }, session).items[0].backendId, 3);
  assert.equal(reports[0].createdAt, null);
});

test('citizen list: equal dates sort deterministically by numeric backend ID', () => {
  const reports = [report(10, { createdAt: '2026-10-01 10:00:00' }), report(2, { createdAt: '2026-10-01 10:00:00' })];
  assert.deepEqual(list.selectReports(reports, {}, session).items.map(item => item.backendId), [10, 2]);
  assert.deepEqual(list.selectReports(reports, { sort: 'oldest' }, session).items.map(item => item.backendId), [2, 10]);
});

test('citizen list: another owner and non-citizen submissions never enter the page', () => {
  const reports = [report(1), report(2, { submittedById: 2 }), report(3, { submittedById: 3, submittedByRole: 'admin' }), null];
  assert.deepEqual(list.selectReports(reports, {}, session).items.map(item => item.backendId), [1]);
  assert.equal(list.selectReports(reports, {}, { ...session, role: 'admin' }).total, 0);
  assert.equal(list.selectReports(reports, {}, null).total, 0);
});

test('citizen list: owned legacy reports remain visible without role metadata', () => {
  const legacy = report(1, { submittedByRole: undefined });
  const usernameOwned = report(2, { submittedById: null, submittedBy: 'owner', submittedByRole: undefined });
  assert.deepEqual(list.selectReports([legacy], {}, session).items, [legacy]);
  assert.deepEqual(list.selectReports([usernameOwned], {}, session).items, [usernameOwned]);
  assert.equal(reportStore.reportIsAccessible(legacy, session), true);
  assert.equal(reportStore.reportIsAccessible(usernameOwned, session), true);
  assert.equal(reportStore.reportIsAccessible(report(2, { submittedById: 2, submittedByRole: undefined }), session), false);
});

test('citizen list: legacy owner identity and numeric string IDs remain supported', () => {
  assert.equal(list.selectReports([report(1, { submittedById: '1' }), report(2, { submittedById: null, submittedBy: 'owner' })], {}, session).total, 2);
});

test('citizen list: out-of-range, negative, and nonnumeric pages clamp safely', () => {
  for (const page of [-10, 0, 'invalid', Infinity, 1.2, 900]) assert.equal(list.selectReports([report(1)], { page }, session).page, 1);
});

test('citizen list: empty results have no fake pages or records', () => {
  const result = list.selectReports([], {}, session);
  assert.deepEqual([result.from, result.to, result.pageCount, result.total], [0, 0, 0, 0]);
});

test('citizen list: a removed last page clamps to the remaining page', () => {
  const result = list.selectReports(Array.from({ length: 6 }, (_, index) => report(index + 1)), { page: 2 }, session);
  assert.equal(result.page, 1);
  assert.equal(result.to, 6);
});

test('citizen list: selected per-page limit applies before rendering each page', () => {
  const reports = Array.from({ length: 8 }, (_, index) => report(index + 1));
  const result = list.selectReports(reports, { pageSize: 3, page: 2 }, session);
  assert.deepEqual([result.from, result.to, result.pageCount], [4, 6, 3]);
  assert.equal(list.selectReports(reports, { pageSize: 999 }, session).items.length, 6);
});

test('citizen list: accepted original AI class is displayed without inventing verification', () => {
  const item = list.summary(report(1, { originalAi: detected, citizenCategory: 'Road Damage' }));
  assert.equal(item.title, 'Pothole');
  assert.equal(item.detail, 'AI detected: Pothole (Road Damage)');
  assert.equal(item.detected, true);
  assert.equal(item.correction, null);
});

test('citizen list: correction remains distinct and preserves the original assessment', () => {
  const source = report(1, { originalAi: detected, citizenCategory: 'Street Light Damage' });
  const before = JSON.stringify(source);
  const item = list.summary(source);
  assert.equal(item.title, 'Street Light Damage');
  assert.equal(item.correction, 'Citizen correction: Street Light Damage');
  assert.match(item.detail, /Pothole \(Road Damage\)/);
  assert.equal(JSON.stringify(source), before);
});

for (const status of ['LOW_CONFIDENCE', 'NO_DETECTION', 'AI_UNAVAILABLE', 'PAIR_MISMATCH']) {
  test(`citizen list: ${status} never gets an accepted AI detection badge`, () => {
    const item = list.summary(report(1, { originalAi: { ...detected, status, detected: false, canonical_class: null }, citizenCategory: 'Road Damage' }));
    assert.equal(item.detected, false);
    assert.doesNotMatch(item.detail, /AI detected/);
  });
}

test('citizen list: legacy category is not claimed as a genuine original YOLO result', () => {
  const item = list.summary(report(1, { aiCategory: 'Electrical', visionDetected: true }));
  assert.equal(item.title, 'Electrical');
  assert.equal(item.detected, false);
  assert.match(item.detail, /No original AI assessment/);
});
