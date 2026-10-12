'use strict';
// Payment provider boundary. The rest of the app only talks to this interface:
//   provider.createPayment(checkout)  -> { providerRef, redirectUrl? }
//   provider.verifyWebhook(rawBody, headers) -> normalized event | throws
//   provider.refund(payment, amountCents) -> { providerRef }
// Normalized event: { id, type: 'payment_succeeded'|'payment_failed', checkoutId, amountCents? }
//
// Money is only ever marked paid by a *verified webhook* (handlePaymentEvent), never by a browser redirect.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { transition } = require('./orderMachine');
const { notify } = require('./notify');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

// ---- Sandbox provider: for development/tests only. No money moves. Uses the same signed-webhook path as a real provider.
const sandbox = {
  name: 'sandbox',
  sandbox: true,
  async createPayment(checkout) { return { providerRef: `sbx_${checkout.id}_${crypto.randomBytes(4).toString('hex')}`, redirectUrl: `/pay/${checkout.id}` }; },
  sign(body) { return hmac(config.sandboxSecret, body); },
  verifyWebhook(raw, headers) {
    if (!safeEq(headers['x-sandbox-signature'] || '', hmac(config.sandboxSecret, raw))) throw Object.assign(new Error('Bad signature'), { status: 400 });
    return JSON.parse(raw);
  },
  async refund(payment) { return { providerRef: `sbx_re_${payment.id}` }; },
};

// ---- Stripe provider (REST via fetch; no SDK). Needs STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET.
// NOTE: written against Stripe's documented API but NOT exercised against live Stripe in this repo's tests
// (only webhook signature verification is unit-tested). Seller transfers (Connect) are not implemented.
const stripe = {
  name: 'stripe',
  sandbox: false,
  async api(path, params) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.stripe.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Stripe: ${json.error && json.error.message}`);
    return json;
  },
  async createPayment(checkout) {
    const s = await this.api('checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(checkout.total_cents),
      'line_items[0][price_data][product_data][name]': `PairPlug order #${checkout.id}`,
      client_reference_id: String(checkout.id),
      'metadata[checkout_id]': String(checkout.id),
      success_url: `${config.publicUrl}/checkout/${checkout.id}`,
      cancel_url: `${config.publicUrl}/cart`,
    });
    return { providerRef: s.payment_intent || s.id, redirectUrl: s.url };
  },
  verifyWebhook(raw, headers) {
    const sig = String(headers['stripe-signature'] || '');
    const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
    const age = Math.abs(now() - Number(parts.t));
    if (!parts.t || !parts.v1 || age > 300) throw Object.assign(new Error('Bad signature'), { status: 400 });
    if (!safeEq(parts.v1, hmac(config.stripe.webhookSecret, `${parts.t}.${raw}`))) throw Object.assign(new Error('Bad signature'), { status: 400 });
    const ev = JSON.parse(raw);
    const obj = ev.data && ev.data.object;
    const map = { 'checkout.session.completed': 'payment_succeeded', 'checkout.session.async_payment_succeeded': 'payment_succeeded',
      'checkout.session.async_payment_failed': 'payment_failed', 'checkout.session.expired': 'payment_failed' };
    if (!map[ev.type] || !obj) return { id: ev.id, type: 'ignored' };
    if (ev.type === 'checkout.session.completed' && obj.payment_status !== 'paid') return { id: ev.id, type: 'ignored' };
    return { id: ev.id, type: map[ev.type], checkoutId: Number(obj.client_reference_id), amountCents: obj.amount_total };
  },
  async refund(payment, amountCents) {
    const r = await this.api('refunds', { payment_intent: payment.provider_ref, amount: String(amountCents) });
    return { providerRef: r.id };
  },
};

function getProvider() {
  if (config.stripe.secretKey) return stripe;
  if (config.paymentsMode === 'sandbox') return sandbox;
  return null; // checkout disabled: we never pretend payments work without credentials
}
const getProviderByName = (n) => (n === 'stripe' && config.stripe.secretKey ? stripe : n === 'sandbox' && config.paymentsMode === 'sandbox' && !config.stripe.secretKey ? sandbox : null);

/** Release held items back to the marketplace (used on failed/expired checkouts). Call inside tx(). */
async function releaseCheckoutItems(checkoutId) {
  const ck = await q.get('SELECT mode FROM checkouts WHERE id = ?', checkoutId);
  if (ck && ck.mode === 'external') return await require('./inventory').releaseCheckout(checkoutId);     // quantity-aware: give the held unit back
  await q.run(`UPDATE listings SET status='active', reserved_until=NULL, reserved_checkout_id=NULL
         WHERE reserved_checkout_id = ? AND status = 'reserved'`, checkoutId);
}

