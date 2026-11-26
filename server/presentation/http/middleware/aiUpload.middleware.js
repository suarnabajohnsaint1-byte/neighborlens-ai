const multer = require('multer');
const { IMAGE_UPLOAD_LIMITS, imageFileFilter } = require('./imageUploadPolicy');

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: IMAGE_UPLOAD_LIMITS,
  fileFilter: imageFileFilter
});

module.exports = aiUpload;
