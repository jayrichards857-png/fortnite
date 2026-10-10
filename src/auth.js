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

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)', sha(token), userId, now() + SESSION_TTL);
  // Only a hash is stored server-side, so a DB leak doesn't leak live sessions.
  res.cookie('pp_session', token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: SESSION_TTL * 1000, path: '/' });
}
function destroySession(req, res) {
  const t = readCookie(req, 'pp_session');
  if (t) q.run('DELETE FROM sessions WHERE token_hash = ?', sha(t));
  res.clearCookie('pp_session', { path: '/' });
}
function readCookie(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

/** Attach req.user (or null) on every request. Banned users are treated as logged out. */
function loadUser(req, res, next) {
  req.user = null;
  const t = readCookie(req, 'pp_session');
  if (t) {
    const u = q.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0`, sha(t), now());
    if (u) req.user = u;
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

// Tiny in-memory sliding-window limiter (per key). Enough to blunt password guessing on one node.
const hits = new Map();
function rateLimit(key, max, windowSec) {
  const t = now(), arr = (hits.get(key) || []).filter((x) => x > t - windowSec);
  if (arr.length >= max * config.rateLimitScale) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  arr.push(t); hits.set(key, arr);
}

module.exports = { DUMMY_HASH, hashPassword, verifyPassword, createSession, destroySession, loadUser, requireUser, requireSeller, requireAdmin, csrfGuard, rateLimit };
