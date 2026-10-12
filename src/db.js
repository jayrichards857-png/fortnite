'use strict';
// PostgreSQL data-access layer (node-postgres `pg`, connection pool, no ORM).
//
//   await q.get(sql, ...params)     first row or undefined
//   await q.all(sql, ...params)     array of rows
//   await q.run(sql, ...params)     { changes, rows }            (changes = rows affected)
//   await q.insert(sql, ...params)  inserts and returns the new row's `id` (appends RETURNING id)
//   await tx(async () => { ... })   one transaction; q.* calls inside it use the transaction's connection automatically
//
// SQL is written with `?` placeholders (converted to $1..$n here) so call sites read the same as before the migration.
// Money is integer cents, times are epoch seconds, flags are 0/1 — all BIGINT; node-postgres returns BIGINT/NUMERIC as strings
// by default, so the parsers below turn them into JS numbers (every value is far below 2^53).
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(20, (v) => Number(v));       // int8
types.setTypeParser(1700, (v) => Number(v));     // numeric

// ---- migrations --------------------------------------------------------------------------------------------------------------
// src/migrations/NN.sql, applied in order, each in its own transaction, recorded in schema_migrations. Append-only: never edit an
// applied migration, add the next number. Versions 1-16 are the 1:1 port of the original SQLite migrations.
const MIGRATION_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS = fs.readdirSync(MIGRATION_DIR).filter((f) => /^\d+\.sql$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  .map((f, i) => {
    if (parseInt(f, 10) !== i + 1) throw new Error(`migration numbering must be contiguous, found ${f} at position ${i + 1}`);
    return fs.readFileSync(path.join(MIGRATION_DIR, f), 'utf8');
  });
const MIGRATION_LOCK = 727401;                    // pg advisory lock id: one instance migrates at a time

// ---- pool --------------------------------------------------------------------------------------------------------------------
let pool = null;
function getPool() {
  if (pool) return pool;
  if (!config.db.url) throw new Error('DATABASE_URL is not set. PairPlug now runs on PostgreSQL: set DATABASE_URL=postgres://user:pass@host:5432/dbname (see docs/DEPLOYMENT.md).');
  pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: config.db.idleTimeoutMs,
    connectionTimeoutMillis: config.db.connectTimeoutMs,
    statement_timeout: config.db.statementTimeoutMs,
    application_name: 'pairplug',
    ssl: config.db.ssl,
  });
  pool.on('error', (e) => console.error('postgres pool error (idle client):', e.message));   // an idle connection dropped; the pool replaces it
  return pool;
}

// `?` -> `$n`, skipping string literals, quoted identifiers and comments. Cached per SQL text.
const converted = new Map();
function toPg(sql) {
  let out = converted.get(sql);
  if (out !== undefined) return out;
  let n = 0, i = 0, res = '';
  while (i < sql.length) {
    const c = sql[i], d = sql[i + 1];
    if (c === "'" || c === '"') {                                  // literal / identifier (doubled quote = escaped quote)
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; }
      res += sql.slice(i, j + 1); i = j + 1;
    } else if (c === '-' && d === '-') { const j = sql.indexOf('\n', i); const e = j < 0 ? sql.length : j; res += sql.slice(i, e); i = e; }
    else if (c === '/' && d === '*') { const j = sql.indexOf('*/', i + 2); const e = j < 0 ? sql.length : j + 2; res += sql.slice(i, e); i = e; }
    else if (c === '?') { const m = /^\?(\d+)/.exec(sql.slice(i, i + 6)); if (m) { res += '$' + m[1]; i += m[0].length; } else { res += '$' + (++n); i++; } }   // ?  and  ?NNN
    else { res += c; i++; }
  }
  if (converted.size > 2000) converted.clear();
  converted.set(sql, res);
  return res;
}

// ---- transaction context -----------------------------------------------------------------------------------------------------
const als = new AsyncLocalStorage();               // { client } while inside tx()

// In development/tests a forgotten `await` on a db call throws as soon as the un-awaited result is used.
const GUARD = process.env.NODE_ENV !== 'production';
const guarded = (p, what) => !GUARD ? p : new Proxy(p, {
  get(t, k) {
    if (k === 'then' || k === 'catch' || k === 'finally') return t[k].bind(t);
    if (typeof k === 'symbol') return Reflect.get(t, k);
    throw new Error(`missing await on db call (${what}): read .${String(k)} of an un-awaited result`);
  },
});

