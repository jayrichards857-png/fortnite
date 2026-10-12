'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Each test file gets its own throwaway database and upload dir: fixtures can never touch the live marketplace.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairplug-test-'));
// A private, empty PostgreSQL database per test file (dropped on exit). See test/testdb.js and scripts/pg-test.sh.
{
  const testdb = require('./testdb');
  if (process.env.PAIRPLUG_TEST_DATABASE_URL) {          // an explicit, named throwaway database (scripts/seed-demo.js): kept after the run, never dropped here
    const name = decodeURIComponent(new URL(process.env.PAIRPLUG_TEST_DATABASE_URL).pathname.slice(1));
    if (!testdb.NAME.test(name)) throw new Error('PAIRPLUG_TEST_DATABASE_URL must name a pp_test_*, pp_sandbox* or pp_demo* database');
    process.env.DATABASE_URL = process.env.PAIRPLUG_TEST_DATABASE_URL;
  } else {
    const created = testdb.createSync();
    process.env.DATABASE_URL = created.url;
    process.on('exit', () => testdb.dropSync(created.name));
  }
}
process.env.PAIRPLUG_UPLOADS = process.env.PAIRPLUG_UPLOADS || path.join(dir, 'uploads');
process.env.PG_IDLE_TIMEOUT_MS = process.env.PG_IDLE_TIMEOUT_MS ?? '300';      // idle connections close quickly so test processes exit promptly
process.env.PAYMENTS_MODE = process.env.PAYMENTS_MODE ?? 'sandbox';
process.env.CARRIER_WEBHOOK_SECRET = 'carrier-secret';
// Test sellers are created through the dev/test-only open onboarding path; invitation-only behaviour is tested by flipping config explicitly.
process.env.SELLER_ONBOARDING = process.env.SELLER_ONBOARDING ?? 'open';
// legacy tests exercise the PairPlug-held (platform) flow; direct-checkout tests set CHECKOUT_MODE=external before requiring this file
process.env.CHECKOUT_MODE = process.env.CHECKOUT_MODE ?? 'platform';
process.env.TAX_RATE_BPS = process.env.TAX_RATE_BPS ?? '0';

const { png } = require('../scripts/png');
const config = require('../src/config');
config.rateLimitScale = 1000;
const { createServer } = require('../src/server');
// Test databases only: lift the beta seller cap (the cap itself is exercised in test/beta.test.js) so older suites can create many sellers.
const dbReady = (async () => { const { q, ready } = require('../src/db'); await ready(); await q.run("UPDATE settings SET value = '1000' WHERE key = 'seller_cap'"); })();

let server, base;
async function start() {
  await dbReady;
  await new Promise((res) => { server = createServer().listen(0, '127.0.0.1', res); });
  config.port = server.address().port; // sandbox pay endpoint calls back into this server
  base = `http://127.0.0.1:${config.port}`;
}
const stop = async () => { if (server) await new Promise((r) => { server.closeAllConnections(); server.close(r); }); await require('../src/db').close(); };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { raw, type, headers = {} } = {}) {
    const h = { 'X-Requested-With': 'pairplug', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (raw) h['Content-Type'] = type;
    const res = await fetch(base + url, { method, headers: h, body: raw ? body : body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  put(u, b) { return this.req('PUT', u, b ?? {}); }
}
let n = 0;
async function newUser(name = 'User') {
  const c = new Client(); n++;
  c.email = `u${n}-${Date.now()}@example.test`;
  const r = await c.post('/api/register', { email: c.email, display_name: `${name} ${n}`, terms: true, password: 'correct-horse-9' });
  if (r.status !== 200) throw new Error('register failed ' + r.text);
  return c;
}
async function newSeller(name = 'Seller', plan) {
  const c = await newUser(name);
  c.handle = `h${n}${Date.now() % 100000}`;
  const r = await c.post('/api/sell/onboard', { store_name: `${name} store ${n}`, handle: c.handle, country: 'US', region: 'NY', city: 'Brooklyn', agree: true, terms: true });
  if (r.status !== 200) throw new Error('onboard failed ' + r.text);
  await require('../src/db').q.run('UPDATE users SET email_verified_at = CAST(EXTRACT(EPOCH FROM now()) AS BIGINT) WHERE handle = ?', c.handle);   // test sellers are pre-verified unless a test says otherwise
  if (plan) await require('../src/db').q.run('UPDATE users SET plan = ? WHERE handle = ?', plan, c.handle);
  return c;
}
async function upload(c) {
  const buf = png(8, 8, (x, y) => [x * 30, y * 30, 120]);
  const r = await c.req('POST', '/api/uploads', buf, { raw: true, type: 'image/png' });
  if (r.status !== 200) throw new Error('upload failed ' + r.text);
  return r.json.file;
}
async function makeListing(seller, over = {}) {
  const file = await upload(seller);
  const r = await seller.post('/api/seller/listings', { title: 'Test jacket', description: 'Worn twice', category: 'outerwear', brand: 'Acme', size: 'M', condition: 'good', price: '40.00', shipping: '5.00', cost: '15.00', weight_oz: '20', images: [file], status: 'active', ...(over.payment_url ? { payment_amount_ack: true } : {}), ...over });
  if (r.status !== 200) throw new Error('listing failed ' + r.text);
  return r.json.id;
}
const address = { name: 'Buyer Person', line1: '1 Main St', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
let k = 0;
const checkout = (buyer, key) => buyer.post('/api/checkout', { idempotencyKey: key || `key-${Date.now()}-${++k}-abcdef`, address });
const pay = (buyer, checkoutId, outcome = 'succeeded') => buyer.post(`/api/sandbox/pay/${checkoutId}`, { outcome });
module.exports = { start, stop, Client, newUser, newSeller, upload, makeListing, checkout, pay, address, get base() { return base; } };
