'use strict';
// Private-beta access: Sell => Coming Soon (server-enforced), open buyer sign-up, invitation-only sellers (cap 3, buyers excluded).
process.env.CHECKOUT_MODE = 'external';
process.env.SELLER_ONBOARDING = 'invite';          // the real beta behaviour (helpers default to 'open' only so older suites can mint sellers)
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => { await H.start(); await q.run("UPDATE settings SET value = '3' WHERE key = 'seller_cap'"); });
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_access123';
const tokenOf = (link) => link.split('/').pop();
async function admin() { const a = await H.newUser('Admin'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; }
async function approvedSeller(adm, key) {
  const email = `${key}-${Date.now()}@example.test`;
  const inv = await adm.post('/api/admin/invitations', { kind: 'seller', email }); assert.equal(inv.status, 200, inv.text);
  const c = new H.Client(); c.email = email; c.handle = `${key}${Date.now() % 100000}`;
  const r = await c.post('/api/invitations/accept', { token: tokenOf(inv.json.link), display_name: `Seller ${key}`, password: 'a-long-password-1', store_name: `Store ${key}`, handle: c.handle, country: 'US', region: 'NY', city: 'Brooklyn', agree: true, terms: true });
  assert.equal(r.status, 200, r.text);
  await q.run("UPDATE users SET email_verified_at = CAST(EXTRACT(EPOCH FROM now()) AS BIGINT) WHERE email = ?", email);
  return c;
}
const listingBody = (file) => ({ title: 'Wool sweater', description: 'Warm', category: 'clothing', condition: 'good', size: 'M', price: '30.00', shipping: '5.00', shipping_payer: 'buyer', weight_oz: 20, payment_url: LINK, images: [file], status: 'active' });

test('visitors can browse home, shop, categories and listings without logging in; no seller-acquisition CTAs', async () => {
  const adm = await admin(), seller = await approvedSeller(adm, 'browse');
  const id = await H.makeListing(seller, { payment_url: LINK });
  const anon = new H.Client();
  for (const url of ['/', '/shop', '/shop?category=outerwear', `/listing/${id}`, `/s/${seller.handle}`, '/login', '/register', '/support']) assert.equal((await anon.get(url)).status, 200, url);
  const home = (await anon.get('/')).text;
  assert.match(home, /href="\/login"/); assert.match(home, /href="\/register"/); assert.doesNotMatch(home, /List now|Start selling|Become a seller/i);
  assert.doesNotMatch((await anon.get('/shop')).text, /List now|Start selling|Become a seller/i);
});

test('the Sell page lets any signed-in account open a store immediately; anonymous visitors are asked to sign in first', async () => {
  const anon = new H.Client(), buyer = await H.newUser('Plain'), adm = await admin();
  assert.match((await anon.get('/')).text, /href="\/sell"/, 'the Sell link is in the navigation');
  const a = (await anon.get('/sell')).text; assert.match(a, /Sell on Grailedside/); assert.match(a, /href="\/register\?next=\/sell"/); assert.match(a, /href="\/login\?next=\/sell"/); assert.doesNotMatch(a, /Coming Soon!|name="store_name"/);
  for (const who of [buyer, adm]) { const r = (await who.get('/sell')).text; assert.match(r, /name="store_name"/); assert.match(r, /Start selling/); assert.match(r, /free|no fee/i); assert.doesNotMatch(r, /Coming Soon!|Request seller access|waitlist|approval needed/i); }
  const body = (h) => ({ store_name: 'X', handle: h, country: 'US', region: 'NY', city: 'B', agree: true, terms: true });
  assert.equal((await anon.post('/api/sell/onboard', body('sneaky1'))).status, 401, 'anonymous visitors cannot sell');
  assert.equal((await anon.post('/api/sell/apply', body('sneaky1'))).status, 401);
  assert.equal((await buyer.post('/api/sell/onboard', body('plain' + Date.now() % 1e6))).status, 200, 'a plain buyer opens a store with no approval');
  assert.equal((await q.get('SELECT is_seller s FROM users WHERE email = ?', buyer.email)).s, 1);
  assert.equal((await buyer.get('/dashboard')).status, 200);
  assert.equal((await adm.post('/api/sell/apply', body('adm' + Date.now() % 1e6))).status, 200);
  assert.equal((await q.get('SELECT is_admin a FROM users WHERE email = ?', adm.email)).a, 1, 'admins keep their role');
});

test('buyer registration and login work; sign-up can never grant seller or admin privileges', async () => {
  const c = new H.Client(), email = `buyer-${Date.now()}@example.test`;
  const reg = await c.post('/api/register', { email, display_name: 'Buyer One', terms: true, password: 'a-long-password-1', is_seller: 1, is_admin: 1, role: 'admin', handle: 'x', store_name: 'x' });
  assert.equal(reg.status, 200, reg.text);
  assert.deepEqual({ ...await q.get('SELECT is_seller, is_admin, handle FROM users WHERE email = ?', email) }, { is_seller: 0, is_admin: 0, handle: null });
  const login = new H.Client();
  assert.equal((await login.post('/api/login', { email, password: 'wrong-password-1' })).status, 401);
  assert.equal((await login.post('/api/login', { email, password: 'a-long-password-1' })).status, 200);
  assert.equal((await login.get('/orders')).status, 200);
  assert.equal((await new H.Client().post('/api/register', { email, display_name: 'Dup', terms: true, password: 'a-long-password-1' })).status, 422, 'duplicate email');
});

test('buyers cannot publish listings or reach seller-only pages and endpoints', async () => {
  const adm = await admin(), seller = await approvedSeller(adm, 'guarded'), buyer = await H.newUser('Plain');
  const file = await H.upload(buyer);
  for (const [m, url, body] of [['post', '/api/seller/listings', listingBody(file)], ['put', '/api/seller/storefront', { announcement: 'hi' }], ['post', '/api/seller/storefront/publish', {}], ['put', '/api/seller/settings', { store_name: 'x' }]]) {
    assert.equal((await buyer[m](url, body)).status, 403, `${m} ${url}`);
  }
  for (const url of ['/dashboard', '/dashboard/listings/new', '/dashboard/inventory', '/dashboard/orders', '/dashboard/storefront', '/dashboard/settings']) {
    const r = await buyer.get(url); assert.equal(r.status, 302, url); assert.equal(r.headers.get('location'), '/sell', url);
  }
  assert.equal((await new H.Client().post('/api/seller/listings', listingBody(file))).status, 401);
  const lid = await H.makeListing(seller, { payment_url: LINK });
  assert.equal((await buyer.post(`/api/seller/listings/${lid}/pause`)).status, 403);
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', lid)).status, 'active');
});

test('there is no seller limit: many sellers can exist, buyers stay buyers, and sign-up stays open', async () => {
  const adm = await admin();
  for (let i = 0; i < 6; i++) await H.newUser('Many');                 // buyers
  for (let i = 0; i < 5; i++) await approvedSeller(adm, `many${i}`);
  const n = (await q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1')).n;
  assert.ok(n >= 5, 'five more sellers than any old cap of 3 were created');
  assert.equal((await adm.post('/api/admin/invitations', { kind: 'seller', email: `more-${Date.now()}@example.test` })).status, 200, 'another seller invitation is accepted');
  await q.run("INSERT INTO users(email, password_hash, display_name, is_seller, handle, created_at) VALUES('x4@x.test','x','X',1,'x4',1)");   // no database trigger blocks it any more
  assert.equal((await new H.Client().post('/api/register', { email: `after-${Date.now()}@example.test`, display_name: 'Late Buyer', terms: true, password: 'a-long-password-1' })).status, 200, 'buyer sign-up works');
});

test('approved sellers keep seller access after logging in again', async () => {
  const adm = await admin();
  let s = await q.get("SELECT email, handle FROM users WHERE is_seller = 1 AND banned = 0 LIMIT 1");
  const email = s ? s.email : null;
  const seller = email ? Object.assign(new H.Client(), { email, handle: s.handle }) : await approvedSeller(adm, 'keeper');
  const re = new H.Client();
  assert.equal((await re.post('/api/login', { email: seller.email, password: 'a-long-password-1' })).status, 200);
  for (const url of ['/dashboard', '/dashboard/inventory', '/dashboard/listings/new', '/dashboard/storefront', '/dashboard/settings']) assert.equal((await re.get(url)).status, 200, url);
  const file = await H.upload(re);
  const r = await re.post('/api/seller/listings', listingBody(file));
  assert.equal(r.status, 200, r.text);
  assert.match((await re.get('/')).text, /href="\/dashboard"/, 'the nav sends sellers to their dashboard');
});

test('admins can approve seller access via an invitation and manage the admin role with password confirmation and audit logging', async () => {
  const adm = await admin(), target = await H.newUser('Target'), other = await H.newUser('Other');
  const tid = (await q.get('SELECT id FROM users WHERE email = ?', target.email)).id;
  assert.equal((await target.post(`/api/admin/users/${tid}/seller-invite`)).status, 403, 'non-admin cannot');
  const inv = await adm.post(`/api/admin/users/${tid}/seller-invite`);
  assert.equal(inv.status, 200); assert.match(inv.json.link, /\/invite\/pp_inv_/);
  // admin role
  const oid = (await q.get('SELECT id FROM users WHERE email = ?', other.email)).id;
  assert.equal((await adm.post(`/api/admin/users/${oid}/admin`, { admin: true, password: 'wrong-password' })).status, 403);
  assert.equal((await target.post(`/api/admin/users/${oid}/admin`, { admin: true, password: 'a-long-password-1' })).status, 403);
  assert.equal((await adm.post(`/api/admin/users/${oid}/admin`, { admin: true, password: 'correct-horse-9' })).status, 200);
  assert.equal((await q.get('SELECT is_admin a FROM users WHERE id = ?', oid)).a, 1);
  assert.equal((await other.get('/admin')).status, 200);
  const admId = (await q.get('SELECT id FROM users WHERE email = ?', adm.email)).id;
  assert.equal((await adm.post(`/api/admin/users/${admId}/admin`, { admin: false, password: 'correct-horse-9' })).status, 400, 'not yourself');
  assert.equal((await adm.post(`/api/admin/users/${oid}/admin`, { admin: false, password: 'correct-horse-9' })).status, 200);
  assert.notEqual((await other.get('/admin')).status, 200);
  const acts = (await q.all("SELECT action FROM audit_log WHERE action IN ('admin_granted','admin_revoked')")).map((a) => a.action);
  assert.ok(acts.includes('admin_granted') && acts.includes('admin_revoked'));
});
