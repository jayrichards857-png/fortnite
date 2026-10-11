'use strict';
// Shippo label integration (TEST MODE): authorization, validation, rates, confirmed purchase, failures, duplicates. The network is never touched:
// every Shippo call goes through an injected fake transport.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const SH = require('../src/shippo');
const ship = require('../src/shipments');
const { assertProductionConfig } = require('../src/server');

const KEY = 'shippo_test_FAKE_KEY_FOR_TESTS_ONLY_123';
const LINK = 'https://buy.stripe.com/test_ship123';
const FROM = { name: 'Seller Shop', line1: '5 Warehouse Rd', city: 'Brooklyn', region: 'ny', postal: '11201', country: 'US', phone: '212-555-0100' };
const PARCEL = { weight_oz: 20, length_in: 12, width_in: 9, height_in: 4 };
const TRK = '94001' + Date.now();
const LABEL = 'https://shippo-delivery-east.s3.amazonaws.com/label-abc.pdf';

let calls, behave;
const rates = [
  { object_id: 'rate_ups', provider: 'UPS', servicelevel: { name: 'Ground' }, amount: '10.20', currency: 'USD', estimated_days: 4 },
  { object_id: 'rate_usps', provider: 'USPS', servicelevel: { name: 'Priority Mail' }, amount: '7.58', currency: 'USD', estimated_days: 2 },
];
const ok = (over = {}) => ({ object_id: 'txn_0123456789', status: 'SUCCESS', label_url: LABEL, tracking_number: 'SHIPPO_TRANSIT', tracking_url_provider: 'https://track.example.test/x', test: true, ...over });
function reset() {
  calls = []; behave = { transaction: () => ({ status: 200, json: ok() }), shipment: () => ({ status: 200, json: { object_id: 'shp_1', test: true, rates } }) };
  SH.setTransport(async (req) => {
    calls.push(req);
    if (req.method === 'POST' && req.path === '/shipments/') return behave.shipment(req);
    if (req.method === 'POST' && req.path === '/transactions/') return behave.transaction(req);
    if (req.method === 'GET' && req.path.startsWith('/transactions/')) return behave.get ? behave.get(req) : { status: 200, json: ok() };
    return { status: 404, json: {} };
  });
}
const txCalls = () => calls.filter((c) => c.path === '/transactions/' && c.method === 'POST').length;
const row = (id) => q.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', id);

test.before(async () => { await H.start(); config.shippo = { apiKey: KEY, mode: 'test' }; reset(); });
test.beforeEach(() => reset());
test.after(() => { SH.setTransport(null); config.shippo = { apiKey: '', mode: 'off' }; return H.stop(); });

async function paidOrder() {
  const seller = await H.newSeller('Ship'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: '6.00', shipping_payer: 'buyer' });
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId;
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 200);
  return { seller, buyer, o };
}
const rates_ = (s, o, body = PARCEL) => s.post(`/api/seller/orders/${o}/shipping/rates`, body);
const buy = (s, o, body) => s.post(`/api/seller/orders/${o}/shipping/buy`, body);
async function quoted() { const x = await paidOrder(); assert.equal((await x.seller.put('/api/seller/ship-from', FROM)).status, 200); const r = await rates_(x.seller, x.o); assert.equal(r.status, 200, r.text); return { ...x, r }; }

test('disabled states: no key, a LIVE key, and production never reach the provider', async () => {
  const { seller, o } = await paidOrder();
  for (const cfg of [{ apiKey: '', mode: 'off' }, { apiKey: 'shippo_live_FAKE', mode: 'live-blocked' }]) {
    config.shippo = cfg;
    const st = await seller.get(`/api/seller/orders/${o}/shipping`); assert.equal(st.status, 200); assert.equal(st.json.enabled, false); assert.ok(st.json.disabledReason);
    await seller.put('/api/seller/ship-from', FROM);
    assert.equal((await rates_(seller, o)).status, 503); assert.equal((await buy(seller, o, { confirm: true })).status, 503);
  }
  assert.match((await seller.get(`/api/seller/orders/${o}/shipping`)).json.disabledReason, /live Shippo key.*disabled|not set up/);
  config.shippo = { apiKey: KEY, mode: 'test' };
  config.isProd = true; try { assert.equal(SH.enabled(), false, 'production'); } finally { config.isProd = false; }
  assert.equal(calls.length, 0, 'no provider call was made');
});

