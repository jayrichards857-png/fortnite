'use strict';
// Order creation, persistence, visibility and manual payment confirmation (direct-to-seller model: PairPlug never handles money).
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const { expireStaleCheckouts } = require('../src/payments');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_orders123';
const row = async (id) => await q.get('SELECT * FROM orders WHERE id = ?', id);
const listing = async (id) => await q.get('SELECT * FROM listings WHERE id = ?', id);
const buy = (buyer, id) => buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address });
async function scene(title = 'Orders test jacket') {
  const seller = await H.newSeller('Ord'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: '6.00', shipping_payer: 'buyer', title });
  return { seller, buyer, id };
}
const sellerPage = async (c, qs = '') => (await c.get('/dashboard/orders' + qs));
const buyerPage = async (c) => (await c.get('/orders'));

test('a purchase creates a durable order that the seller and buyer both see (awaiting payment confirmation), newest first', async () => {
  const { seller, buyer, id } = await scene('Visible jacket');
  const r = await buy(buyer, id);
  assert.equal(r.status, 200, r.text); assert.equal(r.json.ok, true); assert.equal(r.json.reference, `PP-${r.json.orderId}`); assert.equal(r.json.redirect, `/orders/${r.json.orderId}`);
  const o = await row(r.json.orderId); assert.ok(o, 'the response refers to a persisted row'); assert.equal(o.status, 'pending_payment'); assert.equal(o.payment_mode, 'external'); assert.equal(o.payment_confirmed_at, null); assert.equal(o.payment_confirmed_by, null);
  assert.equal((await q.get('SELECT COUNT(*) n FROM order_items WHERE order_id = ?', o.id)).n, 1); assert.equal((await listing(id)).status, 'reserved');
  const sp = (await sellerPage(seller)).text;
  assert.match(sp, /Awaiting your payment confirmation/); assert.match(sp, new RegExp(`#${o.id}`)); assert.match(sp, /Visible jacket/); assert.match(sp, /Unconfirmed/); assert.match(sp, /Confirm payment/); assert.doesNotMatch(sp, /No orders/);
  const bp = (await buyerPage(buyer)).text; assert.match(bp, new RegExp(`#${o.id}`)); assert.match(bp, new RegExp(`PP-${o.id}`)); assert.match(bp, /Visible jacket/); assert.match(bp, /Awaiting payment confirmation/);
  // the order link from the response works for the buyer
  assert.equal((await buyer.get(r.json.redirect)).status, 200);
  // newest first
  const id2 = await H.makeListing(seller, { payment_url: LINK, title: 'Second jacket' }), r2 = await buy(buyer, id2);
  const sp2 = (await sellerPage(seller)).text; assert.ok(sp2.indexOf(`#${r2.json.orderId}<`) < sp2.indexOf(`#${o.id}<`), 'newest order listed first');
  const bp2 = (await buyerPage(buyer)).text; assert.ok(bp2.indexOf(`#${r2.json.orderId}<`) < bp2.indexOf(`#${o.id}<`));
  // a repeated click returns the same order rather than creating a second
  assert.equal((await buy(buyer, id2)).json.orderId, r2.json.orderId); assert.equal((await q.get('SELECT COUNT(*) n FROM orders WHERE buyer_id = (SELECT buyer_id FROM orders WHERE id = ?) AND status = \'pending_payment\'', o.id)).n, 2);
});

test('only a genuinely empty list shows the empty state, and nobody sees anyone else\'s orders', async () => {
  const { seller, buyer, id } = await scene('Private jacket'), idle = await H.newSeller('Idle'), stranger = await H.newUser('Stranger');
  const empty = await sellerPage(idle); assert.equal(empty.status, 200); assert.match(empty.text, /No orders/);
  assert.match((await buyerPage(stranger)).text, /No orders/);
  const r = await buy(buyer, id);
  for (const c of [idle, stranger]) { const t = (await (c === idle ? await sellerPage(c) : await buyerPage(c))).text; assert.doesNotMatch(t, /Private jacket/); assert.doesNotMatch(t, new RegExp(`PP-${r.json.orderId}`)); }
  // direct access is refused (404, not 403, so existence isn't confirmed)
  assert.equal((await stranger.get(`/orders/${r.json.orderId}`)).status, 404); assert.equal((await idle.get(`/dashboard/orders/${r.json.orderId}`)).status, 404);
  assert.equal((await idle.post(`/api/seller/orders/${r.json.orderId}/confirm-payment`)).status, 404); assert.equal((await idle.post(`/api/seller/orders/${r.json.orderId}/reject-payment`)).status, 404);
  assert.equal((await stranger.post(`/api/orders/${r.json.orderId}/claim-paid`)).status, 404); assert.equal((await stranger.post(`/api/orders/${r.json.orderId}/cancel-purchase`)).status, 404);
  assert.equal((await buyer.post(`/api/seller/orders/${r.json.orderId}/confirm-payment`)).status, 403, 'a buyer cannot confirm payment');
  assert.equal((await row(r.json.orderId)).status, 'pending_payment');
});

