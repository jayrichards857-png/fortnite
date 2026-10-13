'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const { q, now } = require('./db');
const { HttpError } = require('./util');

const SESSION_TTL = 14 * 86400;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// scrypt with a per-user salt: memory-hard, built in, no native dependency.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex || '', 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q.run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)', sha(token), userId, now() + SESSION_TTL);
  // Only a hash is stored server-side, so a DB leak doesn't leak live sessions.
  res.cookie('pp_session', token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: SESSION_TTL * 1000, path: '/' });
}
async function destroySession(req, res) {
  const t = readCookie(req, 'pp_session');
  if (t) await q.run('DELETE FROM sessions WHERE token_hash = ?', sha(t));
  res.clearCookie('pp_session', { path: '/' });
}
/** Sign out every session of a user except the one making this request (used after a password change). */
async function destroyOtherSessions(req, userId) {
  const t = readCookie(req, 'pp_session');
  await q.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, t ? sha(t) : '');
}
function readCookie(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

/** Resolve the logged-in user from the session cookie of any Node request (HTTP or WebSocket upgrade). Banned users resolve to null. */
async function userFromRequest(req) {
  const t = readCookie(req, 'pp_session');
  if (!t) return null;
  return await q.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0`, sha(t), now()) || null;
}
/**
 * Attach req.user (or null) to every request. Sessions are sliding: when less than half of the lifetime remains, the session and
 * cookie are renewed, so active people stay signed in and idle sessions expire after SESSION_TTL.
 */
async function loadUser(req, res, next) {
  req.user = await userFromRequest(req);
  if (req.user) {
    const t = readCookie(req, 'pp_session');
    const s = await q.get('SELECT expires_at FROM sessions WHERE token_hash = ?', sha(t));
    if (s && s.expires_at - now() < SESSION_TTL / 2) {
      await q.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now() + SESSION_TTL, sha(t));
      res.cookie('pp_session', t, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: SESSION_TTL * 1000, path: '/' });
    }
  }
  next();
}

const wantsJson = (req) => req.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
function denied(req, res, status, msg, redirect) {
  if (wantsJson(req) || !redirect) return res.status(status).json({ error: msg });
  return res.redirect(redirect);
}
const requireUser = (req, res, next) => (req.user ? next() : denied(req, res, 401, 'Please log in', `/login?next=${encodeURIComponent(req.originalUrl)}`));
const requireSeller = (req, res, next) => {
  if (!req.user) return denied(req, res, 401, 'Please log in', `/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.is_seller) return denied(req, res, 403, 'Seller account required', '/sell');
  next();
};
/** Administrators and moderators. Individual routes still check the narrower role when an operation is admin-only. */
const requireStaff = (req, res, next) => {
  if (!req.user) return denied(req, res, 401, 'Please log in', `/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!(req.user.is_admin || req.user.is_moderator)) return denied(req, res, 403, 'Moderator access required');
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.user) return denied(req, res, 401, 'Please log in', `/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.is_admin) return denied(req, res, 403, 'Administrator access required');
  next();
};

/**
 * CSRF defense for state-changing requests: every mutation is a JSON fetch (or raw upload) carrying a
 * custom header. A cross-site <form> cannot set custom headers or application/json without a CORS
 * preflight, which we never grant; SameSite=Lax cookies add a second layer.
 * Webhooks are exempt (they authenticate by signature).
 */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/webhooks/')) return next();
  if (req.headers['x-requested-with'] !== 'pairplug') return res.status(403).json({ error: 'Missing request header' });
  next();
}

// Request limiter. Two stores with the same behaviour for callers (await it; it throws HttpError 429 when the limit is exceeded):
//   memory  per-process sliding window (local development, one VM).
//   db      fixed-window counters in PostgreSQL shared by every instance (REQUIRED on serverless hosts: Vercel runs many instances, so a
//           per-process map would give each instance its own allowance). Selected automatically on Vercel or with RATE_LIMIT_STORE=db.
const hits = new Map();
async function rateLimit(key, max, windowSec) {
  const limit = max * config.rateLimitScale;
  if (config.sharedRateLimit) {
    const bucket = Math.floor(now() / windowSec), r = await q.get('INSERT INTO rate_limits(key, bucket, hits, expires_at) VALUES(?,?,1,?) ON CONFLICT (key, bucket) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits', String(key).slice(0, 300), bucket, (bucket + 1) * windowSec);
    if (Number(r.hits) > limit) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    return;
  }
  const t = now(), arr = (hits.get(key) || []).filter((x) => x > t - windowSec);
  if (arr.length >= limit) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  arr.push(t); hits.set(key, arr);
}
/** Housekeeping for the shared store: drop counters whose window is long over. */
const purgeRateLimits = async () => (await q.run('DELETE FROM rate_limits WHERE expires_at < ?', now())).changes;

module.exports = { purgeRateLimits, destroyOtherSessions, userFromRequest, DUMMY_HASH, hashPassword, verifyPassword, createSession, destroySession, loadUser, requireUser, requireSeller, requireAdmin, requireStaff, csrfGuard, rateLimit };
