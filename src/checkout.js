'use strict';
const config = require('./config');
const { q, tx, now, getSettings } = require('./db');
const { PricingEngine } = require('./pricing');
const { HttpError, cleanLine } = require('./util');
const { getProvider, expireStaleCheckouts } = require('./payments');
const { transition } = require('./orderMachine');

const engine = () => new PricingEngine(getSettings(), config.taxRateBps);

function cartLines(userId) {
  return q.all(`SELECT l.id, l.title, l.price_cents, l.shipping_cents, l.status, l.seller_id, l.size, l.condition,
      (SELECT file FROM listing_images WHERE listing_id = l.id ORDER BY position LIMIT 1) image,
      u.handle seller_handle, u.store_name seller_name, u.plan seller_plan, u.banned seller_banned
    FROM cart_items c JOIN listings l ON l.id = c.listing_id JOIN users u ON u.id = l.seller_id
    WHERE c.user_id = ? ORDER BY c.created_at`, userId)
    .map((l) => ({ ...l, available: l.status === 'active' && !l.seller_banned }));
}

/** Server-side quote: group available lines by seller (one order per seller). Prices come only from the DB. */
function quote(userId) {
  const lines = cartLines(userId), e = engine();
  const bySeller = new Map();
  for (const l of lines.filter((x) => x.available)) {
    if (!bySeller.has(l.seller_id)) bySeller.set(l.seller_id, { sellerId: l.seller_id, sellerName: l.seller_name, plan: l.seller_plan, items: [] });
    bySeller.get(l.seller_id).items.push(l);
  }
  const groups = [...bySeller.values()].map((g) => {
    const subtotalCents = g.items.reduce((s, i) => s + i.price_cents, 0);
    // One parcel per seller: shipping is the highest per-item shipping price among the items (documented policy).
    const shippingCents = Math.max(...g.items.map((i) => i.shipping_cents));
    return { ...g, subtotalCents, shippingCents, ...e.priceOrder({ subtotalCents, shippingCents, sellerPlan: g.plan }) };
  });
  const sum = (k) => groups.reduce((s, g) => s + g[k], 0);
  return { lines, groups, subtotalCents: sum('subtotalCents'), shippingCents: sum('shippingCents'), taxCents: sum('taxCents'), totalCents: sum('totalCents'), taxRateBps: config.taxRateBps };
}

function addToCart(userId, listingId) {
  const l = q.get('SELECT id, seller_id, status FROM listings WHERE id = ?', listingId);
  if (!l || l.status !== 'active') throw new HttpError(409, 'This item is no longer available.');
  if (l.seller_id === userId) throw new HttpError(403, "You can't buy your own listing.");
  q.run('INSERT OR IGNORE INTO cart_items(user_id, listing_id, created_at) VALUES(?,?,?)', userId, listingId, now());
}

const ADDR = { name: 'ship_name', line1: 'ship_line1', line2: 'ship_line2', city: 'ship_city', region: 'ship_region', postal: 'ship_postal', country: 'ship_country' };
function validateAddress(a = {}) {
  const errors = {}, out = {};
  for (const [k, col] of Object.entries(ADDR)) out[col] = cleanLine(a[k], 100);
  for (const k of ['name', 'line1', 'city', 'region', 'postal']) if (!out[ADDR[k]]) errors[k] = 'Required';
  out.ship_country = String(a.country || '').toUpperCase();
  if (!config.naCountries.includes(out.ship_country)) errors.country = 'We currently ship within the US, Canada and Mexico.';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please complete your shipping address.', errors);
  return out;
}

/**
 * Create a checkout: reserve every item atomically, then create orders priced on the server.
 * Race safety: tx() uses BEGIN IMMEDIATE (one writer at a time) AND the reservation is a conditional
 *   UPDATE ... WHERE status='active'  whose row count we check, so a second buyer for the same unique item fails with 409.
 * Idempotency: (buyer_id, idempotency_key) is UNIQUE; replaying the same key returns the original checkout.
 */