test('authorization: only the owning seller; buyers, anonymous and other sellers get nothing (and never see credentials)', async () => {
  const { seller, buyer, o } = await quoted(); const other = await H.newSeller('Other'); const anon = new H.Client();
  await buy(seller, o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true });
  const probes = [['get', `/api/seller/orders/${o}/shipping`], ['post', `/api/seller/orders/${o}/shipping/rates`], ['post', `/api/seller/orders/${o}/shipping/buy`], ['post', `/api/seller/orders/${o}/shipping/refresh`], ['post', `/api/seller/orders/${o}/shipping/release`], ['get', `/dashboard/orders/${o}/label`]];
  const before = calls.length;
  for (const [m, u] of probes) {
    assert.equal((await other[m](u, m === 'post' ? { ...PARCEL, confirm: true, rateId: 'rate_usps', expectedAmountCents: 758 } : undefined)).status, 404, `other seller ${u}`);
    const b = await buyer[m](u, m === 'post' ? {} : undefined); assert.equal(b.status, u.startsWith('/dashboard') ? 302 : 403, `buyer ${u}`); if (u.startsWith('/dashboard')) assert.equal(b.headers.get('location'), '/sell');
    assert.equal((await anon[m](u, m === 'post' ? {} : undefined)).status, u.startsWith('/dashboard') ? 302 : 401, `anon ${u}`);
  }
  assert.equal(calls.length, before, 'unauthorised requests never reach the provider');
  assert.equal((await other.get(`/dashboard/orders/${o}/label`)).status, 404);
  const own = await seller.get(`/api/seller/orders/${o}/shipping`); assert.equal(own.status, 200);
  for (const t of [own.text, (await seller.get(`/dashboard/orders/${o}`)).text, (await buyer.get(`/orders/${o}`)).text]) { assert.ok(!t.includes(KEY) && !t.includes('shippo_test_') && !t.includes(LABEL) && !t.includes('txn_0123456789'), 'no credential, label URL or provider id in browser-visible data'); }
  assert.equal(await (async () => { const l = await seller.get(`/dashboard/orders/${o}/label`); return l.status; })(), 302);
});

test('missing or invalid shipment data is requested, never invented', async () => {
  const { seller, o } = await paidOrder();
  let r = await rates_(seller, o); assert.equal(r.status, 409); assert.equal(r.json.fields.missing, 'ship_from');
  assert.equal((await seller.put('/api/seller/ship-from', { ...FROM, postal: 'ABCDE', line1: '' })).status, 422);
  const bad = await seller.put('/api/seller/ship-from', { ...FROM, postal: 'ABCDE', line1: '' }); assert.ok(bad.json.fields.postal && bad.json.fields.line1);
  assert.equal((await seller.put('/api/seller/ship-from', { ...FROM, country: 'FR' })).status, 422);
  await seller.put('/api/seller/ship-from', FROM);
  assert.equal(q.get('SELECT region FROM seller_ship_from').region, 'NY', 'state code normalised');
  r = await rates_(seller, o, {}); assert.equal(r.status, 422, 'dimensions are required (the listing has none)'); assert.ok(r.json.fields.length_in);
  assert.equal((await rates_(seller, o, { ...PARCEL, weight_oz: 0 })).status, 422); assert.equal((await rates_(seller, o, { ...PARCEL, height_in: 999 })).status, 422);
  q.run('UPDATE checkouts SET ship_postal = ? WHERE id = (SELECT checkout_id FROM orders WHERE id = ?)', 'XX', o);
  r = await rates_(seller, o); assert.equal(r.status, 409); assert.match(r.json.error, /delivery address/);
  assert.equal(calls.length, 0, 'nothing was sent to the provider with incomplete data');
  const pending = await paidOrderPending(); assert.equal((await rates_(pending.seller, pending.o)).status, 409);
});
async function paidOrderPending() {
  const seller = await H.newSeller('Pend'), buyer = await H.newUser('B2'); const id = await H.makeListing(seller, { payment_url: LINK });
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId; await seller.put('/api/seller/ship-from', FROM); return { seller, o };
}

