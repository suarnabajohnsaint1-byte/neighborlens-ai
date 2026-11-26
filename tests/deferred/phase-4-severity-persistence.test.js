const test = require('node:test');
const assert = require('node:assert/strict');
const createSqliteAdapter = require('../../server/infrastructure/database/sqlite/sqliteAdapter');
const verificationRepository = require('../../server/infrastructure/repositories/damageVerification.repository');

test('Phase 4 regression: unknown severity must persist as NULL instead of fabricated low', async () => {
  const db = createSqliteAdapter({ filePath: ':memory:' });
  try {
    const { insertId } = await db.execute(
      'INSERT INTO reports (description, barangay, ai_classification, ai_priority) VALUES (?, ?, ?, ?)',
      ['Unknown severity evidence', 'Barangay Central', null, null]
    );
    await verificationRepository.create(
      {
        reportId: insertId,
        isValidMatch: false,
        compositeSimilarityScore: 0.15,
        embeddingSimilarity: 0.15,
        homographyInlierRatio: 0,
        perspectiveAligned: false,
        matchedDamageType: null,
        highestSeverity: null,
        model: 'isolated-test',
        rawPayload: { highest_severity: null, detected: false }
      },
      db
    );
    const [stored] = await verificationRepository.findByReportId(insertId, db);
    assert.equal(JSON.parse(stored.raw_payload).highest_severity, null);
    assert.equal(
      stored.highest_severity,
      null,
      'The NOT NULL schema and repository fallback currently fabricate low severity; nullable storage is deferred to Phase 4.'
    );
  } finally {
    await db.close();
  }
});
