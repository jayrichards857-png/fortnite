'use strict';
// Listing quantity: reserving a unit takes one off, releasing gives it back, a confirmed payment keeps it taken; sold only when nothing is left.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q, tx } = require('../src/db');
const X = require('../src/externalCheckout');
const { expireStaleCheckouts } = require('../src/payments');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_qty1';
const row = async (id) => await q.get('SELECT status, quantity, reserved_checkout_id rc FROM listings WHERE id = ?', id);
const buy = async (b, id) => b.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address });
const oidOf = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
async function stock(n, over = {}) { const seller = await H.newSeller('Qty'), id = await H.makeListing(seller, { payment_url: LINK, quantity: n, ...over }); return { seller, id }; }

test('the seller sets the quantity; it is validated, shown to buyers, and fixed at 1 by default', async () => {
  const { seller, id } = await stock(3); assert.equal((await row(id)).quantity, 3);
  const buyer = await H.newUser('Look'); const page = (await buyer.get(`/listing/${id}`)).text; assert.match(page, /3 units/); assert.match((await buyer.get('/shop')).text, /3 left/);
  const one = await H.makeListing(seller, { payment_url: LINK, title: 'Just one' }); assert.equal((await row(one)).quantity, 1); assert.doesNotMatch((await buyer.get(`/listing/${one}`)).text, /Available<\/dt>/);
  const editor = (await seller.get(`/dashboard/listings/${id}/edit`)).text; assert.match(editor, /name="quantity"[^>]*value="3"/);
  const base = { title: 'Qty check', category: 'outerwear', condition: 'good', price: '20.00', shipping: '4', weight_oz: '10', images: [await H.upload(seller)], status: 'draft' };
  for (const bad of ['0', '-1', '1000', '1.5', 'abc', '1e2']) assert.equal((await seller.post('/api/seller/listings', { ...base, quantity: bad })).status, 422, bad);
  const ok = await seller.post('/api/seller/listings', { ...base, quantity: '12' }); assert.equal(ok.status, 200); assert.equal((await row(ok.json.id)).quantity, 12);
  assert.equal((await seller.put(`/api/seller/listings/${ok.json.id}`, { ...base, quantity: 5 })).status, 200); assert.equal((await row(ok.json.id)).quantity, 5);
  await assert.rejects(async () => await q.run('UPDATE listings SET quantity = -1 WHERE id = ?', id), /check constraint/i);
});

test('reserve -> quantity down; cancel/reject/expire -> quantity back; confirmed payment keeps the unit taken; sold only when none is left', async () => {
  const { seller, id } = await stock(3); const b = await Promise.all([1, 2, 3, 4].map(async (i) => await H.newUser('B' + i)));
  const o1 = await buy(b[0], id); assert.equal(o1.status, 200); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [2, 'active']);
  const again = await buy(b[0], id); assert.equal(oidOf(again), oidOf(o1), 'double-click returns the same order'); assert.equal((await row(id)).quantity, 2, 'and takes no second unit');
  const o2 = await buy(b[1], id), o3 = await buy(b[2], id); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [0, 'reserved'], 'last unit taken -> reserved');
  assert.match((await b[3].get(`/listing/${id}`)).text, /Reserved/); assert.equal((await buy(b[3], id)).status, 409, 'nothing left to reserve');
  assert.equal((await b[1].post(`/api/orders/${oidOf(o2)}/cancel-purchase`, {})).status, 200); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [1, 'active'], 'a cancelled reservation gives the unit back');
  assert.equal((await b[1].post(`/api/orders/${oidOf(o2)}/cancel-purchase`, {})).status >= 400, true); assert.equal((await row(id)).quantity, 1, 'cancelling twice never double-releases');
  assert.equal((await seller.post(`/api/seller/orders/${oidOf(o3)}/reject-payment`, {})).status, 200); assert.equal((await row(id)).quantity, 2); assert.equal((await seller.post(`/api/seller/orders/${oidOf(o3)}/reject-payment`, {})).status, 200); assert.equal((await row(id)).quantity, 2, 'repeat reject does not release again');
  assert.equal((await seller.post(`/api/seller/orders/${oidOf(o1)}/confirm-payment`, {})).status, 200); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [2, 'active'], 'a confirmed payment keeps its unit taken');
  assert.equal((await seller.post(`/api/seller/orders/${oidOf(o1)}/confirm-payment`, {})).status, 200); assert.equal((await row(id)).quantity, 2, 'confirming twice changes nothing');
  // expiry gives the unit back too
  const o4 = await buy(b[3], id), o5 = await buy(await H.newUser('B5'), id); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [0, 'reserved']);
  await q.run('UPDATE checkouts SET expires_at = 1 WHERE id = (SELECT checkout_id FROM orders WHERE id = ?)', oidOf(o5)); await expireStaleCheckouts(); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [1, 'active']); assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', oidOf(o5))).status, 'cancelled');
  // the last unit sells: confirm the pending one, then a final buyer takes the last unit and it becomes sold
  assert.equal((await seller.post(`/api/seller/orders/${oidOf(o4)}/confirm-payment`, {})).status, 200); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [1, 'active']);
  const last = await buy(await H.newUser('Last'), id); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [0, 'reserved']);
  assert.equal((await seller.post(`/api/seller/orders/${oidOf(last)}/confirm-payment`, {})).status, 200); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [0, 'sold'], 'sold once every unit is paid for');
  assert.equal((await q.get("SELECT COUNT(*) n FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.listing_id = ? AND o.status = 'paid'", id)).n, 3, 'three real sales, none invented');
  assert.equal((await buy(await H.newUser('TooLate'), id)).status, 409);
});

