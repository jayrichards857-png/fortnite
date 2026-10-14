'use strict';
// Open self-service selling. Anyone with an account (sign-in required: no anonymous listing or buying) starts selling immediately with their
// store details. There is NO limit on the number of sellers, no queue and no approval step.
//   * apply() sets is_seller on the server from the authenticated session; the client never sends a role.
//   * approve()/reject() remain only to close out requests that were filed before selling became immediate (admin-only).
//   * No fee, subscription or payment is involved.
const { q, tx, now, lockKey } = require('./db');
const { HttpError, clean } = require('./util');
const auth = require('./auth');
const { audit } = require('./audit');
const inv = require('./invitations');
const { notify } = require('./notify');
const LEGAL = require('./legal');

const needAdmin = (a) => { if (!(a && a.is_admin)) throw new HttpError(403, 'Administrator access required'); };

/**
 * Start selling NOW. Any signed-in, non-suspended account becomes a seller immediately: no request queue, no approval, no invitation, no limit.
 * The server decides: the caller supplies only store details (never a role). A legacy waiting request from this user is closed as approved.
 */
async function apply(user, body = {}) {
  await auth.rateLimit(`seller-apply:${user.id}`, 10, 3600);
  if (user.is_seller) throw new HttpError(409, 'You already have a store.');
  const s = await inv.validateStore(body);                                   // store eligibility: handle, North America, terms ticked
  await tx(async () => {
    await lockKey('seller-apply', user.id);
    const u = await q.get('SELECT is_seller, banned FROM users WHERE id = ? FOR UPDATE', user.id);
    if (!u) throw new HttpError(401, 'Please log in');
    if (u.banned) throw new HttpError(403, 'This account cannot open a store.');
    if (u.is_seller) throw new HttpError(409, 'You already have a store.');
    try { await q.run('UPDATE users SET is_seller=1, store_name=?, handle=?, country=?, region=?, city=?, bio=? WHERE id=?', s.store, s.handle, s.country, s.region, s.city, s.bio, user.id); }
    catch (e) { if (/users_handle|handle/i.test(String(e.message)) && /unique|duplicate/i.test(String(e.message))) throw new HttpError(422, 'Please fix the highlighted fields.', { handle: 'That URL is taken.' }); throw e; }
    await q.run("UPDATE seller_applications SET status = 'approved', decision_note = 'Automatic: selling is open to every account', decided_at = ? WHERE user_id = ? AND status = 'pending'", now(), user.id);
    await audit(user, 'seller_started', { type: 'user', id: user.id });
  });
  if (!LEGAL.accepted(await q.get('SELECT terms_version, terms_accepted_at FROM users WHERE id = ?', user.id))) await LEGAL.recordAcceptance(user.id);   // the agree box on this form is the explicit tick
  return { status: 'active', redirect: '/dashboard' };
}

/**
 * The owner closes their own storefront. is_seller goes to 0, which removes the store from every public page and from discovery and blocks all
 * seller routes; the account, any admin/moderator role, orders, payments and audit history are untouched. Active/draft listings are archived.
 * Refused while there are open orders (those must be resolved first). Reopen later with reopenStore().
 */
