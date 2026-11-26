const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../frontend/js/shared/reportCard');
const vocabulary = require('../../shared/reportVocabulary');
const dates = require('../../shared/manilaDates');
const store = require('../../frontend/js/barangay/viewState');

const report = {
  id: 54, aiCategory: 'road_crack', status: 'resolved', barangay: 'Villamonte', location: 'Full private street address',
  description: 'AI detected: Road Crack (Road Damage).', createdAt: '2026-10-14T17:00:00Z',
  images: [{ id: 12, imageOrder: 2 }, { id: 11, imageOrder: 1 }]
};
const options = { staff: true, apiBase: 'http://127.0.0.1:3000/' };

test('shared report icon honors citizen correction and cannot inject arbitrary asset paths', () => {
  assert.match(cards.categoryIcon({ citizenCategory: 'Street Light Damage', originalAi: { status: 'DETECTED', canonical_class: 'pothole' } }), /icon--streetlight/);
  assert.match(cards.categoryIcon({ aiCategory: '<img src=x onerror=alert(1)>' }), /icon--report/);
  assert.doesNotMatch(cards.categoryIcon({ aiCategory: '<img src=x onerror=alert(1)>' }), /onerror|<img/);
});

test('staff cards use the evidence-first presentation and preserve the submitted description', () => {
  const html = cards.render(report, options);
  assert.match(html, /class="report-card"/);
  assert.match(html, /#54/);
  assert.match(html, />Road Crack<\/h3>/);
  assert.match(html, /data-status="resolved">Resolved/);
  assert.match(html, /Unclassified/);
  assert.match(html, /Unprioritized/);
  assert.match(html, /Villamonte/);
  assert.doesNotMatch(html, /Full private street address|Original YOLO|mr-row|report-card-actions/);
  assert.match(html, /class="report-card-description">AI detected: Road Crack \(Road Damage\)\./);
  assert.equal((html.match(/data-action="view"/g) || []).length, 1);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /data-evidence-url="http:\/\/127.0.0.1:3000\/api\/reports\/54\/images\/11"/);
  assert.match(html, /View details for report 54/);
});

test('cards escape legacy titles and locations without inventing metadata or unsafe image URLs', () => {
  const html = cards.render({
    id: 4, aiCategory: '<img src=x onerror=alert(1)>', barangay: '<script>unsafe</script>',
    status: 'unknown', images: [{ imageOrder: 1, imagePath: 'javascript:alert(1)' }]
  }, options);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script|data-evidence-url/);
  assert.match(html, /Photo 1 unavailable/);
  assert.match(html, /Date not recorded/);
  assert.match(html, /Unknown status/);
  assert.match(html, /Unclassified/);
  assert.match(html, /Unprioritized/);
});

test('table thumbnails and cards share protected photo normalization across Admin URL arrays and Barangay image DTOs', () => {
  const url = 'http://127.0.0.1:3000/api/reports/54/images/11';
  assert.equal(cards.photoUrl(report, 54, 1, options.apiBase), url);
  assert.equal(cards.photoUrl({ images: [url] }, 54, 1, options.apiBase), url);
  assert.equal(cards.photoUrl({ image: url }, 54, 1, options.apiBase), url);
  assert.equal(cards.photoUrl({ images: ['javascript:alert(1)'] }, 54, 1, options.apiBase), null);
});

