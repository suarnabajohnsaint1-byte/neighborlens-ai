const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { JPEG_BYTES, SECOND_JPEG_BYTES, PNG_BYTES, WEBP_BYTES } = require('../../tests/support/image-fixtures');

const env = require('../infrastructure/config/env');
const { setStorageInstance, resetStorage } = require('../infrastructure/storage/storageFactory');
const { reportService, damageDetectionService, geofenceService, communityPublicationService } = require('../composition');
const reportRepository = require('../infrastructure/repositories/report.repository');
const barangayRepository = require('../infrastructure/repositories/barangay.repository');
const reportImageRepository = require('../infrastructure/repositories/reportImage.repository');
const damageVerificationRepository = require('../infrastructure/repositories/damageVerification.repository');
const auditLogRepository = require('../infrastructure/repositories/auditLog.repository');
const { useTestDatabase, resetDatabase } = require('../infrastructure/database');
const { ForbiddenError } = require('../domain/errors');

function uploadedFiles(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/tmp/uploads/file-${index}.jpg`,
    filename: `file-${index}.jpg`,
    size: 1024 * (index + 1),
    buffer: index === 1 ? SECOND_JPEG_BYTES : JPEG_BYTES,
    mimetype: 'image/jpeg'
  }));
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

function citizen(id) {
  return { id, role: 'citizen', barangay: 'Barangay Central', barangayId: 1, residencyVerified: true, tokenVersion: 0 };
}

function submission(overrides = {}) {
  return {
    description: 'Damaged road surface and open pothole',
    barangay: 'Barangay Central',
    latitude: '10.6780',
    longitude: '122.9460',
    gpsAccuracy: '15',
    gpsFixAt: Date.now(),
    landmarkDescription: 'Beside the school entrance.',
    ...overrides
  };
}

function install({
  storage = null,
  driver = 'supabase',
  imageFailure = null,
  dbTxFailure = null
} = {}) {
  const state = {
    reports: [],
    images: [],
    verifications: [],
    audits: [],
    unlinked: [],
    uploaded: [],
    removed: [],
    sequence: [],
    singleQueryCalls: 0,
    batchQueryCalls: 0
  };

  const restore = [];
  const swap = (target, key, value) => {
    const original = target[key];
    target[key] = value;
    restore.push(() => { target[key] = original; });
  };

  const originalDriver = env.STORAGE_DRIVER;
  swap(communityPublicationService, 'prepareAutomatic', async () => ({ media: [] }));
  swap(communityPublicationService, 'enqueueAutomatic', async () => ({ publication: { state: 'pending_approval' } }));
  swap(communityPublicationService, 'discardAutomatic', async () => {});
  swap(communityPublicationService, 'announceAutomatic', () => {});
  env.STORAGE_DRIVER = driver;
  restore.push(() => { env.STORAGE_DRIVER = originalDriver; });

  const mockStorage = storage || {
    async upload(file, key) {
      state.sequence.push(`upload:${file.path}`);
      const reference = driver === 'supabase' ? `supabase:${key}` : `/uploads/${file.filename}`;
      state.uploaded.push({ file, key, reference });
      return {
        provider: driver,
        key: driver === 'supabase' ? key : reference,
        reference
      };
    },
    async getReadUrl(reference) {
      state.sequence.push(`getReadUrl:${reference}`);
      if (typeof reference === 'string' && reference.startsWith('supabase:')) {
        return `https://supabase.mock.test/signed/${reference.slice('supabase:'.length)}?token=mock300s`;
      }
      return reference;
    },
    async remove(reference) {
      state.sequence.push(`remove:${reference}`);
      state.removed.push(reference);
    }
  };

  setStorageInstance(mockStorage, driver);
  restore.push(() => { resetStorage(); });

  useTestDatabase({
    driver: 'stub',
    query: async () => [],
    execute: async () => ({ insertId: 1, affectedRows: 1 }),
    withTransaction: async (fn) => {
      if (dbTxFailure) throw dbTxFailure;
      return fn({ stub: true });
    },
    ping: async () => true,
    close: async () => {}
  });

  swap(geofenceService, 'resolveJurisdiction', async () => ({
    status: 'RESOLVED',
    barangayId: 1,
    boundaryCheckStatus: 'inside_service_area',
    gpsAccuracy: { status: 'acceptable', reportedMeters: 15, thresholdMeters: 100 }
  }));

  swap(barangayRepository, 'findById', async () => ({ id: 1, name: 'Barangay Central' }));
  swap(reportRepository, 'lockSubmissionActor', async () => ({ status: 'active', token_version: 0, barangay_id: 1, residency_confirmed_at: 'fixture' }));
  swap(reportRepository, 'hasUsedGpsFix', async () => false);

  swap(damageDetectionService, 'detectForReport', async () => {
    state.sequence.push('ai_detection');
    return { detected: true, damage_type: 'pothole', confidence_score: 0.95, severity_level: 'critical' };
  });

  swap(damageDetectionService, 'verifyReportImages', async () => {
    state.sequence.push('ai_verification');
    return { is_valid_match: true, composite_similarity_score: 0.9 };
  });

  swap(reportRepository, 'create', async (report) => {
    state.sequence.push('db_create_report');
    state.reports.push({
      ...report,
      submitted_by: report.submittedBy ?? report.submitted_by,
      landmark_description: report.landmarkDescription ?? report.landmark_description ?? null,
      landmark_image_path: report.landmarkImagePath ?? report.landmark_image_path ?? null
    });
    return { insertId: state.reports.length };
  });

  swap(reportRepository, 'findById', async (id) => {
    state.sequence.push(`db_find_report:${id}`);
    const row = state.reports[id - 1];
    return row ? { id, ...row } : null;
  });

  swap(reportImageRepository, 'createMany', async (reportId, images) => {
    state.sequence.push(`db_create_images:${reportId}`);
    if (imageFailure) throw imageFailure;
    state.images.push(...images.map(img => ({ ...img, report_id: reportId })));
    return images;
  });

  swap(reportImageRepository, 'findByReportId', async (reportId) => {
    state.sequence.push(`db_find_images_by_report_id:${reportId}`);
    state.singleQueryCalls += 1;
    return state.images.filter(img => img.report_id === reportId).map(img => ({
      id: 1,
      report_id: reportId,
      image_path: img.imagePath,
      image_order: img.imageOrder,
      file_size: img.fileSize,
      mime_type: img.mimeType
    }));
  });

  swap(reportImageRepository, 'findByReportIds', async (reportIds) => {
    state.sequence.push('db_find_images_by_report_ids_batch');
    state.batchQueryCalls += 1;
    const map = new Map();
    for (const id of reportIds) {
      map.set(id, state.images.filter(img => img.report_id === id).map(img => ({
        id: 1,
        report_id: id,
        image_path: img.imagePath,
        image_order: img.imageOrder,
        file_size: img.fileSize,
        mime_type: img.mimeType
      })));
    }
    return map;
  });

  swap(damageVerificationRepository, 'create', async (row) => {
    state.sequence.push('db_create_verification');
    state.verifications.push(row);
    return { insertId: state.verifications.length };
  });

  swap(auditLogRepository, 'create', async (entry) => {
    state.sequence.push('db_create_audit');
    state.audits.push(entry);
    return { insertId: state.audits.length };
  });

  swap(fs, 'unlink', async (target) => {
    state.sequence.push(`unlink:${target}`);
    state.unlinked.push(target);
  });

  state.restore = () => {
    restore.reverse().forEach(fn => fn());
    resetDatabase();
  };

  return state;
}

