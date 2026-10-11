'use strict';
// The local shipping sandbox: isolation, test-data marking, production refusal, key rules, the full Shippo TEST workflow (fake transport), logging hygiene.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const H = require('./helpers');
const { q, now, setSetting } = require('../src/db');
const { hashPassword } = require('../src/auth');
const config = require('../src/config');
const SH = require('../src/shippo');
const sb = require('../src/sandbox');
const { png } = require('../scripts/png');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'shippo_test_SANDBOX_TEST_ONLY_KEY_123';
const deps = () => ({ q, now, hashPassword, setSetting, listings: require('../src/listings'), images: require('../src/images'), checkout: require('../src/externalCheckout'), png });
const login = async (email, password) => { const c = new H.Client(); const r = await c.post('/api/login', { email, password }); return { c, status: r.status }; };
const row = (id) => q.get('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC LIMIT 1', id);
let transcript = '';

test.before(async () => { await H.start(); config.shippo = { apiKey: KEY, mode: 'test' }; SH.setTransport(sb.fakeTransport()); });
test.after(() => { SH.setTransport(null); config.shippo = { apiKey: '', mode: 'off' }; return H.stop(); });

test('pre-flight guards: production, live keys, missing/invalid keys and the real database are all refused (the key is never echoed)', () => {
  const ok = { nodeEnv: 'development', shippoKey: KEY, fake: false, dbFile: '/x/sandbox.db', realDbFile: '/x/pairplug.db' };
  assert.doesNotThrow(() => sb.assertSafeEnvironment(ok));
  assert.doesNotThrow(() => sb.assertSafeEnvironment({ ...ok, shippoKey: '', fake: true }));
  assert.throws(() => sb.assertSafeEnvironment({ ...ok, nodeEnv: 'production' }), /development-only/);
  assert.throws(() => sb.assertSafeEnvironment({ ...ok, dbFile: '/x/pairplug.db' }), /real PairPlug database/);
  assert.throws(() => sb.assertSafeEnvironment({ ...ok, shippoKey: '' }), /SHIPPO_API_KEY/);
  for (const bad of ['shippo_live_SECRETVALUE123', 'sk_live_abc', 'whatever']) {
    try { sb.assertSafeEnvironment({ ...ok, shippoKey: bad }); assert.fail('should refuse ' + bad); } catch (e) { assert.ok(!e.message.includes(bad), 'message does not echo the key'); assert.match(e.message, /shippo_test_|LIVE/); }
  }
});

