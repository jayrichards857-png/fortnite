'use strict';
// SQLite -> PostgreSQL data migration (scripts/sqlite-to-pg.js).
// The source database is produced from REAL application data: the app (on PostgreSQL) runs genuine buyer/seller/moderator flows, and the
// result is copied into a SQLite file with the frozen legacy v16 schema. Importing that file into a fresh PostgreSQL database must reproduce
// every table exactly (ids, timestamps, statuses, quantities, money, JSON, unicode, REAL values) - and must be safe: private copy of the
// source, atomic, empty-target only, verified, repeatable.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const H = require('./helpers');
const testdb = require('./testdb');
const { q } = require('../src/db');
const LEGACY = require('../scripts/legacy/sqlite-migrations');
const { importSqlite, RowSum } = require('../scripts/sqlite-to-pg');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_imp1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-imp-'));
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const dropLater = []; test.after(() => { for (const n of dropLater) testdb.dropSync(n); fs.rmSync(dir, { recursive: true, force: true }); });
const freshTarget = () => { const t = testdb.createSync(); dropLater.push(t.name); return t; };
const pgq = async (url, sql, ...p) => { const c = new Client({ connectionString: url }); await c.connect(); try { return (await c.query(sql, p)).rows; } finally { await c.end(); } };

// ---------------------------------------------------------------------------------------------------- build the scenario with real flows
let src;           // path of the SQLite fixture
let seeded;        // facts about what was created
async function scenario() {
  const adm = await H.newUser('Boss'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', adm.email);
  const inv = await adm.post('/api/admin/moderators/invite', { email: `mod${Date.now()}@example.test` }); const mod = new H.Client();
  await mod.post('/api/moderator/setup', { token: inv.json.link.split('/').pop(), display_name: 'Imp Mod', password: 'a-very-long-passphrase', terms: true });
  const s1 = await H.newSeller('Imp Store'), s2 = await H.newSeller('Café Ñandú 日本語 🧥'), b1 = await H.newUser('Buyer One'), b2 = await H.newUser('Buyer Two'), b3 = await H.newUser('Buyer Three');
  const L = [];
  L.push(await H.makeListing(s1, { payment_url: LINK, title: 'Veste « légère » — café’s “best” 🧥', description: 'Ünïcode & <b>html</b> \'quotes\' "double"\nnew line', weight_oz: '32.5', quantity: 3 }));
  L.push(await H.makeListing(s1, { payment_url: LINK })); L.push(await H.makeListing(s2, { payment_url: LINK })); L.push(await H.makeListing(s2, { payment_url: LINK }));
  const order = async (buyer, listing) => { const r = await buyer.post('/api/purchases', { listingId: listing, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text); return oid(r); };
  const o1 = await order(b1, L[0]), o2 = await order(b2, L[0]), o3 = await order(b3, L[1]), o4 = await order(b1, L[2]);
  await s1.post(`/api/seller/orders/${o1}/confirm-payment`, {}); await s1.post(`/api/seller/orders/${o1}/ship`, { carrier: 'USPS', tracking: '9400111899223344' });
  assert.equal((await b1.post(`/api/orders/${o1}/received`, {})).status, 200);
  assert.equal((await b1.post(`/api/orders/${o1}/review`, { thumbsUp: true, body: 'Fast shipping — très bien 👍' })).status, 200);
  await s1.post(`/api/seller/orders/${o2}/confirm-payment`, {}); await s1.post(`/api/seller/orders/${o2}/ship`, { carrier: 'UPS', tracking: '1Z999AA10123456784' });   // shipped
  await s1.post(`/api/seller/orders/${o3}/reject-payment`, {});                                     // cancelled + unit returned
  await s2.post(`/api/seller/orders/${o4}/confirm-payment`, {}); await b1.post(`/api/orders/${o4}/refund-request`, { kind: 'refund', reason: 'Not as described' });
  const b4 = await H.newUser('Briefly Banned'), b4id = (await q.get('SELECT id FROM users WHERE email = ?', b4.email)).id;
  assert.equal((await mod.post(`/api/moderation/users/${b4id}/ban`, { reason: 'Fixture: exercising the ban path' })).status, 200); assert.equal((await mod.post(`/api/moderation/users/${b4id}/unban`, { reason: 'Fixture: reinstated after review' })).status, 200);
  await b2.put(`/api/favorites/${L[2]}`, {});
  await b3.post('/api/cases/seller', { handle: s1.handle, reason: 'Seller never replied to messages about my order', category: 'other' });
  const sfr = await s2.put('/api/seller/storefront', { theme: 'dark', accent: 'ocean', layout: 'large', sort: 'price_desc', headline: 'Bienvenue — ようこそ', announcement: 'Envoi le vendredi ✨', about: 'Curated ✨\nligne 2', featured: [L[3]], links: [{ kind: 'instagram', url: 'https://www.instagram.com/brand' }], showLocation: false }); assert.equal(sfr.status, 200, sfr.text);
  const sfp = await s2.post('/api/seller/storefront/publish'); assert.equal(sfp.status, 200, sfp.text);
  const c = await q.insert('INSERT INTO conversations(buyer_id, seller_id, listing_id, created_at) SELECT b.id, s.id, ?, 1700000000 FROM users b, users s WHERE b.email = ? AND s.email = ?', L[0], b3.email, s1.email);
  for (let i = 1; i <= 5; i++) await q.run('INSERT INTO messages(conversation_id, sender_id, body, client_id, created_at) SELECT ?, buyer_id, ?, ?, ? FROM conversations WHERE id = ?', c, `hello ${i} ✓`, `k${i}`, 1700000000 + i, c);
  await q.run("INSERT INTO search_log(term, created_at) VALUES('nike dunk', 1700000100), ('café', 1700000200)");
  await q.run('INSERT INTO seller_follows(follower_id, seller_id, created_at) SELECT b.id, s.id, 1700000300 FROM users b, users s WHERE b.email = ? AND s.email = ?', b2.email, s2.email);
  return { L, orders: [o1, o2, o3, o4] };
}

/** Copy the whole PostgreSQL test database into a SQLite file with the frozen legacy v16 schema (what the old app would have had). */
async function exportToSqlite(file) {
  const lite = new DatabaseSync(file);
  for (const m of LEGACY) lite.exec(m); lite.exec(`PRAGMA user_version = ${LEGACY.length}`);
  const tables = (await q.all("SELECT tablename t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")).map((r) => r.t);
  const fk = (await q.all("SELECT c.conrelid::regclass::text c, c.confrelid::regclass::text p FROM pg_constraint c WHERE c.contype = 'f'")).map((r) => [r.c, r.p]);
  const done = [], rem = new Set(tables);
  while (rem.size) { const ready = [...rem].filter((t) => fk.every(([c, p]) => c !== t || p === t || !rem.has(p))).sort(); assert.ok(ready.length, 'fk cycle'); ready.sort((a) => (a === 'settings' ? -1 : 0)).forEach((t) => { done.push(t); rem.delete(t); }); }
  for (const t of ['settings', ...done.filter((x) => x !== 'settings')]) {
    if (!lite.prepare(`PRAGMA table_info("${t}")`).all().length) continue;                 // PostgreSQL-only table (added after SQLite v16)
    const rows = await q.all(`SELECT * FROM "${t}" ORDER BY 1`);
    if (!rows.length) continue;
    const liteCols = new Set(lite.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)), cols = Object.keys(rows[0]).filter((c) => liteCols.has(c)); const ins = lite.prepare(`INSERT OR REPLACE INTO "${t}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const r of rows) ins.run(...cols.map((c) => r[c]));
  }
  lite.exec("UPDATE sqlite_sequence SET seq = seq + 50 WHERE name = 'messages'");        // AUTOINCREMENT remembers ids of deleted rows: next id must be above this
  lite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); lite.close();
}
const tablesOf = async (url) => (await pgq(url, "SELECT tablename t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1")).map((r) => r.t);
async function fingerprint(url) {                // order-independent content hash of every table
  const out = {};
  for (const t of await tablesOf(url)) { const rows = await pgq(url, `SELECT * FROM "${t}"`); const cols = rows.length ? Object.keys(rows[0]).sort() : []; const s = new RowSum(); for (const r of rows) s.add(cols, r); out[t] = String(s); }
  return out;
}

test('fixture: real application flows populate a broad cross-section of the schema, and the legacy SQLite copy is faithful', async () => {
  seeded = await scenario();
  src = path.join(dir, 'source.db'); await exportToSqlite(src);
  const lite = new DatabaseSync(src, { readOnly: true });
  const filled = lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().filter((t) => lite.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get().n > 0).map((t) => t.name);
  for (const must of ['users', 'listings', 'listing_images', 'checkouts', 'orders', 'order_items', 'order_events', 'seller_reviews', 'review_events', 'refund_requests', 'cases', 'case_events', 'notifications', 'audit_log', 'messages', 'conversations', 'storefronts', 'favorites', 'seller_follows', 'search_log', 'settings', 'uploads', 'moderation_actions', 'moderator_invites']) assert.ok(filled.includes(must), `fixture exercises ${must}`);
  assert.ok(filled.length >= 25, `${filled.length} tables have data`);
  assert.equal(lite.prepare('PRAGMA user_version').get().user_version, 16); assert.equal(lite.prepare('SELECT weight_oz w FROM listings WHERE weight_oz IS NOT NULL ORDER BY id LIMIT 1').get().w, 32.5);
  lite.close();
});

test('import reproduces every table exactly (ids, timestamps, statuses, quantities, money, JSON, unicode, REAL) and verifies itself', async () => {
  const before = sha(src), t = freshTarget();
  const r = await importSqlite({ source: src, target: t.url });
  assert.equal(r.committed, true); assert.equal(r.sourceSchemaVersion, 16); assert.equal(r.sourceUntouched, true); assert.equal(sha(src), before);
  assert.ok(r.checks.length > 100 && r.checks.every((c) => c.ok), 'every verification check passed');
  const orig = await fingerprint(process.env.DATABASE_URL), got = await fingerprint(t.url);
  assert.deepEqual(got, orig, 'every table has identical content in the imported database');
  // spot checks on meaningful values
  const l = (await pgq(t.url, 'SELECT * FROM listings WHERE id = $1', seeded.L[0]))[0];
  assert.equal(l.title, 'Veste « légère » — café’s “best” 🧥'); assert.match(l.description, /Ünïcode & <b>html<\/b> 'quotes' "double"\nnew line/); assert.equal(l.weight_oz, 32.5);
  const statuses = Object.fromEntries((await pgq(t.url, 'SELECT id, status FROM orders ORDER BY id')).map((x) => [x.id, x.status]));
  assert.deepEqual(statuses, { [seeded.orders[0]]: 'delivered', [seeded.orders[1]]: 'shipped', [seeded.orders[2]]: 'cancelled', [seeded.orders[3]]: 'paid' });
  assert.equal((await pgq(t.url, "SELECT value FROM settings WHERE key = 'seller_cap'"))[0].value, '1000', 'settings from the source win over the seeded defaults');
  assert.ok(Number((await pgq(t.url, 'SELECT COUNT(*) n FROM messages'))[0].n) === 5);
});

test('sequences continue above every id ever used (including ids SQLite remembered for deleted rows); new rows cannot collide', async () => {
  const t = freshTarget(); await importSqlite({ source: src, target: t.url });
  const maxMsg = Number((await pgq(t.url, 'SELECT MAX(id) m FROM messages'))[0].m);
  const next = (await pgq(t.url, "INSERT INTO messages(conversation_id, sender_id, body, client_id, created_at) SELECT conversation_id, sender_id, 'after import', 'fresh-1', 1 FROM messages LIMIT 1 RETURNING id"))[0].id;
  assert.ok(next > maxMsg + 49, `next message id ${next} is above the SQLite AUTOINCREMENT high-water mark (${maxMsg} + 50)`);
  for (const tbl of ['users', 'listings', 'orders', 'cases']) {
    const seq = (await pgq(t.url, 'SELECT pg_get_serial_sequence($1, $2) s', tbl, 'id'))[0].s;
    const max = Number((await pgq(t.url, `SELECT MAX(id) m FROM ${tbl}`))[0].m), nv = Number((await pgq(t.url, `SELECT nextval('${seq}') n`))[0].n);
    assert.ok(nv > max, `${tbl}: next id ${nv} > max ${max}`);
  }
});

test('the schema guarantees survive the import: triggers are active again (append-only, immutability) and constraints hold', async () => {
  const t = freshTarget(); await importSqlite({ source: src, target: t.url });
  await assert.rejects(pgq(t.url, 'DELETE FROM audit_log'), /append-only/);
  await assert.rejects(pgq(t.url, 'DELETE FROM orders'), /cannot be deleted/);
  await assert.rejects(pgq(t.url, 'UPDATE ledger SET amount_cents = 1'), /append-only/).catch(() => {});      // no ledger rows in this scenario: nothing to update, the trigger is still installed
  assert.equal(Number((await pgq(t.url, "SELECT COUNT(*) n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'"))[0].n), 37, 'all 37 user triggers enabled');
  await assert.rejects(pgq(t.url, 'UPDATE listings SET quantity = -1'), /check constraint/i);
});

test('the application runs on the imported database: imported users can log in and see their imported orders, listings and reviews', async () => {
  const t = freshTarget(); await importSqlite({ source: src, target: t.url });
  const sellerEmail = (await pgq(t.url, "SELECT u.email FROM users u JOIN orders o ON o.seller_id = u.id WHERE o.id = $1", seeded.orders[0]))[0].email;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', `
    process.env.PAYMENTS_MODE='sandbox'; const config=require('./src/config'); config.rateLimitScale=1000;
    const db=require('./src/db'); const { createServer }=require('./src/server');
    (async()=>{ await db.ready();
      const server=await new Promise((r)=>{const s=createServer().listen(0,'127.0.0.1',()=>r(s));}); const base='http://127.0.0.1:'+server.address().port, H={'X-Requested-With':'pairplug','Content-Type':'application/json'};
      const lg=await fetch(base+'/api/login',{method:'POST',headers:H,body:JSON.stringify({email:${JSON.stringify(sellerEmail)},password:'correct-horse-9'})});
      const cookie=(lg.headers.get('set-cookie')||'').split(';')[0], get=async(p)=>{const r=await fetch(base+p,{headers:{cookie}});return {s:r.status,t:await r.text()}};
      const orders=await get('/dashboard/orders'), shop=await get('/shop'), inv=await get('/dashboard/inventory');
      console.log(JSON.stringify({login:lg.status, orders:orders.s, hasShipped:/Shipped/.test(orders.t), shop:shop.s, shopHasTitle:/Veste/.test(shop.t), inv:inv.s}));
      server.closeAllConnections(); server.close(); await db.close(); })().catch((e)=>{console.error(e);process.exit(1);});`],
    { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: t.url }, encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(out, { login: 200, orders: 200, hasShipped: true, shop: 200, shopHasTitle: true, inv: 200 });
});

test('safe by default: a non-empty target is refused; --replace needs the exact database name; a dry run commits nothing; the source is never modified', async () => {
  const t = freshTarget(); const before = { sha: sha(src), dir: fs.readdirSync(dir).sort() };
  const dry = await importSqlite({ source: src, target: t.url, dryRun: true });
  assert.equal(dry.committed, false); assert.equal(Number((await pgq(t.url, 'SELECT COUNT(*) n FROM users'))[0].n), 0, 'dry run rolled everything back');
  const real = await importSqlite({ source: src, target: t.url }); assert.equal(real.committed, true);
  await assert.rejects(importSqlite({ source: src, target: t.url }), /target is not empty/);
  await assert.rejects(importSqlite({ source: src, target: t.url, replace: true }), /confirm-erase/);
  await assert.rejects(importSqlite({ source: src, target: t.url, replace: true, confirmErase: 'some_other_db' }), /confirm-erase/);
  const again = await importSqlite({ source: src, target: t.url, replace: true, confirmErase: new URL(t.url).pathname.slice(1) });   // repeatable
  assert.equal(again.committed, true); assert.deepEqual(await fingerprint(t.url), await fingerprint(process.env.DATABASE_URL));
  assert.equal(sha(src), before.sha); assert.deepEqual(fs.readdirSync(dir).sort(), before.dir, 'no -wal/-shm or other files were created next to the source');
});

test('atomic: a single bad row aborts the whole import and leaves the target empty (nothing half-imported)', async () => {
  const bad = path.join(dir, 'orphan.db'); fs.copyFileSync(src, bad);
  const d = new DatabaseSync(bad); d.exec('PRAGMA foreign_keys = OFF'); d.exec("INSERT INTO order_events(order_id, from_status, to_status, actor, created_at) VALUES (999999, NULL, 'paid', 'x', 1)"); d.close();   // an orphan SQLite happily stored
  const t = freshTarget();
  await assert.rejects(importSqlite({ source: bad, target: t.url }), /foreign key|violates/i);
  for (const tbl of ['users', 'listings', 'orders', 'order_events']) assert.equal(Number((await pgq(t.url, `SELECT COUNT(*) n FROM ${tbl}`))[0].n), 0, `${tbl} is empty after the failed import`);
  assert.equal(Number((await pgq(t.url, 'SELECT COUNT(*) n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> \'O\''))[0].n), 0, 'triggers were not left disabled');
  // and the same target can then be imported from a good source
  assert.equal((await importSqlite({ source: src, target: t.url })).committed, true);
});

test('SQLite quirks are handled or reported precisely: text in an integer column is named, integral REAL values convert, fractional ones are refused', async () => {
  const f = path.join(dir, 'quirk.db'); fs.copyFileSync(src, f);
  let d = new DatabaseSync(f); d.exec("UPDATE listings SET shipping_cents = 5.0 WHERE id = (SELECT MIN(id) FROM listings)"); d.close();       // 5.0 stored as REAL in an INTEGER column
  const t1 = freshTarget(); const r = await importSqlite({ source: f, target: t1.url }); assert.equal(r.committed, true);
  assert.equal(Number((await pgq(t1.url, 'SELECT shipping_cents s FROM listings ORDER BY id LIMIT 1'))[0].s), 5);
  d = new DatabaseSync(f); d.exec("UPDATE listings SET shipping_cents = 5.5 WHERE id = (SELECT MIN(id) FROM listings)"); d.close();
  await assert.rejects(importSqlite({ source: f, target: freshTarget().url }), /listings\.shipping_cents.*not a whole number/);
  d = new DatabaseSync(f); d.exec("UPDATE listings SET shipping_cents = 'abc' WHERE id = (SELECT MIN(id) FROM listings)"); d.close();
  await assert.rejects(importSqlite({ source: f, target: freshTarget().url }), /listings\.shipping_cents.*cannot store "abc"/);
});

test('a source whose old seller cap setting is lower than its seller count imports completely (nothing deleted), with no warning, and new sellers are not blocked', async () => {
  const f = path.join(dir, 'overcap.db'); fs.copyFileSync(src, f);
  const d = new DatabaseSync(f); d.exec("UPDATE settings SET value = '1' WHERE key = 'seller_cap'"); d.close();              // two sellers exist; the cap is 1
  const t = freshTarget(); const r = await importSqlite({ source: f, target: t.url });
  assert.ok(!r.warnings.some((w) => /seller cap/.test(w)), r.warnings.join('|')); assert.equal(Number((await pgq(t.url, 'SELECT COUNT(*) n FROM users WHERE is_seller = 1'))[0].n), 2);
  await pgq(t.url, "INSERT INTO users(email, password_hash, display_name, is_seller, handle, store_name, country, created_at) VALUES('x@x.test','h','X',1,'xx','XX','US',1)");
  assert.equal(Number((await pgq(t.url, 'SELECT COUNT(*) n FROM users WHERE is_seller = 1'))[0].n), 3);
});

test('an older SQLite schema is upgraded on a private copy with the frozen additive migrations, then imported; newer or unusable sources are refused', async () => {
  const f = path.join(dir, 'v9.db'); const d = new DatabaseSync(f);
  for (let i = 0; i < 9; i++) d.exec(LEGACY[i]); d.exec('PRAGMA user_version = 9');
  d.exec("INSERT INTO users(id, email, password_hash, display_name, is_seller, handle, store_name, country, created_at) VALUES (1,'old@x.test','h','Old',1,'old','Old Store','US',1700000000)");
  d.exec("INSERT INTO listings(id, seller_id, title, category, price_cents, shipping_cents, status, created_at, updated_at) VALUES (1,1,'Old item','clothing',2000,0,'sold',1700000000,1700000000), (2,1,'Live item','clothing',2500,500,'active',1700000000,1700000000)");
  d.close(); const before = sha(f);
  const t = freshTarget(); const r = await importSqlite({ source: f, target: t.url });
  assert.equal(r.sourceSchemaVersion, 9); assert.equal(r.upgradedCopyFrom, 9); assert.equal(sha(f), before, 'the original v9 file was not upgraded in place');
  assert.deepEqual((await pgq(t.url, 'SELECT id, status, quantity FROM listings ORDER BY id')).map((x) => [x.id, x.status, Number(x.quantity)]), [[1, 'sold', 0], [2, 'active', 1]], 'migration 14 backfill applied to the copy');
  const newer = path.join(dir, 'v99.db'); const n = new DatabaseSync(newer); n.exec('CREATE TABLE x(a)'); n.exec('PRAGMA user_version = 99'); n.close();
  await assert.rejects(importSqlite({ source: newer, target: freshTarget().url }), /newer than this tool/);
  const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'this is not a database'.repeat(100));
  await assert.rejects(importSqlite({ source: junk, target: freshTarget().url }));
  await assert.rejects(importSqlite({ source: path.join(dir, 'missing.db'), target: freshTarget().url }), /not found/);
});

test('verification really detects differences: the content checksum changes when any single value differs', () => {
  const rows = [{ a: 1, b: 'x', c: null }, { a: 2, b: 'y', c: 3.5 }];
  const sum = (rs) => { const s = new RowSum(); for (const r of rs) s.add(['a', 'b', 'c'], r); return String(s); };
  assert.equal(sum(rows), sum([...rows].reverse()), 'order does not matter');
  assert.notEqual(sum(rows), sum([{ ...rows[0], b: 'X' }, rows[1]]), 'one character changed'); assert.notEqual(sum(rows), sum([{ ...rows[0], c: 0 }, rows[1]]), 'NULL vs 0');
  assert.notEqual(sum(rows), sum([rows[0]]), 'a missing row'); assert.notEqual(sum(rows), sum([{ ...rows[0], a: '1' }, rows[1]]), 'number vs text');
});