test('rate retrieval: correct provider payload, sorted cheapest first, nothing bought, no secrets in the body', async () => {
  const { r } = await quoted();
  const rs = r.json.shipment.rates; assert.deepEqual(rs.map((x) => x.id), ['rate_usps', 'rate_ups']); assert.equal(rs[0].amountCents, 758); assert.equal(rs[0].currency, 'USD');
  assert.equal(r.json.shipment.status, 'rates_ready'); assert.equal(txCalls(), 0, 'getting rates buys nothing');
  const c = calls[0]; assert.equal(c.path, '/shipments/'); assert.equal(c.body.address_from.state, 'NY'); assert.equal(c.body.address_to.zip, '78701'); assert.equal(c.body.parcels[0].mass_unit, 'oz'); assert.equal(c.body.parcels[0].distance_unit, 'in'); assert.equal(c.body.async, false);
  assert.ok(!JSON.stringify(c.body).includes(KEY));
  assert.equal(r.json.test, undefined); assert.equal(r.json.mode, 'test'); assert.match(r.json.billing, /Test mode/);
  const { seller, o } = await quoted(); calls.length = 0;
  behave.shipment = () => ({ status: 200, json: { object_id: 'shp_2', test: true, rates: [], messages: [{ text: 'No services' }] } });
  const none = await rates_(seller, o); assert.equal(none.status, 422); assert.match(none.json.error, /No carrier services/);
  behave.shipment = () => ({ status: 422, json: { address_to: ['Invalid ZIP'] } });
  const e = await rates_(seller, o); assert.equal(e.status, 422); assert.match(e.json.error, /Invalid ZIP/);
});

test('purchase requires explicit confirmation and an exact price; success stores everything and is clearly a TEST label', async () => {
  const { seller, buyer, o } = await quoted();
  assert.equal((await buy(seller, o, { rateId: 'rate_usps', expectedAmountCents: 758 })).status, 422, 'no confirm flag'); assert.equal(txCalls(), 0);
  assert.equal((await buy(seller, o, { rateId: 'rate_usps', expectedAmountCents: 1, confirm: true })).status, 409, 'price mismatch'); assert.equal(txCalls(), 0);
  assert.equal((await buy(seller, o, { rateId: 'rate_forged', expectedAmountCents: 758, confirm: true })).status, 422); assert.equal(txCalls(), 0);
  const r = await buy(seller, o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true });
  assert.equal(r.status, 200, r.text); assert.equal(txCalls(), 1); assert.equal(r.json.shipment.status, 'success'); assert.equal(r.json.shipment.test, true); assert.equal(r.json.shipment.hasLabel, true);
  const s = row(o); assert.equal(s.test, 1); assert.equal(s.price_cents, 758); assert.equal(s.currency, 'USD'); assert.equal(s.carrier, 'USPS'); assert.equal(s.service, 'Priority Mail'); assert.equal(s.tracking_number, 'SHIPPO_TRANSIT'); assert.equal(s.provider_transaction_id, 'txn_0123456789'); assert.equal(s.label_url, LABEL);
  assert.equal(calls.at(-1).body.rate, 'rate_usps'); assert.equal(calls.at(-1).body.metadata, `PP-${o}-S${s.id}`);
  const ord = q.get('SELECT carrier, tracking_number, status FROM orders WHERE id = ?', o); assert.equal(ord.tracking_number, null, 'a test label is never copied to the order'); assert.equal(ord.status, 'paid');
  const bp = (await buyer.get(`/orders/${o}`)).text; assert.ok(!bp.includes('SHIPPO_TRANSIT'), 'buyers never see test tracking');
  const l = await seller.get(`/dashboard/orders/${o}/label`); assert.equal(l.status, 302); assert.equal(l.headers.get('location'), LABEL);
  assert.ok(q.all("SELECT 1 FROM audit_log WHERE action IN ('label_purchase_started','label_purchased')").length >= 2);
  assert.throws(() => q.run('UPDATE shipments SET price_cents = 1 WHERE id = ?', s.id), /cannot be changed/); assert.throws(() => q.run('DELETE FROM shipments WHERE id = ?', s.id), /cannot be deleted/);
  assert.equal((await rates_(seller, o)).status, 409, 'no second quote once a label exists');
});

test('duplicates: double-click, concurrent requests and retries buy exactly one label', async () => {
  const { seller, o } = await quoted(); const body = { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true };
  let release; const gate = new Promise((r) => { release = r; });
  behave.transaction = async () => { await gate; return { status: 200, json: ok() }; };
  const first = buy(seller, o, body), second = buy(seller, o, body), third = buy(seller, o, body);
  await new Promise((r) => setTimeout(r, 50)); release();
  const rs = await Promise.all([first, second, third]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 2); assert.equal(txCalls(), 1, 'one provider purchase');
  const again = await buy(seller, o, body); assert.equal(again.status, 200); assert.equal(again.json.duplicate, true); assert.equal(txCalls(), 1);
  assert.equal(q.get("SELECT COUNT(*) n FROM shipments WHERE order_id = ? AND status = 'success'", o).n, 1);
  assert.throws(() => q.run("INSERT INTO shipments(order_id, seller_id, test, status, weight_oz, length_in, width_in, height_in, address_hash, created_at, updated_at) VALUES(?,?,1,'purchasing',1,1,1,1,'x',1,1)", o, q.get('SELECT seller_id s FROM orders WHERE id = ?', o).s), /UNIQUE/, 'the database itself forbids a second purchase');
});

