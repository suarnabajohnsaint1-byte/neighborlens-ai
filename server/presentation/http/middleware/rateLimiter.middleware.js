const requestLog = new Map();

function notificationRateLimit({ windowMs = 60000, maxRequests = 60 } = {}) {
  return (req, res, next) => {
    const key = req.user?.id ? `user:${req.user.id}` : (req.ip || 'anonymous');
    const now = Date.now();
    const timestamps = requestLog.get(key) || [];
    const validTimestamps = timestamps.filter(t => now - t < windowMs);

    if (validTimestamps.length >= maxRequests) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    validTimestamps.push(now);
    requestLog.set(key, validTimestamps);
    next();
  };
}

function resetNotificationRateLimits() {
  requestLog.clear();
}

module.exports = {
  notificationRateLimit,
  resetNotificationRateLimits
};
