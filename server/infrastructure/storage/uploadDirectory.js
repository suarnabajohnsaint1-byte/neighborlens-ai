const path = require('node:path');
const env = require('../config/env');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const UPLOAD_ROOT = path.resolve(PROJECT_ROOT, env.UPLOAD_DIR);
const UPLOAD_URL_PREFIX = '/uploads';

function toUploadUrl(filePath) {
  return `${UPLOAD_URL_PREFIX}/${path.basename(filePath)}`;
}

module.exports = { PROJECT_ROOT, UPLOAD_ROOT, UPLOAD_URL_PREFIX, toUploadUrl };
