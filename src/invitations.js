'use strict';
// Seller invitations (single-use links) and seller-account helpers. There is no limit on the number of sellers.
//   * An invitation is a single-use, expiring, revocable capability bound to ONE email. Only its SHA-256 is stored.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, cleanLine, clean } = require('./util');
const { hashPassword } = require('./auth');
const { audit } = require('./audit');
const { sha } = require('./accountTokens');
const LEGAL = require('./legal');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SELLER_COUNTRIES = () => config.naCountries;

/** Seller accounts and pending seller invitations. There is NO limit on the number of sellers. */
async function slots() {
  const used = (await q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1')).n;
  const live = (await q.get("SELECT COUNT(*) n FROM invitations WHERE kind = 'seller' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", now())).n;
  return { used, liveInvites: live };
}

async function create(admin, { kind, email, note, suggestedName }) {
  const addr = cleanLine(email, 200).toLowerCase();
  if (!['buyer', 'seller'].includes(kind)) throw new HttpError(422, 'Choose buyer or seller.');
  if (!EMAIL_RE.test(addr)) throw new HttpError(422, 'Enter a valid email address.');
  return await tx(async () => {
    const existing = await q.get('SELECT id, is_seller FROM users WHERE email = ?', addr);
    if (kind === 'buyer' && existing) throw new HttpError(409, 'That email already has an account.');
    if (kind === 'seller' && existing && existing.is_seller) throw new HttpError(409, 'That account is already a seller.');
    await q.run('UPDATE invitations SET revoked_at = ? WHERE email = ? AND kind = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at <= ?', now(), addr, kind, now()); // retire expired
    if (await q.get('SELECT 1 x FROM invitations WHERE email = ? AND kind = ? AND used_at IS NULL AND revoked_at IS NULL', addr, kind)) throw new HttpError(409, 'A live invitation for that email already exists. Revoke it first.');
    const raw = 'pp_inv_' + crypto.randomBytes(24).toString('base64url');
    const expires = now() + config.inviteTtlHours * 3600;
    const r = await q.insert('INSERT INTO invitations(token_hash, kind, email, note, suggested_name, created_by, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)', sha(raw), kind, addr, clean(note, 200) || null, cleanLine(suggestedName, 80) || null, admin.id, now(), expires);
    await audit(admin, 'invitation_created', { type: 'invitation', id: r, detail: { kind, email: addr, expiresAt: expires } });
    return { id: r, token: raw, expiresAt: expires, link: `${config.publicUrl.replace(/\/$/, '')}/invite/${raw}` };
  });
}

async function revoke(admin, id) {
  const r = await q.run('UPDATE invitations SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL', now(), Number(id));
  if (r.changes !== 1) throw new HttpError(409, 'That invitation is already used or revoked.');
  await audit(admin, 'invitation_revoked', { type: 'invitation', id });
}

/** Look an invitation up by raw token. Every failure returns null so callers can show one generic message. */
async function lookup(raw, { lock = false } = {}) {
  if (typeof raw !== 'string' || !raw.startsWith('pp_inv_') || raw.length > 80) return null;
  // lock=true (inside the accepting transaction): a concurrent accept of the same link waits, then finds it already used
  const inv = await q.get(`SELECT * FROM invitations WHERE token_hash = ?${lock ? ' FOR UPDATE' : ''}`, sha(raw));
  return inv && !inv.used_at && !inv.revoked_at && inv.expires_at > now() ? inv : null;
}

async function validateStore(b) {
  const f = {};
  const store = cleanLine(b.store_name, 60), handle = String(b.handle || '').trim(), country = String(b.country || ''), region = cleanLine(b.region, 60), city = cleanLine(b.city, 60);
  if (!store) f.store_name = 'Enter a store name.';
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(handle)) f.handle = '3–30 letters, numbers, - or _.';
  else if (await q.get('SELECT 1 x FROM users WHERE handle = ?', handle)) f.handle = 'That URL is taken.';
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
async function accept(raw, body, currentUser) {
  const gone = () => new HttpError(400, 'This invitation is invalid, expired or already used.');
  const early = await lookup(raw); if (!early) throw gone();
  return await tx(async () => {
    const inv = await lookup(raw, { lock: true }); if (!inv) throw gone();
    let user = await q.get('SELECT * FROM users WHERE email = ?', inv.email);
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
    if (!user || !LEGAL.accepted(user)) { if (body.terms !== true) throw new HttpError(422, 'Please fix the highlighted fields.', { terms: 'Please accept the Terms of Service and Privacy Policy to continue.' }); }
    const store = inv.kind === 'seller' ? await validateStore(body) : null;
    if (!user) {
      const r = await q.insert('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', inv.email, hashPassword(String(body.password)), cleanLine(body.display_name, 80), now());
      user = await q.get('SELECT * FROM users WHERE id = ?', r);
    }
    if (!LEGAL.accepted(user)) { await LEGAL.recordAcceptance(user.id); }       // explicit tick on this very form; never inferred
    if (store) await q.run('UPDATE users SET is_seller=1, store_name=?, handle=?, country=?, region=?, city=?, bio=? WHERE id=?', store.store, store.handle, store.country, store.region, store.city, store.bio, user.id);
    const mark = await q.run('UPDATE invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', now(), user.id, inv.id, now());
    if (mark.changes !== 1) throw gone();                                        // someone else consumed the token first
    await audit(user, 'invitation_accepted', { type: 'invitation', id: inv.id, detail: { kind: inv.kind } });
    return user.id;
  });
}

/** Direct (legacy) seller onboarding for the already-logged-in user. Only reachable when SELLER_ONBOARDING=open (development/test). */
async function onboardOpen(user, body) {
  const s = await validateStore(body);
  return await tx(async () => {
    await q.run('UPDATE users SET is_seller=1, store_name=?, handle=?, country=?, region=?, city=?, bio=? WHERE id=? AND is_seller=0', s.store, s.handle, s.country, s.region, s.city, s.bio, user.id); 
    await audit(user, 'seller_onboarded_open', { type: 'user', id: user.id });
  });
}

/** Audited admin recovery: free a slot by demoting a seller who has no open orders. Their data and history are preserved. */
async function releaseSellerSlot(admin, userId) {
  return await tx(async () => {
    const u = await q.get('SELECT * FROM users WHERE id = ? AND is_seller = 1', Number(userId));
    if (!u) throw new HttpError(404, 'Seller not found');
    const open = (await q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND status IN ('pending_payment','paid','shipped')", u.id)).n;
    if (open) throw new HttpError(409, `This seller still has ${open} open order(s). Resolve them first.`);
    await q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE seller_id = ? AND status IN ('active','draft')", now(), u.id);
    await q.run('UPDATE users SET is_seller = 0 WHERE id = ?', u.id);
    await audit(admin, 'seller_slot_released', { type: 'user', id: u.id, detail: { handle: u.handle } });
  });
}

module.exports = { slots, create, revoke, lookup, accept, onboardOpen, releaseSellerSlot, validateStore };
