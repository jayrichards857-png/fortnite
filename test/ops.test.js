'use strict';
// Operations: migration safety, backups, production guards, health, proxy-aware rate limiting.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { dbAt, upgradeAndRun } = require('./pgmig');
const H = require('./helpers');
const { q, MIGRATIONS } = require('../src/db');
const config = require('../src/config');
const { backup } = require('../scripts/backup');
const { assertProductionConfig } = require('../src/server');

test.before(async () => await H.start());
test.after(() => H.stop());

test('migration 3 upgrades a populated v2 database without losing or rewriting history', async () => {
  const old = await dbAt(2);
  const t = 1700000000;
  await old.run(`
    INSERT INTO users(id, email, password_hash, display_name, is_seller, handle, store_name, country, created_at) VALUES (1,'s@x.test','h','S',1,'s','Store','US',${t}),(2,'b@x.test','h','B',0,NULL,NULL,NULL,${t});
    INSERT INTO listings(id, seller_id, title, category, price_cents, shipping_cents, status, created_at, updated_at) VALUES (1,1,'Free ship item','clothing',2000,0,'active',${t},${t}),(2,1,'Paid ship item','clothing',3000,500,'active',${t},${t}),(3,1,'Sold item','clothing',4000,700,'sold',${t},${t});
    INSERT INTO checkouts(id, buyer_id, status, idempotency_key, total_cents, expires_at, created_at) VALUES (1,2,'paid','legacy-key-0001',4700,${t},${t});
    INSERT INTO orders(id, checkout_id, buyer_id, seller_id, status, subtotal_cents, shipping_cents, tax_cents, total_cents, fee_bps, platform_fee_cents, processing_fee_cents, seller_payout_cents, paid_at, released_at, created_at, updated_at)
      VALUES (1,1,2,1,'released',4000,700,0,4700,1000,400,166,4134,${t},${t},${t},${t});
    INSERT INTO order_items(order_id, listing_id, title, price_cents, cost_cents) VALUES (1,3,'Sold item',4000,1500);
    INSERT INTO ledger(user_id, order_id, kind, amount_cents, note, created_at) VALUES (1,1,'sale_release',4134,'Order #1',${t});
    INSERT INTO withdrawals(user_id, amount_cents, status, created_at) VALUES (1,4134,'requested',${t});`);
  const out = upgradeAndRun(old.url, `
    const o=await q.get('SELECT * FROM orders WHERE id=1');
    let del='none'; try{await q.run('DELETE FROM orders WHERE id=1')}catch(e){del=e.message}
    return {v:await db.schemaVersion(), order:{status:o.status,mode:o.payment_mode,total:o.total_cents,fee:o.platform_fee_cents,payout:o.seller_payout_cents,snap:o.snapshot_json},
      ledger:await q.all('SELECT amount_cents a FROM ledger'), wd:await q.all('SELECT status s FROM withdrawals'), ship:await q.all('SELECT id,shipping_payer p FROM listings ORDER BY id'), ck:(await q.get('SELECT mode FROM checkouts WHERE id=1')).mode, del};
  `);
  await old.close();
  assert.equal(out.v, MIGRATIONS.length);
  assert.deepEqual(out.order, { status: 'released', mode: 'platform', total: 4700, fee: 400, payout: 4134, snap: null }, 'historical order is untouched and marked as a PairPlug-processed (platform) order');
  assert.deepEqual(out.ledger, [{ a: 4134 }]); assert.deepEqual(out.wd, [{ s: 'requested' }]); assert.equal(out.ck, 'platform');
  assert.deepEqual(out.ship, [{ id: 1, p: 'seller' }, { id: 2, p: 'buyer' }, { id: 3, p: 'buyer' }], 'existing free listings become seller-pays; the rest stay buyer-pays');
  assert.match(out.del, /cannot be deleted/, 'history is protected from deletion after migration');
});

