const {
  REQUIRED_IMAGE_COUNT,
  normalizeStatus,
  hasRequiredImageCount
} = require('../../domain/reports/report.rules');
const { isAiReportCategory } = require('../../domain/reports/damageCategories');

const LATITUDE_RANGE = Object.freeze({ min: -90, max: 90 });
const LONGITUDE_RANGE = Object.freeze({ min: -180, max: 180 });
const LANDMARK_DESCRIPTION_MAX = 250;

function text(value, max = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function outOfRange(value, { min, max }) {
  return value !== null && (value < min || value > max);
}

function validateReport(body, maxGpsAccuracyMeters = 100) {
  const citizenCategory = body?.citizenCategory;
  if (citizenCategory !== undefined && !isAiReportCategory(citizenCategory)) return { error: 'Invalid citizen report category.' };
  const description = text(body?.description, 2000);
  const barangay = text(body?.barangay, 100);
  if (!description) return { error: 'Description is required.' };

  const latitude = finiteOrNull(body?.latitude);
  const longitude = finiteOrNull(body?.longitude);

  if (outOfRange(latitude, LATITUDE_RANGE)) {
    return { error: 'Latitude must be between -90 and 90.' };
  }
  if (outOfRange(longitude, LONGITUDE_RANGE)) {
    return { error: 'Longitude must be between -180 and 180.' };
  }

  if ((latitude !== null && longitude === null) || (latitude === null && longitude !== null)) {
    return { error: 'Both latitude and longitude must be provided together.' };
  }

  const rawAccuracy = body?.gpsAccuracy ?? body?.gps_accuracy;
  let gpsAccuracy = null;

  if (rawAccuracy !== undefined && rawAccuracy !== null && String(rawAccuracy).trim() !== '') {
    const parsed = Number(rawAccuracy);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: 'GPS accuracy must be a valid non-negative number.' };
    }
    if (parsed > maxGpsAccuracyMeters) {
      return { error: `GPS accuracy radius exceeds maximum allowed threshold of ${maxGpsAccuracyMeters} meters.` };
    }
    gpsAccuracy = parsed;
  }

  return {
    value: {
      description,
      citizenCategory: citizenCategory ?? null,
      location: text(body?.location, 300),
      barangay,
      latitude,
      longitude,
      gpsAccuracy
    }
  };
}

function validateImageCount(files) {
  const count = Array.isArray(files) ? files.length : 0;
  if (!hasRequiredImageCount(count)) {
    return { error: `Exactly ${REQUIRED_IMAGE_COUNT} evidence images are required (received ${count}).` };
  }
  return { value: files };
}

function validateLandmark(body, landmarkFiles) {
  const rawDescription = body?.landmarkDescription;

  if (!rawDescription || typeof rawDescription !== 'string' || !rawDescription.trim()) {
    return { error: 'Landmark description is required.' };
  }

  const trimmed = rawDescription.trim();

  if (trimmed.length > LANDMARK_DESCRIPTION_MAX) {
    return { error: `Landmark description must not exceed ${LANDMARK_DESCRIPTION_MAX} characters.` };
  }

  const count = Array.isArray(landmarkFiles) ? landmarkFiles.length : 0;

  if (count === 0) {
    return { error: 'A landmark photo is required.' };
  }

  if (count > 1) {
    return { error: 'Only one landmark photo is allowed.' };
  }

  return { value: { landmarkDescription: trimmed, landmarkFile: landmarkFiles[0] } };
}

function validateStatus(status) {
  return normalizeStatus(status);
}

module.exports = {
  validateReport,
  validateImageCount,
  validateLandmark,
  validateStatus,
  LATITUDE_RANGE,
  LONGITUDE_RANGE,
  REQUIRED_IMAGE_COUNT,
  LANDMARK_DESCRIPTION_MAX
};