test('nothing the buyer does marks an order paid; only the seller\'s explicit confirmation does', async () => {
  const { seller, buyer, id } = await scene(), o = (await buy(buyer, id)).json.orderId;
  const pay = await buyer.get(`/orders/${o}/pay`); assert.ok([200, 302].includes(pay.status));
  assert.equal((await buyer.post(`/api/orders/${o}/claim-paid`)).status, 200);
  assert.equal((await row(o)).status, 'pending_payment'); assert.equal((await listing(id)).status, 'reserved'); assert.equal((await row(o)).payment_confirmed_at, null);
  assert.match((await sellerPage(seller)).text, /Awaiting your payment confirmation/);
});

test('confirming payment: order paid, listing sold, who/when recorded, visible to both, a second buyer is blocked, sold stays in inventory', async () => {
  const { seller, buyer, id } = await scene('Sold jacket'), other = await H.newUser('Late'), o = (await buy(buyer, id)).json.orderId;
  const c = await seller.post(`/api/seller/orders/${o}/confirm-payment`, { reference: 'ch_test_123' }); assert.equal(c.status, 200);
  const sellerId = (await q.get('SELECT id FROM users WHERE handle = ?', seller.handle)).id, r = await row(o);
  assert.equal(r.status, 'paid'); assert.equal(r.payment_confirmed_by, sellerId); assert.ok(r.payment_confirmed_at); assert.equal((await listing(id)).status, 'sold');
  assert.ok(await q.get("SELECT 1 x FROM order_events WHERE order_id = ? AND to_status = 'paid' AND actor = ?", o, `seller:${sellerId}`));
  const sp = (await sellerPage(seller)).text; assert.match(sp, /Paid — ready to ship/); assert.match(sp, /Confirmed by you/); assert.match(sp, /Ship/);
  assert.match((await buyerPage(buyer)).text, /Payment Confirmed|paid/i);
  assert.equal((await buy(other, id)).status, 409, 'a second buyer cannot purchase a sold listing'); assert.equal((await q.get('SELECT COUNT(*) n FROM orders WHERE checkout_id IN (SELECT id FROM checkouts WHERE buyer_id = (SELECT id FROM users WHERE email = ?))', other.email)).n, 0);
  const inv = (await seller.get('/dashboard/inventory?status=sold')).text; assert.match(inv, /Sold jacket/); assert.match(inv, /Sold/);
  assert.match((await seller.get('/dashboard/inventory')).text, /Sold jacket/, 'sold listings remain in the inventory');
});

test('releasing an unpaid reservation re-opens the item, keeps the order visible as cancelled, and never disturbs another reservation or a sale', async () => {
  const { seller, buyer, id } = await scene('Release jacket'), second = await H.newUser('Second'), o = (await buy(buyer, id)).json.orderId;
  assert.equal((await seller.post(`/api/seller/orders/${o}/reject-payment`)).status, 200);
  assert.equal((await row(o)).status, 'cancelled'); assert.equal((await listing(id)).status, 'active'); assert.equal((await listing(id)).reserved_checkout_id, null);
  assert.match((await sellerPage(seller)).text, /Cancelled, released and refunded/); assert.match((await sellerPage(seller)).text, /Not paid/); assert.match((await buyerPage(buyer)).text, new RegExp(`#${o}`), 'cancelled orders stay in the buyer\'s history');
  // second buyer reserves; a repeated release of the FIRST order must not free the second buyer's reservation
  const o2 = (await buy(second, id)).json.orderId; assert.equal((await listing(id)).status, 'reserved');
  assert.equal((await seller.post(`/api/seller/orders/${o}/reject-payment`)).status, 200, 'repeat is harmless'); assert.equal((await listing(id)).status, 'reserved'); assert.equal((await row(o2)).status, 'pending_payment');
  // ...and once paid, neither a late release of the first order nor of the second can reopen it
  assert.equal((await seller.post(`/api/seller/orders/${o2}/confirm-payment`)).status, 200);
  assert.equal((await seller.post(`/api/seller/orders/${o}/reject-payment`)).status, 200); assert.equal((await seller.post(`/api/seller/orders/${o2}/reject-payment`)).status, 409, 'a paid order cannot be released'); assert.equal((await listing(id)).status, 'sold');
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 409, 'a released reservation cannot be confirmed'); assert.equal((await row(o)).status, 'cancelled');
  // expiry path: the order is cancelled but still listed, and the item is re-opened only because nothing else holds it
  const s2 = await scene('Expiring jacket'), o3 = (await buy(s2.buyer, s2.id)).json.orderId;
  await q.run('UPDATE checkouts SET expires_at = 1 WHERE id = ?', (await row(o3)).checkout_id); await expireStaleCheckouts();
  assert.equal((await row(o3)).status, 'cancelled'); assert.equal((await listing(s2.id)).status, 'active'); assert.match((await sellerPage(s2.seller)).text, /Expiring jacket/); assert.match((await buyerPage(s2.buyer)).text, /Expiring jacket/);
});