test('1. Successful local report creation preserves local files and stores local paths', async () => {
  const state = install({ driver: 'local' });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);
    const result = await reportService.createReport(submission(), files, user, landmarkFiles());

    assert.equal(state.reports.length, 1);
    assert.equal(state.unlinked.length, 0, 'Local uploaded files must be preserved after successful persistence');
    assert.equal(state.reports[0].imagePath, '/uploads/file-0.jpg,/uploads/file-1.jpg');
    assert.equal(state.reports[0].landmarkDescription, 'Beside the school entrance.');
    assert.equal(state.reports[0].landmarkImagePath, '/uploads/landmark.jpg');
    assert.equal(result.images.length, 2);
    assert.equal(result.images[0].imagePath, `/api/reports/${result.id}/images/${result.images[0].id}`);
    assert.deepEqual(result.landmark, {
      description: 'Beside the school entrance.',
      imagePath: `/api/reports/${result.id}/images/landmark`
    });
  } finally {
    state.restore();
  }
});

test('2. Successful Supabase report creation generates signed URLs and deletes local temporary files', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);
    const result = await reportService.createReport(submission(), files, user, landmarkFiles());

    assert.equal(state.reports.length, 1);
    assert.equal(state.unlinked.length, 3, 'Temporary local files must be deleted after cloud persistence');
    assert.deepEqual(state.unlinked, ['/tmp/uploads/file-0.jpg', '/tmp/uploads/file-1.jpg', '/tmp/uploads/landmark.jpg']);
    assert.match(state.reports[0].imagePath, /^supabase:reports\/7\/[a-f0-9-]{36}\.jpg,supabase:reports\/7\/[a-f0-9-]{36}\.jpg$/);
    assert.match(state.reports[0].landmarkImagePath, /^supabase:reports\/7\/[a-f0-9-]{36}\.jpg$/);
    assert.equal(result.images.length, 2);
    assert.match(result.images[0].imagePath, /^https:\/\/supabase\.mock\.test\/signed\/reports\/7\//);
    assert.match(result.images[1].imagePath, /^https:\/\/supabase\.mock\.test\/signed\/reports\/7\//);
  } finally {
    state.restore();
  }
});

