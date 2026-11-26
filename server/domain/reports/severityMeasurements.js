const { ValidationError } = require('../errors');

const FIELDS = {
  pothole: [
    { key: 'major_diameter_m', label: 'Major opening diameter (m)', max: 100 },
    { key: 'minor_diameter_m', label: 'Minor opening diameter (m)', max: 100 }
  ],
  road_crack: [
    { key: 'segment_lengths_m', label: 'Measured crack segment lengths (m)', max: 1000, series: true }
  ],
  clogged_drainage: [
    { key: 'obstructed_area_m2', label: 'Obstructed cross-section (m²)', max: 1000000 },
    { key: 'total_area_m2', label: 'Total cross-section (m²)', max: 1000000 },
    { key: 'comparable_cross_sections', label: 'Areas share a comparable cross-section', boolean: true }
  ]
};

const DERIVED_LIMITS = {
  pothole: { estimated_area_mm2: Math.PI * 50000 ** 2, elliptical_area_m2: Math.PI * 50 ** 2 },
  road_crack: { total_length_m: 1000 },
  clogged_drainage: { computed_obstruction_percent: 100 }
};

function isMeasurement(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function normalizeMeasurement(field, value) {
  if (!field.series && isMeasurement(value, field.max)) return value;
  if (field.series && Array.isArray(value) && value.length > 0 && value.length <= 256 &&
      value.every(segment => isMeasurement(segment, field.max) && segment > 0) &&
      value.reduce((sum, segment) => sum + segment, 0) <= field.max) return value.slice();
  throw new ValidationError(`Invalid ${field.label.toLowerCase()}.`);
}

function measurementBounds(fields, evidence, uncertainty) {
  if (uncertainty !== undefined && (!uncertainty || typeof uncertainty !== 'object' || Array.isArray(uncertainty))) {
    throw new ValidationError('Invalid measurement uncertainty.');
  }
  const numeric = Object.keys(evidence).filter(key => fields.get(key)?.max);
  if (uncertainty !== undefined && (
    Object.keys(uncertainty).length !== numeric.length ||
    numeric.some(key => !isMeasurement(uncertainty[key], fields.get(key).max))
  )) throw new ValidationError('Supply uncertainty in the same unit for every numeric measurement.');
  return Object.fromEntries(numeric.map(key => {
    const samples = Array.isArray(evidence[key]) ? evidence[key] : [evidence[key]];
    const radius = uncertainty?.[key] ?? 0;
    const low = samples.reduce((sum, value) => sum + Math.max(0, value - radius), 0);
    const high = samples.reduce((sum, value) => sum + value + radius, 0);
    return [key, [low, high]];
  }));
}

function derivedMeasurements(category, evidence, bounds) {
  const derived = {};
  function add(key, value, low, high) {
    derived[key] = value;
    bounds[key] = [low, high];
  }
  if (category === 'pothole') {
    if (bounds.diameter_mm) {
      const area = diameter => Math.PI * (diameter / 2) ** 2;
      add('estimated_area_mm2', area(evidence.diameter_mm), ...bounds.diameter_mm.map(area));
    }
    const major = evidence.major_diameter_m, minor = evidence.minor_diameter_m;
    if (major > 0 && minor > 0 && major >= minor && bounds.minor_diameter_m[0] > 0 && bounds.major_diameter_m[0] > 0) {
      const area = (a, b) => Math.PI * a * b / 4;
      add('elliptical_area_m2', area(major, minor), area(bounds.major_diameter_m[0], bounds.minor_diameter_m[0]),
        area(bounds.major_diameter_m[1], bounds.minor_diameter_m[1]));
    }
  } else if (category === 'road_crack' && bounds.segment_lengths_m) {
    add('total_length_m', evidence.segment_lengths_m.reduce((sum, length) => sum + length, 0), ...bounds.segment_lengths_m);
  } else if (category === 'clogged_drainage' && evidence.comparable_cross_sections &&
      evidence.total_area_m2 > 0 && bounds.total_area_m2[0] > 0 && evidence.obstructed_area_m2 <= evidence.total_area_m2) {
    const percentage = (part, whole) => 100 * (part / whole);
    add('computed_obstruction_percent', percentage(evidence.obstructed_area_m2, evidence.total_area_m2),
      percentage(bounds.obstructed_area_m2[0], bounds.total_area_m2[1]),
      Math.min(100, percentage(bounds.obstructed_area_m2[1], bounds.total_area_m2[0])));
  }
  return derived;
}

module.exports = { FIELDS, DERIVED_LIMITS, normalizeMeasurement, measurementBounds, derivedMeasurements };
