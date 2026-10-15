'use strict';
// Direct ("external") checkout — the private-beta payment model.
//
//   Grailedside does NOT collect, hold, escrow, split or refund money in this mode. The buyer pays the seller through the
//   seller's own payment link. Grailedside records the purchase attempt and the seller's confirmation, nothing more.
//
// Order lifecycle (existing state machine, reused):
//   pending_payment  buyer started checkout; item reserved; NOT paid
//   paid             seller confirmed they received the payment in their own provider   <- only a seller action does this
//   shipped          seller recorded carrier + tracking
//   delivered        buyer (or seller) marked it received
//   cancelled        abandoned/expired/rejected before payment was confirmed; item released
//   refunded         seller declares they refunded the buyer in their own provider (Grailedside moves no money)
const config = require('./config');
const { q, tx, now, getSettings, isUnique } = require('./db');
const { HttpError, cleanLine } = require('./util');
const { rateLimit } = require('./auth');
const { validateAddress } = require('./checkout');
const { transition } = require('./orderMachine');
const { notify } = require('./notify');
const { resolveLink, buyerUrl, validatePaymentUrl } = require('./paymentLinks');
const { randomUUID } = require('node:crypto');
const { expireStaleCheckouts } = require('./payments');
const INV = require('./inventory');

const isExternal = () => config.checkoutMode === 'external';
const MAX_PENDING_PER_BUYER = 3;

/** What the buyer will pay, computed only from the database. */
function terms(listing) {
  const shippingCents = listing.shipping_payer === 'buyer' ? listing.shipping_cents : 0;
  return { itemCents: listing.price_cents, shippingCents, shippingPayer: listing.shipping_payer, totalCents: listing.price_cents + shippingCents };
}

/** Can this listing be bought right now through a seller link? (used for the listing page and again at purchase time) */
async function purchasable(listing) {
  if (!listing || listing.status !== 'active' || !(listing.quantity > 0)) return { ok: false, reason: 'This item is no longer available.' };
  const seller = await q.get('SELECT * FROM users WHERE id = ?', listing.seller_id);
  if (!seller || seller.banned || !seller.is_seller) return { ok: false, reason: 'This seller is unavailable.' };
  if (seller.selling_restricted_at) return { ok: false, reason: 'This seller is temporarily unavailable.' };
  const link = resolveLink(listing);
  // Beta rule: only the listing's OWN Stripe link, and only after the seller confirmed it charges exactly the current item + shipping total. The confirmation is the seller's statement;
  // Grailedside cannot read the amount at Stripe. Any change to price, shipping or link clears it (see saveListing and the listings_ack_follows_total trigger).
  if (!link) return { ok: false, reason: "This seller hasn't added a Stripe checkout link to this listing yet." };
  if (listing.payment_total_ack_cents !== terms(listing).totalCents) return { ok: false, reason: "This seller still needs to confirm that their Stripe link charges the current total (item price plus shipping), so online checkout is paused. You can message them." };
  try { validatePaymentUrl(link.url); } catch { return { ok: false, reason: "This seller's checkout link is no longer accepted, so online checkout is paused. You can message them." }; }
  return { ok: true, seller };
}

