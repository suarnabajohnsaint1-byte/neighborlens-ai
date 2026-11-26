const express = require('express');
const reportsController = require('../controllers/reports.controller');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');
const reportAnalyticsController = require('../controllers/reportAnalytics.controller');
const { createRequestRateLimit } = require('../middleware/requestRateLimit.middleware');
const { createUploadCapacity } = require('../middleware/uploadCapacity.middleware');

const router = express.Router();
const reviewLimit = createRequestRateLimit({ maximum: 40, key: req => String(req.user.id) });
const reviewReadLimit = createRequestRateLimit({ maximum: 120, key: req => String(req.user.id) });
for (const [method, path, operation] of [
  ['get', '/:id/review', 'load'], ['get', '/:id/citizen-comments', 'comments'], ['post', '/:id/messages', 'send'],
  ['post', '/:id/messages/read', 'read'], ['post', '/:id/severity', 'reviewSeverity']
]) router[method](path, requireAuth, requireRole('admin', 'barangay'), method === 'get' ? reviewReadLimit : reviewLimit, async (req, res, next) => {
  try {
    const value = await require('../../../composition').reportReviewService[operation](req.params.id, req.user, method === 'get' ? req.query : req.body);
    res.set('Cache-Control', 'no-store').json(value);
  } catch (error) { next(error); }
});
for (const [method, path, operation] of [
  ['get', '/:id/incident-review', 'load'], ['post', '/:id/duplicate-review', 'decide'],
  ['post', '/:id/routing-flags', 'flag'], ['patch', '/:id/jurisdiction', 'assign']
]) router[method](path, requireAuth, method === 'get' ? reviewReadLimit : reviewLimit, async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await require('../../../composition').incidentService[operation](req.params.id, req.user, method === 'get' ? req.query : req.body)); }
  catch (error) { next(error); }
});
const exportLimit = createRequestRateLimit({ maximum: 4, windowMs: 60000, key: req => String(req.user.id) });
router.get('/print-preview', requireAuth, requireRole('barangay'), exportLimit, async (req, res, next) => {
  try {
    const result = await require('../../../composition').reportExportService.execute(req.user, req.query, { printable: true });
    res.set('Cache-Control', 'no-store').json(result);
  } catch (error) { next(error); }
});
router.get('/export', requireAuth, requireRole('admin', 'barangay'), exportLimit, async (req, res, next) => {
  try {
    const result = await require('../../../composition').reportExportService.execute(req.user, req.query);
    res.set({ 'Access-Control-Expose-Headers': 'Content-Disposition', 'Cache-Control': 'no-store', 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${result.filename}"`, 'X-Content-Type-Options': 'nosniff' }).send(result.buffer);
  } catch (error) { next(error); }
});
router.get('/gis', requireAuth, requireRole('admin', 'barangay'), createRequestRateLimit({ maximum: 120, key: req => String(req.user.id) }), async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await require('../../../composition').reportGisService.load(req.user, req.query)); }
  catch (error) { next(error); }
});

router.get('/', requireAuth, (req, res, next) => reportsController.getReports(req, res, next));
router.get('/analytics', requireAuth, requireRole('admin', 'barangay'), (req, res, next) => reportAnalyticsController.getAnalytics(req, res, next));
router.get('/:id/images/landmark', requireAuth, requireRole('citizen', 'admin', 'barangay'), (req, res, next) => reportsController.getLandmarkAttachment(req, res, next));
router.get('/:id/images/:imageId', requireAuth, requireRole('citizen', 'admin', 'barangay'), (req, res, next) => reportsController.getAttachment(req, res, next));
router.get('/:id', requireAuth, requireRole('citizen', 'admin', 'barangay'), (req, res, next) => reportsController.getReport(req, res, next));
router.post('/', createRequestRateLimit({ maximum: 180 }), requireAuth, requireRole('citizen'), createRequestRateLimit({ maximum: 30, key: req => String(req.user.id) }), createUploadCapacity(), upload.fields([{ name: 'images', maxCount: 2 }, { name: 'landmarkImage', maxCount: 1 }]), (req, res, next) => reportsController.createReport(req, res, next));
router.patch('/:id/status', requireAuth, requireRole('barangay'), createRequestRateLimit({ maximum: 30, key: req => String(req.user.id) }), createUploadCapacity(),
  async (req, res, next) => {
    try { await require('../../../composition').reportService.findAuthorizedReport(req.params.id, req.user); next(); }
    catch (error) { next(error); }
  }, upload.array('images', 5), (req, res, next) => reportsController.updateReportStatus(req, res, next));
router.get('/:id/history', requireAuth, (req, res, next) => reportsController.getStatusHistory(req, res, next));

module.exports = router;
