const express = require('express');
const identityController = require('../controllers/identity.controller');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const { createRequestRateLimit } = require('../middleware/requestRateLimit.middleware');

const router = express.Router();

// Both routes act on the caller's own record; there is intentionally no
// GET /:userId route.
router.get('/me', requireAuth, requireRole('citizen'), (req, res, next) => identityController.getMine(req, res, next));
router.post('/',
  requireAuth,
  requireRole('citizen'),
  createRequestRateLimit({ maximum: 20, key: (req) => String(req.user.id) }),
  (req, res, next) => identityController.save(req, res, next)
);

module.exports = router;
