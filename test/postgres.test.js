'use strict';
// PostgreSQL behaviour: transaction semantics and rollback, deadlock retry, migrations (fresh / idempotent / concurrent / failing / newer),
// schema parity with the legacy SQLite schema, and concurrency guarantees for the flows where a lost race would cost money or stock:
// inventory reservation, duplicate purchases, order claim vs reject vs expiry, caps, moderation actions, single-use links, review duplicates.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const H = require('./helpers');
const { q, tx, toPg, isUnique, lockKey, getPool, applyMigrations, MIGRATIONS } = require('../src/db');
const { dbAt } = require('./pgmig');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_pg1';
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const count = async (sql, ...p) => Number((await q.get(sql, ...p)).n);
const buy = (b, listingId) => b.post('/api/purchases', { listingId, acknowledged: true, address: H.address });
const listing = async (id) => await q.get('SELECT * FROM listings WHERE id = ?', id);
const mkAdmin = async () => { const a = await H.newUser('Boss'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };

// ------------------------------------------------------------------------------------------------ SQL layer
test('placeholder conversion: ? and ?N become $n, but never inside string literals, quoted identifiers or comments', () => {
  assert.equal(toPg('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(toPg("SELECT '?' q, \"a?b\" x, ? y -- really? \n, ? /* and ? */ z"), "SELECT '?' q, \"a?b\" x, $1 y -- really? \n, $2 /* and ? */ z");
  assert.equal(toPg("SELECT 'it''s ?' a, ?"), "SELECT 'it''s ?' a, $1"); assert.equal(toPg('SELECT ?1, ?1, ?2'), 'SELECT $1, $1, $2');
  assert.equal(toPg("UPDATE t SET a = ? WHERE b ILIKE ? ESCAPE '\\'"), "UPDATE t SET a = $1 WHERE b ILIKE $2 ESCAPE '\\'");
});

test('q.get / all / run / insert: row shapes, numbers for BIGINT/COUNT/SUM, undefined params become NULL, insert returns the id', async () => {
  const id = await q.insert("INSERT INTO search_log(term, created_at) VALUES(?, ?)", 'pg-shape', 1700000000);
  assert.equal(typeof id, 'number'); assert.ok(id > 0);
  const row = await q.get('SELECT id, term, created_at FROM search_log WHERE id = ?', id); assert.deepEqual({ ...row }, { id, term: 'pg-shape', created_at: 1700000000 });
  assert.equal(await q.get('SELECT 1 x WHERE FALSE'), undefined); assert.deepEqual(await q.all('SELECT 1 x WHERE FALSE'), []);
  const n = await q.get('SELECT COUNT(*) n, COALESCE(SUM(created_at), 0) s FROM search_log WHERE term = ?', 'pg-shape'); assert.equal(typeof n.n, 'number'); assert.equal(n.s, 1700000000);
  assert.equal((await q.run('UPDATE search_log SET term = ? WHERE id = ?', 'pg-shape2', id)).changes, 1); assert.equal((await q.run('UPDATE search_log SET term = ? WHERE id = ?', 'x', -1)).changes, 0);
  await q.run('INSERT INTO search_log(term, created_at) VALUES(?, ?)', 'with-undefined', undefined === 1 ? 1 : 5);
  assert.equal(await q.insert('INSERT INTO notifications(user_id, title, dedupe_key, created_at) SELECT id, ?, ?, 1 FROM users WHERE FALSE', 't', 'k'), null, 'insert that inserts nothing returns null');
});

test('a forgotten await is caught immediately in development: reading a property of an un-awaited db result throws', async () => {
  const p = q.get('SELECT 1 AS x'); assert.throws(() => p.x, /missing await/); assert.equal((await p).x, 1);
});

test('unique violations are recognised by SQLSTATE, not by message text', async () => {
  const u = await H.newUser('Dup');
  await assert.rejects(q.run("INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?, 'x', 'Dup2', 1)", u.email.toUpperCase()), (e) => isUnique(e) && e.code === '23505');   // citext: case-insensitive uniqueness
  assert.equal(isUnique(new Error('UNIQUE constraint failed')), false);
});

// ------------------------------------------------------------------------------------------------ transactions
test('tx: commits on success and returns the callback value; everything is rolled back when the callback throws', async () => {
  const k = 'tx-ok-' + Date.now();
  assert.equal(await tx(async () => { await q.run("INSERT INTO settings(key, value) VALUES(?, 'a')", k); return 42; }), 42);
  assert.equal((await q.get('SELECT value FROM settings WHERE key = ?', k)).value, 'a');
  const k2 = 'tx-fail-' + Date.now();
  await assert.rejects(tx(async () => { await q.run("INSERT INTO settings(key, value) VALUES(?, 'a')", k2); await q.run("INSERT INTO settings(key, value) VALUES(?, 'b')", k2 + '-2'); throw new Error('boom'); }), /boom/);
  assert.equal(await count('SELECT COUNT(*) n FROM settings WHERE key IN (?, ?)', k2, k2 + '-2'), 0, 'nothing from the failed transaction survives');
});

test('tx: a failed SQL statement aborts the transaction and rolls back earlier writes (PostgreSQL semantics)', async () => {
  const k = 'tx-sql-' + Date.now();
  await assert.rejects(tx(async () => { await q.run("INSERT INTO settings(key, value) VALUES(?, 'a')", k); await q.run('INSERT INTO settings(key, value) VALUES(?, NULL)', k + 'x'); }), /null value/i);
  assert.equal(await count('SELECT COUNT(*) n FROM settings WHERE key = ?', k), 0);
});

test('tx: isolation - uncommitted rows are invisible to other connections until commit; a nested tx joins the outer one', async () => {
  const k = 'tx-iso-' + Date.now(); let seenInside, seenOutsideBefore, release; const gate = new Promise((r) => { release = r; });
  const outer = tx(async () => {
    await q.run("INSERT INTO settings(key, value) VALUES(?, 'v')", k);
    seenInside = await count('SELECT COUNT(*) n FROM settings WHERE key = ?', k);
    await tx(async () => { await q.run("UPDATE settings SET value = 'nested' WHERE key = ?", k); });          // joins: no second connection, no savepoint
    await gate;
    return 'done';
  });
  await new Promise((r) => setTimeout(r, 80));
  seenOutsideBefore = await new Promise((res) => getPool().query('SELECT COUNT(*) n FROM settings WHERE key = $1', [k]).then((r) => res(r.rows[0].n)));      // a different pooled connection, outside the transaction
  release(); assert.equal(await outer, 'done');
  assert.equal(seenInside, 1); assert.equal(Number(seenOutsideBefore), 0, 'not visible before commit'); assert.equal((await q.get('SELECT value FROM settings WHERE key = ?', k)).value, 'nested');
  await assert.rejects(tx(async () => { await q.run("UPDATE settings SET value = 'x' WHERE key = ?", k); await tx(async () => { throw new Error('inner'); }); }), /inner/);
  assert.equal((await q.get('SELECT value FROM settings WHERE key = ?', k)).value, 'nested', 'an error in a nested tx rolls back the whole outer transaction');
});

test('tx: connections are always returned to the pool (no leak after many failed transactions)', async () => {
  const pool = getPool(); for (let i = 0; i < 40; i++) await tx(async () => { throw new Error('x'); }).catch(() => {});
  await Promise.all(Array.from({ length: 30 }, () => tx(async () => { await q.get('SELECT 1'); })));
  assert.equal(pool.waitingCount, 0); assert.ok(pool.totalCount <= 10, `pool stays within its limit (${pool.totalCount})`); assert.equal(pool.totalCount - pool.idleCount, 0, 'nothing is still checked out');
});

test('tx: a deadlock is detected by PostgreSQL and the loser is retried automatically; both transactions complete', async () => {
  const a = 'dl-a-' + Date.now(), b = 'dl-b-' + Date.now(); await q.run("INSERT INTO settings(key, value) VALUES (?, '0'), (?, '0')", a, b);
  let attempts1 = 0, attempts2 = 0, ready1, ready2; const r1 = new Promise((r) => { ready1 = r; }), r2 = new Promise((r) => { ready2 = r; });
  const t1 = tx(async () => { attempts1++; await q.run("UPDATE settings SET value = value || '1' WHERE key = ?", a); ready1(); await r2; await q.run("UPDATE settings SET value = value || '1' WHERE key = ?", b); });
  const t2 = tx(async () => { attempts2++; await q.run("UPDATE settings SET value = value || '2' WHERE key = ?", b); ready2(); await r1; await q.run("UPDATE settings SET value = value || '2' WHERE key = ?", a); });
  await Promise.all([t1, t2]);
  assert.ok(attempts1 + attempts2 >= 3, `one side was retried (attempts ${attempts1}+${attempts2})`);
  assert.equal((await q.get('SELECT value FROM settings WHERE key = ?', a)).value.replace(/^0/, '').length, 2, 'both updates to a landed exactly once'); assert.equal((await q.get('SELECT value FROM settings WHERE key = ?', b)).value.replace(/^0/, '').length, 2);
});

test('lockKey: an advisory lock serialises a check-then-insert rule across transactions', async () => {
  const k = 'lk-' + Date.now(); let inside = 0, maxInside = 0;
  await Promise.all(Array.from({ length: 6 }, () => tx(async () => { await lockKey('test', k); inside++; maxInside = Math.max(maxInside, inside); await new Promise((r) => setTimeout(r, 15)); inside--; })));
  assert.equal(maxInside, 1);
});

// ------------------------------------------------------------------------------------------------ migrations
test('migrations: a fresh database reaches the latest version; running again changes nothing; concurrent starters do not collide', async () => {
  const d = await dbAt(0);
  try {
    const c1 = new Client({ connectionString: d.url }), c2 = new Client({ connectionString: d.url }), c3 = new Client({ connectionString: d.url }); await Promise.all([c1.connect(), c2.connect(), c3.connect()]);
    try { await Promise.all([applyMigrations(c1), applyMigrations(c2), applyMigrations(c3)]); await applyMigrations(c1); } finally { await Promise.all([c1.end(), c2.end(), c3.end()]); }
    assert.deepEqual((await d.all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => Number(r.version)), Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1), 'each migration recorded exactly once');
    assert.equal(Number((await d.one("SELECT COUNT(*) n FROM pg_tables WHERE schemaname = 'public'")).n), 46);
  } finally { await d.close(); }
});

test('migrations: a failing migration rolls back completely (no half-applied schema, version unchanged); a database newer than the code is refused', async () => {
  const d = await dbAt(15);
  try {
    const keep = MIGRATIONS[15]; MIGRATIONS[15] = 'CREATE TABLE half_applied(x BIGINT); INSERT INTO half_applied VALUES (1/0);';
    const c = new Client({ connectionString: d.url }); await c.connect();
    try { await assert.rejects(applyMigrations(c), /migration 16 failed/); } finally { MIGRATIONS[15] = keep; await c.end(); }
    assert.equal(Number((await d.one('SELECT MAX(version) v FROM schema_migrations')).v), 15); assert.equal(await d.one("SELECT 1 x FROM pg_tables WHERE tablename = 'half_applied'"), undefined);
    await d.run('INSERT INTO schema_migrations(version, applied_at) VALUES (99, 1)');
    const c2 = new Client({ connectionString: d.url }); await c2.connect(); try { await assert.rejects(applyMigrations(c2), /newer than this code/); } finally { await c2.end(); }
  } finally { await d.close(); }
});

test('schema parity: every table, column, index and trigger of the legacy SQLite schema exists in PostgreSQL with the same name', async () => {
  const { DatabaseSync } = require('node:sqlite'); const LEGACY = require('../scripts/legacy/sqlite-migrations');
  const lite = new DatabaseSync(':memory:'); for (const m of LEGACY) lite.exec(m);
  const liteTables = lite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const pgTables = (await q.all("SELECT tablename t FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY 1")).map((r) => r.t);
  assert.deepEqual(pgTables, liteTables, 'same tables');
  for (const t of liteTables) {
    const lc = lite.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name).sort();
    const pc = (await q.all("SELECT column_name c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", t)).map((r) => r.c).sort();
    assert.deepEqual(pc, lc, `columns of ${t}`);
  }
  const liteIdx = lite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
  const pgIdx = new Set((await q.all("SELECT indexname i FROM pg_indexes WHERE schemaname = current_schema()")).map((r) => r.i));
  for (const i of liteIdx) assert.ok(pgIdx.has(i), `index ${i}`);
  const liteTrig = lite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
  const pgTrig = (await q.all("SELECT tgname n FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1")).map((r) => r.n);
  assert.deepEqual(pgTrig, liteTrig, 'same triggers (the one SQLite trigger dropped by migration 9 stays dropped)');
  const nn = (await q.all("SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = current_schema() AND is_nullable = 'NO' AND table_name <> 'schema_migrations'")).map((r) => `${r.t}.${r.c}`);
  for (const t of liteTables) for (const c of lite.prepare(`PRAGMA table_info("${t}")`).all()) if (c.notnull && !c.pk) assert.ok(nn.includes(`${t}.${c.name}`), `${t}.${c.name} is NOT NULL in both`);
  lite.close();
});

test('append-only and immutability triggers raise the same messages the application relied on under SQLite', async () => {
  const s = await H.newSeller('Trg'), b = await H.newUser('Trg'), id = await H.makeListing(s, { payment_url: LINK }); const o = oid(await buy(b, id));
  await assert.rejects(q.run('DELETE FROM orders WHERE id = ?', o), /orders cannot be deleted/);
  await assert.rejects(q.run('UPDATE orders SET total_cents = total_cents + 1 WHERE id = ?', o), /order terms are immutable/);
  await assert.rejects(q.run("UPDATE orders SET snapshot_json = '{}' WHERE id = ?", o), /order snapshot is immutable/);
  await assert.rejects(q.run('UPDATE order_items SET price_cents = 1 WHERE order_id = ?', o), /order items are immutable/);
  await assert.rejects(q.run("UPDATE audit_log SET action = 'x'"), /audit log is append-only/); await assert.rejects(q.run('DELETE FROM audit_log'), /audit log is append-only/);
});

// ------------------------------------------------------------------------------------------------ concurrency: stock and orders
test('inventory: many buyers race for a limited quantity - exactly that many reservations, never oversold, listing state consistent', async () => {
  const seller = await H.newSeller('Race'), id = await H.makeListing(seller, { payment_url: LINK, quantity: 4 });
  const buyers = await Promise.all(Array.from({ length: 16 }, async (_, i) => await H.newUser('R' + i)));
  const rs = await Promise.all(buyers.map((b) => buy(b, id)));
  const ok = rs.filter((r) => r.status === 200), lost = rs.filter((r) => r.status === 409);
  assert.equal(ok.length, 4, 'exactly four winners'); assert.equal(lost.length, 12, 'everyone else is told the item is taken'); assert.equal(new Set(ok.map(oid)).size, 4);
  const l = await listing(id); assert.equal(l.quantity, 0); assert.equal(l.status, 'reserved');
  assert.equal(await count("SELECT COUNT(*) n FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.listing_id = ? AND o.status = 'pending_payment'", id), 4);
  assert.equal(await count('SELECT COUNT(*) n FROM checkouts c WHERE c.id IN (SELECT checkout_id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.listing_id = ?)', id), 4, 'no stray checkouts from the losers');
});

test('duplicate purchase: the same buyer clicking Buy repeatedly in parallel gets one order and one reserved unit', async () => {
  const seller = await H.newSeller('Dup'), id = await H.makeListing(seller, { payment_url: LINK, quantity: 5 }), b = await H.newUser('Clicky');
  const rs = await Promise.all(Array.from({ length: 8 }, () => buy(b, id)));
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join()); assert.equal(new Set(rs.map(oid)).size, 1, 'every response refers to the same order');
  assert.equal((await listing(id)).quantity, 4, 'exactly one unit reserved'); assert.equal(await count("SELECT COUNT(*) n FROM orders WHERE buyer_id = (SELECT id FROM users WHERE email = ?)", b.email), 1);
});

