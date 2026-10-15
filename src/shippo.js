'use strict';
// Thin Shippo REST client (https://docs.goshippo.com). Server-side only: the token comes from config (SHIPPO_API_KEY) and is sent solely in the
// Authorization header of requests to api.goshippo.com. It is never logged, returned to a browser, or included in an error message.
// TEST MODE ONLY in this release: every call is refused unless the token is a `shippo_test_…` token, so no real postage can be bought.
const config = require('./config');

const BASE = 'https://api.goshippo.com';
let transport = null;                                      // tests inject a fake; nothing in the test-suite touches the network
const setTransport = (fn) => { transport = fn; };

/** kind: 'disabled' (not usable here) | 'rejected' (Shippo said no; safe to retry later) | 'unknown' (timeout/5xx: outcome of a purchase is NOT known) */
class ShippoError extends Error { constructor(kind, message, status) { super(message); this.kind = kind; this.status = status || 502; } }

const mode = () => config.shippo.mode;
// Label purchase is available ONLY in the isolated development sandbox (scripts/shipping-sandbox.js sets config.sandbox) and ONLY with a test token.
// In the live beta (production, or any normal run) it is unavailable: sellers buy postage from their own shipping account and enter the tracking number.
// A real customer address is therefore never sent to Shippo outside the sandbox's TEST data.
const enabled = () => mode() === 'test' && !config.isProd && config.sandbox === true;
const disabledReason = () => 'Grailedside does not buy shipping labels or pay postage in the beta. Buy postage from your own shipping account (for example Shippo, Pirate Ship or USPS) and enter the tracking number on the order.';

async function realTransport({ method, path, body }) {
  const res = await fetch(BASE + path, {
    method, headers: { Authorization: `ShippoToken ${config.shippo.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function call(method, path, body) {
  if (!enabled()) throw new ShippoError('disabled', disabledReason(), 503);
  let out;
  try { out = await (transport || realTransport)({ method, path, body }); }
  catch { throw new ShippoError('unknown', 'Could not reach the shipping provider. Nothing was confirmed.', 502); }
  if (out.status === 401 || out.status === 403) throw new ShippoError('rejected', 'The shipping provider refused our credentials. Contact Grailedside support.', 502);
  if (out.status >= 500) throw new ShippoError('unknown', 'The shipping provider had a problem. Nothing was confirmed.', 502);
  if (out.status >= 400) throw new ShippoError('rejected', providerMessage(out.json) || 'The shipping provider rejected the request.', 422);
  if (out.json && out.json.test === false) throw new ShippoError('disabled', 'Refusing a non-test response: live label purchasing is disabled.', 503);   // defence in depth
  return out.json;
}
/** Shippo error bodies vary; keep only short plain strings (never echo raw bodies, which could contain addresses). */
function providerMessage(j) {
  const parts = [];
  const take = (v) => { if (typeof v === 'string') parts.push(v); else if (Array.isArray(v)) v.forEach(take); else if (v && typeof v === 'object') Object.values(v).forEach(take); };
  take(j && (j.detail || j.messages || j.error || j.address_to || j.address_from || j.parcels));
  return parts.join(' ').replace(/[<>]/g, '').slice(0, 240);
}

const addr = (a) => ({ name: a.name, street1: a.line1, street2: a.line2 || undefined, city: a.city, state: a.region, zip: a.postal, country: a.country, phone: a.phone || undefined });
const cents = (v) => Math.round(Number(v) * 100);

/** Create a shipment and return its rates: [{ id, carrier, service, amountCents, currency, days }]. Buys nothing. */
async function createShipment({ from, to, parcel, ref }) {
  const j = await call('POST', '/shipments/', { address_from: addr(from), address_to: addr(to), async: false, metadata: ref,
    parcels: [{ length: String(parcel.length_in), width: String(parcel.width_in), height: String(parcel.height_in), distance_unit: 'in', weight: String(parcel.weight_oz), mass_unit: 'oz' }] });
  const rates = (Array.isArray(j.rates) ? j.rates : []).filter((r) => r && r.object_id && Number.isFinite(Number(r.amount)) && /^[A-Z]{3}$/.test(String(r.currency)))
    .map((r) => ({ id: String(r.object_id), carrier: String(r.provider || '').slice(0, 40), service: String((r.servicelevel && r.servicelevel.name) || '').slice(0, 80), amountCents: cents(r.amount), currency: String(r.currency), days: Number.isFinite(Number(r.estimated_days)) ? Number(r.estimated_days) : null }))
    .sort((a, b) => a.amountCents - b.amountCents);
  return { id: String(j.object_id || ''), rates, messages: Array.isArray(j.messages) ? j.messages.map((m) => String(m.text || m).slice(0, 160)) : [] };
}
const LABEL_HOST = /(^|\.)(goshippo\.com|amazonaws\.com)$/;
const safeUrl = (u, hostRe) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && !x.username && hostRe.test(x.hostname) ? x.toString() : null; } catch { return null; } };
function mapTransaction(t) {
  return { id: String(t.object_id || ''), status: String(t.status || '').toUpperCase(), labelUrl: safeUrl(t.label_url, LABEL_HOST), trackingNumber: t.tracking_number ? String(t.tracking_number).slice(0, 60) : null,
    trackingUrl: safeUrl(t.tracking_url_provider, /./), trackingStatus: t.tracking_status ? String((t.tracking_status && t.tracking_status.status) || t.tracking_status).slice(0, 40) : null,
    message: providerMessage({ messages: t.messages }), test: t.test !== false };
}
/** Buy the label for a rate the seller confirmed. QUEUED/WAITING mean "not finished yet": poll with getTransaction. */
async function purchaseLabel({ rateId, ref }) { return mapTransaction(await call('POST', '/transactions/', { rate: rateId, label_file_type: 'PDF_4x6', async: false, metadata: ref })); }
async function getTransaction(id) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(String(id))) throw new ShippoError('rejected', 'Unknown transaction.', 422);
  return mapTransaction(await call('GET', `/transactions/${encodeURIComponent(id)}`));
}

module.exports = { enabled, mode, disabledReason, createShipment, purchaseLabel, getTransaction, setTransport, ShippoError };
