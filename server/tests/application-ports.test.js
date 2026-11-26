const test = require('node:test');
const assert = require('node:assert/strict');
const { createReportService } = require('../application/use-cases/report.service');
const { createDamageDetectionService } = require('../application/use-cases/damageDetection.service');
const { createGeofenceService } = require('../application/use-cases/geofence.service');
const { validateReport } = require('../application/use-cases/report.validation');
const { ValidationError, DamageDetectionError } = require('../domain/errors');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../../tests/support/image-fixtures');

test('report validation port rejects the second image before any inference, upload or persistence', async () => {
  const files = [{ name: 'first' }, { name: 'second' }];
  const landmark = [{ name: 'landmark' }];
  const calls = [];
  const error = new ValidationError('Invalid image.', { code: 'IMAGE_VALIDATION_ERROR' });
  const unexpected = () => assert.fail('No adapter should run after invalid evidence');
  const service = createReportService({
    config: { STORAGE_DRIVER: 'supabase', MAX_GPS_ACCURACY_METERS: 100 },
    imageInput: {
      async validateReportImage(file) {
        calls.push(file.name);
        if (file === files[1]) throw error;
      },
      async removeTemporaryFiles(value) {
        assert.ok(value === files || value === landmark);
        calls.push(value === files ? 'cleanup:damage' : 'cleanup:landmark');
      }
    },
    getImageStorage: unexpected,
    getDatabase: unexpected,
    geofenceService: { resolveJurisdiction: unexpected },
    damageDetectionService: { detectForReport: unexpected, verifyReportImages: unexpected },
    reportRepository: { create: unexpected },
    reportImageRepository: { createMany: unexpected }
  });
  await assert.rejects(
    service.createReport({ description: 'Damaged road', barangay: 'Barangay Central', landmarkDescription: 'Beside the school entrance.' }, files, { id: 1 }, landmark),
    (value) => value === error
  );
  assert.deepEqual(calls, ['first', 'second', 'cleanup:damage', 'cleanup:landmark']);
});

test('injected inference keeps outages best effort while rejecting image validation errors', async () => {
  const valid = { buffer: JPEG_BYTES, mimetype: 'image/jpeg' };
  const alternate = { buffer: SECOND_JPEG_BYTES, mimetype: 'image/jpeg' };
  let nextError = new DamageDetectionError('Unavailable provider', 'INFERENCE_UNAVAILABLE', 503);
  let calls = 0;
  const service = createDamageDetectionService({
    imageInput: require('../infrastructure/storage/imageInput.adapter'),
    aiProvider: {
      detectionDefaults: () => ({ task: 'detect' }),
      async requestInference() {
        calls += 1;
        throw nextError;
      },
      async requestPairInference() {
        calls += 1;
        throw nextError;
      }
    }
  });
  assert.equal(await service.detectForReport([valid, alternate]), null);
  assert.equal(await service.verifyReportImages([valid, alternate]), null);
  assert.equal(calls, 3);
  nextError = new DamageDetectionError('Unsupported provider task', 'TASK_UNSUPPORTED');
  assert.equal(await service.detectForReport([valid, alternate]), null);
  assert.equal(await service.verifyReportImages([valid, alternate]), null);
  const beforeInvalid = calls;
  const invalid = { buffer: Buffer.from('invalid'), mimeType: 'image/jpeg' };
  await assert.rejects(service.detectForReport([invalid, valid]), { code: 'IMAGE_FORMAT' });
  await assert.rejects(service.verifyReportImages([valid, invalid]), { code: 'IMAGE_FORMAT' });
  assert.equal(calls, beforeInvalid);
});

test('geofence and report validation use the injected GPS configuration', async () => {
  const config = {
    MAX_GPS_ACCURACY_METERS: 75,
    BACOLOD_BBOX: { minLat: 10, maxLat: 11, minLng: 122, maxLng: 123 }
  };
  let queries = 0;
  const service = createGeofenceService({
    config,
    barangayRepository: {
      async findAllWithBoundary() {
        queries += 1;
        return [];
      }
    }
  });
  const result = await service.resolveJurisdiction({ latitude: 10.678, longitude: 122.946, gpsAccuracy: 80 });
  assert.equal(result.gpsAccuracy.thresholdMeters, 75);
  assert.equal(result.gpsAccuracy.status, 'unacceptable');
  assert.equal(result.boundaryCheckStatus, 'inside_service_area');
  assert.equal(queries, 1);
  const body = { description: 'Damaged road', barangay: 'Barangay Central', gpsAccuracy: '80' };
  assert.match(validateReport(body, config.MAX_GPS_ACCURACY_METERS).error, /75 meters/);
  assert.equal(
    validateReport({ ...body, gpsAccuracy: '75' }, config.MAX_GPS_ACCURACY_METERS).value.gpsAccuracy,
    75
  );
});
