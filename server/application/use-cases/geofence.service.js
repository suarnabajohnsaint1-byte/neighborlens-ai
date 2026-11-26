const { inspect } = require('../../../shared/geoContainment');
const {
  JurisdictionStatus,
  BoundaryCheckStatus,
  GpsAccuracyStatus,
  areValidCoordinates,
  normalizeBoundary,
  boundaryCheckStatusFor,
  classifyGpsAccuracy
} = require('../../domain/geofencing/geofence.rules');

function createGeofenceService({ config: env, barangayRepository, loadBoundary }) {
  let dataset;
  class GeofenceService {
    async resolveJurisdiction({ latitude, longitude, gpsAccuracy = null, requireCityPolygon = false }, client) {
      const gpsAccuracyStatus = classifyGpsAccuracy(gpsAccuracy, env.MAX_GPS_ACCURACY_METERS);
      const accuracyReport = {
        reportedMeters: gpsAccuracyStatus === GpsAccuracyStatus.UNKNOWN ? null : Number(gpsAccuracy),
        thresholdMeters: env.MAX_GPS_ACCURACY_METERS,
        status: gpsAccuracyStatus
      };

      if (!areValidCoordinates(latitude, longitude)) {
        return {
          status: JurisdictionStatus.INVALID_COORDINATES,
          barangayId: null,
          boundaryCheckStatus: BoundaryCheckStatus.UNKNOWN,
          gpsAccuracy: accuracyReport,
          note: 'Latitude/longitude were missing or not numeric.'
        };
      }

      let boundaryCheckStatus = boundaryCheckStatusFor(latitude, longitude, env.BACOLOD_BBOX);
      if (requireCityPolygon && loadBoundary) {
        dataset ??= loadBoundary().catch(error => { dataset = null; throw error; });
        const boundary = await dataset.catch(() => null);
        const city = inspect(latitude, longitude, boundary?.city);
        if (!city || gpsAccuracyStatus === GpsAccuracyStatus.UNKNOWN || city.edgeMeters <= Number(gpsAccuracy)) {
          return { status: JurisdictionStatus.AMBIGUOUS_JURISDICTION, barangayId: null,
            boundaryCheckStatus: BoundaryCheckStatus.UNKNOWN, gpsAccuracy: accuracyReport };
        }
        boundaryCheckStatus = city.inside ? BoundaryCheckStatus.INSIDE : BoundaryCheckStatus.OUTSIDE;
      }

      const authoritativeBarangays = await barangayRepository.findAllWithBoundary(client);
      if (!authoritativeBarangays.length) {
        return {
          status: JurisdictionStatus.AUTHORITATIVE_POLYGONS_PENDING,
          barangayId: null,
          boundaryCheckStatus,
          gpsAccuracy: accuracyReport,
          note: 'No authoritative Bacolod barangay polygon dataset is loaded yet; jurisdiction cannot be resolved from GPS alone.'
        };
      }

      if (gpsAccuracyStatus === GpsAccuracyStatus.UNACCEPTABLE) {
        return {
          status: JurisdictionStatus.GPS_ACCURACY_UNACCEPTABLE,
          barangayId: null,
          boundaryCheckStatus,
          gpsAccuracy: accuracyReport,
          note: `Reported GPS accuracy radius exceeds the ${env.MAX_GPS_ACCURACY_METERS} m threshold; jurisdiction was not resolved from this fix.`
        };
      }

      if (boundaryCheckStatus === BoundaryCheckStatus.OUTSIDE || gpsAccuracyStatus === GpsAccuracyStatus.UNKNOWN) {
        return {
          status: boundaryCheckStatus === BoundaryCheckStatus.OUTSIDE ? JurisdictionStatus.NO_MATCHING_POLYGON : JurisdictionStatus.AMBIGUOUS_JURISDICTION,
          barangayId: null, boundaryCheckStatus, gpsAccuracy: accuracyReport,
          note: 'The point is outside the service area or its GPS accuracy is unknown.'
        };
      }

      const matchedBarangays = [];
      let nearBoundary = false;
      for (const row of authoritativeBarangays) {
        let geometry;
        try {
          geometry = normalizeBoundary(typeof row.boundary_geojson === 'string' ? JSON.parse(row.boundary_geojson) : row.boundary_geojson);
        } catch {
          geometry = null;
        }
        const result = inspect(latitude, longitude, geometry);
        if (!result || !row.boundary_source?.trim() || !row.boundary_version?.trim()) {
          return {
            status: JurisdictionStatus.AMBIGUOUS_JURISDICTION,
            barangayId: null, boundaryCheckStatus, gpsAccuracy: accuracyReport,
            note: 'A loaded boundary is malformed or lacks provenance.'
          };
        }
        nearBoundary ||= result.edgeMeters <= Math.max(0.001, accuracyReport.reportedMeters);
        if (result.inside) matchedBarangays.push({ row, geometry });
      }

      if (matchedBarangays.length > 1 || nearBoundary) {
        return {
          status: JurisdictionStatus.AMBIGUOUS_JURISDICTION,
          barangayId: null,
          boundaryCheckStatus,
          gpsAccuracy: accuracyReport,
          note: 'The GPS fix touches a boundary or matches overlapping polygons.'
        };
      }

      if (matchedBarangays.length === 1) {
        const { row, geometry } = matchedBarangays[0];
        return {
          status: JurisdictionStatus.RESOLVED,
          barangayId: row.id,
          boundary: { name: row.name, geometry: geometry.geometry || geometry, source: row.boundary_source, version: row.boundary_version },
          boundaryCheckStatus,
          gpsAccuracy: accuracyReport,
          note: `Resolved via authoritative polygon (source: ${row.boundary_source || 'unknown'}).`
        };
      }

      return {
        status: JurisdictionStatus.NO_MATCHING_POLYGON,
        barangayId: null,
        boundaryCheckStatus,
        gpsAccuracy: accuracyReport,
        note: 'Point did not fall inside any loaded authoritative barangay polygon.'
      };
    }
  }

  return new GeofenceService();
}

module.exports = { createGeofenceService };
