const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSeverity, FIELDS } = require('../domain/reports/reportSeverity.rules');

for (const category of Object.keys(FIELDS)) {
  test(`${category}: no approved thresholds or measurements never invent Minor/Major`, () => {
    assert.equal(evaluateSeverity(category).status, 'REVIEW_REQUIRED');
    const evidence = Object.fromEntries(FIELDS[category].map(field => [field.key, field.boolean ? true : field.series ? [field.max] : field.max]));
    assert.equal(evaluateSeverity(category, evidence).recommendation, null);
    assert.throws(() => evaluateSeverity(category, { confidence: 0.99 }), /Unsupported/);
  });
}

for (const [category, key] of [['pothole', 'depth_mm'], ['road_crack', 'width_mm'], ['clogged_drainage', 'obstruction_percent']]) {
  test(`${category}: configured test-only threshold is inclusive and requires real measurement`, () => {
    const policy = { approvedBy: 'Isolated test fixture, not LGU policy', version: 'fixture-v1', rules: { [category]: { majorAtOrAbove: { [key]: 20 } } } };
    assert.equal(evaluateSeverity(category, {}, policy).status, 'REVIEW_REQUIRED');
    assert.equal(evaluateSeverity(category, { [key]: 19.9 }, policy).recommendation, 'MINOR');
    assert.equal(evaluateSeverity(category, { [key]: 20 }, policy).recommendation, 'MAJOR');
    assert.equal(evaluateSeverity(category, { [key]: 20.1 }, policy).recommendation, 'MAJOR');
    assert.throws(() => evaluateSeverity(category, { [key]: -1 }, policy), /Invalid/);
    assert.throws(() => evaluateSeverity(category, { [key]: '20' }, policy), /Invalid/);
    assert.throws(() => evaluateSeverity(category, { [key]: Infinity }, policy), /Invalid/);
  });
}

test('streetlight: explicitly configured functional-failure criterion does not infer unobserved facts', () => {
  const policy = { approvedBy: 'Test fixture', version: 'fixture-v1', rules: { broken_streetlight: { majorWhen: { nonfunctional: true } } } };
  assert.equal(evaluateSeverity('broken_streetlight', {}, policy).status, 'REVIEW_REQUIRED');
  assert.equal(evaluateSeverity('broken_streetlight', { nonfunctional: false }, policy).recommendation, 'MINOR');
  assert.equal(evaluateSeverity('broken_streetlight', { nonfunctional: true }, policy).recommendation, 'MAJOR');
  assert.throws(() => evaluateSeverity('broken_streetlight', { nonfunctional: 1 }, policy), /yes or no/);
});

test('invalid categories and evidence cannot drive a severity recommendation', () => {
  assert.throws(() => evaluateSeverity('unknown'), /supported/);
  assert.throws(() => evaluateSeverity('pothole', []), /evidence/);
  assert.throws(() => evaluateSeverity('clogged_drainage', { obstruction_percent: 101 }), /Invalid/);
  assert.deepEqual(evaluateSeverity('pothole', { safety_impact: 'Inspection recorded', depth_mm: 1 }).evidence,
    evaluateSeverity('pothole', { depth_mm: 1, safety_impact: 'Inspection recorded' }).evidence);
});

test('a circular pothole area uses measured diameter and only an approved area threshold', () => {
  const policy = { approvedBy: 'Test fixture', version: 'test-area',
    rules: { pothole: { majorAtOrAbove: { estimated_area_mm2: Math.PI * 50 ** 2 } } } };
  assert.equal(evaluateSeverity('pothole', {}, policy).recommendation, null);
  assert.equal(evaluateSeverity('pothole', { diameter_mm: 99 }, policy).recommendation, 'MINOR');
  const result = evaluateSeverity('pothole', { diameter_mm: 100 }, policy);
  assert.equal(result.derived.estimated_area_mm2, Math.PI * 50 ** 2);
  assert.equal(result.recommendation, 'MAJOR');
  assert.equal(evaluateSeverity('pothole', { diameter_mm: 100 }, { ...policy, approvedBy: ' ' }).recommendation, null);
  assert.throws(() => evaluateSeverity('pothole', { estimated_area_mm2: 9000 }, policy), /Unsupported/);
});

test('calibrated elliptical axes produce area in m² and threshold intervals can abstain', () => {
  const evidence = { major_diameter_m: 0.4, minor_diameter_m: 0.2 };
  const threshold = Math.PI * 0.4 * 0.2 / 4;
  const policy = { approvedBy: 'Fixture', version: 'fixture-v2',
    rules: { pothole: { majorAtOrAbove: { elliptical_area_m2: threshold } } } };
  assert.equal(evaluateSeverity('pothole', evidence, policy).derived.elliptical_area_m2, threshold);
  assert.equal(evaluateSeverity('pothole', evidence, policy).recommendation, 'MAJOR');
  assert.equal(evaluateSeverity('pothole', evidence, policy, { major_diameter_m: 0.01, minor_diameter_m: 0.01 }).recommendation, null);
  assert.equal(evaluateSeverity('pothole', { major_diameter_m: 0.4 }, policy).recommendation, null);
  assert.equal(evaluateSeverity('pothole', { ...evidence, minor_diameter_m: 0 }, policy).recommendation, null);
  assert.throws(() => evaluateSeverity('pothole', evidence, policy, { major_diameter_m: 0.01 }), /uncertainty/i);
});

test('crack length sums valid measured segments and rejects invalid or implicit units', () => {
  const policy = { approvedBy: 'Fixture', version: 'fixture-v2',
    rules: { road_crack: { majorAtOrAbove: { total_length_m: 0.75 } } } };
  const data = { segment_lengths_m: [0.25, 0.5] };
  assert.equal(evaluateSeverity('road_crack', data, policy).derived.total_length_m, 0.75);
  assert.equal(evaluateSeverity('road_crack', data, policy, { segment_lengths_m: 0.01 }).recommendation, null);
  for (const parts of [[0], [NaN], [Infinity], [-1], ['0.25'], [], [800, 900]]) {
    assert.throws(() => evaluateSeverity('road_crack', { segment_lengths_m: parts }, policy), /invalid/i);
  }
  assert.throws(() => evaluateSeverity('road_crack', { segment_lengths_mm: [250] }, policy), /unsupported/i);
});

test('drainage ratio needs comparable areas and a positive denominator including measurement error', () => {
  const policy = { approvedBy: 'Fixture', version: 'fixture-v2',
    rules: { clogged_drainage: { majorAtOrAbove: { computed_obstruction_percent: 25 } } } };
  const evidence = { obstructed_area_m2: 0.5, total_area_m2: 2, comparable_cross_sections: true };
  const evaluate = (overrides, uncertainty) => evaluateSeverity('clogged_drainage', { ...evidence, ...overrides }, policy, uncertainty);
  assert.equal(evaluate().derived.computed_obstruction_percent, 25);
  assert.equal(evaluate().recommendation, 'MAJOR');
  assert.equal(evaluate({ obstructed_area_m2: 0 }).recommendation, 'MINOR');
  for (const invalid of [{ total_area_m2: 0 }, { obstructed_area_m2: 3 }, { comparable_cross_sections: false }]) {
    assert.equal(evaluate(invalid).recommendation, null);
  }
  assert.equal(evaluate({}, { obstructed_area_m2: 0.1, total_area_m2: 2 }).recommendation, null);
});
