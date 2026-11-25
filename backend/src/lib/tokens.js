// Login tokens (JWT): HS256 only, so "alg: none" is rejected; 1-hour lifetime.
// The token carries only the user id; role and active flag come from the database.

const jwt = require('jsonwebtoken');

const ISSUER = 'onboarding-portal-api';
const AUDIENCE = 'onboarding-portal';
const LIFETIME = '1h';

function getSecret() {
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32) {
    // Fail closed: never sign or accept tokens with a missing or weak secret.
    throw new Error('JWT_SECRET is missing or shorter than 32 characters');
  }
  return secret;
}

function signToken(userId) {
  return jwt.sign({}, getSecret(), {
    algorithm: 'HS256',
    subject: String(userId),
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: LIFETIME,
  });
}

// Returns the user id from a valid token, or null if the token is
// missing, malformed, tampered with, expired or signed differently.
function verifyToken(token) {
  try {
    const payload = jwt.verify(token, getSecret(), {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (err) {
    if (err.message.startsWith('JWT_SECRET')) throw err;
    return null;
  }
}

module.exports = { signToken, verifyToken, LIFETIME };
