const express = require('express');
const multer = require('multer');
const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { createAuthRateLimit } = require('../middleware/authRateLimit.middleware');
const { citizenEnrollment } = require('../../../composition');
const { ForbiddenError, ValidationError } = require('../../../domain/errors');

const router = express.Router();
const captureUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 2 * 1024 * 1024,
    fields: 1,
    fieldSize: 512,
    parts: 3
  }
}).array('frames', 1);

// Use fixed route names and outcome codes only; requests contain identity evidence.
router.use(['/auth/enrollment/start', '/auth/enrollment/capture'], (req, res, next) => {
  const stage = req.baseUrl.endsWith('/capture') ? 'capture' : 'start';
  res.once('finish', () => console.info('Enrollment decision', {
    stage, status: res.statusCode, code: res.locals.enrollmentCode || 'REQUEST_ENDED',
    ...(res.locals.captureIssue ? { captureIssue: res.locals.captureIssue } : {})
  }));
  next();
});

router.get('/auth/enrollment/options', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ scanTest: citizenEnrollment.isScanTestEnabled() });
});

router.post('/auth/enrollment/start', createAuthRateLimit(), async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    const challenge = await citizenEnrollment.start(req.body?.position);
    res.locals.enrollmentCode = 'CHALLENGE_ISSUED';
    res.json(challenge);
  } catch (error) { next(error); }
});
const enrollmentToken = req => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')?.[1];

router.get('/auth/enrollment/status', createAuthRateLimit(), (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next(new ForbiddenError('Earlier review applications are closed. Start a new live ID scan.', { code: 'REGISTRATION_PROOF_REQUIRED' }));
});

function requireCaptureSession(req, _res, next) {
  const token = enrollmentToken(req);
  try {
    citizenEnrollment.assertCaptureSession(token);
    req.captureToken = token;
    next();
  } catch (error) { next(error); }
}
router.post('/auth/enrollment/capture', createAuthRateLimit(), requireCaptureSession, captureUpload, async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    let position;
    try { position = JSON.parse(req.body?.position); }
    catch { throw new ValidationError('A fresh location is required for ID capture.'); }
    const result = await citizenEnrollment.capture({ token: req.captureToken, position, frames: req.files?.map(file => file.buffer) });
    res.locals.enrollmentCode = result.decision;
    res.json(result);
  } catch (error) { next(error); }
});
router.use(['/auth/enrollment/start', '/auth/enrollment/capture'], (error, _req, res, next) => {
  res.locals.enrollmentCode = /^REGISTRATION_[A-Z_]+$/.test(error.code || '') ? error.code : 'ENROLLMENT_REQUEST_FAILED';
  res.locals.captureIssue = error.captureIssue;
  next(error);
});
router.post('/auth/register', createAuthRateLimit(), (req, res, next) => authController.register(req, res, next));
router.post('/auth/login', createAuthRateLimit(), (req, res, next) => authController.login(req, res, next));
router.post('/auth/:portal(citizen|admin|barangay)/login', createAuthRateLimit(), (req, res, next) => authController.login(req, res, next));
router.post('/auth/admin-access-requests', createAuthRateLimit(), (req, res, next) => authController.requestAdminAccess(req, res, next));
router.post('/auth/logout', requireAuth, (req, res, next) => authController.logout(req, res, next));
router.get('/me', requireAuth, (req, res) => authController.getMe(req, res));
router.get('/auth/me/account', requireAuth, (req, res, next) => authController.getOwnAccount(req, res, next));
router.patch('/auth/me/account', requireAuth, (req, res, next) => authController.updateOwnProfile(req, res, next));
router.post('/auth/me/password', requireAuth, createAuthRateLimit(), (req, res, next) => authController.changeOwnPassword(req, res, next));

module.exports = router;
