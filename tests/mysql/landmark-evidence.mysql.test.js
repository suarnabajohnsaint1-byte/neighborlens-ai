const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');
const env = require('../../server/infrastructure/config/env');
const { runMigrations } = require('../../server/infrastructure/database/mysql/migrationRunner');
const { useTestDatabase } = require('../../server/infrastructure/database');
const createMysqlAdapter = require('../../server/infrastructure/database/mysql/mysqlAdapter');
const reportRepository = require('../../server/infrastructure/repositories/report.repository');

const databaseName = `neighborlens_landmark_${randomBytes(6).toString('hex')}_test`;
let administrator;
let database;

test.before(async () => {
  require('../support/local-test-target').assertLoopbackHost(env.DB_HOST);
  administrator = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD
  });
  await administrator.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`);
  env.DB_NAME = databaseName;
  env.DB_CONNECTION_LIMIT = 1;
  database = createMysqlAdapter();
  await runMigrations(database.pool);
  useTestDatabase(database);
});

test.after(async () => {
  await database?.close();
  if (administrator && /^neighborlens_landmark_[0-9a-f]{12}_test$/.test(databaseName)) {
    await administrator.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await administrator.end();
  }
});

test('MySQL migration 025 adds landmark columns and persists/rolls back landmark evidence cleanly', async () => {
  const [cols] = await database.pool.query("SHOW COLUMNS FROM reports LIKE 'landmark%'");
  assert.deepEqual(cols.map(c => c.Field), ['landmark_description', 'landmark_image_path']);

  const user = await database.execute(
    'INSERT INTO users (username, password_hash, role, barangay) VALUES (?, ?, ?, ?)',
    ['mysql_lm_user', 'fixture-hash', 'citizen', 'Villamonte']
  );

  // Persist landmark evidence inside transaction
  const created = await database.withTransaction(async tx => {
    const { insertId } = await reportRepository.create({
      description: 'MySQL landmark persistence test',
      location: 'Villamonte',
      barangay: 'Villamonte',
      latitude: 10.6685,
      longitude: 122.9647,
      imagePath: '/uploads/d1.jpg,/uploads/d2.jpg',
      aiCategory: 'pothole',
      aiClassification: null,
      aiPriority: null,
      aiConfidence: 90,
      visionDetected: true,
      submittedBy: user.insertId,
      landmarkDescription: 'Near the public market entrance.',
      landmarkImagePath: 'reports/1/landmark.webp'
    }, tx);
    return insertId;
  });

  const persisted = await reportRepository.findById(created);
  assert.equal(persisted.landmark_description, 'Near the public market entrance.');
  assert.equal(persisted.landmark_image_path, 'reports/1/landmark.webp');

  // Historical report without landmark columns remains valid with NULLs
  const historical = await reportRepository.create({
    description: 'Historical MySQL report',
    location: 'Villamonte',
    barangay: 'Villamonte',
    latitude: 10.6685,
    longitude: 122.9647,
    imagePath: '/uploads/h1.jpg,/uploads/h2.jpg',
    aiCategory: 'pothole',
    aiClassification: null,
    aiPriority: null,
    aiConfidence: 80,
    visionDetected: true,
    submittedBy: user.insertId
  });
  const histRow = await reportRepository.findById(historical.insertId);
  assert.equal(histRow.landmark_description, null);
  assert.equal(histRow.landmark_image_path, null);

  // Rollback discards report and landmark evidence atomically
  await assert.rejects(async () => {
    await database.withTransaction(async tx => {
      await reportRepository.create({
        description: 'Rolled back report',
        location: 'Villamonte',
        barangay: 'Villamonte',
        latitude: 10.6685,
        longitude: 122.9647,
        imagePath: '/uploads/r1.jpg,/uploads/r2.jpg',
        aiCategory: 'pothole',
        aiClassification: null,
        aiPriority: null,
        aiConfidence: 80,
        visionDetected: true,
        submittedBy: user.insertId,
        landmarkDescription: 'Should be rolled back.',
        landmarkImagePath: 'reports/1/rollback.webp'
      }, tx);
      throw new Error('force rollback');
    });
  }, /force rollback/);

  const rolledBack = await database.query("SELECT id FROM reports WHERE description = 'Rolled back report'");
  assert.equal(rolledBack.length, 0);
});
