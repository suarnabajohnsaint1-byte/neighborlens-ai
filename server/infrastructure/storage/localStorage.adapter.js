
const fs = require('node:fs/promises');
const path = require('node:path');

const {
    UPLOAD_ROOT,
    toUploadUrl,
} = require('./uploadDirectory');

class LocalStorageAdapter {
    async upload(file) {
        const reference = toUploadUrl(file.path);

        return {
            provider: 'local',
            key: reference,
            reference,
        };
    }

    async getReadUrl(reference) {
        return reference;
    }

    async remove(reference) {
        if (
            typeof reference !== 'string' ||
            !/^\/uploads\/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$/.test(reference)
        ) {
            throw new Error('Invalid local upload reference.');
        }

        const fileName = reference.slice('/uploads/'.length);

        try {
            await fs.unlink(path.join(UPLOAD_ROOT, fileName));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
}

module.exports = LocalStorageAdapter;
