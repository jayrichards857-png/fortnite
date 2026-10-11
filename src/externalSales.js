'use strict';
// Recorded sales: the seller's own record of a sale that did NOT go through a PairPlug checkout order (the table keeps its original name, `external_sales`).
// A sale can ORIGINATE from PairPlug even though the buyer paid through the seller's own Stripe/PayPal link, so "where did this sale originate?" is a field,
// not an assumption. Principles:
//   * It is NOT an order and PairPlug never verifies a payment: the seller may attest "payment confirmed by seller"; nothing says "verified".
//   * No buyer account, checkout or notification is invented. PairPlug does not message or email the buyer about a recorded sale.
//   * A listing with a genuine PairPlug order (anything but cancelled) can't get a sale record: the order is the record. One active record per listing.
//   * Corrections and voids are logged in sale_events (append-only); a void never reopens the listing by itself (it is paused for the seller to resume).
//   * Rows written before migration 9 keep origin = NULL ("earlier record") and are never relabelled.
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, clean, cleanLine, dollarsToCents } = require('./util');
const { rateLimit } = require('./auth');
const { audit } = require('./audit');

const ORIGINS = { pairplug: 'PairPlug', in_person: 'In person', other_marketplace: 'Another marketplace', social: 'Social media or direct message', other: 'Other' };
const POSTAL = { US: /^\d{5}(-\d{4})?$/, CA: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, MX: /^\d{5}$/ };
const TRACKING_RE = /^[A-Za-z0-9-]{6,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const today = () => new Date().toISOString().slice(0, 10);
const day = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) ? d : null);
const log = (saleId, userId, action, detail) => q.run('INSERT INTO sale_events(sale_id, actor_id, action, detail, created_at) VALUES(?,?,?,?,?)', saleId, userId, action, detail == null ? null : String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1000), now());

/** Does a genuine PairPlug order (anything except a cancelled one) exist for this listing? */
const hasOrder = (listingId) => Boolean(q.get("SELECT 1 x FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.listing_id = ? AND o.status <> 'cancelled'", listingId));
const active = (listingId) => q.get('SELECT * FROM external_sales WHERE listing_id = ? AND voided_at IS NULL', listingId);

// ------------------------------------------------------------------ validation helpers
function recipientFrom(b = {}, { required }) {
  const v = { name: cleanLine(b.name ?? b.recipient_name, 60), line1: cleanLine(b.line1 ?? b.recipient_line1, 100), line2: cleanLine(b.line2 ?? b.recipient_line2, 100) || null, city: cleanLine(b.city ?? b.recipient_city, 60), region: cleanLine(b.region ?? b.recipient_region, 40), postal: cleanLine(b.postal ?? b.recipient_postal, 12).toUpperCase(), country: String(b.country ?? b.recipient_country ?? '').toUpperCase() };
  const any = [v.name, v.line1, v.line2, v.city, v.region, v.postal].some(Boolean);
  if (!any && !required) return null;                         // not provided yet: allowed when saving as awaiting fulfilment
  const p = {};
  if (v.name.length < 2) p.name = 'Enter the recipient\'s full name.';
  if (v.line1.length < 3) p.line1 = 'Enter the street address.';
  if (!v.city) p.city = 'Enter the city.';
  if (!v.region) p.region = 'Enter the state / province / region.';
  if (!config.naCountries.includes(v.country)) p.country = 'Choose US, CA or MX.'; else if (!POSTAL[v.country].test(v.postal)) p.postal = `Enter a valid ${v.country} postal code.`;
  if (Object.keys(p).length) throw new HttpError(422, 'Please complete the recipient address.', p);
  return v;
}
const recipientCols = (r) => (r ? [r.name, r.line1, r.line2, r.city, r.region, r.postal, r.country] : [null, null, null, null, null, null, null]);
const hasAddress = (s) => Boolean(s.recipient_name && s.recipient_line1 && s.recipient_city && s.recipient_region && s.recipient_postal && s.recipient_country);
function shipInput(b = {}) {
  const carrier = config.carriers.includes(b.carrier) ? b.carrier : '', tracking = cleanLine(b.tracking, 60).replace(/\s/g, ''), f = {};
  if (!carrier) f.carrier = 'Choose a carrier.';
  if (!TRACKING_RE.test(tracking)) f.tracking = 'Enter a valid tracking number (letters/numbers, 6–40 characters).';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  return { carrier, tracking, note: cleanLine(b.note, 200) || null };
}
function details(b = {}) {
  const f = {}, out = {};
  out.sold_on = today();
  if (b.sold_on !== undefined && b.sold_on !== '') { const d = day(String(b.sold_on)); if (!d) f.sold_on = 'Use a valid date (YYYY-MM-DD).'; else if (d > today()) f.sold_on = 'The sale date can\'t be in the future.'; else if (d < '2000-01-01') f.sold_on = 'That date is too far back.'; else out.sold_on = d; }
  out.price = null;
  if (b.price !== undefined && String(b.price).trim() !== '') { const p = dollarsToCents(b.price); if (!Number.isFinite(p) || p < 0 || p > 100000000) f.price = 'Enter the sale price as a positive amount, or leave it blank if you genuinely don\'t know it.'; else out.price = p; }
  out.channel = cleanLine(b.channel, 60) || null; out.reference = cleanLine(b.reference, 80) || null; out.note = clean(b.note, 500) || null;
  out.email = cleanLine(b.buyer_email, 120).toLowerCase() || null; if (out.email && !EMAIL_RE.test(out.email)) f.buyer_email = 'Enter a valid email address, or leave it blank.';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  return out;
}

