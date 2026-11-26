
'use strict';

const fs = require('node:fs');

function resolveCertificate(caValue) {
    if (typeof caValue !== 'string' || !caValue.trim()) {
        throw new Error(
            'DB_SSL_CA is required for production MySQL connections'
        );
    }

    const value = caValue.trim();

    // Supports PEM content stored in environment variables.
    if (value.includes('-----BEGIN CERTIFICATE-----')) {
        return value.replace(/\\n/g, '\n');
    }

    // Supports an existing local certificate file path.
    return fs.readFileSync(value, 'utf8');
}

function createProductionConfig(env) {
    if (
        !env.DB_HOST ||
        !env.DB_USER ||
        !env.DB_PASSWORD ||
        !env.DB_NAME
    ) {
        throw new Error('Missing production database configuration');
    }

    return {
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
        connectionLimit: env.DB_CONNECTION_LIMIT,
        connectTimeout: env.DB_CONNECT_TIMEOUT_MS,
        waitForConnections: true,
        dateStrings: true,

        ssl: {
            ca: resolveCertificate(env.DB_SSL_CA),
            rejectUnauthorized: true
        }
    };
}

module.exports = { createProductionConfig };
