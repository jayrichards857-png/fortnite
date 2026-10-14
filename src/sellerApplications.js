'use strict';
// Self-service seller access. Anyone with an account (sign-in required: no anonymous listing or buying) asks for seller access with their store
// details; an administrator approves or rejects. There is NO limit on the number of sellers and no capacity queue.
//   * Seller privileges come ONLY from approve(): the client never sends a role, and the route is admin-only (re-checked here).
//   * One open request per person (partial unique index + a friendly check), so repeated submissions are harmless.
//   * No fee, subscription or payment is involved.
const { q, tx, now, lockKey } = require('./db');
const { HttpError, clean } = require('./util');
const auth = require('./auth');
const { audit } = require('./audit');
const inv = require('./invitations');
const { notify } = require('./notify');
const LEGAL = require('./legal');

const needAdmin = (a) => { if (!(a && a.is_admin)) throw new HttpError(403, 'Administrator access required'); };

async function apply(user, body = {}) {
  await auth.rateLimit(`seller-apply:${user.id}`, 10, 3600);
  if (user.is_seller) throw new HttpError(409, 'You already have a store.');
  const s = await inv.validateStore(body);                                   // same store eligibility rules as everywhere (handle, North America, terms ticked)
  const id = await tx(async () => {
    await lockKey('seller-apply', user.id);
    if (await q.get("SELECT 1 x FROM seller_applications WHERE user_id = ? AND status = 'pending'", user.id)) throw new HttpError(409, 'You already have a seller request waiting. You can withdraw it and send a new one.');
    if (await q.get("SELECT 1 x FROM seller_applications WHERE handle = ? AND status = 'pending'", s.handle)) throw new HttpError(422, 'Please fix the highlighted fields.', { handle: 'That URL is taken.' });
    return Number(await q.insert('INSERT INTO seller_applications(user_id, store_name, handle, country, region, city, bio, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)', user.id, s.store, s.handle, s.country, s.region, s.city, s.bio, 'pending', now()));
  });
  if (!LEGAL.accepted(await q.get('SELECT terms_version, terms_accepted_at FROM users WHERE id = ?', user.id))) await LEGAL.recordAcceptance(user.id);   // the agree box on this form is the explicit tick
  await audit(user, 'seller_application_submitted', { type: 'seller_application', id });
  return { id, status: 'pending' };
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
module.exports = { apply, withdraw, mine, queue, history, approve, reject };
