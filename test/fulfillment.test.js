'use strict';
// Real-order fulfilment: checkout address -> seller sees recipient -> carrier + tracking + message -> shipped; missing-address handling, history, authorization.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');

test.before(() => H.start());
test.after(() => { config.carrierWebhookSecret = ''; return H.stop(); });

const LINK = 'https://buy.stripe.com/test_fulfil1';
const row = (id) => q.get('SELECT * FROM orders WHERE id = ?', id);
const events = (id) => q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', id);
let n = 0; const trk = () => `1Z${Date.now()}${++n}`;
async function scene({ payer = 'buyer', title = 'Fulfil jacket', confirm = true } = {}) {
  const seller = await H.newSeller('Ful'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: payer === 'seller' ? '0' : '6.00', shipping_payer: payer, title });
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: { ...H.address, line2: 'Apt 4B' } })).json.orderId;
  if (confirm) assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 200);
  return { seller, buyer, id, o };
}
const sellerOrder = async (c, o) => (await c.get(`/dashboard/orders/${o}`)).text;
const buyerOrder = async (c, o) => (await c.get(`/orders/${o}`)).text;

test('checkout persists the address; both users see the order; payment stays unconfirmed until the seller confirms; confirmation sells the listing', async () => {
  const { seller, buyer, id, o } = await scene({ confirm: false, title: 'Flow jacket' });
  const ck = q.get('SELECT * FROM checkouts WHERE id = ?', row(o).checkout_id);
  assert.deepEqual([ck.ship_name, ck.ship_line1, ck.ship_line2, ck.ship_city, ck.ship_region, ck.ship_postal, ck.ship_country], ['Buyer Person', '1 Main St', 'Apt 4B', 'Austin', 'TX', '78701', 'US']);
  assert.match((await seller.get('/dashboard/orders')).text, /Awaiting your payment confirmation/); assert.match((await buyer.get('/orders')).text, /Flow jacket/);
  assert.doesNotMatch(await sellerOrder(seller, o), /1 Main St/, 'the address is withheld until payment is confirmed'); assert.equal(row(o).status, 'pending_payment');
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: trk() })).status, 409, 'cannot ship an unpaid order');
  await seller.post(`/api/seller/orders/${o}/confirm-payment`); assert.equal(row(o).status, 'paid'); assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'sold');
  const page = await sellerOrder(seller, o);
  for (const t of ['Ship this order', 'Buyer Person', '1 Main St', 'Apt 4B', 'Austin, TX 78701', 'US', 'Carrier', 'Tracking number', 'Message to the buyer', 'Mark shipped']) assert.ok(page.includes(t), t);
  for (const c of ['USPS', 'UPS', 'FedEx', 'Canada Post', 'DHL', 'Other']) assert.ok(page.includes(`<option>${c}</option>`), c);
  assert.match(page, /not<\/em> a prepaid label/); assert.match(page, /PairPlug does not buy labels or pay postage/);
  const free = await scene({ payer: 'seller' }); assert.match(await sellerOrder(free.seller, free.o), /you pay the postage yourself/); assert.match(await buyerOrder(free.buyer, free.o), /the seller covers postage/);
  assert.match(await buyerOrder(buyer, o), /not prepaid postage/);
});

test('Mark shipped saves carrier, tracking and message, updates the order, shows them to both users, notifies the buyer in-app, and keeps history', async () => {
  const { seller, buyer, o } = await scene(), t = trk();
  const r = await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'UPS', tracking: t, note: 'Packed in a box, left Friday' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.notified, true);
  const ord = row(o); assert.equal(ord.status, 'shipped'); assert.equal(ord.carrier, 'UPS'); assert.equal(ord.tracking_number, t); assert.equal(ord.ship_note, 'Packed in a box, left Friday'); assert.ok(ord.shipped_at);
  const sp = await sellerOrder(seller, o); assert.match(sp, /Shipped/); assert.ok(sp.includes(t)); assert.match(sp, /Packed in a box/); assert.match(sp, /Your own entry can&#39;t mark it delivered|Your own entry can't mark it delivered/);
  const bp = await buyerOrder(buyer, o); assert.ok(bp.includes(t)); assert.match(bp, /UPS/); assert.match(bp, /Packed in a box, left Friday/); assert.match(bp, /not proof of delivery/);
  assert.match((await buyer.get('/orders')).text, new RegExp(t));
  const note = q.get("SELECT * FROM notifications WHERE user_id = (SELECT buyer_id FROM orders WHERE id = ?) AND title = 'Your order shipped'", o); assert.ok(note); assert.ok(note.body.includes(t)); assert.equal(note.link, `/orders/${o}`);
  assert.deepEqual(events(o).map((e) => e.to_status), ['pending_payment', 'paid', 'shipped']); assert.match(events(o)[2].note, new RegExp(`UPS ${t}`)); assert.equal(events(o)[2].actor, `seller:${q.get('SELECT seller_id s FROM orders WHERE id = ?', o).s}`);
  // the shipment is saved even if the in-app notification cannot be written, and the response does not claim it was sent
  const b = await scene(), orig = q.run;
  q.run = (sql, ...a) => { if (/INSERT OR IGNORE INTO notifications/.test(sql)) throw new Error('notification store down'); return orig(sql, ...a); };
  try { const f = await b.seller.post(`/api/seller/orders/${b.o}/ship`, { carrier: 'USPS', tracking: trk() }); assert.equal(f.status, 200); assert.equal(f.json.notified, false); } finally { q.run = orig; }
  assert.equal(row(b.o).status, 'shipped');
});

