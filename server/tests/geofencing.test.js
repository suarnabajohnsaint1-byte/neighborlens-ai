const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JurisdictionStatus,
  GpsAccuracyStatus,
  pointInPolygon,
  isInsideServiceArea,
  classifyGpsAccuracy
} = require('../domain/geofencing/geofence.rules');
const { geofenceService } = require('../composition');
const barangayRepository = require('../infrastructure/repositories/barangay.repository');

// The coarse Bacolod service-area box, matching the deployed default.
const BACOLOD_BBOX = { minLat: 10.45, maxLat: 10.90, minLng: 122.75, maxLng: 123.20 };

// Stubs the persistence boundary so the service can be exercised without a
// database. Polygons here are synthetic fixtures, never authoritative data.
function withBoundaries(rows, run) {
  const original = barangayRepository.findAllWithBoundary;
  barangayRepository.findAllWithBoundary = async () => rows;
  return Promise.resolve(run()).finally(() => {
    barangayRepository.findAllWithBoundary = original;
  });
}

test('pointInPolygon correctly classifies a point inside a simple square', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(50, 50, square), false);
});

test('pointInPolygon returns false for degenerate (non-polygon) input', () => {
  assert.equal(pointInPolygon(5, 5, []), false);
  assert.equal(pointInPolygon(5, 5, [[0, 0], [1, 1]]), false);
  assert.equal(pointInPolygon(5, 5, null), false);
});

test('pointInPolygon returns false for an unsupported geometry type instead of crashing', () => {
  assert.equal(pointInPolygon(10.678, 122.946, { type: 'Point', coordinates: [122.946, 10.678] }), false);
  assert.equal(pointInPolygon(10.678, 122.946, { type: 'LineString', coordinates: [[122.9, 10.6], [123.0, 10.7]] }), false);
});

test('pointInPolygon returns false for non-numeric coordinates instead of crashing', () => {
  const polygon = {
    type: 'Polygon',
    coordinates: [[['a', 'b'], ['c', 'd'], ['e', 'f']]]
  };
  assert.equal(pointInPolygon(10.678, 122.946, polygon), false);
});

test('pointInPolygon returns false for invalidly nested coordinates instead of crashing', () => {
  assert.equal(pointInPolygon(10.678, 122.946, { type: 'Polygon', coordinates: [10, 20, 30] }), false);
  assert.equal(pointInPolygon(10.678, 122.946, { type: 'Polygon', coordinates: null }), false);
  assert.equal(pointInPolygon(10.678, 122.946, { type: 'Polygon', coordinates: [] }), false);
});

test('pointInPolygon unwraps a GeoJSON Feature to reach its geometry', () => {
  const feature = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[122.90, 10.60], [123.00, 10.60], [123.00, 10.75], [122.90, 10.75], [122.90, 10.60]]]
    }
  };
  assert.equal(pointInPolygon(10.678, 122.946, feature), true);
  assert.equal(pointInPolygon(10.200, 122.946, feature), false);
});

test('pointInPolygon resolves a point on a hole edge deterministically', () => {
  const polygonWithHole = {
    type: 'Polygon',
    coordinates: [
      [[122.90, 10.60], [123.00, 10.60], [123.00, 10.75], [122.90, 10.75], [122.90, 10.60]],
      [[122.94, 10.67], [122.96, 10.67], [122.96, 10.69], [122.94, 10.69], [122.94, 10.67]]
    ]
  };
  const onHoleEdge = pointInPolygon(10.67, 122.95, polygonWithHole);
  assert.equal(typeof onHoleEdge, 'boolean');
  assert.equal(pointInPolygon(10.67, 122.95, polygonWithHole), onHoleEdge, 'hole edge classification must be repeatable');
});

test('pointInPolygon resolves edge and vertex points deterministically', () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
  // Ray casting is half-open: the result on a boundary is stable but is not a
  // claim of boundary-precise jurisdiction.
  const onEdge = pointInPolygon(0, 5, square);
  const onVertex = pointInPolygon(0, 0, square);
  assert.equal(typeof onEdge, 'boolean');
  assert.equal(typeof onVertex, 'boolean');
  assert.equal(pointInPolygon(0, 5, square), onEdge, 'edge classification must be repeatable');
  assert.equal(pointInPolygon(0, 0, square), onVertex, 'vertex classification must be repeatable');
});

test('the bounding box reflects only the coarse Bacolod service area, not a real barangay boundary', () => {
  assert.equal(isInsideServiceArea(10.678, 122.946, BACOLOD_BBOX), true); // inside Bacolod bbox
  assert.equal(isInsideServiceArea(14.5995, 120.9842, BACOLOD_BBOX), false); // Manila, outside bbox
});

