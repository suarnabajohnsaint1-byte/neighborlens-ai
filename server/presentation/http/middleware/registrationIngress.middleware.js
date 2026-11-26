const express = require("express");
const { createRequestRateLimit } = require("./requestRateLimit.middleware");

function createRegistrationIngress(rateOptions = {}) {
  const limit = createRequestRateLimit(rateOptions);
  const parse = express.json({ limit: "8kb", inflate: false });
  return (req, res, next) => {
    if (req.method !== "POST") return next();
    limit(req, res, () => {
      const length = Number(req.get("content-length") || 0);
      if (length > 8192) {
        return res.status(413).json({ error: "Request body exceeds 8 KB." });
      }
      if (
        (length > 0 || req.get("transfer-encoding")) &&
        !req.is("application/json")
      ) {
        return res
          .status(415)
          .json({ error: "Only JSON requests are supported." });
      }
      parse(req, res, (error) => {
        if (!error) return next();
        const status =
          error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
        return res.status(status).json({
          error:
            status === 413
              ? "Request body exceeds 8 KB."
              : status === 415
                ? "Unsupported request encoding."
                : "Invalid JSON request.",
        });
      });
    });
  };
}

module.exports = { createRegistrationIngress };
