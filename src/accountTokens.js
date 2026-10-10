'use strict';
// Email-verification, email-change and password-reset tokens. Raw tokens exist only in the email/link; the database keeps a SHA-256.
// Single use, expiring, and issuing a new one invalidates older ones. All failure modes return the SAME error (no oracle).
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError } = require('./util');
const email = require('./email');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TTL = { verify_email: 48 * 3600, change_email: 48 * 3600, reset_password: 3600 };
const BAD = () => new HttpError(400, 'This link is invalid or has expired. Request a new one.');

/** Create a token. Throttled: one per minute and five per day per user+purpose. Returns the RAW token (deliver it, never store it). */
function issue(userId, purpose, address) {
  const recent = q.all('SELECT created_at FROM email_tokens WHERE user_id = ? AND purpose = ? AND created_at > ? ORDER BY created_at DESC', userId, purpose, now() - 86400);
  if (recent.length >= 5) throw new HttpError(429, 'Too many requests. Try again tomorrow.');
  if (recent.length && now() - recent[0].created_at < 60) throw new HttpError(429, 'Please wait a minute before requesting another email.');
  q.run('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', now(), userId, purpose); // older links die
  const raw = crypto.randomBytes(32).toString('base64url');
  q.run('INSERT INTO email_tokens(token_hash, user_id, purpose, email, expires_at, created_at) VALUES(?,?,?,?,?,?)', sha(raw), userId, purpose, address, now() + TTL[purpose], now());
  return raw;
}

function consume(raw, purpose) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) throw BAD();
  const row = q.get('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?', sha(raw), purpose);
  if (!row || row.used_at || row.expires_at < now()) throw BAD();
  const r = q.run('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', now(), row.id);
  if (r.changes !== 1) throw BAD();                                   // lost a race with another use of the same token
  return row;
}

const link = (path, token) => `${config.publicUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

function sendVerification(user) {
  const token = issue(user.id, 'verify_email', user.email);
  return email.send({ to: user.email, kind: 'verify_email', subject: 'Verify your PairPlug email', dedupeKey: `verify:${sha(token).slice(0, 16)}`,
    text: `Hi ${user.display_name},\n\nConfirm your email address for PairPlug:\n${link('/verify-email', token)}\n\nThis link works once and expires in 48 hours. If you didn't ask for this, ignore this email.\n` });
}
function confirmVerification(raw) {
  return tx(() => {
    const t = consume(raw, 'verify_email');
    const u = q.get('SELECT id, email FROM users WHERE id = ?', t.user_id);
    if (!u || u.email.toLowerCase() !== t.email.toLowerCase()) throw BAD();    // the email changed since the link was sent
    q.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', now(), u.id);
    return u.id;
  });
}

function requestEmailChange(user, newEmail) {
  if (q.get('SELECT 1 x FROM users WHERE email = ?', newEmail)) throw new HttpError(422, 'Please fix the highlighted fields.', { email: 'That email is already in use.' });
  const token = issue(user.id, 'change_email', newEmail);
  return email.send({ to: newEmail, kind: 'change_email', subject: 'Confirm your new PairPlug email', dedupeKey: `change:${sha(token).slice(0, 16)}`,
    text: `Confirm this as your new PairPlug email:\n${link('/confirm-email-change', token)}\n\nThis link works once and expires in 48 hours. Your current email stays active until you confirm.\n` });
}
function confirmEmailChange(raw) {
  return tx(() => {
    const t = consume(raw, 'change_email');
    if (q.get('SELECT 1 x FROM users WHERE email = ? AND id <> ?', t.email, t.user_id)) throw new HttpError(409, 'That email is now used by another account.');
    q.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', t.email, now(), t.user_id);   // proof of control of the NEW address
    return t.user_id;
  });
}

function sendPasswordReset(user) {
  const token = issue(user.id, 'reset_password', user.email);
  return email.send({ to: user.email, kind: 'reset_password', subject: 'Reset your PairPlug password', dedupeKey: `reset:${sha(token).slice(0, 16)}`,
    text: `Reset your PairPlug password:\n${link('/reset-password', token)}\n\nThis link works once and expires in 1 hour. If you didn't ask for this, ignore this email.\n` });
}

module.exports = { issue, consume, sendVerification, confirmVerification, requestEmailChange, confirmEmailChange, sendPasswordReset, sha };
