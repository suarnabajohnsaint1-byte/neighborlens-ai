const test = require('node:test');
const assert = require('node:assert/strict');
const { analyticsRange, summarizeAnalytics } = require('../domain/reports/reportAnalytics.rules');
const { createReportAnalyticsService } = require('../application/use-cases/reportAnalytics.service');
const components = require('../../frontend/js/shared/portalComponents');
const { normalize } = require('../../frontend/js/shared/analyticsApi');
const options = require('../../frontend/js/shared/analyticsCharts');
const { create } = require('../../frontend/js/shared/analyticsState');
const charts = require('../../frontend/js/shared/chartLifecycle');

const now = new Date('2026-10-15T16:00:00Z');
const empty = { submissions: [], resolutions: [], missingResolutionHistory: 0, timestampOffsetMinutes: 480 };

test('analytics periods use Manila midnight and inclusive calendar days across month and year boundaries', () => {
  const range = analyticsRange('7', now);
  assert.equal(range.startDate, '2026-10-10');
  assert.equal(range.endDate, '2026-10-16');
  assert.equal(range.startUtc, '2026-10-09T16:00:00.000Z');
  assert.equal(range.endExclusiveUtc, '2026-10-16T16:00:00.000Z');
  assert.equal(analyticsRange(7, new Date('2026-10-15T15:59:59Z')).endDate, '2026-10-15');
  assert.equal(analyticsRange(7, new Date('2026-01-01T00:00:00Z')).startDate, '2025-12-26');
  assert.equal(analyticsRange(30, new Date('2024-03-01T00:00:00Z')).startDate, '2024-02-01');
  assert.equal(analyticsRange(undefined, now).days, 30);
  for (const value of [0, -1, 1000, '7 OR 1=1', '7.0', ['7'], null, {}]) assert.throws(() => analyticsRange(value, now));
});

test('analytics fills known missing days and keeps submitted dates separate from resolved events', () => {
  const range = analyticsRange(7, now);
  const value = summarizeAnalytics(range, { ...empty,
    submissions: [{ day: '2026-10-10', category: 'pothole', total: '2' }, { day: '2026-10-16', category: 'uncategorized', total: 1 }],
    resolutions: [{ day: '2026-10-15', total: 3 }], ongoing: [{ day: '2026-10-15', total: 2 }] });
  assert.equal(value.daily.length, 7);
  assert.deepEqual(value.daily[0], { date: '2026-10-10', submitted: 2, ongoing: 0, resolved: 0, knownResolved: 0 });
  assert.deepEqual(value.daily[5], { date: '2026-10-15', submitted: 0, ongoing: 2, resolved: 3, knownResolved: 3 });
  assert.deepEqual(value.totals, { submitted: 3, ongoing: 2, resolved: 3, knownResolved: 3 });
  assert.deepEqual(value.categories.map(category => category.key), ['pothole', 'road_crack', 'damaged_street_light', 'clogged_drainage', 'uncategorized']);
  assert.equal(value.categories[0].percentage, 2 / 3 * 100);
  assert.equal(value.categories[1].count, 0);
  assert.equal(normalize(value), value);
});

test('missing legacy resolution history is unavailable, never invented as zero', () => {
  const value = summarizeAnalytics(analyticsRange(7, now), { ...empty, missingResolutionHistory: 2, resolutions: [{ day: '2026-10-16', total: 1 }] });
  assert.equal(value.totals.resolved, null);
  assert.equal(value.totals.knownResolved, 1);
  assert.equal(value.resolutionHistory.complete, false);
  assert.ok(value.daily.every(day => day.resolved === null));
  assert.equal(normalize(value), value);
  assert.throws(() => normalize({ ...value, totals: { ...value.totals, resolved: 0 } }));
});

test('successful empty analytics has zero daily values and all four canonical categories', () => {
  const value = summarizeAnalytics(analyticsRange(30, now), empty);
  assert.equal(value.categories.length, 4);
  assert.ok(value.categories.every(category => category.count === 0));
  assert.ok(value.daily.every(day => day.submitted === 0 && day.resolved === 0));
  assert.equal(normalize(value), value);
  assert.throws(() => normalize({ ...value, daily: value.daily.slice(1) }));
  assert.throws(() => normalize({ ...value, categories: [{ key: 'x', label: 'x', count: 2, percentage: 100 }] }));
});

test('analytics use case authorizes before retrieval and bounds the query', async () => {
  let queries = 0;
  const service = createReportAnalyticsService({ clock: () => now, reportAnalyticsRepository: { aggregate: async () => { queries++; return empty; } } });
  for (const role of ['citizen', undefined]) await assert.rejects(service.getAnalytics({}, { role }), /Staff/);
  await assert.rejects(service.getAnalytics({}, { role: 'barangay' }), /assignment/);
  await assert.rejects(service.getAnalytics({ days: 7, barangay: 'Villamonte' }, { role: 'admin' }), /Only/);
  assert.equal(queries, 0);
  assert.equal((await service.getAnalytics({ days: '90' }, { role: 'admin' })).daily.length, 90);
  assert.equal(queries, 1);
});

