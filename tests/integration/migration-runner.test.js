const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listMigrationFiles,
  parseStatements,
  readMigration,
  runMigrations
} = require('../../server/infrastructure/database/mysql/migrationRunner');

test('listMigrationFiles returns .sql files in deterministic order', async () => {
  const files = await listMigrationFiles();
  assert.ok(files.includes('001_init_schema.sql'));
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.every(name => name.endsWith('.sql')));
});

test('migration runner refuses changed applied SQL before applying pending migrations', async () => {
  let acquired = false;
  const pool = {
    query: async sql => sql.includes('FROM schema_migrations') ? [[{ filename: '001_init_schema.sql', checksum: '0'.repeat(64) }]] : [[]],
    getConnection: async () => { acquired = true; throw new Error('No migration must run on a mismatched history.'); }
  };
  await assert.rejects(runMigrations(pool), /checksum.*001_init_schema.sql/i);
  assert.equal(acquired, false);
});

test('migration history remains valid across LF and CRLF checkouts', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  for (const ending of ['\n', '\r\n']) {
    const rows = await Promise.all((await listMigrationFiles()).map(async filename => {
      const sql = await fs.readFile(path.join(__dirname, '../../server/infrastructure/database/mysql/migrations', filename), 'utf8');
      return { filename, checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n').replace(/\n/g, ending)).digest('hex') };
    }));
    const pool = {
      query: async sql => sql.includes('FROM schema_migrations') ? [rows] : [[]],
      getConnection: async () => ({ query: async () => { throw new Error('Already applied SQL must not execute.'); }, release() {} })
    };
    assert.deepEqual((await runMigrations(pool)).applied, []);
  }
});

test('parseStatements splits on statement boundaries and drops comments', () => {
  const statements = parseStatements(`
    -- a leading comment
    CREATE TABLE a (id INT);
    CREATE TABLE b (id INT); -- trailing comment
  `);
  assert.equal(statements.length, 2);
  assert.ok(statements[0].startsWith('CREATE TABLE a'));
  assert.ok(statements[1].startsWith('CREATE TABLE b'));
  assert.ok(!statements.join(' ').includes('comment'));
});

test('parseStatements does not split on semicolons inside quoted literals', () => {
  const statements = parseStatements("INSERT INTO t (v) VALUES ('a;b'); SELECT 1;");
  assert.equal(statements.length, 2);
  assert.equal(statements[0], "INSERT INTO t (v) VALUES ('a;b')");
  assert.equal(statements[1], 'SELECT 1');
});

test('parseStatements preserves semicolons inside backtick identifiers and escapes', () => {
  const statements = parseStatements("SELECT `we;ird` FROM t WHERE v = 'it\\'s; fine';");
  assert.equal(statements.length, 1);
  assert.ok(statements[0].includes('`we;ird`'));
  assert.ok(statements[0].includes("it\\'s; fine"));
});

test('parseStatements ignores trailing whitespace-only fragments', () => {
  assert.deepEqual(parseStatements('SELECT 1;\n\n   \n'), ['SELECT 1']);
  assert.deepEqual(parseStatements('   '), []);
});

test('readMigration exposes a stable checksum and parsed statements', async () => {
  const migration = await readMigration('001_init_schema.sql');
  const again = await readMigration('001_init_schema.sql');
  assert.equal(migration.filename, '001_init_schema.sql');
  assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  assert.equal(migration.checksum, again.checksum);
  assert.ok(migration.statements.length > 0);
  assert.ok(migration.statements.some(statement => statement.includes('CREATE TABLE IF NOT EXISTS report_images')));
});

test('recovered migration sources match the exact applied historical checksums', async () => {
  for (const [filename, checksum] of Object.entries({
    '001_init_schema.sql': 'a65af462fddb093a40157d0d1776273f6cc28fb53aa3a7199f802d13397bf662',
    '009_community_feed.sql': 'aad817432d3f4638b6f2aef86dcf2ea6e63ceb8c746097068450e8ad66acf14b'
  })) assert.ok((await readMigration(filename)).compatibleChecksums.includes(checksum));
});

test('documented deployed history requires an intact versioned SQL source and preserves the recorded hash', async () => {
  const { readAppliedMigration } = require('../../server/infrastructure/database/mysql/migrationRunner');
  for (const [filename, checksum] of Object.entries({
    '001_init_schema.sql': '082a7aa1f22e01f7f9358ff8e79123552775a8861ed0fb2ba2680b68e06799c7',
    '009_community_feed.sql': 'c7cb9ad5dee5cb2eb4b4a2ad517a5b2f157c514cabdece8237a8436edc1576b0'
  })) {
    const source = await readAppliedMigration(filename, checksum);
    assert.ok(source.source.includes('migration-history')); assert.ok(source.compatibleChecksums.includes(checksum));
    await assert.rejects(readAppliedMigration(filename, 'f'.repeat(64)), /checksum mismatch/i);
  }
});

test('missing applied migration sources fail before acquiring a mutation connection', async () => {
  const pool = { query: async sql => sql.includes('FROM schema_migrations') ? [[{ filename: '999_missing.sql', checksum: 'f'.repeat(64) }]] : [[]], getConnection: async () => { throw new Error('Mutation connection was acquired.'); } };
  await assert.rejects(runMigrations(pool), /Applied migration source is missing/);
});
