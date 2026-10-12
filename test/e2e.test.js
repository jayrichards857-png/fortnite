'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const { payments: _p } = {};
const escrow = require('../src/escrow');
const payments = require('../src/payments');

test.before(() => H.start());
test.after(() => H.stop());

const bal = (handle) => require('../src/stats').wallet(q.get('SELECT id FROM users WHERE handle = ?', handle).id);
const order = (id) => q.get('SELECT * FROM orders WHERE id = ?', id);

test('empty marketplace: pages render honest empty states, no fake data', async () => {
  const c = new H.Client();
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /No listings yet/);
  const shop = await c.get('/shop?q=anything');
  assert.match(shop.text, /No matching items/);
  assert.equal(q.get('SELECT COUNT(*) n FROM listings').n, 0);
});

test('auth: register validation, login, wrong password, logout, no plaintext passwords', async () => {
  const c = new H.Client();
  let r = await c.post('/api/register', { email: 'bad', display_name: '', terms: true, password: 'short' });
  assert.equal(r.status, 422); assert.ok(r.json.fields.email && r.json.fields.password);
  const u = await H.newUser('Auth');
  const row = q.get('SELECT * FROM users WHERE email = ?', u.email);
  assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes('correct-horse'));
  const l = new H.Client();
  assert.equal((await l.post('/api/login', { email: u.email, password: 'nope-nope-1' })).status, 401);
  assert.equal((await l.post('/api/login', { email: u.email, password: 'correct-horse-9' })).status, 200);
  assert.equal((await l.get('/orders')).status, 200);
  await l.post('/api/logout');
  assert.equal((await l.get('/orders')).status, 302);
});

test('login rate limiting kicks in', async () => {
  const config = require('../src/config'); config.rateLimitScale = 1;
  try {
    const c = new H.Client(); let last;
    for (let i = 0; i < 10; i++) last = await c.post('/api/login', { email: 'victim@example.test', password: 'guess-' + i });
    assert.equal(last.status, 429);
  } finally { config.rateLimitScale = 1000; }
});

test('CSRF: mutations without the custom header are rejected', async () => {
  const u = await H.newUser();
  const r = await fetch(H.base + '/api/account', { method: 'PATCH', headers: { cookie: u.cookie, 'content-type': 'text/plain' }, body: '{"display_name":"Hacked"}' });
  assert.equal(r.status, 403);
});

test('unauthenticated + unauthorized access', async () => {
  const anon = new H.Client(), buyer = await H.newUser('Buyer');
  assert.equal((await anon.post('/api/cart', { listingId: 1 })).status, 401);
  assert.equal((await anon.post('/api/seller/listings', {})).status, 401);
  assert.equal((await buyer.post('/api/seller/listings', {})).status, 403, 'non-seller');
  assert.equal((await buyer.get('/api/seller/tax.csv')).status, 403);
  assert.equal((await buyer.put('/api/admin/settings', {})).status, 403);
  assert.equal((await buyer.get('/admin')).status, 403);
  assert.equal((await anon.get('/dashboard')).status, 302);
});

test('seller journey: upload, validate, publish, find, edit, inventory', async () => {
  const s = await H.newSeller('Journey');
  const bad = await s.post('/api/seller/listings', { title: 'a', status: 'active' });
  assert.equal(bad.status, 422); assert.ok(bad.json.fields.title && bad.json.fields.images);
  // uploads: non-images rejected
  const svg = await s.req('POST', '/api/uploads', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { raw: true, type: 'image/png' });
  assert.equal(svg.status, 415);
  const id = await H.makeListing(s, { title: 'Vintage denim jacket', brand: 'Levi’s', category: 'denim', size: 'L', price: '55.00', sku: 'DJ-1' });
  const detail = await new H.Client().get(`/listing/${id}`);
  assert.equal(detail.status, 200); assert.match(detail.text, /Vintage denim jacket/); assert.match(detail.text, /Local ship/);
  // search finds it (brand, category, size)
  const anon = new H.Client();
  for (const qs of ['q=denim', 'q=levi', 'category=denim&size=L', 'min=50&max=60&condition=good']) assert.match((await anon.get('/shop?' + qs)).text, /Vintage denim jacket/, qs);
  for (const qs of ['q=sneaker', 'category=sneakers', 'min=100', 'max=10', 'condition=fair', 'size=S']) assert.match((await anon.get('/shop?' + qs)).text, /No matching items/, qs);
  assert.equal((await anon.get("/shop?q=%25_'; DROP TABLE listings;--")).status, 200);
  // edit price and status
  const edit = await s.put(`/api/seller/listings/${id}`, { title: 'Vintage denim jacket', category: 'denim', condition: 'good', sku: 'DJ-1', price: '49.00', weight_oz: '20', images: JSON.parse(JSON.stringify(q.all('SELECT file FROM listing_images WHERE listing_id = ?', id).map((r) => r.file))), status: 'active' });
  assert.equal(edit.status, 200);
  assert.equal(q.get('SELECT price_cents p FROM listings WHERE id = ?', id).p, 4900);
  assert.match((await s.get('/dashboard/inventory')).text, /Vintage denim jacket/);
  assert.match((await s.get('/dashboard/inventory?q=DJ-1')).text, /Vintage denim jacket/);
  // draft isn't public
  const d = await H.makeListing(s, { title: 'Secret draft', status: 'draft' });
  assert.equal((await anon.get(`/listing/${d}`)).status, 404);
  assert.doesNotMatch((await anon.get('/shop')).text, /Secret draft/);
  for (const p of ['/dashboard', '/dashboard/orders', '/dashboard/analytics', '/dashboard/finance', '/dashboard/import', '/dashboard/listings/new', `/dashboard/listings/${id}/edit`]) assert.equal((await s.get(p)).status, 200, p);
});

