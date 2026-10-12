'use strict';
// Moderators and moderation actions.
//   Roles:  user  <  moderator  <  administrator.
//   * Moderators investigate reports and can ban / unban / restrict selling, always with a recorded reason. They cannot create accounts, change roles, or act on staff.
//   * Administrators do everything moderators do, and are the only ones who provision/deactivate moderators or lift bans that an administrator placed.
//   * Moderator capacity is a hard DB-level cap of five (settings.moderator_cap, enforced by triggers) shared by active moderators AND live setup links, so concurrent
//     setups cannot exceed it. Deactivating a moderator frees the slot.
//   * Setup links are individual, single-use and expiring; only SHA-256(token) is stored. Nothing here sends email or holds a shared password.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, cleanLine, clean } = require('./util');
const { hashPassword } = require('./auth');
const { audit } = require('./audit');
const { sha } = require('./accountTokens');
const { notify } = require('./notify');
const F = require('./fraud');
const LEGAL = require('./legal');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TTL_HOURS = 72, MIN_PASSWORD = 12;
const isStaff = (u) => Boolean(u && (u.is_admin || u.is_moderator));

// ------------------------------------------------------------------ moderator slots
async function slots() {
  const cap = Number((await q.get("SELECT value v FROM settings WHERE key = 'moderator_cap'"))?.v ?? 5);
  const active = (await q.get('SELECT COUNT(*) n FROM users WHERE is_moderator = 1')).n;
  const pending = (await q.get('SELECT COUNT(*) n FROM moderator_invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', now())).n;
  return { cap, active, pending, available: Math.max(0, cap - active - pending) };
}
const slotError = () => new HttpError(409, 'All moderator slots are in use (active moderators plus unused setup links). Deactivate a moderator or revoke a setup link first.');
const mapCap = (e) => { if (/moderator (cap reached|slots exhausted)/.test(String(e.message))) throw slotError(); throw e; };

