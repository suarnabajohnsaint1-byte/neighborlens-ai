const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const crc32 = require('crc-32');
const { ValidationError, DamageDetectionError } = require('../../domain/errors');
const { detectMimeType, validateImage } = require('../../domain/reports/damageDetection.rules');

async function read(input) {
  if (!input) throw new DamageDetectionError('Image input is required.', 'IMAGE_REQUIRED');
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buffer = Buffer.from(input);
    return {
      buffer,
      mimeType: detectMimeType(buffer),
      source: Buffer.isBuffer(input) ? 'buffer' : 'uint8array'
    };
  }
  if (typeof input === 'object' && input.buffer) {
    const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
    return {
      buffer,
      mimeType: input.mimetype || input.type || detectMimeType(buffer),
      source: 'file-object'
    };
  }
  if (typeof input === 'object' && input.path) {
    const buffer = await fs.readFile(input.path);
    return {
      buffer,
      mimeType: input.mimetype || input.type || detectMimeType(buffer),
      source: path.resolve(input.path)
    };
  }
  if (typeof input === 'string' && input.startsWith('data:')) {
    const match = input.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
    if (!match)
      throw new DamageDetectionError(
        'Only base64 JPEG, PNG, and WebP data URLs are supported.',
        'IMAGE_FORMAT'
      );
    return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1], source: 'data-url' };
  }
  if (typeof input === 'string') {
    const buffer = await fs.readFile(input);
    return { buffer, mimeType: detectMimeType(buffer), source: path.resolve(input) };
  }
  throw new DamageDetectionError('Unsupported image input type.', 'IMAGE_INPUT_TYPE');
}

function validatePngChunks(buffer) {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error('Incomplete PNG chunk.');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const checksum = crc32.buf(buffer.subarray(offset + 4, end - 4)) >>> 0;
    if (checksum !== buffer.readUInt32BE(end - 4)) throw new Error('Invalid PNG checksum.');
    if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length) throw new Error('Invalid PNG end chunk.');
      return;
    }
    offset = end;
  }
  throw new Error('Missing PNG end chunk.');
}

async function validateReportImage(file, { preserveFormatError = false } = {}) {
  try {
    const image = await read(file);
    validateImage(image.buffer, image.mimeType);
    if (image.mimeType === 'image/png') validatePngChunks(image.buffer);
    await sharp(image.buffer, { failOn: 'warning', animated: true }).stats();
    return image;
  } catch (error) {
    if (preserveFormatError && error instanceof DamageDetectionError) throw error;
    throw new ValidationError(
      'Invalid image. Upload a complete JPEG, PNG, or WebP image with a matching MIME type within the 10 MB limit.',
      {
        code: 'IMAGE_VALIDATION_ERROR'
      }
    );
  }
}

async function evidenceFingerprint({ buffer }) {
  try {
    const source = sharp(buffer, { failOn: 'warning' });
    const { width, height, orientation } = await source.metadata();
    const size = 96;
    const pixels = await source.autoOrient().resize(size, size, { fit: 'fill' })
      .toColourspace('srgb').flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
    return { pixels, width: size, aspectRatio: orientation >= 5 ? height / width : width / height };
  } catch {
    throw new ValidationError('The photo could not be processed. Retake it and try again.', { code: 'IMAGE_VALIDATION_ERROR' });
  }
}

async function removeTemporaryFiles(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
}

module.exports = { read, validateReportImage, evidenceFingerprint, removeTemporaryFiles };
