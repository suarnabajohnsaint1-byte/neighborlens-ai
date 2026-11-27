const jwt = require('jsonwebtoken');
const env = require('../config/env');
const registrationFraud = require('../config/registrationFraud');
const { createHmac, randomUUID } = require('node:crypto');

const DEFAULT_TTL = '8h';
const sessionKey = registrationFraud.isolatedEnrollment
  ? createHmac('sha256', env.JWT_SECRET).update(`neighborlens:local-enrollment:${env.DB_NAME}`).digest()
  : env.JWT_SECRET;

// A JWT is signed, not encrypted, so the payload carries only identity and
// authorization scope.
function issue(safeUser, ttl = DEFAULT_TTL) {
  return jwt.sign(
    {
      id: safeUser.id,
      username: safeUser.username,
      role: safeUser.role,
      barangay: safeUser.barangay,
      tv: Number(safeUser.token_version ?? safeUser.tokenVersion ?? 0)
    },
    sessionKey,
    { expiresIn: ttl, algorithm: 'HS256', issuer: 'neighborlens-api', audience: 'neighborlens-session' }
  );
}

function verify(token) {
  const claims = jwt.verify(token, sessionKey, { algorithms: ['HS256'] });
  if ((claims.iss !== undefined && claims.iss !== 'neighborlens-api') || (claims.aud !== undefined && claims.aud !== 'neighborlens-session')) throw new jwt.JsonWebTokenError('Invalid session purpose.');
  return claims;
}

function assessmentKey() {
  return createHmac('sha256', env.JWT_SECRET).update('neighborlens:report-assessment:v1').digest();
}

function issueAssessment(payload, ttl = 900) {
  return jwt.sign(payload, assessmentKey(), {
    algorithm: 'HS256', audience: 'neighborlens-report-assessment', issuer: 'neighborlens-api',
    expiresIn: ttl, jwtid: randomUUID()
  });
}

function verifyAssessment(token) {
  return jwt.verify(token, assessmentKey(), {
    algorithms: ['HS256'], audience: 'neighborlens-report-assessment', issuer: 'neighborlens-api'
  });
}

module.exports = { issue, verify, DEFAULT_TTL, issueAssessment, verifyAssessment };
