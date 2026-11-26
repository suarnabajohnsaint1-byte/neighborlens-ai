const express = require('express');
const aiController = require('../controllers/ai.controller');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const aiUpload = require('../middleware/aiUpload.middleware');
const { createRequestRateLimit } = require('../middleware/requestRateLimit.middleware');
const { createUploadCapacity } = require('../middleware/uploadCapacity.middleware');

const router = express.Router();
router.use(createRequestRateLimit({ maximum: 240 }), requireAuth, requireRole('citizen'), createRequestRateLimit({ maximum: 60, key: req => String(req.user.id) }), createUploadCapacity());

router.post('/damage', aiUpload.array('images', 5), (req, res, next) => aiController.detectDamage(req, res, next));
router.post('/damage-pair', aiUpload.array('images', 2), (req, res, next) => aiController.verifyDamagePair(req, res, next));

module.exports = router;