test('duplicate confirmation / release requests (double clicks, retries, parallel) leave exactly one consistent result', async () => {
  const { seller, id, buyer } = await scene(), o = (await buy(buyer, id)).json.orderId;
  const rs = await Promise.all(Array.from({ length: 6 }, () => seller.post(`/api/seller/orders/${o}/confirm-payment`)));
  assert.ok(rs.every((r) => r.status === 200)); assert.equal(rs.filter((r) => !r.json.alreadyConfirmed).length, 1, 'exactly one request did the work');
  assert.equal((await q.get("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND to_status = 'paid'", o)).n, 1); assert.equal((await row(o)).status, 'paid'); assert.equal((await listing(id)).status, 'sold');
  const at = (await row(o)).payment_confirmed_at; await seller.post(`/api/seller/orders/${o}/confirm-payment`); assert.equal((await row(o)).payment_confirmed_at, at, 'the original confirmation timestamp is never rewritten');
  const b = await scene(), ob = (await buy(b.buyer, b.id)).json.orderId;
  const rr = await Promise.all(Array.from({ length: 4 }, () => b.seller.post(`/api/seller/orders/${ob}/reject-payment`))); assert.ok(rr.every((r) => r.status === 200));
  assert.equal((await q.get("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND to_status = 'cancelled'", ob)).n, 1); assert.equal((await listing(b.id)).status, 'active');
  // confirm racing release: one wins, state stays consistent
  const c = await scene(), oc = (await buy(c.buyer, c.id)).json.orderId;
  await Promise.all([c.seller.post(`/api/seller/orders/${oc}/confirm-payment`), c.seller.post(`/api/seller/orders/${oc}/reject-payment`)]);
  const st = (await row(oc)).status; assert.ok(['paid', 'cancelled'].includes(st)); assert.equal((await listing(c.id)).status, st === 'paid' ? 'sold' : 'active');
});

test('orders persist: a fresh database connection and a fresh login still show them', async () => {
  const { seller, buyer, id } = await scene('Persistent jacket'), o = (await buy(buyer, id)).json.orderId; await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  const { Client } = require('pg'); const fresh = new Client({ connectionString: process.env.DATABASE_URL }); await fresh.connect();     // a brand-new connection, not the app's pool
  try { const r = (await fresh.query('SELECT status, payment_confirmed_by FROM orders WHERE id = $1', [o])).rows[0]; assert.equal(r.status, 'paid'); assert.ok(r.payment_confirmed_by); assert.equal((await fresh.query('SELECT status FROM listings WHERE id = $1', [id])).rows[0].status, 'sold'); } finally { await fresh.end(); }
  const again = new H.Client(); assert.equal((await again.post('/api/login', { email: seller.email, password: 'correct-horse-9' })).status, 200);
  assert.match((await sellerPage(again)).text, /Persistent jacket/);
  const b2 = new H.Client(); await b2.post('/api/login', { email: buyer.email, password: 'correct-horse-9' }); assert.match((await buyerPage(b2)).text, /Persistent jacket/);
});

test('a database failure is an error page, never presented as "no orders"; a failed purchase never claims an order', async () => {
  const { seller, buyer, id } = await scene('Error jacket'), o = (await buy(buyer, id)).json.orderId, orig = q.all;
  q.all = (sql, ...a) => { if (/FROM orders o/.test(sql)) throw new Error('simulated database failure'); return orig(sql, ...a); };
  try {
    for (const [c, url] of [[seller, '/dashboard/orders'], [buyer, '/orders']]) {
      const r = await c.get(url); assert.equal(r.status, 500, url); assert.doesNotMatch(r.text, /No orders/i); assert.doesNotMatch(r.text, /simulated database failure/, 'internals are not shown'); assert.match(r.text, /Something went wrong/);
    }
  } finally { q.all = orig; }
  assert.match((await sellerPage(seller)).text, new RegExp(`#${o}`), 'and the order was never lost');
  // a purchase that fails reports an honest error and creates nothing
  const other = await H.newUser('Unlucky'), before = (await q.get('SELECT COUNT(*) n FROM orders')).n;
  const fail = await buy(other, id); assert.equal(fail.status, 409); assert.ok(fail.json.error); assert.equal(fail.json.orderId, undefined); assert.equal((await q.get('SELECT COUNT(*) n FROM orders')).n, before);
  assert.equal((await other.post('/api/purchases', { listingId: id, acknowledged: false, address: H.address })).status, 422); assert.equal((await q.get('SELECT COUNT(*) n FROM orders')).n, before);
});

test('migration 7 backfills who confirmed existing paid direct orders from their immutable history', async () => {
  const { MIGRATIONS } = require('../src/db'); assert.ok(MIGRATIONS.length >= 7);
  const { seller, buyer, id } = await scene('Backfill jacket'), o = (await buy(buyer, id)).json.orderId; await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  const who = (await row(o)).payment_confirmed_by; assert.ok(who);
  await q.run('UPDATE orders SET payment_confirmed_by = NULL WHERE id = ?', o);                          // simulate an order paid before the column existed
  const backfill = MIGRATIONS[6].split('\n').filter((l) => !/^ALTER TABLE/.test(l)).join('\n');   // the UPDATE part of migration 7
  await q.run(backfill);
  assert.equal((await row(o)).payment_confirmed_by, who, 'restored from the order history'); void config;
});