test('classifyGpsAccuracy treats a missing or nonsensical radius as unknown, never acceptable', () => {
  assert.equal(classifyGpsAccuracy(null, 100), GpsAccuracyStatus.UNKNOWN);
  assert.equal(classifyGpsAccuracy(undefined, 100), GpsAccuracyStatus.UNKNOWN);
  assert.equal(classifyGpsAccuracy('not-a-number', 100), GpsAccuracyStatus.UNKNOWN);
  assert.equal(classifyGpsAccuracy(-5, 100), GpsAccuracyStatus.UNKNOWN);
  assert.equal(classifyGpsAccuracy(100, 100), GpsAccuracyStatus.ACCEPTABLE);
  assert.equal(classifyGpsAccuracy(100.1, 100), GpsAccuracyStatus.UNACCEPTABLE);
});

test('resolveJurisdiction reports AUTHORITATIVE_POLYGONS_PENDING when no barangay polygons are loaded (current default state)', async () => {
  await withBoundaries([], async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.946 });
    assert.equal(result.status, JurisdictionStatus.AUTHORITATIVE_POLYGONS_PENDING);
    assert.equal(result.barangayId, null);
    assert.equal(result.boundaryCheckStatus, 'inside_service_area');
  });
});

test('resolveJurisdiction rejects missing/non-numeric coordinates without guessing a jurisdiction', async () => {
  const result = await geofenceService.resolveJurisdiction({ latitude: null, longitude: undefined });
  assert.equal(result.status, JurisdictionStatus.INVALID_COORDINATES);
  assert.equal(result.barangayId, null);
});

test('resolveJurisdiction flags a point outside the Bacolod service area without fabricating a barangay', async () => {
  await withBoundaries([], async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 14.5995, longitude: 120.9842 });
    assert.equal(result.barangayId, null);
    assert.equal(result.boundaryCheckStatus, 'outside_service_area');
  });
});

test('resolveJurisdiction resolves a barangay when the point falls inside a loaded polygon', async () => {
  const rows = [{
    id: 42,
    boundary_version: 'fixture-v1',
    boundary_source: 'test-fixture (not authoritative)',
    boundary_geojson: JSON.stringify([[10.60, 122.90], [10.60, 123.00], [10.75, 123.00], [10.75, 122.90]])
  }];

  await withBoundaries(rows, async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.946, gpsAccuracy: 15 });
    assert.equal(result.status, JurisdictionStatus.RESOLVED);
    assert.equal(result.barangayId, 42);
    assert.equal(result.gpsAccuracy.status, GpsAccuracyStatus.ACCEPTABLE);
  });
});

test('resolveJurisdiction reports NO_MATCHING_POLYGON rather than picking the nearest barangay', async () => {
  const rows = [{
    id: 7,
    boundary_version: 'fixture-v1',
    boundary_source: 'test-fixture (not authoritative)',
    boundary_geojson: JSON.stringify([[10.50, 122.80], [10.50, 122.85], [10.55, 122.85], [10.55, 122.80]])
  }];

  await withBoundaries(rows, async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.946, gpsAccuracy: 15 });
    assert.equal(result.status, JurisdictionStatus.NO_MATCHING_POLYGON);
    assert.equal(result.barangayId, null);
  });
});

test('resolveJurisdiction reports an ambiguous result rather than silently choosing the first of two overlapping authoritative polygons', async () => {
  const rows = [
    {
      id: 101,
      boundary_version: 'fixture-v1',
    boundary_source: 'test-fixture (not authoritative)',
      boundary_geojson: JSON.stringify([[10.60, 122.90], [10.60, 123.00], [10.75, 123.00], [10.75, 122.90]])
    },
    {
      id: 102,
      boundary_version: 'fixture-v1',
    boundary_source: 'test-fixture (not authoritative)',
      boundary_geojson: JSON.stringify([[10.65, 122.90], [10.65, 123.00], [10.80, 123.00], [10.80, 122.90]])
    }
  ];

  await withBoundaries(rows, async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.70, longitude: 122.946, gpsAccuracy: 15 });
    assert.equal(result.status, JurisdictionStatus.AMBIGUOUS_JURISDICTION);
    assert.equal(result.barangayId, null);
  });
});

test('resolveJurisdiction leaves jurisdiction unresolved with a malformed stored polygon', async () => {
  const rows = [
    { id: 1, boundary_geojson: '{not json' },
    {
      id: 2,
      boundary_version: 'fixture-v1',
    boundary_source: 'test-fixture (not authoritative)',
      boundary_geojson: JSON.stringify([[10.60, 122.90], [10.60, 123.00], [10.75, 123.00], [10.75, 122.90]])
    }
  ];

  await withBoundaries(rows, async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.946, gpsAccuracy: 15 });
    assert.equal(result.status, JurisdictionStatus.AMBIGUOUS_JURISDICTION);
    assert.equal(result.barangayId, null);
  });
});