// ------------------------------------------------------------------ recording
function record(user, listingId, body = {}) {
  rateLimit(`ext-sale:${user.id}`, 60, 3600);
  const f = {};
  const origin = String(body.origin || ''); if (!ORIGINS[origin]) f.origin = 'Choose where this sale originated.';
  const fulfillment = String(body.fulfillment || ''); if (!['ship', 'pickup'].includes(fulfillment)) f.fulfillment = 'Choose shipping or local pickup.';
  const payment = body.payment_status === 'confirmed_by_seller' ? 'confirmed_by_seller' : 'unconfirmed';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  const d = details(body), rec = fulfillment === 'ship' ? recipientFrom(body, { required: false }) : null;
  return tx(() => {
    const l = q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', Number(listingId), user.id);
    if (!l) throw new HttpError(404, 'Listing not found');
    if (active(l.id)) throw new HttpError(409, 'A sale is already recorded for this item.');
    if (hasOrder(l.id)) throw new HttpError(409, 'This item already has a PairPlug order, which is its sale record. Confirm payment and ship from that order; recording it here would duplicate it.');
    if (l.status === 'reserved') throw new HttpError(409, 'A buyer is checking out this item right now. Try again after their reservation ends.');
    if (!['active', 'sold'].includes(l.status)) throw new HttpError(409, 'Only items for sale (or already marked sold) can be recorded as sold.');
    const t = now();
    const r = q.run(`INSERT INTO external_sales(listing_id, seller_id, sold_on, price_cents, channel, reference, note, recorded_at, updated_at, origin, payment_status, payment_confirmed_at, fulfillment, shipment_status,
      recipient_name, recipient_line1, recipient_line2, recipient_city, recipient_region, recipient_postal, recipient_country, buyer_email) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?)`,
    l.id, user.id, d.sold_on, d.price, d.channel, d.reference, d.note, t, t, origin, payment, payment === 'confirmed_by_seller' ? t : null, fulfillment, fulfillment === 'ship' ? 'not_shipped' : 'not_applicable', ...recipientCols(rec), d.email);
    const id = Number(r.lastInsertRowid);
    if (l.status === 'active') q.run("UPDATE listings SET status = 'sold', reserved_until = NULL, reserved_checkout_id = NULL, updated_at = ? WHERE id = ? AND status = 'active'", t, l.id);
    log(id, user.id, 'recorded', { origin, fulfillment, payment, was: l.status });
    audit(user, 'sale_recorded', { type: 'listing', id: l.id, detail: { sale: id, origin, price_cents: d.price, was: l.status } });
    return { id, status: 'sold' };
  });
}

// ------------------------------------------------------------------ reading
const mine = (user, id) => { const s = q.get('SELECT s.*, l.title FROM external_sales s JOIN listings l ON l.id = s.listing_id WHERE s.id = ? AND s.seller_id = ?', Number(id), user.id); if (!s) throw new HttpError(404, 'Sale not found'); return s; };
const listFor = (user) => q.all('SELECT s.*, l.title FROM external_sales s JOIN listings l ON l.id = s.listing_id WHERE s.seller_id = ? ORDER BY s.sold_on DESC, s.id DESC LIMIT 200', user.id);
const eventsFor = (user, id) => { mine(user, id); return q.all('SELECT e.*, u.display_name FROM sale_events e JOIN users u ON u.id = e.actor_id WHERE e.sale_id = ? ORDER BY e.id', Number(id)); };
/** Sold listings with neither a PairPlug order nor an active sale record (e.g. marked Sold by hand earlier, or after a void). Never converted automatically. */
const unrecordedSold = (user) => q.all(`SELECT l.id, l.title, l.price_cents, l.updated_at FROM listings l WHERE l.seller_id = ? AND l.status = 'sold'
  AND NOT EXISTS (SELECT 1 FROM external_sales s WHERE s.listing_id = l.id AND s.voided_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.listing_id = l.id AND o.status <> 'cancelled') ORDER BY l.updated_at DESC, l.id DESC`, user.id);
