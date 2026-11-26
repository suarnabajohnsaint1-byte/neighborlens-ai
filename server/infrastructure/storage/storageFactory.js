
const env = require('../config/env');

const LocalStorageAdapter =
    require('./localStorage.adapter');

const SupabaseStorageAdapter =
    require('./supabaseStorage.adapter');

let storageInstance;
let currentDriver;

function getImageStorage() {
    if (storageInstance && currentDriver === env.STORAGE_DRIVER) {
        return storageInstance;
    }

    switch (env.STORAGE_DRIVER) {
        case 'local':
            storageInstance = new LocalStorageAdapter();
            break;

        case 'supabase':
            storageInstance = new SupabaseStorageAdapter(env);
            break;

        default:
            throw new Error(
                `Unsupported storage driver: ${env.STORAGE_DRIVER}`
            );
    }

    currentDriver = env.STORAGE_DRIVER;
    return storageInstance;
}

function resetStorage() {
    storageInstance = null;
    currentDriver = null;
}

function setStorageInstance(instance, driver = env.STORAGE_DRIVER) {
    storageInstance = instance;
    currentDriver = driver;
}

module.exports = { getImageStorage, resetStorage, setStorageInstance };
