const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../../frontend/js/shared/reportPresentation');
const vocabulary = require('../../shared/reportVocabulary');

function assessment(status = 'DETECTED') {
  return { status, detected: status === 'DETECTED', canonical_class: status === 'DETECTED' ? 'pothole' : null,
    suggested_category: 'Road Damage', confidence: 0.9, candidate: { canonical_class: 'pothole', accepted: status === 'DETECTED' },
    photos: [{ candidate: { canonical_class: 'pothole', display_name: 'Pothole' } }] };
}

test('model branding resolves v9 without changing stored identity or attributing unknown models to v9', () => {
  const identifier = 'NeighborLens YOLOv8m neighborlens_yolov8m_v9';
  const displayName = 'NeighborLens-AI YOLOv8m';
  const historical = 'NeighborLens YOLO11s beta_testing_v3';
  assert.equal(vocabulary.aiModelDisplayName('NeighborLens YOLOv8m, v9'), displayName);
  assert.equal(vocabulary.aiModelDisplayName('unformatted', {
    architecture: 'YOLOv8m', version: 'neighborlens_yolov8m_v9'
  }), displayName);
  assert.equal(vocabulary.aiModelDisplayName(historical), historical);
  assert.equal(vocabulary.aiModelDisplayName('NeighborLens YOLOv8m, v3.1 Interim Baseline'), 'NeighborLens YOLOv8m, v3.1 Interim Baseline');
  assert.equal(vocabulary.aiModelDisplayName(null), null);
  const report = { originalAi: { ...assessment(), photos: [{ model: identifier }, { model: identifier }] } };
  assert.deepEqual(view.damage(report).fields.at(-1), ['AI model', displayName]);
  assert.equal(report.originalAi.photos[0].model, identifier);
  assert.equal(view.damage({ evidenceStatus: 'EVIDENCE_REVIEW_REQUIRED', originalAi: report.originalAi }).model, null);
});

test('details: accepted citizen category is distinct from genuine original prediction', () => {
  const summary = view.damage({ citizenCategory: 'Road Damage', originalAi: assessment() });
  assert.equal(summary.title, 'Road Damage');
  assert.equal(summary.corrected, false);
  assert.match(summary.note, /Suggestion accepted/);
  assert.ok(summary.fields.some(([label, value]) => label === 'Original YOLO prediction' && value === 'Pothole'));
});

test('details: correction retains the original suggestion without rewriting either input', () => {
  const report = { citizenCategory: 'Street Light Damage', originalAi: assessment() };
  const before = structuredClone(report);
  const summary = view.damage(report);
  assert.equal(summary.title, 'Street Light Damage');
  assert.equal(summary.corrected, true);
  assert.ok(summary.fields.some(([label, value]) => label === 'AI-suggested category' && value === 'Road Damage'));
  assert.deepEqual(report, before);
});

test('details: low confidence remains a provisional candidate, never accepted', () => {
  const summary = view.damage({ citizenCategory: 'Road Damage', originalAi: assessment('LOW_CONFIDENCE') });
  assert.match(summary.note, /no AI detection was confirmed/);
  assert.ok(summary.fields.some(([label]) => label === 'Provisional candidate'));
  assert.ok(!summary.fields.some(([label]) => label === 'Original YOLO prediction'));
});

for (const status of ['NO_DETECTION', 'AI_UNAVAILABLE', 'PAIR_MISMATCH', 'UNSUPPORTED']) {
  test(`details: ${status} never invents an accepted class or confidence`, () => {
    const summary = view.damage({ citizenCategory: 'Road Damage', originalAi: assessment(status) });
    assert.ok(!summary.fields.some(([label]) => /prediction|confidence|candidate/i.test(label)));
    assert.ok(!summary.note.includes('Suggestion accepted'));
  });
}

test('details: legacy AI columns do not pretend to be the original assessment', () => {
  const summary = view.damage({ ai_category: 'Electrical', ai_confidence: 80, vision_detected: true });
  assert.equal(summary.title, 'Electrical');
  assert.match(summary.note, /No original AI assessment/);
  assert.deepEqual(summary.fields, [['Classification', 'Unclassified'], ['Confidence', '80%']]);
  assert.ok(!summary.fields.some(([label]) => label.includes('Original')));
});

test('details: missing category is not inferred from description or severity', () => {
  assert.equal(view.damage({ description: 'pothole', ai_classification: 'MAJOR' }).title, 'Category not recorded');
});

test('details: zero confidence is genuine, missing confidence is not fabricated', () => {
  assert.ok(view.damage({ originalAi: { ...assessment('LOW_CONFIDENCE'), confidence: 0 } }).fields.some(([, value]) => value === '0%'));
  assert.ok(!view.damage({ originalAi: { ...assessment('LOW_CONFIDENCE'), confidence: null } }).fields.some(([label]) => label.includes('confidence')));
});

test('details: photos are exactly two ordered slots, with no fabricated second photo', () => {
  const photos = view.evidence({ images: [{ imageOrder: 2, imagePath: '/two.jpg' }, { imageOrder: 1, imagePath: '/one.jpg' }] }, 'https://api.test/');
  assert.deepEqual(photos.map(photo => photo.url), ['https://api.test/one.jpg', 'https://api.test/two.jpg']);
  const legacy = view.evidence({ images: [{ imageOrder: 1, imagePath: '/one.jpg' }] }, 'https://api.test/');
  assert.equal(legacy.length, 2);
  assert.equal(legacy[1].url, null);
});

for (const value of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'supabase:private/key', 'https://user:password@example.test/photo.jpg', null]) {
  test(`details: reject unsafe or unresolved photo URL ${value}`, () => assert.equal(view.imageUrl(value, 'https://api.test/'), null));
}

test('details: escape untrusted descriptions, locations, and labels', () => {
  assert.equal(view.escape('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('details: coordinates accept actual zero and reject missing, invalid, or out-of-range values', () => {
  assert.deepEqual(view.coordinates({ latitude: 0, longitude: 0 }), { lat: 0, lng: 0 });
  for (const latitude of [null, '', undefined, NaN, 91, true]) assert.equal(view.coordinates({ latitude, longitude: 123 }), null);
});

test('details: no future review stages are created for a pending report', () => {
  const events = view.timeline({ created_at: '2026-10-13 01:41:00', status: 'pending' }, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Report submitted');
  assert.ok(!JSON.stringify(events).includes('Ongoing'));
});

test('details: only valid stored history rows are appended', () => {
  const events = view.timeline({}, [{ new_status: 'ongoing', old_status: 'pending', created_at: '2026-10-13 02:00:00' }, { new_status: 'resolved', created_at: null }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].description, 'Pending to Ongoing');
});

test('details: missing and invalid dates never use the current time', () => {
  assert.equal(view.date(null), null);
  assert.equal(view.date('invalid'), null);
  assert.deepEqual(view.timeline({}, []), []);
});

test('details: stored status actors are presented without inventing a reviewer for redacted Citizen history', () => {
  const row = { new_status: 'ongoing', old_status: 'pending', created_at: '2026-10-27T01:00:00Z', changed_by_username: 'assigned_reviewer' };
  assert.equal(view.timeline({}, [row])[0].actor, 'assigned_reviewer');
  assert.equal(view.timeline({}, [{ ...row, changed_by_username: undefined }])[0].actor, null);
});