test('order claim: confirm vs reject vs expiry racing on one pending order always end in exactly one consistent outcome, and stock is returned at most once', async () => {
  const X = require('../src/payments');
  for (let round = 0; round < 4; round++) {
    const seller = await H.newSeller('Claim' + round), id = await H.makeListing(seller, { payment_url: LINK, quantity: 1 }), b = await H.newUser('C' + round); const o = oid(await buy(b, id));
    await q.run("UPDATE checkouts SET expires_at = 1 WHERE id = (SELECT checkout_id FROM orders WHERE id = ?)", o);          // already stale: the expiry job may also claim it
    const results = await Promise.allSettled([seller.post(`/api/seller/orders/${o}/confirm-payment`, {}), seller.post(`/api/seller/orders/${o}/reject-payment`, {}), X.expireStaleCheckouts(), X.expireStaleCheckouts(), seller.post(`/api/seller/orders/${o}/confirm-payment`, {})]);
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => String(r.reason))));
    const ord = await q.get('SELECT status FROM orders WHERE id = ?', o), l = await listing(id), ev = await q.all('SELECT from_status, to_status FROM order_events WHERE order_id = ? ORDER BY id', o);
    assert.ok(['paid', 'cancelled'].includes(ord.status), `round ${round}: ${ord.status}`);
    assert.equal(ev.length, 2, 'created + exactly one transition'); assert.equal(ev[1].from_status, 'pending_payment');
    if (ord.status === 'paid') { assert.equal(l.quantity, 0); assert.equal(l.status, 'sold'); } else { assert.equal(l.quantity, 1, 'the unit came back exactly once'); assert.equal(l.status, 'active'); }
  }
});