/** actor: an admin user object, or a string label ('cli:root') for the local setup command. Returns the one-time link; only its hash is stored. */
async function invite(actor, { email, note, suggestedName }) {
  const addr = cleanLine(email, 200).toLowerCase();
  if (!EMAIL_RE.test(addr)) throw new HttpError(422, 'Enter a valid email address.');
  if (actor && typeof actor === 'object' && !actor.is_admin) throw new HttpError(403, 'Administrator access required');
  return await tx(async () => {
    if (await q.get('SELECT 1 x FROM users WHERE email = ?', addr)) throw new HttpError(409, 'That email already has an account. Moderator accounts are dedicated: use a new email address.');
    if (await q.get('SELECT 1 x FROM moderator_invites WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', addr, now())) throw new HttpError(409, 'A live setup link for that email already exists. Revoke it first.');
    const raw = 'pp_mod_' + crypto.randomBytes(24).toString('base64url'), expires = now() + TTL_HOURS * 3600;
    let id;
    try { id = (await q.insert('INSERT INTO moderator_invites(token_hash, email, note, suggested_name, created_by, created_via, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)',
      sha(raw), addr, clean(note, 200) || null, cleanLine(suggestedName, 80) || null, typeof actor === 'object' ? actor.id : null, typeof actor === 'object' ? 'admin' : String(actor), now(), expires)); } catch (e) { mapCap(e); }
    await audit(actor, 'moderator_setup_link_created', { type: 'moderator_invite', id, detail: { email: addr, expiresAt: expires } });     // never the token
    return { id: Number(id), expiresAt: expires, link: `${config.publicUrl.replace(/\/$/, '')}/moderator/setup/${raw}` };
  });
}
async function revokeInvite(actor, id) {
  const r = await q.run('UPDATE moderator_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL', now(), Number(id));
  if (r.changes !== 1) throw new HttpError(409, 'That setup link is already used or revoked.');
  await audit(actor, 'moderator_setup_link_revoked', { type: 'moderator_invite', id });
}
/** Raw token -> live row, or null for every failure (unknown, malformed, used, revoked, expired). */
async function lookup(raw, { lock = false } = {}) {
  if (typeof raw !== 'string' || !raw.startsWith('pp_mod_') || raw.length > 80) return null;
  const r = await q.get(`SELECT * FROM moderator_invites WHERE token_hash = ?${lock ? ' FOR UPDATE' : ''}`, sha(raw));       // lock inside the accepting tx
  return r && !r.used_at && !r.revoked_at && r.expires_at > now() ? r : null;
}
/** The invited person creates THEIR OWN account and password. One transaction: account + cap check + consuming the link. */
async function accept(raw, body) {
  const gone = () => new HttpError(400, 'This setup link is invalid, expired or already used. Ask an administrator for a new one.');
  if (!await lookup(raw)) throw gone();
  return await tx(async () => {
    const inv = await lookup(raw, { lock: true }); if (!inv) throw gone();
    const f = {}; const name = cleanLine(body.display_name, 80), pw = String(body.password || '');
    if (name.length < 2) f.display_name = 'Enter your name.';
    if (pw.length < MIN_PASSWORD || pw.length > 200) f.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (body.terms !== true) f.terms = 'Please accept the Terms of Service and Privacy Policy to continue.';
    if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
    if (await q.get('SELECT 1 x FROM users WHERE email = ?', inv.email)) throw gone();
    let uid;
    try { uid = Number((await q.insert('INSERT INTO users(email, password_hash, display_name, is_moderator, created_at, terms_version, terms_accepted_at) VALUES(?,?,?,1,?,?,?)', inv.email, hashPassword(pw), name, now(), LEGAL.VERSION, now()))); } catch (e) { mapCap(e); }
    if ((await q.run('UPDATE moderator_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', now(), uid, inv.id, now())).changes !== 1) throw gone();
    await audit({ id: uid }, 'moderator_account_created', { type: 'user', id: uid, detail: { invite: inv.id } });
    return uid;
  });
}
async function deactivate(actor, userId, reason) {
  const why = reasonOf(reason);
  return await tx(async () => {
    const u = await q.get('SELECT id, is_admin, is_moderator FROM users WHERE id = ?', Number(userId));
    if (!u || !u.is_moderator) throw new HttpError(404, 'Moderator not found');
    if (u.is_admin) throw new HttpError(409, 'Administrators are not managed here.');
    await q.run('UPDATE users SET is_moderator = 0 WHERE id = ?', u.id); await q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    await audit(actor, 'moderator_deactivated', { type: 'user', id: u.id, detail: { reason: why } });
  });
}
const roster = async () => ({
  active: await q.all('SELECT id, display_name, email, created_at, banned FROM users WHERE is_moderator = 1 ORDER BY id'),
  invites: await q.all(`SELECT id, email, note, created_at, expires_at, used_at, revoked_at, created_via FROM moderator_invites ORDER BY id DESC LIMIT 50`),
});

// ------------------------------------------------------------------ moderation actions
function reasonOf(v) {
  const t = clean(v, 1001);
  if (t.length < 5) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'A reason of at least 5 characters is required.' });
  if (t.length > 1000) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'Keep the reason under 1000 characters.' });
  return t;
}
const maskEmail = (e) => { const [l, d] = String(e).split('@'); return `${l.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, l.length - 1)))}@${d}`; };
const role = (u) => (u.is_admin ? 'admin' : 'moderator');