test('authorization: sellers cannot touch each other\'s listings, orders or uploads', async () => {
  const a = await H.newSeller('A'), b = await H.newSeller('B');
  const id = await H.makeListing(a);
  assert.equal((await b.put(`/api/seller/listings/${id}`, { title: 'Hijack', category: 'denim', price: '1.00', status: 'draft' })).status, 404);
  assert.equal((await b.post(`/api/seller/listings/${id}/duplicate`)).status, 404);
  assert.equal((await b.get(`/dashboard/listings/${id}/edit`)).status, 404);
  const bulk = await b.post('/api/seller/listings/bulk', { ids: [id], action: 'status', status: 'archived' });
  assert.equal(bulk.json.updated, 0); assert.equal(bulk.json.skipped[0].reason, 'not found');
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'active');
  const file = await H.upload(a);
  const steal = await b.post('/api/seller/listings', { title: 'Stolen photo', category: 'denim', price: '10.00', status: 'draft', images: [file] });
  assert.equal(steal.status, 403);
  // buying your own listing
  assert.equal((await a.post('/api/cart', { listingId: id })).status, 403);
});

test('bulk actions: validated server-side; sold items protected; sold cannot be set via inventory', async () => {
  const s = await H.newSeller('Bulk');
  const ids = [await H.makeListing(s, { price: '20.00' }), await H.makeListing(s, { price: '30.00' })];
  let r = await s.post('/api/seller/listings/bulk', { ids, action: 'price', percent: '10' });
  assert.equal(r.json.updated, 2);
  assert.deepEqual(ids.map((i) => q.get('SELECT price_cents p FROM listings WHERE id = ?', i).p), [2200, 3300]);
  assert.equal((await s.post('/api/seller/listings/bulk', { ids, action: 'status', status: 'sold' })).status, 422);
  assert.equal((await s.post('/api/seller/listings/bulk', { ids, action: 'price', price: '0.10' })).json.updated, 0);
  r = await s.post('/api/seller/listings/bulk', { ids, action: 'status', status: 'archived' });
  assert.equal(r.json.updated, 2);
  // mark one sold via the order system, then try bulk archive
  const buyer = await H.newUser();
  const id = await H.makeListing(s);
  await buyer.post('/api/cart', { listingId: id });
  const ck = await H.checkout(buyer); await H.pay(buyer, ck.json.checkoutId);
  r = await s.post('/api/seller/listings/bulk', { ids: [id], action: 'status', status: 'archived' });
  assert.equal(r.json.updated, 0); assert.match(r.json.skipped[0].reason, /sold/);
});

