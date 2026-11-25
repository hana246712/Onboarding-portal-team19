// POST /api/auth/login: 200 with a token, 400 bad input, 401 wrong email or
// password (same message for both), 429 too many failed attempts.
// Failed attempts live in login_attempts because serverless memory is not shared.
// The audit log stores the user id, never the typed email.

const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { signToken } = require('../lib/tokens');
const { recordAudit } = require('../lib/audit');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MINUTES = 15; // failures older than this are forgotten
const LOCK_MINUTES = 15;

// Compared against when the email does not exist, so a wrong email takes
// about as long as a wrong password (no timing hint about valid emails).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 12);

function readCredentials(body) {
  if (!body || typeof body !== 'object') return null;
  const { email, password } = body;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || cleanEmail.length > 254 || !cleanEmail.includes('@')) return null;
  if (!password || password.length > 200) return null;
  return { email: cleanEmail, password };
}

async function isLocked(email, ip) {
  const { rows } = await pool.db().query(
    `SELECT EXTRACT(EPOCH FROM (locked_until - now()))::int AS seconds_left
       FROM login_attempts
      WHERE email = $1 AND ip_address = $2 AND locked_until > now()`,
    [email, ip]
  );
  return rows[0] ? rows[0].seconds_left : 0;
}

// Adds one failure and locks the email+IP pair once the limit is reached.
async function recordFailure(email, ip) {
  const { rows } = await pool.db().query(
    `WITH next AS (
       SELECT CASE
                WHEN la.email IS NULL THEN 1
                WHEN la.last_failed_at < now() - make_interval(mins => $4) THEN 1
                ELSE la.failed_count + 1
              END AS count
         FROM (SELECT 1) AS one
         LEFT JOIN login_attempts la ON la.email = $1 AND la.ip_address = $2
     )
     INSERT INTO login_attempts (email, ip_address, failed_count, last_failed_at, locked_until)
     SELECT $1, $2, next.count, now(),
            CASE WHEN next.count >= $3 THEN now() + make_interval(mins => $5) ELSE NULL END
       FROM next
     ON CONFLICT (email, ip_address) DO UPDATE
        SET failed_count   = EXCLUDED.failed_count,
            last_failed_at = EXCLUDED.last_failed_at,
            locked_until   = EXCLUDED.locked_until
     RETURNING failed_count, locked_until`,
    [email, ip, MAX_FAILED_ATTEMPTS, WINDOW_MINUTES, LOCK_MINUTES]
  );
  return rows[0];
}

router.post('/auth/login', async (req, res, next) => {
  try {
    const credentials = readCredentials(req.body);
    if (!credentials) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const { email, password } = credentials;
    const ip = req.ip || 'unknown';

    const secondsLeft = await isLocked(email, ip);
    if (secondsLeft > 0) {
      const { rows: known } = await pool.db().query('SELECT id FROM users WHERE email = $1', [email]);
      const userId = known[0] ? known[0].id : null;
      await recordAudit({ actorId: userId, action: 'login_locked', entity: 'user', entityId: userId, result: 'denied', ip });
      res.set('Retry-After', String(secondsLeft));
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }

    const { rows } = await pool.db().query(
      'SELECT id, name, role, active, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !passwordOk || !user.active) {
      const attempt = await recordFailure(email, ip);
      await recordAudit({
        actorId: user ? user.id : null,
        action: user && passwordOk && !user.active ? 'login_inactive' : 'login_failed',
        entity: 'user',
        entityId: user ? user.id : null,
        result: 'denied',
        ip,
      });
      if (attempt && attempt.locked_until) {
        res.set('Retry-After', String(LOCK_MINUTES * 60));
        return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Success: clear the failure counter for this email + IP.
    await pool.db().query('DELETE FROM login_attempts WHERE email = $1 AND ip_address = $2', [email, ip]);
    await recordAudit({ actorId: user.id, action: 'login', entity: 'user', entityId: String(user.id), result: 'allowed', ip });

    return res.json({
      token: signToken(user.id),
      user: { id: user.id, name: user.name, role: user.role },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
