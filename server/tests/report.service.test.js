const test = require('node:test');
const assert = require('node:assert/strict');
const { JPEG_BYTES, SECOND_JPEG_BYTES } = require('../../tests/support/image-fixtures');

const { reportService, damageDetectionService, geofenceService } = require('../composition');
const reportRepository = require('../infrastructure/repositories/report.repository');
const barangayRepository = require('../infrastructure/repositories/barangay.repository');
const reportImageRepository = require('../infrastructure/repositories/reportImage.repository');
const damageVerificationRepository = require('../infrastructure/repositories/damageVerification.repository');
const auditLogRepository = require('../infrastructure/repositories/auditLog.repository');
const { useTestDatabase, resetDatabase } = require('../infrastructure/database');

// Exercises the createReport workflow with the persistence and detection
// collaborators stubbed, so these assertions are about orchestration and the AI
// trust boundary rather than about SQL.

function uploadedFiles(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/tmp/uploads/file-${index}.jpg`,
    filename: `file-${index}.jpg`,
    size: 100 + index,
    buffer: index === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES,
    mimetype: 'image/jpeg'
  }));
}


function submission(overrides = {}) {
  return {
    description: 'Collapsed drainage cover on the sidewalk',
    barangay: 'Barangay Central',
    latitude: '10.6780',
    longitude: '122.9460',
    gpsAccuracy: '15',
    landmarkDescription: 'Beside the school entrance.',
    ...overrides
  };
}

function landmarkFiles() {
  return [{
    path: '/tmp/uploads/landmark.jpg',
    filename: 'landmark.jpg',
    fieldname: 'landmarkImage',
    size: JPEG_BYTES.length,
    buffer: JPEG_BYTES,
    mimetype: 'image/jpeg'
  }];
}

function acceptedPothole(confidence = 0.9, severity = 'critical') {
  return {
    detected: true, damage_type: 'pothole', confidence_score: confidence, severity_level: severity,
    candidate: { canonical_category: 'pothole', confidence, accepted: true },
    detections: [{ canonical_category: 'pothole', confidence_score: confidence, eligible: true, severity_level: severity }]
  };
}

function install({ detection = null, imageFailure = null, pairVerification = null } = {}) {
  const state = {
    reports: [], images: [], verifications: [], audits: [], unlinked: [],
    detectorCalls: 0, pairCalls: 0
  };
  const restore = [];

  const swap = (target, key, value) => {
    const original = target[key];
    target[key] = value;
    restore.push(() => { target[key] = original; });
  };

  useTestDatabase({
    driver: 'stub',
    query: async () => [],
    execute: async () => ({ insertId: 1, affectedRows: 1 }),
    withTransaction: async (fn) => fn({ stub: true }),
    ping: async () => true,
    close: async () => { }
  });

  swap(geofenceService, 'resolveJurisdiction', async () => ({
    status: 'AUTHORITATIVE_POLYGONS_PENDING',
    barangayId: null,
    boundaryCheckStatus: 'inside_service_area'
  }));

  swap(damageDetectionService, 'processDamageImage', async () => {
    state.detectorCalls += 1;
    if (typeof detection === 'function') return detection(state.detectorCalls);
    if (!detection) throw new Error('provider down');
    return detection;
  });

  swap(damageDetectionService, 'verifyDamagePair', async () => {
    state.pairCalls += 1;
    if (!pairVerification) throw new Error('pair provider down');
    return pairVerification;
  });

  swap(reportRepository, 'create', async (report) => {
    state.reports.push(report);
    return { insertId: state.reports.length };
  });
  swap(barangayRepository, 'findById', async () => null);
  swap(reportRepository, 'findById', async (id) => ({ id, ...state.reports[id - 1] }));
  swap(reportImageRepository, 'createMany', async (reportId, images) => {
    if (imageFailure) throw imageFailure;
    state.images.push(...images);
    return images;
  });
  swap(reportImageRepository, 'findByReportId', async () => state.images);
  swap(damageVerificationRepository, 'create', async (row) => {
    state.verifications.push(row);
    return { insertId: state.verifications.length };
  });
  swap(auditLogRepository, 'create', async (entry) => {
    state.audits.push(entry);
    return { insertId: state.audits.length };
  });

  // Uploads live only in the stub's bookkeeping; nothing touches the disk.
  const fs = require('node:fs/promises');
  swap(fs, 'unlink', async (target) => { state.unlinked.push(target); });

  state.restore = () => {
    restore.reverse().forEach(fn => fn());
    resetDatabase();
  };
  return state;
}

test('a submission that is not exactly two images is rejected and its uploads discarded', async () => {
  for (const count of [0, 1, 3]) {
    const state = install({ detection: acceptedPothole() });
    try {
      await assert.rejects(
        reportService.createReport(submission(), uploadedFiles(count), { id: 1 }, landmarkFiles()),
        error => /Exactly 2 evidence images are required/.test(error.message),
        `image count ${count} must be rejected`
      );
      assert.equal(state.reports.length, 0, 'no report row may be written');
      assert.equal(state.unlinked.length, count + 1, 'uploads must be cleaned up');
    } finally {
      state.restore();
    }
  }
});

test('exactly two images is accepted and both image rows are written in order', async () => {
  const state = install({ detection: acceptedPothole() });
  try {
    await reportService.createReport(submission(), uploadedFiles(), { id: 7 }, landmarkFiles());
    assert.equal(state.reports.length, 1);
    assert.deepEqual(state.images.map(image => image.imageOrder), [1, 2]);
    assert.equal(state.reports[0].landmarkDescription, 'Beside the school entrance.');
    assert.ok(state.reports[0].landmarkImagePath);
    assert.equal(state.audits.length, 1);
  } finally {
    state.restore();
  }
});

test('the server-derived detection overrides the AI values the client claimed', async () => {
  const state = install({
    detection: acceptedPothole(0.93)
  });
  try {
    await reportService.createReport(
      submission({
        aiCategory: 'Client Claimed Category',
        aiClassification: 'MINOR',
        aiPriority: 'Low',
        aiConfidence: '1',
        visionDetected: ''
      }),
      uploadedFiles(),
      { id: 7 },
      landmarkFiles()
    );

    const [row] = state.reports;
    assert.equal(row.aiCategory, 'pothole');
    assert.equal(row.aiConfidence, 93);
    assert.equal(row.aiClassification, null);
    assert.equal(row.aiPriority, null);
    assert.equal(row.visionDetected, true);
  } finally {
    state.restore();
  }
});

test('both evidence images are analysed and the stronger detection wins when the class agrees', async () => {
  const state = install({
    detection: (call) => (call === 1
      ? acceptedPothole(0.62, 'high')
      : acceptedPothole(0.88, 'low'))
  });
  try {
    await reportService.createReport(submission(), uploadedFiles(), { id: 7 }, landmarkFiles());
    assert.equal(state.detectorCalls, 2, 'each evidence image must be analysed');
    assert.equal(state.reports[0].aiCategory, 'pothole');
    assert.equal(state.reports[0].aiConfidence, 88);
    assert.equal(state.reports[0].aiClassification, null);
    assert.equal(state.reports[0].aiPriority, null);
  } finally {
    state.restore();
  }
});

test('a detector outage records no AI assessment and ignores the client claim', async () => {
  const state = install({ detection: null });
  try {
    const created = await reportService.createReport(
      submission({ aiCategory: 'Road Hazard', aiConfidence: '55', aiPriority: 'High', aiClassification: 'MAJOR' }),
      uploadedFiles(),
      { id: 7 },
      landmarkFiles()
    );
    assert.ok(created.id, 'the citizen must still get their report');
    const [row] = state.reports;
    assert.equal(row.aiCategory, null);
    assert.equal(row.aiConfidence, null);
    assert.equal(row.aiPriority, null);
    assert.equal(row.aiClassification, null);
    assert.equal(row.visionDetected, false);
  } finally {
    state.restore();
  }
});

test('a detector that finds nothing records no AI assessment either', async () => {
  const state = install({ detection: { detected: false, damage_type: 'Inconclusive', confidence_score: 0 } });
  try {
    await reportService.createReport(submission({ aiCategory: 'Road Hazard' }), uploadedFiles(), { id: 7 }, landmarkFiles());
    assert.equal(state.reports[0].aiCategory, null);
    assert.equal(state.reports[0].aiPriority, null);
    assert.equal(state.reports[0].visionDetected, false);
  } finally {
    state.restore();
  }
});

test('every AI field a malicious client can post is refused while the detector succeeds', async () => {
  const state = install({
    detection: acceptedPothole(0.93)
  });
  try {
    await reportService.createReport(
      submission({
        aiCategory: 'Nothing To See Here',
        ai_category: 'Nothing To See Here',
        aiClassification: 'MINOR',
        ai_classification: 'MINOR',
        aiPriority: 'Low',
        ai_priority: 'Low',
        aiConfidence: '0',
        ai_confidence: '0',
        visionDetected: 'false',
        vision_detected: 'false'
      }),
      uploadedFiles(),
      { id: 7 },
      landmarkFiles()
    );

    const [row] = state.reports;
    assert.equal(row.aiCategory, 'pothole');
    assert.equal(row.aiConfidence, 93);
    assert.equal(row.aiClassification, null);
    assert.equal(row.aiPriority, null);
    assert.equal(row.visionDetected, true);
  } finally {
    state.restore();
  }
});

test('a failure while writing image rows aborts the report and discards the uploads', async () => {
  const state = install({
    detection: acceptedPothole(),
    imageFailure: new Error('simulated report_images failure')
  });
  try {
    await assert.rejects(
      reportService.createReport(submission(), uploadedFiles(), { id: 7 }, landmarkFiles()),
      /no changes were persisted/
    );
    assert.equal(state.unlinked.length, 3, 'orphan uploads must be removed');
  } finally {
    state.restore();
  }
});

test('a forged client verification payload is never persisted', async () => {
  const state = install({
    detection: acceptedPothole()
  });
  try {
    await reportService.createReport(
      submission({
        verification: JSON.stringify({
          summary: {
            is_valid_match: true,
            composite_similarity_score: 0.99,
            damage_type_consensus: 'forged-by-client',
            highest_severity: 'critical'
          }
        })
      }),
      uploadedFiles(),
      { id: 7 },
      landmarkFiles()
    );

    // The pair provider is unavailable in this setup, so there is no
    // server-derived verification and the client's payload buys nothing.
    assert.equal(state.verifications.length, 0);
  } finally {
    state.restore();
  }
});

test('the verification that is persisted comes from the server pair check', async () => {
  const state = install({
    detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' },
    pairVerification: {
      is_valid_match: true,
      composite_similarity_score: 0.81,
      embedding_similarity: 0.77,
      damage_type_consensus: 'pothole',
      highest_severity: 'critical',
      alignment: { perspective_aligned: true, inlier_ratio: 0.5 },
      summary: { model: 'server-pair-model' }
    }
  });
  try {
    await reportService.createReport(
      submission({
        verification: JSON.stringify({
          summary: { is_valid_match: true, damage_type_consensus: 'forged-by-client' }
        })
      }),
      uploadedFiles(),
      { id: 7 },
      landmarkFiles()
    );

    assert.equal(state.pairCalls, 1, 'the server runs its own pair check');
    assert.equal(state.verifications.length, 1);
    const [row] = state.verifications;
    assert.equal(row.matchedDamageType, 'pothole');
    assert.notEqual(row.matchedDamageType, 'forged-by-client');
    assert.equal(row.compositeSimilarityScore, 0.81);
    assert.equal(row.model, 'server-pair-model');
  } finally {
    state.restore();
  }
});

test('the uploads are removed when the report body itself is invalid', async () => {
  const state = install({ detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' } });
  try {
    await assert.rejects(
      reportService.createReport(submission({ description: '   ' }), uploadedFiles(), { id: 7 }, landmarkFiles()),
      /Description is required/
    );
    assert.equal(state.reports.length, 0);
    assert.equal(state.unlinked.length, 3, 'a rejected body must not leave uploads behind');
  } finally {
    state.restore();
  }
});

test('the uploads survive a report that persisted successfully', async () => {
  const state = install({ detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' } });
  try {
    await reportService.createReport(submission(), uploadedFiles(), { id: 7 }, landmarkFiles());
    assert.equal(state.unlinked.length, 0, 'a stored report must keep its evidence');
  } finally {
    state.restore();
  }
});

test('a submission with unacceptable GPS accuracy is rejected with the threshold message, not a generic persistence failure', async () => {
  const state = install({ detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' } });
  const originalResolve = geofenceService.resolveJurisdiction;
  geofenceService.resolveJurisdiction = async () => ({
    status: 'GPS_ACCURACY_UNACCEPTABLE',
    barangayId: null,
    boundaryCheckStatus: 'inside_service_area',
    gpsAccuracy: { reportedMeters: 750, thresholdMeters: 100, status: 'unacceptable' }
  });

  try {
    await assert.rejects(
      reportService.createReport(submission(), uploadedFiles(), { id: 7 }, landmarkFiles()),
      error => /exceeds maximum allowed threshold/i.test(error.message),
      'the GPS accuracy threshold message must reach the caller, not a generic persistence failure'
    );
    assert.equal(state.reports.length, 0, 'no report row must be persisted');
    assert.equal(state.unlinked.length, 3, 'uploads must be discarded on rejection');
  } finally {
    geofenceService.resolveJurisdiction = originalResolve;
    state.restore();
  }
});

test('a resolved authoritative jurisdiction overrides a mismatched client-declared barangay', async () => {
  const state = install({ detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' } });
  const originalResolve = geofenceService.resolveJurisdiction;
  const originalFindById = barangayRepository.findById;
  geofenceService.resolveJurisdiction = async () => ({
    status: 'RESOLVED',
    barangayId: 42,
    boundaryCheckStatus: 'inside_service_area',
    gpsAccuracy: { reportedMeters: 15, thresholdMeters: 100, status: 'acceptable' }
  });
  barangayRepository.findById = async (id) => (id === 42 ? { id: 42, name: 'Barangay 7' } : null);

  try {
    await reportService.createReport(
      submission({ barangay: 'Mandalagan' }),
      uploadedFiles(),
      { id: 7 },
      landmarkFiles()
    );

    const [row] = state.reports;
    assert.equal(row.barangay, 'Barangay 7', 'the authoritative polygon match must win over the client-declared name');
    assert.notEqual(row.barangay, 'Mandalagan');
    assert.equal(row.barangayId, 42);
    assert.equal(row.jurisdictionSource, 'geofence_resolved');
  } finally {
    geofenceService.resolveJurisdiction = originalResolve;
    barangayRepository.findById = originalFindById;
    state.restore();
  }
});

test('an ambiguous authoritative jurisdiction persists the report as citizen-declared rather than guessing a barangay', async () => {
  const state = install({ detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' } });
  const originalResolve = geofenceService.resolveJurisdiction;
  geofenceService.resolveJurisdiction = async () => ({
    status: 'AMBIGUOUS_JURISDICTION',
    barangayId: null,
    boundaryCheckStatus: 'inside_service_area',
    gpsAccuracy: { reportedMeters: 15, thresholdMeters: 100, status: 'acceptable' }
  });

  try {
    await reportService.createReport(submission({ barangay: 'Barangay A' }), uploadedFiles(), { id: 7 }, landmarkFiles());

    const [row] = state.reports;
    assert.equal(row.barangay, 'Barangay A');
    assert.equal(row.barangayId, null);
    assert.equal(row.jurisdictionSource, 'citizen_declared');
  } finally {
    geofenceService.resolveJurisdiction = originalResolve;
    state.restore();
  }
});

test('a submission outside the service area is rejected and leaves no persisted rows or uploads', async () => {
  const state = install({ detection: { detected: true, damage_type: 'pothole', confidence_score: 0.9, severity_level: 'critical' } });
  const originalResolve = geofenceService.resolveJurisdiction;
  geofenceService.resolveJurisdiction = async () => ({
    status: 'NO_MATCHING_POLYGON',
    barangayId: null,
    boundaryCheckStatus: 'outside_service_area'
  });

  try {
    await assert.rejects(
      reportService.createReport(submission({ latitude: '14.5995', longitude: '120.9842' }), uploadedFiles(), { id: 7 }, landmarkFiles()),
      /outside the Bacolod City service area/i
    );
    assert.equal(state.reports.length, 0, 'no report row must be persisted');
    assert.equal(state.unlinked.length, 3, 'uploads must be discarded on rejection');
  } finally {
    geofenceService.resolveJurisdiction = originalResolve;
    state.restore();
  }
});

