const test = require('node:test');
const assert = require('node:assert/strict');
const { seedCitizen, addReportGps } = require('../support/citizens');
const { randomUUID } = require('node:crypto');

process.env.REPORT_SEVERITY_POLICY_JSON = JSON.stringify({
  approvedBy: 'Isolated test fixture only', version: 'test-measurements-v1',
  measurementSource: { id: 'fixture-gauge', version: '1' },
  rules: { pothole: { majorAtOrAbove: { depth_mm: 20 }, majorSeverity: 'high', minorSeverity: 'low' } }
});

const { startTestServer, testDatabase } = require('../support/test-app');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../support/image-fixtures');
const { adminSession, createOfficial } = require('../support/accounts');
const { assessPair } = require('../../frontend/js/citizen/damagePairAssessment');
const { renderAssessment } = require('../../frontend/js/citizen/citizenAssessmentPresentation');
const { evaluatePairResults } = require('../../server/domain/reports/damageDetection.rules');
const { triageForSeverity } = require('../../server/domain/reports/report.rules');
const { readVisualExtent } = require('../../server/domain/reports/visualExtent');

const extentFixture = {
  source: 'opencv_visual_extent', version: '1', category: 'pothole', quality: 'EXPERIMENTAL',
  reason: 'CANDIDATE_MASK_ONLY', grid: [40, 40], region: [2, 4, 40, 40],
  features: { candidate_area_px2: 80, crop_fraction: 0.05, components: 1, largest_component_fraction: 1, threshold_stability_iou: 0.83 }
};
const box = { x: 2, y: 4, width: 40, height: 40 };
const imageSize = { width: 100, height: 100 };

test('visual evidence rejects foreign categories, coordinates, units and authority fields', () => {
  const primary = { eligible: true, canonical_category: 'pothole', bounding_box: box };
  const read = patch => readVisualExtent({ ...extentFixture, ...patch }, primary, imageSize);
  assert.deepEqual(read({}), extentFixture);
  for (const patch of [{ category: 'road_crack' }, { region: [0, 0, 40, 40] }, { version: 'future' },
    { features: { ...extentFixture.features, depth_mm: 80 } }, { grid: [4096, 4096] },
    { features: { ...extentFixture.features, crop_fraction: 0.9 } }, { features: { severity_level: 'high' } }]) {
    assert.equal(read(patch), null);
  }
});

test('conflicting severity requires review, while corroborated Major survives either photo order', () => {
  const photo = (level, confidence) => {
    const { aiClassification, aiPriority } = triageForSeverity(level);
    return {
      detected: true, candidate: { accepted: true, canonical_category: 'pothole', confidence },
      detections: [{ eligible: true, canonical_category: 'pothole', severity_level: level,
        severity_suggestion: aiClassification ? { category: 'pothole', source: 'approved_measurement_rule', level,
          classification: aiClassification, priority: aiPriority } : null }]
    };
  };
  const results = [photo('low', 0.99), photo(' CRITICAL ', 0.85)];
  for (const order of [results, results.toReversed()]) {
    const pair = evaluatePairResults(order);
    assert.equal(pair.severityConflict, true);
    assert.equal(pair.severity, null);
    assert.equal(pair.triage, null);
  }
  const consistent = [photo('high', 0.99), photo(' CRITICAL ', 0.85)];
  for (const order of [consistent, consistent.toReversed()]) {
    const pair = evaluatePairResults(order);
    assert.equal(pair.severityConflict, false);
    assert.equal(pair.severity, 'critical');
    assert.deepEqual(pair.triage, { classification: 'MAJOR', priority: 'Critical' });
  }
  const pair = evaluatePairResults([photo(null, 0.99), photo('constructor', 0.98)]);
  assert.equal(pair.severity, null);
  assert.equal(pair.triage, null);
});

