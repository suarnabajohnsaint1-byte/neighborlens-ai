const test = require('node:test');
const assert = require('node:assert/strict');
const LocalStorageAdapter = require('../infrastructure/storage/localStorage.adapter');
const path = require('node:path')

const { UPLOAD_ROOT } = require('../infrastructure/storage/uploadDirectory');

const FILENAME = '123e4567-e89b-42d3-a456-426614174000.jpg'

test('local storage returns correct image reference', async () => {
    const storage = new LocalStorageAdapter();

    const result = await storage.upload({ path: path.join(UPLOAD_ROOT, FILENAME), mimetype: 'image/jpeg' });

    assert.equal(result.provider, 'local')
    assert.equal(result.reference, `/uploads/${FILENAME}`)
})

test('Local storage returns incorrect image reference', async () => {
    const storage = new LocalStorageAdapter();

    const result = await storage.upload({ path: path.join(UPLOAD_ROOT, FILENAME), mimetype: 'image/jpeg' });

    assert.notEqual(result.reference, `/uploads${FILENAME}`)
})

test('Local storage returns existing URL unchanged', async () => {
    const storage = new LocalStorageAdapter();

    const reference = `/uploads/${FILENAME}`

    const result = await storage.getReadUrl(reference)

    assert.equal(result, reference)
})

test('Local storage rejects path traversal', async () => {
    const storage = new LocalStorageAdapter();

    await assert.rejects(
        () => storage.remove('/uploads/../../.env'),
        /Invalid local upload reference/
    );
});
