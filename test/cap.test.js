'use strict';
// Seller cap (3), invitations, "Coming soon" sign-ups, role-escalation attempts. This file runs on its own database with the REAL cap.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const { sha } = require('../src/accountTokens');

test.before(async () => { await H.start(); q.run("UPDATE settings SET value = '3' WHERE key = 'seller_cap'"); });
test.after(() => H.stop());

const sellerCount = () => q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1').n;
const insertUser = (email, isSeller = 0, handle = null) => q.run('INSERT INTO users(email, password_hash, display_name, is_seller, handle, created_at) VALUES(?,?,?,?,?,1700000000)', email, 'x', 'T', isSeller, handle);
async function admin() { const a = await H.newUser('Admin'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; }
const body = (over = {}) => ({ display_name: 'Invited Person', password: 'a-long-password-1', store_name: 'Store', handle: 'h' + Math.random().toString(36).slice(2, 10), country: 'US', region: 'NY', city: 'Brooklyn', agree: true, ...over });
const tokenOf = (link) => link.split('/').pop();
async function invite(adm, kind, email) { return adm.post('/api/admin/invitations', { kind, email }); }

test('the database itself refuses a 4th seller (insert and promotion), and never touches existing rows', () => {
  assert.equal(q.get("SELECT value v FROM settings WHERE key = 'seller_cap'").v, '3');
  for (let i = 0; i < 3; i++) insertUser(`cap${i}@x.test`, 1, `cap${i}`);
  assert.equal(sellerCount(), 3);
  assert.throws(() => insertUser('cap3@x.test', 1, 'cap3'), /seller cap reached/);
  insertUser('buyer-a@x.test', 0);
  assert.throws(() => q.run("UPDATE users SET is_seller = 1 WHERE email = 'buyer-a@x.test'"), /seller cap reached/);
  q.run("UPDATE users SET store_name = 'edited', banned = 1 WHERE email = 'cap0@x.test'");       // ordinary updates of existing sellers still work
  q.run("UPDATE users SET banned = 0 WHERE email = 'cap0@x.test'");
  assert.equal(sellerCount(), 3);
  q.run("UPDATE users SET is_seller = 0 WHERE email = 'cap2@x.test'");                          // freeing a slot is possible at the DB level...
  q.run("UPDATE users SET is_seller = 1 WHERE email = 'cap2@x.test'");                          // ...and a suspended/demoted seller can be restored into it
  assert.equal(sellerCount(), 3);
});

test('a database that already holds MORE than the cap is preserved, flagged, and blocked from growing', async () => {
  q.run("UPDATE settings SET value = '10' WHERE key = 'seller_cap'");
  insertUser('extra1@x.test', 1, 'extra1'); insertUser('extra2@x.test', 1, 'extra2');            // 5 sellers
  q.run("UPDATE settings SET value = '3' WHERE key = 'seller_cap'");                            // cap lowered below the existing count
  assert.equal(sellerCount(), 5, 'nothing was deleted');
  assert.throws(() => insertUser('extra3@x.test', 1, 'extra3'), /seller cap reached/);
  const adm = await admin();
  assert.match((await adm.get('/admin')).text, /5 seller accounts but the beta cap is 3/);
  assert.equal((await invite(adm, 'seller', 'nope@x.test')).status, 409);
  assert.equal(require('../src/invitations').slots().over, true);
  // restore a clean slate for the remaining tests: demote the extras (only possible through the audited admin action)
  const ids = q.all("SELECT id FROM users WHERE handle IN ('extra1','extra2')").map((r) => r.id);
  for (const id of ids) assert.equal((await adm.post(`/api/admin/sellers/${id}/release-slot`)).status, 200);
  assert.equal(sellerCount(), 3);
  assert.equal(q.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'seller_slot_released'").n, 2, 'slot releases are audited');
  // free the shared slots for the invitation tests
  q.run("UPDATE users SET is_seller = 0 WHERE handle LIKE 'cap%'");
  assert.equal(sellerCount(), 0);
});

test('invitations: hashed at rest, single use, expiring, revocable, email-bound; only admins can create them', async () => {
  const adm = await admin(), buyer = await H.newUser('NotAdmin');
  assert.equal((await buyer.post('/api/admin/invitations', { kind: 'seller', email: 'x@x.test' })).status, 403);
  assert.equal((await new H.Client().post('/api/admin/invitations', { kind: 'seller', email: 'x@x.test' })).status, 401);
  assert.equal((await invite(adm, 'seller', 'not-an-email')).status, 422);
  assert.equal((await invite(adm, 'friend', 'ok@x.test')).status, 422);
  const made = await invite(adm, 'seller', 'seller1@x.test'); assert.equal(made.status, 200);
  const tok = tokenOf(made.json.link); assert.match(tok, /^pp_inv_/);
  const row = q.get("SELECT * FROM invitations WHERE email = 'seller1@x.test'");
  assert.equal(row.token_hash, sha(tok)); assert.ok(!JSON.stringify(row).includes(tok), 'the raw token is never stored');
  assert.equal((await invite(adm, 'seller', 'seller1@x.test')).status, 409, 'one live invitation per email');
  // wrong / malformed tokens give one generic answer
  const anon = new H.Client();
  for (const t of ['pp_inv_' + 'a'.repeat(32), 'garbage', '', 'pp_inv_']) { const r = await anon.post('/api/invitations/accept', { token: t, ...body() }); assert.equal(r.status, 400); assert.match(r.json.error, /invalid, expired or already used/); }
  assert.match((await anon.get(`/invite/${tok}`)).text, /Open your PairPlug store/);
  assert.match((await anon.get(`/invite/pp_inv_${'b'.repeat(32)}`)).text, /invalid, expired or already used/);
  // validation errors don't burn the invitation
  assert.equal((await anon.post('/api/invitations/accept', { token: tok, ...body({ handle: 'x' }) })).status, 422);
  assert.equal(q.get("SELECT used_at FROM invitations WHERE email = 'seller1@x.test'").used_at, null);
  // expiry
  q.run("UPDATE invitations SET expires_at = 1 WHERE email = 'seller1@x.test'");
  assert.equal((await anon.post('/api/invitations/accept', { token: tok, ...body() })).status, 400);
  assert.match((await anon.get(`/invite/${tok}`)).text, /invalid, expired or already used/);
  assert.equal((await invite(adm, 'seller', 'seller1@x.test')).status, 200, 'an expired invitation is retired and can be reissued');
  // revoke
  const second = await invite(adm, 'buyer', 'rev@x.test'); const id = q.get("SELECT id FROM invitations WHERE email = 'rev@x.test'").id;
  assert.equal((await adm.post(`/api/admin/invitations/${id}/revoke`)).status, 200);
  assert.equal((await anon.post('/api/invitations/accept', { token: tokenOf(second.json.link), ...body() })).status, 400);
  assert.equal((await adm.post(`/api/admin/invitations/${id}/revoke`)).status, 409);
  // single use
  const ok = await invite(adm, 'seller', 'single@x.test'), t = tokenOf(ok.json.link);
  const c = new H.Client();
  assert.equal((await c.post('/api/invitations/accept', { token: t, ...body() })).status, 200);
  assert.equal((await new H.Client().post('/api/invitations/accept', { token: t, ...body() })).status, 400, 'reuse is refused');
  const u = q.get("SELECT * FROM users WHERE email = 'single@x.test'"); assert.equal(u.is_seller, 1); assert.equal(u.email_verified_at, null, 'accepting an invitation does not verify the email');
  assert.equal((await c.get('/dashboard')).status, 200, 'the invitation signed them in');
  assert.ok(q.get("SELECT used_by FROM invitations WHERE email = 'single@x.test'").used_by === u.id);
  assert.equal(q.get("SELECT COUNT(*) n FROM audit_log WHERE action IN ('invitation_created','invitation_accepted','invitation_revoked')").n >= 5, true);
  q.run("UPDATE users SET is_seller = 0 WHERE email = 'single@x.test'");
});

test('seller invitations reserve slots, so the cap cannot be oversubscribed by issuing invitations', async () => {
  const adm = await admin();
  assert.equal(sellerCount(), 0);
  q.run("UPDATE invitations SET revoked_at = 1 WHERE used_at IS NULL AND revoked_at IS NULL");
  for (let i = 0; i < 3; i++) assert.equal((await invite(adm, 'seller', `slot${i}@x.test`)).status, 200);
  const fourth = await invite(adm, 'seller', 'slot3@x.test'); assert.equal(fourth.status, 409); assert.match(fourth.json.error, /slots/);
  assert.equal((await invite(adm, 'buyer', 'buyer-ok@x.test')).status, 200, 'buyer invitations never need a slot');
  assert.match((await adm.get('/admin/invitations')).text, /0 \/ 3/);
  q.run("UPDATE invitations SET revoked_at = 1 WHERE used_at IS NULL AND revoked_at IS NULL");
});

test('race: 8 simultaneous attempts to become the last seller yield exactly one; no 4th seller ever', async () => {
  q.run("UPDATE users SET is_seller = 0 WHERE is_seller = 1");
  for (let i = 0; i < 2; i++) insertUser(`pre${i}@x.test`, 1, `pre${i}`);
  assert.equal(sellerCount(), 2);
  const prev = config.sellerOnboarding; config.sellerOnboarding = 'open';                 // the open path exists only in dev/test; the cap is the same trigger
  try {
    const users = await Promise.all(Array.from({ length: 8 }, () => H.newUser('Racer')));
    const rs = await Promise.all(users.map((u, i) => u.post('/api/sell/onboard', { store_name: 'R' + i, handle: 'race' + i + Date.now() % 1000, country: 'US', region: 'NY', city: 'B', agree: true })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.filter((r) => r.status === 409).length, 7);
  } finally { config.sellerOnboarding = prev; }
  assert.equal(sellerCount(), 3);
});

test('race: one invitation accepted by 6 parallel requests creates exactly one account; cap race through invitations', async () => {
  q.run("UPDATE users SET is_seller = 0 WHERE is_seller = 1");
  const adm = await admin(), made = await invite(adm, 'seller', 'once@x.test'), t = tokenOf(made.json.link);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => new H.Client().post('/api/invitations/accept', { token: t, ...body({ handle: 'once' + i }) })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE email = 'once@x.test'").n, 1);
  assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE handle LIKE 'once%'").n, 1);
  // invitation acceptance against a full house: slots taken by other means after the invitation was issued
  q.run("UPDATE users SET is_seller = 0 WHERE is_seller = 1");
  const late = await invite(adm, 'seller', 'late@x.test');
  for (let i = 0; i < 3; i++) insertUser(`fill${i}@x.test`, 1, `fill${i}`);
  const lose = await new H.Client().post('/api/invitations/accept', { token: tokenOf(late.json.link), ...body() });
  assert.equal(lose.status, 409);
  assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE email = 'late@x.test'").n, 0, 'the failed acceptance left no half-created account');
  assert.equal(q.get("SELECT used_at FROM invitations WHERE email = 'late@x.test'").used_at, null, 'and did not consume the invitation');
  assert.equal(sellerCount(), 3);
});

test('buyers register without consuming slots; admins cannot create sellers by accident; self-promotion is impossible', async () => {
  const before = sellerCount();
  const adm = await admin(), made = await invite(adm, 'buyer', 'newbuyer@x.test');
  const c = new H.Client();
  assert.equal((await c.post('/api/invitations/accept', { token: tokenOf(made.json.link), display_name: 'Buyer', password: 'a-long-password-1', is_seller: 1, is_admin: 1, store_name: 'X', handle: 'xx' })).status, 200);
  const u = q.get("SELECT is_seller, is_admin FROM users WHERE email = 'newbuyer@x.test'"); assert.deepEqual({ ...u }, { is_seller: 0, is_admin: 0 });
  assert.equal(sellerCount(), before);
  // self-registration in open mode can't smuggle roles either
  const reg = new H.Client(); await reg.post('/api/register', { email: 'sneaky@x.test', display_name: 'Sneaky', password: 'a-long-password-1', is_seller: 1, is_admin: 1, role: 'admin' });
  assert.deepEqual({ ...q.get("SELECT is_seller, is_admin FROM users WHERE email = 'sneaky@x.test'") }, { is_seller: 0, is_admin: 0 });
  // profile/account endpoints ignore role fields; admin and seller APIs refuse a buyer
  await reg.req('PATCH', '/api/account', { display_name: 'Sneaky', is_admin: 1, is_seller: 1, banned: 0 });
  assert.deepEqual({ ...q.get("SELECT is_seller, is_admin FROM users WHERE email = 'sneaky@x.test'") }, { is_seller: 0, is_admin: 0 });
  for (const [m, u] of [['post', '/api/admin/invitations'], ['post', '/api/admin/users/1/ban'], ['put', '/api/admin/settings'], ['post', '/api/seller/listings'], ['put', '/api/seller/settings']]) assert.equal((await reg[m](u, {})).status, 403, u);
  const prevO = config.sellerOnboarding; config.sellerOnboarding = 'invite';
  try { assert.equal((await reg.post('/api/sell/onboard', { store_name: 'S', handle: 'sneakyshop', country: 'US', region: 'NY', city: 'B', agree: true })).status, 403, 'a buyer cannot open a store without an invitation'); }
  finally { config.sellerOnboarding = prevO; }
  // existing buyer upgraded through a seller invitation only when logged in as that account
  q.run("UPDATE users SET is_seller = 0 WHERE email LIKE 'fill%'");
  const up = await invite(adm, 'seller', 'sneaky@x.test'), anon = new H.Client();
  assert.equal((await anon.post('/api/invitations/accept', { token: tokenOf(up.json.link), ...body() })).status, 401, 'must be logged in as the invited account');
  assert.equal((await reg.post('/api/invitations/accept', { token: tokenOf(up.json.link), ...body() })).status, 200);
  assert.equal(q.get("SELECT is_seller FROM users WHERE email = 'sneaky@x.test'").is_seller, 1);
  const other = await H.newUser('Other'); const up2 = await invite(adm, 'seller', other.email);
  assert.equal((await reg.post('/api/invitations/accept', { token: tokenOf(up2.json.link), ...body() })).status, 401, "someone else's invitation requires being logged in as that account");
  assert.equal(q.get("SELECT is_seller FROM users WHERE email = ?", other.email).is_seller, 0, "another account's invitation cannot be used by a different user");
});

test('Coming soon: closed sign-ups show the release date, create nothing, but login and invitations still work', async () => {
  const prevS = config.signups, prevD = config.releaseDate, prevO = config.sellerOnboarding;
  config.signups = 'closed'; config.releaseDate = '2026-11-01'; config.sellerOnboarding = 'invite';
  try {
    const anon = new H.Client(), before = q.get('SELECT COUNT(*) n FROM users').n;
    const reg = await anon.get('/register'); assert.equal(reg.status, 200);
    assert.match(reg.text, /Coming soon/i); assert.match(reg.text, /Selling available <strong>November 1, 2026<\/strong>/);
    const api = await anon.post('/api/register', { email: 'closed@x.test', display_name: 'Closed', password: 'a-long-password-1' });
    assert.equal(api.status, 403); assert.match(api.json.error, /paused/i);
    assert.equal(q.get('SELECT COUNT(*) n FROM users').n, before); assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE email = 'closed@x.test'").n, 0);
    const sell = await anon.get('/sell'); assert.match(sell.text, /Coming soon/i); assert.match(sell.text, /November 1, 2026/);
    const home = (await anon.get('/')).text; assert.match(home, /Coming soon/i); assert.doesNotMatch(home, />Sign up</);
    // existing users can still log in; a logged-in buyer gets the same Coming-soon page for /sell and cannot open a store
    const existing = q.get("SELECT email FROM users WHERE email = 'newbuyer@x.test'");
    assert.equal((await anon.post('/api/login', { email: existing.email, password: 'a-long-password-1' })).status, 200);
    assert.match((await anon.get('/sell')).text, /Coming soon/i);
    assert.equal((await anon.post('/api/sell/onboard', { store_name: 'S', handle: 'nopeshop', country: 'US', region: 'NY', city: 'B', agree: true })).status, 403);
    // without a configured date we say "very soon" instead of inventing one
    config.releaseDate = ''; assert.match((await new H.Client().get('/register')).text, /Selling opens very soon/);
  } finally { config.signups = prevS; config.releaseDate = prevD; config.sellerOnboarding = prevO; }
});

test('every seller slot change is attributable: audit rows exist and are append-only', async () => {
  assert.ok(q.get('SELECT COUNT(*) n FROM audit_log').n > 5);
  assert.throws(() => q.run("UPDATE audit_log SET action = 'x' WHERE id = 1"), /append-only/);
  assert.throws(() => q.run('DELETE FROM audit_log WHERE id = 1'), /append-only/);
  const adm = await admin(); assert.match((await adm.get('/admin/audit')).text, /invitation_created/);
});
