'use strict';
// Direct ("external") checkout — the private-beta payment model.
//
//   PairPlug does NOT collect, hold, escrow, split or refund money in this mode. The buyer pays the seller through the
//   seller's own payment link. PairPlug records the purchase attempt and the seller's confirmation, nothing more.
//
// Order lifecycle (existing state machine, reused):
//   pending_payment  buyer started checkout; item reserved; NOT paid
//   paid             seller confirmed they received the payment in their own provider   <- only a seller action does this
//   shipped          seller recorded carrier + tracking
//   delivered        buyer (or seller) marked it received
//   cancelled        abandoned/expired/rejected before payment was confirmed; item released
//   refunded         seller declares they refunded the buyer in their own provider (PairPlug moves no money)
const config = require('./config');
const { q, tx, now, getSettings } = require('./db');
const { HttpError, cleanLine } = require('./util');
const { rateLimit } = require('./auth');
const { validateAddress } = require('./checkout');
const { transition } = require('./orderMachine');
const { notify } = require('./notify');
const { resolveLink, buyerUrl } = require('./paymentLinks');
const { randomUUID } = require('node:crypto');
const { expireStaleCheckouts } = require('./payments');

const isExternal = () => config.checkoutMode === 'external';
const MAX_PENDING_PER_BUYER = 3;

/** What the buyer will pay, computed only from the database. */
function terms(listing) {
  const shippingCents = listing.shipping_payer === 'buyer' ? listing.shipping_cents : 0;
  return { itemCents: listing.price_cents, shippingCents, shippingPayer: listing.shipping_payer, totalCents: listing.price_cents + shippingCents };
}

/** Can this listing be bought right now through a seller link? (used for the listing page and again at purchase time) */
function purchasable(listing) {
  if (!listing || listing.status !== 'active') return { ok: false, reason: 'This item is no longer available.' };
  const seller = q.get('SELECT * FROM users WHERE id = ?', listing.seller_id);
  if (!seller || seller.banned || !seller.is_seller) return { ok: false, reason: 'This seller is unavailable.' };
  if (!seller.email_verified_at) return { ok: false, reason: "This seller hasn't verified their email yet, so online checkout is paused. You can still message them." };
  if (!resolveLink(listing, seller)) return { ok: false, reason: "This seller hasn't finished setting up checkout for this item yet." };
  return { ok: true, seller };
}

function snapshotOf(listing, seller, link, t) {
  const images = q.all('SELECT file FROM listing_images WHERE listing_id = ? ORDER BY position, id', listing.id).map((r) => r.file);
  return JSON.stringify({
    v: 1, createdAt: now(), paymentModel: 'seller_external_checkout',
    listing: { id: listing.id, title: listing.title, description: listing.description, category: listing.category, brand: listing.brand, size: listing.size, condition: listing.condition, images },
    terms: { itemCents: t.itemCents, shippingPayer: t.shippingPayer, shippingCents: t.shippingCents, totalCents: t.totalCents, currency: 'USD' },
    seller: { id: seller.id, store: seller.store_name, handle: seller.handle, country: seller.country, region: seller.region, city: seller.city },
    paymentLink: { source: link.source, host: new URL(link.url).hostname, url: link.url },   // the exact link offered at checkout time
  });
}

/**
 * Buyer asks to purchase. Creates a PENDING order and reserves the listing — it does not and cannot create a paid order.
 * Idempotent: if this buyer already holds the reservation, the same order is returned (double-clicks, retries, refreshes).
 */
