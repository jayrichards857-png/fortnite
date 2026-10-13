'use strict';
// Admin-only account management: create buyer / seller / admin accounts directly, and reset a user's password.
// PairPlug sellers are curated: ONLY an authenticated administrator can reach these functions (routes use requireAdmin; the check is repeated here).
//   * No account is ever created from a public form with a role; public sign-up creates buyers only (src/routes/buyer.js).
//   * Credentials are random temporary passwords (~120 bits), shown ONCE to the acting admin in the response, stored only as a scrypt hash, never
//     logged or audited. The account must replace it at first login (must_change_password); changing it signs the user out everywhere else.
//   * Email is not verified and is never marked verified here: sellers do not need verified email (see listings.js).
//   * Seller creation obeys the same seller cap and store eligibility rules as invitations; admin creation needs the acting admin's own password.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, cleanLine } = require('./util');
const auth = require('./auth');
const { audit } = require('./audit');
const inv = require('./invitations');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tempPassword = () => crypto.randomBytes(15).toString('base64url');
const needAdmin = (a) => { if (!(a && a.is_admin)) throw new HttpError(403, 'Administrator access required'); };

async function createAccount(admin, b = {}) {
  needAdmin(admin);
  await auth.rateLimit(`acct-create:${admin.id}`, 30, 3600);
  const role = String(b.role || ''), email = cleanLine(b.email, 200).toLowerCase(), name = cleanLine(b.display_name, 80), f = {};
  if (!['buyer', 'seller', 'admin'].includes(role)) throw new HttpError(422, 'Choose buyer, seller or admin.');
  if (!EMAIL_RE.test(email)) f.email = 'Enter a valid email address.';
  if (name.length < 2) f.display_name = 'Enter their name.';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  if (b.confirm !== true) throw new HttpError(422, 'Please confirm before creating the account.');
  if (role === 'admin' && !auth.verifyPassword(String(b.password || ''), admin.password_hash)) throw new HttpError(403, 'Your password is incorrect (needed to create an administrator).');
  const pw = tempPassword();
  const id = await tx(async () => {
    if (await q.get('SELECT 1 x FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Use "Reset password" on the Users page for someone who cannot log in; do not create a duplicate.');
    let store = null;
    if (role === 'seller') {
      store = await inv.validateStore({ ...b, agree: true });              // same eligibility rules as an accepted invitation
      if ((await inv.slots()).available <= 0) throw new HttpError(409, 'All seller slots are in use during the private beta.');
    }
    try {
      return Number(await q.insert('INSERT INTO users(email, password_hash, display_name, is_admin, is_seller, store_name, handle, country, region, city, bio, must_change_password, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)',
        email, auth.hashPassword(pw), name, role === 'admin' ? 1 : 0, store ? 1 : 0, store && store.store, store && store.handle, store && store.country, store && store.region, store && store.city, store && store.bio, now()));
    } catch (e) { inv.mapCap(e); }
  });
  await audit(admin, 'account_created_by_admin', { type: 'user', id, detail: { role, email } });       // never the password
  return { id, email, role, tempPassword: pw };
}

async function resetPassword(admin, userId) {
  needAdmin(admin);
  await auth.rateLimit(`acct-reset:${admin.id}`, 30, 3600);
  const id = Number(userId);
  if (id === admin.id) throw new HttpError(400, 'Change your own password from the Account page.');
  const pw = tempPassword();
  const email = await tx(async () => {
    const u = await q.get('SELECT id, email FROM users WHERE id = ? FOR UPDATE', id);
    if (!u) throw new HttpError(404, 'User not found');
    await q.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', auth.hashPassword(pw), id);      // ban / suspension status is NOT touched
    await q.run('DELETE FROM sessions WHERE user_id = ?', id);                                                                  // every existing session ends
    return u.email;
  });
  await audit(admin, 'password_reset_by_admin', { type: 'user', id });
  return { id, email, tempPassword: pw };
}
void config;
module.exports = { createAccount, resetPassword };
