const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { assertLoopbackHost, assertTestDatabase } = require('./local-test-target');

const TEST_DB_NAME = process.env.MYSQL_TEST_DB_NAME || 'neighborlens_ai_test';
const LIVE_DB_NAME = process.env.DB_NAME || 'neighborlens_ai';
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEST_ADMIN = Object.freeze({ username: 'admin', password: 'admin123' });

function assertIsolatedName(name) {
  assertTestDatabase(name);
  if (!/_test$/.test(name) || name === LIVE_DB_NAME) {
    throw new Error(`Refusing to use "${name}" as an isolated test database; the name must end in _test and differ from DB_NAME.`);
  }
}

function connectionOptions() {
  assertLoopbackHost(process.env.DB_HOST || '127.0.0.1');
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || ''
  };
}

async function recreateTestDatabase() {
  assertIsolatedName(TEST_DB_NAME);
  const connection = await mysql.createConnection(connectionOptions());
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``);
    await connection.query(`CREATE DATABASE \`${TEST_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await connection.end();
  }
}

function useTestDatabaseEnvironment() {
  assertIsolatedName(TEST_DB_NAME);
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborlens-mysql-uploads-'));
  process.env.DB_NAME = TEST_DB_NAME;
  process.env.DB_DRIVER = 'mysql';
  process.env.STORAGE_DRIVER = 'local';
  process.env.UPLOAD_DIR = uploads;
  return { uploads };
}

async function seedTestAdmin(pool, passwordHasher) {
  const [rows] = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (rows.length) return rows[0].id;
  const [result] = await pool.query(
    "INSERT INTO users (username, password_hash, role, barangay, full_name) VALUES (?, ?, 'admin', 'City Wide', 'Test Administrator')",
    [TEST_ADMIN.username, passwordHasher.hash(TEST_ADMIN.password, 4)]
  );
  await pool.query("INSERT INTO user_permissions (user_id, permission) VALUES (?, 'admin:create')", [result.insertId]);
  return result.insertId;
}

function startServerProcess(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_NAME: TEST_DB_NAME, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend process did not start within 20 s.')), 20000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('NeighborLens API running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Backend process exited early with code ${code}.`));
    });
  });
  const stop = () => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });
  return { child, ready, stop };
}

module.exports = {
  TEST_DB_NAME,
  TEST_ADMIN,
  recreateTestDatabase,
  useTestDatabaseEnvironment,
  seedTestAdmin,
  startServerProcess
};
