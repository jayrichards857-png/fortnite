'use strict';
// Operations: migration safety, backups, production guards, health, proxy-aware rate limiting.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers');
const { q, MIGRATIONS } = require('../src/db');
const config = require('../src/config');
const { backup } = require('../scripts/backup');
const { assertProductionConfig } = require('../src/server');

test.before(() => H.start());
test.after(() => H.stop());

test('migration 3 upgrades a populated v2 database without losing or rewriting history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mig-')), file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(MIGRATIONS[0]); old.exec(MIGRATIONS[1]); old.exec('PRAGMA user_version = 2');
  const t = 1700000000;
  old.exec(`
    INSERT INTO users(id, email, password_hash, display_name, is_seller, handle, store_name, country, created_at) VALUES (1,'s@x.test','h','S',1,'s','Store','US',${t}),(2,'b@x.test','h','B',0,NULL,NULL,NULL,${t});
    INSERT INTO listings(id, seller_id, title, category, price_cents, shipping_cents, status, created_at, updated_at) VALUES (1,1,'Free ship item','clothing',2000,0,'active',${t},${t}),(2,1,'Paid ship item','clothing',3000,500,'active',${t},${t}),(3,1,'Sold item','clothing',4000,700,'sold',${t},${t});
    INSERT INTO checkouts(id, buyer_id, status, idempotency_key, total_cents, expires_at, created_at) VALUES (1,2,'paid','legacy-key-0001',4700,${t},${t});
    INSERT INTO orders(id, checkout_id, buyer_id, seller_id, status, subtotal_cents, shipping_cents, tax_cents, total_cents, fee_bps, platform_fee_cents, processing_fee_cents, seller_payout_cents, paid_at, released_at, created_at, updated_at)
      VALUES (1,1,2,1,'released',4000,700,0,4700,1000,400,166,4134,${t},${t},${t},${t});
    INSERT INTO order_items(order_id, listing_id, title, price_cents, cost_cents) VALUES (1,3,'Sold item',4000,1500);
    INSERT INTO ledger(user_id, order_id, kind, amount_cents, note, created_at) VALUES (1,1,'sale_release',4134,'Order #1',${t});
    INSERT INTO withdrawals(user_id, amount_cents, status, created_at) VALUES (1,4134,'requested',${t});`);
  old.close();
  const out = JSON.parse(execFileSync(process.execPath, ['-e', `
    const {q}=require('./src/db');
    const o=q.get('SELECT * FROM orders WHERE id=1');
    let del='none'; try{q.run('DELETE FROM orders WHERE id=1')}catch(e){del=e.message}
    console.log(JSON.stringify({v:q.get('PRAGMA user_version').user_version, order:{status:o.status,mode:o.payment_mode,total:o.total_cents,fee:o.platform_fee_cents,payout:o.seller_payout_cents,snap:o.snapshot_json},
      ledger:q.all('SELECT amount_cents a FROM ledger'), wd:q.all('SELECT status s FROM withdrawals'), ship:q.all('SELECT id,shipping_payer p FROM listings ORDER BY id'), ck:q.get('SELECT mode FROM checkouts WHERE id=1').mode, del}));`], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PAIRPLUG_DB: file, PAIRPLUG_UPLOADS: path.join(dir, 'up') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop());
  assert.equal(out.v, MIGRATIONS.length);
  assert.deepEqual(out.order, { status: 'released', mode: 'platform', total: 4700, fee: 400, payout: 4134, snap: null }, 'historical order is untouched and marked as a PairPlug-processed (platform) order');
  assert.deepEqual(out.ledger, [{ a: 4134 }]); assert.deepEqual(out.wd, [{ s: 'requested' }]); assert.equal(out.ck, 'platform');
  assert.deepEqual(out.ship, [{ id: 1, p: 'seller' }, { id: 2, p: 'buyer' }, { id: 3, p: 'buyer' }], 'existing free listings become seller-pays; the rest stay buyer-pays');
  assert.match(out.del, /cannot be deleted/, 'history is protected from deletion after migration');
});

