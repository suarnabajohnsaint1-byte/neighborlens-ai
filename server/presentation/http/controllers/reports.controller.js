const { reportService, reportAttachmentService } = require('../../../composition');
const { ValidationError } = require('../../../domain/errors');

class ReportsController {
  async getAttachment(req, res, next) {
    try {
      const attachment = await reportAttachmentService.read(req.params.id, req.params.imageId, req.user);
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      if (attachment.url) return res.redirect(302, attachment.url);
      res.sendFile(attachment.path, error => { if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  }

  async getLandmarkAttachment(req, res, next) {
    try {
      const attachment = await reportAttachmentService.readLandmark(req.params.id, req.user);
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      if (attachment.url) return res.redirect(302, attachment.url);
      res.sendFile(attachment.path, error => { if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  }

  async getReport(req, res, next) {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
        throw new ValidationError('Invalid report ID.');
      }
      res.set('Cache-Control', 'no-store');
      res.json(await reportService.getReport(Number(req.params.id), req.user));
    } catch (error) {
      next(error);
    }
  }

  async getReports(req, res, next) {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await reportService.listReports(req.query, req.user));
    } catch (error) {
      next(error);
    }
  }

  async createReport(req, res, next) {
    try {
      const damageFiles = Array.isArray(req.files) ? req.files : (req.files?.images || []);
      const landmarkFiles = Array.isArray(req.files) ? [] : (req.files?.landmarkImage || []);
      res.status(201).json(await reportService.createReport(req.body, damageFiles, req.user, landmarkFiles));
    } catch (error) {
      next(error);
    }
  }

  async updateReportStatus(req, res, next) {
    try {
      res.json(await reportService.updateReportStatus(req.params.id, req.body?.status, req.user, req.body?.note, req.files || [], req.body?.requestKey ?? null));
    } catch (error) {
      next(error);
    }
  }

  async getStatusHistory(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ history: await reportService.getStatusHistory(req.params.id, req.user) });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new ReportsController();
