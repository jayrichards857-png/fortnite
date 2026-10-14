'use strict';
// Curated sellers: only an administrator creates sellers/admins (server-enforced); public sign-up makes buyers only; admin-created accounts get a
// one-time temporary password and can list immediately without any email verification; admin password resets; bans stay in force.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const config = require('../src/config');
const { q } = require('../src/db');
const { verifyPassword } = require('../src/auth');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_curated1';
const mkAdmin = async () => { const a = await H.newUser('Owner'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); a.pw = 'correct-horse-9'; return a; };
const store = (n) => ({ store_name: `Curated ${n}`, handle: `curated${n}${Date.now() % 100000}`, country: 'US', region: 'NY', city: 'Brooklyn' });
const create = (admin, over = {}) => admin.post('/api/admin/accounts/create', { role: 'seller', display_name: 'Curated Seller', email: `cs${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`, confirm: true, ...store(Math.floor(Math.random() * 1e6)), ...over });
const row = async (email) => await q.get('SELECT * FROM users WHERE email = ?', email.toLowerCase());

test('public sign-up creates buyers only: role fields in the request are ignored; nobody can self-onboard as a seller or promote themselves', async () => {
  const c = new H.Client(), email = `evil${Date.now()}@example.test`;
  const r = await c.post('/api/register', { email, display_name: 'Eve', password: 'a-long-password-1', terms: true, is_admin: 1, is_seller: 1, role: 'admin', handle: 'evilstore', must_change_password: 0, is_moderator: 1 });
  assert.equal(r.status, 200, r.text);
  const u = await row(email); assert.deepEqual([u.is_admin, u.is_seller, u.is_moderator, u.handle], [0, 0, 0, null]);
  assert.equal((await c.post('/api/sell/onboard', { ...store(1), agree: true, terms: true })).status, 200, 'any signed-in account may open a store');   // the server grants is_seller; the sign-up roles above were ignored
  const after = await row(email); assert.deepEqual([after.is_seller, after.is_admin, after.is_moderator], [1, 0, 0]);
  for (const [url, body] of [[`/api/admin/users/${u.id}/admin`, { admin: true, password: 'x' }], [`/api/admin/users/${u.id}/seller-invite`, {}], ['/api/admin/accounts/create', { role: 'seller', email: 'x@example.test', display_name: 'X', confirm: true, ...store(2) }], ['/api/admin/invitations', { kind: 'seller', email: 'y@example.test' }]])
    assert.ok([401, 403].includes((await c.post(url, body)).status), url);
  assert.equal((await row(email)).is_admin, 0);
});

test('only an administrator can create accounts or reset passwords: anonymous, buyers, sellers and moderators are refused and nothing is created', async () => {
  const anon = new H.Client(), buyer = await H.newUser('Buyer'), seller = await H.newSeller('Sel'), mod = await H.newUser('Mod'); await q.run('UPDATE users SET is_moderator = 1 WHERE email = ?', mod.email);
  const victim = await H.newUser('Victim'), vrow = await row(victim.email), before = Number((await q.get('SELECT COUNT(*) n FROM users')).n);
  for (const [who, c] of [['anonymous', anon], ['buyer', buyer], ['seller', seller], ['moderator', mod]]) {
    const r = await c.post('/api/admin/accounts/create', { role: 'seller', email: `nope-${who}@example.test`, display_name: 'Nope', confirm: true, ...store(3) });
    assert.ok([401, 403].includes(r.status), `${who}: ${r.status}`);
    const p = await c.post(`/api/admin/users/${vrow.id}/reset-password`, {}); assert.ok([401, 403].includes(p.status), `${who} reset: ${p.status}`);
  }
  assert.equal(Number((await q.get('SELECT COUNT(*) n FROM users')).n), before, 'no account was created by the refused requests');
  assert.equal((await row(victim.email)).password_hash, vrow.password_hash, 'victim password untouched');
});