test('backup: consistent snapshot, integrity-checked, incremental photos, retention; restore opens with all rows', async () => {
  const buyer = await H.newUser('Bk'), seller = await H.newSeller('Bk');
  await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_bk123' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bak-'));
  const a = backup({ dir, keep: 1, stamp: '2030-01-01-00-00-00' });
  assert.equal(a.integrity, 'ok'); assert.ok(a.photosCopied >= 1);
  const snap = new DatabaseSync(a.database, { readOnly: true });
  assert.equal(snap.prepare('SELECT COUNT(*) n FROM users').get().n, q.get('SELECT COUNT(*) n FROM users').n);
  assert.equal(snap.prepare('SELECT COUNT(*) n FROM listings').get().n, q.get('SELECT COUNT(*) n FROM listings').n);
  assert.equal(snap.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length); snap.close();
  const b = backup({ dir, keep: 1, stamp: '2030-01-02-00-00-00' });
  assert.equal(b.photosCopied, 0, 'uploads are copied once');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'db')), ['pairplug-2030-01-02-00-00-00.db'], 'retention keeps only the newest');
  assert.throws(() => backup({ dir, stamp: '2030-01-02-00-00-00' }), /already exists/);
  void buyer;
});

test('production config guard refuses unsafe settings', () => {
  const keep = { publicUrl: config.publicUrl, paymentsMode: config.paymentsMode, rateLimitScale: config.rateLimitScale, checkoutMode: config.checkoutMode };
  try {
    Object.assign(config, { publicUrl: 'https://beta.example.com', paymentsMode: '', rateLimitScale: 1, checkoutMode: 'external' });
    assert.deepEqual(assertProductionConfig(), []);
    config.publicUrl = 'http://beta.example.com'; assert.match(assertProductionConfig().join(), /https/);
    config.publicUrl = 'https://beta.example.com'; config.paymentsMode = 'sandbox'; assert.match(assertProductionConfig().join(), /sandbox/);
    config.paymentsMode = ''; config.rateLimitScale = 100; assert.match(assertProductionConfig().join(), /RATE_LIMIT_SCALE/);
    config.rateLimitScale = 1; config.checkoutMode = 'platform'; assert.match(assertProductionConfig().join(), /CHECKOUT_MODE/);
  } finally { Object.assign(config, keep); }
});

test('health check proves the DB answers and reveals no secrets', async () => {
  const r = await new H.Client().get('/healthz');
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['checkoutMode', 'ok']);
});

test('rate limits are per real client IP behind a proxy (X-Forwarded-For), not shared by everyone', async () => {
  config.rateLimitScale = 1;
  try {
    const email = `victim-${Date.now()}@example.test`, login = (ip) => fetch(H.base + '/api/login', { method: 'POST', headers: { 'x-requested-with': 'pairplug', 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password: 'wrong-wrong-1' }) });
    let last; for (let i = 0; i < 9; i++) last = await login('203.0.113.10');
    assert.equal(last.status, 429, 'attacker is throttled');
    assert.equal((await login('198.51.100.7')).status, 401, 'a different client is unaffected');
  } finally { config.rateLimitScale = 1000; }
});

test('uploads: only real images, size-limited, and files are served inert', async () => {
  const u = await H.newUser();
  const svg = await u.req('POST', '/api/uploads', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), { raw: true, type: 'image/svg+xml' });
  assert.equal(svg.status, 415);
  const html = await u.req('POST', '/api/uploads', Buffer.from('<html><script>alert(1)</script></html>'), { raw: true, type: 'image/png' });
  assert.equal(html.status, 415, 'content is sniffed, not the declared type');
  const big = await u.req('POST', '/api/uploads', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6 * 1024 * 1024)]), { raw: true, type: 'image/jpeg' });
  assert.ok([413, 400].includes(big.status));
  const file = await H.upload(u);
  assert.match(file, /^[a-f0-9]{32}\.png$/, 'server-chosen name, no user-controlled path');
  const served = await fetch(H.base + '/uploads/' + file); assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(H.base + '/uploads/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await new H.Client().post('/api/uploads', {})).status, 401);
});