test('full buyer journey + escrow: checkout → paid → shipped → delivered → released, with correct fees', async () => {
  const s = await H.newSeller('Escrow'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(s, { price: '100.00', shipping: '8.00', cost: '40.00' });
  assert.equal((await buyer.post('/api/cart', { listingId: id })).status, 200);
  assert.match((await buyer.get('/cart')).text, /Test jacket/);
  const ck = await H.checkout(buyer); assert.equal(ck.status, 200);
  const o = q.get('SELECT * FROM orders WHERE checkout_id = ?', ck.json.checkoutId);
  assert.equal(o.status, 'pending_payment');
  assert.equal(o.total_cents, 10800); assert.equal(o.platform_fee_cents, 1000);
  assert.equal(o.seller_payout_cents, 10800 - 1000 - o.processing_fee_cents);
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'reserved');
  // reserved items can't be added by others
  const other = await H.newUser();
  assert.equal((await other.post('/api/cart', { listingId: id })).status, 409);
  assert.equal((await H.pay(buyer, ck.json.checkoutId)).json.paid, true);
  assert.equal(order(o.id).status, 'paid'); assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'sold');
  assert.match((await buyer.get('/orders')).text, new RegExp(`#${o.id}`));
  assert.match((await s.get('/dashboard/orders')).text, /Mark shipped/);
  // funds not yet available
  assert.equal(bal(s.handle).availableCents, 0);
  // cannot release unpaid/unshipped; buyer can't confirm before shipping
  assert.equal((await buyer.post(`/api/orders/${o.id}/confirm`)).status, 409);
  // other seller can't ship it
  const evil = await H.newSeller('Evil');
  assert.equal((await evil.post(`/api/seller/orders/${o.id}/ship`, { carrier: 'USPS', tracking: '9400111899223' })).status, 404);
  assert.equal((await s.post(`/api/seller/orders/${o.id}/ship`, { carrier: 'USPS', tracking: 'x' })).status, 422);
  assert.equal((await s.post(`/api/seller/orders/${o.id}/ship`, { carrier: 'USPS', tracking: '9400111899223' })).status, 200);
  assert.equal(order(o.id).status, 'shipped');
  // carrier webhook: auth required, then marks delivered
  const hook = (secret, status) => fetch(H.base + '/webhooks/tracking', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify({ carrier: 'USPS', trackingNumber: '9400111899223', status }) });
  assert.equal((await hook('wrong', 'DELIVERED')).status, 401);
  assert.equal((await hook('carrier-secret', 'DELIVERED')).status, 200);
  assert.equal(order(o.id).status, 'delivered'); assert.ok(order(o.id).auto_release_at > Date.now() / 1000);
  assert.equal(bal(s.handle).availableCents, 0, 'still escrowed after delivery');
  assert.equal((await hook('carrier-secret', 'DELIVERED')).status, 200, 'duplicate carrier event is harmless');
  // buyer confirms -> funds released exactly once
  assert.equal((await buyer.post(`/api/orders/${o.id}/confirm`)).status, 200);
  assert.equal(order(o.id).status, 'released');
  assert.equal(bal(s.handle).availableCents, o.seller_payout_cents);
  assert.equal((await buyer.post(`/api/orders/${o.id}/confirm`)).status, 409, 'cannot release twice');
  assert.equal(bal(s.handle).availableCents, o.seller_payout_cents);
  // review
  assert.equal((await buyer.post(`/api/orders/${o.id}/review`, { rating: 5, body: 'Great' })).status, 200);
  assert.equal((await buyer.post(`/api/orders/${o.id}/review`, { rating: 5 })).status, 409);
  assert.match((await new H.Client().get(`/s/${s.handle}`)).text, /Great/);
  // dashboard numbers come from the records
  const ov = require('../src/stats').overview(q.get('SELECT id FROM users WHERE handle = ?', s.handle).id);
  assert.equal(ov.gross, 10000); assert.equal(ov.completed, 1); assert.equal(ov.net, o.seller_payout_cents);
  assert.equal(ov.profit.cents, o.seller_payout_cents - 4000);
  // withdrawal can't exceed balance
  assert.equal((await s.post('/api/seller/withdrawals', { amount: '9999' })).status, 422);
  assert.equal((await s.post('/api/seller/withdrawals', { amount: (o.seller_payout_cents / 100).toFixed(2) })).status, 200);
  assert.equal(bal(s.handle).availableCents, 0);
  // notifications recorded once per event
  const n = q.get("SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?", `order:${o.id}:released`).n;
  assert.equal(n, 1);
});

