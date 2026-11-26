const express = require('express');
const barangayController = require('../controllers/barangay.controller');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const { createRequestRateLimit } = require('../middleware/requestRateLimit.middleware');
const { barangayOperationsService } = require('../../../composition');

const router = express.Router();

router.get('/', (req, res, next) => barangayController.listCatalog(req, res, next));
for (const name of ['gis', 'activity']) router.get(`/${name}`, requireAuth, requireRole('barangay'), createRequestRateLimit({ maximum: 120, key: req => String(req.user.id) }), async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await barangayOperationsService[name](req.user, req.query)); }
  catch (error) { next(error); }
});

module.exports = router;
