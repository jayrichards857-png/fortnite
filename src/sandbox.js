'use strict';
// Local SHIPPING SANDBOX (development only). Builds a throwaway database containing clearly-marked TEST data (a test seller, a test buyer, one paid
// order ready for a label and one unpaid order) so the Shippo TEST-mode workflow can be exercised without any real customer, payment or order.
// Safety model:
//   * it only ever runs against its own database file (never data/pairplug.db) and refuses a database holding anything that isn't sandbox data;
//   * it is refused in production, and config.sandbox is ignored in production;
//   * it accepts only `shippo_test_` credentials (or an in-process FAKE Shippo, clearly labelled) — never a live key;
//   * it adds NO bypass to the app: orders are created through the normal checkout functions, so ownership, paid/unshipped and rate-limit checks apply unchanged.
const crypto = require('node:crypto');
const path = require('node:path');

const DOMAIN = 'sandbox.invalid';
const MARK = '[TEST DATA]';
const FIXTURE_ADDRESS = { name: 'TEST Buyer (sandbox)', line1: '215 Clayton St', city: 'San Francisco', region: 'CA', postal: '94117', country: 'US' };   // a public Shippo documentation sample address

/** Pure pre-flight checks. Throws Error with a safe message (never includes the key). */
function assertSafeEnvironment({ nodeEnv = '', shippoKey = '', fake = false, manual = false, dbFile, realDbFile }) {
  if (fake && manual) throw new Error('Choose either --fake-shippo or --manual-only, not both.');
  if (/^production\b/.test(String(nodeEnv).trim())) throw new Error('The shipping sandbox is development-only and refuses to run with NODE_ENV=production.');
  if (path.resolve(dbFile) === path.resolve(realDbFile)) throw new Error('Refusing to use the real PairPlug database. The sandbox has its own database file.');
  if (!fake && !manual) {          // --manual-only never uses Shippo (any key in the environment is ignored and removed), so there is nothing to validate
    if (!shippoKey) throw new Error('Set SHIPPO_API_KEY to a Shippo TEST token (starts with shippo_test_) in this terminal, or run with --fake-shippo to try the UI without Shippo.');
    if (/^shippo_live_/.test(shippoKey)) throw new Error('A LIVE Shippo key was found. The sandbox only accepts shippo_test_ tokens and will not run with a live key.');
    if (!/^shippo_test_\S+$/.test(shippoKey)) throw new Error('SHIPPO_API_KEY is not a Shippo test token (it must start with shippo_test_).');
  }
}

/** The sandbox database must be empty or contain ONLY sandbox data. Anything else is treated as real data and the sandbox refuses to touch it. */
function assertSandboxDb(q) {
  const foreign = q.get(`SELECT COUNT(*) n FROM users WHERE email NOT LIKE '%@${DOMAIN}'`).n;
  const orders = q.get(`SELECT COUNT(*) n FROM orders o JOIN users b ON b.id = o.buyer_id WHERE b.email NOT LIKE '%@${DOMAIN}'`).n;
  if (foreign || orders) throw new Error('This database contains non-sandbox accounts or orders. The shipping sandbox only runs on its own throwaway database (use --reset to rebuild it).');
}

const generate = () => crypto.randomBytes(12).toString('base64url');