test('auto-release after delivery window', async () => {
  const s = await H.newSeller('Auto'), buyer = await H.newUser();
  const id = await H.makeListing(s);
  await buyer.post('/api/cart', { listingId: id });
  const ck = await H.checkout(buyer); await H.pay(buyer, ck.json.checkoutId);
  const o = q.get('SELECT * FROM orders WHERE checkout_id = ?', ck.json.checkoutId);
  await s.post(`/api/seller/orders/${o.id}/ship`, { carrier: 'UPS', tracking: '1Z999AA10123456784' });
  escrow.markDelivered(o.id, 'carrier');
  assert.equal(escrow.autoReleaseDue(), 0, 'not due yet');
  q.run('UPDATE orders SET auto_release_at = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 5, o.id);
  assert.equal(escrow.autoReleaseDue(), 1);
  assert.equal(order(o.id).status, 'released');
  assert.equal(escrow.autoReleaseDue(), 0);
});

test('concurrency: 12 buyers racing for one unique item → exactly one wins', async () => {
  const s = await H.newSeller('Race');
  const id = await H.makeListing(s, { title: 'Grail sneaker', category: 'sneakers', price: '300.00' });
  const buyers = await Promise.all(Array.from({ length: 12 }, () => H.newUser('Racer')));
  const added = await Promise.all(buyers.map((b) => b.post('/api/cart', { listingId: id })));
  assert.equal(added.filter((r) => r.status === 200).length, 12, 'all can add to cart while item is active');
  const results = await Promise.all(buyers.map((b) => H.checkout(b)));
  const wins = results.filter((r) => r.status === 200), losses = results.filter((r) => r.status === 409);
  assert.equal(wins.length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(losses.length, 11);
  assert.equal(q.get('SELECT COUNT(*) n FROM order_items WHERE listing_id = ?', id).n, 1);
});

test('idempotency: replaying a checkout key returns the same checkout, no duplicate orders', async () => {
  const s = await H.newSeller('Idem'), buyer = await H.newUser();
  const id = await H.makeListing(s);
  await buyer.post('/api/cart', { listingId: id });
  const [a, b] = await Promise.all([H.checkout(buyer, 'same-key-12345'), H.checkout(buyer, 'same-key-12345')]);
  const c = await H.checkout(buyer, 'same-key-12345');
  assert.equal(c.status, 200); assert.equal(c.json.checkoutId, (a.status === 200 ? a : b).json.checkoutId);
  assert.equal(q.get('SELECT COUNT(*) n FROM orders WHERE buyer_id = (SELECT id FROM users WHERE email = ?)', buyer.email).n, 1);
});

test('webhooks: bad signature rejected, duplicates idempotent, amount mismatch rejected', async () => {
  const s = await H.newSeller('Hook'), buyer = await H.newUser();
  const id = await H.makeListing(s);
  await buyer.post('/api/cart', { listingId: id });
  const ck = await H.checkout(buyer); const cid = ck.json.checkoutId;
  const total = q.get('SELECT total_cents t FROM checkouts WHERE id = ?', cid).t;
  const send = (body, sig) => fetch(H.base + '/webhooks/payments/sandbox', { method: 'POST', headers: { 'x-sandbox-signature': sig ?? payments.sandbox.sign(body) }, body });
  const ev = (over) => JSON.stringify({ id: 'evt_x1', type: 'payment_succeeded', checkoutId: cid, amountCents: total, ...over });
  assert.equal((await send(ev(), 'deadbeef')).status, 400);
  assert.equal(q.get('SELECT status FROM checkouts WHERE id = ?', cid).status, 'pending', 'unsigned event changes nothing');
  assert.equal((await send(ev({ id: 'evt_bad', amountCents: 1 }))).status, 400, 'wrong amount');
  assert.equal(q.get('SELECT status FROM checkouts WHERE id = ?', cid).status, 'pending');
  const [r1, r2, r3] = await Promise.all([send(ev()), send(ev()), send(ev())]);
  const bodies = await Promise.all([r1, r2, r3].map((r) => r.json()));
  assert.equal(bodies.filter((b) => b.paid).length, 1); assert.equal(bodies.filter((b) => b.duplicate).length, 2);
  assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE dedupe_key LIKE 'order:%:paid'  AND user_id = (SELECT id FROM users WHERE handle = ?)", s.handle).n, 1);
  assert.equal(q.get('SELECT COUNT(*) n FROM order_events WHERE to_status = ? AND order_id IN (SELECT id FROM orders WHERE checkout_id = ?)', 'paid', cid).n, 1);
});

test('failed payment releases the item; late success after expiry is flagged for refund, not fulfilled', async () => {
  const s = await H.newSeller('Fail'), buyer = await H.newUser(), other = await H.newUser();
  const id = await H.makeListing(s);
  await buyer.post('/api/cart', { listingId: id });
  const ck = await H.checkout(buyer);
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'reserved');
  await H.pay(buyer, ck.json.checkoutId, 'failed');
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'active');
  assert.equal(order(q.get('SELECT id FROM orders WHERE checkout_id = ?', ck.json.checkoutId).id).status, 'cancelled');
  // someone else can now buy it
  await other.post('/api/cart', { listingId: id });
  const ck2 = await H.checkout(other); assert.equal(ck2.status, 200);
  // expire it
  q.run('UPDATE checkouts SET expires_at = 1 WHERE id = ?', ck2.json.checkoutId);
  assert.equal(payments.expireStaleCheckouts(), 1);
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'active');
  const late = await H.pay(other, ck2.json.checkoutId);
  assert.equal(late.json.lateSuccess, true);
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'active', 'late payment must not sell the item');
  assert.equal(q.get('SELECT status FROM payments WHERE checkout_id = ?', ck2.json.checkoutId).status, 'needs_refund');
});

