const { accountService } = require('../../../composition');

class BarangayController {
  async listCatalog(req, res, next) {
    try {
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ barangays: await accountService.listBarangays() });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new BarangayController();
