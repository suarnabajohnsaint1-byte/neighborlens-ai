const env = require('../config/env');
const createMysqlAdapter = require('./mysql/mysqlAdapter');

// MySQL is the only driver runtime can select. Falling back to another store on
// a MySQL failure would make both a green test run and a healthy server
// meaningless, so ./sqlite is reachable only through useTestDatabase().
const RUNTIME_DRIVER = 'mysql';

let instance = null;
let testDatabase = null;

function createDatabase(driver = env.DB_DRIVER) {
  if (driver !== RUNTIME_DRIVER) {
    throw new Error(
      `Unsupported DB_DRIVER "${driver}". The only supported runtime driver is "${RUNTIME_DRIVER}".`
    );
  }
  return createMysqlAdapter();
}

function getDatabase() {
  if (testDatabase) return testDatabase;
  if (!instance) instance = createDatabase();
  return instance;
}

// Test-only seam. Nothing in the request path calls this, so it cannot act as
// a runtime fallback.
function useTestDatabase(database) {
  testDatabase = database;
}

function resetDatabase() {
  instance = null;
  testDatabase = null;
}

module.exports = { RUNTIME_DRIVER, createDatabase, getDatabase, useTestDatabase, resetDatabase };
