'use strict';
// One-off, repeatable import of a PairPlug SQLite database (from the node:sqlite era) into PostgreSQL.
//
//   node scripts/sqlite-to-pg.js --source <sqlite file> --target <postgres url> [--uploads <dir>] [--report <file.json>]
//                                [--dry-run] [--replace --confirm-erase <target database name>]
//
// SAFETY
//   * The source is NEVER modified or even opened in place: the tool copies it (plus any -wal/-shm) into a private temp directory and reads
//     the copy. The source's SHA-256, size and mtime are recorded before and after and must be identical (reported as sourceUntouched).
//     Best practice is still to point it at a backup snapshot, not at the live file of a running app.
//   * An older SQLite schema (user_version < 16) is upgraded on the COPY with the frozen legacy migrations; a newer one is refused.
//   * The target must be EMPTY (freshly migrated, no application rows). Anything else is refused. --replace erases the target's application
//     rows first, and only if you also pass --confirm-erase with the exact target database name. Re-running against an empty database always
//     yields the same result (ids, timestamps, statuses, quantities and upload metadata are copied verbatim).
//   * Everything happens in ONE transaction: any error or failed check rolls the whole import back and leaves the target empty. --dry-run runs
//     the complete import and verification and then rolls back (the empty schema is still created: use a scratch database).
//   * Triggers that enforce business rules for NEW rows (seller/moderator caps, review eligibility, ...) are disabled only while copying
//     and re-enabled before commit, because history written under older rules must be preserved as it was; the invariants are re-checked afterwards.
//
// VERIFICATION (the import fails unless all hold): same table set; per-table row counts; per-table order-independent content checksum
// (every column of every row); per-status order counts and money sums; ledger sums; inventory totals; foreign keys (enforced by PostgreSQL
// during the copy); sequences positioned after the highest id so new rows can never collide.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const config = require('../src/config');
const { applyMigrations, MIGRATIONS } = require('../src/db');         // also installs the int8/numeric -> Number type parsers
const LEGACY = require('./legacy/sqlite-migrations');
const { describe, dbName } = require('./lib/pg');

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const fingerprint = (f) => { const st = fs.statSync(f); return { sha256: sha256File(f), bytes: st.size, mtimeMs: st.mtimeMs }; };
const SKIP_TABLES = new Set(['schema_migrations']);                    // PostgreSQL's own migration bookkeeping is never imported
const UPSERT_TABLES = new Set(['settings']);                           // migrations seed default settings; the source's values win

/** Copy the SQLite file (and any WAL/SHM) to a private directory so the original is never opened. */
function privateCopy(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-import-')); fs.chmodSync(dir, 0o700);
  const copy = path.join(dir, 'source.db');
  fs.copyFileSync(source, copy);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(source + ext)) fs.copyFileSync(source + ext, copy + ext);
  return { dir, copy };
}

function sqliteTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
}

/** Canonical text of a value for checksums: identical for the SQLite and PostgreSQL representation of the same datum. */
function canon(v) {
  if (v === null || v === undefined) return 'N';
  if (typeof v === 'number' || typeof v === 'bigint') return 'n:' + String(v);
  if (typeof v === 'string') return 's:' + v.length + ':' + v;
  return 'x:' + JSON.stringify(v);
}
class RowSum {                                           // order-independent multiset hash: count + sum of 64-bit row hashes
  constructor() { this.n = 0; this.sum = 0n; }
  add(cols, row) {
    const h = crypto.createHash('sha256');
    for (const c of cols) h.update(c + '=' + canon(row[c]) + '\u0001');
    this.sum = (this.sum + BigInt('0x' + h.digest('hex').slice(0, 16))) & 0xffffffffffffffffn; this.n++;
  }
  toString() { return `${this.n}:${this.sum.toString(16)}`; }
}