/** Permission policy for acting on another account. Returns the target row or throws. */
async function target(actor, targetId) {
  if (!isStaff(actor)) throw new HttpError(403, 'Moderator access required');
  // FOR UPDATE: two staff acting on the same account at once queue here; the second sees the first's result (e.g. "already banned")
  const t = await q.get('SELECT * FROM users WHERE id = ? FOR UPDATE', Number(targetId));
  if (!t) throw new HttpError(404, 'User not found');
  if (t.id === actor.id) throw new HttpError(400, "You can't take moderation action on your own account.");
  if (!actor.is_admin && (t.is_admin || t.is_moderator)) throw new HttpError(403, 'Moderators cannot act on administrator or moderator accounts.');
  return t;
}
async function record(actor, t, action, reason, caseId) {
  let cid = null;
  if (caseId !== undefined && caseId !== null && caseId !== '') { const c = await q.get('SELECT id FROM cases WHERE id = ?', Number(caseId)); if (!c) throw new HttpError(404, 'Case not found'); cid = c.id; }
  await q.run('INSERT INTO moderation_actions(actor_id, actor_role, target_id, action, reason, case_id, created_at) VALUES(?,?,?,?,?,?,?)', actor.id, role(actor), t.id, action, reason, cid, now());
  if (cid) await q.run("INSERT INTO case_events(case_id, actor_id, actor_role, kind, body, internal, created_at) VALUES(?,?,'admin','action',?,1,?)", cid, actor.id, `${action.replace('_', ' ')} @${t.handle || t.id}: ${reason}`, now());
  await audit(actor, `moderation_${action}`, { type: 'user', id: t.id, detail: { reason, case: cid } });
}

