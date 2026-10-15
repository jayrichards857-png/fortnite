'use strict';
// Free listing, 0% Grailedside commission: nothing in the publish path asks for money, orders carry no Grailedside fee, the UI says so (without claiming
// Stripe is free), no upgrade/plan prompts remain, and the seller-owned Stripe Payment Link model is untouched.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const config = require('../src/config');
const { q, getSettings } = require('../src/db');
const { FREE_LISTING } = require('../src/pricing');

test.before(async () => await H.start());
test.after(() => H.stop());
const LINK = 'https://buy.stripe.com/test_free1';
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '');

test('configuration: commission is 0% for standard AND pro sellers, even if an old settings row says otherwise', async () => {
  assert.equal(config.defaults.fee_bps_standard, 0); assert.equal(config.defaults.fee_bps_pro, 0);
  await q.run("INSERT INTO settings(key, value) VALUES('fee_bps_pro', '600') ON CONFLICT (key) DO UPDATE SET value = '600'");
  const s = await getSettings(); assert.equal(s.fee_bps_standard, 0); assert.equal(s.fee_bps_pro, 0);
  await q.run("DELETE FROM settings WHERE key = 'fee_bps_pro'");
});

test('a seller publishes and manages listings for $0: no payment step, no payment information, no plan required', async () => {
  const seller = await H.newSeller('Free'), pro = await H.newSeller('FreePro', 'pro');
  const before = Number((await q.get('SELECT COUNT(*) n FROM ledger')).n);
  for (const s of [seller, pro]) {
    const id = await H.makeListing(s, { payment_url: LINK, price: '25.00' });                        // create + publish
    assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'active');
    assert.equal((await s.post(`/api/seller/listings/${id}/pause`)).status, 200); assert.equal((await s.post(`/api/seller/listings/${id}/resume`)).status, 200);   // manage
    assert.equal((await s.post(`/api/seller/listings/${id}/duplicate`)).status, 200);
  }
  assert.equal(Number((await q.get('SELECT COUNT(*) n FROM ledger')).n), before, 'no money movement of any kind');
  const form = strip((await seller.get('/dashboard/listings/new')).text);
  assert.doesNotMatch(form, /card number|billing|subscribe|upgrade|listing fee of|insertion fee/i, 'no payment information is asked for to list');
});

test('orders carry 0% Grailedside commission and the seller-owned Stripe link model is unchanged', async () => {
  const seller = await H.newSeller('Direct'), buyer = await H.newUser('Buyer'), id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: '6.00', shipping_payer: 'buyer' });
  const page = strip((await buyer.get(`/listing/${id}`)).text); assert.match(page, /Buy now/); assert.match(page, /\$40\.00/); assert.match(page, /\$6\.00/);   // browse + price + shipping as set by the seller
  assert.equal((await buyer.get('/shop')).status, 200); assert.match((await buyer.get('/shop')).text, /Test jacket/);
  const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text);
  const o = await q.get('SELECT * FROM orders WHERE id = ?', oid(r));
  assert.equal(o.payment_mode, 'external'); assert.equal(o.platform_fee_cents, 0); assert.equal(o.seller_payout_cents, 0, 'Grailedside holds no funds and computes no payout');
  assert.equal(o.subtotal_cents, 4000); assert.equal(o.shipping_cents, 600, 'seller-defined price and shipping are untouched');
  assert.match(String(r.json.redirect), /buy\.stripe\.com|\/orders\//, 'the buyer pays on the seller\'s own Stripe link');
  assert.match(strip((await seller.get('/dashboard')).text), /0% commission/);
});

test('UI: free-to-list and 0% commission are stated; Stripe fees are never called free; no fee/plan/upgrade wording remains', async () => {
  const seller = await H.newSeller('Copy'), admin = await H.newUser('Adm'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', admin.email);
  assert.match(FREE_LISTING, /free/); assert.match(FREE_LISTING, /0% commission/); assert.match(FREE_LISTING, /Stripe may charge you its own processing fees/);
  const pages = { dashboard: '/dashboard', newListing: '/dashboard/listings/new', finance: '/dashboard/finance', terms: '/terms', payments: '/payments' };
  const text = {}; for (const [k, u] of Object.entries(pages)) { const r = await (k === 'terms' || k === 'payments' ? new H.Client() : seller).get(u); assert.equal(r.status, 200, u); text[k] = strip(r.text); }
  for (const k of ['dashboard', 'newListing']) assert.match(text[k], /Free to list/);
  assert.match(text.finance, /Listing is free and Grailedside takes 0% commission/);
  assert.match(text.terms, /Listing on Grailedside is free/); assert.match(text.payments, /takes no commission \(0%\)/);
  for (const [k, t] of Object.entries(text)) {
    assert.doesNotMatch(t, /Stripe[^.]{0,40}\bis free|free[^.]{0,30}Stripe processing/i, `${k}: never claims Stripe is free`);
    assert.doesNotMatch(t, /10% transaction fee|6% for Pro|Pro sellers pay|plan billing|Upgrade to Pro|Standard plan|Plan:\s*<strong>/i, `${k}: outdated pricing text`);
  }
  const settings = strip((await admin.get('/admin/settings')).text); assert.match(settings, /commission is fixed at 0%/); assert.doesNotMatch(settings, /Standard transaction fee|Pro transaction fee/);
  const users = strip((await admin.get('/admin/users')).text); assert.doesNotMatch(users, /<th>Plan<\/th>/); assert.equal((await admin.put('/api/admin/users/1/plan', { plan: 'pro' })).status, 404, 'no paid-plan switch exists');
});
