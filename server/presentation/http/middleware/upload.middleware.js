const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { UPLOAD_ROOT } = require('../../../infrastructure/storage/uploadDirectory');
const { IMAGE_UPLOAD_LIMITS, EXTENSION_BY_MIME, imageFileFilter } = require('./imageUploadPolicy');

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_ROOT,
  filename: (req, file, cb) => {
    const extension = EXTENSION_BY_MIME[file.mimetype] || '';
    cb(null, `${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: IMAGE_UPLOAD_LIMITS,
  fileFilter: imageFileFilter
});

module.exports = upload;
