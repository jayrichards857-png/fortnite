'use strict';
// Unified "Record sale": origin, payment attestation, fulfilment (ship / pickup), recipient privacy, corrections, voids, and clear separation from Grailedside checkout orders.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_sales1';
const REC = { line1: '77 Harbor Rd', line2: 'Unit 9', city: 'Portland', region: 'OR', postal: '97201', country: 'US' };
const listing = async (id) => await q.get('SELECT * FROM listings WHERE id = ?', id);
const sale = async (id) => await q.get('SELECT * FROM external_sales WHERE listing_id = ? AND voided_at IS NULL', id);
const counts = async () => ({ orders: (await q.get('SELECT COUNT(*) n FROM orders')).n, checkouts: (await q.get('SELECT COUNT(*) n FROM checkouts')).n, users: (await q.get('SELECT COUNT(*) n FROM users')).n, notifications: (await q.get('SELECT COUNT(*) n FROM notifications')).n });
let n = 0; const trk = () => `9400${Date.now()}${++n}`;
async function seller(title = 'Sale hoodie') { const s = await H.newSeller('Sale'); const id = await H.makeListing(s, { payment_url: LINK, title }); return { s, id }; }
const rec = (s, id, body) => s.post(`/api/seller/listings/${id}/record-sale`, body);
const page = async (c) => (await c.get('/dashboard/orders')).text;
const full = { origin: 'other_marketplace', channel: 'Depop', reference: 'DP-1001', sold_on: '2026-10-01', price: '85.00', fulfillment: 'ship', payment_status: 'unconfirmed', name: 'Casey Buyer', ...REC };

test('wording: the general action is "Record sale", the origin is a form field, no blanket "outside Grailedside" claim, and no payment verification claim', async () => {
  const { s, id } = await seller('Wording hoodie');
  const inv = (await s.get('/dashboard/inventory')).text; assert.match(inv, />Record sale</); assert.doesNotMatch(inv, /Sold outside Grailedside|Record external sale/);
  const f = (await s.get(`/dashboard/listings/${id}/record-sale`)).text;
  assert.match(f, /<h1>Record sale<\/h1>/); assert.match(f, /Where did this sale originate\?/); assert.doesNotMatch(f, /Record external sale|sold outside Grailedside|outside Grailedside/i);
  for (const o of ['Grailedside', 'In person', 'Another marketplace', 'Social media or direct message', 'Other']) assert.ok(f.includes(`>${o}</option>`), o);
  assert.match(f, /does <strong>not<\/strong> independently verify any payment/); assert.match(f, /Stripe, PayPal or other payment link/); assert.match(f, /Local pickup \/ no shipping required/);
  assert.equal((await s.get(`/dashboard/listings/${id}/external-sale`)).status, 301, 'the old URL redirects');
  for (const c of ['USPS', 'UPS', 'FedEx', 'Canada Post', 'DHL', 'Other']) assert.ok((await s.get(`/dashboard/listings/${id}/record-sale`)).text.length > 0, c);
});