test('resolution progress uses the exact ratio, rounded label and honest zero states', () => {
  assert.deepEqual(components.resolutionProgress(0, 0), { total: 0, resolved: 0, percentage: 0, label: 'No reports yet' });
  assert.deepEqual(components.resolutionProgress(12, 0), { total: 12, resolved: 0, percentage: 0, label: '0%' });
  assert.deepEqual(components.resolutionProgress(3, 1), { total: 3, resolved: 1, percentage: 1 / 3 * 100, label: '33%' });
  assert.deepEqual(components.resolutionProgress(4, 4), { total: 4, resolved: 4, percentage: 100, label: '100%' });
  assert.match(components.resolutionProgressMarkup(3, 1), /role="progressbar"/);
  assert.match(components.resolutionProgressMarkup(3, 1), /width:33\.33333333333333%/);
  assert.match(components.resolutionProgressMarkup(3, 1), /aria-valuetext="1 \/ 3 resolved \(33%\)"/);
});

test('shared resolution progress normalizes invalid counts and never invents ongoing completion', () => {
  for (const total of [undefined, null, -1, 1.5, NaN, Infinity, '12']) {
    assert.deepEqual(components.resolutionProgress(total, 2), { total: 0, resolved: 0, percentage: 0, label: 'No reports yet' });
    assert.doesNotMatch(components.resolutionProgressMarkup(total, 2), /NaN|Infinity|100%/);
  }
  assert.equal(components.resolutionProgress(8, -1).resolved, 0);
  assert.equal(components.resolutionProgress(8, NaN).resolved, 0);
  assert.equal(components.resolutionProgress(8, 20).resolved, 8);
  assert.match(components.resolutionProgressMarkup(8, 0), /0 \/ 8 resolved \(0%\)/);
});

test('chart options use daily line series without area fill and solid horizontal bars', () => {
  const data = summarizeAnalytics(analyticsRange(30, now), empty);
  const categoryPalette = { pothole: 'orange', 'road-crack': 'blue', streetlight: 'purple', drainage: 'teal', report: 'gray' };
  const colors = { blue: 'blue', ongoing: 'gold', resolved: 'green', text: 'black', border: 'gray', muted: 'gray', surface: 'white', track: '#f7faff', motion: false, width: 340, category: icon => categoryPalette[icon] };
  const line = options.trend(data, colors);
  assert.deepEqual(line.series.map(series => [series.name, series.itemStyle.color]), [['Submitted', 'blue'], ['Ongoing', 'gold'], ['Resolved', 'green']]);
  assert.match(line.tooltip.formatter([{ axisValue: data.daily[0].date }]), /Ongoing:/);
  assert.ok(line.series.every(series => series.type === 'line' && !series.areaStyle));
  assert.equal(line.series[0].data.length, 30);
  assert.equal(line.yAxis.minInterval, 1);
  assert.equal(line.animation, false);
  const curve = options.trend(data, { ...colors, motion: true }, 'curve');
  const groupedBars = options.trend(data, colors, 'bar');
  assert.ok(curve.series.every(series => series.type === 'line' && series.smooth && !series.connectNulls));
  assert.ok([...line.series, ...curve.series].every(series => series.lineStyle.type === 'solid'));
  assert.equal(curve.yAxis.splitLine.lineStyle.type, 'solid');
  assert.deepEqual(curve.series.map(series => [series.symbol(0), series.symbol(1)]), [['none', 'circle'], ['none', 'diamond'], ['none', 'rect']]);
  assert.equal(curve.animation, true);
  assert.ok(groupedBars.series.every(series => series.type === 'bar' && !series.stack));
  assert.equal(groupedBars.xAxis.boundaryGap, true);
  for (const variant of [curve, groupedBars]) assert.deepEqual(variant.series.map(series => series.data), line.series.map(series => series.data));
  const bar = options.categories(data, colors);
  assert.equal(bar.xAxis.type, 'value');
  assert.equal(bar.yAxis[0].type, 'category');
  assert.equal(bar.series[0].type, 'bar');
  assert.equal(bar.series[0].barWidth, 8);
  assert.equal(bar.series[0].backgroundStyle.color, colors.track);
  assert.equal(bar.yAxis[1].position, 'right');
  assert.equal(bar.yAxis[1].axisLabel.formatter('Pothole', 0), '0');
  assert.equal(bar.series[0].data.length, 4);
  assert.deepEqual(bar.yAxis[0].data, ['Pothole', 'Road Crack', 'Broken Streetlight', 'Clogged Drainage']);
  assert.deepEqual(bar.series[0].data.map(entry => entry.itemStyle.color), ['orange', 'blue', 'purple', 'teal']);
  assert.equal(bar.yAxis[0].axisLabel.rich.mark2.color, 'purple');
  assert.deepEqual(bar.series[0].data.map(entry => entry.value), data.categories.map(category => category.count));
  assert.match(bar.tooltip.formatter({ dataIndex: 0 }), /All period submissions: 0/);
});

