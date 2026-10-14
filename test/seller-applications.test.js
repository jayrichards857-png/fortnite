'use strict';
// Open selling: ANY signed-in account starts selling immediately (no request, approval, invitation, waitlist or seller limit).
// Anonymous visitors cannot sell; client input never grants roles; payments / external checkout / free listings are unchanged.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');

const keepMode = config.sellerOnboarding;
test.before(async () => { await H.start(); config.sellerOnboarding = 'invite'; });        // production behaviour: the legacy instant-onboarding switch is off
test.after(async () => { config.sellerOnboarding = keepMode; await H.stop(); });

const LINK = 'https://buy.stripe.com/test_apply1';
let n = 0;
const store = () => { n++; return { store_name: `Open Store ${n}`, handle: `open${n}x${Date.now() % 100000}`, country: 'US', region: 'NY', city: 'Brooklyn', agree: true }; };
const mkAdmin = async () => { const a = await H.newUser('Owner'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
const row = async (c) => await q.get('SELECT * FROM users WHERE email = ?', c.email);
const start = (c, over = {}) => c.post('/api/sell/apply', { ...store(), ...over });
const sellers = async () => Number((await q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1')).n);

test('FLOW: new user registers -> starts selling immediately -> publishes a listing; no admin, invitation, request or email verification', async () => {
  const c = new H.Client(), email = `newbuyer${Date.now()}@example.test`;
  assert.equal((await c.post('/api/register', { email, display_name: 'New Buyer', password: 'a-long-password-1', terms: true })).status, 200); c.email = email;
  const u0 = await row(c); assert.deepEqual([u0.is_seller, u0.is_admin, u0.email_verified_at], [0, 0, null]);
  const form = (await c.get('/sell')).text; assert.match(form, /name="store_name"/); assert.match(form, /Start selling/); assert.doesNotMatch(form, /Coming Soon!|Request seller access|waitlist|card number|subscribe/i);
  assert.notEqual((await c.get('/dashboard')).status, 200, 'not a seller yet');
  const r = await start(c, { is_seller: 1, is_admin: 1, role: 'admin', plan: 'pro' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'active');
  const u = await row(c); assert.deepEqual([u.is_seller, u.is_admin, u.is_moderator, u.email_verified_at], [1, 0, 0, null], 'seller only; the injected admin/role fields were ignored');
  assert.equal((await q.get("SELECT COUNT(*) n FROM seller_applications WHERE user_id = ?", u.id)).n, 0, 'no request row is needed');
  for (const url of ['/dashboard', '/dashboard/inventory', '/dashboard/listings/new', '/dashboard/storefront', '/dashboard/settings']) assert.equal((await c.get(url)).status, 200, url);
  const id = await H.makeListing(c, { payment_url: LINK, price: '30.00' });                      // create + publish
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'active');
  assert.equal((await c.get('/sell')).status, 302, 'sellers go to their dashboard'); assert.equal((await start(c)).status, 409, 'already a seller');
  const buyer = await H.newUser('Shopper'); const page = (await buyer.get(`/listing/${id}`)).text;
  assert.match(page, /30\.00/); assert.match(page, /Buy now/, 'external seller checkout is unchanged'); assert.equal((await buyer.get('/shop')).status, 200);
});

test('the legacy /api/sell/onboard endpoint is the same immediate path', async () => {
  const c = await H.newUser('Legacy');
  const r = await c.post('/api/sell/onboard', { ...store(), terms: true }); assert.equal(r.status, 200, r.text);
  assert.equal((await row(c)).is_seller, 1);
});

test('anonymous visitors cannot sell, and need an account first; buyers cannot grant other roles; banned accounts cannot open a store', async () => {
  const anon = new H.Client(), page = (await anon.get('/sell')).text;
  assert.equal((await anon.post('/api/sell/apply', store())).status, 401); assert.equal((await anon.post('/api/sell/onboard', store())).status, 401);
  assert.equal((await anon.post('/api/seller/listings', { title: 'x' })).status, 401);
  assert.doesNotMatch(page, /name="store_name"/, 'no form without an account'); assert.match(page, /You need an account first/);
  const c = await H.newUser('Bad'); await q.run('UPDATE users SET banned = 1 WHERE email = ?', c.email);
  const r = await start(c); assert.ok([401, 403].includes(r.status), String(r.status)); assert.equal((await row(c)).is_seller, 0);
  const m = await H.newUser('Mod'); await start(m, { is_moderator: 1, moderator: true, role: 'moderator' });
  const mu = await row(m); assert.deepEqual([mu.is_seller, mu.is_moderator], [1, 0]);
});

test('input rules still apply: handle, North America, terms ticked; a taken handle is refused; duplicates and parallel submissions are safe', async () => {
  const c = await H.newUser('Rules');
  assert.equal((await start(c, { store_name: '' })).status, 422); assert.equal((await start(c, { handle: 'a b' })).status, 422); assert.equal((await start(c, { country: 'FR' })).status, 422); assert.equal((await start(c, { agree: false })).status, 422);
  assert.equal((await row(c)).is_seller, 0, 'invalid forms grant nothing');
  const other = await H.newSeller('Taker'), taken = await start(c, { handle: other.handle }); assert.equal(taken.status, 422); assert.equal((await row(c)).is_seller, 0);
  const par = await Promise.all(Array.from({ length: 5 }, () => start(c))), ok = par.filter((p) => p.status === 200).length;
  assert.equal(ok, 1, JSON.stringify(par.map((p) => p.status))); assert.ok(par.every((p) => [200, 409, 422].includes(p.status)));
  assert.equal((await row(c)).is_seller, 1);
});

test('no cap, no waitlist, no approval: opening a store works with 10, 50 and 100 existing sellers', async () => {
  for (const target of [10, 50, 100]) {
    const missing = target - await sellers();
    if (missing > 0) await q.run(`INSERT INTO users(email, password_hash, display_name, is_seller, handle, store_name, country, created_at)
      SELECT 'bulk' || g || '-${target}@x.test', 'x', 'Bulk', 1, 'bulk' || g || 'x${target}', 'Bulk Store', 'US', 1 FROM generate_series(1, ${missing}) g`);
    assert.ok(await sellers() >= target);
    const c = await H.newUser('Late' + target), r = await start(c);
    assert.equal(r.status, 200, `${target} sellers: ${r.text}`); assert.equal((await row(c)).is_seller, 1);
    assert.doesNotMatch((await H.newUser('V' + target).then((v) => v.get('/sell'))).text, /waitlist|capacity|no spots|\bis full\b/i);
  }
  assert.ok(await sellers() > 100);
});

test('existing sellers and admins keep their access; ordinary accounts cannot reach admin or moderator tools', async () => {
  const admin = await mkAdmin(), old = await H.newSeller('Old'), c = await H.newUser('Newbie');
  await start(c);
  assert.equal((await old.get('/dashboard')).status, 200); assert.equal((await c.get('/dashboard')).status, 200); assert.equal((await admin.get('/admin')).status, 200);
  assert.notEqual((await c.get('/admin')).status, 200, 'a new seller is not an admin'); assert.notEqual((await c.get('/moderation')).status, 200);
  const buyer = await H.newUser('Plain');
  for (const url of ['/dashboard', '/dashboard/inventory', '/dashboard/listings/new']) assert.equal((await buyer.get(url)).status, 302, url);
  assert.equal((await buyer.post('/api/seller/listings', { title: 'x' })).status, 403, 'a buyer who has not opened a store cannot list');
});

test('older pending requests (filed before selling became immediate) are closed automatically, and admins can still decide them', async () => {
  const admin = await mkAdmin(), c = await H.newUser('Old request'), u = await row(c);
  const ins = (uid, h) => q.insert("INSERT INTO seller_applications(user_id, store_name, handle, country, region, city, status, created_at) VALUES(?,?,?,?,?,?,?,?)", uid, 'Old', h, 'US', 'NY', 'B', 'pending', 1);
  await ins(u.id, 'oldreq' + Date.now() % 100000);
  assert.equal((await start(c)).status, 200);
  assert.equal((await q.get("SELECT COUNT(*) n FROM seller_applications WHERE user_id = ? AND status = 'pending'", u.id)).n, 0);
  const d = await H.newUser('Decided'), du = await row(d), id = await ins(du.id, 'oldreq2x' + Date.now() % 100000);
  assert.equal((await admin.post(`/api/admin/applications/${id}/approve`, {})).status, 200); assert.equal((await row(d)).is_seller, 1);
  const outsider = await H.newUser('Out'); assert.ok([401, 403].includes((await outsider.post(`/api/admin/applications/${id}/approve`, {})).status));
});
