function createUploadCapacity(maximum = 4) {
  let active = 0;
  return (req, res, next) => {
    if (active >= maximum) return res.set('Retry-After', '2').status(429).json({ error: 'Image processing is busy. Please retry.' });
    active++;
    function release() { active--; res.off('finish', release); res.off('close', release); }
    res.once('finish', release); res.once('close', release);
    next();
  };
}
module.exports = { createUploadCapacity };
