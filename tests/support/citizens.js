const database = () => require('../../server/infrastructure/database').getDatabase();

const locations = {
  'Barangay 1': { latitude: 10.678, longitude: 122.946 },
  'Barangay 2': { latitude: 10.675, longitude: 122.974 },
  'Barangay Central': { latitude: 10.678, longitude: 122.946 },
  Villamonte: { latitude: 10.6685, longitude: 122.9647 },
  Mandalagan: { latitude: 10.694, longitude: 122.972 },
  Mansilingan: { latitude: 10.65613, longitude: 122.99357 }
};
let lastFix = 0;

function freshReportFixAt() {
  lastFix = Math.max(Date.now(), lastFix + 1);
  return lastFix;
}

function reportGpsFields(barangay = 'Barangay 1') {
  const location = locations[barangay];
  if (!location) throw new Error(`No reporting fixture location for ${barangay}`);
  return { ...location, gpsAccuracy: 15, gpsFixAt: freshReportFixAt() };
}

function addReportGps(form, barangay) {
  for (const [field, value] of Object.entries(reportGpsFields(barangay))) {
    if (!form.has(field)) form.set(field, String(value));
  }
  return form;
}

async function installFixtureBarangay(name, db = database()) {
  const barangays = require('../../server/infrastructure/repositories/barangay.repository');
  const location = locations[name];
  if (!location) throw new Error(`No reporting fixture location for ${name}`);
  const { latitude, longitude } = location;
  const boundaryGeojson = { type: 'Polygon', coordinates: [[
    [longitude - .002, latitude - .002], [longitude + .002, latitude - .002],
    [longitude + .002, latitude + .002], [longitude - .002, latitude + .002],
    [longitude - .002, latitude - .002]
  ]] };
  const boundarySource = 'isolated regression fixture';
  const boundaryVersion = 'fixture-v1';
  const existing = await barangays.findByName(name, db);
  if (!existing) {
    const { insertId } = await barangays.create({ name, boundaryGeojson, boundarySource, boundaryVersion }, db);
    return insertId;
  }
  if (!existing.boundary_geojson) {
    await db.execute('UPDATE barangays SET boundary_geojson = ?, boundary_source = ?, boundary_version = ? WHERE id = ?',
      [JSON.stringify(boundaryGeojson), boundarySource, boundaryVersion, existing.id]);
  }
  return existing.id;
}

async function setFixtureResidency(username, barangay, db = database()) {
  const users = require('../../server/infrastructure/repositories/user.repository');
  const barangayId = await installFixtureBarangay(barangay, db);
  const citizen = await users.findByUsername(username, db);
  if (citizen?.role !== 'citizen') throw new Error(`Missing fixture citizen ${username}`);
  await db.withTransaction(async tx => {
    await tx.execute('UPDATE users SET barangay = ?, barangay_id = ?, enrollment_tier = ? WHERE id = ?',
      [barangay, barangayId, 'FULLY_VERIFIED', citizen.id]);
    await users.confirmCitizenResidence(citizen.id, { cityVersion: 'fixture-land-only', barangayVersion: 'fixture-v1' }, tx);
  });
}

async function seedCitizen({ username, password, barangay = 'Barangay 1', fullName = null, reporting = false }, db = database()) {
  const users = require('../../server/infrastructure/repositories/user.repository');
  const { hash } = require('../../server/infrastructure/security/passwordHasher');
  await users.create({ username, passwordHash: hash(password), barangay, role: 'citizen', fullName }, db);
  if (reporting) await setFixtureResidency(username, barangay, db);
  return require('../../server/composition').authService.login(username, password, 'citizen');
}

module.exports = { addReportGps, freshReportFixAt, installFixtureBarangay, reportGpsFields, seedCitizen, setFixtureResidency };