test('failures: provider error, rejection, unknown outcome (timeout/5xx), queued transactions, stuck purchases', async () => {
  // provider reports ERROR: failed, no charge, retry with fresh rates works
  let x = await quoted(); behave.transaction = () => ({ status: 200, json: ok({ status: 'ERROR', label_url: null, tracking_number: null, messages: [{ text: 'Address not serviceable' }] }) });
  let r = await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true }); assert.equal(r.status, 200); assert.equal(r.json.shipment.status, 'failed'); assert.match(r.json.shipment.error, /not serviceable/);
  assert.equal((await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true })).status, 409, 'old quote is spent: get new rates');
  behave.transaction = () => ({ status: 200, json: ok() }); assert.equal((await rates_(x.seller, x.o)).status, 200);
  assert.equal((await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true })).json.shipment.status, 'success');
  // HTTP rejection
  x = await quoted(); behave.transaction = () => ({ status: 422, json: { detail: 'Rate expired' } });
  r = await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true }); assert.equal(r.status, 422); assert.equal(row(x.o).status, 'failed');
  // unknown outcome: stays purchasing, cannot be bought again, cannot be released immediately, never leaks internals
  x = await quoted(); behave.transaction = () => { throw new Error('socket hang up: secret-internal-detail'); };
  r = await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true }); assert.equal(r.status, 502); assert.ok(!r.text.includes('secret-internal-detail') && !r.text.includes(KEY));
  assert.equal(row(x.o).status, 'purchasing');
  assert.equal((await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true })).status, 409);
  assert.equal((await rates_(x.seller, x.o)).status, 409);
  assert.equal((await x.seller.post(`/api/seller/orders/${x.o}/shipping/refresh`)).status, 409, 'no transaction id to check');
  assert.equal((await x.seller.post(`/api/seller/orders/${x.o}/shipping/release`, {})).status, 422, 'needs confirmation');
  assert.equal((await x.seller.post(`/api/seller/orders/${x.o}/shipping/release`, { confirm: true })).status, 409, 'too soon');
  q.run('UPDATE shipments SET updated_at = updated_at - 600 WHERE order_id = ?', x.o);
  assert.equal((await x.seller.post(`/api/seller/orders/${x.o}/shipping/release`, { confirm: true })).status, 200); assert.equal(row(x.o).status, 'failed');
  behave.transaction = () => ({ status: 200, json: ok() }); assert.equal((await rates_(x.seller, x.o)).status, 200);
  // 5xx is also "unknown"
  x = await quoted(); behave.transaction = () => ({ status: 503, json: {} });
  assert.equal((await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true })).status, 502); assert.equal(row(x.o).status, 'purchasing');
  // queued, then completed via "Check status"
  x = await quoted(); behave.transaction = () => ({ status: 200, json: ok({ status: 'QUEUED', label_url: null, tracking_number: null }) });
  r = await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true }); assert.equal(r.status, 200); assert.equal(r.json.pending, true); assert.equal(row(x.o).status, 'purchasing'); assert.equal(row(x.o).provider_transaction_id, 'txn_0123456789');
  assert.equal((await x.seller.post(`/api/seller/orders/${x.o}/shipping/release`, { confirm: true })).status, 409, 'cannot release while the provider has a transaction');
  const before = txCalls(); behave.get = () => ({ status: 200, json: ok() }); r = await x.seller.post(`/api/seller/orders/${x.o}/shipping/refresh`); assert.equal(r.status, 200); assert.equal(r.json.shipment.status, 'success'); assert.equal(txCalls(), before, 'checking status never buys again');
  // a non-test response is refused outright
  x = await quoted(); behave.transaction = () => ({ status: 200, json: ok({ test: false }) });
  r = await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true }); assert.notEqual(r.status, 200); assert.notEqual(row(x.o).status, 'success');
});

