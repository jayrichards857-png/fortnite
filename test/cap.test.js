'use strict';
// Invitations (no seller limit), "Coming soon" sign-ups, role-escalation attempts. This file runs on its own database.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const { sha } = require('../src/accountTokens');

test.before(async () => await H.start());
test.after(() => H.stop());

const sellerCount = async () => (await q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1')).n;
const insertUser = async (email, isSeller = 0, handle = null) => await q.run('INSERT INTO users(email, password_hash, display_name, is_seller, handle, created_at) VALUES(?,?,?,?,?,1700000000)', email, 'x', 'T', isSeller, handle);
async function admin() { const a = await H.newUser('Admin'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; }
const body = (over = {}) => ({ display_name: 'Invited Person', password: 'a-long-password-1', store_name: 'Store', handle: 'h' + Math.random().toString(36).slice(2, 10), country: 'US', region: 'NY', city: 'Brooklyn', agree: true, terms: true, ...over });
const tokenOf = (link) => link.split('/').pop();
async function invite(adm, kind, email) { return adm.post('/api/admin/invitations', { kind, email }); }

test('there is no seller limit in the database: any number of sellers can be inserted or promoted, and existing rows are untouched', async () => {
  for (let i = 0; i < 12; i++) await insertUser(`many${i}@x.test`, 1, `many${i}`);
  assert.equal(await sellerCount(), 12, 'more than the old cap of 3 (and of 10)');
  await insertUser('buyer-a@x.test', 0);
  await q.run("UPDATE users SET is_seller = 1 WHERE email = 'buyer-a@x.test'");
  assert.equal(await sellerCount(), 13);
  assert.equal((await q.get("SELECT COUNT(*) n FROM pg_trigger WHERE tgname IN ('sellers_cap_insert','sellers_cap_update')")).n, 0, 'the cap triggers are gone');
  const adm = await admin();
  assert.doesNotMatch((await adm.get('/admin')).text, /beta cap/);
  assert.equal((await invite(adm, 'seller', 'unlimited@x.test')).status, 200, 'seller invitations are not capped');
  await q.run("UPDATE invitations SET revoked_at = 1 WHERE used_at IS NULL AND revoked_at IS NULL");
  await q.run("UPDATE users SET is_seller = 0 WHERE handle LIKE 'many%' OR email = 'buyer-a@x.test'");   // clean slate for the remaining tests
  assert.equal(await sellerCount(), 0);
});

test('invitations: hashed at rest, single use, expiring, revocable, email-bound; only admins can create them', async () => {
  const adm = await admin(), buyer = await H.newUser('NotAdmin');
  assert.equal((await buyer.post('/api/admin/invitations', { kind: 'seller', email: 'x@x.test' })).status, 403);
  assert.equal((await new H.Client().post('/api/admin/invitations', { kind: 'seller', email: 'x@x.test' })).status, 401);
  assert.equal((await invite(adm, 'seller', 'not-an-email')).status, 422);
  assert.equal((await invite(adm, 'friend', 'ok@x.test')).status, 422);
  const made = await invite(adm, 'seller', 'seller1@x.test'); assert.equal(made.status, 200);
  const tok = tokenOf(made.json.link); assert.match(tok, /^pp_inv_/);
  const row = await q.get("SELECT * FROM invitations WHERE email = 'seller1@x.test'");
  assert.equal(row.token_hash, sha(tok)); assert.ok(!JSON.stringify(row).includes(tok), 'the raw token is never stored');
  assert.equal((await invite(adm, 'seller', 'seller1@x.test')).status, 409, 'one live invitation per email');
  // wrong / malformed tokens give one generic answer
  const anon = new H.Client();
  for (const t of ['pp_inv_' + 'a'.repeat(32), 'garbage', '', 'pp_inv_']) { const r = await anon.post('/api/invitations/accept', { token: t, ...body() }); assert.equal(r.status, 400); assert.match(r.json.error, /invalid, expired or already used/); }
  assert.match((await anon.get(`/invite/${tok}`)).text, /Open your PairPlug store/);
  assert.match((await anon.get(`/invite/pp_inv_${'b'.repeat(32)}`)).text, /invalid, expired or already used/);
  // validation errors don't burn the invitation
  assert.equal((await anon.post('/api/invitations/accept', { token: tok, ...body({ handle: 'x' }) })).status, 422);
  assert.equal((await q.get("SELECT used_at FROM invitations WHERE email = 'seller1@x.test'")).used_at, null);
  // expiry
  await q.run("UPDATE invitations SET expires_at = 1 WHERE email = 'seller1@x.test'");
  assert.equal((await anon.post('/api/invitations/accept', { token: tok, ...body() })).status, 400);
  assert.match((await anon.get(`/invite/${tok}`)).text, /invalid, expired or already used/);
  assert.equal((await invite(adm, 'seller', 'seller1@x.test')).status, 200, 'an expired invitation is retired and can be reissued');
  // revoke
  const second = await invite(adm, 'buyer', 'rev@x.test'); const id = (await q.get("SELECT id FROM invitations WHERE email = 'rev@x.test'")).id;
  assert.equal((await adm.post(`/api/admin/invitations/${id}/revoke`)).status, 200);
  assert.equal((await anon.post('/api/invitations/accept', { token: tokenOf(second.json.link), ...body() })).status, 400);
  assert.equal((await adm.post(`/api/admin/invitations/${id}/revoke`)).status, 409);
  // single use
  const ok = await invite(adm, 'seller', 'single@x.test'), t = tokenOf(ok.json.link);
  const c = new H.Client();
  assert.equal((await c.post('/api/invitations/accept', { token: t, ...body() })).status, 200);
  assert.equal((await new H.Client().post('/api/invitations/accept', { token: t, ...body() })).status, 400, 'reuse is refused');
  const u = await q.get("SELECT * FROM users WHERE email = 'single@x.test'"); assert.equal(u.is_seller, 1); assert.equal(u.email_verified_at, null, 'accepting an invitation does not verify the email');
  assert.equal((await c.get('/dashboard')).status, 200, 'the invitation signed them in');
  assert.ok((await q.get("SELECT used_by FROM invitations WHERE email = 'single@x.test'")).used_by === u.id);
  assert.equal((await q.get("SELECT COUNT(*) n FROM audit_log WHERE action IN ('invitation_created','invitation_accepted','invitation_revoked')")).n >= 5, true);
  await q.run("UPDATE users SET is_seller = 0 WHERE email = 'single@x.test'");
});

test('many seller invitations can be open at once (no reserved slots)', async () => {
  const adm = await admin();
  await q.run("UPDATE invitations SET revoked_at = 1 WHERE used_at IS NULL AND revoked_at IS NULL");
  for (let i = 0; i < 12; i++) assert.equal((await invite(adm, 'seller', `slot${i}@x.test`)).status, 200);
  await q.run("UPDATE invitations SET revoked_at = 1 WHERE used_at IS NULL AND revoked_at IS NULL");
});

test('race: one invitation accepted by 6 parallel requests creates exactly one account', async () => {
  await q.run("UPDATE users SET is_seller = 0 WHERE is_seller = 1");
  const adm = await admin(), made = await invite(adm, 'seller', 'once@x.test'), t = tokenOf(made.json.link);
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => new H.Client().post('/api/invitations/accept', { token: t, ...body({ handle: 'once' + i }) })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal((await q.get("SELECT COUNT(*) n FROM users WHERE email = 'once@x.test'")).n, 1);
  assert.equal((await q.get("SELECT COUNT(*) n FROM users WHERE handle LIKE 'once%'")).n, 1);
});

test('buyers register without consuming slots; admins cannot create sellers by accident; self-promotion is impossible', async () => {
  const before = await sellerCount();
  const adm = await admin(), made = await invite(adm, 'buyer', 'newbuyer@x.test');
  const c = new H.Client();
  assert.equal((await c.post('/api/invitations/accept', { token: tokenOf(made.json.link), display_name: 'Buyer', password: 'a-long-password-1', terms: true, is_seller: 1, is_admin: 1, store_name: 'X', handle: 'xx' })).status, 200);
  const u = await q.get("SELECT is_seller, is_admin FROM users WHERE email = 'newbuyer@x.test'"); assert.deepEqual({ ...u }, { is_seller: 0, is_admin: 0 });
  assert.equal(await sellerCount(), before);
  // self-registration in open mode can't smuggle roles either
  const reg = new H.Client(); await reg.post('/api/register', { email: 'sneaky@x.test', display_name: 'Sneaky', terms: true, password: 'a-long-password-1', is_seller: 1, is_admin: 1, role: 'admin' });
  assert.deepEqual({ ...await q.get("SELECT is_seller, is_admin FROM users WHERE email = 'sneaky@x.test'") }, { is_seller: 0, is_admin: 0 });
  // profile/account endpoints ignore role fields; admin and seller APIs refuse a buyer
  await reg.req('PATCH', '/api/account', { display_name: 'Sneaky', is_admin: 1, is_seller: 1, banned: 0 });
  assert.deepEqual({ ...await q.get("SELECT is_seller, is_admin FROM users WHERE email = 'sneaky@x.test'") }, { is_seller: 0, is_admin: 0 });
  for (const [m, u] of [['post', '/api/admin/invitations'], ['post', '/api/admin/users/1/ban'], ['put', '/api/admin/settings'], ['post', '/api/seller/listings'], ['put', '/api/seller/settings']]) assert.equal((await reg[m](u, {})).status, 403, u);
  const prevO = config.sellerOnboarding; config.sellerOnboarding = 'invite';
  try { assert.equal((await reg.post('/api/sell/onboard', { store_name: 'S', handle: 'sneakyshop', country: 'US', region: 'NY', city: 'B', agree: true, terms: true })).status, 403, 'a buyer cannot open a store without an invitation'); }
  finally { config.sellerOnboarding = prevO; }
  // existing buyer upgraded through a seller invitation only when logged in as that account
  await q.run("UPDATE users SET is_seller = 0 WHERE email LIKE 'fill%'");
  const up = await invite(adm, 'seller', 'sneaky@x.test'), anon = new H.Client();
  assert.equal((await anon.post('/api/invitations/accept', { token: tokenOf(up.json.link), ...body() })).status, 401, 'must be logged in as the invited account');
  assert.equal((await reg.post('/api/invitations/accept', { token: tokenOf(up.json.link), ...body() })).status, 200);
  assert.equal((await q.get("SELECT is_seller FROM users WHERE email = 'sneaky@x.test'")).is_seller, 1);
  const other = await H.newUser('Other'); const up2 = await invite(adm, 'seller', other.email);
  assert.equal((await reg.post('/api/invitations/accept', { token: tokenOf(up2.json.link), ...body() })).status, 401, "someone else's invitation requires being logged in as that account");
  assert.equal((await q.get("SELECT is_seller FROM users WHERE email = ?", other.email)).is_seller, 0, "another account's invitation cannot be used by a different user");
});

test('Coming soon: closed sign-ups show the release date, create nothing, but login and invitations still work', async () => {
  const prevS = config.signups, prevD = config.releaseDate, prevO = config.sellerOnboarding;
  config.signups = 'closed'; config.releaseDate = '2026-11-01'; config.sellerOnboarding = 'invite';
  try {
    const anon = new H.Client(), before = (await q.get('SELECT COUNT(*) n FROM users')).n;
    const reg = await anon.get('/register'); assert.equal(reg.status, 200);
    assert.match(reg.text, /Coming soon/i); assert.match(reg.text, /Selling available <strong>November 1, 2026<\/strong>/);
    const api = await anon.post('/api/register', { email: 'closed@x.test', display_name: 'Closed', terms: true, password: 'a-long-password-1' });
    assert.equal(api.status, 403); assert.match(api.json.error, /paused/i);
    assert.equal((await q.get('SELECT COUNT(*) n FROM users')).n, before); assert.equal((await q.get("SELECT COUNT(*) n FROM users WHERE email = 'closed@x.test'")).n, 0);
    const sell = await anon.get('/sell'); assert.match(sell.text, /Coming soon/i); assert.match(sell.text, /November 1, 2026/);
    const home = (await anon.get('/')).text; assert.match(home, /Coming soon/i); assert.doesNotMatch(home, />Sign up</);
    // existing users can still log in; a logged-in buyer sees the seller request form (not instant onboarding)
    const existing = await q.get("SELECT email FROM users WHERE email = 'newbuyer@x.test'");
    assert.equal((await anon.post('/api/login', { email: existing.email, password: 'a-long-password-1' })).status, 200);
    assert.match((await anon.get('/sell')).text, /Request seller access|Join the waitlist/); assert.doesNotMatch((await anon.get('/sell')).text, /Coming soon/i);
    assert.equal((await anon.post('/api/sell/onboard', { store_name: 'S', handle: 'nopeshop', country: 'US', region: 'NY', city: 'B', agree: true, terms: true })).status, 403);
    // without a configured date we say "very soon" instead of inventing one
    config.releaseDate = ''; assert.match((await new H.Client().get('/register')).text, /Selling opens very soon/);
  } finally { config.signups = prevS; config.releaseDate = prevD; config.sellerOnboarding = prevO; }
});

test('every seller slot change is attributable: audit rows exist and are append-only', async () => {
  assert.ok((await q.get('SELECT COUNT(*) n FROM audit_log')).n > 5);
  await assert.rejects(async () => await q.run("UPDATE audit_log SET action = 'x' WHERE id = 1"), /append-only/);
  await assert.rejects(async () => await q.run('DELETE FROM audit_log WHERE id = 1'), /append-only/);
  const adm = await admin(); assert.match((await adm.get('/admin/audit')).text, /invitation_created/);
});
