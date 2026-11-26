const { assessDamageUpload, damageDetectionService } = require('../../../composition');
const { ValidationError } = require('../../../domain/errors');

function uploadedFiles(req) {
  const files = Array.isArray(req.files) && req.files.length ? req.files : (req.file ? [req.file] : []);
  return files.map(inMemoryImage);
}

function inMemoryImage(file) {
  if (!Buffer.isBuffer(file?.buffer)) {
    throw new ValidationError('Uploaded image was not received in memory.');
  }
  return { buffer: file.buffer, mimetype: file.mimetype, originalname: file.originalname };
}

class AiController {
  async detectDamage(req, res, next) {
    try {
      const { batch, preview } = await assessDamageUpload(uploadedFiles(req), req.user, {
        assessment: req.body?.assessment,
        photoOrder: req.body?.photoOrder
      });
      if (!preview) return res.json(batch);

      const { failure, result, assessmentProof, correctionCategories } = preview;
      if (failure) return res.status(failure.status).json({ ...failure, assessmentProof, correctionCategories });
      return res.json({ ok: true, count: 1, primary: result, results: [result], assessmentProof, correctionCategories });
    } catch (error) {
      next(error);
    }
  }

  async verifyDamagePair(req, res, next) {
    try {
      const files = uploadedFiles(req);
      if (files.length !== 2) {
        throw new ValidationError('Exactly two images are required for dual-perspective verification.');
      }
      res.json(await damageDetectionService.verifyDamagePair(files[0], files[1], {}));
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AiController();
