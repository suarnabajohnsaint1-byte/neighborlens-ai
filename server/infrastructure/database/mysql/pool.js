
'use strict';

const mysql = require('mysql2/promise');
const env = require('../../config/env');
const { createProductionConfig } = require('./config/production.config');

let pool = null;

function createLocalConfig() {
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
    waitForConnections: true,
    dateStrings: true
  };
}

function getPool() {
  if (!pool) {
    const useSecureConfig =
      env.NODE_ENV === 'production' ||
      env.DB_TARGET === 'aiven';

    const config = useSecureConfig
      ? createProductionConfig(env)
      : createLocalConfig();

    pool = mysql.createPool(config);
  }

  return pool;
}

async function closePool() {
  if (!pool) return;

  const closing = pool;
  pool = null;

  await closing.end();
}

module.exports = { getPool, closePool };