async function snapshotOf(listing, seller, link, t) {
  const images = (await q.all('SELECT file FROM listing_images WHERE listing_id = ? ORDER BY position, id', listing.id)).map((r) => r.file);
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
async function startPurchase(user, { listingId, address, acknowledged }) {
  if (!isExternal()) throw new HttpError(404, 'Direct checkout is not enabled.');
  if (!acknowledged) throw new HttpError(422, 'Please confirm you understand how payment works.', { acknowledged: 'Required' });
  const addr = validateAddress(address);
  await rateLimit(`buy:${user.id}`, 12, 3600);
  await expireStaleCheckouts(); // free any expired holds first so a stale reservation can't block a real buyer
  const out = await tx(async () => {
    // lock the listing: concurrent purchases of the same item queue here, so the "already holds a reservation" check, the unit hold and the order insert are one atomic step
    const l = await q.get('SELECT * FROM listings WHERE id = ? FOR UPDATE', Number(listingId));
    if (!l) throw new HttpError(404, 'Listing not found');
    if (l.seller_id === user.id) throw new HttpError(403, "You can't buy your own listing.");
    // retry/double-click: this buyer already holds a reservation on this listing
    const mine = await q.get(`SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.listing_id = ? AND o.buyer_id = ? AND o.payment_mode = 'external' AND o.status = 'pending_payment' ORDER BY o.id DESC LIMIT 1`, l.id, user.id);
    if (mine) return { orderId: mine.id, existing: true };
    const p = await purchasable(l);
    if (!p.ok) throw new HttpError(409, p.reason);
    const pending = (await q.get(`SELECT COUNT(*) n FROM orders WHERE buyer_id = ? AND payment_mode = 'external' AND status = 'pending_payment'`, user.id)).n;
    if (pending >= MAX_PENDING_PER_BUYER) throw new HttpError(429, `You already have ${MAX_PENDING_PER_BUYER} items waiting for payment. Finish or cancel one first.`);

    const seller = p.seller, link = resolveLink(l), t = terms(l), tNow = now();
    const expires = tNow + (await getSettings()).external_hold_minutes * 60;
    const ck = await q.insert(`INSERT INTO checkouts(buyer_id, idempotency_key, total_cents, mode, ship_name, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, expires_at, created_at)
      VALUES(?,?,?, 'external', ?,?,?,?,?,?,?,?,?)`, user.id, `ext-${randomUUID()}`, t.totalCents, addr.ship_name, addr.ship_line1, addr.ship_line2, addr.ship_city, addr.ship_region, addr.ship_postal, addr.ship_country, expires, tNow);
    const checkoutId = ck;
    // Reservation = conditional decrement of the listing's quantity inside a BEGIN IMMEDIATE transaction: exactly one buyer can win the last unit.
    if (!await INV.holdUnit(l.id)) throw new HttpError(409, 'This item was just taken by another buyer.');
    // Grailedside takes no fees and moves no money in this mode: fee/payout columns are zero by definition.
    const o = await q.insert(`INSERT INTO orders(checkout_id, buyer_id, seller_id, payment_mode, shipping_payer, subtotal_cents, shipping_cents, tax_cents, total_cents, fee_bps, platform_fee_cents, processing_fee_cents, seller_payout_cents, snapshot_json, created_at, updated_at)
      VALUES(?,?,?, 'external', ?, ?,?,0,?, 0,0,0,0, ?, ?,?)`, checkoutId, user.id, seller.id, t.shippingPayer, t.itemCents, t.shippingCents, t.totalCents, await snapshotOf(l, seller, link, t), tNow, tNow);
    const orderId = o;
    await q.run("INSERT INTO order_events(order_id, from_status, to_status, actor, note, created_at) VALUES(?, NULL, 'pending_payment', ?, 'Buyer started seller checkout (not paid)', ?)", orderId, `buyer:${user.id}`, tNow);
    await q.run('INSERT INTO order_items(order_id, listing_id, title, price_cents, cost_cents, image) SELECT ?, id, title, price_cents, cost_cents, (SELECT file FROM listing_images WHERE listing_id = listings.id ORDER BY position LIMIT 1) FROM listings WHERE id = ?', orderId, l.id);
    await INV.sync(l.id);                                                                  // now that the order exists, the legacy reserved_* markers can point at it
    await notify(seller.id, `order:${orderId}:initiated`, 'Someone started checkout', `Order #${orderId}: "${l.title}" is reserved. Watch for the payment in your Stripe dashboard (reference PP-${orderId}), then confirm it in Grailedside.`, `/dashboard/orders/${orderId}`);
    return { orderId, existing: false };
  });
  // The response is only built after the transaction committed; read the row back so we never report an order that is not durably stored.
  if (!await q.get('SELECT 1 x FROM orders WHERE id = ?', out.orderId)) throw new HttpError(500, 'The order could not be saved. Nothing was reserved; please try again.');
  return { ...out, reference: `PP-${out.orderId}` };
}

async function buyerOrder(user, orderId) {
  const o = await q.get(`SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND payment_mode = 'external' FOR UPDATE`, Number(orderId), user.id);   // row lock (inside a tx): racing requests on one order queue and re-read
  if (!o) throw new HttpError(404, 'Order not found');
  return o;
}
async function sellerOrder(user, orderId) {
  const o = await q.get(`SELECT * FROM orders WHERE id = ? AND seller_id = ? AND payment_mode = 'external' FOR UPDATE`, Number(orderId), user.id);
  if (!o) throw new HttpError(404, 'Order not found');
  return o;
}
const releaseListing = async (checkoutId) => await INV.releaseCheckout(checkoutId);          // give the held unit back

/**
 * Where the buyer is sent to pay. Only for the buyer's own, still-pending direct order. The destination is the exact link
 * recorded in the order snapshot at checkout time (so later edits to the seller's settings can't redirect an open order),
 * and it is re-validated against the allowlist before every redirect.
 */
async function payRedirect(user, orderId) {
  const o = await buyerOrder(user, orderId);
  if (o.status !== 'pending_payment') throw new HttpError(409, 'This order is no longer waiting for payment.');
  if (await require('./fraud').sellerHeld(o.seller_id)) throw new HttpError(409, 'Grailedside is reviewing a report about this seller, so we are not sending buyers to their payment link right now. Please do not pay yet; message support if you have questions.');
  const snap = JSON.parse(o.snapshot_json);
  let url;
  try { url = buyerUrl(snap.paymentLink.url, o.id); }
  catch { throw new HttpError(409, "This seller's checkout link is no longer accepted. Please contact the seller."); }
  await q.run('UPDATE orders SET pay_clicked_at = COALESCE(pay_clicked_at, ?) WHERE id = ?', now(), o.id);
  return url;
}

/** Buyer says they paid. This is a *claim*: it notifies the seller and extends the hold so they can verify. It never marks paid. */
async function buyerClaimPaid(user, orderId) {
  return await tx(async () => {
    const o = await buyerOrder(user, orderId);
    if (o.status !== 'pending_payment') throw new HttpError(409, o.status === 'cancelled' ? 'This reservation expired or was cancelled. If you already paid, message the seller.' : 'Nothing to do: this order has already moved on.');
    if (!o.buyer_claimed_paid_at) {
      const until = now() + (await getSettings()).external_claim_hold_hours * 3600;
      await q.run('UPDATE orders SET buyer_claimed_paid_at = ?, updated_at = ? WHERE id = ?', now(), now(), o.id);
      await q.run('UPDATE checkouts SET expires_at = ? WHERE id = ?', until, o.checkout_id);
      await INV.sync((await q.get('SELECT listing_id FROM order_items WHERE order_id = ?', o.id)).listing_id);
      await q.run("INSERT INTO order_events(order_id, from_status, to_status, actor, note, created_at) VALUES(?, 'pending_payment', 'pending_payment', ?, 'Buyer says they paid (unverified)', ?)", o.id, `buyer:${user.id}`, now());
      await notify(o.seller_id, `order:${o.id}:claimed`, 'Buyer says they paid', `Order #${o.id}: check your payment dashboard for reference PP-${o.id}, then confirm the payment in Grailedside.`, `/dashboard/orders/${o.id}`);
    }
    return { ok: true };
  });
}

async function buyerCancel(user, orderId) {
  return await tx(async () => {
    const o = await buyerOrder(user, orderId);
    if (o.status !== 'pending_payment') throw new HttpError(409, 'Only orders still waiting for payment can be cancelled here.');
    if (o.buyer_claimed_paid_at) throw new HttpError(409, 'You said you already paid, so please message the seller to cancel or get a refund.');
    await transition(o.id, 'cancelled', { actor: `buyer:${user.id}`, note: 'Buyer cancelled before paying' });
    await q.run("UPDATE checkouts SET status = 'failed' WHERE id = ?", o.checkout_id); await releaseListing(o.checkout_id);
    return { ok: true };
  });
}

/** SELLER confirms the money arrived in THEIR provider account. This is the only path to `paid` for direct orders. */
async function sellerConfirmPayment(user, orderId, { reference } = {}) {
  return await tx(async () => {
    const o = await sellerOrder(user, orderId);
    // Repeated request (double click / retry) by the seller who already confirmed: nothing changes, and it is reported honestly.
    if (['paid', 'shipped', 'delivered', 'released'].includes(o.status) && o.payment_confirmed_by === user.id) return { ok: true, alreadyConfirmed: true };
    if (o.status !== 'pending_payment') throw new HttpError(409, o.status === 'cancelled' ? 'This reservation expired or was cancelled, so the item may have been released. Refund the buyer in your payment dashboard if they paid.' : 'This order is already confirmed.');
    await transition(o.id, 'paid', { actor: `seller:${user.id}`, note: 'Seller confirmed payment received in their own payment account', set: { paid_at: now(), payment_confirmed_at: now(), payment_confirmed_by: user.id, payment_reference: cleanLine(reference, 80) || null } });
    await q.run("UPDATE checkouts SET status = 'paid' WHERE id = ?", o.checkout_id);
    await INV.sync((await q.get('SELECT listing_id FROM order_items WHERE order_id = ?', o.id)).listing_id);       // the reserved unit becomes a sale; the listing is 'sold' only when no unit is left
    await notify(o.buyer_id, `order:${o.id}:confirmed`, 'Payment confirmed by the seller', `Order #${o.id}: the seller confirmed your payment and will ship soon.`, `/orders/${o.id}`);
    return { ok: true };
  });
}

/** Seller did not receive payment: reject the pending order and release the item. */
async function sellerRejectPayment(user, orderId) {
  return await tx(async () => {
    const o = await sellerOrder(user, orderId);
    if (o.status === 'cancelled' && !o.payment_confirmed_at) return { ok: true, alreadyReleased: true };      // repeated request: already released; the item is never re-opened twice
    if (o.status !== 'pending_payment') throw new HttpError(409, 'Only orders waiting for payment can be rejected.');
    await transition(o.id, 'cancelled', { actor: `seller:${user.id}`, note: 'Seller did not receive payment' });
    await q.run("UPDATE checkouts SET status = 'failed' WHERE id = ?", o.checkout_id); await releaseListing(o.checkout_id);
    await notify(o.buyer_id, `order:${o.id}:rejected`, 'Order cancelled', `Order #${o.id} was cancelled because the seller did not receive a payment. Message the seller if you did pay.`, `/orders/${o.id}`);
    return { ok: true };
  });
}

/** Seller records that THEY refunded the buyer in their payment provider. Grailedside moves no money and verifies nothing. */
/** A refunded unit: back in stock when the seller relists it; otherwise the listing is archived only if nothing else is left to sell. */
async function afterRefund(orderId, relist) {
  for (const it of await q.all('SELECT listing_id FROM order_items WHERE order_id = ?', orderId)) {
    if (relist) await INV.returnUnit(it.listing_id);
    else if ((await q.get('SELECT quantity FROM listings WHERE id = ?', it.listing_id)).quantity === 0 && !await INV.pendingCount(it.listing_id)) await q.run("UPDATE listings SET status = 'archived', reserved_until = NULL, reserved_checkout_id = NULL WHERE id = ?", it.listing_id);
    else await INV.sync(it.listing_id);
  }
}
async function sellerDeclareRefund(user, orderId, { relist }) {
  return await tx(async () => {
    const o = await sellerOrder(user, orderId);
    if (!['paid', 'shipped', 'delivered'].includes(o.status)) throw new HttpError(409, 'Only confirmed orders can be marked refunded.');
    await transition(o.id, 'refunded', { actor: `seller:${user.id}`, note: 'Seller states they refunded the buyer outside Grailedside', set: { refunded_cents: o.total_cents } });
    await afterRefund(o.id, relist);
    await notify(o.buyer_id, `order:${o.id}:refund-declared`, 'Seller marked your order refunded', `Order #${o.id}: the seller says a refund was issued through their payment provider.`, `/orders/${o.id}`);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- recipient address (collected at checkout; older orders may lack it)
const ADDR_COLS = ['ship_name', 'ship_line1', 'ship_city', 'ship_region', 'ship_postal', 'ship_country'];
/** Is the order's delivery address usable for fulfilment? (Older orders may predate address collection; we never invent one.) */
const addressMissing = (ck) => !ck || ADDR_COLS.some((c) => !String(ck[c] || '').trim()) || !config.naCountries.includes(String(ck.ship_country || '').toUpperCase());

/** The BUYER supplies/repairs the delivery address on their own order. Only while the address is missing and the order is not shipped. */
async function buyerSetAddress(user, orderId, address) {
  const addr = validateAddress(address);
  return await tx(async () => {
    const o = await buyerOrder(user, orderId), ck = await q.get('SELECT * FROM checkouts WHERE id = ?', o.checkout_id);
    if (['shipped', 'delivered', 'released', 'cancelled', 'refunded'].includes(o.status)) throw new HttpError(409, 'This order can no longer be changed.');
    if (!addressMissing(ck)) throw new HttpError(409, 'This order already has a delivery address. Message the seller if it needs to change.');
    await q.run('UPDATE checkouts SET ship_name=?, ship_line1=?, ship_line2=?, ship_city=?, ship_region=?, ship_postal=?, ship_country=? WHERE id=?', addr.ship_name, addr.ship_line1, addr.ship_line2, addr.ship_city, addr.ship_region, addr.ship_postal, addr.ship_country, o.checkout_id);
    await notify(o.seller_id, `order:${o.id}:address-added`, 'Delivery address added', `Order #${o.id}: the buyer added a delivery address.`, `/dashboard/orders/${o.id}`);
    return { ok: true };
  });
}
/** The SELLER asks the buyer (in-app notification) to add the missing address. Throttled; never claims more than it did. */
async function sellerRequestAddress(user, orderId) {
  await rateLimit(`addr-req:${user.id}`, 30, 3600);
  const o = await sellerOrder(user, orderId), ck = await q.get('SELECT * FROM checkouts WHERE id = ?', o.checkout_id);
  if (!addressMissing(ck)) throw new HttpError(409, 'This order already has a delivery address.');
  if (['cancelled', 'refunded', 'shipped', 'delivered', 'released'].includes(o.status)) throw new HttpError(409, 'This order no longer needs an address.');
  await notify(o.buyer_id, `order:${o.id}:address-request:${Math.floor(now() / 21600)}`, 'Please add your delivery address', `Order #${o.id}: the seller needs your delivery address to ship your item.`, `/orders/${o.id}`);
  return { ok: true, message: 'The buyer was sent an in-app notification asking for their address. (No email is sent.)' };
}

// ---------------------------------------------------------------- shipping (seller-entered carrier + tracking; Grailedside buys no postage)
const TRACKING_RE = /^[A-Za-z0-9-]{6,40}$/;
function shipInput(body) {
  const carrier = config.carriers.includes(body.carrier) ? body.carrier : '', tracking = cleanLine(body.tracking, 60).replace(/\s/g, ''), note = cleanLine(body.note, 200) || null, f = {};
  if (!carrier) f.carrier = 'Choose a carrier.';
  if (!TRACKING_RE.test(tracking)) f.tracking = 'Enter a valid tracking number (letters/numbers, 6–40 characters).';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  return { carrier, tracking, note };
}
const uniqueMsg = (e) => { if (isUnique(e)) throw new HttpError(409, 'That tracking number is already used on another order.'); throw e; };

/** Mark a PAID order shipped. Idempotent for the same carrier+tracking; validates recipient, carrier and tracking; records history in order_events. */
async function sellerShip(user, orderId, body = {}) {
  const { carrier, tracking, note } = shipInput(body);
  const out = await tx(async () => {
    const o = await sellerOrder(user, orderId);
    if (['shipped', 'delivered', 'released'].includes(o.status)) {
      if (o.carrier === carrier && o.tracking_number === tracking) return { ok: true, alreadyShipped: true };
      throw new HttpError(409, 'This order is already marked shipped. Use “Correct tracking” to change the carrier or tracking number.');
    }
    if (o.status !== 'paid' || !o.payment_confirmed_at) throw new HttpError(409, 'Confirm that you received the buyer\'s payment before shipping.');
    const ck = await q.get('SELECT * FROM checkouts WHERE id = ?', o.checkout_id);
    if (addressMissing(ck)) throw new HttpError(409, 'The buyer\'s delivery address is missing or incomplete. Ask the buyer to add it before you ship.', { address: 'missing' });
    try { await transition(o.id, 'shipped', { actor: `seller:${user.id}`, note: `${carrier} ${tracking}`, set: { carrier, tracking_number: tracking, shipped_at: now(), ship_note: note } }); } catch (e) { uniqueMsg(e); }
    return { ok: true, order: o };
  });
  if (out.alreadyShipped) return out;
  // Buyer notification is in-app only (there is no email mechanism) and is reported honestly.
  let notified = false;
  try { await notify(out.order.buyer_id, `order:${out.order.id}:shipped`, 'Your order shipped', `Order #${out.order.id} shipped with ${carrier}. Tracking: ${tracking}${note ? '. Seller note: ' + note : ''}`, `/orders/${out.order.id}`); notified = true; } catch { /* the shipment is saved regardless */ }
  return { ok: true, notified };
}
/** Fix a typo'd carrier/tracking/note on an order that is shipped but not yet delivered. History keeps the old and new values. */
async function sellerCorrectTracking(user, orderId, body = {}) {
  const { carrier, tracking, note } = shipInput(body);
  return await tx(async () => {
    const o = await sellerOrder(user, orderId);
    if (o.status !== 'shipped') throw new HttpError(409, 'Tracking can only be corrected while the order is shipped and not yet delivered.');
    if (o.carrier === carrier && o.tracking_number === tracking && (o.ship_note || null) === note) return { ok: true, unchanged: true };
    try { await q.run('UPDATE orders SET carrier = ?, tracking_number = ?, ship_note = ?, updated_at = ? WHERE id = ?', carrier, tracking, note, now(), o.id); } catch (e) { uniqueMsg(e); }
    await q.run("INSERT INTO order_events(order_id, from_status, to_status, actor, note, created_at) VALUES(?, 'shipped', 'shipped', ?, ?, ?)", o.id, `seller:${user.id}`, `Tracking corrected: ${o.carrier} ${o.tracking_number} → ${carrier} ${tracking}`, now());
    try { await notify(o.buyer_id, `order:${o.id}:tracking:${tracking}`, 'Tracking updated', `Order #${o.id}: tracking is now ${carrier} ${tracking}.`, `/orders/${o.id}`); } catch { /* ignore */ }
    return { ok: true };
  });
}

/** shipped -> delivered. Only the BUYER ("I got it") or a verified carrier report can say so: a seller's own claim is not reliable evidence of delivery. */
async function markReceived(user, orderId, who) {
  return await tx(async () => {
    const o = who === 'buyer' ? await buyerOrder(user, orderId) : await sellerOrder(user, orderId);
    if (who !== 'buyer') throw new HttpError(403, 'Only the buyer (or a verified carrier delivery report) can mark an order delivered.');
    if (o.status !== 'shipped') throw new HttpError(409, 'Only shipped orders can be marked received.');
    await transition(o.id, 'delivered', { actor: `${who}:${user.id}`, note: who === 'buyer' ? 'Buyer confirmed receipt' : 'Seller marked delivered', set: { delivered_at: now() } });
    await notify(who === 'buyer' ? o.seller_id : o.buyer_id, `order:${o.id}:delivered`, 'Order delivered', `Order #${o.id} was marked delivered.`, who === 'buyer' ? `/dashboard/orders/${o.id}` : `/orders/${o.id}`);
    return { ok: true };
  });
}

module.exports = { afterRefund, buyerSetAddress, sellerRequestAddress, sellerShip, sellerCorrectTracking, addressMissing, isExternal, terms, purchasable, startPurchase, payRedirect, buyerClaimPaid, buyerCancel, sellerConfirmPayment, sellerRejectPayment, sellerDeclareRefund, markReceived, buyerOrder, sellerOrder };