test('resolveJurisdiction refuses to resolve from a GPS fix coarser than the threshold', async () => {
  const rows = [{
    id: 42,
    boundary_geojson: JSON.stringify([[10.60, 122.90], [10.60, 123.00], [10.75, 123.00], [10.75, 122.90]])
  }];

  await withBoundaries(rows, async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.946, gpsAccuracy: 750 });
    assert.equal(result.status, JurisdictionStatus.GPS_ACCURACY_UNACCEPTABLE);
    assert.equal(result.barangayId, null);
    assert.equal(result.gpsAccuracy.status, GpsAccuracyStatus.UNACCEPTABLE);
    // The point is still inside the coarse service area; the two checks are
    // reported separately and must not be conflated.
    assert.equal(result.boundaryCheckStatus, 'inside_service_area');
  });
});

test('pointInPolygon correctly handles standard GeoJSON Polygon format [lng, lat]', () => {
  const geojsonPolygon = {
    type: 'Polygon',
    coordinates: [
      [[122.90, 10.60], [123.00, 10.60], [123.00, 10.75], [122.90, 10.75], [122.90, 10.60]]
    ]
  };

  assert.equal(pointInPolygon(10.678, 122.946, geojsonPolygon), true);
  assert.equal(pointInPolygon(10.200, 122.946, geojsonPolygon), false);
});

test('pointInPolygon correctly handles standard GeoJSON MultiPolygon format', () => {
  const geojsonMultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [[122.80, 10.50], [122.85, 10.50], [122.85, 10.55], [122.80, 10.55], [122.80, 10.50]]
      ],
      [
        [[122.90, 10.60], [123.00, 10.60], [123.00, 10.75], [122.90, 10.75], [122.90, 10.60]]
      ]
    ]
  };

  assert.equal(pointInPolygon(10.678, 122.946, geojsonMultiPolygon), true, 'point in second part must be inside');
  assert.equal(pointInPolygon(10.520, 122.820, geojsonMultiPolygon), true, 'point in first part must be inside');
  assert.equal(pointInPolygon(10.000, 122.000, geojsonMultiPolygon), false, 'point far outside must be outside');
});

test('pointInPolygon respects holes in GeoJSON Polygon', () => {
  const polygonWithHole = {
    type: 'Polygon',
    coordinates: [
      // Outer ring
      [[122.90, 10.60], [123.00, 10.60], [123.00, 10.75], [122.90, 10.75], [122.90, 10.60]],
      // Hole inside
      [[122.94, 10.67], [122.96, 10.67], [122.96, 10.69], [122.94, 10.69], [122.94, 10.67]]
    ]
  };

  // Inside the hole -> outside the polygon
  assert.equal(pointInPolygon(10.680, 122.950, polygonWithHole), false);
  // Inside the polygon but outside the hole -> inside
  assert.equal(pointInPolygon(10.610, 122.910, polygonWithHole), true);
});

test('resolveJurisdiction resolves a barangay when stored boundary is standard GeoJSON Polygon', async () => {
  const rows = [{
    id: 99,
    boundary_version: 'fixture-v1',
    boundary_source: 'synthetic-test-fixture (not authoritative)',
    boundary_geojson: JSON.stringify({
      type: 'Polygon',
      coordinates: [
        [[122.90, 10.60], [123.00, 10.60], [123.00, 10.75], [122.90, 10.75], [122.90, 10.60]]
      ]
    })
  }];

  await withBoundaries(rows, async () => {
    const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.946, gpsAccuracy: 15 });
    assert.equal(result.status, JurisdictionStatus.RESOLVED);
    assert.equal(result.barangayId, 99);
  });
});


test('jurisdiction remains unresolved on both sides of a shared edge within the reported GPS radius', async () => {
  const rows = [[122.90, 122.95], [122.95, 123.00]].map(([west, east], index) => ({
    id: index + 1, name: `Synthetic area ${index + 1}`, boundary_source: 'fixture', boundary_version: '1',
    boundary_geojson: { type: 'Polygon', coordinates: [[[west, 10.60], [east, 10.60], [east, 10.75], [west, 10.75], [west, 10.60]]] }
  }));
  await withBoundaries(rows, async () => {
    for (const longitude of [122.94995, 122.95, 122.95005]) {
      const result = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude, gpsAccuracy: 10 });
      assert.equal(result.status, JurisdictionStatus.AMBIGUOUS_JURISDICTION);
      assert.equal(result.barangayId, null);
    }
    const clear = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.949, gpsAccuracy: 10 });
    assert.equal(clear.barangayId, 1);
    const unknown = await geofenceService.resolveJurisdiction({ latitude: 10.678, longitude: 122.949 });
    assert.equal(unknown.barangayId, null);
  });
});
