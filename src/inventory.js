'use strict';
// Listing quantity. `listings.quantity` is the number of units STILL AVAILABLE to reserve:
//   reserving a unit (a buyer starts seller checkout)  -> quantity - 1
//   the reservation is released (cancelled / rejected / expired) -> quantity + 1
//   a payment is confirmed -> the unit stays taken (the reservation simply becomes a sale)
// The listing's status follows from the numbers: units left -> 'active'; none left but unpaid reservations -> 'reserved'; none left and none pending -> 'sold'.
// All writers run inside the caller's BEGIN IMMEDIATE transaction, and the decrement is a conditional UPDATE, so two buyers can never take the same last unit.
const { q, now } = require('./db');

const pendingFor = async (listingId) => await q.all(`SELECT o.id, o.checkout_id, c.expires_at FROM orders o JOIN order_items i ON i.order_id = o.id JOIN checkouts c ON c.id = o.checkout_id
  WHERE i.listing_id = ? AND o.payment_mode = 'external' AND o.status = 'pending_payment' ORDER BY o.id DESC`, listingId);

/** Bring status (and the legacy reserved_* markers) in line with quantity and pending reservations. Only touches active/reserved/sold listings. */
async function sync(listingId) {
  const l = await q.get('SELECT id, status, quantity FROM listings WHERE id = ? FOR UPDATE', Number(listingId));      // lock: status is derived from quantity + pending reservations
  if (!l || !['active', 'reserved', 'sold'].includes(l.status)) return null;
  let status;
  if (l.quantity > 0) status = 'active';
  else status = (await pendingFor(l.id)).length ? 'reserved' : 'sold';
  const p = status === 'reserved' ? (await pendingFor(l.id))[0] : null;
  await q.run('UPDATE listings SET status = ?, reserved_until = ?, reserved_checkout_id = ?, updated_at = ? WHERE id = ?', status, p ? p.expires_at : null, p ? p.checkout_id : null, now(), l.id);
  return status;
}
/** Take one unit for a new reservation. False when none is available (someone else got it first). */
async function holdUnit(listingId) {
  const r = await q.run("UPDATE listings SET quantity = quantity - 1 WHERE id = ? AND status = 'active' AND quantity > 0", Number(listingId));
  if (r.changes !== 1) return false;
  await sync(listingId);
  return true;
}
/** Give one unit back (after a reservation ends without a sale, or an item is restocked). */
async function returnUnit(listingId, n = 1) {
  await q.run('UPDATE listings SET quantity = LEAST(999, quantity + ?) WHERE id = ?', n, Number(listingId));
  await sync(listingId);
}
/** Release every unit held by an external checkout (cancel, reject, expiry). Call once per ended reservation, inside a transaction. */
async function releaseCheckout(checkoutId) {
  for (const it of await q.all('SELECT DISTINCT i.listing_id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.checkout_id = ?', checkoutId)) await returnUnit(it.listing_id);
}
const pendingCount = async (listingId) => (await pendingFor(listingId)).length;

module.exports = { sync, holdUnit, returnUnit, releaseCheckout, pendingCount };