test('ACCEPTANCE: admin creates a seller -> seller logs in with the temporary password -> must change it -> lists a product and sells, with NO email verification anywhere', async () => {
  const admin = await mkAdmin(), email = 'Jay.Mixed.Case@Example.test';
  const made = await create(admin, { email, display_name: 'Trusted Reseller' }); assert.equal(made.status, 200, made.text);
  assert.equal(made.headers.get('cache-control'), 'no-store'); const pw = made.json.tempPassword; assert.match(pw, /^[A-Za-z0-9_-]{20}$/);
  const u = await row(email); assert.equal(u.email, email.toLowerCase()); assert.deepEqual([u.is_seller, u.is_admin, Number(u.must_change_password)], [1, 0, 1]); assert.equal(u.email_verified_at, null, 'email is not falsely marked verified');
  assert.ok(verifyPassword(pw, u.password_hash) && !u.password_hash.includes(pw), 'only a hash is stored');
  assert.equal(JSON.stringify(await q.all('SELECT * FROM audit_log')).includes(pw), false, 'the password is not in the audit log');
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'account_created_by_admin'"));
  const s = new H.Client(); assert.equal((await s.post('/api/login', { email, password: pw })).status, 200);       // mixed-case login works
  // forced change: nothing else works until the temporary password is replaced
  assert.equal((await s.get('/dashboard')).status, 302); const blocked = await s.post('/api/seller/listings', { title: 'x' }); assert.equal(blocked.status, 403); assert.equal(blocked.json.mustChangePassword, true);
  assert.equal((await s.post('/api/account/password', { current: pw, next: pw })).status, 422, 'must choose a different password');
  assert.equal((await s.post('/api/account/password', { current: pw, next: 'my-own-new-password-1' })).status, 200);
  assert.equal(Number((await row(email)).must_change_password), 0);
  assert.equal((await new H.Client().post('/api/login', { email, password: pw })).status, 401, 'the temporary password no longer works');
  // list and sell immediately
  assert.equal((await s.get('/dashboard')).status, 200); assert.doesNotMatch((await s.get('/dashboard')).text, /[Vv]erify your email/);
  const id = await H.makeListing(s, { payment_url: LINK, shipping_payer: 'buyer' });
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'active');
  const buyer = await H.newUser('Shopper'); assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 200, 'and it can be bought');
  assert.equal((await row(email)).email_verified_at, null, 'still never marked verified');
});

test('seller creation keeps the eligibility rules: handle, country, duplicates; admin creation needs the admin password; buyers can be created too', async () => {
  const admin = await mkAdmin();
  const first = await create(admin); assert.equal(first.status, 200, first.text);
  const second = await create(admin); assert.equal(second.status, 200, 'no seller limit: a second and further seller can be created');
  assert.equal((await create(admin, { email: first.json.email })).status, 409, 'no duplicate accounts for the same email');
  assert.equal((await create(admin, { handle: 'a b' })).status, 422); assert.equal((await create(admin, { country: 'FR' })).status, 422); assert.equal((await create(admin, { email: 'not-an-email' })).status, 422); assert.equal((await create(admin, { display_name: '' })).status, 422);
  assert.equal((await create(admin, { confirm: false })).status, 422, 'explicit confirmation required'); assert.equal((await create(admin, { role: 'superuser' })).status, 422);
  const taken = await create(admin, { handle: (await row(first.json.email)).handle }); assert.equal(taken.status, 422, 'handle must be unique');
  const b = await create(admin, { role: 'buyer' }); assert.equal(b.status, 200); const br = await row(b.json.email); assert.deepEqual([br.is_seller, br.is_admin, br.handle], [0, 0, null]);
  const noPw = await create(admin, { role: 'admin' }); assert.equal(noPw.status, 403); const badPw = await create(admin, { role: 'admin', password: 'wrong' }); assert.equal(badPw.status, 403);
  const adm = await create(admin, { role: 'admin', password: admin.pw }); assert.equal(adm.status, 200, adm.text); assert.equal((await row(adm.json.email)).is_admin, 1);
  const a2 = new H.Client(); assert.equal((await a2.post('/api/login', { email: adm.json.email, password: adm.json.tempPassword })).status, 200);
  assert.equal((await a2.post('/api/account/password', { current: adm.json.tempPassword, next: 'brand-new-admin-pass-1' })).status, 200);
  assert.equal((await a2.get('/admin')).status, 200, 'the new admin reaches the dashboard after choosing a password');
});

