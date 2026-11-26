const { valid, inspect } = require('../../../shared/geoContainment');

const JurisdictionStatus = Object.freeze({
  RESOLVED: 'RESOLVED',
  INVALID_COORDINATES: 'INVALID_COORDINATES',
  AUTHORITATIVE_POLYGONS_PENDING: 'AUTHORITATIVE_POLYGONS_PENDING',
  GPS_ACCURACY_UNACCEPTABLE: 'GPS_ACCURACY_UNACCEPTABLE',
  NO_MATCHING_POLYGON: 'NO_MATCHING_POLYGON',
  AMBIGUOUS_JURISDICTION: 'AMBIGUOUS_JURISDICTION'
});

const BoundaryCheckStatus = Object.freeze({
  INSIDE: 'inside_service_area',
  OUTSIDE: 'outside_service_area',
  UNKNOWN: 'service_area_unknown'
});

const GpsAccuracyStatus = Object.freeze({
  ACCEPTABLE: 'acceptable',
  UNACCEPTABLE: 'unacceptable',
  UNKNOWN: 'unknown'
});

function isFreshGpsFix(timestamp, now) {
  return Number.isSafeInteger(timestamp) && timestamp > 0 && now - timestamp <= 30_000 && timestamp - now <= 5_000;
}

function normalizeBoundary(boundary) {
  if (!Array.isArray(boundary)) return boundary;
  // Older stored outlines use an open ring of [latitude, longitude] pairs.
  if (boundary.some(point => !Array.isArray(point))) return null;
  const ring = boundary.map(([latitude, longitude]) => [longitude, latitude]);
  if (!ring.length) return null;
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] };
}

function pointInPolygon(lat, lng, polygon) {
  const result = inspect(lat, lng, normalizeBoundary(polygon));
  return Boolean(result?.inside && result.edgeMeters > 0.001);
}

function isInsideServiceArea(latitude, longitude, { minLat, maxLat, minLng, maxLng }) {
  return latitude >= minLat && latitude <= maxLat && longitude >= minLng && longitude <= maxLng;
}

function boundaryCheckStatusFor(latitude, longitude, boundingBox) {
  return isInsideServiceArea(latitude, longitude, boundingBox)
    ? BoundaryCheckStatus.INSIDE
    : BoundaryCheckStatus.OUTSIDE;
}

function classifyGpsAccuracy(reportedMeters, thresholdMeters) {
  const radius = Number(reportedMeters);
  if (reportedMeters === null || reportedMeters === undefined || !Number.isFinite(radius) || radius < 0) {
    return GpsAccuracyStatus.UNKNOWN;
  }
  if (!Number.isFinite(Number(thresholdMeters))) return GpsAccuracyStatus.UNKNOWN;
  return radius <= Number(thresholdMeters) ? GpsAccuracyStatus.ACCEPTABLE : GpsAccuracyStatus.UNACCEPTABLE;
}

module.exports = {
  isFreshGpsFix,
  JurisdictionStatus,
  BoundaryCheckStatus,
  GpsAccuracyStatus,
  areValidCoordinates: valid,
  normalizeBoundary,
  pointInPolygon,
  isInsideServiceArea,
  boundaryCheckStatusFor,
  classifyGpsAccuracy
};
