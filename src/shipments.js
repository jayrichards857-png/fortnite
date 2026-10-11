'use strict';
// Shipping labels for direct orders: sender/parcel/recipient validation, rate quotes, a confirmed purchase, and safe handling of
// pending / failed / duplicate purchases. TEST MODE ONLY in this release (see src/shippo.js and docs/SHIPPING.md): no real postage is bought and
// PairPlug never pays for postage. Every function takes the acting user and scopes by seller_id, so another seller's order/address/label is a 404.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, cleanLine } = require('./util');
const { rateLimit } = require('./auth');
const { audit } = require('./audit');
const SH = require('./shippo');

const RATES_TTL = 24 * 3600;                 // quotes older than this must be refreshed (Shippo itself allows 7 days)
const STUCK_AFTER = 120;                      // seconds before a purchase with unknown outcome may be released by the seller
const POSTAL = { US: /^\d{5}(-\d{4})?$/, CA: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, MX: /^\d{5}$/ };
const fail = (fields, msg = 'Please fix the highlighted fields.') => { throw new HttpError(422, msg, fields); };

/** Validate and normalise an address; returns { value, problems }. Never invents data. */
function address(a = {}, { needPhone = false } = {}) {
  const v = { name: cleanLine(a.name, 60), line1: cleanLine(a.line1, 100), line2: cleanLine(a.line2, 100) || null, city: cleanLine(a.city, 60), region: cleanLine(a.region, 40), postal: cleanLine(a.postal, 12).toUpperCase(), country: String(a.country || '').toUpperCase(), phone: cleanLine(a.phone, 20) || null };
  const p = {};
  if (v.name.length < 2) p.name = 'Enter a name.';
  if (v.line1.length < 3) p.line1 = 'Enter a street address.';
  if (!v.city) p.city = 'Enter a city.';
  if (!config.naCountries.includes(v.country)) p.country = 'Choose US, CA or MX.';
  else if (!POSTAL[v.country].test(v.postal)) p.postal = `Enter a valid ${v.country} postal code.`;
  if (v.country === 'US' && !/^[A-Za-z]{2}$/.test(v.region)) p.region = 'Use the 2-letter state code (e.g. NY).';
  else if (v.country !== 'US' && v.region.length < 2) p.region = 'Enter the state/province.';
  if (v.country === 'US') v.region = v.region.toUpperCase();
  if (v.phone && !/^[0-9+() .-]{7,20}$/.test(v.phone)) p.phone = 'Enter a valid phone number.';
  if (needPhone && !v.phone) p.phone = 'A phone number is required for this destination.';
  return { value: v, problems: p };
}
function parcel(b = {}) {
  const num = (x) => (x === '' || x == null ? NaN : Number(x));
  const v = { weight_oz: num(b.weight_oz), length_in: num(b.length_in), width_in: num(b.width_in), height_in: num(b.height_in) }, p = {};
  if (!(v.weight_oz >= 1 && v.weight_oz <= 2400)) p.weight_oz = 'Weight must be 1–2400 oz.';
  for (const k of ['length_in', 'width_in', 'height_in']) if (!(v[k] >= 0.5 && v[k] <= 108)) p[k] = 'Enter 0.5–108 inches.';
  return { value: v, problems: p };
}
const hashOf = (from, to, pc) => crypto.createHash('sha256').update(JSON.stringify([from, to, pc])).digest('hex');