test('validation: recipient, carrier and tracking are checked and nothing is saved on bad input', async () => {
  const { seller, o } = await scene(), bad = (b) => seller.post(`/api/seller/orders/${o}/ship`, b);
  assert.equal((await bad({ carrier: 'Teleport', tracking: trk() })).status, 422); assert.equal((await bad({ tracking: trk() })).status, 422);
  for (const t of ['', 'abc', 'has space!!', 'x'.repeat(41), '<script>1</script>']) { const r = await bad({ carrier: 'USPS', tracking: t }); assert.equal(r.status, 422, t); assert.ok(r.json.fields.tracking); }
  assert.equal(row(o).status, 'paid'); assert.equal(row(o).tracking_number, null);
  // checkout itself rejects an invalid or incomplete address, creating no order
  const s2 = await H.newSeller('V'), b2 = await H.newUser('V'), id2 = await H.makeListing(s2, { payment_url: LINK }), before = q.get('SELECT COUNT(*) n FROM orders').n;
  for (const a of [{ ...H.address, name: '' }, { ...H.address, line1: '' }, { ...H.address, postal: '' }, { ...H.address, country: 'FR' }]) assert.equal((await b2.post('/api/purchases', { listingId: id2, acknowledged: true, address: a })).status, 422);
  assert.equal(q.get('SELECT COUNT(*) n FROM orders').n, before);
});

test('duplicate submissions are safe; tracking can be corrected with history; one tracking number cannot serve two orders', async () => {
  const { seller, buyer, o } = await scene(), t = trk(), body = { carrier: 'FedEx', tracking: t, note: 'hi' };
  const rs = await Promise.all([1, 2, 3, 4].map(() => seller.post(`/api/seller/orders/${o}/ship`, body)));
  assert.ok(rs.every((r) => r.status === 200)); assert.equal(rs.filter((r) => !r.json.alreadyShipped).length, 1); assert.equal(events(o).filter((e) => e.to_status === 'shipped' && e.from_status === 'paid').length, 1);
  assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE title = 'Your order shipped' AND body LIKE ?", `%${t}%`).n, 1, 'one notification only');
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: trk() })).status, 409, 'a different submission is refused (use Correct tracking)');
  const t2 = trk(); assert.equal((await seller.put(`/api/seller/orders/${o}/tracking`, { carrier: 'UPS', tracking: t2, note: 'corrected' })).status, 200);
  assert.equal(row(o).tracking_number, t2); assert.match(events(o).at(-1).note, new RegExp(`Tracking corrected: FedEx ${t} → UPS ${t2}`)); assert.equal(row(o).status, 'shipped'); assert.ok((await buyerOrder(buyer, o)).includes(t2));
  const other = await scene(); assert.equal((await other.seller.post(`/api/seller/orders/${other.o}/ship`, { carrier: 'UPS', tracking: t2 })).status, 409, 'tracking numbers are unique per carrier');
  assert.equal((await other.seller.put(`/api/seller/orders/${other.o}/tracking`, { carrier: 'UPS', tracking: trk() })).status, 409, 'cannot correct before shipping');
});

test('authorization: other sellers, buyers and anonymous users cannot see or change fulfilment', async () => {
  const { seller, buyer, o } = await scene(), evil = await H.newSeller('Evil'), anon = new H.Client(), t = trk();
  assert.equal((await evil.get(`/dashboard/orders/${o}`)).status, 404);
  for (const [m, u, b] of [['post', `/api/seller/orders/${o}/ship`, { carrier: 'UPS', tracking: t }], ['put', `/api/seller/orders/${o}/tracking`, { carrier: 'UPS', tracking: t }], ['post', `/api/seller/orders/${o}/request-address`, {}], ['post', `/api/seller/orders/${o}/received`, {}]]) assert.equal((await evil[m](u, b)).status, 404, u);
  assert.equal((await buyer.post(`/api/seller/orders/${o}/ship`, { carrier: 'UPS', tracking: t })).status, 403); assert.equal((await anon.post(`/api/seller/orders/${o}/ship`, { carrier: 'UPS', tracking: t })).status, 401);
  assert.equal(row(o).status, 'paid'); assert.doesNotMatch((await evil.get('/dashboard/orders')).text, /1 Main St|Fulfil jacket/);
  const stranger = await H.newUser('Stranger'); assert.equal((await stranger.get(`/orders/${o}`)).status, 404); assert.equal((await stranger.post(`/api/orders/${o}/shipping-address`, H.address)).status, 404);
  void seller;
});

