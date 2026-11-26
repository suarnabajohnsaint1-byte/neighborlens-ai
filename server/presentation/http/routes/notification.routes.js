const express = require('express');
const notificationController = require('../controllers/notification.controller');
const { requireAuth, requireStreamTicket } = require('../middleware/auth.middleware');
const { streamTickets } = require('../../../composition');
const { notificationRateLimit } = require('../middleware/rateLimiter.middleware');

const router = express.Router();

router.use(notificationRateLimit({ windowMs: 60000, maxRequests: 120 }));

router.get('/', requireAuth, (req, res, next) => notificationController.getNotifications(req, res, next));
router.get('/unread-count', requireAuth, (req, res, next) => notificationController.getUnreadCount(req, res, next));
router.post('/stream-ticket', requireAuth, (req, res, next) => notificationController.issueStreamTicket(req, res, next));
router.get('/stream', requireStreamTicket(streamTickets), (req, res, next) => notificationController.stream(req, res, next));
router.patch('/:id/read', requireAuth, (req, res, next) => notificationController.markAsRead(req, res, next));
router.post('/mark-all-read', requireAuth, (req, res, next) => notificationController.markAllAsRead(req, res, next));

module.exports = router;