async function closeStore(user) {
  return await tx(async () => {
    await lockKey('seller-apply', user.id);
    const u = await q.get('SELECT id, is_seller, handle FROM users WHERE id = ? FOR UPDATE', user.id);
    if (!u || !u.is_seller) throw new HttpError(409, 'You do not have an open storefront.');
    const open = Number((await q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND status IN ('pending_payment','paid','shipped')", u.id)).n);
    if (open) throw new HttpError(409, `You still have ${open} open order(s). Finish or resolve them before closing your storefront.`);
    await q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE seller_id = ? AND status IN ('active','draft')", now(), u.id);
    await q.run('UPDATE users SET is_seller = 0 WHERE id = ?', u.id);
    await audit(user, 'storefront_closed', { type: 'user', id: u.id, detail: { handle: u.handle } });
  });
}

/** Reopen a storefront the owner closed earlier (same store details; listings stay archived until they republish them). */
async function reopenStore(user) {
  await auth.rateLimit(`seller-apply:${user.id}`, 10, 3600);
  return await tx(async () => {
    await lockKey('seller-apply', user.id);
    const u = await q.get('SELECT id, is_seller, banned, handle, store_name FROM users WHERE id = ? FOR UPDATE', user.id);
    if (!u || u.banned) throw new HttpError(403, 'This account cannot open a store.');
    if (u.is_seller) throw new HttpError(409, 'Your storefront is already open.');
    if (!u.handle || !u.store_name) throw new HttpError(404, 'You have no closed storefront to reopen. Use the Sell page to open one.');
    await q.run('UPDATE users SET is_seller = 1 WHERE id = ?', u.id);
    await audit(user, 'storefront_reopened', { type: 'user', id: u.id, detail: { handle: u.handle } });
  });
}

async function withdraw(user) {
  const r = await q.run("UPDATE seller_applications SET status = 'withdrawn', decided_at = ? WHERE user_id = ? AND status = 'pending'", now(), user.id);
  if (r.changes !== 1) throw new HttpError(404, 'You have no waiting seller request.');
  await audit(user, 'seller_application_withdrawn', { type: 'user', id: user.id });
}

/** The caller's most recent application (or null). */
const mine = async (userId) => (await q.get('SELECT * FROM seller_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId)) || null;
const queue = async () => await q.all("SELECT a.*, u.email, u.display_name, u.banned FROM seller_applications a JOIN users u ON u.id = a.user_id WHERE a.status = 'pending' ORDER BY a.id");
const history = async () => await q.all("SELECT a.*, u.email, u.display_name FROM seller_applications a JOIN users u ON u.id = a.user_id WHERE a.status IN ('approved','rejected','withdrawn') ORDER BY a.decided_at DESC NULLS LAST, a.id DESC LIMIT 50");

async function approve(admin, id) {
  needAdmin(admin);
  return await tx(async () => {
    const a = await q.get('SELECT * FROM seller_applications WHERE id = ? FOR UPDATE', Number(id));
    if (!a) throw new HttpError(404, 'Application not found');
    if (a.status !== 'pending') throw new HttpError(409, 'This application was already decided or withdrawn.');
    const u = await q.get('SELECT id, banned, is_seller FROM users WHERE id = ? FOR UPDATE', a.user_id);
    if (!u || u.banned) throw new HttpError(409, 'This account is not eligible (suspended or removed).');
    if (u.is_seller) throw new HttpError(409, 'This member is already a seller.');
    const store = await inv.validateStore({ store_name: a.store_name, handle: a.handle, country: a.country, region: a.region, city: a.city, bio: a.bio, agree: true });   // the handle may have been taken since
    await q.run('UPDATE users SET is_seller = 1, store_name = ?, handle = ?, country = ?, region = ?, city = ?, bio = ? WHERE id = ? AND is_seller = 0', store.store, store.handle, store.country, store.region, store.city, store.bio, a.user_id);
    await q.run("UPDATE seller_applications SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", admin.id, now(), a.id);
    await audit(admin, 'seller_application_approved', { type: 'seller_application', id: a.id, detail: { user: a.user_id, handle: store.handle } });
    await notify(a.user_id, `seller-app:${a.id}:approved`, 'You can sell on PairPlug', 'Your seller request was approved. Open your seller dashboard to list your first item. Listing is free.', '/dashboard');
  });
}

async function reject(admin, id, reason) {
  needAdmin(admin);
  const why = clean(reason, 1001);
  if (why.length < 5 || why.length > 1000) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'Give a reason of 5 to 1000 characters; the applicant will see it.' });
  await tx(async () => {
    const a = await q.get('SELECT * FROM seller_applications WHERE id = ? FOR UPDATE', Number(id));
    if (!a) throw new HttpError(404, 'Application not found');
    if (a.status !== 'pending') throw new HttpError(409, 'This application was already decided or withdrawn.');
    await q.run("UPDATE seller_applications SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?", why, admin.id, now(), a.id);
    await audit(admin, 'seller_application_rejected', { type: 'seller_application', id: a.id, detail: { user: a.user_id, reason: why } });
    await notify(a.user_id, `seller-app:${a.id}:rejected`, 'Seller request not approved', `Your seller request was not approved: ${why}`, '/sell');
  });
}
module.exports = { closeStore, reopenStore, apply, withdraw, mine, queue, history, approve, reject };