test('category pie shares use the same counts and colors as bars and render an honest empty ring', () => {
  const range = analyticsRange(7, now);
  const data = summarizeAnalytics(range, { ...empty, submissions: [
    { day: range.startDate, category: 'road_crack', total: 1 }, { day: range.startDate, category: 'pothole', total: 3 }
  ] });
  const colors = { category: key => key, surface: 'white', border: 'gray', motion: true, width: 340 };
  const pie = options.categories(data, colors, 'pie');
  const bar = options.categories(data, colors, 'bar');
  assert.equal(pie.series[0].type, 'pie');
  assert.deepEqual(pie.series[0].data, bar.series[0].data.filter(entry => entry.value > 0));
  assert.match(bar.tooltip.formatter({ dataIndex: 1 }), /1 report \(25%\)/);
  assert.equal(pie.tooltip.show, false);
  assert.equal(pie.animation, true);
  assert.equal(pie.series[0].emphasis.scale, true);
  const emptyPie = options.categories(summarizeAnalytics(range, empty), { ...colors, motion: false }, 'pie');
  assert.equal(emptyPie.animation, false);
  assert.equal(emptyPie.series[0].emphasis.scale, false);
  assert.equal(emptyPie.series[0].showEmptyCircle, true);
  assert.deepEqual(emptyPie.series[0].data, []);
});

test('range changes abort previous requests and ignore late responses without duplicate loads', async () => {
  const requests = [];
  const states = [];
  const selection = create({ load: (days, signal) => new Promise((resolve, reject) => requests.push({ days, signal, resolve, reject })), changed: state => states.push(state) });
  const first = selection.select(30);
  assert.equal(selection.select(30), first);
  await Promise.resolve();
  const second = selection.select(7);
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ id: 'new' });
  await second;
  requests[0].resolve({ id: 'old' });
  await first;
  assert.equal(selection.get().data.id, 'new');
  assert.equal(states.filter(state => state.status === 'ready').length, 1);
  selection.destroy();
});

test('range errors transition once, retry recovers and destroyed views cannot update', async () => {
  let fail = true;
  let finish;
  const states = [];
  const selection = create({ load: async () => { if (fail) throw new Error('Service unavailable'); return new Promise(resolve => { finish = resolve; }); }, changed: state => states.push(state) });
  await selection.select(30);
  assert.equal(selection.get().status, 'error');
  assert.equal(selection.get().data, null);
  fail = false;
  const pending = selection.refresh();
  await Promise.resolve();
  selection.destroy();
  finish({ id: 'late' });
  await pending;
  assert.equal(states.filter(state => state.status === 'ready').length, 0);
  assert.equal(states.filter(state => state.status === 'error').length, 1);
});

test('chart lifecycle reuses its instance and cleans up observers, frames, themes and motion listeners', () => {
  const queued = new Map();
  let id = 0;
  const calls = { init: 0, dispose: 0, disconnect: 0, unsubscribe: 0, remove: 0, resize: 0 };
  let resize;
  const element = { isConnected: true, clientWidth: 600, clientHeight: 220 };
  const view = {
    requestAnimationFrame(callback) { queued.set(++id, callback); return id; }, cancelAnimationFrame: key => queued.delete(key),
    getComputedStyle: () => ({ getPropertyValue: () => 'blue', fontFamily: 'Arial' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() { calls.remove++; } }),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() { calls.disconnect++; } },
    PortalTheme: { subscribe: () => () => { calls.unsubscribe++; } }
  };
  const engine = { init() { calls.init++; return { resize() { calls.resize++; }, setOption() {}, clear() {}, dispose() { calls.dispose++; } }; } };
  const mounted = charts.mount(element, { engine, options: () => ({}), view });
  assert.equal(charts.mount(element, { engine, options: () => ({}), view }), mounted);
  mounted.update({});
  for (const [key, callback] of queued) { queued.delete(key); callback(); }
  resize(); mounted.resize();
  assert.equal(queued.size, 1);
  mounted.destroy(); mounted.destroy();
  assert.equal(queued.size, 0);
  assert.deepEqual(calls, { init: 1, dispose: 1, disconnect: 1, unsubscribe: 1, remove: 1, resize: 1 });
});

test('analytics retains known data during transient failures but clears it for access denial', async () => {
  let failure = null;
  const data = { id: 'authorized' };
  const selection = create({ changed() {}, load: async () => { if (failure) throw failure; return data; } });
  await selection.select();
  failure = Object.assign(new Error('Service unavailable'), { status: 503 });
  await selection.refresh();
  assert.equal(selection.get().data, data);
  failure = Object.assign(new Error('Access denied'), { status: 403 });
  await selection.refresh();
  assert.equal(selection.get().data, null);
  selection.destroy();
});
