function createLocalConfig(env) {
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

module.exports = { createLocalConfig };