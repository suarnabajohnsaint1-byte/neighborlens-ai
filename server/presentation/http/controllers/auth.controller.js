const { authService, accountService } = require('../../../composition');

class AuthController {
  async register(req, res, next) {
    try {
      res.status(201).json(await authService.registerCitizen(req.body));
    } catch (error) {
      next(error);
    }
  }

  async login(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await authService.login(req.body?.username, req.body?.password, req.params.portal || 'citizen'));
    } catch (error) {
      next(error);
    }
  }

  async requestAdminAccess(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.status(202).json(await accountService.submitAdminAccessRequest(req.body));
    } catch (error) {
      next(error);
    }
  }

  async logout(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await accountService.logout(req.user));
    } catch (error) {
      next(error);
    }
  }

  async getOwnAccount(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await accountService.getOwnAccount(req.user));
    } catch (error) {
      next(error);
    }
  }

  async updateOwnProfile(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await accountService.updateOwnProfile(req.user, req.body));
    } catch (error) {
      next(error);
    }
  }

  async changeOwnPassword(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await accountService.changeOwnPassword(req.user, req.body));
    } catch (error) {
      next(error);
    }
  }

  getMe(req, res) {
    const { id, username, role, barangay, barangayId, accountStatus, identityStatus } = req.user;
    res.set('Cache-Control', 'no-store');
    res.json({ user: { id, username, role, barangay, barangay_id: barangayId, accountStatus, identityStatus } });
  }
}

module.exports = new AuthController();