test('the CLI refuses production and live keys before touching anything, and never prints the key', () => {
  const run = (env) => spawnSync(process.execPath, ['scripts/shipping-sandbox.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
  const prod = run({ NODE_ENV: 'production', SHIPPO_API_KEY: KEY }); assert.equal(prod.status, 1); assert.match(prod.stderr, /development-only/);
  const live = run({ SHIPPO_API_KEY: 'shippo_live_SUPERSECRET999' }); assert.equal(live.status, 1); assert.match(live.stderr, /LIVE Shippo key/); assert.ok(!(live.stdout + live.stderr).includes('SUPERSECRET999'));
  const none = run({}); assert.equal(none.status, 1); assert.match(none.stderr, /--fake-shippo/);
  const other = run({ SHIPPO_API_KEY: KEY, PAIRPLUG_DB: path.join(ROOT, 'data', 'pairplug.db') }); assert.equal(other.status, 1); assert.match(other.stderr, /another database/);
});

test('config.sandbox is ignored in production', () => {
  const get = (env) => execFileSync(process.execPath, ['-e', "console.log(require('./src/config').sandbox)"], { cwd: ROOT, env: { PATH: process.env.PATH, PAIRPLUG_DB: ':memory:', PAIRPLUG_UPLOADS: '/tmp/pp-sbx', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop();
  assert.equal(get({ PAIRPLUG_SANDBOX: '1' }), 'true'); assert.equal(get({ PAIRPLUG_SANDBOX: '1', NODE_ENV: 'production', PUBLIC_URL: 'https://x.example' }), 'false'); assert.equal(get({}), 'false');
});

test('seeding creates only clearly-marked test data, one paid and one unpaid order, with fresh random one-time passwords', async () => {
  const logs = []; const orig = { log: console.log, error: console.error, warn: console.warn }; for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  let out; try { out = sb.seed(deps()); } finally { Object.assign(console, orig); }
  transcript += logs.join('\n');
  assert.deepEqual(Object.values(out.email).sort(), ['buyer@sandbox.invalid', 'seller@sandbox.invalid']); assert.notEqual(out.password.seller, out.password.buyer); assert.ok(out.password.seller.length >= 12);
  const users = q.all('SELECT email, display_name, store_name FROM users'); assert.ok(users.length === 2 && users.every((u) => u.email.endsWith('@sandbox.invalid')), 'only sandbox accounts exist');
  assert.match(q.get("SELECT display_name d FROM users WHERE email = 'seller@sandbox.invalid'").d, /\[TEST DATA\]/);
  assert.equal(q.get("SELECT value v FROM settings WHERE key = 'sandbox'").v, '1');
  assert.ok(q.all("SELECT title FROM listings WHERE title LIKE '[TEST DATA]%'").length >= 2);
  const paid = q.get('SELECT * FROM orders WHERE id = ?', out.paidOrder), unpaid = q.get('SELECT * FROM orders WHERE id = ?', out.unpaidOrder);
  assert.equal(paid.status, 'paid'); assert.equal(paid.payment_reference, 'SANDBOX-TEST-NO-REAL-PAYMENT'); assert.equal(unpaid.status, 'pending_payment'); assert.equal(paid.shipped_at, null);
  assert.ok(!q.get('SELECT password_hash h FROM users WHERE email = ?', out.email.seller).h.includes(out.password.seller), 'only a hash is stored');
  // re-running rotates passwords, keeps one paid order, and invalidates the old password
  const again = sb.seed(deps()); assert.equal(again.paidOrder, out.paidOrder); assert.equal(q.get("SELECT COUNT(*) n FROM orders WHERE status = 'paid'").n, 1);
  assert.equal((await login(out.email.seller, out.password.seller)).status, 401); assert.equal((await login(again.email.seller, again.password.seller)).status, 200);
  globalThis.__sbx = again;
});

test('the whole Shippo TEST workflow on the sandbox order: validation, rates, confirmed test label, persistence, errors; real checks still apply', async () => {
  const s = globalThis.__sbx, { c: seller } = await login(s.email.seller, s.password.seller), { c: buyer } = await login(s.email.buyer, s.password.buyer);
  const base = `/api/seller/orders/${s.paidOrder}/shipping`;
  config.sandbox = true; try { assert.match((await seller.get('/')).text, /SHIPPING SANDBOX — TEST DATA ONLY/, 'banner marks the data as test data'); } finally { config.sandbox = false; }
  // missing ship-from, then an invalid one, then a valid one
  const miss = await seller.post(`${base}/rates`, {}); assert.equal(miss.status, 409); assert.equal(miss.json.fields.missing, 'ship_from');
  assert.equal((await seller.put('/api/seller/ship-from', { name: 'TEST Seller', line1: '965 Mission St', city: 'San Francisco', region: 'CA', postal: 'BAD', country: 'US' })).status, 422);
  assert.equal((await seller.put('/api/seller/ship-from', { name: 'TEST Seller', line1: '965 Mission St', city: 'San Francisco', region: 'ca', postal: '94103', country: 'US' })).status, 200);
  // parcel validation (seeded defaults are overridden by bad input)
  assert.equal((await seller.post(`${base}/rates`, { weight_oz: 0 })).status, 422); assert.equal((await seller.post(`${base}/rates`, { length_in: 500 })).status, 422);
  // rates
  const r = await seller.post(`${base}/rates`, { weight_oz: 20, length_in: 12, width_in: 9, height_in: 4 }); assert.equal(r.status, 200); assert.deepEqual(r.json.shipment.rates.map((x) => x.id), ['rate_fake_usps', 'rate_fake_ups']);
  // unconfirmed / wrong price are refused; confirmed purchase creates a TEST label
  assert.equal((await seller.post(`${base}/buy`, { rateId: 'rate_fake_usps', expectedAmountCents: 758 })).status, 422);
  assert.equal((await seller.post(`${base}/buy`, { rateId: 'rate_fake_usps', expectedAmountCents: 9, confirm: true })).status, 409);
  const b = await seller.post(`${base}/buy`, { rateId: 'rate_fake_usps', expectedAmountCents: 758, confirm: true }); assert.equal(b.status, 200); assert.equal(b.json.shipment.status, 'success'); assert.equal(b.json.shipment.test, true);
  const sh = row(s.paidOrder); assert.equal(sh.test, 1); assert.equal(sh.price_cents, 758); assert.equal(sh.currency, 'USD'); assert.equal(sh.carrier, 'USPS'); assert.ok(sh.tracking_number && sh.label_url && sh.provider_transaction_id);
  assert.equal(q.get('SELECT tracking_number t, status s FROM orders WHERE id = ?', s.paidOrder).t, null, 'test label is not copied into the order'); assert.equal(q.get('SELECT status s FROM orders WHERE id = ?', s.paidOrder).s, 'paid');
  assert.equal((await seller.post(`${base}/buy`, { rateId: 'rate_fake_usps', expectedAmountCents: 758, confirm: true })).json.duplicate, true, 'retry returns the same label');
  // privacy: nothing sensitive in what the browser receives
  for (const t of [JSON.stringify(b.json), (await seller.get(`/dashboard/orders/${s.paidOrder}`)).text, (await buyer.get(`/orders/${s.paidOrder}`)).text]) assert.ok(!t.includes(KEY) && !t.includes(sh.provider_transaction_id) && !t.includes(sh.label_url), 'no token, transaction id or label URL in browser output');
  assert.ok(!(await buyer.get(`/orders/${s.paidOrder}`)).text.includes(sh.tracking_number), 'buyers never see test tracking');
  // the unpaid order is refused (paid/unshipped rule is not bypassed)
  const un = await seller.post(`/api/seller/orders/${s.unpaidOrder}/shipping/rates`, { weight_oz: 20, length_in: 12, width_in: 9, height_in: 4 }); assert.equal(un.status, 409); assert.match(un.json.error, /payment/i);
});

test('provider failures on the sandbox order are handled without leaking details', async () => {
  const s = globalThis.__sbx;
  const second = sb.seed({ ...deps(), gen: () => 'fixedpass-' + Math.random().toString(36).slice(2) });
  q.run("UPDATE orders SET status = 'shipped', shipped_at = 1, carrier = 'USPS', tracking_number = 'SBX' || id WHERE id = ?", second.paidOrder);   // consume it, forcing a brand-new paid order on next seed
  const third = sb.seed(deps()); assert.notEqual(third.paidOrder, second.paidOrder);
  const { c: seller } = await login(third.email.seller, third.password.seller); const base = `/api/seller/orders/${third.paidOrder}/shipping`;
  await seller.put('/api/seller/ship-from', { name: 'TEST Seller', line1: '965 Mission St', city: 'San Francisco', region: 'CA', postal: '94103', country: 'US' });
  assert.equal((await seller.post(`${base}/rates`, {})).status, 200);
  SH.setTransport(async (r) => (r.path === '/transactions/' ? { status: 200, json: { object_id: 'txn_fail_000001', status: 'ERROR', test: true, messages: [{ text: 'Carrier rejected the shipment' }] } } : sb.fakeTransport()(r)));
  try {
    const f = await seller.post(`${base}/buy`, { rateId: 'rate_fake_usps', expectedAmountCents: 758, confirm: true }); assert.equal(f.status, 200); assert.equal(f.json.shipment.status, 'failed'); assert.match(f.json.shipment.error, /rejected/);
    SH.setTransport(async () => { throw new Error('boom: internal-secret-detail'); });
    assert.equal((await seller.post(`${base}/rates`, {})).status, 502);
  } finally { SH.setTransport(sb.fakeTransport()); }
});

test('the sandbox refuses a database that holds real (non-sandbox) accounts or orders, and no output ever contained secrets or addresses', async () => {
  const real = await H.newUser('Real Customer'), realSeller = await H.newSeller('RealOther'), s = globalThis.__sbx, base = `/api/seller/orders/${s.paidOrder}/shipping`;
  // a real seller can never see or act on sandbox orders (ownership is enforced exactly as for real orders), and vice versa
  assert.equal((await realSeller.get(base)).status, 404); assert.equal((await realSeller.post(`${base}/rates`, {})).status, 404); assert.equal((await realSeller.get(`/dashboard/orders/${s.paidOrder}/label`)).status, 404);
  assert.equal((await real.get(base)).status, 403, 'buyers have no shipping access');
  assert.throws(() => sb.seed(deps()), /non-sandbox accounts/);
  assert.throws(() => sb.assertSandboxDb(q), /non-sandbox/);
  q.run('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)', real.email);
  assert.ok(!transcript.includes(KEY) && !transcript.includes('215 Clayton'), 'seeding logged nothing sensitive');
});
