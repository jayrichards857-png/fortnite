'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { PricingEngine, isLocalShip } = require('../src/pricing');
const { canTransition, TRANSITIONS } = require('../src/orderMachine');
const { parseCsv, validateListing } = require('../src/listings');
const { sniff } = require('../src/images');
const { stripe } = require('../src/payments');
const config = require('../src/config');
const crypto = require('node:crypto');

// The fee engine stays generic (historic orders, arithmetic): these tests give it explicit non-zero rates. The shipped defaults are 0% (see the next test).
const S = { ...config.defaults, fee_bps_standard: 1000, fee_bps_pro: 600 };
test('Grailedside commission defaults to 0% for standard and pro sellers, and the engine then takes nothing', () => {
  assert.equal(config.defaults.fee_bps_standard, 0); assert.equal(config.defaults.fee_bps_pro, 0);
  const e = new PricingEngine({ ...config.defaults }, 0), o = e.priceOrder({ subtotalCents: 10000, shippingCents: 800, sellerPlan: 'standard' });
  assert.equal(o.platformFeeCents, 0); assert.equal(e.priceOrder({ subtotalCents: 10000, shippingCents: 800, sellerPlan: 'pro' }).platformFeeCents, 0);
});
test('PricingEngine: payout and revenue formulas', () => {
  const e = new PricingEngine(S, 0);
  const o = e.priceOrder({ subtotalCents: 10000, shippingCents: 800, sellerPlan: 'standard' });
  assert.equal(o.platformFeeCents, 1000);
  assert.equal(o.totalCents, 10800);
  assert.equal(o.processingFeeCents, Math.round(10800 * 0.029) + 30);
  assert.equal(o.sellerPayoutCents, 10000 + 800 - 1000 - o.processingFeeCents);
  assert.equal(o.platformRevenueCents, 1000);
  assert.equal(e.priceOrder({ subtotalCents: 10000, shippingCents: 0, sellerPlan: 'pro' }).platformFeeCents, 600);
});
test('PricingEngine: tax is added to buyer total but not paid to seller', () => {
  const e = new PricingEngine(S, 800);
  const o = e.priceOrder({ subtotalCents: 5000, shippingCents: 500, sellerPlan: 'standard' });
  assert.equal(o.taxCents, 440);
  assert.equal(o.totalCents, 5940);
  assert.equal(o.sellerPayoutCents, 5500 - 500 - o.processingFeeCents);
});
test('PricingEngine: shipping label margin is platform revenue', () => {
  const e = new PricingEngine({ ...S, shipping_margin_bps: 1000 }, 0);
  assert.deepEqual(e.labelCharge(800), { chargeCents: 880, marginCents: 80 });
});
test('Profit calculator recommends a price that achieves the margin', () => {
  const e = new PricingEngine(S, 0);
  for (const margin of [10, 30, 50]) {
    const r = e.recommendPrice({ costCents: 2000, labelCostCents: 700, shippingChargedCents: 0, marginPct: margin });
    assert.ok(r.marginPct >= margin - 0.01, `margin ${r.marginPct} < ${margin}`);
    assert.ok(r.marginPct < margin + 2);
    assert.equal(r.profitCents, r.sellerPayoutCents - 2000 - 700);
  }
  assert.equal(e.recommendPrice({ costCents: 100, marginPct: 95 }), null);
});
test('Local ship badge covers North America only', () => {
  assert.ok(isLocalShip('US') && isLocalShip('ca') && isLocalShip('MX'));
  assert.ok(!isLocalShip('CN') && !isLocalShip(''));
});
test('Order state machine: only legal transitions', () => {
  assert.ok(canTransition('pending_payment', 'paid'));
  assert.ok(canTransition('delivered', 'released'));
  assert.ok(canTransition('disputed', 'refunded'));
  assert.ok(!canTransition('paid', 'released'), 'cannot skip shipment/delivery');
  assert.ok(!canTransition('pending_payment', 'released'));
  assert.ok(!canTransition('released', 'refunded'), 'released funds are final');
  assert.ok(!canTransition('refunded', 'paid'));
  for (const t of ['released', 'refunded', 'cancelled']) assert.equal(TRANSITIONS[t].length, 0);
});
test('CSV parser handles quotes, commas, CRLF', () => {
  const rows = parseCsv('sku,title\r\nA1,"Hat, wool"\r\nA2,"He said ""hi"""\r\n');
  assert.deepEqual(rows, [['sku', 'title'], ['A1', 'Hat, wool'], ['A2', 'He said "hi"']]);
});
test('Listing validation rejects bad input with field errors', () => {
  assert.throws(() => validateListing({ title: 'x', category: 'nope', price: '-3' }, { publish: true }), (e) => e.status === 422 && Boolean(e.fields.title && e.fields.category && e.fields.price && e.fields.images));
  assert.throws(() => validateListing({ title: 'Valid title', category: 'denim', price: '12.345', condition: 'good', images: ['a'], weight_oz: '5' }, { publish: true }), (e) => Boolean(e.fields.price));
});
test('Image sniffing trusts bytes, not names', () => {
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)></svg>')), null);
  assert.equal(sniff(Buffer.from('GIF89a......')), null);
  assert.equal(sniff(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'jpg');
});
test('Stripe webhook signature verification', () => {
  config.stripe.webhookSecret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: '7', amount_total: 1234 } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = (ts, secret) => `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  assert.deepEqual(stripe.verifyWebhook(body, { 'stripe-signature': sig(t, 'whsec_test') }), { id: 'evt_1', type: 'payment_succeeded', checkoutId: 7, amountCents: 1234 });
  assert.throws(() => stripe.verifyWebhook(body, { 'stripe-signature': sig(t, 'wrong') }), /signature/i);
  assert.throws(() => stripe.verifyWebhook(body, { 'stripe-signature': sig(t - 4000, 'whsec_test') }), /signature/i);
});
