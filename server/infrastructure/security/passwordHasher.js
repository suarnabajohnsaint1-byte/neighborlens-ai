const bcrypt = require('bcryptjs');

const DEFAULT_COST = 12;

function hash(plainPassword, cost = DEFAULT_COST) {
  return bcrypt.hashSync(plainPassword, cost);
}

function verify(plainPassword, storedHash) {
  if (!storedHash) return false;
  try {
    return bcrypt.compareSync(plainPassword, storedHash);
  } catch {
    // A malformed hash must read as "does not match", never as an error that
    // distinguishes this account from any other.
    return false;
  }
}

module.exports = { hash, verify, DEFAULT_COST };