async function query(sql, params) {
  const store = als.getStore();
  const target = store ? store.client : getPool();
  try { return await target.query(toPg(sql), params); }
  catch (e) { if (e && typeof e === 'object' && !e.sql) e.sql = sql.replace(/\s+/g, ' ').slice(0, 400); throw e; }       // diagnostics only; parameters are never attached
}
const clean = (p) => p.map((v) => (v === undefined ? null : v));
const q = {
  get: (sql, ...p) => guarded(query(sql, clean(p)).then((r) => r.rows[0]), 'q.get'),
  all: (sql, ...p) => guarded(query(sql, clean(p)).then((r) => r.rows), 'q.all'),
  run: (sql, ...p) => guarded(query(sql, clean(p)).then((r) => ({ changes: r.rowCount, rows: r.rows })), 'q.run'),
  insert: (sql, ...p) => guarded(query(sql + ' RETURNING id', clean(p)).then((r) => (r.rows[0] ? r.rows[0].id : null)), 'q.insert'),
};

const RETRYABLE = new Set(['40001', '40P01']);     // serialization failure, deadlock detected
/**
 * Run fn in one transaction (READ COMMITTED). Every q.* call made inside fn - including from helper functions it calls - uses this
 * transaction. A nested tx() joins the outer one. Throwing rolls everything back. Deadlocks are retried (bounded); fn must therefore
 * only do database work plus idempotent in-memory work.
 */
async function tx(fn, { retries = 2 } = {}) {
  if (als.getStore()) return fn();
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const r = await als.run({ client }, fn);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }   // connection is broken: do not return it to the pool
      if (RETRYABLE.has(e.code) && attempt < retries) continue;
      throw e;
    } finally { client.release(discard); }
  }
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Transaction-scoped advisory lock for check-then-insert rules that have no single row to lock (e.g. "one open report per reporter and
 * seller"). Concurrent callers with the same (namespace, ids) queue until the holder commits or rolls back. Call inside tx().
 */
const lockKey = (ns, ...ids) => q.run('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ns, ids.join(':'));

// ---- startup -----------------------------------------------------------------------------------------------------------------
let readyPromise = null;
/** Connect and bring the schema up to date. Safe to call repeatedly and from several instances at once (advisory lock). */
function ready() {
  if (!readyPromise) readyPromise = migrate().catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}
async function migrate() {
  const client = await getPool().connect();
  try { await applyMigrations(client); } finally { client.release(); }
}
/** Bring the database behind `client` (a connected pg Client) up to the latest schema. Serialised by an advisory lock; one transaction per migration. */
async function applyMigrations(client) {
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const have = Number((await client.query('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations')).rows[0].v);
    if (have > MIGRATIONS.length) throw new Error(`database schema is version ${have}, newer than this code (${MIGRATIONS.length}). Refusing to start: deploy the newer release or restore a matching backup.`);
    for (let v = have; v < MIGRATIONS.length; v++) {
      try {
        await client.query('BEGIN');
        await client.query(MIGRATIONS[v]);
        await client.query('INSERT INTO schema_migrations(version, applied_at) VALUES($1,$2)', [v + 1, now()]);
        await client.query('COMMIT');
      } catch (e) { try { await client.query('ROLLBACK'); } catch {} e.message = `migration ${v + 1} failed: ${e.message}`; throw e; }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); } catch {}
  }
}
async function schemaVersion() { return Number((await q.get('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations')).v); }
async function close() { if (pool) { const p = pool; pool = null; readyPromise = null; await p.end(); } }

// ---- settings ----------------------------------------------------------------------------------------------------------------
async function getSettings() {
  const out = { ...config.defaults };
  for (const r of await q.all('SELECT key, value FROM settings')) if (r.key in out) out[r.key] = Number(r.value);
  return out;
}
async function setSetting(key, value) {
  await q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

/** True for a PostgreSQL unique-constraint violation (SQLSTATE 23505): the database refused a duplicate. */
const isUnique = (e) => Boolean(e) && e.code === '23505';

module.exports = { q, tx, now, lockKey, isUnique, applyMigrations, ready, close, schemaVersion, getSettings, setSetting, getPool, toPg, MIGRATIONS };
