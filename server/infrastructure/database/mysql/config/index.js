const { createLocalConfig } = require('./local.config');
const { createProductionConfig } = require('./production.config');

function createDatabaseConfig(env) {
    const target = env.DB_TARGET;

    if (target === 'local') {
        if (env.NODE_ENV === 'production') {
            throw new Error('Local MySQL is not allowed in production');
        }

        return createLocalConfig(env);
    }

    if (target === 'aiven') {
        return createProductionConfig(env);
    }

    throw new Error('DB_TARGET must be local or aiven');
}

module.exports = { createDatabaseConfig };