
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SupabaseStorageAdapter = require(
    '../infrastructure/storage/supabaseStorage.adapter'
);

const KEY =
    'reports/12/123e4567-e89b-42d3-a456-426614174000.jpg';

const REFERENCE = `supabase:${KEY}`;

function createAdapter(bucket) {
    const adapter = Object.create(
        SupabaseStorageAdapter.prototype
    );

    adapter.bucket = bucket;
    adapter.bucketName = 'neighborlens-reports';

    return adapter;
}

test('uploads an image and returns Supabase reference', async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'neighborlens-storage-')
    );

    const filePath = path.join(directory, 'test.jpg');

    try {
        const content = Buffer.from([0xff, 0xd8, 0xff]);

        await fs.writeFile(filePath, content);

        let uploadedKey;
        let uploadedBody;
        let uploadedOptions;

        const storage = createAdapter({
            async upload(key, body, options) {
                uploadedKey = key;
                uploadedBody = body;
                uploadedOptions = options;

                return {
                    data: { path: key },
                    error: null
                };
            }
        });

        const result = await storage.upload(
            {
                path: filePath,
                mimetype: 'image/jpeg'
            },
            KEY
        );

        assert.equal(uploadedKey, KEY);
        assert.deepEqual(uploadedBody, content);
        assert.equal(uploadedOptions.contentType, 'image/jpeg');
        assert.equal(uploadedOptions.upsert, false);

        assert.deepEqual(result, {
            provider: 'supabase',
            key: KEY,
            reference: REFERENCE
        });
    } finally {
        await fs.rm(directory, {
            recursive: true,
            force: true
        });
    }
});

test('generates a signed URL with 300-second expiry', async () => {
    let requestedKey;
    let expiry;

    const storage = createAdapter({
        async createSignedUrl(key, expiresIn) {
            requestedKey = key;
            expiry = expiresIn;

            return {
                data: {
                    signedUrl: 'https://example.test/signed-image'
                },
                error: null
            };
        }
    });

    const url = await storage.getReadUrl(REFERENCE);

    assert.equal(requestedKey, KEY);
    assert.equal(expiry, 300);
    assert.equal(
        url,
        'https://example.test/signed-image'
    );
});

test('removes the correct Supabase object', async () => {
    let removedKeys;

    const storage = createAdapter({
        async remove(keys) {
            removedKeys = keys;

            return { error: null };
        }
    });

    await storage.remove(REFERENCE);

    assert.deepEqual(removedKeys, [KEY]);
});

test('rejects invalid Supabase references', async () => {
    const storage = createAdapter({});

    await assert.rejects(
        () => storage.getReadUrl('supabase:../secret.jpg'),
        /Invalid Supabase image reference/
    );
});

test('propagates Supabase upload errors', async () => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'neighborlens-storage-')
    );

    const filePath = path.join(directory, 'test.jpg');

    try {
        await fs.writeFile(
            filePath,
            Buffer.from([0xff, 0xd8])
        );

        const storage = createAdapter({
            async upload() {
                return {
                    data: null,
                    error: new Error('Storage upload failed')
                };
            }
        });

        await assert.rejects(
            () => storage.upload(
                {
                    path: filePath,
                    mimetype: 'image/jpeg'
                },
                KEY
            ),
            /Storage upload failed/
        );
    } finally {
        await fs.rm(directory, {
            recursive: true,
            force: true
        });
    }
});
