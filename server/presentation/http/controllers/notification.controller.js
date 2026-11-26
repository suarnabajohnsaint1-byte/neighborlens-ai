const { notificationService, streamTickets } = require('../../../composition');

class NotificationController {
  async getNotifications(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await notificationService.listNotifications(req.user, req.query));
    } catch (error) {
      next(error);
    }
  }

  async getUnreadCount(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await notificationService.getUnreadCount(req.user));
    } catch (error) {
      next(error);
    }
  }

  async markAsRead(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await notificationService.markAsRead(req.params.id, req.user));
    } catch (error) {
      next(error);
    }
  }

  async markAllAsRead(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await notificationService.markAllAsRead(req.user));
    } catch (error) {
      next(error);
    }
  }

  issueStreamTicket(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json(streamTickets.issue({ id: req.user.id, role: req.user.role, tv: req.user.tokenVersion, expiresAt: req.user.sessionExpiresAt }));
  }

  stream(req, res) {
    if (req.sessionExpiresAt <= Date.now()) {
      return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    }
    if (notificationService.getActiveConnections && notificationService.getActiveConnections(req.user.id) >= 5) {
      return res.status(429).json({ error: 'Too many active event streams for this account.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let isClosed = false;

    const writeSafe = (payload) => {
      if (isClosed || res.writableEnded || res.destroyed) return;
      try {
        res.write(payload);
      } catch {
        cleanup();
      }
    };

    writeSafe(': connected\n\n');

    const unsubscribe = notificationService.subscribe(req.user.id, (payload) => {
      if (Date.now() >= req.sessionExpiresAt) return cleanup();
      writeSafe(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload?.event === 'session_revoked') cleanup();
    }, req.user.role, req.user.barangayId);

    const heartbeat = setInterval(() => {
      if (Date.now() >= req.sessionExpiresAt) return cleanup();
      writeSafe(': ping\n\n');
    }, 25000);
    const remaining = req.sessionExpiresAt - Date.now();
    const expiry = remaining <= 2147483647 ? setTimeout(() => cleanup(), remaining) : null;

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      try {
        unsubscribe();
      } catch {}
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {}
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }
}

module.exports = new NotificationController();
