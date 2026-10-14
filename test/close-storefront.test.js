'use strict';
// A store owner (including an admin) can close their own storefront: it leaves public view and discovery, selling stops, the account and
// admin role survive, history is kept, and it can be reopened. No schema change: it uses users.is_seller.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_close1';
const row = async (c) => await q.get('SELECT * FROM users WHERE email = ?', c.email);

test('an admin who opened a store closes it: gone from public pages and discovery; account, admin tools and history stay; reopening works', async () => {
  const adm = await H.newUser('Boss'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', adm.email);
  assert.equal((await adm.post('/api/sell/onboard', { store_name: 'Accidental Store', handle: 'accidental' + Date.now() % 100000, country: 'US', region: 'NY', city: 'B', agree: true, terms: true })).status, 200);
  const u = await row(adm), id = await H.makeListing(adm, { payment_url: LINK, price: '12.00' }), anon = new H.Client();
  assert.equal((await anon.get(`/s/${u.handle}`)).status, 200); assert.equal((await anon.get(`/listing/${id}`)).status, 200);
  assert.match((await anon.get('/shop')).text, /Accidental Store|12\.00/);
  assert.match((await adm.get('/dashboard/settings')).text, /Close storefront/);

  assert.equal((await adm.post('/api/sell/close', {})).status, 422, 'confirmation is required');
  assert.equal((await new H.Client().post('/api/sell/close', { confirm: true })).status, 401, 'anonymous callers cannot');
  assert.equal((await adm.post('/api/sell/close', { confirm: true })).status, 200);

  const after = await row(adm); assert.deepEqual([after.is_seller, after.is_admin, after.banned], [0, 1, 0], 'account and admin role preserved');
  assert.equal(after.handle, u.handle, 'store details kept for reopening');
  for (const url of [`/s/${u.handle}`, `/listing/${id}`]) assert.equal((await anon.get(url)).status, 404, `${url} is no longer public`);
  const shop = (await anon.get('/shop')).text, sellers = (await anon.get('/shop?tab=sellers')).text;
  assert.doesNotMatch(shop + sellers + (await anon.get('/')).text + (await anon.get('/sellers')).text, /Accidental Store/, 'not in discovery');
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'archived', 'listing archived, not deleted');
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'storefront_closed'"));

  assert.equal((await adm.get('/dashboard')).status, 302, 'seller dashboard closed'); assert.equal((await adm.post('/api/seller/listings', { title: 'x' })).status, 403, 'no new listings');
  assert.equal((await adm.put('/api/seller/settings', { store_name: 'x' })).status, 403);
  assert.equal((await adm.get('/admin')).status, 200); assert.equal((await adm.get('/admin/users')).status, 200); assert.equal((await adm.get('/account')).status, 200);
  assert.match((await adm.get('/sell')).text, /Reopen my storefront/);

  assert.equal((await adm.post('/api/sell/reopen', {})).status, 200);
  assert.equal((await row(adm)).is_seller, 1); assert.equal((await anon.get(`/s/${u.handle}`)).status, 200); assert.equal((await adm.get('/dashboard')).status, 200);
  assert.equal((await adm.post('/api/sell/reopen', {})).status, 409);
});

test('closing is refused while there are open orders (transaction records are protected); other accounts cannot reopen or close for someone else', async () => {
  const seller = await H.newSeller('Busy'), buyer = await H.newUser('Cust'), id = await H.makeListing(seller, { payment_url: LINK, price: '20.00' });
  const o = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: { name: 'B', line1: '1 Main', city: 'Austin', region: 'TX', postal: '78701', country: 'US' } });
  assert.equal(o.status, 200, o.text);
  const r = await seller.post('/api/sell/close', { confirm: true }); assert.equal(r.status, 409); assert.match(r.json.error, /open order/);
  assert.equal((await row(seller)).is_seller, 1);
  assert.equal((await buyer.post('/api/sell/close', { confirm: true })).status, 409, 'a buyer has no storefront to close');
  assert.equal((await buyer.post('/api/sell/reopen', {})).status, 404, 'and nothing to reopen');
  assert.ok(await q.get('SELECT 1 x FROM orders WHERE id = ?', o.json.orderId), 'order kept');
});

test('a store with no orders closes straightforwardly; a banned owner cannot reopen', async () => {
  const s = await H.newSeller('Quiet'); await H.makeListing(s, { payment_url: LINK });
  assert.equal((await s.post('/api/sell/close', { confirm: true })).status, 200);
  await q.run('UPDATE users SET banned = 1 WHERE email = ?', s.email);
  const r = await s.post('/api/sell/reopen', {}); assert.ok([401, 403].includes(r.status), String(r.status)); assert.equal((await row(s)).is_seller, 0);
});
