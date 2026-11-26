const { reportAnalyticsService } = require('../../../composition');

module.exports = {
  async getAnalytics(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store').json(await reportAnalyticsService.getAnalytics(req.query, req.user));
    } catch (error) { next(error); }
  }
};