// ---------------------------------------------------------------- loading (every query is scoped to the acting seller)
function orderFor(user, id) {
  const o = q.get("SELECT * FROM orders WHERE id = ? AND seller_id = ? AND payment_mode = 'external'", Number(id), user.id);
  if (!o) throw new HttpError(404, 'Order not found');
  return o;
}
const eligibility = (o) => (o.status === 'paid' && o.payment_confirmed_at ? { ok: true } : { ok: false, reason: o.status === 'pending_payment' ? 'Confirm the buyer\'s payment first.' : o.status === 'shipped' || o.status === 'delivered' ? 'This order has already shipped.' : 'Labels are only available for paid, unshipped orders.' });
const shipFromRow = (uid) => q.get('SELECT * FROM seller_ship_from WHERE user_id = ?', uid);
function toRow(o) {
  const c = q.get('SELECT ship_name name, ship_line1 line1, ship_line2 line2, ship_city city, ship_region region, ship_postal postal, ship_country country FROM checkouts WHERE id = ?', o.checkout_id);
  return c ? { ...c, phone: null } : null;
}
const latest = (orderId, test) => q.get('SELECT * FROM shipments WHERE order_id = ? AND test = ? ORDER BY id DESC LIMIT 1', orderId, test);
const isTest = () => (SH.mode() === 'test' ? 1 : 0);
function parcelDefaults(o) {
  const r = q.get('SELECT l.weight_oz, l.length_in, l.width_in, l.height_in FROM order_items oi JOIN listings l ON l.id = oi.listing_id WHERE oi.order_id = ? LIMIT 1', o.id);
  return r ? { weight_oz: r.weight_oz, length_in: r.length_in, width_in: r.width_in, height_in: r.height_in } : {};
}
/** What the browser may see. No label URL, no provider ids, no credentials. */
function present(s) {
  if (!s) return null;
  const rates = s.rates_json ? JSON.parse(s.rates_json) : [];
  return { id: s.id, status: s.status, test: Boolean(s.test), rates: s.status === 'rates_ready' ? rates : [], fetchedAt: s.rates_fetched_at, expired: s.status === 'rates_ready' && now() - s.rates_fetched_at > RATES_TTL,
    parcel: { weight_oz: s.weight_oz, length_in: s.length_in, width_in: s.width_in, height_in: s.height_in },
    carrier: s.carrier, service: s.service, priceCents: s.price_cents, currency: s.currency, trackingNumber: s.tracking_number, trackingUrl: s.tracking_url, trackingStatus: s.tracking_status,
    hasLabel: s.status === 'success' && Boolean(s.label_url), error: s.error_message, purchasedAt: s.purchased_at, stuck: s.status === 'purchasing' && now() - s.updated_at > STUCK_AFTER };
}

