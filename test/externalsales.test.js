'use strict';
// Manually sold listings vs orders: external-sale records (the seller's own bookkeeping), kept strictly apart from genuine PairPlug orders.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_ext_sale1';
const counts = () => ({ orders: q.get('SELECT COUNT(*) n FROM orders').n, checkouts: q.get('SELECT COUNT(*) n FROM checkouts').n, users: q.get('SELECT COUNT(*) n FROM users').n, events: q.get('SELECT COUNT(*) n FROM order_events').n });
const listing = (id) => q.get('SELECT * FROM listings WHERE id = ?', id);
const sales = (id) => q.all('SELECT * FROM external_sales WHERE listing_id = ?', id);
async function seller(title = 'Ext sale hoodie') { const s = await H.newSeller('Ext'); const id = await H.makeListing(s, { payment_url: LINK, title }); return { s, id }; }
const ordersPage = async (c) => (await c.get('/dashboard/orders')).text;

test('root cause: marking an item Sold by hand never created an order; such items are surfaced, not silently converted', async () => {
  const { s, id } = await seller('Hand-sold hoodie'), before = counts();
  q.run("UPDATE listings SET status = 'sold' WHERE id = ?", id);                        // exactly what the old inventory "Mark sold" did: listing status only
  assert.deepEqual(counts(), before, 'no order, checkout or buyer exists for it');
  const page = await ordersPage(s);
  assert.match(page, /Sold items with no sales record/); assert.match(page, /Hand-sold hoodie/); assert.match(page, /Record external sale/); assert.match(page, /Nothing was converted automatically/);
  assert.doesNotMatch(page, /<h2[^>]*>No orders/); assert.match(page, /No PairPlug orders yet/);
  assert.deepEqual(counts(), before, 'viewing the page creates nothing'); assert.equal(sales(id).length, 0);
  const inv = (await s.get('/dashboard/inventory')).text; assert.match(inv, /Hand-sold hoodie/); assert.match(inv, /Record sale/);
});

test('recording an external sale: marks the listing Sold, stores the seller\'s details, creates no buyer/order/payment, and is clearly labelled', async () => {
  const { s, id } = await seller('Pink hoodie'), before = counts();
  const form = await s.get(`/dashboard/listings/${id}/external-sale`); assert.equal(form.status, 200); assert.match(form.text, /sale made outside PairPlug/); assert.match(form.text, /does not verify the sale or any payment/); assert.match(form.text, /name="sold_on"/);
  const r = await s.post(`/api/seller/listings/${id}/external-sale`, { sold_on: '2026-10-01', price: '85.00', channel: 'In person', reference: 'cash', note: 'Sold at the pop-up' });
  assert.equal(r.status, 200, r.text); assert.equal(listing(id).status, 'sold');
  const [x] = sales(id); assert.equal(x.sold_on, '2026-10-01'); assert.equal(x.price_cents, 8500); assert.equal(x.channel, 'In person'); assert.equal(x.reference, 'cash'); assert.equal(x.note, 'Sold at the pop-up'); assert.equal(x.seller_id, q.get('SELECT id FROM users WHERE handle = ?', s.handle).id);
  assert.deepEqual(counts(), before, 'no fake buyer, checkout, order or payment event was created');
  const page = await ordersPage(s);
  assert.match(page, /External sales you recorded/); assert.match(page, /Pink hoodie/); assert.match(page, /2026-10-01/); assert.match(page, /\$85\.00/); assert.match(page, /In person · cash/); assert.match(page, /Sold <strong>outside PairPlug<\/strong>/); assert.match(page, /not PairPlug orders, and PairPlug has not verified the sale or any payment/);
  assert.doesNotMatch(page, /Confirmed by you|Paid — ready to ship/, 'never shown as a verified payment'); assert.doesNotMatch(page, /Sold items with no sales record/);
  assert.match((await s.get('/dashboard/inventory')).text, /Pink hoodie/); assert.doesNotMatch((await s.get('/dashboard/inventory')).text, /Record sale/);
  assert.match((await s.get(`/dashboard/listings/${id}/external-sale`)).text, /Already recorded/);
  assert.ok(q.get("SELECT 1 x FROM audit_log WHERE action = 'external_sale_recorded'"));
  // the item is gone from the shop for buyers
  const buyer = await H.newUser('Late'); assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 409);
});

test('an already-Sold listing can be recorded once; price and details are optional; legacy mark-sold also writes a record', async () => {
  const { s, id } = await seller('Optional fields'); q.run("UPDATE listings SET status = 'sold' WHERE id = ?", id);
  assert.equal((await s.post(`/api/seller/listings/${id}/external-sale`, {})).status, 200); const [x] = sales(id); assert.equal(x.price_cents, null); assert.equal(x.sold_on, new Date().toISOString().slice(0, 10)); assert.equal(x.channel, null);
  assert.match(await ordersPage(s), /not recorded/);
  const b = await seller('Legacy button'); assert.equal((await b.s.post(`/api/seller/listings/${b.id}/mark-sold`)).status, 200); assert.equal(sales(b.id).length, 1); assert.equal(listing(b.id).status, 'sold');
});

