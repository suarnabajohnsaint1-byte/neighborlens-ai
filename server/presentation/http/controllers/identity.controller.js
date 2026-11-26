const { citizenIdentityService } = require('../../../composition');

class IdentityController {
  async save(req, res, next) {
    try {
      const identity = await citizenIdentityService.saveOwnIdentity(req.user.id, req.body);
      res.status(200).json({ identity });
    } catch (error) {
      next(error);
    }
  }

  async getMine(req, res, next) {
    try {
      const identity = await citizenIdentityService.getOwnIdentity(req.user.id);
      res.json({ identity });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new IdentityController();