/**
 * Apply a verified provider event. Idempotent: the (provider,event_id) primary key is inserted in the
 * same transaction as the state change, so a duplicate delivery changes nothing and returns {duplicate:true}.
 */
async function handlePaymentEvent(providerName, ev) {
  return await tx(async () => {
    const ins = await q.run('INSERT OR IGNORE INTO payment_events(event_id, provider, type, processed_at) VALUES(?,?,?,?)', ev.id, providerName, ev.type, now());
    if (ins.changes === 0) return { duplicate: true };
    if (ev.type === 'ignored') return { ignored: true };
    const checkout = await q.get('SELECT * FROM checkouts WHERE id = ?', ev.checkoutId);
    if (!checkout) return { ignored: true };
    // A provider webhook can never mark a seller-direct checkout paid: only the seller's own confirmation can.
    if (checkout.mode === 'external') return { ignored: true };
    const payment = await q.get('SELECT * FROM payments WHERE checkout_id = ? ORDER BY id DESC LIMIT 1', checkout.id);

    if (ev.type === 'payment_succeeded') {
      if (ev.amountCents != null && ev.amountCents !== checkout.total_cents) throw Object.assign(new Error('Amount mismatch'), { status: 400 });
      if (checkout.status !== 'pending') {
        // Paid after we gave up on the checkout (expired/failed): the items may be gone, so refund rather than ship.
        if (payment) await q.run("UPDATE payments SET status = 'needs_refund' WHERE id = ?", payment.id);
        return { lateSuccess: true };
      }
      await q.run("UPDATE checkouts SET status = 'paid' WHERE id = ?", checkout.id);
      if (payment) await q.run("UPDATE payments SET status = 'succeeded' WHERE id = ?", payment.id);
      for (const o of await q.all('SELECT * FROM orders WHERE checkout_id = ?', checkout.id)) {
        await transition(o.id, 'paid', { actor: 'payment', set: { paid_at: now() } });
        await q.run(`UPDATE listings SET status='sold', reserved_until=NULL WHERE id IN (SELECT listing_id FROM order_items WHERE order_id = ?)`, o.id);
        await notify(o.seller_id, `order:${o.id}:paid`, 'New order to ship', `Order #${o.id} is paid. Ship it to release your funds.`, `/dashboard/orders`);
        await notify(o.buyer_id, `order:${o.id}:paid-buyer`, 'Payment received', `Order #${o.id} is paid. Funds are held until you receive the item.`, `/orders/${o.id}`);
      }
      return { paid: true };
    }
    if (ev.type === 'payment_failed') {
      if (checkout.status !== 'pending') return { ignored: true };
      await q.run("UPDATE checkouts SET status = 'failed' WHERE id = ?", checkout.id);
      if (payment) await q.run("UPDATE payments SET status = 'failed' WHERE id = ?", payment.id);
      for (const o of await q.all('SELECT * FROM orders WHERE checkout_id = ?', checkout.id)) {
        await transition(o.id, 'cancelled', { actor: 'payment', note: 'payment failed' });
        await notify(o.buyer_id, `order:${o.id}:failed`, 'Payment failed', `Order #${o.id} was not completed. Your items were released.`, '/cart');
      }
      await releaseCheckoutItems(checkout.id);
      return { failed: true };
    }
    return { ignored: true };
  });
}

/** Expire stale checkouts (reservation timeout). Safe to run repeatedly. */
async function expireStaleCheckouts() {
  return await tx(async () => {
    const stale = await q.all("SELECT id FROM checkouts WHERE status = 'pending' AND expires_at < ?", now());
    for (const c of stale) {
      await q.run("UPDATE checkouts SET status = 'expired' WHERE id = ?", c.id);
      for (const o of await q.all('SELECT id, buyer_id, payment_mode FROM orders WHERE checkout_id = ?', c.id)) {
        await transition(o.id, 'cancelled', { actor: 'system', note: 'checkout expired' });
        if (o.payment_mode === 'external') await notify(o.buyer_id, `order:${o.id}:expired`, 'Reservation expired', `Order #${o.id} was released because the seller never confirmed a payment. If you did pay, message the seller right away.`, `/orders/${o.id}`);
      }
      await releaseCheckoutItems(c.id);
    }
    return stale.length;
  });
}

module.exports = { getProvider, getProviderByName, handlePaymentEvent, expireStaleCheckouts, sandbox, stripe, hmac };
