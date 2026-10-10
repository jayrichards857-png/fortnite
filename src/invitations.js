'use strict';
// Invite-only onboarding + the hard seller cap.
//   * An invitation is a single-use, expiring, revocable capability bound to ONE email. Only its SHA-256 is stored.
//   * The seller cap is enforced by SQLite triggers (see migration 4), so a race, a retry or a bug in this file cannot create
//     a fourth seller. This module adds friendly errors and the audited admin operations around it.
//   * Slots: every account with is_seller = 1 occupies one slot, including suspended ones. A slot is only freed by the audited
//     admin action releaseSellerSlot(). Reactivating a suspended seller never needs a new slot.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, cleanLine, clean } = require('./util');
const { hashPassword } = require('./auth');
const { audit } = require('./audit');
const { sha } = require('./accountTokens');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SELLER_COUNTRIES = () => config.naCountries;

function slots() {
  const cap = Number(q.get("SELECT value v FROM settings WHERE key = 'seller_cap'")?.v ?? 3);
  const used = q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1').n;
  const live = q.get("SELECT COUNT(*) n FROM invitations WHERE kind = 'seller' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", now()).n;
  return { cap, used, liveInvites: live, available: Math.max(0, cap - used - live), over: used > cap };
}
const capError = () => new HttpError(409, 'All seller slots are in use during the private beta.');
function mapCap(e) { if (/seller cap reached/.test(String(e.message))) throw capError(); throw e; }

function create(admin, { kind, email, note }) {
  const addr = cleanLine(email, 200).toLowerCase();
  if (!['buyer', 'seller'].includes(kind)) throw new HttpError(422, 'Choose buyer or seller.');
  if (!EMAIL_RE.test(addr)) throw new HttpError(422, 'Enter a valid email address.');
  return tx(() => {
    const existing = q.get('SELECT id, is_seller FROM users WHERE email = ?', addr);
    if (kind === 'buyer' && existing) throw new HttpError(409, 'That email already has an account.');
    if (kind === 'seller' && existing && existing.is_seller) throw new HttpError(409, 'That account is already a seller.');
    if (kind === 'seller' && slots().available <= 0) throw capError();
    q.run('UPDATE invitations SET revoked_at = ? WHERE email = ? AND kind = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at <= ?', now(), addr, kind, now()); // retire expired
    if (q.get('SELECT 1 x FROM invitations WHERE email = ? AND kind = ? AND used_at IS NULL AND revoked_at IS NULL', addr, kind)) throw new HttpError(409, 'A live invitation for that email already exists. Revoke it first.');
    const raw = 'pp_inv_' + crypto.randomBytes(24).toString('base64url');
    const expires = now() + config.inviteTtlHours * 3600;
    const r = q.run('INSERT INTO invitations(token_hash, kind, email, note, created_by, created_at, expires_at) VALUES(?,?,?,?,?,?,?)', sha(raw), kind, addr, clean(note, 200) || null, admin.id, now(), expires);
    audit(admin, 'invitation_created', { type: 'invitation', id: r.lastInsertRowid, detail: { kind, email: addr, expiresAt: expires } });
    return { id: Number(r.lastInsertRowid), token: raw, expiresAt: expires, link: `${config.publicUrl.replace(/\/$/, '')}/invite/${raw}` };
  });
}

function revoke(admin, id) {
  const r = q.run('UPDATE invitations SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL', now(), Number(id));
  if (r.changes !== 1) throw new HttpError(409, 'That invitation is already used or revoked.');
  audit(admin, 'invitation_revoked', { type: 'invitation', id });
}

/** Look an invitation up by raw token. Every failure returns null so callers can show one generic message. */
function lookup(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('pp_inv_') || raw.length > 80) return null;
  const inv = q.get('SELECT * FROM invitations WHERE token_hash = ?', sha(raw));
  return inv && !inv.used_at && !inv.revoked_at && inv.expires_at > now() ? inv : null;
}