function startPurchase(user, { listingId, address, acknowledged }) {
  if (!isExternal()) throw new HttpError(404, 'Direct checkout is not enabled.');
  if (!acknowledged) throw new HttpError(422, 'Please confirm you understand how payment works.', { acknowledged: 'Required' });
  const addr = validateAddress(address);
  rateLimit(`buy:${user.id}`, 12, 3600);
  expireStaleCheckouts(); // free any expired holds first so a stale reservation can't block a real buyer
  const out = tx(() => {
    const l = q.get('SELECT * FROM listings WHERE id = ?', Number(listingId));
    if (!l) throw new HttpError(404, 'Listing not found');
    if (l.seller_id === user.id) throw new HttpError(403, "You can't buy your own listing.");
    // retry/double-click: this buyer already holds the reservation
    if (l.status === 'reserved' && l.reserved_checkout_id) {
      const mine = q.get(`SELECT o.id FROM orders o WHERE o.checkout_id = ? AND o.buyer_id = ? AND o.payment_mode = 'external' AND o.status = 'pending_payment'`, l.reserved_checkout_id, user.id);
      if (mine) return { orderId: mine.id, existing: true };
    }
    const p = purchasable(l);
    if (!p.ok) throw new HttpError(409, p.reason);
    const pending = q.get(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND payment_mode = 'external' AND status = 'pending_payment'`, user.id).n;
    if (pending >= MAX_PENDING_PER_BUYER) throw new HttpError(429, `You already have ${MAX_PENDING_PER_BUYER} items waiting for payment. Finish or cancel one first.`);

    const seller = p.seller, link = resolveLink(l, seller), t = terms(l), tNow = now();
    const expires = tNow + getSettings().external_hold_minutes * 60;
    const ck = q.run(`INSERT INTO checkouts(buyer_id, idempotency_key, total_cents, mode, ship_name, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, expires_at, created_at)
      VALUES(?,?,?, 'external', ?,?,?,?,?,?,?,?,?)`, user.id, `ext-${randomUUID()}`, t.totalCents, addr.ship_name, addr.ship_line1, addr.ship_line2, addr.ship_city, addr.ship_region, addr.ship_postal, addr.ship_country, expires, tNow);
    const checkoutId = Number(ck.lastInsertRowid);
    // Reservation = conditional UPDATE inside a BEGIN IMMEDIATE transaction: exactly one buyer can win a unique item.
    const res = q.run("UPDATE listings SET status='reserved', reserved_until=?, reserved_checkout_id=? WHERE id=? AND status='active'", expires, checkoutId, l.id);
    if (res.changes !== 1) throw new HttpError(409, 'This item was just taken by another buyer.');
    // PairPlug takes no fees and moves no money in this mode: fee/payout columns are zero by definition.
    const o = q.run(`INSERT INTO orders(checkout_id, buyer_id, seller_id, payment_mode, shipping_payer, subtotal_cents, shipping_cents, tax_cents, total_cents, fee_bps, platform_fee_cents, processing_fee_cents, seller_payout_cents, snapshot_json, created_at, updated_at)
      VALUES(?,?,?, 'external', ?, ?,?,0,?, 0,0,0,0, ?, ?,?)`, checkoutId, user.id, seller.id, t.shippingPayer, t.itemCents, t.shippingCents, t.totalCents, snapshotOf(l, seller, link, t), tNow, tNow);
    const orderId = Number(o.lastInsertRowid);
    q.run("INSERT INTO order_events(order_id, from_status, to_status, actor, note, created_at) VALUES(?, NULL, 'pending_payment', ?, 'Buyer started seller checkout (not paid)', ?)", orderId, `buyer:${user.id}`, tNow);
    q.run('INSERT INTO order_items(order_id, listing_id, title, price_cents, cost_cents, image) SELECT ?, id, title, price_cents, cost_cents, (SELECT file FROM listing_images WHERE listing_id = listings.id ORDER BY position LIMIT 1) FROM listings WHERE id = ?', orderId, l.id);
    notify(seller.id, `order:${orderId}:initiated`, 'Someone started checkout', `Order #${orderId}: "${l.title}" is reserved. Watch for the payment in your Stripe dashboard (reference PP-${orderId}), then confirm it in PairPlug.`, `/dashboard/orders/${orderId}`);
    return { orderId, existing: false };
  });
  // The response is only built after the transaction committed; read the row back so we never report an order that is not durably stored.
  if (!q.get('SELECT 1 x FROM orders WHERE id = ?', out.orderId)) throw new HttpError(500, 'The order could not be saved. Nothing was reserved; please try again.');
  return { ...out, reference: `PP-${out.orderId}` };
}

function buyerOrder(user, orderId) {
  const o = q.get(`SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND payment_mode = 'external'`, Number(orderId), user.id);
  if (!o) throw new HttpError(404, 'Order not found');
  return o;
}
function sellerOrder(user, orderId) {
  const o = q.get(`SELECT * FROM orders WHERE id = ? AND seller_id = ? AND payment_mode = 'external'`, Number(orderId), user.id);
  if (!o) throw new HttpError(404, 'Order not found');
  return o;
}
const releaseListing = (checkoutId) => q.run("UPDATE listings SET status='active', reserved_until=NULL, reserved_checkout_id=NULL WHERE reserved_checkout_id = ? AND status = 'reserved'", checkoutId);

/**
 * Where the buyer is sent to pay. Only for the buyer's own, still-pending direct order. The destination is the exact link
 * recorded in the order snapshot at checkout time (so later edits to the seller's settings can't redirect an open order),
 * and it is re-validated against the allowlist before every redirect.
 */
function payRedirect(user, orderId) {
  const o = buyerOrder(user, orderId);
  if (o.status !== 'pending_payment') throw new HttpError(409, 'This order is no longer waiting for payment.');
  const snap = JSON.parse(o.snapshot_json);
  let url;
  try { url = buyerUrl(snap.paymentLink.url, o.id); }
  catch { throw new HttpError(409, "This seller's checkout link is no longer accepted. Please contact the seller."); }
  q.run('UPDATE orders SET pay_clicked_at = COALESCE(pay_clicked_at, ?) WHERE id = ?', now(), o.id);
  return url;
}

/** Buyer says they paid. This is a *claim*: it notifies the seller and extends the hold so they can verify. It never marks paid. */
function buyerClaimPaid(user, orderId) {
  return tx(() => {
    const o = buyerOrder(user, orderId);
    if (o.status !== 'pending_payment') throw new HttpError(409, o.status === 'cancelled' ? 'This reservation expired or was cancelled. If you already paid, message the seller.' : 'Nothing to do: this order has already moved on.');
    if (!o.buyer_claimed_paid_at) {
      const until = now() + getSettings().external_claim_hold_hours * 3600;
      q.run('UPDATE orders SET buyer_claimed_paid_at = ?, updated_at = ? WHERE id = ?', now(), now(), o.id);
      q.run('UPDATE checkouts SET expires_at = ? WHERE id = ?', until, o.checkout_id);
      q.run("UPDATE listings SET reserved_until = ? WHERE reserved_checkout_id = ? AND status = 'reserved'", until, o.checkout_id);
      q.run("INSERT INTO order_events(order_id, from_status, to_status, actor, note, created_at) VALUES(?, 'pending_payment', 'pending_payment', ?, 'Buyer says they paid (unverified)', ?)", o.id, `buyer:${user.id}`, now());
      notify(o.seller_id, `order:${o.id}:claimed`, 'Buyer says they paid', `Order #${o.id}: check your payment dashboard for reference PP-${o.id}, then confirm the payment in PairPlug.`, `/dashboard/orders/${o.id}`);
    }
    return { ok: true };
  });
}

function buyerCancel(user, orderId) {
  return tx(() => {
    const o = buyerOrder(user, orderId);
    if (o.status !== 'pending_payment') throw new HttpError(409, 'Only orders still waiting for payment can be cancelled here.');
    if (o.buyer_claimed_paid_at) throw new HttpError(409, 'You said you already paid, so please message the seller to cancel or get a refund.');
    transition(o.id, 'cancelled', { actor: `buyer:${user.id}`, note: 'Buyer cancelled before paying' });
    q.run("UPDATE checkouts SET status = 'failed' WHERE id = ?", o.checkout_id); releaseListing(o.checkout_id);
    return { ok: true };
  });
}

/** SELLER confirms the money arrived in THEIR provider account. This is the only path to `paid` for direct orders. */
function sellerConfirmPayment(user, orderId, { reference } = {}) {
  return tx(() => {
    const o = sellerOrder(user, orderId);
    // Repeated request (double click / retry) by the seller who already confirmed: nothing changes, and it is reported honestly.
    if (['paid', 'shipped', 'delivered', 'released'].includes(o.status) && o.payment_confirmed_by === user.id) return { ok: true, alreadyConfirmed: true };
    if (o.status !== 'pending_payment') throw new HttpError(409, o.status === 'cancelled' ? 'This reservation expired or was cancelled, so the item may have been released. Refund the buyer in your payment dashboard if they paid.' : 'This order is already confirmed.');
    const held = q.get("SELECT id FROM listings WHERE reserved_checkout_id = ? AND status = 'reserved'", o.checkout_id);
    if (!held) throw new HttpError(409, 'The item is no longer reserved for this order.');
    transition(o.id, 'paid', { actor: `seller:${user.id}`, note: 'Seller confirmed payment received in their own payment account', set: { paid_at: now(), payment_confirmed_at: now(), payment_confirmed_by: user.id, payment_reference: cleanLine(reference, 80) || null } });
    q.run("UPDATE checkouts SET status = 'paid' WHERE id = ?", o.checkout_id);
    q.run("UPDATE listings SET status = 'sold', reserved_until = NULL WHERE id = ?", held.id);
    notify(o.buyer_id, `order:${o.id}:confirmed`, 'Payment confirmed by the seller', `Order #${o.id}: the seller confirmed your payment and will ship soon.`, `/orders/${o.id}`);
    return { ok: true };
  });
}

/** Seller did not receive payment: reject the pending order and release the item. */
function sellerRejectPayment(user, orderId) {
  return tx(() => {
    const o = sellerOrder(user, orderId);
    if (o.status === 'cancelled' && !o.payment_confirmed_at) return { ok: true, alreadyReleased: true };      // repeated request: already released; the item is never re-opened twice
    if (o.status !== 'pending_payment') throw new HttpError(409, 'Only orders waiting for payment can be rejected.');
    transition(o.id, 'cancelled', { actor: `seller:${user.id}`, note: 'Seller did not receive payment' });
    q.run("UPDATE checkouts SET status = 'failed' WHERE id = ?", o.checkout_id); releaseListing(o.checkout_id);
    notify(o.buyer_id, `order:${o.id}:rejected`, 'Order cancelled', `Order #${o.id} was cancelled because the seller did not receive a payment. Message the seller if you did pay.`, `/orders/${o.id}`);
    return { ok: true };
  });
}

/** Seller records that THEY refunded the buyer in their payment provider. PairPlug moves no money and verifies nothing. */
function sellerDeclareRefund(user, orderId, { relist }) {
  return tx(() => {
    const o = sellerOrder(user, orderId);
    if (!['paid', 'shipped', 'delivered'].includes(o.status)) throw new HttpError(409, 'Only confirmed orders can be marked refunded.');
    transition(o.id, 'refunded', { actor: `seller:${user.id}`, note: 'Seller states they refunded the buyer outside PairPlug', set: { refunded_cents: o.total_cents } });
    q.run('UPDATE listings SET status = ?, reserved_until = NULL, reserved_checkout_id = NULL WHERE id IN (SELECT listing_id FROM order_items WHERE order_id = ?)', relist ? 'active' : 'archived', o.id);
    notify(o.buyer_id, `order:${o.id}:refund-declared`, 'Seller marked your order refunded', `Order #${o.id}: the seller says a refund was issued through their payment provider.`, `/orders/${o.id}`);
    return { ok: true };
  });
}

/** shipped -> delivered, by the buyer ("I got it") or the seller. No funds are released: there is nothing held. */
function markReceived(user, orderId, who) {
  return tx(() => {
    const o = who === 'buyer' ? buyerOrder(user, orderId) : sellerOrder(user, orderId);
    if (o.status !== 'shipped') throw new HttpError(409, 'Only shipped orders can be marked received.');
    transition(o.id, 'delivered', { actor: `${who}:${user.id}`, note: who === 'buyer' ? 'Buyer confirmed receipt' : 'Seller marked delivered', set: { delivered_at: now() } });
    notify(who === 'buyer' ? o.seller_id : o.buyer_id, `order:${o.id}:delivered`, 'Order delivered', `Order #${o.id} was marked delivered.`, who === 'buyer' ? `/dashboard/orders/${o.id}` : `/orders/${o.id}`);
    return { ok: true };
  });
}

module.exports = { isExternal, terms, purchasable, startPurchase, payRedirect, buyerClaimPaid, buyerCancel, sellerConfirmPayment, sellerRejectPayment, sellerDeclareRefund, markReceived, buyerOrder, sellerOrder };