test('3. Correct storage references in both report and report-image records', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const user = citizen(42);
    const files = uploadedFiles(2);
    await reportService.createReport(submission(), files, user, landmarkFiles());

    const reportRow = state.reports[0];
    const imageRows = state.images;

    const reportRefs = reportRow.imagePath.split(',');
    assert.equal(reportRefs.length, 2);
    assert.equal(imageRows.length, 2);

    assert.equal(reportRefs[0], imageRows[0].imagePath);
    assert.equal(reportRefs[1], imageRows[1].imagePath);
    assert.match(imageRows[0].imagePath, /^supabase:reports\/42\/[a-f0-9-]{36}\.jpg$/);
    assert.match(imageRows[1].imagePath, /^supabase:reports\/42\/[a-f0-9-]{36}\.jpg$/);
  } finally {
    state.restore();
  }
});

test('4. Correct ordering and MIME metadata for evidence images', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const user = citizen(10);
    const files = [
      { path: '/tmp/uploads/img-first.png', filename: 'img-first.png', size: 2048, mimetype: 'image/png', buffer: PNG_BYTES },
      { path: '/tmp/uploads/img-second.webp', filename: 'img-second.webp', size: 4096, mimetype: 'image/webp', buffer: WEBP_BYTES }
    ];

    await reportService.createReport(submission(), files, user, landmarkFiles());

    assert.equal(state.images.length, 2);
    assert.equal(state.images[0].imageOrder, 1);
    assert.equal(state.images[0].fileSize, 2048);
    assert.equal(state.images[0].mimeType, 'image/png');
    assert.match(state.images[0].imagePath, /^supabase:reports\/10\/[a-f0-9-]{36}\.png$/);

    assert.equal(state.images[1].imageOrder, 2);
    assert.equal(state.images[1].fileSize, 4096);
    assert.equal(state.images[1].mimeType, 'image/webp');
    assert.match(state.images[1].imagePath, /^supabase:reports\/10\/[a-f0-9-]{36}\.webp$/);
  } finally {
    state.restore();
  }
});

test('5. First cloud upload failure aborts report and cleans up local temporary files', async () => {
  const mockStorage = {
    async upload() {
      throw new Error('Supabase bucket full or unreachable');
    },
    async getReadUrl(ref) { return ref; },
    async remove() {}
  };

  const state = install({ driver: 'supabase', storage: mockStorage });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);

    await assert.rejects(
      reportService.createReport(submission(), files, user, landmarkFiles()),
      /Failed to save report; no changes were persisted/
    );

    assert.equal(state.reports.length, 0, 'No report row should be created');
    assert.equal(state.images.length, 0, 'No image rows should be created');
    assert.equal(state.unlinked.length, 3, 'Local temporary files must be cleaned up');
  } finally {
    state.restore();
  }
});

test('6. Partial cloud upload failure cleans up previously uploaded cloud object and local files', async () => {
  let callCount = 0;
  const removedRefs = [];
  const mockStorage = {
    async upload(file, key) {
      callCount += 1;
      if (callCount === 2) {
        throw new Error('Supabase network reset on image 2');
      }
      return {
        provider: 'supabase',
        key,
        reference: `supabase:${key}`
      };
    },
    async getReadUrl(ref) { return ref; },
    async remove(reference) {
      removedRefs.push(reference);
    }
  };

  const state = install({ driver: 'supabase', storage: mockStorage });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);

    await assert.rejects(
      reportService.createReport(submission(), files, user, landmarkFiles()),
      /Failed to save report; no changes were persisted/
    );

    assert.equal(state.reports.length, 0);
    assert.equal(removedRefs.length, 1, 'Earlier uploaded cloud image must be removed');
    assert.match(removedRefs[0], /^supabase:reports\/7\/[a-f0-9-]{36}\.jpg$/);
    assert.equal(state.unlinked.length, 3, 'Local temporary files must be cleaned up');
  } finally {
    state.restore();
  }
});