test('Citizen rows keep both photos and show the barangay with a single AI summary', () => {
  const input = { ...report, citizenCategory: 'Road Damage', originalAi: { status: 'DETECTED', detected: true, canonical_class: 'road_crack', suggested_category: 'Road Damage' } };
  const render = changes => cards.render({ ...input, ...changes }, { ...options, staff: false, detailsUrl: 'report-details.html?id=54' });
  const html = render({});
  assert.match(html, /class="mr-row"/);
  assert.match(html, />Road Crack<\/a>/);
  assert.match(html, /class="mr-ai"/);
  assert.match(html, /class="mr-location"[^\n]*<span>Villamonte<\/span>/);
  assert.doesNotMatch(html, /Full private street address|mr-assessment|mr-description/);
  assert.equal((html.match(/<img /g) || []).length, 2);
  assert.match(html, /data-status="resolved">Resolved/);
  assert.match(html, /report-entry-link/);
  const edited = `${report.description} Near the school crossing.`;
  assert.ok(render({ description: edited }).includes(edited));
  const corrected = render({ citizenCategory: 'Flooding / Drainage' });
  assert.equal((corrected.match(/AI detected:/g) || []).length, 1);
  assert.match(render({ originalAi: null, evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED' }), /Check that both photos/);
  const noBarangay = render({ barangay: null, location: 'Purok 5, Negros Occidental, Philippines' });
  assert.match(noBarangay, />Purok 5</);
  assert.doesNotMatch(noBarangay, /Negros Occidental/);
});

test('Admin and Barangay share card content, with one authorized navigation or dialog action', () => {
  const barangay = cards.render(report, options);
  const admin = cards.render(report, { ...options, detailsUrl: 'report-details.html?id=54' });
  const body = html => html.split('<footer')[0].replace('report-card overview-report', 'report-card');
  assert.equal(body(admin), body(barangay));
  assert.equal((admin.match(/href=/g) || []).length, 1);
  assert.match(admin, /href="report-details\.html\?id=54"/);
  assert.doesNotMatch(admin, /<button|data-action=/);
  assert.equal((barangay.match(/data-action="view"/g) || []).length, 1);
  assert.doesNotMatch(barangay, /href=/);
  for (const detailsUrl of [null, 'javascript:alert(1)', 'https://example.com', 'report-details.html?id=0']) {
    const pending = cards.render(report, { ...options, detailsUrl });
    assert.doesNotMatch(pending, /href=|<button|data-action=/);
    assert.match(pending, /Report is being saved/);
  }
});

test('shared staff card styling and rendering have one owner across both portals', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = file => fs.readFileSync(path.resolve('frontend', file), 'utf8');
  for (const page of ['admin.html', 'barangay.html']) {
    assert.equal((read(page).match(/styles\/report-card\.css/g) || []).length, 1);
    assert.equal((read(page).match(/js\/shared\/reportCard\.js/g) || []).length, 1);
  }
  assert.doesNotMatch(read('styles/barangay.css'), /\.report-card/);
  assert.doesNotMatch(read('styles/admin-overview.css'), /\.overview-report|\.barangay-progress/);
  assert.match(read('js/admin/admin_logic.js'), /window\.ReportManagement\.createTable\(/);
  assert.match(read('js/barangay/reportListView.js'), /root\.ReportManagement\.createTable\(/);
  assert.match(read('js/shared/reportManagement.js'), /root\.ReportCard\.render\(report, \{ apiBase, staff: true/);
  assert.doesNotMatch(read('styles/report-card.css'), /#[0-9a-f]{3,8}\b|!important/);
});

test('compact card dates still use Manila boundaries and the shared status mapping preserves stored keys', () => {
  assert.equal(dates.format(report.createdAt, { dateOnly: true }), 'Oct 15, 2026');
  assert.match(dates.format(report.createdAt), /Oct 15, 2026/);
  assert.equal(vocabulary.statuses.resolved, 'Resolved');
  assert.deepEqual(vocabulary.transitions.pending, ['ongoing', 'resolved', 'rejected']);
});

test('new Barangay sessions default to one three-card page without overwriting a saved page size', () => {
  const values = new Map();
  const environment = {
    getSession: () => ({ id: 4, role: 'barangay', barangay: 'Villamonte' }), location: { hash: '#reports' },
    sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  };
  const view = store.create(environment);
  assert.equal(view.read().query.pageSize, 3);
  view.save({ query: { ...view.read().query, pageSize: 24 } });
  assert.equal(view.read().query.pageSize, 24);
});
