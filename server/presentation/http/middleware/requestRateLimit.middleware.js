function createRequestRateLimit({
  clock = Date.now,
  windowMs = 60000,
  maximum = 120,
  capacity = 10000,
  key = (req) => req.socket?.remoteAddress || "unknown",
} = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const now = clock();
    for (const [id, entry] of entries) {
      if (entry.until > now) break;
      entries.delete(id);
    }
    const id = key(req);
    const entry = entries.get(id);
    if (entry?.count >= maximum || (!entry && entries.size >= capacity)) {
      res.set(
        "Retry-After",
        String(
          Math.max(
            1,
            Math.ceil(((entry?.until || now + windowMs) - now) / 1000),
          ),
        ),
      );
      res.set("Cache-Control", "no-store");
      return res
        .status(429)
        .json({ error: "Too many requests. Please wait and retry." });
    }
    if (entry) entry.count++;
    else entries.set(id, { count: 1, until: now + windowMs });
    next();
  };
}

module.exports = { createRequestRateLimit };