test('seller cancel after payment refunds the buyer and relists nothing automatically; refund only once', async () => {
  const s = await H.newSeller('Cancel'), buyer = await H.newUser();
  const id = await H.makeListing(s);
  await buyer.post('/api/cart', { listingId: id });
  const ck = await H.checkout(buyer); await H.pay(buyer, ck.json.checkoutId);
  const o = q.get('SELECT * FROM orders WHERE checkout_id = ?', ck.json.checkoutId);
  assert.equal((await s.post(`/api/seller/orders/${o.id}/cancel`)).status, 200);
  const after = order(o.id);
  assert.equal(after.status, 'refunded'); assert.equal(after.refunded_cents, o.total_cents);
  assert.equal(q.get('SELECT status FROM refunds WHERE order_id = ?', o.id).status, 'succeeded');
  assert.equal((await s.post(`/api/seller/orders/${o.id}/cancel`)).status, 409);
  assert.equal(q.get('SELECT COUNT(*) n FROM refunds WHERE order_id = ?', o.id).n, 1);
  assert.equal(bal(s.handle).availableCents, 0);
});

test('disputes: evidence from both sides, admin resolves; refund and release paths', async () => {
  const s = await H.newSeller('Disp'), buyer = await H.newUser(), stranger = await H.newUser();
  const admin = await H.newUser('Admin'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', admin.email);
  const mk = async () => { const id = await H.makeListing(s); await buyer.post('/api/cart', { listingId: id }); const ck = await H.checkout(buyer); await H.pay(buyer, ck.json.checkoutId); return q.get('SELECT * FROM orders WHERE checkout_id = ?', ck.json.checkoutId); };
  const o1 = await mk(), o2 = await mk();
  const photo = await H.upload(buyer);
  assert.equal((await stranger.post(`/api/orders/${o1.id}/dispute`, { reason: 'I am not the buyer at all' })).status, 404);
  assert.equal((await buyer.post(`/api/orders/${o1.id}/dispute`, { reason: 'short' })).status, 422);
  assert.equal((await buyer.post(`/api/orders/${o1.id}/dispute`, { reason: 'Item never arrived, seller silent', evidence_json: JSON.stringify([photo]) })).status, 200);
  assert.equal(order(o1.id).status, 'disputed');
  assert.equal((await buyer.post(`/api/orders/${o1.id}/dispute`, { reason: 'Item never arrived, again' })).status, 409);
  assert.equal((await s.post(`/api/orders/${o1.id}/dispute/evidence`, { note: 'Shipped with signature, see tracking' })).status, 200);
  assert.equal((await buyer.post(`/api/orders/${o1.id}/confirm`)).status, 409, 'buyer cannot release a disputed order');
  const d = q.get('SELECT * FROM disputes WHERE order_id = ?', o1.id);
  assert.equal((await buyer.post(`/api/admin/disputes/${d.id}/resolve`, { decision: 'refund' })).status, 403);
  const page = await admin.get(`/admin/disputes/${d.id}`);
  assert.equal(page.status, 200); assert.match(page.text, /Shipped with signature/); assert.match(page.text, /Item never arrived/);
  assert.equal((await admin.post(`/api/admin/disputes/${d.id}/resolve`, { decision: 'refund', note: 'No proof of delivery' })).status, 200);
  assert.equal(order(o1.id).status, 'refunded');
  assert.equal((await admin.post(`/api/admin/disputes/${d.id}/resolve`, { decision: 'release' })).status, 404, 'cannot resolve twice');
  // release path
  await buyer.post(`/api/orders/${o2.id}/dispute`, { reason: 'Changed my mind about this item' });
  const d2 = q.get('SELECT * FROM disputes WHERE order_id = ?', o2.id);
  assert.equal((await admin.post(`/api/admin/disputes/${d2.id}/resolve`, { decision: 'release' })).status, 200);
  assert.equal(order(o2.id).status, 'released'); assert.equal(bal(s.handle).availableCents, o2.seller_payout_cents);
});

test('admin: ban removes sessions & listings; fee changes apply to new orders only; validation', async () => {
  const admin = await H.newUser('Admin'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', admin.email);
  const s = await H.newSeller('Banned'); const id = await H.makeListing(s);
  const uid = q.get('SELECT id FROM users WHERE handle = ?', s.handle).id;
  assert.equal((await admin.post(`/api/admin/users/${uid}/ban`, { banned: true })).status, 200);
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'archived');
  assert.equal((await s.get('/dashboard')).status, 302, 'banned session is dead');
  assert.equal((await new H.Client().post('/api/login', { email: s.email, password: 'correct-horse-9' })).status, 403);
  assert.equal((await admin.put('/api/admin/settings', { fee_bps_standard: 99999 })).status, 422);
  const cur = require('../src/db').getSettings();
  assert.equal((await admin.put('/api/admin/settings', { ...cur, fee_bps_standard: 800 })).status, 200);
  const s2 = await H.newSeller('Fee'), b = await H.newUser(); const id2 = await H.makeListing(s2, { price: '100.00', shipping: '0' });
  await b.post('/api/cart', { listingId: id2 }); const ck = await H.checkout(b);
  assert.equal(q.get('SELECT platform_fee_cents f FROM orders WHERE checkout_id = ?', ck.json.checkoutId).f, 800);
  await admin.put('/api/admin/settings', { ...cur });
});

test('CSV import: creates drafts, updates by SKU, reports bad rows, protects sold items', async () => {
  const s = await H.newSeller('Csv');
  const id = await H.makeListing(s, { sku: 'EX-1', price: '20.00' });
  const csv = 'sku,title,category,price,cost,condition,weight_oz\nEX-1,,,25.00,,,\nNEW-1,Wool coat,outerwear,80,30,good,40\nBAD-1,X,nope,abc,,,\n';
  const r = await s.post('/api/seller/import', { csv });
  assert.equal(r.json.updated, 1); assert.equal(r.json.created, 1); assert.equal(r.json.errors.length, 1);
  assert.equal(q.get('SELECT price_cents p FROM listings WHERE id = ?', id).p, 2500);
  assert.equal(q.get("SELECT status FROM listings WHERE sku = 'NEW-1'").status, 'draft');
  assert.equal((await s.post('/api/seller/import', { csv: 'title\nfoo' })).status, 422);
});

test('favorites persist per account and price drops notify once', async () => {
  const s = await H.newSeller('Fav'), b = await H.newUser();
  const id = await H.makeListing(s, { price: '50.00' });
  assert.equal((await new H.Client().put(`/api/favorites/${id}`)).status, 401);
  assert.equal((await b.put(`/api/favorites/${id}`)).status, 200);
  assert.match((await b.get('/favorites')).text, /Test jacket/);
  const body = (price) => ({ title: 'Test jacket', category: 'outerwear', condition: 'good', price, weight_oz: '20', images: q.all('SELECT file FROM listing_images WHERE listing_id = ?', id).map((r) => r.file), status: 'active' });
  await s.put(`/api/seller/listings/${id}`, body('40.00'));
  await s.put(`/api/seller/listings/${id}`, body('40.00'));
  assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE dedupe_key LIKE 'listing:%:price:%' AND user_id = (SELECT id FROM users WHERE email = ?)", b.email).n, 1);
  assert.equal((await b.req('DELETE', `/api/favorites/${id}`)).status, 200);
  assert.doesNotMatch((await b.get('/favorites')).text, /Test jacket/);
});

test('XSS: user-supplied text is escaped everywhere', async () => {
  const s = await H.newSeller('Xss');
  const id = await H.makeListing(s, { title: '<img src=x onerror=alert(1)>', description: '<script>alert(2)</script>', brand: '"><svg onload=1>' });
  for (const u of [`/listing/${id}`, '/shop', `/s/${s.handle}`, '/dashboard/inventory']) {
    const t = (await s.get(u)).text;
    assert.ok(!t.includes('<img src=x onerror') && !t.includes('<script>alert') && !t.includes('"><svg onload'), u);
  }
});