test('concurrent buyers cannot take more units than exist', async () => {
  const { id } = await stock(2); const buyers = await Promise.all(Array.from({ length: 6 }, async (_, i) => await H.newUser('C' + i)));
  const res = await Promise.all(buyers.map(async (b) => await buy(b, id)));
  assert.equal(res.filter((r) => r.status === 200).length, 2); assert.equal(res.filter((r) => r.status === 409).length, 4);
  assert.equal((await row(id)).quantity, 0); assert.equal((await q.get("SELECT COUNT(*) n FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.listing_id = ? AND o.status = 'pending_payment'", id)).n, 2);
});

test('refunds and recorded sales keep the unit count honest', async () => {
  const { seller, id } = await stock(2); const b = await H.newUser('R'); const o = await buy(b, id), oid = oidOf(o);
  await seller.post(`/api/seller/orders/${oid}/confirm-payment`, {}); assert.equal((await row(id)).quantity, 1);
  await tx(async () => { await X.afterRefund(oid, true); });
  assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [2, 'active'], 'a refunded unit the seller relists is back in stock');
  await tx(async () => { await X.afterRefund(oid, false); });
  assert.equal((await row(id)).status, 'active', 'other stock remains, so the listing is not archived');
  // recording sales made elsewhere
  const two = await stock(2), rec = (x) => two.seller.post(`/api/seller/listings/${two.id}/record-sale`, { origin: 'in_person', fulfillment: 'pickup', payment_status: 'unconfirmed', sold_on: new Date().toISOString().slice(0, 10), price: '30', ...x });
  const r1 = await rec(); assert.equal(r1.status, 200, r1.text); assert.deepEqual([(await row(two.id)).quantity, (await row(two.id)).status], [1, 'active'], 'one unit sold elsewhere; the listing stays for sale');
  assert.equal((await rec()).status, 409, 'one recorded sale per listing; further units are handled by lowering the quantity');
  const orderOnOther = await buy(await H.newUser('Other'), two.id); assert.equal(orderOnOther.status, 200); assert.deepEqual([(await row(two.id)).quantity, (await row(two.id)).status], [0, 'reserved']);
});

test('a single-unit listing behaves exactly as before; migration 14 backfills quantities without changing statuses', async () => {
  const { seller, id } = await stock(1); const b = await H.newUser('One'); const o = await buy(b, id);
  assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [0, 'reserved']); await seller.post(`/api/seller/orders/${oidOf(o)}/confirm-payment`, {}); assert.deepEqual([(await row(id)).quantity, (await row(id)).status], [0, 'sold']);
  const { dbAt } = require('./pgmig'); const d = await dbAt(13);
  try {
    await d.run('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', 's@x.test', 'x', 'S', 1);
    for (const st of ['active', 'reserved', 'sold', 'draft', 'archived']) await d.run("INSERT INTO listings(seller_id, title, category, price_cents, status, created_at, updated_at) VALUES(1,?,'clothing',500,?,1,1)", st, st);
    await d.applyNext();
    assert.deepEqual((await d.all('SELECT status, quantity, payment_total_ack_cents a FROM listings ORDER BY id')).map((r) => [r.status, Number(r.quantity), r.a]), [['active', 1, null], ['reserved', 0, null], ['sold', 0, null], ['draft', 1, null], ['archived', 1, null]]);
  } finally { await d.close(); }
});