/** Seed (or refresh) the sandbox. Returns what the operator needs: emails, FRESH one-time passwords, and the order numbers. Prints nothing itself. */
function seed({ q, now, hashPassword, setSetting, listings, images, checkout, png, gen = generate }) {
  assertSandboxDb(q);
  setSetting('sandbox', '1');
  const pw = { seller: gen(), buyer: gen() }, email = { seller: `seller@${DOMAIN}`, buyer: `buyer@${DOMAIN}` };
  const upsert = (key, fields) => {
    const row = q.get('SELECT id FROM users WHERE email = ?', email[key]);
    if (row) { q.run('UPDATE users SET password_hash = ?, banned = 0 WHERE id = ?', hashPassword(pw[key]), row.id); q.run('DELETE FROM sessions WHERE user_id = ?', row.id); return row.id; }
    return Number(q.run(`INSERT INTO users(email, password_hash, display_name, is_seller, handle, store_name, country, region, city, email_verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      email[key], hashPassword(pw[key]), fields.name, fields.seller ? 1 : 0, fields.handle || null, fields.store || null, fields.seller ? 'US' : null, fields.seller ? 'CA' : null, fields.seller ? 'San Francisco' : null, now(), now()).lastInsertRowid);
  };
  const sellerId = upsert('seller', { name: `${MARK} Seller`, seller: true, handle: 'sandbox-test', store: `${MARK} Store` });
  const buyerId = upsert('buyer', { name: `${MARK} Buyer` });
  const user = (id) => q.get('SELECT * FROM users WHERE id = ?', id);
  const makeOrder = (label, confirm) => {
    const file = images.saveUpload(sellerId, png(240, 300, (x, y) => [150 - (y >> 4), 120, 90 + (x >> 4)]));
    const saved = listings.saveListing(user(sellerId), null, { title: `${MARK} ${label}`, description: 'Sandbox listing. Not a real item.', category: 'outerwear', brand: 'Sandbox', size: 'M', condition: 'good', price: '40.00', shipping: '6.00', shipping_payer: 'buyer',
      weight_oz: 20, length_in: 12, width_in: 9, height_in: 4, payment_url: 'https://buy.stripe.com/test_sandbox_not_a_real_link', payment_amount_ack: true, images: [file], status: 'active' });
    const listingId = typeof saved === 'object' ? saved.id : saved;
    const { orderId } = checkout.startPurchase(user(buyerId), { listingId, address: FIXTURE_ADDRESS, acknowledged: true });
    if (confirm) checkout.sellerConfirmPayment(user(sellerId), orderId, { reference: 'SANDBOX-TEST-NO-REAL-PAYMENT' });
    return orderId;
  };
  const open = (st) => q.get(`SELECT o.id FROM orders o WHERE o.buyer_id = ? AND o.status = ? ORDER BY o.id DESC LIMIT 1`, buyerId, st);
  const paid = (open('paid') || {}).id || makeOrder('Jacket (ready for a label)', true);
  const pending = (open('pending_payment') || {}).id || makeOrder('Sweater (payment not confirmed)', false);
  return { email, password: pw, handle: 'sandbox-test', paidOrder: paid, unpaidOrder: pending };
}

/** In-process FAKE Shippo for `--fake-shippo`: no network, no token. Labels it returns are obviously fake. */
function fakeTransport() {
  const rates = [{ object_id: 'rate_fake_usps', provider: 'USPS', servicelevel: { name: 'Priority Mail' }, amount: '7.58', currency: 'USD', estimated_days: 2 },
    { object_id: 'rate_fake_ups', provider: 'UPS', servicelevel: { name: 'Ground' }, amount: '10.20', currency: 'USD', estimated_days: 4 }];
  return async (r) => {
    if (r.method === 'POST' && r.path === '/shipments/') return { status: 200, json: { object_id: 'shp_fake', test: true, rates } };
    if (r.method === 'POST' && r.path === '/transactions/') return { status: 200, json: { object_id: 'txn_fake_sandbox_0001', status: 'SUCCESS', test: true, label_url: 'https://shippo-delivery-east.s3.amazonaws.com/FAKE-sandbox-label.pdf', tracking_number: 'SANDBOX_FAKE_TRACKING' } };
    if (r.method === 'GET') return { status: 200, json: { object_id: 'txn_fake_sandbox_0001', status: 'SUCCESS', test: true, label_url: 'https://shippo-delivery-east.s3.amazonaws.com/FAKE-sandbox-label.pdf', tracking_number: 'SANDBOX_FAKE_TRACKING' } };
    return { status: 404, json: {} };
  };
}

module.exports = { DOMAIN, MARK, FIXTURE_ADDRESS, assertSafeEnvironment, assertSandboxDb, seed, fakeTransport };