/** Ban: immediate and server-enforced (sessions end; every authenticated route resolves the user as logged out). Orders, evidence and history are kept. */
async function ban(actor, targetId, reason, caseId) {
  const why = reasonOf(reason);
  return await tx(async () => {
    const t = await target(actor, targetId);
    if (t.banned) throw new HttpError(409, 'This account is already banned.');
    await q.run('UPDATE users SET banned = 1, banned_at = ?, banned_by = ?, banned_reason = ? WHERE id = ?', now(), actor.id, why, t.id);
    await q.run('DELETE FROM sessions WHERE user_id = ?', t.id);
    const paused = (await q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE seller_id = ? AND status = 'active'", now(), t.id)).changes;
    const warned = await F.warnPendingBuyers(t.id, 'the account was suspended');
    await record(actor, t, 'ban', why, caseId);
    return { paused, warned };
  });
}
/** Unban. A ban placed by an administrator (or of unknown origin) can only be lifted by an administrator. Listings stay paused until the seller republishes. */
async function unban(actor, targetId, reason, caseId) {
  const why = reasonOf(reason);
  return await tx(async () => {
    const t = await target(actor, targetId);
    if (!t.banned) throw new HttpError(409, 'This account is not banned.');
    if (!actor.is_admin) { const by = t.banned_by && await q.get('SELECT is_admin FROM users WHERE id = ?', t.banned_by); if (!by || by.is_admin) throw new HttpError(403, 'This ban was placed by an administrator (or predates the moderation log), so only an administrator can lift it.'); }
    await q.run('UPDATE users SET banned = 0, banned_at = NULL, banned_by = NULL, banned_reason = NULL WHERE id = ?', t.id);
    await record(actor, t, 'unban', why, caseId);
  });
}
async function restrictSelling(actor, targetId, reason, caseId) {
  const why = reasonOf(reason);
  return await tx(async () => {
    const t = await target(actor, targetId);
    if (t.selling_restricted_at) throw new HttpError(409, 'Selling is already restricted for this seller.');
    await q.run('UPDATE users SET selling_restricted_at = ?, selling_restricted_until = NULL, selling_restricted_reason = ?, selling_restricted_case = ? WHERE id = ?', now(), why, caseId ? Number(caseId) : null, t.id);
    const paused = (await q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE seller_id = ? AND status IN ('active','draft')", now(), t.id)).changes;
    const warned = await F.warnPendingBuyers(t.id, 'selling is paused');
    await notify(t.id, `restrict:${t.id}:${now()}`, 'Selling is paused on your account', `PairPlug is reviewing a report. Your listings are paused and you cannot publish or take new orders for now. You can still log in, handle existing orders and reply to PairPlug. Email ${config.supportEmail} if you have questions.`, '/support');
    await record(actor, t, 'restrict_selling', why, caseId);
    return { paused, warned };
  });
}
/**
 * TEMPORARY selling suspension for a payment-link / checkout-accuracy violation (docs/PAYMENT_LINK_POLICY.md). It is never automatic: a staff member must
 *   * name an existing case about THIS seller (a documented review, not just a URL pattern or one click),
 *   * give a reason of at least 20 characters and explicitly confirm,
 *   * choose 1..MAX_SUSPENSION_DAYS (default 5) days.
 * Effects are the same as "restrict selling" (listings paused, no new orders, store hidden, unpaid buyers warned) plus an end date after which it lifts itself. It does not touch any
 * order's payment state and does not affect money in the seller's Stripe account. The seller can appeal at /dashboard/appeal.
 */
async function suspendSelling(actor, targetId, { days, reason, caseId, confirm } = {}) {
  const max = config.enforcement.maxSuspensionDays, n = /^\d+$/.test(String(days)) ? Number(days) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(422, 'Please fix the highlighted fields.', { days: `Choose a whole number of days from 1 to ${max}. Longer measures are the restrict and ban actions.` });
  const why = clean(reason, 1001); if (why.length < 20) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'A suspension needs a documented reason of at least 20 characters.' });
  if (confirm !== true) throw new HttpError(422, 'Please confirm the suspension.', { confirm: 'Required' });
  return await tx(async () => {
    const t = await target(actor, targetId);
    const c = caseId ? await q.get('SELECT id, subject_user_id FROM cases WHERE id = ?', Number(caseId)) : null;
    if (!c || c.subject_user_id !== t.id) throw new HttpError(422, 'Please fix the highlighted fields.', { caseId: 'Link the case that documents this review (it must be a case about this seller).' });
    if (t.selling_restricted_at) throw new HttpError(409, 'Selling is already restricted for this seller. Lift that first if you want to replace it with a timed suspension.');
    const until = now() + n * 86400;
    await q.run('UPDATE users SET selling_restricted_at = ?, selling_restricted_until = ?, selling_restricted_reason = ?, selling_restricted_case = ? WHERE id = ?', now(), until, why, c.id, t.id);
    const paused = (await q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE seller_id = ? AND status IN ('active','draft')", now(), t.id)).changes;
    const warned = await F.warnPendingBuyers(t.id, 'selling is paused');
    await notify(t.id, `suspend:${c.id}:${now()}`, `Selling is suspended for ${n} day${n === 1 ? '' : 's'}`, `After a review, your listings are paused and you cannot publish or take new orders until ${new Date(until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC. You can still log in and handle existing orders. If you think this is a mistake, appeal from your dashboard or email ${config.supportEmail}.`, '/dashboard/appeal');
    await record(actor, t, 'restrict_selling', `Temporary suspension (${n} day${n === 1 ? '' : 's'}, until ${new Date(until * 1000).toISOString().slice(0, 10)}): ${why}`, c.id);
    await audit(actor, 'seller_suspended_temporarily', { type: 'user', id: t.id, detail: { days: n, until, case: c.id } });
    return { paused, warned, until };
  });
}
/** Lift every timed suspension whose end has passed. Cheap and idempotent: called by the background tick and (throttled) on requests. */
async function liftExpired() {
  const due = await q.all('SELECT id FROM users WHERE selling_restricted_until IS NOT NULL AND selling_restricted_until <= ?', now());
  for (const u of due) await tx(async () => {
    if ((await q.run('UPDATE users SET selling_restricted_at = NULL, selling_restricted_until = NULL, selling_restricted_reason = NULL, selling_restricted_case = NULL WHERE id = ? AND selling_restricted_until IS NOT NULL AND selling_restricted_until <= ?', u.id, now())).changes !== 1) return;
    await notify(u.id, `suspension-ended:${u.id}:${now()}`, 'Your selling suspension has ended', 'Selling is available again. Your paused listings stay paused until you publish them again.', '/dashboard/inventory');
    await audit('system', 'seller_suspension_expired', { type: 'user', id: u.id });
  });
  return due.length;
}
async function liftRestriction(actor, targetId, reason, caseId) {
  const why = reasonOf(reason);
  return await tx(async () => {
    const t = await target(actor, targetId);
    if (!t.selling_restricted_at) throw new HttpError(409, 'Selling is not restricted for this seller.');
    await q.run('UPDATE users SET selling_restricted_at = NULL, selling_restricted_until = NULL, selling_restricted_reason = NULL, selling_restricted_case = NULL WHERE id = ?', t.id);
    await notify(t.id, `unrestrict:${t.id}:${now()}`, 'Selling is available again', 'PairPlug lifted the restriction. Your paused listings stay paused until you publish them again.', '/dashboard/inventory');
    await record(actor, t, 'lift_restriction', why, caseId);
  });
}

// ------------------------------------------------------------------ lookups for the interface (minimal personal data)
async function searchUsers(term, limit = 25) {
  const t = clean(term || '', 80); if (t.length < 2) return [];
  const like = `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  return (await q.all(`SELECT id, display_name, handle, store_name, email, is_admin, is_moderator, is_seller, banned, selling_restricted_at, created_at FROM users
    WHERE display_name ILIKE ? ESCAPE '\\' OR handle ILIKE ? ESCAPE '\\' OR store_name ILIKE ? ESCAPE '\\' OR email ILIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`, like, like, like, like, limit))
    .map(({ email, ...u }) => ({ ...u, emailMasked: maskEmail(email) }));
}
async function userView(id) {
  const u = await q.get('SELECT * FROM users WHERE id = ?', Number(id)); if (!u) return null;
  const by = u.banned_by && await q.get('SELECT display_name, is_admin FROM users WHERE id = ?', u.banned_by);
  return {
    user: { id: u.id, display_name: u.display_name, handle: u.handle, store_name: u.store_name, bio: u.bio, is_admin: u.is_admin, is_moderator: u.is_moderator, is_seller: u.is_seller, banned: u.banned, banned_at: u.banned_at, banned_reason: u.banned_reason,
      bannedBy: by ? { name: by.display_name, admin: by.is_admin } : null, selling_restricted_at: u.selling_restricted_at, selling_restricted_reason: u.selling_restricted_reason, created_at: u.created_at, emailMasked: maskEmail(u.email) },
    listings: await q.all('SELECT id, title, status, price_cents FROM listings WHERE seller_id = ? ORDER BY id DESC LIMIT 50', u.id),
    cases: await q.all("SELECT id, kind, status, category, created_at, CASE WHEN reporter_id = ? THEN 'reporter' ELSE 'subject' END AS role FROM cases WHERE reporter_id = ? OR subject_user_id = ? ORDER BY id DESC LIMIT 50", u.id, u.id, u.id),
    actions: await q.all('SELECT a.*, x.display_name actor FROM moderation_actions a JOIN users x ON x.id = a.actor_id WHERE a.target_id = ? ORDER BY a.id DESC LIMIT 50', u.id),
    orders: await q.get("SELECT COUNT(*) FILTER (WHERE buyer_id = ?) \"asBuyer\", COUNT(*) FILTER (WHERE seller_id = ?) \"asSeller\" FROM orders WHERE payment_mode = 'external' AND (buyer_id = ? OR seller_id = ?)", u.id, u.id, u.id, u.id),
  };
}
const recentActions = async (n = 50) => await q.all('SELECT a.*, x.display_name actor, t.display_name targetName, t.handle FROM moderation_actions a JOIN users x ON x.id = a.actor_id JOIN users t ON t.id = a.target_id ORDER BY a.id DESC LIMIT ?', n);

module.exports = { suspendSelling, liftExpired, isStaff, slots, invite, revokeInvite, lookup, accept, deactivate, roster, ban, unban, restrictSelling, liftRestriction, searchUsers, userView, recentActions, maskEmail, MIN_PASSWORD, TTL_HOURS };
