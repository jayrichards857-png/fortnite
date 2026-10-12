'use strict';
// Checkout amount safety and the whole buyer/seller/moderator lifecycle, on throwaway data only.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_life1';
const get = async (c, u) => (await c.get(u)).text;
const text0 = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const uid = (email) => q.get('SELECT id FROM users WHERE email = ?', email).id;
const mkAdmin = async () => { const a = await H.newUser('Owner'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
async function newMod(adm) {
  const email = `lm${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`, inv = await adm.post('/api/admin/moderators/invite', { email });
  const c = new H.Client(); c.email = email; assert.equal((await c.post('/api/moderator/setup', { token: inv.json.link.split('/').pop(), display_name: 'Life Mod', password: 'a-very-long-passphrase', terms: true })).status, 200); return c;
}
const body = (seller, over = {}) => H.upload(seller).then((f) => ({ title: 'Sp5der hoodie', description: 'Worn once', category: 'clothing', brand: 'Sp5der', size: 'L', condition: 'good', price: '100.00', shipping: '7.85', weight_oz: '24', images: [f], status: 'active', payment_url: LINK, ...over }));

test('checkout amounts: the listing, buy page, order and snapshot agree on item + shipping; a mismatched link cannot be offered', async () => {
  const seller = await H.newSeller('Amt'), buyer = await H.newUser('Amt');
  // the reported case: $100 item + $7.85 shipping = $107.85 total
  const made = await seller.post('/api/seller/listings', await body(seller, { payment_amount_ack: true, quantity: 3 })); assert.equal(made.status, 200); const id = made.json.id;
  assert.equal(q.get('SELECT payment_total_ack_cents a FROM listings WHERE id = ?', id).a, 10785);
  const listing = await get(buyer, `/listing/${id}`); assert.match(listing, /\$100\.00/); assert.match(listing, /\$7\.85 flat/); assert.match(listing, /\$107\.85/);
  const buyPage = await get(buyer, `/buy/${id}`); assert.match(buyPage, /\$107\.85/); assert.match(text0(buyPage), /The total shown on PairPlug should match the amount shown at Stripe checkout before you pay/);
  const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200); const o = oid(r);
  const row = q.get('SELECT * FROM orders WHERE id = ?', o); assert.deepEqual([row.subtotal_cents, row.shipping_cents, row.total_cents], [10000, 785, 10785]);
  const snap = JSON.parse(row.snapshot_json); assert.equal(snap.terms.totalCents, 10785); assert.equal(snap.terms.currency, 'USD');
  const page = await get(buyer, `/orders/${o}`); assert.match(page, /\$107\.85/); assert.match(page, /Before you pay/); assert.match(text0(page), /If the amounts differ, do not complete the payment\. Return to PairPlug and contact support/);
  const pay = await buyer.get(`/orders/${o}/pay`); assert.equal(pay.status, 302); const u = new URL(pay.headers.get('location')); assert.equal(u.hostname, 'buy.stripe.com'); assert.equal(u.searchParams.get('client_reference_id'), `PP-${o}`);
  assert.doesNotMatch(u.search, /amount|price|prefilled/i, 'PairPlug cannot set the amount on the provider page, and does not pretend to');
  // changing the price (the link now charges the OLD total) un-confirms it: checkout is paused until the seller confirms again
  const cheaper = await seller.put(`/api/seller/listings/${id}`, await body(seller, { price: '14.15', payment_amount_ack: false, quantity: 3 })); assert.equal(cheaper.status, 200);
  assert.equal(q.get('SELECT payment_total_ack_cents a FROM listings WHERE id = ?', id).a, null);
  assert.doesNotMatch(await get(new H.Client(), `/listing/${id}`), />Buy now</); const other = await H.newUser('Late');
  const blocked = await other.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(blocked.status, 409); assert.match(blocked.text, /confirm that their Stripe link charges/);
  assert.match(await get(other, `/listing/${id}`), /still needs to confirm/);
  const again = await seller.put(`/api/seller/listings/${id}`, await body(seller, { price: '14.15', payment_amount_ack: true, payment_ack_total_cents: 2200, payment_ack_url: LINK, quantity: 3 })); assert.equal(again.status, 200); assert.equal(q.get('SELECT payment_total_ack_cents a FROM listings WHERE id = ?', id).a, 2200);
  assert.equal((await other.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 200);
  // editing other fields without touching price/shipping/link keeps the confirmation; ticking it off clears it
  const keep0 = await seller.put(`/api/seller/listings/${id}`, { ...(await body(seller, { price: '14.15', title: 'Renamed', quantity: 3 })) }); assert.equal(keep0.status, 200); assert.equal(q.get('SELECT payment_total_ack_cents a FROM listings WHERE id = ?', id).a, 2200, 'silence keeps an unchanged confirmation');
  const s2 = await seller.post('/api/seller/listings', await body(seller, { title: 'Ship change', payment_amount_ack: true })); const sid = s2.json.id;
  assert.equal((await seller.put(`/api/seller/listings/${sid}`, await body(seller, { title: 'Ship change 2', payment_amount_ack: false }))).status, 200); assert.equal(q.get('SELECT payment_total_ack_cents a FROM listings WHERE id = ?', sid).a, null, 'ack is a per-save statement; unticking it clears it');
  const s3 = await seller.post('/api/seller/listings', await body(seller, { title: 'Free ship', shipping_payer: 'seller', shipping: '0', payment_amount_ack: true })); assert.equal(q.get('SELECT payment_total_ack_cents a FROM listings WHERE id = ?', s3.json.id).a, 10000, 'free shipping: the total is the price');
  assert.match(await get(buyer, `/listing/${s3.json.id}`), /Free shipping/);
});

test('a payment link that cannot be a live one is refused in production, and a buyer\'s claim never verifies a payment', async () => {
  const seller = await H.newSeller('Prod'), buyer = await H.newUser('Prod'), keep = config.isProd;
  const { validatePaymentUrl } = require('../src/paymentLinks');
  try {
    config.isProd = true; assert.throws(() => validatePaymentUrl('https://buy.stripe.com/test_abc123'), (e) => /TEST-mode link/.test(JSON.stringify(e.fields)));
    assert.ok(validatePaymentUrl('https://buy.stripe.com/abcLIVE123')); config.isProd = false; assert.ok(validatePaymentUrl('https://buy.stripe.com/test_abc123'), 'allowed outside production for development');
    const ok = await seller.post('/api/seller/listings', await body(seller, { payment_url: 'https://buy.stripe.com/test_abc123', payment_amount_ack: true })); assert.equal(ok.status, 200);
    const r = await buyer.post('/api/purchases', { listingId: ok.json.id, acknowledged: true, address: H.address }); const o = oid(r), X = require('../src/externalCheckout');
    assert.ok(X.payRedirect({ id: uid(buyer.email) }, o), 'followed outside production'); config.isProd = true;
    assert.throws(() => X.payRedirect({ id: uid(buyer.email) }, o), /no longer accepted/, 'a test-mode link already on an order is never followed in production');
  } finally { config.isProd = keep; }
  // claims are claims
  const id = await H.makeListing(seller, { payment_url: LINK }); const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); const o = oid(r);
  assert.equal((await buyer.post(`/api/orders/${o}/claim-paid`, {})).status, 200); const row = q.get('SELECT status, payment_confirmed_at c, payment_confirmed_by b, buyer_claimed_paid_at k FROM orders WHERE id = ?', o);
  assert.deepEqual({ ...row, k: Boolean(row.k) }, { status: 'pending_payment', c: null, b: null, k: true }); assert.match(await get(buyer, `/orders/${o}`), /unverified|only the seller can confirm|Awaiting payment confirmation/i);
});

test('the whole lifecycle: publish -> order -> pay -> confirm -> ship -> received -> review; fraud report -> moderator restricts, bans, unbans; history and audit intact', async () => {
  const adm = await mkAdmin(), mod = await newMod(adm), seller = await H.newSeller('Life'), buyer = await H.newUser('Life'), stranger = await H.newUser('Nosy');
  // 1-3 publish, open, price and shipping shown
  const id = (await seller.post('/api/seller/listings', await body(seller, { payment_amount_ack: true }))).json.id; assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'active');
  const lp = await get(buyer, `/listing/${id}`); assert.match(lp, /\$107\.85/); assert.match(lp, /Buy now/);
  // 4 order + external payment flow
  const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200); const o = oid(r);
  assert.equal((await buyer.get(`/orders/${o}/pay`)).status, 302);
  // 7 who can see what (before confirmation the seller does not see the address)
  assert.doesNotMatch(await get(seller, `/dashboard/orders/${o}`), new RegExp(H.address.line1)); assert.match(await get(seller, `/dashboard/orders/${o}`), /Confirm the payment/);
  for (const c of [stranger, new H.Client()]) assert.ok([302, 401, 403, 404].includes((await c.get(`/orders/${o}`)).status)); assert.notEqual((await stranger.get(`/dashboard/orders/${o}`)).status, 200);
  // 5 seller confirms; decline path on a second order
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`, { reference: 'abc' })).status, 200); assert.match(await get(seller, `/dashboard/orders/${o}`), new RegExp(H.address.line1)); assert.match(await get(buyer, `/orders/${o}`), /Payment confirmed/);
  const id2 = await H.makeListing(seller, { payment_url: LINK }), o2 = oid(await buyer.post('/api/purchases', { listingId: id2, acknowledged: true, address: H.address }));
  assert.equal((await seller.post(`/api/seller/orders/${o2}/reject-payment`, {})).status, 200); assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o2).status, 'cancelled'); assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id2).status, 'active');
  // 6 ship with tracking; the buyer sees it and marks received (tracking alone is never "delivered")
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899223399' })).status, 200); assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o).status, 'shipped');
  assert.match(await get(buyer, `/orders/${o}`), /9400111899223399/); assert.equal((await buyer.post(`/api/orders/${o}/received`, {})).status, 200); assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o).status, 'delivered');
  assert.equal((await buyer.post(`/api/orders/${o}/review`, { thumbsUp: true, body: 'Smooth.' })).status, 200); assert.match(await get(new H.Client(), `/s/${seller.handle}`), /Smooth\./);
  // 8 fraud report on a second, never-delivered order
  const id3 = await H.makeListing(seller, { payment_url: LINK }); const o3 = oid(await buyer.post('/api/purchases', { listingId: id3, acknowledged: true, address: H.address }));
  await buyer.get(`/orders/${o3}/pay`); await seller.post(`/api/seller/orders/${o3}/confirm-payment`, {}); const shot = await H.upload(buyer);
  const rep = await buyer.post('/api/cases/order', { orderId: o3, reason: 'Paid, seller confirmed, but nothing ever shipped.', category: 'non_delivery', evidence_json: JSON.stringify([shot]) }); assert.equal(rep.status, 200); const cid = rep.json.id;
  // 9 the moderator investigates and acts
  const cpage = await get(mod, `/admin/cases/${cid}`); assert.match(cpage, /Case #/); assert.match(cpage, new RegExp(`/uploads/${shot}`));
  const pre1 = await body(seller), pre2 = await body(seller);
  const sid = uid(seller.email), before = { orders: q.get('SELECT COUNT(*) n FROM orders').n, events: q.get('SELECT COUNT(*) n FROM case_events').n };
  assert.equal((await mod.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'Non-delivery reported; investigating' })).status, 200); assert.ok(q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', sid).r);
  assert.equal((await seller.post('/api/seller/listings', pre1)).status, 403); assert.equal((await mod.post(`/api/moderation/users/${sid}/lift`, { reason: 'Seller replied with tracking, still checking', caseId: cid })).status, 200);
  assert.equal((await mod.post(`/api/moderation/users/${sid}/ban`, { reason: 'No shipment and no reply after review', caseId: cid })).status, 200);
  assert.equal((await new H.Client().post('/api/login', { email: seller.email, password: 'correct-horse-9' })).status, 403); assert.equal((await seller.get('/dashboard')).status, 302); assert.equal((await seller.post('/api/seller/listings', pre2)).status, 401);
  assert.equal((await seller.post(`/api/seller/orders/${o3}/ship`, { carrier: 'USPS', tracking: '9400111899223377' })).status, 401, 'a banned seller cannot act on orders');
  assert.equal(q.get('SELECT COUNT(*) n FROM orders').n, before.orders); assert.ok(q.get('SELECT COUNT(*) n FROM case_events').n > before.events); assert.equal(q.get('SELECT status FROM orders WHERE id = ?', o).status, 'delivered', 'history intact');
  assert.match(await get(buyer, `/orders/${o3}`), /Payment confirmed/, 'the buyer still sees their order and report');
  // a reversal restores access without deleting anything
  assert.equal((await mod.post(`/api/moderation/users/${sid}/unban`, { reason: 'Seller shipped and buyer confirmed; mistaken report', caseId: cid })).status, 200);
  const back = new H.Client(); assert.equal((await back.post('/api/login', { email: seller.email, password: 'correct-horse-9' })).status, 200); assert.equal((await back.get('/dashboard')).status, 200);
  assert.equal(q.get('SELECT COUNT(*) n FROM orders WHERE seller_id = ?', sid).n, 3); assert.equal(q.get('SELECT COUNT(*) n FROM seller_reviews WHERE seller_id = ?', sid).n, 1); assert.equal(q.get("SELECT COUNT(*) n FROM case_events WHERE case_id = ? AND image = ?", cid, shot).n, 1, 'evidence kept');
  assert.equal(q.get("SELECT status FROM listings WHERE id = ?", id3).status, 'sold', 'paid stock stays sold; paused/unsold listings stay paused until republished');
  // 10 audit trail
  assert.deepEqual(q.all('SELECT action FROM moderation_actions WHERE target_id = ? ORDER BY id', sid).map((a) => a.action), ['restrict_selling', 'lift_restriction', 'ban', 'unban']);
  for (const a of ['case_opened', 'moderation_restrict_selling', 'moderation_lift_restriction', 'moderation_ban', 'moderation_unban']) assert.ok(q.get('SELECT 1 x FROM audit_log WHERE action = ?', a), a);
});