test('quotes go stale: changed address or expired rates must be re-quoted; order must be paid and unshipped; rate limits apply', async () => {
  let x = await quoted(); q.run('UPDATE checkouts SET ship_line1 = ? WHERE id = (SELECT checkout_id FROM orders WHERE id = ?)', '99 Other St', x.o);
  assert.equal((await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true })).status, 409); assert.equal(txCalls(), 0);
  x = await quoted(); q.run('UPDATE shipments SET rates_fetched_at = rates_fetched_at - 90000 WHERE order_id = ?', x.o);
  assert.equal((await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true })).status, 409);
  x = await quoted(); await buy(x.seller, x.o, { rateId: 'rate_usps', expectedAmountCents: 758, confirm: true });
  await x.seller.post(`/api/seller/orders/${x.o}/ship`, { carrier: 'USPS', tracking: 'T' + Date.now() });
  assert.equal((await rates_(x.seller, x.o)).status, 409, 'shipped orders cannot get new quotes');
  const rl = await quoted(); config.rateLimitScale = 1;
  try { let last; for (let i = 0; i < 25; i++) { last = await rates_(rl.seller, rl.o); if (last.status === 429) break; } assert.equal(last.status, 429); }
  finally { config.rateLimitScale = 1000; }
});

test('only REAL labels ever reach buyers or prefill the ship form; webhook updates their carrier status', async () => {
  const x = await paidOrder(); const sid = q.get('SELECT id FROM users WHERE handle = ?', x.seller.handle).id;
  q.run("INSERT INTO shipments(order_id, seller_id, test, status, weight_oz, length_in, width_in, height_in, address_hash, carrier, service, price_cents, currency, provider_transaction_id, label_url, tracking_number, created_at, updated_at, purchased_at) VALUES(?,?,0,'success',20,12,9,4,'h','USPS','Priority',758,'USD','txn_real_000001',?,?,1,1,1)", x.o, sid, LABEL, TRK);
  assert.ok((await x.seller.get(`/dashboard/orders/${x.o}`)).text.includes(`value="${TRK}"`), 'ship form prefilled from a real label');
  q.run("UPDATE orders SET status = 'shipped', carrier = 'USPS', tracking_number = ?, shipped_at = 1 WHERE id = ?", TRK, x.o);
  process.env.CARRIER_WEBHOOK_SECRET = 'carrier-secret'; config.carrierWebhookSecret = 'carrier-secret';
  const hook = await fetch(H.base + '/webhooks/tracking', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'carrier-secret' }, body: JSON.stringify({ carrier: 'USPS', trackingNumber: TRK, status: 'TRANSIT' }) });
  assert.equal(hook.status, 200); assert.match((await x.buyer.get(`/orders/${x.o}`)).text, /Carrier status: <strong>TRANSIT<\/strong>/);
});

test('configuration safeguards: invalid keys are reported; any Shippo key is refused in production', () => {
  const keep = { publicUrl: config.publicUrl, paymentsMode: config.paymentsMode, rateLimitScale: config.rateLimitScale, checkoutMode: config.checkoutMode, sellerOnboarding: config.sellerOnboarding, sellerOnboardingRequested: config.sellerOnboardingRequested, isProd: config.isProd, shippo: config.shippo };
  try {
    Object.assign(config, { publicUrl: 'https://beta.example.com', paymentsMode: '', rateLimitScale: 1, checkoutMode: 'external', sellerOnboarding: 'invite', sellerOnboardingRequested: '', isProd: true, shippo: { apiKey: '', mode: 'off' } });
    assert.deepEqual(assertProductionConfig(), []);
    config.shippo = { apiKey: 'shippo_test_x', mode: 'test' }; assert.ok(assertProductionConfig().some((p) => /SHIPPO_API_KEY must not be set in production/.test(p)));
  } finally { Object.assign(config, keep); }
  const out = JSON.parse(execFileSync(process.execPath, ['-e', "const c=require('./src/config');console.log(JSON.stringify({m:c.shippo.mode,p:c.envProblems}))"], { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, PAIRPLUG_DB: ':memory:', PAIRPLUG_UPLOADS: '/tmp/pp-x', SHIPPO_API_KEY: 'not-a-shippo-key' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop());
  assert.equal(out.m, 'invalid'); assert.ok(out.p.some((p) => /SHIPPO_API_KEY must start with shippo_test_/.test(p)));
  const live = JSON.parse(execFileSync(process.execPath, ['-e', "const c=require('./src/config');console.log(c.shippo.mode)"], { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, PAIRPLUG_DB: ':memory:', PAIRPLUG_UPLOADS: '/tmp/pp-x', SHIPPO_API_KEY: 'shippo_live_abc123' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop().replace(/^(.*)$/, '"$1"'));
  assert.equal(live, 'live-blocked');
});
