const { ValidationError } = require('../errors');
const { triageForSeverity } = require('./report.rules');
const measurements = require('./severityMeasurements');
const FIELDS = Object.freeze({
  pothole: [
    { key: 'depth_mm', label: 'Measured depth (mm)', max: 10000 },
    { key: 'diameter_mm', label: 'Measured diameter (mm)', max: 100000 },
    ...measurements.FIELDS.pothole
  ],
  road_crack: [
    { key: 'width_mm', label: 'Measured width (mm)', max: 10000 },
    { key: 'length_mm', label: 'Measured length (mm)', max: 1000000 },
    { key: 'displacement_mm', label: 'Measured displacement (mm)', max: 10000 },
    { key: 'affected_area_m2', label: 'Measured affected area (m²)', max: 1000000 },
    { key: 'branching', label: 'Branching observed', boolean: true },
    ...measurements.FIELDS.road_crack
  ],
  broken_streetlight: [
    { key: 'nonfunctional', label: 'Light is not functioning', boolean: true },
    { key: 'electrical_or_structural_hazard', label: 'Electrical or structural hazard observed', boolean: true },
    { key: 'visibility_impact', label: 'Road visibility affected', boolean: true }
  ],
  clogged_drainage: [
    { key: 'obstruction_percent', label: 'Measured obstruction (%)', max: 100 },
    { key: 'water_depth_mm', label: 'Measured standing water depth (mm)', max: 10000 },
    { key: 'drainage_impaired', label: 'Impaired drainage observed', boolean: true },
    ...measurements.FIELDS.clogged_drainage
  ]
});

function evaluateSeverity(category, evidence = {}, policy = {}, uncertainty) {
  if (!Object.hasOwn(FIELDS, category)) throw new ValidationError('Choose a supported damage category.');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new ValidationError('Inspection evidence is required.');
  const allowed = new Map([...FIELDS[category], { key: 'safety_impact', label: 'Observed public-safety impact' }].map(field => [field.key, field]));
  const normalized = {};
  for (const key of Object.keys(evidence).sort()) {
    const value = evidence[key];
    const field = allowed.get(key);
    if (!field) throw new ValidationError('Unsupported inspection evidence.');
    if (key === 'safety_impact') {
      if (typeof value !== 'string' || value.trim().length > 500) throw new ValidationError('Describe the observed impact in at most 500 characters.');
      normalized[key] = value.trim();
    } else if (field.boolean) {
      if (typeof value !== 'boolean') throw new ValidationError(`${field.label} must be yes or no.`);
      normalized[key] = value;
    } else normalized[key] = measurements.normalizeMeasurement(field, value);
  }
  const bounds = measurements.measurementBounds(allowed, normalized, uncertainty);
  const derived = measurements.derivedMeasurements(category, normalized, bounds);
  const limits = measurements.DERIVED_LIMITS[category] || {};
  const rule = policy?.rules?.[category];
  let recommendation = null;
  if (typeof policy.approvedBy === 'string' && policy.approvedBy.trim() &&
      typeof policy.version === 'string' && policy.version.trim() && rule) {
    const thresholds = Object.entries(rule.majorAtOrAbove || {}), conditions = Object.entries(rule.majorWhen || {});
    if (thresholds.length + conditions.length > 0 && thresholds.every(([key, threshold]) =>
      typeof threshold === 'number' && threshold > 0 && threshold <= (allowed.get(key)?.series ? 0 : allowed.get(key)?.max ?? limits[key]) &&
      Object.hasOwn(bounds, key)) &&
      conditions.every(([key, value]) => allowed.get(key)?.boolean && typeof value === 'boolean' && typeof normalized[key] === 'boolean')) {
      if (thresholds.some(([key, threshold]) => bounds[key][0] >= threshold) ||
          conditions.some(([key, value]) => normalized[key] === value)) recommendation = 'MAJOR';
      else if (thresholds.every(([key, threshold]) => bounds[key][1] < threshold)) recommendation = 'MINOR';
    }
  }
  return { category, evidence: normalized, recommendation, derived, status: recommendation || 'REVIEW_REQUIRED', policyVersion: policy?.version || 'manual-review-v1' };
}

function measurementSuggestion(category, measurement, policy) {
  const source = policy?.measurementSource;
  if (!measurement || !source?.id || !source.version || measurement.source !== source.id ||
      measurement.version !== source.version || !measurement.uncertainty) return null;
  let result;
  try { result = evaluateSeverity(category, measurement.evidence, policy, measurement.uncertainty); }
  catch (error) { if (error instanceof ValidationError) return null; throw error; }
  if (!result.recommendation) return null;
  const rule = policy.rules[category];
  const configuredLevel = result.recommendation === 'MAJOR' ? rule.majorSeverity : rule.minorSeverity;
  const level = typeof configuredLevel === 'string' ? configuredLevel.trim().toLowerCase() : null;
  const { aiClassification, aiPriority } = triageForSeverity(level);
  if (aiClassification !== result.recommendation) return null;
  return {
    category, classification: aiClassification, priority: aiPriority, level,
    source: 'approved_measurement_rule', measurementSource: source.id, measurementVersion: source.version,
    policyVersion: result.policyVersion, evidence: result.evidence, uncertainty: measurement.uncertainty, derived: result.derived,
    reasonCode: aiClassification === 'MAJOR' ? 'MAJOR_CRITERION_MET' : 'NO_MAJOR_CRITERION_MET'
  };
}

module.exports = { FIELDS, evaluateSeverity, measurementSuggestion };
