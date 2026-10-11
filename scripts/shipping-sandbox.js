'use strict';
// DEVELOPMENT-ONLY shipping sandbox: an isolated database with clearly-marked TEST data so you can run the whole Shippo TEST-mode label workflow locally.
//   $env:SHIPPO_API_KEY="shippo_test_..."; node scripts/shipping-sandbox.js [--reset] [--port 3100]     (your own Shippo TEST token, this terminal only)
//   node scripts/shipping-sandbox.js --fake-shippo                                                       (no Shippo, no token: an in-process fake, UI only)
//   node scripts/shipping-sandbox.js --manual-only                                                       (Shippo OFF: exactly the live-beta seller order page; any SHIPPO_API_KEY is ignored)
// It never touches data/pairplug.db, refuses NODE_ENV=production and live Shippo keys, listens on 127.0.0.1 only, and prints no token, address or provider id.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2), flag = (n) => args.includes(n), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dataDir = path.resolve(opt('--data-dir', path.join(root, 'data')));     // --data-dir exists so tests never touch your own sandbox files
const dbFile = path.join(dataDir, 'shipping-sandbox.db'), upDir = path.join(dataDir, 'shipping-sandbox-uploads'), realDb = path.join(root, 'data', 'pairplug.db');
const die = (m) => { console.error('SANDBOX REFUSED: ' + m); process.exit(1); };

const { assertSafeEnvironment } = require('../src/sandbox');
const fake = flag('--fake-shippo'), manual = flag('--manual-only');
if (manual) delete process.env.SHIPPO_API_KEY;        // manual-only never reads, validates or uses a Shippo credential
if (path.resolve(dbFile) === path.resolve(realDb)) die('Refusing the real database path.');
if (process.env.PAIRPLUG_DB && path.resolve(process.env.PAIRPLUG_DB) !== dbFile) die('PAIRPLUG_DB is set to another database. Unset it; the sandbox uses its own file.');
try { assertSafeEnvironment({ nodeEnv: process.env.NODE_ENV, shippoKey: process.env.SHIPPO_API_KEY || '', fake, manual, dbFile, realDbFile: realDb }); } catch (e) { die(e.message); }
if (flag('--reset')) { for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true }); fs.rmSync(upDir, { recursive: true, force: true }); console.log('Sandbox database reset (only the sandbox files were removed).'); }

const port = Number(opt('--port', 3100));
Object.assign(process.env, { PAIRPLUG_DB: dbFile, PAIRPLUG_UPLOADS: upDir, PAIRPLUG_SANDBOX: '1', CHECKOUT_MODE: 'external', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, NODE_ENV: 'development' });
if (fake) process.env.SHIPPO_API_KEY = 'shippo_test_SANDBOX_FAKE_NOT_A_REAL_TOKEN';
fs.mkdirSync(dataDir, { recursive: true });

const sandbox = require('../src/sandbox');
const { q, now, setSetting } = require('../src/db');
const { hashPassword } = require('../src/auth');
const SH = require('../src/shippo');
const config = require('../src/config');
if (fake) SH.setTransport(sandbox.fakeTransport());
let out;
try {
  out = sandbox.seed({ q, now, hashPassword, setSetting, listings: require('../src/listings'), images: require('../src/images'), checkout: require('../src/externalCheckout'), png: require('./png').png });
} catch (e) { die(e.message); }
require('../src/server').createServer().listen(port, '127.0.0.1', () => {
  const base = `http://localhost:${port}`;
  console.log(`\nSHIPPING SANDBOX (test data only) — Shippo: ${manual ? 'OFF (manual-only: this is exactly the live-beta seller order page)' : fake ? 'FAKE (no network)' : 'TEST token from your environment'}`);
  console.log(`Database: ${path.relative(root, dbFile) || dbFile} (isolated from your real data)\n`);
  console.log(`Log in at ${base}/login`);
  console.log(`  TEST seller: ${out.email.seller}   one-time password: ${out.password.seller}`);
  console.log(`  TEST buyer : ${out.email.buyer}   one-time password: ${out.password.buyer}`);
  console.log('These passwords are generated for this run only; restart the sandbox for new ones.\n');
  console.log(`Seller order ready for a label (paid, unshipped): ${base}/dashboard/orders/${out.paidOrder}`);
  console.log(`Seller order that is NOT paid (labels must be refused): ${base}/dashboard/orders/${out.unpaidOrder}`);
  console.log(`Buyer view of the paid order: ${base}/orders/${out.paidOrder}\n`);
  console.log('Press Ctrl+C to stop. Nothing here is a real customer, payment or order.');
  void config;
});