function state(user, orderId) {
  const o = orderFor(user, orderId), el = eligibility(o), t = isTest();
  const from = shipFromRow(user.id), s = latest(o.id, t) || (SH.enabled() ? null : q.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', o.id));
  const to = el.ok ? toRow(o) : null;
  return { enabled: SH.enabled(), mode: SH.mode(), disabledReason: SH.enabled() ? null : SH.disabledReason(), eligible: el.ok, reason: el.reason || null,
    billing: SH.enabled() ? 'Test mode: no postage is charged and test labels are not valid for shipping.' : null,
    shipFrom: from ? { name: from.name, line1: from.line1, line2: from.line2, city: from.city, region: from.region, postal: from.postal, country: from.country, phone: from.phone } : null,
    shipFromPrefill: { country: user.country, region: user.region, city: user.city },
    shipTo: to ? { name: to.name, line1: to.line1, line2: to.line2, city: to.city, region: to.region, postal: to.postal, country: to.country } : null,
    parcelDefaults: parcelDefaults(o), shipment: present(s) };
}

function saveShipFrom(user, body) {
  const { value, problems } = address(body);
  if (Object.keys(problems).length) fail(problems);
  q.run(`INSERT INTO seller_ship_from(user_id, name, line1, line2, city, region, postal, country, phone, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, line1=excluded.line1, line2=excluded.line2, city=excluded.city, region=excluded.region, postal=excluded.postal, country=excluded.country, phone=excluded.phone, updated_at=excluded.updated_at`,
  user.id, value.name, value.line1, value.line2, value.city, value.region, value.postal, value.country, value.phone, now());
  audit(user, 'ship_from_saved', { type: 'user', id: user.id });
  return { ok: true };
}

// ---------------------------------------------------------------- quote
async function quote(user, orderId, body = {}) {
  rateLimit(`ship-quote:${user.id}`, 20, 3600);
  if (!SH.enabled()) throw new HttpError(503, SH.disabledReason());
  const o = orderFor(user, orderId), el = eligibility(o);
  if (!el.ok) throw new HttpError(409, el.reason);
  const t = isTest(), cur = latest(o.id, t);
  if (cur && ['success', 'purchasing'].includes(cur.status)) throw new HttpError(409, cur.status === 'success' ? 'A label was already purchased for this order.' : 'A label purchase is already in progress for this order.');
  const fromRow = shipFromRow(user.id);
  if (!fromRow) throw new HttpError(409, 'Add your ship-from address first.', { missing: 'ship_from' });
  const from = address(fromRow, {}), toRaw = toRow(o), to = toRaw ? address(toRaw, { needPhone: false }) : null;
  if (Object.keys(from.problems).length) throw new HttpError(409, 'Your ship-from address needs fixing.', from.problems);
  if (!to || Object.keys(to.problems).length) throw new HttpError(409, 'The buyer\'s delivery address is incomplete or invalid, so a label can\'t be created. Message the buyer.', to ? to.problems : { address: 'missing' });
  const pc = parcel({ ...parcelDefaults(o), ...body });
  if (Object.keys(pc.problems).length) fail(pc.problems, 'Enter the package weight and dimensions.');
  let out;
  try { out = await SH.createShipment({ from: from.value, to: to.value, parcel: pc.value, ref: `PP-${o.id}` }); }
  catch (e) { throw shippoToHttp(e); }
  if (!out.rates.length) throw new HttpError(422, `No carrier services are available for this package and address.${out.messages.length ? ' ' + out.messages.join(' ') : ''}`);
  tx(() => {
    q.run("UPDATE shipments SET status = 'superseded', updated_at = ? WHERE order_id = ? AND test = ? AND status = 'rates_ready'", now(), o.id, t);
    q.run('INSERT INTO shipments(order_id, seller_id, test, status, weight_oz, length_in, width_in, height_in, address_hash, provider_shipment_id, rates_json, rates_fetched_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      o.id, user.id, t, 'rates_ready', pc.value.weight_oz, pc.value.length_in, pc.value.width_in, pc.value.height_in, hashOf(from.value, to.value, pc.value), out.id, JSON.stringify(out.rates), now(), now(), now());
  });
  return state(user, o.id);
}

const shippoToHttp = (e) => (e instanceof SH.ShippoError ? new HttpError(e.status, e.message) : e);

// ---------------------------------------------------------------- purchase (explicit confirmation, exactly-once)
function finish(s, t) {
  if (t.status === 'SUCCESS' && t.labelUrl && t.trackingNumber) {
    q.run("UPDATE shipments SET status = 'success', provider_transaction_id = ?, label_url = ?, tracking_number = ?, tracking_url = ?, tracking_status = ?, error_message = NULL, purchased_at = ?, updated_at = ? WHERE id = ? AND status = 'purchasing'",
      t.id, t.labelUrl, t.trackingNumber, t.trackingUrl, t.trackingStatus, now(), now(), s.id);
    return 'success';
  }
  if (t.status === 'SUCCESS') { q.run("UPDATE shipments SET provider_transaction_id = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'purchasing'", t.id || null, 'The provider reported success without a label. Check your Shippo dashboard before trying again.', now(), s.id); return 'purchasing'; }
  if (t.status === 'ERROR' || t.status === 'REFUNDED' || t.status === 'REFUNDPENDING') {
    q.run("UPDATE shipments SET status = 'failed', provider_transaction_id = COALESCE(?, provider_transaction_id), error_message = ?, updated_at = ? WHERE id = ? AND status = 'purchasing'", t.id || null, (t.message || 'The provider could not create the label.').slice(0, 240), now(), s.id);
    return 'failed';
  }
  q.run("UPDATE shipments SET provider_transaction_id = COALESCE(?, provider_transaction_id), updated_at = ? WHERE id = ? AND status = 'purchasing'", t.id || null, now(), s.id);   // QUEUED / WAITING
  return 'purchasing';
}

async function buy(user, orderId, body = {}) {
  rateLimit(`ship-buy:${user.id}`, 10, 3600);
  if (!SH.enabled()) throw new HttpError(503, SH.disabledReason());
  const o = orderFor(user, orderId), t = isTest();
  const existing = latest(o.id, t);
  if (existing && existing.status === 'success') return { ...state(user, o.id), duplicate: true };           // a retry/double click returns the label we already bought
  if (existing && existing.status === 'purchasing') throw new HttpError(409, 'A label purchase is already in progress for this order. Use “Check status” instead of buying again.');
  if (body.confirm !== true) fail({ confirm: 'Confirm the purchase to continue.' }, 'Please confirm the label purchase.');
  const el = eligibility(o); if (!el.ok) throw new HttpError(409, el.reason);
  const claimed = tx(() => {
    const s = q.get("SELECT * FROM shipments WHERE order_id = ? AND test = ? AND status = 'rates_ready' ORDER BY id DESC LIMIT 1", o.id, t);
    if (!s) throw new HttpError(409, 'Get shipping rates first.');
    if (now() - s.rates_fetched_at > RATES_TTL) throw new HttpError(409, 'These rates have expired. Get fresh rates.');
    const from = shipFromRow(user.id), to = toRow(o);
    if (!from || !to || hashOf(address(from).value, address(to).value, parcel({ ...s }).value) !== s.address_hash) throw new HttpError(409, 'The addresses or package changed since these rates were quoted. Get fresh rates.');
    const rate = JSON.parse(s.rates_json).find((r) => r.id === String(body.rateId || ''));
    if (!rate) throw new HttpError(422, 'Choose one of the listed shipping services.', { rateId: 'Not an available rate' });
    if (Number(body.expectedAmountCents) !== rate.amountCents) throw new HttpError(409, 'The price shown no longer matches this rate. Reload the rates and confirm again.');
    try {
      q.run("UPDATE shipments SET status = 'purchasing', selected_rate_id = ?, carrier = ?, service = ?, price_cents = ?, currency = ?, confirmed_at = ?, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'rates_ready'", rate.id, rate.carrier, rate.service, rate.amountCents, rate.currency, now(), now(), s.id);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A label purchase is already in progress or complete for this order.'); throw e; }
    return { s, rate };
  });
  audit(user, 'label_purchase_started', { type: 'order', id: o.id, detail: { test: Boolean(t), carrier: claimed.rate.carrier, service: claimed.rate.service, price_cents: claimed.rate.amountCents, currency: claimed.rate.currency } });
  try {
    const tr = await SH.purchaseLabel({ rateId: claimed.rate.id, ref: `PP-${o.id}-S${claimed.s.id}` });
    finish(claimed.s, tr);
  } catch (e) {
    if (!(e instanceof SH.ShippoError)) throw e;
    if (e.kind === 'unknown') {                      // we cannot know whether Shippo created the label: stay in 'purchasing' so nobody buys a second one blindly
      q.run("UPDATE shipments SET error_message = ?, updated_at = ? WHERE id = ?", 'The provider did not confirm the purchase. It may or may not have been created. Use “Check status”; do not buy again until you have.', now(), claimed.s.id);
      throw new HttpError(502, 'We could not confirm the purchase. Use “Check status” before trying again.');
    }
    q.run("UPDATE shipments SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND status = 'purchasing'", String(e.message).slice(0, 240), now(), claimed.s.id);
    throw shippoToHttp(e);
  }
  const done = q.get('SELECT status FROM shipments WHERE id = ?', claimed.s.id).status;
  audit(user, done === 'success' ? 'label_purchased' : done === 'failed' ? 'label_purchase_failed' : 'label_purchase_pending', { type: 'order', id: o.id, detail: { test: Boolean(t), shipment: claimed.s.id } });
  return { ...state(user, o.id), pending: done === 'purchasing' };
}

/** Poll a pending purchase (QUEUED / unknown outcome with a transaction id). */
async function refresh(user, orderId) {
  rateLimit(`ship-refresh:${user.id}`, 30, 3600);
  const o = orderFor(user, orderId), s = latest(o.id, isTest());
  if (!s || s.status !== 'purchasing') return state(user, o.id);
  if (!s.provider_transaction_id) throw new HttpError(409, 'There is no provider transaction to check. Look in your Shippo dashboard; if nothing was created you can release this purchase and try again.');
  try { finish(s, await SH.getTransaction(s.provider_transaction_id)); } catch (e) { throw shippoToHttp(e); }
  return state(user, o.id);
}
/** Seller declares, after checking their Shippo dashboard, that an unconfirmed purchase never happened. Only when no transaction id exists. */
function release(user, orderId, body = {}) {
  const o = orderFor(user, orderId), s = latest(o.id, isTest());
  if (body.confirm !== true) fail({ confirm: 'Confirm you checked your Shippo dashboard.' }, 'Please confirm.');
  if (!s || s.status !== 'purchasing') throw new HttpError(409, 'Nothing to release.');
  if (s.provider_transaction_id) throw new HttpError(409, 'The provider has a transaction for this purchase. Use “Check status”.');
  if (now() - s.updated_at < STUCK_AFTER) throw new HttpError(409, 'Please wait a couple of minutes before releasing a purchase that is still being processed.');
  q.run("UPDATE shipments SET status = 'failed', error_message = 'Released by the seller after an unconfirmed purchase', updated_at = ? WHERE id = ? AND status = 'purchasing'", now(), s.id);
  audit(user, 'label_purchase_released', { type: 'order', id: o.id, detail: { shipment: s.id } });
  return state(user, o.id);
}

/** Authenticated hand-off to the Shippo-hosted label (re-validated https host). Seller-scoped; never exposed in JSON. */
function labelUrl(user, orderId) {
  const o = orderFor(user, orderId), s = q.get("SELECT label_url FROM shipments WHERE order_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1", o.id);
  if (!s || !s.label_url) throw new HttpError(404, 'No label for this order');
  try { const u = new URL(s.label_url); if (u.protocol !== 'https:') throw new Error('x'); return u.toString(); } catch { throw new HttpError(404, 'No label for this order'); }
}
/** Only REAL (non-test) labels ever surface to buyers or prefill the shipping form. Test labels are not valid postage. */
const realLabel = (orderId) => q.get("SELECT carrier, service, tracking_number, tracking_url, tracking_status FROM shipments WHERE order_id = ? AND test = 0 AND status = 'success' ORDER BY id DESC LIMIT 1", orderId) || null;

module.exports = { state, saveShipFrom, quote, buy, refresh, release, labelUrl, realLabel, address, parcel };
