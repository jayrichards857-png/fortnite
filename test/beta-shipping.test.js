'use strict';
// Live-beta shipping: sellers buy postage themselves and record carrier + tracking. PairPlug never buys labels or pays postage, and Shippo
// label purchasing is unavailable outside the isolated sandbox (even with a test token, a live token, or a mistaken configuration).
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const SH = require('../src/shippo');

const LINK = 'https://buy.stripe.com/test_beta_ship1';
let calls = [];
test.before(async () => { await H.start(); SH.setTransport(async (r) => { calls.push(r); return { status: 200, json: {} }; }); });
test.after(() => { SH.setTransport(null); config.shippo = { apiKey: '', mode: 'off' }; config.sandbox = false; return H.stop(); });
test.beforeEach(() => { calls = []; config.shippo = { apiKey: '', mode: 'off' }; config.sandbox = false; });

async function order({ confirm = true, payer = 'buyer' } = {}) {
  const seller = await H.newSeller('Beta'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: payer === 'seller' ? '0' : '6.00', shipping_payer: payer });
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId;
  if (confirm) assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 200);
  return { seller, buyer, o };
}
const NO_LABEL_UI = /Buy shipping label|Get shipping rates|Shipping label \(sandbox|TEST MODE|id="ship-panel"|shipping\.js/;

test('the live seller order page explains the manual workflow in plain steps and offers no PairPlug label purchase', async () => {
  const { seller, o } = await order(); const page = (await seller.get(`/dashboard/orders/${o}`)).text;
  assert.match(page, /Ship this order/); assert.match(page, /Buy postage yourself/); assert.match(page, /PairPlug does not buy labels or pay postage/);
  assert.match(page, /Recipient/); assert.match(page, /Enter the carrier and tracking number/); assert.match(page, /Mark shipped/);
  assert.match(page, /it is <em>not<\/em> a prepaid label/); assert.match(page, /you still buy and pay for postage yourself/);
  assert.match(page, /records<\/strong> it in PairPlug/); assert.match(page, /does not buy postage and does not guarantee delivery/);
  for (const c of config.carriers) assert.ok(page.includes(`<option>${c}</option>`), `carrier ${c}`);
  assert.match(page, /name="tracking"/); assert.match(page, /name="note"/);
  assert.doesNotMatch(page, NO_LABEL_UI, 'no label-purchase UI in the beta');
  const free = await order({ payer: 'seller' }); assert.match((await free.seller.get(`/dashboard/orders/${free.o}`)).text, /Free shipping:<\/strong> you offered free shipping, so you pay the postage yourself/);
  assert.match((await seller.get('/dashboard/orders')).text, /does not buy shipping labels or pay postage/);
});

test('manual shipping works end to end: carrier + tracking + note, buyer notified, no postage claim', async () => {
  const { seller, buyer, o } = await order();
  const r = await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899223344', note: 'Left at the front desk' }); assert.equal(r.status, 200, r.text);
  const row = await q.get('SELECT status, carrier, tracking_number, ship_note FROM orders WHERE id = ?', o); assert.deepEqual({ ...row }, { status: 'shipped', carrier: 'USPS', tracking_number: '9400111899223344', ship_note: 'Left at the front desk' });
  const bp = (await buyer.get(`/orders/${o}`)).text; assert.match(bp, /9400111899223344/); assert.match(bp, /Left at the front desk/); assert.match(bp, /not proof of delivery/);
  assert.equal((await q.get('SELECT COUNT(*) n FROM shipments')).n, 0, 'no label/shipment record was created');
  assert.equal(calls.length, 0, 'no provider call');
  assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899223355' })).status, 409, 'cannot ship twice');
  // refunds keep working on a shipped order (request -> seller report -> buyer confirms)
  assert.equal((await buyer.post(`/api/orders/${o}/refund-request`, { reason: 'Item arrived damaged in transit' })).status, 200);
});

test('existing safeguards still apply: payment must be confirmed, ownership, roles, input validation', async () => {
  const unpaid = await order({ confirm: false }), paid = await order(), other = await H.newSeller('Other');
  assert.notEqual((await unpaid.seller.post(`/api/seller/orders/${unpaid.o}/ship`, { carrier: 'USPS', tracking: '9400111899223366' })).status, 200, 'unpaid orders cannot ship');
  assert.equal((await q.get('SELECT status s FROM orders WHERE id = ?', unpaid.o)).s, 'pending_payment');
  assert.equal((await other.post(`/api/seller/orders/${paid.o}/ship`, { carrier: 'USPS', tracking: '9400111899223377' })).status, 404);
  assert.equal((await other.get(`/dashboard/orders/${paid.o}`)).status, 404);
  assert.equal((await paid.buyer.post(`/api/seller/orders/${paid.o}/ship`, { carrier: 'USPS', tracking: '9400111899223377' })).status, 403);
  assert.equal((await paid.seller.post(`/api/seller/orders/${paid.o}/ship`, { carrier: 'Teleport', tracking: '9400111899223377' })).status, 422);
  assert.equal((await paid.seller.post(`/api/seller/orders/${paid.o}/ship`, { carrier: 'USPS', tracking: 'x' })).status, 422);
  assert.equal((await q.get('SELECT status s FROM orders WHERE id = ?', paid.o)).s, 'paid');
  assert.ok(!(await unpaid.seller.get(`/dashboard/orders/${unpaid.o}`)).text.includes('Mark shipped'), 'no shipping form before payment is confirmed');
});

test('Shippo label purchase is unavailable in the beta even if a key is configured: only a test token inside the isolated sandbox enables it', async () => {
  const { seller, o } = await order(); await seller.put('/api/seller/ship-from', { name: 'Seller', line1: '5 Warehouse Rd', city: 'Brooklyn', region: 'NY', postal: '11201', country: 'US' });
  const body = { weight_oz: 20, length_in: 12, width_in: 9, height_in: 4 };
  const cases = [['test key, NOT sandbox', { apiKey: 'shippo_test_X', mode: 'test' }, false], ['live key, sandbox', { apiKey: 'shippo_live_X', mode: 'live-blocked' }, true], ['invalid key, sandbox', { apiKey: 'junk', mode: 'invalid' }, true], ['no key, sandbox', { apiKey: '', mode: 'off' }, true]];
  for (const [label, shippo, sandbox] of cases) {
    config.shippo = shippo; config.sandbox = sandbox; assert.equal(SH.enabled(), false, label);
    const st = await seller.get(`/api/seller/orders/${o}/shipping`); assert.equal(st.json.enabled, false, label); assert.match(st.json.disabledReason, /does not buy shipping labels/); assert.ok(!st.text.includes('shippo_'), 'no key detail in seller-visible output');
    assert.equal((await seller.post(`/api/seller/orders/${o}/shipping/rates`, body)).status, 503, label);
    assert.equal((await seller.post(`/api/seller/orders/${o}/shipping/buy`, { rateId: 'r', expectedAmountCents: 1, confirm: true })).status, 503, label);
    assert.doesNotMatch((await seller.get(`/dashboard/orders/${o}`)).text, NO_LABEL_UI, label);
  }
  assert.equal(calls.length, 0, 'the provider was never contacted, so no customer address was sent to Shippo');
  config.shippo = { apiKey: 'shippo_test_X', mode: 'test' }; config.sandbox = true; assert.equal(SH.enabled(), true, 'the sandbox + test token combination still works');
  assert.match((await seller.get(`/dashboard/orders/${o}`)).text, /id="ship-panel"/, 'the sandbox keeps its label panel');
  config.isProd = true; try { assert.equal(SH.enabled(), false, 'never in production'); } finally { config.isProd = false; }
});
