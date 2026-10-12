'use strict';
// DEVELOPMENT-ONLY shipping sandbox: an isolated database with clearly-marked TEST data so you can run the whole Shippo TEST-mode label workflow locally.
//   $env:SHIPPO_API_KEY="shippo_test_..."; node scripts/shipping-sandbox.js [--reset] [--port 3100]     (your own Shippo TEST token, this terminal only)
//   node scripts/shipping-sandbox.js --fake-shippo                                                       (no Shippo, no token: an in-process fake, UI only)
//   node scripts/shipping-sandbox.js --manual-only                                                       (Shippo OFF: exactly the live-beta seller order page; any SHIPPO_API_KEY is ignored)
// It never touches your real database (it uses its own pp_sandbox_shipping database), refuses NODE_ENV=production and live Shippo keys, listens on 127.0.0.1 only, and prints no token, address or provider id.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2), flag = (n) => args.includes(n), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dataDir = path.resolve(opt('--data-dir', path.join(root, 'data')));     // uploads for the sandbox live here; --data-dir exists so tests never touch your own sandbox files
const upDir = path.join(dataDir, 'shipping-sandbox-uploads');
const dbName = opt('--db-name', 'pp_sandbox_shipping');                         // the sandbox's own PostgreSQL database (must be named pp_sandbox*)
const die = (m) => { console.error('SANDBOX REFUSED: ' + m); process.exit(1); };

const { assertSafeEnvironment } = require('../src/sandbox');
const testdb = require('../test/testdb');
const fake = flag('--fake-shippo'), manual = flag('--manual-only');
if (manual) delete process.env.SHIPPO_API_KEY;        // manual-only never reads, validates or uses a Shippo credential
if (!testdb.NAME.test(dbName)) die('--db-name must be a pp_sandbox* database name.');
// DATABASE_URL (the real application database on a developer machine) must not be in play: the sandbox derives its own database URL.
if (process.env.DATABASE_URL) { let other = true; try { other = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)) !== dbName; } catch {} if (other) die('DATABASE_URL is set to another database. Unset it; the sandbox uses its own database.'); }
let sandboxUrl;
try { assertSafeEnvironment({ nodeEnv: process.env.NODE_ENV, shippoKey: process.env.SHIPPO_API_KEY || '', fake, manual, databaseUrl: `postgres://x@localhost/${dbName}`, realDatabaseUrl: null }); } catch (e) { die(e.message); }
try { sandboxUrl = testdb.ensureSync(dbName, flag('--reset')); } catch (e) { die('could not prepare the sandbox database: ' + e.message.split('\n')[0]); }
if (flag('--reset')) { fs.rmSync(upDir, { recursive: true, force: true }); console.log('Sandbox database reset (only the sandbox database and its upload folder were removed).'); }

const port = Number(opt('--port', 3100));
Object.assign(process.env, { DATABASE_URL: sandboxUrl, PAIRPLUG_UPLOADS: upDir, PAIRPLUG_SANDBOX: '1', CHECKOUT_MODE: 'external', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, NODE_ENV: 'development' });
if (fake) process.env.SHIPPO_API_KEY = 'shippo_test_SANDBOX_FAKE_NOT_A_REAL_TOKEN';
fs.mkdirSync(dataDir, { recursive: true });

const sandbox = require('../src/sandbox');
const { q, now, setSetting } = require('../src/db');
const { hashPassword } = require('../src/auth');
const SH = require('../src/shippo');
const config = require('../src/config');
if (fake) SH.setTransport(sandbox.fakeTransport());
(async () => {
await require('../src/db').ready();
let out;
try {
  out = await sandbox.seed({ q, now, hashPassword, setSetting, listings: require('../src/listings'), images: require('../src/images'), checkout: require('../src/externalCheckout'), png: require('./png').png });
} catch (e) { die(e.message); }
require('../src/server').createServer().listen(port, '127.0.0.1', () => {
  const base = `http://localhost:${port}`;
  console.log(`\nSHIPPING SANDBOX (test data only) — Shippo: ${manual ? 'OFF (manual-only: this is exactly the live-beta seller order page)' : fake ? 'FAKE (no network)' : 'TEST token from your environment'}`);
  console.log(`Database: ${dbName} (a separate PostgreSQL database, isolated from your real data)\n`);
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
})().catch((e) => die(e.message));
