const { createHash } = require("node:crypto");
const { createRequestRateLimit } = require("./requestRateLimit.middleware");

function createAuthRateLimit({
  clock = Date.now,
  windowMs = 60000,
  maximum = 120,
} = {}) {
  const addressLimit = createRequestRateLimit({ clock, windowMs, maximum });
  const accountLimit = createRequestRateLimit({
    clock,
    windowMs,
    maximum: 10,
    key: (req) => {
      const username =
        typeof req.body?.username === "string"
          ? req.body.username.trim().toLowerCase().slice(0, 190)
          : "";
      return (
        (req.socket?.remoteAddress || "unknown") +
        ":" +
        createHash("sha256").update(username).digest("hex")
      );
    },
  });
  return (req, res, next) => {
    addressLimit(req, res, () => accountLimit(req, res, next));
  };
}
module.exports = { createAuthRateLimit };