test('7. MySQL transaction rollback triggers cloud cleanup and local cleanup', async () => {
  const state = install({
    driver: 'supabase',
    dbTxFailure: new Error('MySQL ER_LOCK_DEADLOCK')
  });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);

    await assert.rejects(
      reportService.createReport(submission(), files, user, landmarkFiles()),
      /Failed to save report; no changes were persisted/
    );

    assert.equal(state.reports.length, 0);
    assert.equal(state.uploaded.length, 3, 'All three images were uploaded to cloud before tx');
    assert.equal(state.removed.length, 3, 'All three cloud objects must be cleaned up on tx failure');
    assert.equal(state.unlinked.length, 3, 'Local temporary files must be cleaned up');
  } finally {
    state.restore();
  }
});

test('8. Cleanup failure does not hide the original application error and local files are still unlinked', async () => {
  const mockStorage = {
    async upload(file, key) {
      return {
        provider: 'supabase',
        key,
        reference: `supabase:${key}`
      };
    },
    async getReadUrl(ref) { return ref; },
    async remove() {
      throw new Error('Supabase cleanup API timeout 504');
    }
  };

  const state = install({
    driver: 'supabase',
    storage: mockStorage,
    imageFailure: new Error('Simulated SQL constraint violation')
  });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);

    await assert.rejects(
      reportService.createReport(submission(), files, user, landmarkFiles()),
      error => {
        assert.match(error.message, /Failed to save report; no changes were persisted/);
        assert.equal(error.name, 'PersistenceError');
        return true;
      }
    );

    assert.equal(state.unlinked.length, 3, 'Local files must still be deleted even if cloud cleanup failed');
  } finally {
    state.restore();
  }
});

test('9. Temporary file deletion after successful cloud persistence', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const user = citizen(15);
    const files = uploadedFiles(2);
    await reportService.createReport(submission(), files, user, landmarkFiles());

    assert.equal(state.unlinked.length, 3);
    assert.deepEqual(state.unlinked, ['/tmp/uploads/file-0.jpg', '/tmp/uploads/file-1.jpg', '/tmp/uploads/landmark.jpg']);
  } finally {
    state.restore();
  }
});

test('10. Local file preservation after successful local persistence', async () => {
  const state = install({ driver: 'local' });
  try {
    const user = citizen(15);
    const files = uploadedFiles(2);
    await reportService.createReport(submission(), files, user, landmarkFiles());

    assert.equal(state.unlinked.length, 0, 'No local files may be unlinked on successful local persistence');
  } finally {
    state.restore();
  }
});

test('11. Citizen report reads use protected image routes; admin reads retain signed URLs', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const citizenUser = citizen(25);
    const adminUser = { id: 99, role: 'admin' };
    const files = uploadedFiles(2);

    const created = await reportService.createReport(submission(), files, citizenUser, landmarkFiles());
    const reportId = created.id;

    // Report owner retrieves
    const ownerReport = await reportService.getReport(reportId, citizenUser);
    assert.equal(ownerReport.id, reportId);
    assert.equal(ownerReport.images.length, 2);
    assert.equal(ownerReport.images[0].imagePath, `/api/reports/${reportId}/images/1`);

    // Admin retrieves
    const adminReport = await reportService.getReport(reportId, adminUser);
    assert.equal(adminReport.id, reportId);
    assert.match(adminReport.images[0].imagePath, /^https:\/\/supabase\.mock\.test\/signed\/reports\/25\//);
  } finally {
    state.restore();
  }
});

test('12. No unauthorized access to private report images', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const owner = citizen(30);
    const otherCitizen = citizen(31);
    const wrongBarangayOfficial = { id: 50, role: 'barangay', barangay: 'Barangay North' };
    const files = uploadedFiles(2);

    const created = await reportService.createReport(submission(), files, owner, landmarkFiles());
    const reportId = created.id;

    // Other citizen denied
    await assert.rejects(
      reportService.getReport(reportId, otherCitizen),
      ForbiddenError
    );

    // Other barangay official denied
    await assert.rejects(
      reportService.getReport(reportId, wrongBarangayOfficial),
      ForbiddenError
    );
  } finally {
    state.restore();
  }
});