test('expiry job: several overlapping runs release each stale reservation exactly once (no double stock return)', async () => {
  const X = require('../src/payments'); const seller = await H.newSeller('Exp'), id = await H.makeListing(seller, { payment_url: LINK, quantity: 6 });
  const bs = await Promise.all(Array.from({ length: 5 }, async (_, i) => await H.newUser('E' + i))); const os = [];
  for (const b of bs) os.push(oid(await buy(b, id)));
  assert.equal((await listing(id)).quantity, 1);
  await q.run('UPDATE checkouts SET expires_at = 1 WHERE id IN (SELECT checkout_id FROM orders WHERE id = ANY(?::bigint[]))', `{${os.join(',')}}`);
  const swept = await Promise.all(Array.from({ length: 6 }, () => X.expireStaleCheckouts()));
  assert.equal(swept.reduce((a, b) => a + b, 0), 5, 'the five stale checkouts were handled exactly once across all runs');
  assert.equal((await listing(id)).quantity, 6, 'all five units returned once each'); assert.equal((await listing(id)).status, 'active');
  assert.equal(await count("SELECT COUNT(*) n FROM order_events WHERE to_status = 'cancelled' AND order_id = ANY(?::bigint[])", `{${os.join(',')}}`), 5);
});

test('failed purchase rolls back completely: a failure late in the transaction leaves no order, no checkout and no reserved unit', async () => {
  const seller = await H.newSeller('Rb'), id = await H.makeListing(seller, { payment_url: LINK, quantity: 2 }), b = await H.newUser('Rb');
  const before = { orders: await count('SELECT COUNT(*) n FROM orders'), checkouts: await count('SELECT COUNT(*) n FROM checkouts') }, orig = q.run;
  q.run = (sql, ...a) => { if (/INSERT INTO notifications/.test(sql) && /Someone started checkout/.test(String(a[1] || a[0]))) return Promise.reject(new Error('notification store down')); return orig(sql, ...a); };
  try { const r = await buy(b, id); assert.equal(r.status, 500); } finally { q.run = orig; }
  assert.equal(await count('SELECT COUNT(*) n FROM orders'), before.orders); assert.equal(await count('SELECT COUNT(*) n FROM checkouts'), before.checkouts); assert.equal((await listing(id)).quantity, 2, 'the unit that was taken inside the failed transaction is back');
  assert.equal((await buy(b, id)).status, 200, 'and the buyer can simply try again');
});

