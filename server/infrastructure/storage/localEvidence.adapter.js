const fs = require('node:fs/promises');
const path = require('node:path');
const env = require('../config/env');
const { PROJECT_ROOT, UPLOAD_ROOT } = require('./uploadDirectory');
const { NotFoundError } = require('../../domain/errors');

const FILE_NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,190}\.(?:jpg|jpeg|png|webp)$/i;

async function resolve(reference) {
  const match = typeof reference === 'string' && /^\/uploads\/([^/]+)$/.exec(reference);
  if (!match || !FILE_NAME.test(match[1]) || match[1].includes('..')) throw new NotFoundError('Attachment unavailable.');
  for (const directory of new Set([UPLOAD_ROOT, env.LEGACY_UPLOAD_DIR, path.join(PROJECT_ROOT, 'uploads')])) {
    try {
      const root = await fs.realpath(directory);
      const file = await fs.realpath(path.join(root, match[1]));
      if (path.dirname(file) !== root || !(await fs.stat(file)).isFile()) continue;
      return file;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new NotFoundError('Attachment unavailable.');
}

module.exports = { resolve };