test('backup: consistent snapshot, manifest + verification, incremental photos, retention; restore opens with all rows', async () => {
  const buyer = await H.newUser('Bk'), seller = await H.newSeller('Bk');
  await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_bk123' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bak-'));
  const withPw = new URL(process.env.DATABASE_URL); withPw.password = 's3cr3tpw';        // the local test server uses trust auth, so a made-up password connects fine
  const a = await backup({ dir, keep: 1, stamp: '2030-01-01-00-00-00', databaseUrl: withPw.toString() });
  assert.equal(a.integrity, 'ok'); assert.ok(a.photosCopied >= 1);
  assert.equal(a.manifest.schemaVersion, MIGRATIONS.length);
  assert.equal(a.manifest.tables.users, (await q.get('SELECT COUNT(*) n FROM users')).n); assert.equal(a.manifest.tables.listings, (await q.get('SELECT COUNT(*) n FROM listings')).n);
  assert.equal(Object.keys(a.manifest.tables).length, 49, 'every table (48 app tables + schema_migrations) is counted'); assert.match(a.manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!fs.readFileSync(a.database + '.json', 'utf8').includes('s3cr3tpw'), 'the manifest never contains the database password');
  const b = await backup({ dir, keep: 1, stamp: '2030-01-02-00-00-00' });
  assert.equal(b.photosCopied, 0, 'uploads are copied once');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'db')).sort(), ['pairplug-2030-01-02-00-00-00.dump', 'pairplug-2030-01-02-00-00-00.dump.json'], 'retention keeps only the newest dump (and its manifest)');
  await assert.rejects(backup({ dir, stamp: '2030-01-02-00-00-00' }), /already exists/);
  void buyer;
});

test('production config guard refuses unsafe settings', () => {
  const keep = { publicUrl: config.publicUrl, paymentsMode: config.paymentsMode, rateLimitScale: config.rateLimitScale, checkoutMode: config.checkoutMode, sellerOnboarding: config.sellerOnboarding };
  try {
    Object.assign(config, { publicUrl: 'https://beta.example.com', paymentsMode: '', rateLimitScale: 1, checkoutMode: 'external', sellerOnboarding: 'invite' });
    assert.deepEqual(assertProductionConfig(), []);
    config.publicUrl = 'http://beta.example.com'; assert.match(assertProductionConfig().join(), /https/);
    config.publicUrl = 'https://beta.example.com'; config.paymentsMode = 'sandbox'; assert.match(assertProductionConfig().join(), /sandbox/);
    config.paymentsMode = ''; config.rateLimitScale = 100; assert.match(assertProductionConfig().join(), /RATE_LIMIT_SCALE/);
    config.rateLimitScale = 1; config.checkoutMode = 'platform'; assert.match(assertProductionConfig().join(), /CHECKOUT_MODE/);
    config.checkoutMode = 'external'; config.sellerOnboarding = 'open'; assert.match(assertProductionConfig().join(), /SELLER_ONBOARDING must be "invite"/);
  } finally { Object.assign(config, keep); }
});