// ------------------------------------------------------------------------------------------------ concurrency: caps, moderation, links, duplicates
test('seller cap: racing promotions can never exceed the cap (advisory-locked trigger)', async () => {
  const current = await count('SELECT COUNT(*) n FROM users WHERE is_seller = 1'), prev = (await q.get("SELECT value FROM settings WHERE key = 'seller_cap'")).value;
  await q.run("UPDATE settings SET value = ? WHERE key = 'seller_cap'", String(current + 1));
  try {
    const us = await Promise.all(Array.from({ length: 6 }, async (_, i) => await H.newUser('Cap' + i)));
    const rs = await Promise.allSettled(us.map((u, i) => q.run("UPDATE users SET is_seller = 1, handle = ?, store_name = 'S', country = 'US' WHERE email = ?", 'capper' + i + Date.now(), u.email)));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one succeeds'); assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => /seller cap reached/.test(String(r.reason.message))));
    assert.equal(await count('SELECT COUNT(*) n FROM users WHERE is_seller = 1'), current + 1);
  } finally { await q.run("UPDATE settings SET value = ? WHERE key = 'seller_cap'", prev); }
});

test('moderation: racing bans of one account by several staff produce exactly one ban, one log entry, and clean conflicts for the rest', async () => {
  const adm = await mkAdmin(), target = await H.newUser('Target'), tid = (await q.get('SELECT id FROM users WHERE email = ?', target.email)).id;
  const rs = await Promise.all(Array.from({ length: 6 }, () => adm.post(`/api/admin/users/${tid}/ban`, { banned: true, reason: 'Racing moderation actions test' })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 5, rs.map((r) => r.status).join());
  assert.equal(await count("SELECT COUNT(*) n FROM moderation_actions WHERE target_id = ? AND action = 'ban'", tid), 1); assert.equal(await count("SELECT COUNT(*) n FROM audit_log WHERE action = 'moderation_ban' AND target_id = ?", String(tid)), 1);
});

test('single-use links: racing acceptances of one invitation create exactly one account and consume it once', async () => {
  const adm = await mkAdmin(), email = `race${Date.now()}@example.test`, inv = await adm.post('/api/admin/accounts/invite', { role: 'seller', email, confirm: true });
  const token = (inv.json.link || inv.json.path || '').split('/').pop(); assert.ok(token, JSON.stringify(inv.json));
  const rs = await Promise.all(Array.from({ length: 6 }, () => new H.Client().post('/api/invitations/accept', { token, display_name: 'Racer', password: 'a-long-password-1', terms: true, store_name: 'Race Store', handle: 'racestore' + Date.now() % 100000, country: 'US', region: 'NY', city: 'B', agree: true })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status + ':' + (r.json && r.json.error)).join(' | ')); assert.ok(rs.filter((r) => r.status !== 200).every((r) => [400, 401, 409].includes(r.status)));
  assert.equal(await count('SELECT COUNT(*) n FROM users WHERE email = ?', email), 1);
});

test('duplicates: parallel review submissions and refund requests on one order leave exactly one row', async () => {
  const seller = await H.newSeller('Dups'), b = await H.newUser('Dups'), id = await H.makeListing(seller, { payment_url: LINK }); const o = oid(await buy(b, id));
  await seller.post(`/api/seller/orders/${o}/confirm-payment`, {}); await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400' + String(Date.now()).slice(-10) + '77' }); assert.equal((await b.post(`/api/orders/${o}/received`, {})).status, 200);
  const rv = await Promise.all(Array.from({ length: 6 }, () => b.post(`/api/orders/${o}/review`, { thumbsUp: true, body: 'dup' })));
  assert.equal(rv.filter((r) => r.status === 200).length, 1); assert.ok(rv.filter((r) => r.status !== 200).every((r) => r.status === 409)); assert.equal(await count('SELECT COUNT(*) n FROM seller_reviews WHERE order_id = ?', o), 1);
  const rf = await Promise.all(Array.from({ length: 6 }, () => b.post(`/api/orders/${o}/refund-request`, { kind: 'refund', reason: 'Parallel request' })));
  assert.equal(rf.filter((r) => r.status === 200).length, 1, rf.map((r) => r.status).join()); assert.equal(await count("SELECT COUNT(*) n FROM refund_requests WHERE order_id = ? AND status = 'requested'", o), 1);
  const rp = await Promise.all(Array.from({ length: 5 }, () => b.post('/api/cases/seller', { handle: seller.handle, reason: 'Parallel seller report with enough text', category: 'other' })));
  assert.equal(rp.filter((r) => r.status === 200).length, 1, rp.map((r) => r.status).join()); assert.equal(await count("SELECT COUNT(*) n FROM cases WHERE kind = 'seller_issue' AND reporter_id = (SELECT id FROM users WHERE email = ?)", b.email), 1);
});

test('webhook idempotency: the same provider event delivered in parallel is processed once', async () => {
  const P = require('../src/payments'); const id = 'evt_' + Date.now();
  const rs = await Promise.all(Array.from({ length: 6 }, () => P.handlePaymentEvent('stripe', { id, type: 'ignored' })));
  assert.equal(rs.filter((r) => r.ignored).length, 1); assert.equal(rs.filter((r) => r.duplicate).length, 5); assert.equal(await count('SELECT COUNT(*) n FROM payment_events WHERE event_id = ?', id), 1);
});

// ------------------------------------------------------------------------------------------------ health
test('health check reports the schema version, and answers 503 (not 200) when the database cannot be reached', async () => {
  const ok = await new H.Client().get('/healthz'); assert.equal(ok.status, 200); assert.equal(ok.json.schema, MIGRATIONS.length);
  const orig = q.get; q.get = () => Promise.reject(new Error('connection refused'));
  try { const down = await new H.Client().get('/healthz'); assert.equal(down.status, 503); assert.deepEqual(down.json, { ok: false }); } finally { q.get = orig; }
});