function convert(value, pgType, where) {
  if (value === null || value === undefined) return null;
  if (pgType === 'bigint') {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') { if (!Number.isInteger(value)) throw new Error(`${where}: ${value} is not a whole number but the column is an integer`); return value; }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
    throw new Error(`${where}: cannot store ${JSON.stringify(String(value).slice(0, 40))} in an integer column`);
  }
  if (pgType === 'double precision') { const n = Number(value); if (!Number.isFinite(n)) throw new Error(`${where}: not a number`); return n; }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${where}: unsupported value type ${typeof value}`);
}

function topoOrder(tables, fks) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const [child, parent] of fks) if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  const done = [], remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining].filter((t) => [...deps.get(t)].every((d) => !remaining.has(d))).sort();
    if (!ready.length) throw new Error('foreign keys form a cycle among: ' + [...remaining].join(', '));
    for (const t of ready) { done.push(t); remaining.delete(t); }
  }
  return done;
}

const AGGREGATES = [
  ['users', 'SELECT COUNT(*) n, COALESCE(SUM(is_seller),0) sellers, COALESCE(SUM(is_admin),0) admins, COALESCE(SUM(is_moderator),0) moderators, COALESCE(SUM(banned),0) banned FROM users'],
  ['orders_by_status', 'SELECT status, COUNT(*) n, COALESCE(SUM(subtotal_cents),0) subtotal, COALESCE(SUM(shipping_cents),0) shipping, COALESCE(SUM(total_cents),0) total, COALESCE(SUM(refunded_cents),0) refunded FROM orders GROUP BY status ORDER BY status'],
  ['order_events_by_status', 'SELECT to_status, COUNT(*) n FROM order_events GROUP BY to_status ORDER BY to_status'],
  ['ledger_by_kind', 'SELECT kind, COUNT(*) n, COALESCE(SUM(amount_cents),0) total FROM ledger GROUP BY kind ORDER BY kind'],
  ['listings_by_status', 'SELECT status, COUNT(*) n, COALESCE(SUM(quantity),0) units, COALESCE(SUM(price_cents),0) price FROM listings GROUP BY status ORDER BY status'],
  ['uploads', 'SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM uploads'],
];

async function importSqlite({ source, target, uploadDir, replace = false, confirmErase, dryRun = false, log = () => {} }) {
  if (!source || !fs.existsSync(source)) throw new Error('source SQLite file not found: ' + source);
  if (!target) throw new Error('--target (a postgres:// URL) is required');
  const started = Date.now();
  const before = fingerprint(source);
  const report = { tool: 'sqlite-to-pg', startedAt: new Date(started).toISOString(), source: { file: path.basename(source), ...before }, target: describe(target), dryRun, sourceSchemaVersion: null, upgradedCopyFrom: null, tables: {}, aggregates: {}, warnings: [], checks: [] };
  const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) }); if (!ok) throw new Error(`verification failed: ${name}${detail ? ' — ' + detail : ''}`); };

  const { dir, copy } = privateCopy(source);
  let src, pg;
  try {
    src = new DatabaseSync(copy);
    const integrity = src.prepare('PRAGMA integrity_check').get().integrity_check;
    check('source passes PRAGMA integrity_check', integrity === 'ok', integrity);
    let version = src.prepare('PRAGMA user_version').get().user_version;
    report.sourceSchemaVersion = version;
    if (version > LEGACY.length) throw new Error(`source schema v${version} is newer than this tool understands (v${LEGACY.length})`);
    if (version < 1) throw new Error('source has no PairPlug schema (user_version 0)');
    if (version < LEGACY.length) {                                   // upgrade the PRIVATE COPY with the frozen additive migrations
      report.upgradedCopyFrom = version; log(`source is schema v${version}; upgrading the private copy to v${LEGACY.length}`);
      for (; version < LEGACY.length; version++) { src.exec('BEGIN'); try { src.exec(LEGACY[version]); src.exec(`PRAGMA user_version = ${version + 1}`); src.exec('COMMIT'); } catch (e) { src.exec('ROLLBACK'); throw e; } }
    }

    pg = new Client({ connectionString: target, ssl: config.db.ssl }); await pg.connect();
    await applyMigrations(pg);                                       // exactly the production migration runner
    const pgv = Number((await pg.query('SELECT MAX(version) v FROM schema_migrations')).rows[0].v);
    check('target schema is current', pgv === MIGRATIONS.length, `target v${pgv}, code v${MIGRATIONS.length}`);

    const pgTables = (await pg.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((r) => r.tablename).filter((t) => !SKIP_TABLES.has(t));
    const liteTables = sqliteTables(src);
    // Tables introduced in PostgreSQL after the frozen SQLite schema (v16) have no SQLite counterpart: they are created empty by the migrations, never copied.
    const PG_ONLY_TABLES = new Set(['review_photos', 'rate_limits', 'job_leases']);   // migrations 17-18: photo reviews, shared rate limits, job leases
    const missingInPg = liteTables.filter((t) => !pgTables.includes(t)), missingInLite = pgTables.filter((t) => !liteTables.includes(t) && !PG_ONLY_TABLES.has(t));
    check('same set of tables on both sides', !missingInPg.length && !missingInLite.length, `only in SQLite: [${missingInPg}] only in PostgreSQL: [${missingInLite}]`);

    const cols = {};     // table -> [{name, type}]
    for (const r of (await pg.query("SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position")).rows)
      (cols[r.table_name] ||= []).push({ name: r.column_name, type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type });
    const fks = (await pg.query("SELECT c.conrelid::regclass::text child, c.confrelid::regclass::text parent FROM pg_constraint c WHERE c.contype = 'f'")).rows.map((r) => [r.child.replace(/"/g, ''), r.parent.replace(/"/g, '')]);
    const order = topoOrder(pgTables, fks);

    // --- target must be empty (or --replace with explicit confirmation)
    const nonEmpty = [];
    for (const t of pgTables) { const n = Number((await pg.query(`SELECT COUNT(*) n FROM ${qi(t)}`)).rows[0].n); if (n && !(UPSERT_TABLES.has(t) && n <= 2)) nonEmpty.push(`${t}(${n})`); }
    if (nonEmpty.length) {
      if (!replace) throw new Error(`target is not empty: ${nonEmpty.join(', ')}. Use a new empty database, or --replace --confirm-erase ${dbName(target)}`);
      if (confirmErase !== dbName(target)) throw new Error(`--replace needs --confirm-erase ${dbName(target)} (the exact target database name) because it ERASES the target's application data`);
      log(`erasing application data in ${describe(target)}`);
    }

    await pg.query('BEGIN');
    try {
      await pg.query("SET LOCAL statement_timeout = 0");
      for (const t of pgTables) await pg.query(`ALTER TABLE ${qi(t)} DISABLE TRIGGER USER`);       // history is copied as it was written; rules are re-checked below
      if (nonEmpty.length) await pg.query(`TRUNCATE ${pgTables.map(qi).join(', ')} RESTART IDENTITY`);
      for (const t of order) {
        if (PG_ONLY_TABLES.has(t) && !liteTables.includes(t)) { log(`  ${t}: new in PostgreSQL, left empty`); continue; }
        const litecols = src.prepare(`PRAGMA table_info(${qi(t)})`).all().map((c) => c.name);
        const pgcols = cols[t].map((c) => c.name);
        const unknown = litecols.filter((c) => !pgcols.includes(c));
        check(`columns of ${t} exist in PostgreSQL`, !unknown.length, `SQLite-only columns: ${unknown}`);
        const use = cols[t].filter((c) => litecols.includes(c.name));
        const total = src.prepare(`SELECT COUNT(*) n FROM ${qi(t)}`).get().n;
        const sumLite = new RowSum(); const batch = Math.max(1, Math.min(500, Math.floor(30000 / use.length)));
        let last = 0, copied = 0;
        for (;;) {
          const rows = src.prepare(`SELECT rowid AS __rid, * FROM ${qi(t)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(last, batch);
          if (!rows.length) break;
          const params = []; const tuples = [];
          for (const r of rows) {
            last = Number(r.__rid);
            const conv = {};
            for (const c of use) conv[c.name] = convert(r[c.name], c.type, `${t}.${c.name} (rowid ${r.__rid})`);
            sumLite.add(use.map((c) => c.name).sort(), conv);
            tuples.push('(' + use.map((c) => { params.push(conv[c.name]); return '$' + params.length; }).join(',') + ')');
          }
          const conflict = UPSERT_TABLES.has(t) ? ` ON CONFLICT (key) DO UPDATE SET ${use.filter((c) => c.name !== 'key').map((c) => `${qi(c.name)} = EXCLUDED.${qi(c.name)}`).join(', ')}` : '';
          await pg.query(`INSERT INTO ${qi(t)}(${use.map((c) => qi(c.name)).join(',')}) VALUES ${tuples.join(',')}${conflict}`, params);
          copied += rows.length;
        }
        // sequence for the identity column: after the highest id ever used (SQLite AUTOINCREMENT never reuses ids)
        let seqNote = null;
        if (cols[t].some((c) => c.name === 'id')) {
          const seq = (await pg.query('SELECT pg_get_serial_sequence($1, $2) s', [qi(t), 'id'])).rows[0].s;
          if (seq) {
            const maxId = Number((await pg.query(`SELECT COALESCE(MAX(id), 0) m FROM ${qi(t)}`)).rows[0].m);
            const lite = src.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(t); const next = Math.max(maxId, lite ? Number(lite.seq) : 0);
            if (next > 0) await pg.query('SELECT setval($1, $2, true)', [seq, next]); seqNote = next;
          }
        }
        // verify this table: counts + content checksum of what PostgreSQL now holds
        const sumPg = new RowSum(); const sortedCols = use.map((c) => c.name).sort();
        const stream = await pg.query(`SELECT ${use.map((c) => qi(c.name)).join(',')} FROM ${qi(t)}`);
        for (const row of stream.rows) sumPg.add(sortedCols, row);
        const pgCount = stream.rows.length;
        check(`${t}: row count`, pgCount === total && copied === total, `SQLite ${total}, copied ${copied}, PostgreSQL ${pgCount}`);
        check(`${t}: content checksum`, String(sumPg) === String(sumLite), `SQLite ${sumLite} vs PostgreSQL ${sumPg}`);
        report.tables[t] = { rows: total, checksum: String(sumLite), nextId: seqNote };
        log(`  ${t}: ${total} rows`);
      }
      for (const t of pgTables) await pg.query(`ALTER TABLE ${qi(t)} ENABLE TRIGGER USER`);

      // aggregate invariants (money, statuses, inventory) computed by the same SQL on both sides
      for (const [name, sql] of AGGREGATES) {
        const a = src.prepare(sql).all().map((r) => ({ ...r })), b = (await pg.query(sql)).rows.map((r) => ({ ...r }));
        check(`aggregate ${name} identical`, JSON.stringify(a) === JSON.stringify(b), `SQLite ${JSON.stringify(a)} vs PostgreSQL ${JSON.stringify(b)}`);
        report.aggregates[name] = b;
      }
      // rules the disabled triggers normally enforce for new rows: report (do not block) if legacy data violates them
      const w = async (msg, sql) => { const n = Number((await pg.query(sql)).rows[0].n); if (n) report.warnings.push(`${msg}: ${n}`); };
      await w('reviews whose order is not a completed order of that buyer/seller', "SELECT COUNT(*) n FROM seller_reviews r WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = r.order_id AND o.buyer_id = r.buyer_id AND o.seller_id = r.seller_id AND o.status IN ('delivered','released'))");
      await w('sellers above the seller cap (nothing is deleted; new sellers stay blocked)', "SELECT GREATEST(0, (SELECT COUNT(*) FROM users WHERE is_seller = 1) - COALESCE((SELECT CAST(value AS BIGINT) FROM settings WHERE key = 'seller_cap'), 3)) n");
      await w('moderators above the moderator cap', "SELECT GREATEST(0, (SELECT COUNT(*) FROM users WHERE is_moderator = 1) - COALESCE((SELECT CAST(value AS BIGINT) FROM settings WHERE key = 'moderator_cap'), 5)) n");
      // the schema's own guarantees still work after the import
      await pg.query('SAVEPOINT guard');
      let blocked = false; try { await pg.query('DELETE FROM audit_log WHERE FALSE'); await pg.query('UPDATE audit_log SET id = id WHERE id = (SELECT MIN(id) FROM audit_log)'); } catch (e) { blocked = /append-only/.test(e.message); }
      await pg.query('ROLLBACK TO SAVEPOINT guard');
      const auditRows = report.tables.audit_log ? report.tables.audit_log.rows : 0;
      check('append-only triggers are active again after the import', auditRows === 0 || blocked);

      if (uploadDir) {
        const files = new Set((await pg.query('SELECT file FROM uploads')).rows.map((r) => r.file));
        const missing = [...files].filter((f) => !fs.existsSync(path.join(uploadDir, f)));
        report.uploads = { rows: files.size, missingFiles: missing.length };
        if (missing.length) report.warnings.push(`${missing.length} of ${files.size} uploaded image files are not present in ${uploadDir} (copy the uploads folder alongside the database)`);
      }
      if (dryRun) { await pg.query('ROLLBACK'); report.committed = false; } else { await pg.query('COMMIT'); report.committed = true; }
    } catch (e) { try { await pg.query('ROLLBACK'); } catch {} throw e; }
  } finally {
    try { src && src.close(); } catch {}
    try { pg && (await pg.end()); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const after = fingerprint(source);
  report.sourceUntouched = before.sha256 === after.sha256 && before.bytes === after.bytes && before.mtimeMs === after.mtimeMs;
  if (!report.sourceUntouched) throw new Error('the source file changed while it was being imported (is the app still writing to it?)');
  report.durationMs = Date.now() - started;
  return report;
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; }, flag = (n) => a.includes(n);
  const target = opt('--target') || process.env.IMPORT_TARGET_URL;
  if (flag('--help') || !opt('--source') || !target) { console.error('usage: node scripts/sqlite-to-pg.js --source <sqlite file> --target <postgres url> [--uploads dir] [--report file.json] [--dry-run] [--replace --confirm-erase <dbname>]\n(the target URL may also come from IMPORT_TARGET_URL; credentials are never printed)'); process.exit(flag('--help') ? 0 : 2); }
  importSqlite({ source: opt('--source'), target, uploadDir: opt('--uploads'), replace: flag('--replace'), confirmErase: opt('--confirm-erase'), dryRun: flag('--dry-run'), log: (m) => console.log(m) }).then((r) => {
    if (opt('--report')) fs.writeFileSync(opt('--report'), JSON.stringify(r, null, 2), { mode: 0o600 });
    const rows = Object.values(r.tables).reduce((s, t) => s + t.rows, 0);
    console.log(`\n${r.dryRun ? 'DRY RUN (rolled back)' : 'IMPORTED'}: ${Object.keys(r.tables).length} tables, ${rows} rows into ${r.target}. ${r.checks.length} checks passed. Source untouched: ${r.sourceUntouched}.`);
    for (const w of r.warnings) console.log('WARNING:', w);
  }).catch((e) => { console.error('IMPORT FAILED (nothing was committed):', e.message); process.exit(1); });
}
module.exports = { importSqlite, RowSum, canon };