test('health check proves the DB answers and reveals no secrets', async () => {
  const r = await new H.Client().get('/healthz');
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['checkoutMode', 'ok', 'schema']); assert.equal(r.json.schema, MIGRATIONS.length);
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

test('migration 4 on a populated v3 database with MORE sellers than the cap: nothing is deleted, new sellers are blocked', async () => {
  const old = await dbAt(3);
  const t = 1700000000;
  for (let i = 1; i <= 5; i++) await old.run(`INSERT INTO users(id, email, password_hash, display_name, is_seller, handle, store_name, country, created_at) VALUES (${i},'s${i}@x.test','h','S${i}',1,'s${i}','Store ${i}','US',${t})`);
  await old.run(`INSERT INTO users(id, email, password_hash, display_name, is_seller, created_at) VALUES (6,'b@x.test','h','B',0,${t})`);
  const out = upgradeAndRun(old.url, `
    let blocked='no'; try{await q.run("INSERT INTO users(email,password_hash,display_name,is_seller,handle,store_name,country,created_at) VALUES('n@x.test','h','N',1,'nn','NN','US',1)")}catch(e){blocked=e.message}
    let upgrade='no'; try{await q.run('UPDATE users SET is_seller=1, handle=?, store_name=?, country=? WHERE id=6','bb','BB','US')}catch(e){upgrade=e.message}
    return ({v:await db.schemaVersion(), sellers:(await q.get('SELECT COUNT(*) n FROM users WHERE is_seller=1')).n, users:(await q.get('SELECT COUNT(*) n FROM users')).n, cap:(await q.get("SELECT value FROM settings WHERE key='seller_cap'")).value, blocked, upgrade})
  `);
  await old.close();
  assert.equal(out.v, MIGRATIONS.length); assert.equal(out.sellers, 5, 'existing sellers preserved'); assert.equal(out.users, 6); assert.equal(out.cap, '3');
  assert.match(out.blocked, /seller/i, 'a new seller is refused while over the cap'); assert.match(out.upgrade, /seller/i, 'a buyer cannot become a seller while over the cap');
});

test('backup files are owner-only; restore verifies the manifest and schema version, refuses to overwrite without --force, keeps a pre-restore copy', async () => {
  const { restore } = require('../scripts/restore'); const testdb = require('./testdb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rst-'));
  const a = await backup({ dir, stamp: '2031-01-01-00-00-00' });
  assert.equal(fs.statSync(a.database).mode & 0o777, 0o600); assert.equal(fs.statSync(a.database + '.json').mode & 0o777, 0o600); assert.equal(fs.statSync(path.join(dir, 'db')).mode & 0o777, 0o700);
  const fresh = testdb.createSync(), up = path.join(dir, 'restored', 'uploads');
  try {
    const r = await restore({ dump: a.database, databaseUrl: fresh.url, uploadDir: up, photosDir: path.join(dir, 'uploads'), supportedVersion: MIGRATIONS.length });
    assert.equal(r.integrity, 'ok'); assert.equal(r.schemaVersion, MIGRATIONS.length); assert.ok(r.photosRestored >= 0); assert.equal(r.tables, 49);
    const { Client } = require('pg'); const c = new Client({ connectionString: fresh.url }); await c.connect();
    try { assert.equal(Number((await c.query('SELECT COUNT(*) n FROM users')).rows[0].n), (await q.get('SELECT COUNT(*) n FROM users')).n);
      // the restored database keeps its guarantees: append-only tables, constraints and triggers came across
      await assert.rejects(c.query("DELETE FROM audit_log"), /append-only/); await assert.rejects(c.query("UPDATE listings SET quantity = -1"), /check constraint/i); } finally { await c.end(); }
    await assert.rejects(restore({ dump: a.database, databaseUrl: fresh.url, uploadDir: up, supportedVersion: MIGRATIONS.length }), /refusing to overwrite/);
    const forced = await restore({ dump: a.database, databaseUrl: fresh.url, uploadDir: up, force: true, supportedVersion: MIGRATIONS.length });
    assert.ok(fs.existsSync(forced.preRestore) && fs.existsSync(forced.preRestore + '.json'), 'the database being replaced was backed up first');
    await assert.rejects(restore({ dump: a.database, databaseUrl: testdb.createSync().url, supportedVersion: MIGRATIONS.length - 1 }), /newer than this code/);
    // tampered / corrupt / unverifiable backups write nothing
    const empty = testdb.createSync();
    try {
      const bad = path.join(dir, 'db', 'corrupt.dump'); fs.writeFileSync(bad, 'this is not a database'.repeat(200)); fs.writeFileSync(bad + '.json', JSON.stringify({ ...a.manifest }));
      await assert.rejects(restore({ dump: bad, databaseUrl: empty.url, supportedVersion: MIGRATIONS.length }), /integrity check/);
      fs.copyFileSync(a.database, path.join(dir, 'db', 'nomanifest.dump'));
      await assert.rejects(restore({ dump: path.join(dir, 'db', 'nomanifest.dump'), databaseUrl: empty.url, supportedVersion: MIGRATIONS.length }), /manifest/);
      const c2 = new Client({ connectionString: empty.url }); await c2.connect(); try { assert.equal(Number((await c2.query("SELECT COUNT(*) n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n), 0, 'a failed restore writes nothing'); } finally { await c2.end(); }
    } finally { testdb.dropSync(empty.name); }
  } finally { testdb.dropSync(fresh.name); }
});
