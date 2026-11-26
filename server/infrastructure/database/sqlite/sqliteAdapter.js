const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const env = require('../../config/env');
const { FIND_ADMIN_SQL, INSERT_ADMIN_SQL, adminSeedValues } = require('../adminSeed');
const { FIND_USER_BY_USERNAME_SQL, INSERT_DEMO_CITIZEN_SQL, demoCitizenSeedValues } = require('../demoCitizenSeed');
const { seedBarangayCatalogSync } = require('../barangayCatalog');

// Test-only. A passing test against this adapter is isolated-integration
// evidence, not proof of MySQL behaviour. It defaults to a file outside the
// repository so runs leave no WAL/SHM artifacts behind.

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const SCHEMA_VERSION = 11;

function removeStaleDatabase(filePath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${filePath}${suffix}`, { force: true });
  }
}

function hasCurrentSchema(filePath) {
  if (!fs.existsSync(filePath)) return true;
  const probe = new DatabaseSync(filePath);
  try {
    const version = probe.prepare('PRAGMA user_version').get().user_version;
    const tables = probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    return tables === 0 || version === SCHEMA_VERSION;
  } finally {
    probe.close();
  }
}

function defaultFilePath() {
  const configured = process.env.TEST_DB_FILE;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  }
  return path.join(os.tmpdir(), 'neighborlens-tests', 'neighborlens.sqlite');
}

function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!hasCurrentSchema(filePath)) removeStaleDatabase(filePath);
  const db = new DatabaseSync(filePath);

  db.exec('PRAGMA foreign_keys = ON;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
  } catch {
    // WAL is unavailable on some filesystems; the default journal still works.
  }

  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(path.join(__dirname, 'community.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(__dirname, 'publication.sql'), 'utf8'));
  if (!db.prepare('PRAGMA table_info(reports)').all().some(column => column.name === 'submission_assessment')) {
    db.exec('ALTER TABLE reports ADD COLUMN submission_assessment TEXT CHECK (submission_assessment IS NULL OR json_valid(submission_assessment))');
  }
  const users = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  for (const [name, type] of [['residency_confirmed_at', 'DATETIME'], ['residency_city_version', 'TEXT'], ['residency_barangay_version', 'TEXT']]) {
    if (!users.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  if (!db.prepare('PRAGMA table_info(reports)').all().some(column => column.name === 'gps_fix_at')) {
    db.exec('ALTER TABLE reports ADD COLUMN gps_fix_at INTEGER');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_citizen_gps_fix ON reports(submitted_by, gps_fix_at)');
  if (!db.prepare('PRAGMA table_info(reports)').all().some(column => column.name === 'landmark_description')) {
    db.exec('ALTER TABLE reports ADD COLUMN landmark_description TEXT');
    db.exec('ALTER TABLE reports ADD COLUMN landmark_image_path TEXT');
  }
  if (!db.prepare('PRAGMA table_info(community_comments)').all().some(column => column.name === 'parent_id')) {
    db.exec('ALTER TABLE community_comments ADD COLUMN parent_id INTEGER REFERENCES community_comments(id) ON DELETE SET NULL');
  }
  if (!db.prepare('PRAGMA table_info(community_comment_reactions)').all().some(column => column.name === 'reaction')) {
    db.exec("ALTER TABLE community_comment_reactions ADD COLUMN reaction TEXT NOT NULL DEFAULT 'like' CHECK (reaction IN ('like', 'heart'))");
  }
  // Mirror migration 014 only in this existing test adapter; runtime remains MySQL.
  if (!db.prepare('PRAGMA table_info(report_status_history)').all().some(column => column.name === 'request_key')) {
    db.exec('ALTER TABLE report_status_history ADD COLUMN request_key TEXT');
    db.exec('ALTER TABLE report_status_history ADD COLUMN request_hash TEXT');
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_report_action_request ON report_status_history(report_id, request_key);
    CREATE TABLE IF NOT EXISTS report_action_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, history_id INTEGER NOT NULL REFERENCES report_status_history(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL, image_order INTEGER NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL,
      UNIQUE(history_id, image_order))`);
  db.exec(fs.readFileSync(path.join(__dirname, 'incidents.sql'), 'utf8').replaceAll('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ').replace('INSERT INTO report_incident_lock', 'INSERT OR IGNORE INTO report_incident_lock'));
  if (!db.prepare('PRAGMA table_info(community_publication_requests)').all().some(column => column.name === 'discussion_post_id')) db.exec('ALTER TABLE community_publication_requests ADD COLUMN discussion_post_id INTEGER REFERENCES community_posts(id)');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  seedBarangayCatalogSync(db);
  return db;
}

function seedAdmin(db) {
  if (!env.DEFAULT_ADMIN_USERNAME || !env.DEFAULT_ADMIN_PASSWORD) return;
  if (!db.prepare(FIND_ADMIN_SQL).get('admin')) db.prepare(INSERT_ADMIN_SQL).run(...adminSeedValues());
  db.prepare(
    `INSERT INTO user_permissions (user_id, permission)
     SELECT id, 'admin:create' FROM users WHERE role = 'admin'
       AND NOT EXISTS (SELECT 1 FROM user_permissions WHERE permission = 'admin:create')
     ORDER BY id LIMIT 1`
  ).run();
}

function seedDemoCitizen(db) {
  if (!env.DEMO_CITIZEN_USERNAME || !env.DEMO_CITIZEN_PASSWORD) return;
  if (db.prepare(FIND_USER_BY_USERNAME_SQL).get(env.DEMO_CITIZEN_USERNAME)) return;
  db.prepare(INSERT_DEMO_CITIZEN_SQL).run(...demoCitizenSeedValues());
}

function createSqliteAdapter({ filePath = defaultFilePath() } = {}) {
  const db = openDatabase(filePath);
  seedAdmin(db);
  seedDemoCitizen(db);

  function query(sql, params = []) {
    return Promise.resolve(db.prepare(sql).all(...params));
  }

  function execute(sql, params = []) {
    const info = db.prepare(sql).run(...params);
    return Promise.resolve({
      insertId: Number(info.lastInsertRowid || 0),
      affectedRows: Number(info.changes || 0)
    });
  }

  async function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({ query, execute });
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original error is what the caller needs to see.
      }
      throw error;
    }
  }

  async function ping() {
    db.prepare('SELECT 1').get();
    return true;
  }

  return {
    driver: 'sqlite-test',
    filePath,
    query,
    execute,
    withTransaction,
    ping,
    close: () => db.close()
  };
}

module.exports = createSqliteAdapter;
module.exports.createSqliteAdapter = createSqliteAdapter;
module.exports.defaultFilePath = defaultFilePath;
