const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const sharp = require('sharp');
const { getImageStorage } = require('./storageFactory');
const { UPLOAD_ROOT } = require('./uploadDirectory');
const localEvidence = require('./localEvidence.adapter');
const imageInput = require('./imageInput.adapter');
const { ValidationError, NotFoundError } = require('../../domain/errors');

function fingerprint(body, files) {
  const hash = createHash('sha256').update(JSON.stringify(body));
  for (const file of files) hash.update(createHash('sha256').update(file.buffer).digest());
  return hash.digest('hex');
}

async function publish(file, { reportEvidence = false } = {}) {
  const maxBytes = (reportEvidence ? 10 : 5) * 1024 * 1024;
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length || file.buffer.length > maxBytes) throw new ValidationError(`Choose an image no larger than ${reportEvidence ? 10 : 5} MB.`);
  const options = { failOn: 'warning', ...(reportEvidence ? {} : { limitInputPixels: 16000000 }) };
  let output;
  try {
    const metadata = await sharp(file.buffer, options).metadata();
    if ((metadata.pages || 1) !== 1) throw new Error('Animated image.');
    await imageInput.validateReportImage(file);
    output = await sharp(file.buffer, options).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new ValidationError(reportEvidence ? 'Use a complete supported report photo under 10 MB.' : 'Use a complete JPEG, PNG, or WebP photo under 5 MB and 16 megapixels.');
  }
  if (output.length > 5 * 1024 * 1024) throw new ValidationError('Published photo exceeds 5 MB.');
  const storage = getImageStorage();
  await storage.assertPrivate?.();
  const filename = `${randomUUID()}.webp`;
  const local = path.join(UPLOAD_ROOT, filename);
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.writeFile(local, output, { flag: 'wx' });
  try {
    const saved = await storage.upload({ path: local, mimetype: 'image/webp' }, `reports/community/${filename}`);
    if (saved.provider !== 'local') await fs.unlink(local);
    return saved.reference;
  } catch (error) {
    await fs.unlink(local).catch(() => {});
    throw error;
  }
}

async function remove(reference) { await getImageStorage().remove(reference); }

async function read(reference) {
  if (typeof reference !== 'string' || !/^(?:\/uploads\/|supabase:reports\/community\/)[a-f0-9-]{36}\.webp$/.test(reference)) throw new NotFoundError('Community photo unavailable.');
  if (reference.startsWith('/uploads/')) {
    try { return await fs.readFile(await localEvidence.resolve(reference)); }
    catch { throw new NotFoundError('Community photo unavailable.'); }
  }
  const url = await getImageStorage().getReadUrl(reference);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new NotFoundError('Community photo unavailable.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 5 * 1024 * 1024) throw new NotFoundError('Community photo unavailable.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

async function readAttachment(reference) {
  if (typeof reference !== 'string' || !reference.trim()) return null;
  if (reference.startsWith('supabase:')) {
    const url = await getImageStorage().getReadUrl(reference);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }
  const normalized = reference.startsWith('/uploads/') ? reference : (reference.startsWith('uploads/') ? `/${reference}` : `/uploads/${reference}`);
  try {
    const resolved = await localEvidence.resolve(normalized);
    return fs.readFile(resolved);
  } catch {
    return null;
  }
}

module.exports = { publish, publishReportEvidence: file => publish(file, { reportEvidence: true }), remove, read, readAttachment, fingerprint };
