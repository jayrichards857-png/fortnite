'use strict';
// External sales: items a seller sold OUTSIDE PairPlug's checkout (in person, another marketplace, ...). This is the seller's own bookkeeping.
//   * It is NOT an order: no buyer account, no checkout, no payment status. PairPlug has not verified the sale or any payment, and says so.
//   * One record per listing (unique index); records are append-only (triggers).
//   * Genuine PairPlug purchases keep using orders; a listing that sold through an order can never also get an external-sale record.
const { q, tx, now } = require('./db');
const { HttpError, clean, cleanLine, dollarsToCents } = require('./util');
const { rateLimit } = require('./auth');
const { audit } = require('./audit');

const today = () => new Date().toISOString().slice(0, 10);
const day = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) ? d : null);

/** Does a genuine PairPlug order (anything except a cancelled one) exist for this listing? */
const hasOrder = (listingId) => Boolean(q.get("SELECT 1 x FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.listing_id = ? AND o.status <> 'cancelled'", listingId));
const existing = (listingId) => q.get('SELECT * FROM external_sales WHERE listing_id = ?', listingId);

function record(user, listingId, body = {}) {
  rateLimit(`ext-sale:${user.id}`, 60, 3600);
  const f = {};
  let soldOn = today();
  if (body.sold_on !== undefined && body.sold_on !== '') { soldOn = day(String(body.sold_on)); if (!soldOn) f.sold_on = 'Use a valid date (YYYY-MM-DD).'; else if (soldOn > today()) f.sold_on = 'The sale date can\'t be in the future.'; else if (soldOn < '2000-01-01') f.sold_on = 'That date is too far back.'; }
  let price = null;
  if (body.price !== undefined && String(body.price).trim() !== '') { price = dollarsToCents(body.price); if (!Number.isFinite(price) || price < 0 || price > 100000000) f.price = 'Enter the sale price as a positive amount, or leave it blank.'; }
  const channel = cleanLine(body.channel, 60) || null, reference = cleanLine(body.reference, 80) || null, note = clean(body.note, 500) || null;
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  return tx(() => {
    const l = q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', Number(listingId), user.id);
    if (!l) throw new HttpError(404, 'Listing not found');
    if (existing(l.id)) throw new HttpError(409, 'An external sale is already recorded for this item.');
    if (hasOrder(l.id)) throw new HttpError(409, 'This item has a PairPlug order, so its sale is tracked there. External sales are only for items sold outside PairPlug.');
    if (l.status === 'reserved') throw new HttpError(409, 'A buyer is checking out this item right now. Try again after their reservation ends.');
    if (!['active', 'sold'].includes(l.status)) throw new HttpError(409, 'Only items for sale (or already marked sold) can be recorded as sold.');
    const t = now();
    const r = q.run('INSERT INTO external_sales(listing_id, seller_id, sold_on, price_cents, channel, reference, note, recorded_at) VALUES(?,?,?,?,?,?,?,?)', l.id, user.id, soldOn, price, channel, reference, note, t);
    if (l.status === 'active') q.run("UPDATE listings SET status = 'sold', reserved_until = NULL, reserved_checkout_id = NULL, updated_at = ? WHERE id = ? AND status = 'active'", t, l.id);
    audit(user, 'external_sale_recorded', { type: 'listing', id: l.id, detail: { sale: Number(r.lastInsertRowid), price_cents: price, was: l.status } });
    return { id: Number(r.lastInsertRowid), status: 'sold' };
  });
}

/** The seller's external sales, newest first. */
const listFor = (user) => q.all('SELECT s.*, l.title FROM external_sales s JOIN listings l ON l.id = s.listing_id WHERE s.seller_id = ? ORDER BY s.sold_on DESC, s.id DESC LIMIT 200', user.id);
/** Sold listings with neither a PairPlug order nor an external-sale record (e.g. marked Sold by hand before this feature). Never converted automatically. */
const unrecordedSold = (user) => q.all(`SELECT l.id, l.title, l.price_cents, l.updated_at FROM listings l WHERE l.seller_id = ? AND l.status = 'sold'
  AND NOT EXISTS (SELECT 1 FROM external_sales s WHERE s.listing_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.listing_id = l.id AND o.status <> 'cancelled') ORDER BY l.updated_at DESC, l.id DESC`, user.id);
/** For the inventory page: which of these listing ids have a sales record (order or external)? */
const recordedIds = (ids) => (ids.length ? new Set(q.all(`SELECT listing_id id FROM external_sales WHERE listing_id IN (${ids.map(() => '?').join(',')}) UNION SELECT oi.listing_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'cancelled' AND oi.listing_id IN (${ids.map(() => '?').join(',')})`, ...ids, ...ids).map((r) => r.id)) : new Set());

module.exports = { record, listFor, unrecordedSold, recordedIds, hasOrder };
