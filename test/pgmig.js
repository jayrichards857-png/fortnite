'use strict';
// Helpers for migration tests: build a PostgreSQL database at an OLD schema version (by applying the real src/migrations files),
// put realistic old-format rows in it, then upgrade it through the application's own migration runner in a child process.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const testdb = require('./testdb');
const fs = require('node:fs');
// Read the migration files directly: requiring src/db here would load src/config before a test has set DATABASE_URL.
const MDIR = path.join(__dirname, '..', 'src', 'migrations');
const MIGRATIONS = fs.readdirSync(MDIR).filter((f) => /^\d+\.sql$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map((f) => fs.readFileSync(path.join(MDIR, f), 'utf8'));

const ROOT = path.resolve(__dirname, '..');

/** A throw-away database migrated to exactly `version` (1..N). Returns { url, name, run(sql, ...params), all(sql, ...params), one, close() }. */
async function dbAt(version) {
  const created = testdb.createSync();
  const c = new Client({ connectionString: created.url }); await c.connect();
  c.connection.stream.unref();                 // a forgotten close() must never keep the test process alive
  await c.query('CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)');
  for (let i = 0; i < version; i++) {
    await c.query('BEGIN'); await c.query(MIGRATIONS[i]);
    await c.query('INSERT INTO schema_migrations(version, applied_at) VALUES($1, 1700000000)', [i + 1]);
    await c.query('COMMIT');
  }
  const conv = (sql) => { let n = 0; return sql.replace(/\?/g, () => '$' + (++n)); };
  let at = version;
  const db = {
    url: created.url, name: created.name,
    /** Apply the next pending migration through the same transaction + bookkeeping the app uses. */
    async applyNext() { await c.query('BEGIN'); await c.query(MIGRATIONS[at]); await c.query('INSERT INTO schema_migrations(version, applied_at) VALUES($1, 1700000000)', [at + 1]); await c.query('COMMIT'); at += 1; },
    run: async (sql, ...p) => (p.length ? await c.query(conv(sql), p) : await c.query(sql)),     // no params => simple protocol (multi-statement allowed)
    all: async (sql, ...p) => (await c.query(conv(sql), p)).rows,
    one: async (sql, ...p) => (await c.query(conv(sql), p)).rows[0],
    async close() { try { await c.end(); } catch {} testdb.dropSync(created.name); },
  };
  return db;
}

/**
 * Run `body` (JS source, may use top-level await via an async wrapper; has `q`, `tx`, `db`) in a fresh node process whose application
 * database is `url`. The application's own startup (db.ready()) runs first, so every pending migration is applied exactly as in production.
 * `body` must console.log one JSON line; it is parsed and returned.
 */
function upgradeAndRun(url, body, env = {}) {
  const src = `
    const db = require('./src/db'); const { q, tx } = db;
    (async () => { await db.ready(); const out = await (async () => { ${body} })(); console.log(JSON.stringify(out)); await db.close(); })()
      .catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ['-e', src], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop());
}
module.exports = { dbAt, upgradeAndRun, MIGRATIONS };