test('delivered only when reliably verified: not by the seller; by the buyer, or an authenticated carrier report', async () => {
  const a = await scene(); await a.seller.post(`/api/seller/orders/${a.o}/ship`, { carrier: 'USPS', tracking: trk() });
  assert.equal((await a.seller.post(`/api/seller/orders/${a.o}/received`)).status, 403); assert.equal(row(a.o).status, 'shipped'); assert.doesNotMatch(await sellerOrder(a.seller, a.o), /Mark delivered/);
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/received`)).status, 200); assert.equal(row(a.o).status, 'delivered');
  const b = await scene(), tn = trk(); await b.seller.post(`/api/seller/orders/${b.o}/ship`, { carrier: 'USPS', tracking: tn });
  config.carrierWebhookSecret = 'hook-secret'; const hook = (secret) => fetch(H.base + '/webhooks/tracking', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify({ carrier: 'USPS', trackingNumber: tn, status: 'DELIVERED' }) });
  assert.equal((await hook('wrong')).status, 401); assert.equal(row(b.o).status, 'shipped'); assert.equal((await hook('hook-secret')).status, 200); assert.equal(row(b.o).status, 'delivered'); assert.equal(events(b.o).at(-1).actor, 'carrier');
});

test('older orders without an address: shown as missing (never invented), shipping blocked, the buyer is asked and can add it safely', async () => {
  const { seller, buyer, o } = await scene(), ck = row(o).checkout_id;
  q.run('UPDATE checkouts SET ship_name = NULL, ship_line1 = NULL, ship_line2 = NULL, ship_city = NULL, ship_region = NULL, ship_postal = NULL, ship_country = NULL WHERE id = ?', ck);   // simulate an order created before addresses were collected
  const sp = await sellerOrder(seller, o); assert.match(sp, /delivery address is missing/); assert.match(sp, /Ask the buyer to add it/); assert.doesNotMatch(sp, /name="tracking"/, 'no shipping form until there is an address');
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: trk() })).status, 409); assert.equal(row(o).status, 'paid');
  const ask = await seller.post(`/api/seller/orders/${o}/request-address`); assert.equal(ask.status, 200); assert.match(ask.json.message, /in-app notification/); assert.match(ask.json.message, /No email/);
  assert.ok(q.get("SELECT 1 x FROM notifications WHERE user_id = (SELECT buyer_id FROM orders WHERE id = ?) AND title = 'Please add your delivery address'", o)); await seller.post(`/api/seller/orders/${o}/request-address`); assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE title = 'Please add your delivery address'").n >= 1, true);
  const bp = await buyerOrder(buyer, o); assert.match(bp, /No delivery address on this order/); assert.match(bp, /Save delivery address/);
  assert.equal((await buyer.post(`/api/orders/${o}/shipping-address`, { ...H.address, postal: '' })).status, 422); assert.equal((await seller.post(`/api/orders/${o}/shipping-address`, H.address)).status, 404, 'the seller cannot write the buyer\'s address');
  assert.equal((await buyer.post(`/api/orders/${o}/shipping-address`, H.address)).status, 200);
  assert.ok(q.get("SELECT 1 x FROM notifications WHERE title = 'Delivery address added'")); assert.match(await sellerOrder(seller, o), /1 Main St/);
  assert.equal((await buyer.post(`/api/orders/${o}/shipping-address`, { ...H.address, line1: '9 Other Rd' })).status, 409, 'an existing address cannot be silently replaced');
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: trk() })).status, 200);
});

test('history stays intact and visible after refresh/fresh login: cancelled and shipped orders and external-sale records', async () => {
  const a = await scene(), cancelled = await scene({ confirm: false, title: 'Cancelled jacket' }); await cancelled.seller.post(`/api/seller/orders/${cancelled.o}/reject-payment`);
  await a.seller.post(`/api/seller/orders/${a.o}/ship`, { carrier: 'USPS', tracking: trk() });
  const ext = await H.makeListing(a.seller, { payment_url: LINK, title: 'Sold elsewhere jacket' }); assert.equal((await a.seller.post(`/api/seller/listings/${ext}/record-sale`, { origin: 'in_person', fulfillment: 'pickup', price: '20' })).status, 200);
  const fresh = new H.Client(); await fresh.post('/api/login', { email: a.seller.email, password: 'correct-horse-9' });
  const page = (await fresh.get('/dashboard/orders')).text; assert.match(page, /Shipped/); assert.match(page, /Sold elsewhere jacket/); assert.match(page, /Recorded sales/);
  const cp = (await cancelled.seller.get('/dashboard/orders')).text; assert.match(cp, /Cancelled jacket/); assert.match(cp, /Cancelled, released and refunded/);
  assert.match((await cancelled.buyer.get('/orders')).text, /Cancelled jacket/);
  assert.match((await a.seller.get('/dashboard/inventory?status=sold')).text, /Fulfil jacket/);
});
