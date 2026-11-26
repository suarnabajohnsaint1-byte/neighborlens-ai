const IMAGE_UPLOAD_LIMITS = Object.freeze({ fileSize: 10 * 1024 * 1024, files: 5 });

const EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
});

function imageFileFilter(req, file, cb) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
    const error = new Error('Invalid image format. Only JPEG, PNG, and WebP images are allowed.');
    error.statusCode = 400;
    return cb(error, false);
  }
  cb(null, true);
}

module.exports = { IMAGE_UPLOAD_LIMITS, EXTENSION_BY_MIME, imageFileFilter };
