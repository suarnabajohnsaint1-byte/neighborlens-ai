const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const imageInput = require('../infrastructure/storage/imageInput.adapter');
const { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } = require('../../tests/support/image-fixtures');
const { DEFAULT_MAX_BYTES } = require('../domain/reports/damageDetection.rules');
const corruptPng = Buffer.from(PNG_BYTES);
corruptPng[80] ^= 0xff;

for (const [mimeType, buffer] of [
  ['image/jpeg', JPEG_BYTES],
  ['image/png', PNG_BYTES],
  ['image/webp', WEBP_BYTES]
]) {
  test(`report validator decodes valid ${mimeType}`, async () => {
    await imageInput.validateReportImage({ buffer, mimetype: mimeType });
  });
  test(`report validator rejects truncated ${mimeType}`, async () => {
    await assert.rejects(
      imageInput.validateReportImage({
        buffer: buffer.subarray(0, Math.floor(buffer.length / 2)),
        mimetype: mimeType
      }),
      {
        code: 'IMAGE_VALIDATION_ERROR',
        kind: 'VALIDATION'
      }
    );
  });
}

for (const [name, buffer, mimetype] of [
  ['empty', Buffer.alloc(0), 'image/jpeg'],
  ['invalid bytes', Buffer.from('not an image'), 'image/jpeg'],
  ['mismatched MIME', PNG_BYTES, 'image/jpeg'],
  ['unsupported format', Buffer.from('GIF89a'), 'image/gif'],
  ['oversized bytes', Buffer.concat([JPEG_BYTES, Buffer.alloc(DEFAULT_MAX_BYTES)]), 'image/jpeg'],
  ['invalid PNG checksum', corruptPng, 'image/png'],
  ['missing PNG end bytes', PNG_BYTES.subarray(0, PNG_BYTES.length - 2), 'image/png'],
  ['trailing PNG garbage', Buffer.concat([PNG_BYTES, Buffer.from('garbage')]), 'image/png'],
  ['signature without pixels', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg']
]) {
  test(`report validator rejects ${name} with a safe validation error`, async () => {
    await assert.rejects(imageInput.validateReportImage({ buffer, mimetype }), (error) => {
      assert.equal(error.code, 'IMAGE_VALIDATION_ERROR');
      assert.equal(error.kind, 'VALIDATION');
      assert.doesNotMatch(error.message, /libvips|sharp|ENOENT|supabase|SQL|\\tmp/);
      return true;
    });
  });
}

test('disk evidence is decoded and missing disk evidence returns no internal path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neighborlens-image-'));
  const filename = path.join(directory, 'valid.png');
  try {
    await fs.writeFile(filename, PNG_BYTES);
    await imageInput.validateReportImage({ path: filename, mimetype: 'image/png' });
    await imageInput.removeTemporaryFiles([{ path: filename }]);
    await assert.rejects(
      imageInput.validateReportImage({ path: filename, mimetype: 'image/png' }),
      (error) => {
        assert.equal(error.code, 'IMAGE_VALIDATION_ERROR');
        assert.equal(error.message.includes(filename), false);
        return true;
      }
    );
  } finally {
    await fs.rmdir(directory);
  }
});
