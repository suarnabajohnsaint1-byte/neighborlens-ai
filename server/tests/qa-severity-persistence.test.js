const test = require('node:test');
const assert = require('node:assert/strict');
const createSqliteAdapter = require('../infrastructure/database/sqlite/sqliteAdapter');
const repository = require('../infrastructure/repositories/damageVerification.repository');
const { normalizeSeverity } = require('../domain/reports/damageDetection.rules');
const { triageForSeverity } = require('../domain/reports/report.rules');

for (const damage of ['broken_streetlight', 'clogged_drainage', 'pothole', 'road_crack']) {
  test(`${damage}: confidence and category cannot invent severity`, () => {
    for (const confidence of [null, 0, 0.99, 1]) {
      assert.equal(normalizeSeverity(null, damage, confidence), null);
      assert.deepEqual(triageForSeverity(normalizeSeverity(null, damage, confidence)), { aiClassification: null, aiPriority: null });
    }
    assert.equal(normalizeSeverity('invalid', damage, 0.99), null);
    assert.deepEqual(triageForSeverity('low'), { aiClassification: 'MINOR', aiPriority: 'Low' });
    assert.deepEqual(triageForSeverity('high'), { aiClassification: 'MAJOR', aiPriority: 'High' });
  });
}

test('unknown verification severity persists as NULL while genuine low and high values survive', async () => {
  const database = createSqliteAdapter({ filePath: ':memory:' });
  try {
    const { insertId } = await database.execute("INSERT INTO reports (description, barangay, ai_classification, ai_priority) VALUES ('QA severity', 'Villamonte', NULL, NULL)");
    for (const severity of [null, 'low', 'high']) {
      await repository.create({ reportId: insertId, highestSeverity: severity, rawPayload: { highest_severity: severity } }, database);
      const [stored] = await repository.findByReportId(insertId, database);
      assert.equal(stored.highest_severity, severity);
      assert.equal(JSON.parse(stored.raw_payload).highest_severity, severity);
    }
    const [report] = await database.query('SELECT ai_classification, ai_priority FROM reports WHERE id = ?', [insertId]);
    assert.equal(report.ai_classification, null);
    assert.equal(report.ai_priority, null);
  } finally { await database.close(); }
});