test('admin password reset: temporary credential, forced change, old password and every session invalidated, ban stays, no duplicate, audited without the password', async () => {
  const admin = await mkAdmin(), user = await H.newUser('Locked'), me = await row(user.email);
  assert.equal((await user.get('/orders')).status, 200, 'logged in before');
  const r = await admin.post(`/api/admin/users/${me.id}/reset-password`, {}); assert.equal(r.status, 200, r.text); assert.equal(r.headers.get('cache-control'), 'no-store');
  const pw = r.json.tempPassword, after = await row(user.email);
  assert.deepEqual([Number(after.must_change_password), after.id], [1, me.id]); assert.ok(verifyPassword(pw, after.password_hash)); assert.equal(verifyPassword('correct-horse-9', after.password_hash), false);
  assert.equal(Number((await q.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', me.id)).n), 0, 'all sessions ended');
  assert.notEqual((await user.get('/orders')).status, 200, 'the old session is dead');
  assert.equal((await new H.Client().post('/api/login', { email: user.email, password: 'correct-horse-9' })).status, 401);
  const fresh = new H.Client(); assert.equal((await fresh.post('/api/login', { email: user.email, password: pw })).status, 200); assert.equal((await fresh.get('/orders')).status, 302, 'forced to the account page');
  assert.equal((await fresh.post('/api/account/password', { current: pw, next: 'a-new-chosen-password-9' })).status, 200); assert.equal((await new H.Client().post('/api/login', { email: user.email, password: pw })).status, 401, 'temporary credential is dead once replaced');
  assert.equal(Number((await q.get('SELECT COUNT(*) n FROM users WHERE email = ?', user.email)).n), 1, 'no duplicate account');
  assert.equal(JSON.stringify(await q.all('SELECT * FROM audit_log')).includes(pw), false); assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'password_reset_by_admin'"));
  assert.equal((await admin.post(`/api/admin/users/${(await row(admin.email)).id}/reset-password`, {})).status, 400, 'not your own'); assert.equal((await admin.post('/api/admin/users/99999999/reset-password', {})).status, 404);
  // a banned account stays banned through a reset
  const bad = await H.newUser('Banned'), brow = await row(bad.email);
  assert.equal((await admin.post(`/api/admin/users/${brow.id}/ban`, { banned: true, reason: 'Fraudulent listing, reviewed by owner' })).status, 200);
  const rr = await admin.post(`/api/admin/users/${brow.id}/reset-password`, {}); assert.equal(rr.status, 200); assert.equal((await row(bad.email)).banned, 1);
  assert.equal((await new H.Client().post('/api/login', { email: bad.email, password: rr.json.tempPassword })).status, 403, 'still suspended');
});

test('a suspended seller (selling paused) stays restricted; email verification is optional, never required for admin-created sellers', async () => {
  const admin = await mkAdmin(), made = await create(admin); const s = new H.Client(); await s.post('/api/login', { email: made.json.email, password: made.json.tempPassword });
  await s.post('/api/account/password', { current: made.json.tempPassword, next: 'a-chosen-password-123' });
  await q.run('UPDATE users SET selling_restricted_at = 1 WHERE email = ?', made.json.email);
  const r = await s.post('/api/seller/listings', { title: 'Blocked', description: 'x', category: 'outerwear', condition: 'good', price: '20', shipping: '4', images: [await H.upload(s)], status: 'active', payment_url: LINK });
  assert.equal(r.status >= 400, true, 'selling restrictions still block publishing');
});