const recordedIds = (ids) => (ids.length ? new Set(q.all(`SELECT listing_id id FROM external_sales WHERE voided_at IS NULL AND listing_id IN (${ids.map(() => '?').join(',')}) UNION SELECT oi.listing_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'cancelled' AND oi.listing_id IN (${ids.map(() => '?').join(',')})`, ...ids, ...ids).map((r) => r.id)) : new Set());

// ------------------------------------------------------------------ corrections (all logged; nothing is silently overwritten)
/** Fix the sale date / price / platform / reference / note / buyer email. The log keeps old -> new values. */
function correct(user, id, body = {}) {
  rateLimit(`sale-edit:${user.id}`, 60, 3600);
  const d = details(body);
  return tx(() => {
    const s = mine(user, id); if (s.voided_at) throw new HttpError(409, 'This record was voided and can no longer be changed.');
    const next = { sold_on: body.sold_on ? d.sold_on : s.sold_on, price_cents: body.price !== undefined ? d.price : s.price_cents, channel: body.channel !== undefined ? d.channel : s.channel, reference: body.reference !== undefined ? d.reference : s.reference, note: body.note !== undefined ? d.note : s.note, buyer_email: body.buyer_email !== undefined ? d.email : s.buyer_email };
    const changes = {}; for (const [k, v] of Object.entries(next)) if ((s[k] ?? null) !== (v ?? null)) changes[k] = k === 'buyer_email' ? 'changed' : [s[k] ?? null, v ?? null];
    if (!Object.keys(changes).length) return { ok: true, unchanged: true };
    q.run('UPDATE external_sales SET sold_on = ?, price_cents = ?, channel = ?, reference = ?, note = ?, buyer_email = ?, updated_at = ? WHERE id = ?', next.sold_on, next.price_cents, next.channel, next.reference, next.note, next.buyer_email, now(), s.id);
    log(s.id, user.id, 'corrected', changes); audit(user, 'sale_corrected', { type: 'sale', id: s.id, detail: { fields: Object.keys(changes) } });
    return { ok: true };
  });
}
/** The seller says they received the payment. This is an attestation and is labelled as such; PairPlug does not verify it. Idempotent. */
function confirmPayment(user, id) {
  return tx(() => {
    const s = mine(user, id); if (s.voided_at) throw new HttpError(409, 'This record was voided.');
    if (s.payment_status === 'confirmed_by_seller') return { ok: true, alreadyConfirmed: true };
    q.run("UPDATE external_sales SET payment_status = 'confirmed_by_seller', payment_confirmed_at = ?, updated_at = ? WHERE id = ?", now(), now(), s.id);
    log(s.id, user.id, 'payment_confirmed_by_seller', 'Seller attests they received the payment (not verified by PairPlug)'); audit(user, 'sale_payment_attested', { type: 'sale', id: s.id });
    return { ok: true };
  });
}
/** Change how the sale is fulfilled and/or save/update the recipient while it is not shipped (so the seller can come back later). */
function saveFulfillment(user, id, body = {}) {
  const fulfillment = String(body.fulfillment || ''); if (!['ship', 'pickup'].includes(fulfillment)) throw new HttpError(422, 'Please fix the highlighted fields.', { fulfillment: 'Choose shipping or local pickup.' });
  const rec = fulfillment === 'ship' ? recipientFrom(body, { required: false }) : null;
  return tx(() => {
    const s = mine(user, id); if (s.voided_at) throw new HttpError(409, 'This record was voided.');
    if (s.shipment_status === 'shipped') throw new HttpError(409, 'This sale is already shipped. Use “Correct tracking”; the recipient can\'t be changed after shipping.');
    q.run('UPDATE external_sales SET fulfillment = ?, shipment_status = ?, recipient_name = ?, recipient_line1 = ?, recipient_line2 = ?, recipient_city = ?, recipient_region = ?, recipient_postal = ?, recipient_country = ?, updated_at = ? WHERE id = ?',
      fulfillment, fulfillment === 'ship' ? 'not_shipped' : 'not_applicable', ...recipientCols(rec), now(), s.id);
    log(s.id, user.id, 'fulfillment_saved', { fulfillment, address: rec ? 'saved' : 'none' });            // the address itself is not copied into the log
    return { ok: true };
  });
}
/** Mark shipped: only for a shipping sale with a complete recipient, a valid carrier and tracking number. Idempotent for the same carrier + tracking. */
function ship(user, id, body = {}) {
  const { carrier, tracking, note } = shipInput(body);
  return tx(() => {
    const s = mine(user, id); if (s.voided_at) throw new HttpError(409, 'This record was voided.');
    if (s.fulfillment !== 'ship') throw new HttpError(409, 'This sale is not set up for shipping (local pickup / no shipping required, or fulfilment not chosen).');
    if (s.shipment_status === 'shipped') { if (s.carrier === carrier && s.tracking_number === tracking) return { ok: true, alreadyShipped: true }; throw new HttpError(409, 'Already shipped. Use “Correct tracking” to change the carrier or tracking number.'); }
    if (!hasAddress(s)) throw new HttpError(409, 'Add the recipient\'s complete delivery address before marking this shipped.', { address: 'missing' });
    try { q.run("UPDATE external_sales SET carrier = ?, tracking_number = ?, ship_note = ?, shipment_status = 'shipped', shipped_at = ?, updated_at = ? WHERE id = ?", carrier, tracking, note, now(), now(), s.id); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That tracking number is already used on another sale.'); throw e; }
    log(s.id, user.id, 'shipped', { carrier, tracking }); audit(user, 'sale_shipped', { type: 'sale', id: s.id });
    return { ok: true, buyerNotified: false };            // recorded sales have no PairPlug buyer account: nobody is notified
  });
}
function correctTracking(user, id, body = {}) {
  const { carrier, tracking, note } = shipInput(body);
  return tx(() => {
    const s = mine(user, id); if (s.voided_at) throw new HttpError(409, 'This record was voided.');
    if (s.shipment_status !== 'shipped') throw new HttpError(409, 'Tracking can only be corrected after the sale is marked shipped.');
    if (s.carrier === carrier && s.tracking_number === tracking && (s.ship_note || null) === note) return { ok: true, unchanged: true };
    try { q.run('UPDATE external_sales SET carrier = ?, tracking_number = ?, ship_note = ?, updated_at = ? WHERE id = ?', carrier, tracking, note, now(), s.id); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That tracking number is already used on another sale.'); throw e; }
    log(s.id, user.id, 'tracking_corrected', { from: `${s.carrier} ${s.tracking_number}`, to: `${carrier} ${tracking}` }); audit(user, 'sale_tracking_corrected', { type: 'sale', id: s.id });
    return { ok: true };
  });
}
/** Void an accidental record, with a reason. The record stays (history); the listing is PAUSED, never reopened automatically, and only if it is still just sold-by-this-record. */
function voidSale(user, id, body = {}) {
  const reason = clean(body.reason, 300); if (reason.length < 5) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'Say why you are voiding this record (at least 5 characters).' });
  return tx(() => {
    const s = mine(user, id); if (s.voided_at) return { ok: true, alreadyVoided: true };
    if (s.shipment_status === 'shipped') throw new HttpError(409, 'A shipped sale can\'t be voided. Correct the details instead.');
    const t = now();
    q.run('UPDATE external_sales SET voided_at = ?, void_reason = ?, voided_by = ?, updated_at = ? WHERE id = ?', t, reason, user.id, t, s.id);
    const l = q.get('SELECT status FROM listings WHERE id = ?', s.listing_id);
    let listing = l.status;
    if (l.status === 'sold' && !hasOrder(s.listing_id) && !active(s.listing_id)) { q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'sold'", t, s.listing_id); listing = 'archived'; }
    log(s.id, user.id, 'voided', { reason, listing }); audit(user, 'sale_voided', { type: 'sale', id: s.id, detail: { reason } });
    return { ok: true, listing };
  });
}

module.exports = { ORIGINS, record, listFor, mine, eventsFor, unrecordedSold, recordedIds, hasOrder, correct, confirmPayment, saveFulfillment, ship, correctTracking, voidSale, hasAddress };
