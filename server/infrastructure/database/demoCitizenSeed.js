const bcrypt = require('bcryptjs');
const env = require('../config/env');

const FIND_USER_BY_USERNAME_SQL = 'SELECT id FROM users WHERE username = ? LIMIT 1';
const INSERT_DEMO_CITIZEN_SQL = 'INSERT INTO users (username, password_hash, role, barangay, full_name) VALUES (?, ?, ?, ?, ?)';

function demoCitizenSeedValues() {
  return [
    env.DEMO_CITIZEN_USERNAME,
    bcrypt.hashSync(env.DEMO_CITIZEN_PASSWORD, 12),
    'citizen',
    'Barangay 1',
    'Demo Citizen'
  ];
}

async function seedDemoCitizen(client) {
  const existing = await client.query(FIND_USER_BY_USERNAME_SQL, [env.DEMO_CITIZEN_USERNAME]);
  if (existing.length) return { seeded: false };

  await client.execute(INSERT_DEMO_CITIZEN_SQL, demoCitizenSeedValues());
  return { seeded: true };
}

module.exports = { FIND_USER_BY_USERNAME_SQL, INSERT_DEMO_CITIZEN_SQL, demoCitizenSeedValues, seedDemoCitizen };
