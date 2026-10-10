'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Each test file gets its own throwaway database and upload dir: fixtures can never touch the live marketplace.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairplug-test-'));
process.env.PAIRPLUG_DB = process.env.PAIRPLUG_DB || path.join(dir, 'test.db');
process.env.PAIRPLUG_UPLOADS = process.env.PAIRPLUG_UPLOADS || path.join(dir, 'uploads');
process.env.PAYMENTS_MODE = process.env.PAYMENTS_MODE ?? 'sandbox';
process.env.CARRIER_WEBHOOK_SECRET = 'carrier-secret';
// legacy tests exercise the PairPlug-held (platform) flow; direct-checkout tests set CHECKOUT_MODE=external before requiring this file
process.env.CHECKOUT_MODE = process.env.CHECKOUT_MODE ?? 'platform';
process.env.TAX_RATE_BPS = process.env.TAX_RATE_BPS ?? '0';

const { png } = require('../scripts/png');
const config = require('../src/config');
config.rateLimitScale = 1000;
const { createServer } = require('../src/server');

let server, base;
async function start() {
  await new Promise((res) => { server = createServer().listen(0, '127.0.0.1', res); });
  config.port = server.address().port; // sandbox pay endpoint calls back into this server
  base = `http://127.0.0.1:${config.port}`;
}
const stop = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });

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
  const r = await c.post('/api/register', { email: c.email, display_name: `${name} ${n}`, password: 'correct-horse-9' });
  if (r.status !== 200) throw new Error('register failed ' + r.text);
  return c;
}
async function newSeller(name = 'Seller', plan) {
  const c = await newUser(name);
  c.handle = `h${n}${Date.now() % 100000}`;
  const r = await c.post('/api/sell/onboard', { store_name: `${name} store ${n}`, handle: c.handle, country: 'US', region: 'NY', city: 'Brooklyn', agree: true });
  if (r.status !== 200) throw new Error('onboard failed ' + r.text);
  if (plan) require('../src/db').q.run('UPDATE users SET plan = ? WHERE handle = ?', plan, c.handle);
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
  const r = await seller.post('/api/seller/listings', { title: 'Test jacket', description: 'Worn twice', category: 'outerwear', brand: 'Acme', size: 'M', condition: 'good', price: '40.00', shipping: '5.00', cost: '15.00', weight_oz: '20', images: [file], status: 'active', ...over });
  if (r.status !== 200) throw new Error('listing failed ' + r.text);
  return r.json.id;
}
const address = { name: 'Buyer Person', line1: '1 Main St', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
let k = 0;
const checkout = (buyer, key) => buyer.post('/api/checkout', { idempotencyKey: key || `key-${Date.now()}-${++k}-abcdef`, address });
const pay = (buyer, checkoutId, outcome = 'succeeded') => buyer.post(`/api/sandbox/pay/${checkoutId}`, { outcome });
module.exports = { start, stop, Client, newUser, newSeller, upload, makeListing, checkout, pay, address, get base() { return base; } };
