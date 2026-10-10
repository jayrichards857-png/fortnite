'use strict';
// Direct (seller-owned) checkout: PairPlug never holds money; only the seller can confirm payment.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const payments = require('../src/payments');
const { validatePaymentUrl, buyerUrl, trackingUrl, resolveLink } = require('../src/paymentLinks');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_5kA3cs0abc123';
const count = (sql, ...p) => q.get(sql, ...p).n;
const row = (id) => q.get('SELECT * FROM orders WHERE id = ?', id);
const listingRow = (id) => q.get('SELECT * FROM listings WHERE id = ?', id);

async function listing(seller, over = {}) {
  return H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: '6.00', shipping_payer: 'buyer', ...over });
}
async function purchase(buyer, listingId, over = {}) {
  return buyer.post('/api/purchases', { listingId, acknowledged: true, address: H.address, ...over });
}
async function scene() {
  const seller = await H.newSeller('Dir'), buyer = await H.newUser('Buyer');
  const id = await listing(seller);
  return { seller, buyer, id };
}

// ---------------------------------------------------------------- payment link validation (unit)
test('payment links: only https links on allowlisted hosts are accepted', () => {
  assert.equal(validatePaymentUrl('https://buy.stripe.com/abc123XYZ'), 'https://buy.stripe.com/abc123XYZ');
  assert.equal(validatePaymentUrl('  https://BUY.STRIPE.COM/abc123#frag '), 'https://buy.stripe.com/abc123');
  const bad = [
    '', '   ', 'not a url', 'http://buy.stripe.com/abc123',                      // not https
    'https://buy.stripe.com.evil.com/abc123', 'https://evilbuy.stripe.com/abc123', // look-alike hosts
    'https://evil.com/buy.stripe.com/abc', 'https://buy.stripe.com@evil.com/abc',  // path / userinfo tricks
    'https://user:pw@buy.stripe.com/abc123', 'https://buy.stripe.com:8443/abc123', // credentials / odd port
    'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://buy.stripe.com/abc',
    'https://buy.stripe.com/', 'https://buy.stripe.com', 'https://checkout.stripe.com/c/pay/cs_live_x',
    'https://paypal.me/someone', 'https://' + 'a'.repeat(600) + '.com/x',
  ];
  for (const b of bad) assert.throws(() => validatePaymentUrl(b), (e) => e.status === 422 && Boolean(e.fields.payment_url), b.slice(0, 60));
});
test('payment links: the buyer URL carries our reference and is re-validated at redirect time', () => {
  const u = new URL(buyerUrl('https://buy.stripe.com/abc123?client_reference_id=spoofed', 77));
  assert.equal(u.hostname, 'buy.stripe.com'); assert.equal(u.searchParams.get('client_reference_id'), 'PP-77');
  assert.throws(() => buyerUrl('https://evil.example/abc123', 1), /./, 'a stored link that is no longer allowlisted is refused');
  assert.deepEqual(resolveLink({ payment_url: 'https://buy.stripe.com/a1' }, {}), { url: 'https://buy.stripe.com/a1', source: 'listing' });
  assert.equal(resolveLink({}, { checkout_url: 'https://buy.stripe.com/b1', checkout_url_any_amount: 0 }), null, 'fixed-price default link is never used implicitly');
  assert.equal(resolveLink({}, { checkout_url: 'https://buy.stripe.com/b1', checkout_url_any_amount: 1 }).source, 'seller_default');
});
test('tracking links: known carriers only, numbers are encoded', () => {
  assert.match(trackingUrl('USPS', '9400111899223344'), /^https:\/\/tools\.usps\.com\//);
  assert.equal(trackingUrl('Other', '9400111899223344'), null);
  assert.equal(trackingUrl('UPS', 'bad number!<script>'), null);
});

// ---------------------------------------------------------------- seller settings + publishing rules
test('seller settings: link is validated server-side; only sellers may set it; any-amount needs a link', async () => {
  const s = await H.newSeller('Set'), buyer = await H.newUser(), anon = new H.Client();
  assert.equal((await anon.put('/api/seller/settings', {})).status, 401);
  assert.equal((await buyer.put('/api/seller/settings', {})).status, 403);
  const base = { store_name: 'My Store', country: 'US', region: 'NY', city: 'Brooklyn' };
  const bad = await s.put('/api/seller/settings', { ...base, checkout_url: 'https://evil.example/pay' });
  assert.equal(bad.status, 422); assert.ok(bad.json.fields.checkout_url);
  assert.equal((await s.put('/api/seller/settings', { ...base, checkout_url_any_amount: true })).status, 422);
  assert.equal((await s.put('/api/seller/settings', { ...base, checkout_url: LINK, checkout_url_any_amount: true })).status, 200);
  const u = q.get('SELECT checkout_url, checkout_url_any_amount FROM users WHERE handle = ?', s.handle);
  assert.equal(u.checkout_url, LINK); assert.equal(u.checkout_url_any_amount, 1);
  assert.equal((await s.get('/dashboard/settings')).status, 200);
});

test('publishing needs a usable payment link; shipping terms are validated and enforced', async () => {
  const s = await H.newSeller('Pub');
  const file = await H.upload(s);
  const body = { title: 'Wool sweater', category: 'clothing', condition: 'good', price: '30.00', weight_oz: '20', images: [file], status: 'active' };
  const noLink = await s.post('/api/seller/listings', { ...body, shipping: '5.00' });
  assert.equal(noLink.status, 422); assert.ok(noLink.json.fields.payment_url);
  const badLink = await s.post('/api/seller/listings', { ...body, shipping: '5.00', payment_url: 'http://buy.stripe.com/abc123' });
  assert.equal(badLink.status, 422); assert.ok(badLink.json.fields.payment_url);
  // draft without a link is fine (it cannot be bought)
  assert.equal((await s.post('/api/seller/listings', { ...body, shipping: '5.00', status: 'draft' })).status, 200);
  // a fixed-price default link does not count; an any-amount default does
  const settings = { store_name: 'S', country: 'US', region: 'NY', city: 'B' };
  await s.put('/api/seller/settings', { ...settings, checkout_url: LINK });
  assert.equal((await s.post('/api/seller/listings', { ...body, shipping: '5.00' })).status, 422);
  await s.put('/api/seller/settings', { ...settings, checkout_url: LINK, checkout_url_any_amount: true });
  const ok = await s.post('/api/seller/listings', { ...body, shipping: '5.00' });
  assert.equal(ok.status, 200);
  // shipping terms
  const withLink = { ...body, payment_url: LINK };
  const buyerZero = await s.post('/api/seller/listings', { ...withLink, shipping_payer: 'buyer', shipping: '0' });
  assert.equal(buyerZero.status, 422); assert.ok(buyerZero.json.fields.shipping);
  assert.equal((await s.post('/api/seller/listings', { ...withLink, shipping_payer: 'bogus', shipping: '5' })).status, 422);
  const free = await s.post('/api/seller/listings', { ...withLink, shipping_payer: 'seller', shipping: '9.99' });
  assert.equal(free.status, 200);
  const fr = listingRow(free.json.id); assert.equal(fr.shipping_payer, 'seller'); assert.equal(fr.shipping_cents, 0, 'free shipping can never charge the buyer');
  assert.equal(listingRow(ok.json.id).shipping_payer, 'buyer');
  // CSV cannot sneak a bad link in
  const csv = await s.post('/api/seller/import', { csv: 'sku,title,category,price,shipping,payment_url\nA-1,Hat,accessories,10,3,https://evil.example/x\n' });
  assert.equal(csv.json.errors.length, 1);
  // bulk publish skips drafts that have no link
  const s2 = await H.newSeller('Bulk'); const f2 = await H.upload(s2);
  const d = await s2.post('/api/seller/listings', { title: 'Draft one', category: 'clothing', condition: 'good', price: '12.00', shipping: '4', weight_oz: '5', images: [f2], status: 'draft' });
  const bulk = await s2.post('/api/seller/listings/bulk', { ids: [d.json.id], action: 'status', status: 'active' });
  assert.equal(bulk.json.updated, 0); assert.match(bulk.json.skipped[0].reason, /payment link/);
});

// ---------------------------------------------------------------- listing page + disabled platform surfaces
test('listing page shows shipping terms and total, never escrow/cart language; cart and platform checkout are off', async () => {
  const { seller, buyer, id } = await scene();
  const page = (await new H.Client().get(`/listing/${id}`)).text;
  assert.match(page, /Continue to seller checkout/); assert.match(page, /\$46\.00/); assert.match(page, /\$6\.00 flat fee, paid by the buyer/);
  assert.match(page, /directly through their own checkout/);
  assert.doesNotMatch(page, /escrow|Add to cart|Buy now/i);
  const free = await listing(seller, { shipping_payer: 'seller', shipping: '0' });
  assert.match((await new H.Client().get(`/listing/${free}`)).text, /Free shipping/);
  // the PairPlug-held checkout surfaces are disabled, API and pages
  for (const [m, u, b] of [['post', '/api/cart', { listingId: id }], ['post', '/api/checkout', {}], ['post', `/api/sandbox/pay/1`, {}]]) assert.equal((await buyer[m](u, b)).status, 404, u);
  assert.match((await buyer.get('/cart')).text, /no cart in the private beta/);
  assert.equal((await buyer.get('/checkout')).status, 200);
  assert.doesNotMatch((await buyer.get('/shop')).text, /aria-label="Cart"/);
  assert.match((await seller.get(`/listing/${id}`)).text, /Edit listing/);
});

// ---------------------------------------------------------------- the purchase flow
test('purchase: creates a PENDING order + reservation; nothing is paid, no money records exist', async () => {
  const { seller, buyer, id } = await scene();
  assert.equal((await new H.Client().post('/api/purchases', { listingId: id })).status, 401);
  assert.equal((await purchase(buyer, id, { acknowledged: false })).status, 422);
  assert.equal(listingRow(id).status, 'active', 'no reservation without acknowledgement');
  assert.equal((await purchase(buyer, id, { address: { name: 'x' } })).status, 422);
  assert.equal((await purchase(seller, id)).status, 403, 'cannot buy your own item');
  const r = await purchase(buyer, id);
  assert.equal(r.status, 200); assert.match(r.json.redirect, /^\/orders\/\d+$/);
  const o = row(r.json.orderId);
  assert.equal(o.status, 'pending_payment'); assert.equal(o.payment_mode, 'external'); assert.equal(o.paid_at, null);
  assert.equal(o.total_cents, 4600); assert.equal(o.subtotal_cents, 4000); assert.equal(o.shipping_cents, 600); assert.equal(o.shipping_payer, 'buyer');
  assert.equal(o.platform_fee_cents + o.processing_fee_cents + o.seller_payout_cents + o.tax_cents, 0, 'PairPlug takes no fee and computes no payout');
  assert.equal(listingRow(id).status, 'reserved');
  // snapshot records what was offered
  const snap = JSON.parse(o.snapshot_json);
  assert.equal(snap.listing.title, 'Test jacket'); assert.equal(snap.terms.totalCents, 4600); assert.equal(snap.terms.shippingPayer, 'buyer');
  assert.equal(snap.seller.handle, seller.handle); assert.equal(snap.paymentLink.host, 'buy.stripe.com'); assert.equal(snap.paymentLink.source, 'listing');
  // no payment / refund / wallet records, ever
  assert.equal(count('SELECT COUNT(*) n FROM payments WHERE checkout_id = ?', o.checkout_id), 0);
  assert.equal(count('SELECT COUNT(*) n FROM ledger WHERE order_id = ?', o.id), 0);
  assert.equal(q.get('SELECT mode FROM checkouts WHERE id = ?', o.checkout_id).mode, 'external');
  // double click / refresh / retry => the very same order, no duplicates
  const again = await Promise.all([purchase(buyer, id), purchase(buyer, id), purchase(buyer, id)]);
  assert.ok(again.every((x) => x.status === 200 && x.json.orderId === o.id));
  assert.equal(count('SELECT COUNT(*) n FROM orders WHERE buyer_id = ?', o.buyer_id), 1);
  // another buyer is turned away while reserved
  const other = await H.newUser(); assert.equal((await purchase(other, id)).status, 409);
  // buyer sees an honest status, seller sees "unconfirmed", never "paid"
  const bp = (await buyer.get(`/orders/${o.id}`)).text;
  assert.match(bp, /Awaiting payment confirmation/); assert.match(bp, /PP-\d+/); assert.match(bp, /does not collect, hold or protect|doesn't hold|does not hold/i);
  assert.doesNotMatch(bp, /escrow|held until/i);
  const sp = (await seller.get('/dashboard/orders')).text; assert.match(sp, /Unconfirmed/); assert.doesNotMatch(sp, /Confirmed by you/);
});

test('payment redirect: only the buyer of a pending order, destination from the DB, never from the request', async () => {
  const { seller, buyer, id } = await scene();
  const o = (await purchase(buyer, id)).json.orderId;
  const stranger = await H.newUser();
  assert.equal((await new H.Client().get(`/orders/${o}/pay`)).status, 302, 'anonymous goes to login, not to the seller link');
  assert.match((await new H.Client().get(`/orders/${o}/pay`)).headers.get('location'), /^\/login/);
  assert.equal((await stranger.get(`/orders/${o}/pay`)).status, 409 > 0 ? (await stranger.get(`/orders/${o}/pay`)).status : 0);
  assert.notEqual((await stranger.get(`/orders/${o}/pay`)).status, 302);
  assert.notEqual((await seller.get(`/orders/${o}/pay`)).status, 302);
  const r = await buyer.get(`/orders/${o}/pay?url=https://evil.example&to=//evil.example&redirect=https://evil.example`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.hostname, 'buy.stripe.com'); assert.equal(loc.pathname, '/test_5kA3cs0abc123'); assert.equal(loc.searchParams.get('client_reference_id'), `PP-${o}`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(row(o).pay_clicked_at, 'the click is recorded');
  assert.equal(row(o).status, 'pending_payment', 'clicking through never marks anything paid');
  // the destination is frozen in the order snapshot: later edits to the seller's link can't redirect an open order...
  q.run('UPDATE listings SET payment_url = ? WHERE id = ?', 'https://buy.stripe.com/test_CHANGED_999', id);
  assert.equal(new URL((await buyer.get(`/orders/${o}/pay`)).headers.get('location')).pathname, '/test_5kA3cs0abc123');
  // ...and if the host is no longer allowlisted, buyers are NOT sent anywhere
  const hosts = config.paymentLinkHosts; config.paymentLinkHosts = ['other.example'];
  try { const r2 = await buyer.get(`/orders/${o}/pay`); assert.notEqual(r2.status, 302); assert.match(r2.text, /no longer accepted/); } finally { config.paymentLinkHosts = hosts; }
});

test('buyer actions never confirm payment; the hold extends only so the seller can verify', async () => {
  const { seller, buyer, id } = await scene();
  const o = (await purchase(buyer, id)).json.orderId;
  const before = q.get('SELECT expires_at e FROM checkouts WHERE checkout_id = ?'.replace('checkout_id', 'id'), row(o).checkout_id).e;
  assert.equal((await buyer.post(`/api/orders/${o}/claim-paid`)).status, 200);
  assert.equal((await buyer.post(`/api/orders/${o}/claim-paid`)).status, 200, 'idempotent');
  assert.equal(row(o).status, 'pending_payment'); assert.equal(row(o).payment_confirmed_at, null);
  assert.ok(q.get('SELECT expires_at e FROM checkouts WHERE id = ?', row(o).checkout_id).e > before + 24 * 3600, 'hold extended');
  assert.equal(count("SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?", `order:${o}:claimed`), 1);
  assert.equal((await buyer.post(`/api/orders/${o}/cancel-purchase`)).status, 409, 'cannot cancel after saying you paid');
  // forging statuses from the client is impossible: these endpoints either don't exist or refuse
  assert.equal((await buyer.post(`/api/orders/${o}/confirm`)).status, 409);
  assert.equal((await buyer.post(`/api/seller/orders/${o}/confirm-payment`)).status, 403);
  assert.equal((await buyer.post(`/api/orders/${o}/received`)).status, 409);
  assert.equal((await buyer.put(`/api/orders/${o}`, { status: 'paid' })).status, 404);
  assert.equal((await buyer.post(`/api/orders/${o}/dispute`, { reason: 'I want my money back please' })).status, 409);
  // a provider webhook can never mark a direct order paid (sandbox provider is enabled in this test env)
  const ck = row(o).checkout_id, total = row(o).total_cents;
  const raw = JSON.stringify({ id: 'evt_forged_1', type: 'payment_succeeded', checkoutId: ck, amountCents: total });
  const hook = await fetch(H.base + '/webhooks/payments/sandbox', { method: 'POST', headers: { 'x-sandbox-signature': payments.sandbox.sign(raw) }, body: raw });
  assert.equal((await hook.json()).ignored, true);
  assert.equal(row(o).status, 'pending_payment'); assert.equal(listingRow(id).status, 'reserved');
  // the seller (and only the seller) can confirm; the address stays hidden until they do
  const page = (await seller.get(`/dashboard/orders/${o}`)).text;
  assert.match(page, /Confirm the payment/); assert.doesNotMatch(page, /1 Main St/); assert.match(page, /shown after you confirm/);
});

test('seller confirmation: authorization, state, inventory, no wallet movement; then fulfilment with tracking', async () => {
  const { seller, buyer, id } = await scene();
  const evil = await H.newSeller('Evil');
  const o = (await purchase(buyer, id)).json.orderId;
  assert.equal((await evil.post(`/api/seller/orders/${o}/confirm-payment`)).status, 404);
  assert.equal((await evil.get(`/dashboard/orders/${o}`)).status, 404);
  assert.equal((await evil.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899223344' })).status, 404);
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899223344' })).status, 409, 'cannot ship an unconfirmed order');
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`, { reference: 'ch_3Abc12' })).status, 200);
  const paid = row(o);
  assert.equal(paid.status, 'paid'); assert.ok(paid.payment_confirmed_at); assert.equal(paid.payment_reference, 'ch_3Abc12'); assert.equal(listingRow(id).status, 'sold');
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 409, 'cannot confirm twice');
  assert.equal(count('SELECT COUNT(*) n FROM ledger'), 0, 'direct orders never touch the wallet ledger');
  assert.equal((await seller.get(`/dashboard/orders/${o}`)).text.includes('1 Main St'), true, 'address visible after confirmation');
  assert.match((await seller.get('/dashboard/orders')).text, /Confirmed by you/);
  // buyer is notified once
  assert.equal(count('SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?', `order:${o}:confirmed`), 1);
  // fulfilment: bad carrier / tracking rejected, label providers are plain external links, no label is bought for them
  const page = (await seller.get(`/dashboard/orders/${o}`)).text;
  assert.match(page, /does <strong>not<\/strong> buy labels/); assert.match(page, /rel="noopener noreferrer"/);
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'Sketchy Courier', tracking: '9400111899223344' })).status, 422);
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: 'x<script>' })).status, 422);
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899223344' })).status, 200);
  const bp = (await buyer.get(`/orders/${o}`)).text;
  assert.match(bp, /Seller confirmed payment on/); assert.match(bp, /https:\/\/tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9400111899223344/); assert.match(bp, /Mark as received/);
  assert.equal((await evil.post(`/api/seller/orders/${o}/received`)).status, 404);
  assert.equal((await buyer.post(`/api/orders/${o}/received`)).status, 200);
  assert.equal(row(o).status, 'delivered'); assert.equal(row(o).auto_release_at, null, 'no escrow clock');
  assert.equal(count('SELECT COUNT(*) n FROM ledger'), 0);
  // review is allowed once delivered; escrow functions refuse direct orders
  assert.equal((await buyer.post(`/api/orders/${o}/review`, { rating: 5, body: 'Great seller' })).status, 200);
  const escrow = require('../src/escrow');
  assert.throws(() => escrow.releaseToSeller(o, 'test'), (e) => e.status === 409);
  assert.throws(() => escrow.buyerConfirm(o, row(o).buyer_id), (e) => e.status === 409);
  assert.equal(escrow.autoReleaseDue(), 0);
  // seller dashboard: direct section only, no fees/escrow/payout claims for these sales
  const dash = (await seller.get('/dashboard')).text;
  assert.match(dash, /Direct checkout/); assert.match(dash, /PairPlug does not process these payments/);
  const ov = require('../src/stats').overview(q.get('SELECT id FROM users WHERE handle = ?', seller.handle).id);
  assert.equal(ov.direct.confirmed, 1); assert.equal(ov.direct.gross, 4000); assert.equal(ov.net, 0); assert.equal(ov.balance.escrowCents, 0); assert.equal(ov.balance.availableCents, 0);
  assert.equal(ov.direct.margin.margin, 2500, 'price 40 - cost 15');
});

test('abandoned / expired / rejected / cancelled checkouts release the item and never create paid orders', async () => {
  const { seller, buyer, id } = await scene();
  // buyer cancels before paying
  let o = (await purchase(buyer, id)).json.orderId;
  assert.equal((await buyer.post(`/api/orders/${o}/cancel-purchase`)).status, 200);
  assert.equal(row(o).status, 'cancelled'); assert.equal(listingRow(id).status, 'active');
  assert.equal((await buyer.post(`/api/orders/${o}/cancel-purchase`)).status, 409);
  assert.notEqual((await buyer.get(`/orders/${o}/pay`)).status, 302);
  // expiry (abandoned)
  o = (await purchase(buyer, id)).json.orderId;
  q.run('UPDATE checkouts SET expires_at = 1 WHERE id = ?', row(o).checkout_id);
  assert.equal(payments.expireStaleCheckouts(), 1);
  assert.equal(row(o).status, 'cancelled'); assert.equal(listingRow(id).status, 'active'); assert.equal(listingRow(id).reserved_checkout_id, null);
  assert.equal(count('SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?', `order:${o}:expired`), 1);
  assert.equal((await buyer.post(`/api/orders/${o}/claim-paid`)).status, 409, 'cannot claim on an expired reservation');
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 409, 'cannot confirm a released reservation');
  assert.equal(payments.expireStaleCheckouts(), 0, 'sweeper is idempotent');
  // the item can be bought by someone else afterwards, and the old order can't interfere
  const other = await H.newUser(); const o2 = (await purchase(other, id)).json.orderId;
  assert.equal(listingRow(id).reserved_checkout_id, row(o2).checkout_id);
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 409);
  // seller rejects (no payment received)
  assert.equal((await seller.post(`/api/seller/orders/${o2}/reject-payment`)).status, 200);
  assert.equal(row(o2).status, 'cancelled'); assert.equal(listingRow(id).status, 'active');
  assert.equal(count("SELECT COUNT(*) n FROM orders WHERE status = 'paid' AND payment_mode = 'external'"), 0 + count("SELECT COUNT(*) n FROM orders WHERE status = 'paid' AND payment_mode = 'external' AND payment_confirmed_at IS NOT NULL"), 'no paid direct order exists without a seller confirmation');
  assert.equal(count("SELECT COUNT(*) n FROM orders WHERE payment_mode = 'external' AND status = 'paid' AND payment_confirmed_at IS NULL"), 0);
});

test('hoarding limits: a buyer can hold at most 3 unpaid reservations', async () => {
  const seller = await H.newSeller('Hoard'), buyer = await H.newUser();
  const ids = []; for (let i = 0; i < 4; i++) ids.push(await listing(seller, { title: 'Item ' + i }));
  for (let i = 0; i < 3; i++) assert.equal((await purchase(buyer, ids[i])).status, 200);
  const fourth = await purchase(buyer, ids[3]); assert.equal(fourth.status, 429);
  assert.equal(listingRow(ids[3]).status, 'active', 'a refused purchase leaves the item untouched');
});

test('concurrency: 12 buyers race for one unique item → exactly one reservation and one order', async () => {
  const seller = await H.newSeller('Race'); const id = await listing(seller, { title: 'Grail' });
  const buyers = await Promise.all(Array.from({ length: 12 }, () => H.newUser('R')));
  const rs = await Promise.all(buyers.map((b) => purchase(b, id)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(rs.filter((r) => r.status === 409).length, 11);
  assert.equal(count('SELECT COUNT(*) n FROM order_items WHERE listing_id = ?', id), 1);
});

test('seller-declared refund: recorded without any provider call, optional relist; platform refund route refuses', async () => {
  const { seller, buyer, id } = await scene();
  const o = (await purchase(buyer, id)).json.orderId; await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  assert.equal((await seller.post(`/api/seller/orders/${o}/cancel`)).status, 409, 'PairPlug-refund route cannot touch a direct order');
  assert.equal(row(o).status, 'paid');
  assert.equal((await seller.post(`/api/seller/orders/${o}/refunded`, { relist: true })).status, 422, 'must attest the refund');
  assert.equal((await buyer.post(`/api/seller/orders/${o}/refunded`, { confirm_refunded: true })).status, 403);
  assert.equal((await seller.post(`/api/seller/orders/${o}/refunded`, { confirm_refunded: true, relist: true })).status, 200);
  assert.equal(row(o).status, 'refunded'); assert.equal(row(o).refunded_cents, row(o).total_cents); assert.equal(listingRow(id).status, 'active');
  assert.equal(count('SELECT COUNT(*) n FROM refunds WHERE order_id = ?', o), 0, 'no refund object: PairPlug did not refund anything');
  assert.equal((await seller.post(`/api/seller/orders/${o}/refunded`, { confirm_refunded: true })).status, 409);
});

test('privacy: other users cannot see a direct order or its address; sellers cannot see addresses of other sellers\' orders', async () => {
  const { seller, buyer, id } = await scene();
  const o = (await purchase(buyer, id)).json.orderId; await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  const stranger = await H.newUser(), evil = await H.newSeller('Spy');
  for (const c of [stranger, evil]) { assert.equal((await c.get(`/orders/${o}`)).status, 404); assert.doesNotMatch((await c.get('/orders')).text, /Test jacket/); }
  assert.doesNotMatch((await evil.get('/dashboard/orders')).text, /Test jacket/);
  assert.equal((await new H.Client().get(`/dashboard/orders/${o}`)).status, 302);
  assert.match((await buyer.get(`/orders/${o}`)).text, /Test jacket/);
});

test('snapshot and financial history are immutable at the database level', async () => {
  const { seller, buyer, id } = await scene();
  const o = (await purchase(buyer, id)).json.orderId; await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  assert.throws(() => q.run("UPDATE orders SET snapshot_json = '{}' WHERE id = ?", o), /immutable/);
  assert.throws(() => q.run('UPDATE orders SET total_cents = 1 WHERE id = ?', o), /immutable/);
  assert.throws(() => q.run('UPDATE orders SET shipping_cents = 0 WHERE id = ?', o), /immutable/);
  assert.throws(() => q.run('DELETE FROM orders WHERE id = ?', o), /cannot be deleted/);
  assert.throws(() => q.run("UPDATE order_items SET price_cents = 1 WHERE order_id = ?", o), /immutable/);
  // editing the live listing afterwards never changes what the order recorded
  q.run("UPDATE listings SET title = 'Renamed', price_cents = 99900 WHERE id = ?", id);
  assert.equal(JSON.parse(row(o).snapshot_json).listing.title, 'Test jacket'); assert.equal(row(o).subtotal_cents, 4000);
  assert.match((await buyer.get(`/orders/${o}`)).text, /Test jacket/);
  // ledger is append-only (legacy escrow history can't be rewritten)
  const uid = q.get('SELECT id FROM users LIMIT 1').id;
  q.run("INSERT INTO ledger(user_id, kind, amount_cents, note, created_at) VALUES(?, 'adjustment', 5, 'immutability test', 1)", uid);
  assert.throws(() => q.run("UPDATE ledger SET amount_cents = 6 WHERE note = 'immutability test'"), /append-only/);
  assert.throws(() => q.run("DELETE FROM ledger WHERE note = 'immutability test'"), /append-only/);
});

test('XSS: seller-controlled text on direct order pages is escaped', async () => {
  const seller = await H.newSeller('Xss'), buyer = await H.newUser();
  const id = await listing(seller, { title: '<img src=x onerror=alert(1)>', brand: '"><svg onload=1>' });
  const o = (await purchase(buyer, id, { address: { ...H.address, name: '<script>alert(2)</script>' } })).json.orderId;
  await seller.post(`/api/seller/orders/${o}/confirm-payment`, { reference: '<b>x</b>' });
  for (const [c, u] of [[buyer, `/orders/${o}`], [seller, `/dashboard/orders/${o}`], [seller, '/dashboard/orders']]) {
    const t = (await c.get(u)).text;
    assert.ok(!t.includes('<img src=x onerror') && !t.includes('<script>alert(2)') && !t.includes('<b>x</b>'), u);
  }
});

test('messaging still works alongside direct checkout (buyer → seller from a listing)', async () => {
  const { seller, buyer, id } = await scene();
  const conv = await buyer.post('/api/chat/conversations', { listingId: id }); assert.equal(conv.status, 200);
  const sent = await buyer.post('/api/chat/command', { op: 'send', conversationId: conv.json.id, clientId: 'direct-test-0001', body: 'Does the link include shipping?' });
  assert.equal(sent.status, 200);
  const got = (await seller.get('/api/chat/sync?after=0')).json; assert.equal(got.messages.at(-1).body, 'Does the link include shipping?');
  const stranger = await H.newUser(); assert.equal((await stranger.post('/api/chat/command', { op: 'history', conversationId: conv.json.id })).status, 404);
});

test('error responses do not leak stack traces or internals', async () => {
  const c = await H.newUser();
  const malformed = await fetch(H.base + '/api/account', { method: 'PATCH', headers: { cookie: c.cookie, 'x-requested-with': 'pairplug', 'content-type': 'application/json' }, body: '{bad json' });
  const t = await malformed.text(); assert.equal(malformed.status, 400); assert.doesNotMatch(t, /at .*\.js|node_modules|SyntaxError/);
  const nf = await c.get('/api/nope'); assert.equal(nf.status, 404); assert.doesNotMatch(nf.text, /at .*\.js/);
  const html = await c.get('/orders/999999'); assert.equal(html.status, 404); assert.doesNotMatch(html.text, /at .*\.js|SQLITE/);
});
