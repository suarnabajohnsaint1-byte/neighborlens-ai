const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const migrationHistory = require('./migrationHistory.json');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    checksum VARCHAR(64) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries.filter(name => name.endsWith('.sql')).sort();
}

function parseStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        current += char;
      }
      continue;
    }

    if (!quote && char === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      i++;
      continue;
    }

    if (quote) {
      current += char;
      if (char === '\\') {
        current += sql[i + 1] ?? '';
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  statements.push(current);
  return statements.map(statement => statement.trim()).filter(Boolean);
}

async function readMigration(filename) {
  const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
  const lf = sql.replace(/\r\n/g, '\n');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  return {
    filename,
    checksum: hash(sql),
    compatibleChecksums: [hash(sql), hash(lf), hash(lf.replace(/\n/g, '\r\n'))],
    statements: parseStatements(sql)
  };
}

async function readAppliedMigration(filename, checksum) {
  if (!(await listMigrationFiles()).includes(filename)) throw new Error(`Applied migration source is missing: ${filename}.`);
  const current = await readMigration(filename);
  if (current.compatibleChecksums.includes(checksum)) return { ...current, source: filename };
  for (const expected of migrationHistory[filename] || []) {
    const source = path.join('..', 'migration-history', filename.slice(0, -4), `${expected}.sql`);
    const historical = await readMigration(source);
    if (!historical.compatibleChecksums.includes(expected)) throw new Error(`Historical migration source integrity mismatch: ${filename}.`);
    if (historical.compatibleChecksums.includes(checksum)) return { ...historical, filename, source };
  }
  throw new Error(`Migration checksum mismatch: ${filename}. Restore the applied SQL and add a new migration for schema changes.`);
}

// MySQL implicitly commits on DDL, so a migration file cannot be wrapped in a
// rollback-able transaction. A failure mid-file leaves earlier statements
// applied and the file unrecorded, so it must be resolved before re-running.
async function applyMigration(connection, migration) {
  for (const statement of migration.statements) {
    await connection.query(statement);
  }
  await connection.query(
    'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
    [migration.filename, migration.checksum]
  );
}

async function runMigrations(pool) {
  await pool.query(CREATE_MIGRATIONS_TABLE);

  const [rows] = await pool.query('SELECT filename, checksum FROM schema_migrations');
  const files = await listMigrationFiles();
  for (const row of rows) {
    await readAppliedMigration(row.filename, row.checksum);
  }
  const alreadyApplied = new Set(rows.map(row => row.filename));
  const pending = files.filter(filename => !alreadyApplied.has(filename));

  const connection = await pool.getConnection();
  const applied = [];
  try {
    for (const filename of pending) {
      await applyMigration(connection, await readMigration(filename));
      applied.push(filename);
    }
  } finally {
    connection.release();
  }

  return { applied, skipped: [...alreadyApplied] };
}

module.exports = { runMigrations, listMigrationFiles, parseStatements, readMigration, readAppliedMigration };