test('13. Correct async image enrichment for report listing', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const swap = (target, key, val) => {
      const orig = target[key];
      target[key] = val;
      state.restoreFns = state.restoreFns || [];
      state.restoreFns.push(() => { target[key] = orig; });
    };

    swap(reportRepository, 'findAll', async () => [
      { id: 101, description: 'Report 1', status: 'pending', barangay: 'Barangay Central' },
      { id: 102, description: 'Report 2', status: 'resolved', barangay: 'Barangay Central' }
    ]);

    state.images.push(
      { report_id: 101, imagePath: 'supabase:reports/7/img-1.jpg', imageOrder: 1, fileSize: 100, mimeType: 'image/jpeg' },
      { report_id: 102, imagePath: 'supabase:reports/8/img-2.jpg', imageOrder: 1, fileSize: 200, mimeType: 'image/jpeg' }
    );

    const listing = await reportService.listReports({}, { id: 1, role: 'admin' });

    assert.ok(Array.isArray(listing.reports), 'reports must be an Array, not a Promise');
    assert.equal(listing.reports.length, 2);
    assert.match(listing.reports[0].images[0].imagePath, /^https:\/\/supabase\.mock\.test\/signed\/reports\/7\/img-1\.jpg/);
    assert.match(listing.reports[1].images[0].imagePath, /^https:\/\/supabase\.mock\.test\/signed\/reports\/8\/img-2\.jpg/);
    assert.equal(listing.stats.total, 2);
    assert.equal(listing.stats.pending, 1);
    assert.equal(listing.stats.resolved, 1);

    const signedUrlCalls = state.sequence.filter(item => item.startsWith('getReadUrl:')).length;
    const citizenListing = await reportService.listReports({}, { id: 7, role: 'citizen' });
    assert.equal(citizenListing.reports.length, 2);
    assert.equal(citizenListing.reports[0].images[0].imagePath, '/api/reports/101/images/1');
    assert.equal(citizenListing.reports[1].images[0].imagePath, '/api/reports/102/images/1');
    assert.equal(state.sequence.filter(item => item.startsWith('getReadUrl:')).length, signedUrlCalls,
      'Citizen report listing must not depend on remote signed-URL creation');
  } finally {
    if (state.restoreFns) state.restoreFns.forEach(fn => fn());
    state.restore();
  }
});

test('14. No N+1 database queries in report listing', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const swap = (target, key, val) => {
      const orig = target[key];
      target[key] = val;
      state.restoreFns = state.restoreFns || [];
      state.restoreFns.push(() => { target[key] = orig; });
    };

    swap(reportRepository, 'findAll', async () => [
      { id: 201, description: 'Report 1', status: 'pending', barangay: 'Barangay Central' },
      { id: 202, description: 'Report 2', status: 'ongoing', barangay: 'Barangay Central' },
      { id: 203, description: 'Report 3', status: 'resolved', barangay: 'Barangay Central' }
    ]);

    const listing = await reportService.listReports({}, { id: 1, role: 'admin' });

    assert.equal(listing.reports.length, 3);
    assert.equal(state.batchQueryCalls, 1, 'findByReportIds must be called exactly once');
    assert.equal(state.singleQueryCalls, 0, 'findByReportId must NOT be called in a loop (no N+1 queries)');
  } finally {
    if (state.restoreFns) state.restoreFns.forEach(fn => fn());
    state.restore();
  }
});

test('15. AI detection and verification complete before temporary-file cleanup', async () => {
  const state = install({ driver: 'supabase' });
  try {
    const user = citizen(7);
    const files = uploadedFiles(2);
    await reportService.createReport(submission(), files, user, landmarkFiles());

    const aiDetectIndex = state.sequence.indexOf('ai_detection');
    const aiVerifyIndex = state.sequence.indexOf('ai_verification');
    const upload0Index = state.sequence.indexOf('upload:/tmp/uploads/file-0.jpg');
    const dbCommitIndex = state.sequence.indexOf('db_create_report');
    const unlink0Index = state.sequence.indexOf('unlink:/tmp/uploads/file-0.jpg');

    assert.ok(aiDetectIndex >= 0, 'AI detection must occur');
    assert.ok(aiVerifyIndex >= 0, 'AI verification must occur');
    assert.ok(upload0Index >= 0, 'Upload must occur');
    assert.ok(dbCommitIndex >= 0, 'DB commit must occur');
    assert.ok(unlink0Index >= 0, 'Unlink must occur');

    assert.ok(aiDetectIndex < upload0Index, 'AI detection must run before cloud upload');
    assert.ok(aiVerifyIndex < upload0Index, 'AI verification must run before cloud upload');
    assert.ok(upload0Index < dbCommitIndex, 'Cloud upload must occur before DB commit');
    assert.ok(dbCommitIndex < unlink0Index, 'DB commit must occur before temporary file deletion');
  } finally {
    state.restore();
  }
});
