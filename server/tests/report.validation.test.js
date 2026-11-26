const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReport } = require('../application/use-cases/report.validation');

test('validateReport accepts 15m GPS accuracy with coordinates', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: '10.6780',
    longitude: '122.9460',
    gpsAccuracy: '15'
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.gpsAccuracy, 15);
  assert.equal(result.value.latitude, 10.678);
  assert.equal(result.value.longitude, 122.946);
});

test('validateReport accepts 99.9m GPS accuracy below the threshold', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: 10.6780,
    longitude: 122.9460,
    gpsAccuracy: 99.9
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.gpsAccuracy, 99.9);
});

test('validateReport rejects 100.01m GPS accuracy just above the threshold', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: 10.6780,
    longitude: 122.9460,
    gpsAccuracy: 100.01
  });

  assert.ok(result.error);
  assert.match(result.error, /exceeds maximum allowed threshold/i);
});

test('validateReport accepts exact 100m threshold GPS accuracy', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: 10.6780,
    longitude: 122.9460,
    gpsAccuracy: 100
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.gpsAccuracy, 100);
});

test('validateReport rejects GPS accuracy exceeding 100m threshold', () => {
  for (const excessive of [100.1, 101, 150, 500]) {
    const result = validateReport({
      description: 'Valid issue description',
      barangay: 'Barangay 1',
      latitude: 10.6780,
      longitude: 122.9460,
      gpsAccuracy: excessive
    });

    assert.ok(result.error, `accuracy ${excessive}m must be rejected`);
    assert.match(result.error, /exceeds maximum allowed threshold/i);
  }
});

test('validateReport rejects malformed or negative GPS accuracy', () => {
  for (const malformed of ['not-a-number', -1, -50, 'bad', NaN, Infinity]) {
    const result = validateReport({
      description: 'Valid issue description',
      barangay: 'Barangay 1',
      latitude: 10.6780,
      longitude: 122.9460,
      gpsAccuracy: malformed
    });

    assert.ok(result.error, `malformed accuracy ${malformed} must be rejected`);
    assert.match(result.error, /valid non-negative number/i);
  }
});

test('validateReport allows omitted GPS accuracy and stores it as null', () => {
  for (const empty of [undefined, null]) {
    const result = validateReport({
      description: 'Valid issue description',
      barangay: 'Barangay 1',
      latitude: 10.6780,
      longitude: 122.9460,
      gpsAccuracy: empty
    });

    assert.equal(result.error, undefined);
    assert.equal(result.value.gpsAccuracy, null);
  }
});

test('validateReport preserves explicit null coordinates as null rather than coercing to zero', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: null,
    longitude: null
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.latitude, null);
  assert.equal(result.value.longitude, null);
  assert.notEqual(result.value.latitude, 0);
  assert.notEqual(result.value.longitude, 0);
});

test('validateReport preserves empty string coordinates as null rather than coercing to zero', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: '',
    longitude: ''
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.latitude, null);
  assert.equal(result.value.longitude, null);
  assert.notEqual(result.value.latitude, 0);
  assert.notEqual(result.value.longitude, 0);
});

test('validateReport still accepts a genuine zero coordinate value', () => {
  const result = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: 0,
    longitude: 0
  });

  assert.equal(result.error, undefined);
  assert.equal(result.value.latitude, 0);
  assert.equal(result.value.longitude, 0);
});

test('validateReport rejects partial coordinates when only one axis is supplied', () => {
  const onlyLat = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    latitude: 10.6780,
    gpsAccuracy: 15
  });
  assert.ok(onlyLat.error);
  assert.match(onlyLat.error, /Both latitude and longitude must be provided together/i);

  const onlyLng = validateReport({
    description: 'Valid issue description',
    barangay: 'Barangay 1',
    longitude: 122.9460,
    gpsAccuracy: 15
  });
  assert.ok(onlyLng.error);
  assert.match(onlyLng.error, /Both latitude and longitude must be provided together/i);
});