test('approved measurement fixtures flow from scan through Citizen card, report and SQL verification', async () => {
  let category = 'pothole', depth, missingAlternate = false, version = '1';
  const detection = () => ({
    damage_type: category, confidence_score: 0.98, bounding_box: box,
    severity_measurement: depth === undefined ? undefined : {
      source: 'fixture-gauge', version, evidence: { depth_mm: depth, diameter_mm: 100 },
      uncertainty: { depth_mm: 0.1, diameter_mm: 1 }
    }
  });
  const { server, baseUrl } = await startTestServer({
    inference: async buffer => ({ visual_extent: extentFixture, image_size: imageSize, detections: [missingAlternate && buffer.equals(SECOND_JPEG_BYTES)
      ? { ...detection(), severity_measurement: undefined, severity_level: 'critical' } : detection()] }),
    pairInference: async () => ({ image1_detections: [detection()], image2_detections: [detection()] })
  });
  try {
    const { token } = await seedCitizen({ username: 'severity_' + randomUUID().slice(0, 8), password: 'SeverityFixture123', barangay: 'Villamonte', reporting: true });
    const admin = await adminSession(baseUrl);
    const official = await createOfficial(baseUrl, admin.token, 'Villamonte', 'severity_authority');
    const post = (route, body) => fetch(baseUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    function images() {
      const form = new FormData();
      [JPEG_BYTES, SECOND_JPEG_BYTES].forEach((bytes, index) => form.append('images', new Blob([bytes], { type: 'image/jpeg' }), `angle-${index}.jpg`));
      return form;
    }
    async function scan(form = images()) {
      form.append('assessment', 'pair');
      const response = await post('/api/ai/damage', form);
      assert.equal(response.status, 200);
      const data = await response.json();
      const result = assessPair(data.photos.map(({ result }) => ({ ok: true, result, severitySuggestion: data.severitySuggestion })));
      assert.equal(result.canonicalClass, category);
      assert.equal(result.submittable, true);
      return { data, markup: renderAssessment(result, { escapeHtml: String, priorityBadge: String }) };
    }
    for (category of ['pothole', 'road_crack', 'clogged_drainage', 'broken_streetlight']) {
      const { data, markup } = await scan();
      assert.equal(data.severitySuggestion, null);
      assert.match(markup, /data-damage-severity>Not assessed<\/strong>/);
      assert.match(markup, /Insufficient severity evidence/);
      assert.doesNotMatch(markup, /<select/);
    }
    category = 'pothole';
    for (const [mm, classification, level] of [[-1, null, null], [20, null, null], [19, 'MINOR', 'low'], [21, 'MAJOR', 'high']]) {
      depth = mm;
      const { data, markup } = await scan();
      assert.equal(data.severityStatus, classification ? 'ASSESSED' : 'NOT_ASSESSED');
      assert.equal(data.severitySuggestion?.classification ?? null, classification);
      assert.deepEqual(data.photos[0].result.visual_extent, extentFixture);
      assert.doesNotMatch(markup, /Visual observations|threshold_stability_iou/);
      const label = { MAJOR: 'Major', MINOR: 'Minor' }[classification] || 'Not assessed';
      assert.ok(markup.includes(`data-damage-severity>${label}</strong>`));
      if (classification) assert.match(markup, /data-severity-basis>AI suggestion/);
      const form = images();
      form.append('description', 'Controlled physical measurement evidence fixture.');
      form.append('barangay', 'Villamonte');
      form.append('landmarkDescription', 'Beside the school entrance.');
      form.append('landmarkImage', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'landmark.jpg');
      addReportGps(form, 'Villamonte');
      form.append('citizenCategory', 'Road Damage');
      form.append('assessmentProofs', JSON.stringify(data.photos.map(photo => photo.assessmentProof)));
      form.append('aiClassification', 'MAJOR');
      form.append('visualExtents', JSON.stringify([{ severity: 'MAJOR' }]));
      form.append('aiPriority', 'Critical');
      // A different submission-time result must not rewrite the signed scan.
      if (classification === 'MAJOR') depth = 19;
      const response = await post('/api/reports', form);
      const report = await response.json();
      assert.equal(response.status, 201, JSON.stringify(report));
      assert.equal(report.ai_classification, null);
      assert.equal(report.ai_priority, null);
      assert.deepEqual(report.severitySuggestion ?? null, data.severitySuggestion);
      assert.equal(report.suggestedClassification ?? null, classification);
      assert.deepEqual(report.visualExtents, [extentFixture, extentFixture]);
      const [verification] = await testDatabase().query('SELECT highest_severity FROM damage_verifications WHERE report_id = ?', [report.id]);
      assert.equal(verification.highest_severity, level);
      if (classification !== 'MAJOR') continue;
      const listing = url => fetch(baseUrl + url, { headers: { Authorization: `Bearer ${official.token}` } }).then(response => response.json());
      const before = await listing('/api/reports?page=1');
      assert.ok(before.stats.major >= 1);
      assert.equal(before.reports.find(item => item.id === report.id)?.suggestedClassification, 'MAJOR');
      const majorPage = await listing('/api/reports?classification=MAJOR&page=1');
      assert.ok(majorPage.reports.some(item => item.id === report.id));
      const saved = await fetch(baseUrl + `/api/reports/${report.id}/severity`, {
        method: 'POST', headers: { Authorization: `Bearer ${official.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, classification: 'MINOR', priority: 'Low',
          evidence: { safety_impact: 'A controlled inspection found no traffic obstruction.' },
          reason: 'Severity changed after the controlled field inspection.', requestKey: randomUUID(), expectedReviewId: 0 })
      });
      assert.equal(saved.status, 200);
      const after = await listing('/api/reports?page=1');
      assert.equal(after.stats.minor, before.stats.minor + 1);
      assert.equal(after.stats.major, before.stats.major - 1);
      const detail = await listing(`/api/reports/${report.id}`);
      assert.equal(detail.ai_classification, 'MINOR');
      assert.equal(detail.barangayReview, 'confirmed');
      assert.deepEqual(detail.severitySuggestion, data.severitySuggestion);
      assert.deepEqual(detail.visualExtents, [extentFixture, extentFixture]);
    }
    depth = 21;
    version = 'incompatible';
    assert.equal((await scan()).data.severitySuggestion, null);
    version = '1';
    missingAlternate = true;
    assert.equal((await scan()).data.severitySuggestion, null);
    const reverse = new FormData();
    [SECOND_JPEG_BYTES, JPEG_BYTES].forEach(bytes => reverse.append('images', new Blob([bytes], { type: 'image/jpeg' }), 'angle.jpg'));
    assert.equal((await scan(reverse)).data.severitySuggestion, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    testDatabase().close();
  }
});