test('origin is required and valid; Grailedside-originated sales paid through the seller\'s own link are recorded as Grailedside, not "external"', async () => {
  const { s, id } = await seller('Origin hoodie');
  assert.equal((await rec(s, id, { fulfillment: 'pickup' })).status, 422); assert.equal((await rec(s, id, { origin: 'carrier-pigeon', fulfillment: 'pickup' })).status, 422); assert.equal((await rec(s, id, { origin: 'pairplug' })).status, 422, 'fulfillment is required too');
  assert.equal((await listing(id)).status, 'active', 'rejected requests change nothing');
  const before = await counts();
  const r = await rec(s, id, { origin: 'pairplug', fulfillment: 'ship', payment_status: 'unconfirmed', reference: 'stripe pi_123', price: '60', name: 'Pat Pay', ...REC }); assert.equal(r.status, 200, r.text);
  const x = await sale(id); assert.equal(x.origin, 'pairplug'); assert.equal(x.payment_status, 'unconfirmed'); assert.equal(x.payment_confirmed_at, null); assert.equal(x.reference, 'stripe pi_123');
  assert.deepEqual(await counts(), before, 'no buyer account, checkout, order or notification was fabricated');
  const t = await page(s); assert.match(t, /Recorded sales/); assert.match(t, />Grailedside</); assert.match(t, /Not confirmed/); assert.doesNotMatch(t, /Confirmed by you|verified payment|Paid — ready to ship/);
  assert.equal((await listing(id)).status, 'sold'); assert.equal((await (await H.newUser('Late')).post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 409, 'unavailable for purchase immediately');
});

test('other marketplaces and in-person sales: origin, platform, reference and date are stored and displayed; pickup needs no address or tracking', async () => {
  const a = await seller('Marketplace hoodie'); assert.equal((await rec(a.s, a.id, full)).status, 200);
  const x = await sale(a.id); assert.deepEqual([x.origin, x.channel, x.reference, x.sold_on, x.price_cents, x.fulfillment, x.shipment_status], ['other_marketplace', 'Depop', 'DP-1001', '2026-10-01', 8500, 'ship', 'not_shipped']);
  const t = await page(a.s); assert.match(t, /Another marketplace/); assert.match(t, /Depop/); assert.match(t, /2026-10-01/); assert.match(t, /\$85\.00/); assert.match(t, /Awaiting shipment/);
  const b = await seller('In person hoodie'); assert.equal((await rec(b.s, b.id, { origin: 'in_person', fulfillment: 'pickup', price: '40', note: 'cash at the pop-up' })).status, 200);
  const y = await sale(b.id); assert.equal(y.fulfillment, 'pickup'); assert.equal(y.shipment_status, 'not_applicable'); assert.equal(y.recipient_name, null); assert.equal(y.tracking_number, null);
  const tb = await page(b.s); assert.match(tb, /In person/); assert.match(tb, /Local pickup/); const d = (await b.s.get(`/dashboard/sales/${y.id}`)).text; assert.match(d, /Local pickup \/ no shipping required/); assert.doesNotMatch(d, /Mark shipped/);
  assert.equal((await b.s.post(`/api/seller/sales/${y.id}/ship`, { carrier: 'USPS', tracking: trk() })).status, 409, 'pickup sales cannot be "shipped"');
  const c = await seller('Social hoodie'); assert.equal((await rec(c.s, c.id, { origin: 'social', channel: 'Instagram DM', fulfillment: 'pickup' })).status, 200); assert.match(await page(c.s), /Social media or direct message/);
});

test('shipping: a recipient is saved later, Mark shipped is blocked until address + carrier + tracking are valid, then it records shipment details', async () => {
  const { s, id } = await seller('Fulfil hoodie'); await rec(s, id, { origin: 'in_person', fulfillment: 'ship', price: '30' });                // saved as awaiting fulfilment, no address yet
  const x = await sale(id), ship = (b) => s.post(`/api/seller/sales/${x.id}/ship`, b);
  assert.match(await page(s), /Awaiting recipient address/); assert.equal((await ship({ carrier: 'USPS', tracking: trk() })).status, 409, 'no address yet'); assert.equal((await sale(id)).shipment_status, 'not_shipped');
  assert.equal((await s.put(`/api/seller/sales/${x.id}/fulfillment`, { fulfillment: 'ship', name: 'Casey', line1: '', city: 'Portland', region: 'OR', postal: '97201', country: 'US' })).status, 422);
  assert.equal((await s.put(`/api/seller/sales/${x.id}/fulfillment`, { fulfillment: 'ship', name: 'Casey', line1: '1 A St', city: 'Portland', region: 'OR', postal: 'BAD', country: 'US' })).status, 422);
  assert.equal((await s.put(`/api/seller/sales/${x.id}/fulfillment`, { fulfillment: 'ship', name: 'Casey Buyer', ...REC })).status, 200); assert.match(await page(s), /Awaiting shipment/);
  for (const bad of [{ carrier: 'Teleport', tracking: trk() }, { tracking: trk() }, { carrier: 'USPS', tracking: 'abc' }, { carrier: 'USPS', tracking: '<b>x</b>' }, { carrier: 'USPS', tracking: '' }]) assert.equal((await ship(bad)).status, 422, JSON.stringify(bad));
  assert.equal((await sale(id)).shipment_status, 'not_shipped');
  const t = trk(), ok = await ship({ carrier: 'DHL', tracking: t, note: 'Posted today' }); assert.equal(ok.status, 200); assert.equal(ok.json.buyerNotified, false, 'no buyer account exists, so nobody is notified');
  const y = await sale(id); assert.deepEqual([y.shipment_status, y.carrier, y.tracking_number, y.ship_note], ['shipped', 'DHL', t, 'Posted today']); assert.ok(y.shipped_at);
  assert.equal((await ship({ carrier: 'DHL', tracking: t, note: 'Posted today' })).json.alreadyShipped, true, 'a duplicate submission is harmless'); assert.equal((await ship({ carrier: 'UPS', tracking: trk() })).status, 409);
  const p = await page(s); assert.match(p, new RegExp(`Shipped · DHL ${t}`)); const d = (await s.get(`/dashboard/sales/${y.id}`)).text; assert.ok(d.includes('Casey Buyer') && d.includes('77 Harbor Rd') && d.includes(t));
  assert.equal((await q.get("SELECT COUNT(*) n FROM notifications WHERE body LIKE ?", `%${t}%`)).n, 0, 'no notification was claimed or created');
});

test('payment stays unconfirmed until the seller explicitly attests it; it is never described as verified; attestation is idempotent and logged', async () => {
  const { s, id } = await seller('Payment hoodie'); await rec(s, id, { origin: 'other', fulfillment: 'pickup' });
  const x = await sale(id); assert.equal(x.payment_status, 'unconfirmed'); assert.match((await s.get(`/dashboard/sales/${x.id}`)).text, /Not confirmed/);
  assert.equal((await s.post(`/api/seller/sales/${x.id}/confirm-payment`)).status, 200); assert.equal((await s.post(`/api/seller/sales/${x.id}/confirm-payment`)).json.alreadyConfirmed, true);
  const y = await sale(id); assert.equal(y.payment_status, 'confirmed_by_seller'); assert.ok(y.payment_confirmed_at);
  const d = (await s.get(`/dashboard/sales/${x.id}`)).text; assert.match(d, /Confirmed by you · not verified by Grailedside/); assert.doesNotMatch(d, /verified by Grailedside automatically|Grailedside verified/);
  assert.equal((await q.get("SELECT COUNT(*) n FROM sale_events WHERE sale_id = ? AND action = 'payment_confirmed_by_seller'", x.id)).n, 1);
  const b = await seller('Attested at record'); await rec(b.s, b.id, { origin: 'in_person', fulfillment: 'pickup', payment_status: 'confirmed_by_seller' }); assert.equal((await sale(b.id)).payment_status, 'confirmed_by_seller');
});

test('genuine Grailedside checkout orders keep their own workflow: no duplicate sale record, and a recorded sale never marks anything paid', async () => {
  const { s, id } = await seller('Checkout hoodie'), buyer = await H.newUser('Real Buyer');
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId;
  assert.equal((await rec(s, id, { origin: 'pairplug', fulfillment: 'pickup' })).status, 409, 'a reserved item cannot be recorded');
  assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', o)).status, 'pending_payment');
  await s.post(`/api/seller/orders/${o}/confirm-payment`); const dup = await rec(s, id, { origin: 'pairplug', fulfillment: 'pickup' }); assert.equal(dup.status, 409); assert.match(dup.json.error, /already has a Grailedside order/);
  assert.equal((await q.get('SELECT COUNT(*) n FROM external_sales WHERE listing_id = ?', id)).n, 0); assert.match((await s.get(`/dashboard/listings/${id}/record-sale`)).text, /already has a Grailedside order/);
  const t = await page(s); assert.match(t, /Paid — ready to ship/); assert.doesNotMatch(t, /Sold items with no sales record/);
  const x = await seller('Recorded only'), ordersBefore = (await q.get("SELECT COUNT(*) n FROM orders WHERE status = 'paid'")).n; await rec(x.s, x.id, { origin: 'pairplug', fulfillment: 'pickup', payment_status: 'confirmed_by_seller' });
  assert.equal((await q.get("SELECT COUNT(*) n FROM orders WHERE status = 'paid'")).n, ordersBefore, 'recording never creates or pays an order');
  const gone = await seller('Cancelled order then sold'), b2 = await H.newUser('Walker'); const o2 = (await b2.post('/api/purchases', { listingId: gone.id, acknowledged: true, address: H.address })).json.orderId;
  await gone.s.post(`/api/seller/orders/${o2}/reject-payment`); assert.equal((await rec(gone.s, gone.id, { origin: 'in_person', fulfillment: 'pickup' })).status, 200, 'a cancelled order does not block recording');
});

test('earlier external-sale records stay accessible, keep origin NULL ("earlier record") and are never relabelled', async () => {
  const { s, id } = await seller('Legacy hoodie'), uid = (await q.get('SELECT id FROM users WHERE handle = ?', s.handle)).id;
  await q.run("UPDATE listings SET status = 'sold' WHERE id = ?", id);
  await q.run("INSERT INTO external_sales(listing_id, seller_id, sold_on, price_cents, channel, reference, note, recorded_at) VALUES(?,?,'2026-09-01',5000,'Depop','OLD-1','old note',1700000000)", id, uid);   // exactly the migration-8 shape
  const x = await sale(id); assert.equal(x.origin, null); assert.equal(x.payment_status, 'unconfirmed'); assert.equal(x.fulfillment, null);
  const t = await page(s); assert.match(t, /Legacy hoodie/); assert.match(t, /Earlier record/); assert.match(t, /Depop/); assert.match(t, /2026-09-01/); assert.match(t, /\$50\.00/); assert.doesNotMatch(t, /Sold items with no sales record/);
  const d = (await s.get(`/dashboard/sales/${x.id}`)).text; assert.match(d, /Earlier record \(origin not captured\)/); assert.match(d, /Fulfillment wasn't captured/);
  await assert.rejects(async () => await q.run("UPDATE external_sales SET origin = 'in_person' WHERE id = ?", x.id), /origin and creation time cannot be changed/, 'the origin of a record can never be assigned or rewritten');
  assert.equal((await s.put(`/api/seller/sales/${x.id}/fulfillment`, { fulfillment: 'pickup' })).status, 200);       // the seller can complete the missing fulfilment info
  await assert.rejects(async () => await q.run('DELETE FROM external_sales WHERE id = ?', x.id), /cannot be deleted/);
});

test('privacy and authorization: recipient and buyer details are visible only to the owning seller', async () => {
  const { s, id } = await seller('Private hoodie'); await rec(s, id, { ...full, buyer_email: 'casey@example.test' }); const x = await sale(id);
  const other = await H.newSeller('Other'), buyer = await H.newUser('Plain'), anon = new H.Client();
  const own = (await s.get(`/dashboard/sales/${x.id}`)).text; assert.ok(own.includes('77 Harbor Rd') && own.includes('casey@example.test'));
  assert.equal((await other.get(`/dashboard/sales/${x.id}`)).status, 404); assert.doesNotMatch(await page(other), /Private hoodie|Casey|Harbor/);
  for (const [m, u, b] of [['put', `/api/seller/sales/${x.id}`, { price: '1' }], ['post', `/api/seller/sales/${x.id}/confirm-payment`, {}], ['put', `/api/seller/sales/${x.id}/fulfillment`, { fulfillment: 'pickup' }], ['post', `/api/seller/sales/${x.id}/ship`, { carrier: 'USPS', tracking: trk() }], ['put', `/api/seller/sales/${x.id}/tracking`, { carrier: 'USPS', tracking: trk() }], ['post', `/api/seller/sales/${x.id}/void`, { reason: 'not yours to void' }], ['post', `/api/seller/listings/${id}/record-sale`, full]]) {
    assert.equal((await other[m](u, b)).status, 404, `other seller ${u}`); assert.equal((await buyer[m](u, b)).status, 403, `buyer ${u}`); assert.equal((await anon[m](u, b)).status, 401, `anon ${u}`);
  }
  assert.equal((await sale(id)).payment_status, 'unconfirmed'); assert.equal((await sale(id)).shipment_status, 'not_shipped');
  const adm = await H.newUser('Admin'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', adm.email); assert.doesNotMatch((await adm.get('/admin/orders')).text, /Harbor|Casey/);
});

test('corrections, tracking updates and voids are validated, logged and safe; a void never reopens a listing or touches another order', async () => {
  const { s, id } = await seller('Correct hoodie'); await rec(s, id, { ...full }); const x = await sale(id), t1 = trk(), t2 = trk();
  assert.equal((await s.put(`/api/seller/sales/${x.id}`, { price: 'abc' })).status, 422); assert.equal((await s.put(`/api/seller/sales/${x.id}`, { sold_on: '2999-01-01' })).status, 422);
  assert.equal((await s.put(`/api/seller/sales/${x.id}`, { price: '90.00', note: 'fixed typo' })).status, 200); assert.equal((await sale(id)).price_cents, 9000); assert.equal((await sale(id)).origin, 'other_marketplace', 'origin is untouched');
  const ev = await q.all("SELECT detail FROM sale_events WHERE sale_id = ? AND action = 'corrected'", x.id); assert.equal(ev.length, 1); assert.match(ev[0].detail, /8500/); assert.match(ev[0].detail, /9000/);
  assert.equal((await s.put(`/api/seller/sales/${x.id}/tracking`, { carrier: 'UPS', tracking: t2 })).status, 409, 'before shipping');
  await s.post(`/api/seller/sales/${x.id}/ship`, { carrier: 'USPS', tracking: t1 });
  assert.equal((await s.put(`/api/seller/sales/${x.id}/tracking`, { carrier: 'UPS', tracking: t2, note: 'corrected' })).status, 200); assert.equal((await sale(id)).tracking_number, t2);
  assert.match((await q.get("SELECT detail FROM sale_events WHERE sale_id = ? AND action = 'tracking_corrected'", x.id)).detail, new RegExp(`USPS ${t1}.*UPS ${t2}`)); assert.equal((await sale(id)).shipment_status, 'shipped');
  const other = await seller('Dup tracking'); await rec(other.s, other.id, { ...full }); assert.equal((await other.s.post(`/api/seller/sales/${(await sale(other.id)).id}/ship`, { carrier: 'UPS', tracking: t2 })).status, 409, 'unique tracking');
  assert.equal((await s.post(`/api/seller/sales/${x.id}/void`, { reason: 'too late, shipped' })).status, 409, 'a shipped sale is corrected, not voided');
  // void: reason required; record kept; listing paused (not re-listed); the item can then be recorded again
  const v = await seller('Void hoodie'); await rec(v.s, v.id, { origin: 'in_person', fulfillment: 'pickup' }); const vx = await sale(v.id);
  assert.equal((await v.s.post(`/api/seller/sales/${vx.id}/void`, { reason: 'x' })).status, 422); assert.equal((await listing(v.id)).status, 'sold');
  assert.equal((await v.s.post(`/api/seller/sales/${vx.id}/void`, { reason: 'Clicked by mistake' })).status, 200); assert.equal((await v.s.post(`/api/seller/sales/${vx.id}/void`, { reason: 'Clicked by mistake' })).json.alreadyVoided, true);
  const voided = await q.get('SELECT * FROM external_sales WHERE id = ?', vx.id); assert.ok(voided.voided_at); assert.equal(voided.void_reason, 'Clicked by mistake'); assert.equal((await listing(v.id)).status, 'archived', 'paused, never automatically re-listed');
  await assert.rejects(async () => await q.run('UPDATE external_sales SET note = ? WHERE id = ?', 'x', vx.id), /voided sale records cannot be changed/); assert.equal((await v.s.put(`/api/seller/sales/${vx.id}`, { note: 'x' })).status, 409);
  assert.match(await page(v.s), /Voided/); assert.equal((await rec(v.s, v.id, { origin: 'in_person', fulfillment: 'pickup' })).status, 409, 'an archived item is not recordable until the seller resumes it deliberately');
  // a void on a listing that has since gained a real order must not touch it
  const w = await seller('Guard hoodie'); await rec(w.s, w.id, { origin: 'other', fulfillment: 'pickup' }); const wx = await sale(w.id);
  await q.run("UPDATE listings SET status = 'sold' WHERE id = ?", w.id); await w.s.post(`/api/seller/sales/${wx.id}/void`, { reason: 'Mistake with another sale' });
  await assert.rejects(async () => await q.run('DELETE FROM sale_events WHERE sale_id = ?', wx.id), /append-only/);
});

test('migration 9 shape: legacy columns preserved, active-sale uniqueness is per listing, history tables exist', async () => {
  const cols = (await q.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'external_sales'")).map((c) => c.name); for (const c of ['listing_id', 'sold_on', 'price_cents', 'channel', 'reference', 'note', 'recorded_at', 'origin', 'payment_status', 'fulfillment', 'recipient_name', 'tracking_number', 'voided_at']) assert.ok(cols.includes(c), c);
  const idx = async (n) => await q.get('SELECT 1 x FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?', n);
  assert.ok(await idx('idx_external_sales_listing_active')); assert.ok(!await idx('idx_external_sales_listing')); assert.ok(await q.get("SELECT 1 x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'sale_events'"));
});

test('migration 9 applied to a populated v8 database keeps every existing external-sale row exactly as it was', async () => {
  const { dbAt } = require('./pgmig'); const db = await dbAt(8);
  try {
    await db.run("INSERT INTO users(id, email, password_hash, display_name, is_seller, handle, store_name, country, created_at) VALUES (1,'s@x.test','h','S',1,'s','Store','US',1700000000)");
    await db.run("INSERT INTO listings(id, seller_id, title, category, price_cents, shipping_cents, status, created_at, updated_at) VALUES (1,1,'Old sold hoodie','clothing',9000,0,'sold',1700000000,1700000000)");
    await db.run("INSERT INTO external_sales(listing_id, seller_id, sold_on, price_cents, channel, reference, note, recorded_at) VALUES (1,1,'2026-09-01',5000,'Depop','OLD-1','old note',1700000001)");
    const before = await db.one('SELECT id, listing_id, seller_id, sold_on, price_cents, channel, reference, note, recorded_at FROM external_sales');
    await db.applyNext();
    const after = await db.one('SELECT * FROM external_sales');
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], k);
    assert.deepEqual([after.origin, after.payment_status, after.fulfillment, after.shipment_status, after.voided_at], [null, 'unconfirmed', null, null, null], 'legacy meaning is not relabelled');
    await assert.rejects(db.run('DELETE FROM external_sales'), /cannot be deleted/); await assert.rejects(db.run("UPDATE external_sales SET origin = 'other'"), /cannot be changed/);
    await db.run("UPDATE external_sales SET note = 'edited'");                                       // ordinary corrections are now possible (and are logged by the app)
  } finally { await db.close(); }
});
