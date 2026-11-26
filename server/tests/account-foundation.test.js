const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { BACOLOD_BARANGAY_CATALOG } = require('../infrastructure/database/barangayCatalog');
const { createStreamTicketStore } = require('../infrastructure/security/streamTickets');
const {
  checkOfficialPassword,
  checkOfficialUsername,
  normalizeStatus,
  isActive,
  sessionMatchesAccount
} = require('../domain/accounts/account.rules');
const { authorizeReportAccess, normalizeStatusNote } = require('../domain/reports/report.rules');

const MIGRATION = path.join(__dirname, '../infrastructure/database/mysql/migrations/004_barangay_accounts_foundation.sql');
const FRONTEND_GEOFENCE = path.join(__dirname, '../../frontend/js/map/geofence.js');

test('the catalog holds 61 unique Bacolod barangays with ids 1 to 61', () => {
  assert.equal(BACOLOD_BARANGAY_CATALOG.length, 61);
  assert.equal(new Set(BACOLOD_BARANGAY_CATALOG.map(b => b.name)).size, 61);
  assert.deepEqual(BACOLOD_BARANGAY_CATALOG.map(b => b.id), Array.from({ length: 61 }, (_, i) => i + 1));
});

test('the MySQL migration seeds exactly the catalog with the same stable ids', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const rows = [...sql.matchAll(/\((\d+), '([^']+)', 'Bacolod City'/g)].map(([, id, name]) => ({ id: Number(id), name }));
  assert.deepEqual(rows, BACOLOD_BARANGAY_CATALOG.map(b => ({ id: b.id, name: b.name })));
});

test('the frontend registration list matches the server catalog names', () => {
  const source = fs.readFileSync(FRONTEND_GEOFENCE, 'utf8');
  const block = source.slice(source.indexOf('const BACOLOD_BARANGAYS = ['), source.indexOf('];', source.indexOf('const BACOLOD_BARANGAYS = [')));
  const names = [...block.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(names, BACOLOD_BARANGAY_CATALOG.map(b => b.name));
});

test('official password policy requires length, a letter, and a number', () => {
  assert.match(checkOfficialPassword('short1'), /at least 8/);
  assert.match(checkOfficialPassword('onlyletters'), /letter and one number/);
  assert.match(checkOfficialPassword('12345678'), /letter and one number/);
  assert.match(checkOfficialPassword(`a1${'x'.repeat(80)}`), /at most 72/);
  assert.equal(checkOfficialPassword('Barangay2026'), null);
});

test('official usernames are restricted to a safe character set', () => {
  assert.equal(checkOfficialUsername('brgy_villamonte.01'), null);
  for (const bad of ['ab', '-leading', 'has space', 'semi;colon', `${'a'.repeat(65)}`]) {
    assert.ok(checkOfficialUsername(bad), bad);
  }
});

test('account status values are normalized and only active accounts pass', () => {
  assert.equal(normalizeStatus(' Suspended '), 'suspended');
  assert.equal(normalizeStatus('deleted'), null);
  assert.equal(isActive({ status: 'active' }), true);
  assert.equal(isActive({ status: 'suspended' }), false);
  assert.equal(isActive(null), false);
});

test('a session matches only when id, role, and token version agree with the database', () => {
  const account = { id: 7, role: 'barangay', token_version: 2 };
  assert.equal(sessionMatchesAccount({ id: 7, role: 'barangay', tv: 2 }, account), true);
  assert.equal(sessionMatchesAccount({ id: 7, role: 'admin', tv: 2 }, account), false);
  assert.equal(sessionMatchesAccount({ id: 7, role: 'barangay', tv: 1 }, account), false);
  assert.equal(sessionMatchesAccount({ id: 8, role: 'barangay', tv: 2 }, account), false);
  assert.equal(sessionMatchesAccount({ id: 7, role: 'barangay', tv: 2 }, null), false);
});

test('barangay jurisdiction is decided by the server-assigned barangay id, not by names', () => {
  const report = { submitted_by: 1, barangay: 'Villamonte', barangay_id: 60 };
  assert.equal(authorizeReportAccess(report, { id: 5, role: 'barangay', barangayId: 60 }).allowed, true);
  assert.equal(authorizeReportAccess(report, { id: 5, role: 'barangay', barangayId: 1, barangay: 'Villamonte' }).allowed, false);
  assert.equal(authorizeReportAccess({ ...report, barangay_id: null }, { id: 5, role: 'barangay', barangayId: null }).allowed, false);
  assert.equal(authorizeReportAccess(report, { id: 1, role: 'citizen' }).allowed, true);
  assert.equal(authorizeReportAccess(report, { id: 9, role: 'admin' }).allowed, true);
});

test('status notes are optional, trimmed, and bounded', () => {
  assert.deepEqual(normalizeStatusNote(undefined), { value: null });
  assert.deepEqual(normalizeStatusNote('  fixed  '), { value: 'fixed' });
  assert.deepEqual(normalizeStatusNote('   '), { value: null });
  assert.ok(normalizeStatusNote('x'.repeat(501)).error);
  assert.ok(normalizeStatusNote({ text: 'x' }).error);
});

test('stream tickets are single use and expire', () => {
  let now = 1000;
  const store = createStreamTicketStore({ ttlMs: 30000, now: () => now });
  const { ticket, expiresInSeconds } = store.issue({ id: 3, role: 'citizen', tv: 0 });
  assert.equal(expiresInSeconds, 30);
  assert.deepEqual({ ...store.consume(ticket) }, { id: 3, role: 'citizen', tv: 0 });
  assert.equal(store.consume(ticket), null);

  const expiring = store.issue({ id: 4, role: 'citizen', tv: 0 }).ticket;
  now += 30001;
  assert.equal(store.consume(expiring), null);
  assert.equal(store.consume('not-a-ticket'), null);
  assert.equal(store.consume(undefined), null);
});