function validateStore(b) {
  const f = {};
  const store = cleanLine(b.store_name, 60), handle = String(b.handle || '').trim(), country = String(b.country || ''), region = cleanLine(b.region, 60), city = cleanLine(b.city, 60);
  if (!store) f.store_name = 'Enter a store name.';
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(handle)) f.handle = '3–30 letters, numbers, - or _.';
  else if (q.get('SELECT 1 x FROM users WHERE handle = ?', handle)) f.handle = 'That URL is taken.';
  if (!SELLER_COUNTRIES().includes(country)) f.country = 'Sellers must ship from the US, Canada or Mexico.';
  if (!region) f.region = 'Required'; if (!city) f.city = 'Required';
  if (!b.agree) f.agree = 'Please accept to continue.';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  return { store, handle, country, region, city, bio: clean(b.bio, 500) || null };
}

/**
 * Accept an invitation: create the account (or upgrade the logged-in account whose email matches) and, for seller invitations,
 * take a seller slot — all in ONE transaction together with consuming the token, so partial results are impossible.
 */
function accept(raw, body, currentUser) {
  const gone = () => new HttpError(400, 'This invitation is invalid, expired or already used.');
  const early = lookup(raw); if (!early) throw gone();
  return tx(() => {
    const inv = lookup(raw); if (!inv) throw gone();
    let user = q.get('SELECT * FROM users WHERE email = ?', inv.email);
    const fields = {};
    if (inv.kind === 'buyer' && user) throw gone();
    if (user) {
      if (!currentUser || currentUser.id !== user.id) throw new HttpError(401, 'Log in with the invited account to accept this invitation.');
      if (user.is_seller) throw new HttpError(409, 'That account is already a seller.');
    } else {
      const name = cleanLine(body.display_name, 80), pw = String(body.password || '');
      if (name.length < 2) fields.display_name = 'Enter your name.';
      if (pw.length < 8 || pw.length > 200) fields.password = 'Use at least 8 characters.';
      if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the highlighted fields.', fields);
    }
    const store = inv.kind === 'seller' ? validateStore(body) : null;
    try {
      if (!user) {
        const r = q.run('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', inv.email, hashPassword(String(body.password)), cleanLine(body.display_name, 80), now());
        user = q.get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
      }
      if (store) q.run('UPDATE users SET is_seller=1, store_name=?, handle=?, country=?, region=?, city=?, bio=? WHERE id=?', store.store, store.handle, store.country, store.region, store.city, store.bio, user.id);
    } catch (e) { mapCap(e); }
    const mark = q.run('UPDATE invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', now(), user.id, inv.id, now());
    if (mark.changes !== 1) throw gone();                                        // someone else consumed the token first
    audit(user, 'invitation_accepted', { type: 'invitation', id: inv.id, detail: { kind: inv.kind } });
    return user.id;
  });
}

/** Direct (legacy) seller onboarding for the already-logged-in user. Only reachable when SELLER_ONBOARDING=open (development/test). */
function onboardOpen(user, body) {
  const s = validateStore(body);
  return tx(() => {
    try { q.run('UPDATE users SET is_seller=1, store_name=?, handle=?, country=?, region=?, city=?, bio=? WHERE id=? AND is_seller=0', s.store, s.handle, s.country, s.region, s.city, s.bio, user.id); } catch (e) { mapCap(e); }
    audit(user, 'seller_onboarded_open', { type: 'user', id: user.id });
  });
}

/** Audited admin recovery: free a slot by demoting a seller who has no open orders. Their data and history are preserved. */
function releaseSellerSlot(admin, userId) {
  return tx(() => {
    const u = q.get('SELECT * FROM users WHERE id = ? AND is_seller = 1', Number(userId));
    if (!u) throw new HttpError(404, 'Seller not found');
    const open = q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND status IN ('pending_payment','paid','shipped')", u.id).n;
    if (open) throw new HttpError(409, `This seller still has ${open} open order(s). Resolve them first.`);
    q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE seller_id = ? AND status IN ('active','draft')", now(), u.id);
    q.run('UPDATE users SET is_seller = 0 WHERE id = ?', u.id);
    audit(admin, 'seller_slot_released', { type: 'user', id: u.id, detail: { handle: u.handle } });
  });
}

module.exports = { slots, create, revoke, lookup, accept, onboardOpen, releaseSellerSlot, validateStore, mapCap };
