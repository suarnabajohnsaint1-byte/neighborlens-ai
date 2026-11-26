const auditService = require('../../../application/use-cases/audit.service');
const { authService, accountService } = require('../../../composition');

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  return res;
}

class AdminController {
  async getUsers(req, res, next) {
    try {
      noStore(res).json({ users: await authService.getAllUsers() });
    } catch (error) {
      next(error);
    }
  }

  async listAdministrators(req, res, next) {
    try {
      noStore(res).json(await accountService.listAdministrators(req.user));
    } catch (error) {
      next(error);
    }
  }

  async createAdministrator(req, res, next) {
    try {
      noStore(res).status(201).json(await accountService.createAdministrator(req.body, req.user));
    } catch (error) {
      next(error);
    }
  }

  async listAdminAccessRequests(req, res, next) {
    try {
      noStore(res).json(await accountService.listAdminAccessRequests(req.user));
    } catch (error) {
      next(error);
    }
  }

  async approveAdminAccessRequest(req, res, next) {
    try {
      noStore(res).json(await accountService.decideAdminAccessRequest(req.params.id, 'approve', req.user));
    } catch (error) {
      next(error);
    }
  }

  async rejectAdminAccessRequest(req, res, next) {
    try {
      noStore(res).json(await accountService.decideAdminAccessRequest(req.params.id, 'reject', req.user));
    } catch (error) {
      next(error);
    }
  }

  async listOfficials(req, res, next) {
    try {
      noStore(res).json({ users: await accountService.listOfficials() });
    } catch (error) {
      next(error);
    }
  }

  async getOfficial(req, res, next) {
    try {
      noStore(res).json({ user: await accountService.getOfficial(req.params.id) });
    } catch (error) {
      next(error);
    }
  }

  async createBarangayUser(req, res, next) {
    try {
      noStore(res).status(201).json(await accountService.createOfficial(req.body, req.user));
    } catch (error) {
      next(error);
    }
  }

  async updateOfficial(req, res, next) {
    try {
      noStore(res).json(await accountService.updateOfficial(req.params.id, req.body, req.user));
    } catch (error) {
      next(error);
    }
  }

  async setOfficialStatus(req, res, next) {
    try {
      noStore(res).json(await accountService.setOfficialStatus(req.params.id, req.body, req.user));
    } catch (error) {
      next(error);
    }
  }

  async resetOfficialPassword(req, res, next) {
    try {
      noStore(res).json(await accountService.resetOfficialPassword(req.params.id, req.body, req.user));
    } catch (error) {
      next(error);
    }
  }

  async getAuditLogs(req, res, next) {
    try {
      noStore(res).json(await auditService.listLogs(req.query));
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AdminController();
