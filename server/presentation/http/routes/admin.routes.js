const express = require('express');
const adminController = require('../controllers/admin.controller');
const reportAnalyticsController = require('../controllers/reportAnalytics.controller');
const { requireAuth, requireRole } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));
const publication = require('../controllers/communityPublication.controller');
const { createRequestRateLimit } = require('../middleware/requestRateLimit.middleware');
const reviewLimit = createRequestRateLimit({ maximum: 40, key: req => String(req.user.id) });
router.get('/community-publications', publication.queue);
router.get('/community-publications/:id', publication.detail);
router.get('/community-publications/:id/media/:order', publication.image);
router.post('/community-publications/:id/assign', reviewLimit, publication.assign);
router.patch('/community-publications/:id', reviewLimit, publication.resolveJurisdiction);
router.post('/community-publications/:id/decision', reviewLimit, publication.decide);
router.get('/analytics/reports', (req, res, next) => reportAnalyticsController.getAnalytics(req, res, next));

router.get('/users', (req, res, next) => adminController.getUsers(req, res, next));
router.get('/admins', (req, res, next) => adminController.listAdministrators(req, res, next));
router.post('/admins', (req, res, next) => adminController.createAdministrator(req, res, next));
router.get('/admin-access-requests', (req, res, next) => adminController.listAdminAccessRequests(req, res, next));
router.post('/admin-access-requests/:id/approve', (req, res, next) => adminController.approveAdminAccessRequest(req, res, next));
router.post('/admin-access-requests/:id/reject', (req, res, next) => adminController.rejectAdminAccessRequest(req, res, next));
router.get('/barangay-users', (req, res, next) => adminController.listOfficials(req, res, next));
router.post('/barangay-users', (req, res, next) => adminController.createBarangayUser(req, res, next));
router.get('/barangay-users/:id', (req, res, next) => adminController.getOfficial(req, res, next));
router.patch('/barangay-users/:id', (req, res, next) => adminController.updateOfficial(req, res, next));
router.patch('/barangay-users/:id/status', (req, res, next) => adminController.setOfficialStatus(req, res, next));
router.post('/barangay-users/:id/password', (req, res, next) => adminController.resetOfficialPassword(req, res, next));
router.get('/audit-logs', (req, res, next) => adminController.getAuditLogs(req, res, next));

module.exports = router;
