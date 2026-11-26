const bcrypt = require('bcryptjs');
const env = require('../config/env');

const FIND_ADMIN_SQL = 'SELECT id FROM users WHERE role = ? LIMIT 1';
const INSERT_ADMIN_SQL = 'INSERT INTO users (username, password_hash, role, barangay, full_name) VALUES (?, ?, ?, ?, ?)';

function adminSeedValues() {
  return [
    env.DEFAULT_ADMIN_USERNAME,
    bcrypt.hashSync(env.DEFAULT_ADMIN_PASSWORD, 12),
    'admin',
    'City Wide',
    'System Admin'
  ];
}

async function seedAdminUser(client) {
  const existing = await client.query(FIND_ADMIN_SQL, ['admin']);
  if (existing.length) return { seeded: false };

  await client.execute(INSERT_ADMIN_SQL, adminSeedValues());
  return { seeded: true };
}

module.exports = { FIND_ADMIN_SQL, INSERT_ADMIN_SQL, adminSeedValues, seedAdminUser };