test('duplicates, validation and immutability', async () => {
  const { s, id } = await seller('Dup'); assert.equal((await s.post(`/api/seller/listings/${id}/external-sale`, { price: '10' })).status, 200);
  assert.equal((await s.post(`/api/seller/listings/${id}/external-sale`, { price: '10' })).status, 409); assert.equal(sales(id).length, 1);
  const c = await seller('Parallel'); const rs = await Promise.all(Array.from({ length: 5 }, () => c.s.post(`/api/seller/listings/${c.id}/external-sale`, { price: '5' })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 4); assert.equal(sales(c.id).length, 1);
  const v = await seller('Validation'), bad = (b) => v.s.post(`/api/seller/listings/${v.id}/external-sale`, b);
  assert.equal((await bad({ sold_on: '2999-01-01' })).status, 422); assert.equal((await bad({ sold_on: 'yesterday' })).status, 422); assert.equal((await bad({ price: 'abc' })).status, 422); assert.equal((await bad({ price: '-5' })).status, 422); assert.equal((await bad({ price: '999999999' })).status, 422);
  assert.equal(sales(v.id).length, 0); assert.equal(listing(v.id).status, 'active', 'a rejected request changes nothing');
  assert.throws(() => q.run('UPDATE external_sales SET price_cents = 1 WHERE listing_id = ?', id), /cannot be changed/); assert.throws(() => q.run('DELETE FROM external_sales WHERE listing_id = ?', id), /cannot be deleted/);
});

test('authorization: only the owning seller; nobody can record a sale for another seller\'s item', async () => {
  const { s, id } = await seller('Guarded'), other = await H.newSeller('Other'), buyer = await H.newUser('Plain'), anon = new H.Client();
  assert.equal((await other.post(`/api/seller/listings/${id}/external-sale`, {})).status, 404); assert.equal((await other.get(`/dashboard/listings/${id}/external-sale`)).status, 404);
  assert.equal((await buyer.post(`/api/seller/listings/${id}/external-sale`, {})).status, 403); assert.equal((await anon.post(`/api/seller/listings/${id}/external-sale`, {})).status, 401);
  assert.equal((await other.post(`/api/seller/listings/${id}/mark-sold`)).status, 404);
  assert.equal(sales(id).length, 0); assert.equal(listing(id).status, 'active');
  assert.doesNotMatch(await ordersPage(other), /Guarded/);
});

test('genuine PairPlug orders stay separate: no external sale for ordered items, payment is only ever confirmed by the seller, sales never fabricate it', async () => {
  const { s, id } = await seller('Genuine order'), buyer = await H.newUser('Real Buyer');
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId;
  assert.equal((await s.post(`/api/seller/listings/${id}/external-sale`, {})).status, 409, 'a reserved item (pending order) cannot be recorded as externally sold');
  assert.equal((await s.post(`/api/seller/listings/${id}/mark-sold`)).status, 409);
  assert.equal((await buyer.post(`/api/orders/${o}/claim-paid`)).status, 200);
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o).status, 'pending_payment', 'a buyer\'s claim never marks it paid'); assert.equal(listing(id).status, 'reserved');
  assert.equal((await s.post(`/api/seller/orders/${o}/confirm-payment`)).status, 200);
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o).status, 'paid'); assert.equal(listing(id).status, 'sold');
  assert.equal((await s.post(`/api/seller/listings/${id}/external-sale`, {})).status, 409, 'a PairPlug-ordered item is tracked as an order, not an external sale'); assert.equal(sales(id).length, 0);
  const page = await ordersPage(s); assert.match(page, /Paid — ready to ship/); assert.match(page, /Genuine order/); assert.doesNotMatch(page, /Sold items with no sales record/);
  assert.match((await s.get(`/dashboard/listings/${id}/external-sale`)).text, /has a PairPlug order/);
  // recording external sales never touches orders: order count only changes through checkout
  const ext = await seller('External only'), before = counts(); await ext.s.post(`/api/seller/listings/${ext.id}/external-sale`, { price: '20' }); assert.deepEqual(counts(), before);
  assert.equal(q.get("SELECT COUNT(*) n FROM order_events WHERE to_status = 'paid' AND order_id NOT IN (SELECT id FROM orders)").n, 0);
  // a released (cancelled) reservation leaves the item free to be recorded
  const rel = await seller('Released then sold elsewhere'), b2 = await H.newUser('Walks away'); const o2 = (await b2.post('/api/purchases', { listingId: rel.id, acknowledged: true, address: H.address })).json.orderId;
  await rel.s.post(`/api/seller/orders/${o2}/reject-payment`); assert.equal((await rel.s.post(`/api/seller/listings/${rel.id}/external-sale`, { price: '15' })).status, 200);
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o2).status, 'cancelled');
});