async function createCheckout(user, { address, idempotencyKey }) {
  const provider = getProvider();
  if (!provider) throw new HttpError(503, 'Payments are not configured on this marketplace yet.');
  if (!/^[\w-]{8,80}$/.test(idempotencyKey || '')) throw new HttpError(400, 'Missing idempotency key');
  expireStaleCheckouts();
  const addr = validateAddress(address);
  const s = getSettings();

  const checkout = tx(() => {
    const prev = q.get('SELECT * FROM checkouts WHERE buyer_id = ? AND idempotency_key = ?', user.id, idempotencyKey);
    if (prev) return { ...prev, replay: true };
    const qt = quote(user.id);
    const unavailable = qt.lines.filter((l) => !l.available);
    if (unavailable.length) throw new HttpError(409, `${unavailable[0].title} is no longer available. Remove it from your cart to continue.`);
    if (!qt.groups.length) throw new HttpError(422, 'Your cart is empty.');
    const t = now(), expires = t + s.reservation_minutes * 60;
    const ck = q.run(`INSERT INTO checkouts(buyer_id, idempotency_key, total_cents, ship_name, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, expires_at, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, idempotencyKey, qt.totalCents, addr.ship_name, addr.ship_line1, addr.ship_line2, addr.ship_city, addr.ship_region, addr.ship_postal, addr.ship_country, expires, t);
    const checkoutId = Number(ck.lastInsertRowid);
    for (const g of qt.groups) {
      const o = q.run(`INSERT INTO orders(checkout_id,buyer_id,seller_id,subtotal_cents,shipping_cents,tax_cents,total_cents,fee_bps,platform_fee_cents,processing_fee_cents,seller_payout_cents,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, checkoutId, user.id, g.sellerId, g.subtotalCents, g.shippingCents, g.taxCents, g.totalCents, g.feeBps, g.platformFeeCents, g.processingFeeCents, g.sellerPayoutCents, t, t);
      const orderId = Number(o.lastInsertRowid);
      q.run("INSERT INTO order_events(order_id, from_status, to_status, actor, created_at) VALUES(?, NULL, 'pending_payment', ?, ?)", orderId, `buyer:${user.id}`, t);
      for (const it of g.items) {
        const r = q.run("UPDATE listings SET status='reserved', reserved_until=?, reserved_checkout_id=? WHERE id=? AND status='active'", expires, checkoutId, it.id);
        if (r.changes !== 1) throw new HttpError(409, `${it.title} was just taken by another buyer.`);
        // Snapshot title/price/cost: later listing edits must never rewrite order history or profit reports.
        q.run('INSERT INTO order_items(order_id, listing_id, title, price_cents, cost_cents, image) SELECT ?, id, title, price_cents, cost_cents, ? FROM listings WHERE id = ?', orderId, it.image, it.id);
      }
    }
    q.run('DELETE FROM cart_items WHERE user_id = ?', user.id);
    return q.get('SELECT * FROM checkouts WHERE id = ?', checkoutId);
  });
  if (checkout.replay) return { checkoutId: checkout.id, redirectUrl: `/checkout/${checkout.id}` };

  try {
    const pay = await provider.createPayment(checkout);
    q.run("INSERT INTO payments(checkout_id, provider, provider_ref, amount_cents, created_at) VALUES(?,?,?,?,?)", checkout.id, provider.name, pay.providerRef, checkout.total_cents, now());
    return { checkoutId: checkout.id, redirectUrl: pay.redirectUrl || `/checkout/${checkout.id}` };
  } catch (e) {
    // Couldn't start the payment: give the items back immediately.
    tx(() => {
      q.run("UPDATE checkouts SET status='failed' WHERE id=?", checkout.id);
      for (const o of q.all('SELECT id FROM orders WHERE checkout_id=?', checkout.id)) transition(o.id, 'cancelled', { actor: 'system', note: 'payment could not start' });
      q.run("UPDATE listings SET status='active', reserved_until=NULL, reserved_checkout_id=NULL WHERE reserved_checkout_id=? AND status='reserved'", checkout.id);
    });
    throw new HttpError(502, 'Could not start payment. Please try again.');
  }
}

module.exports = { cartLines, quote, addToCart, createCheckout, validateAddress };
