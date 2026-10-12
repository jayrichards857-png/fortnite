'use strict';
// Shared helpers for the PostgreSQL command-line tools (backup, restore, import). Credentials are passed to pg_dump/pg_restore
// through PG* environment variables, never on the command line (where `ps` would show them), and are never printed.
const { spawnSync } = require('node:child_process');

function parseUrl(url) {
  if (!url) throw new Error('DATABASE_URL is not set (postgres://user:pass@host:5432/dbname)');
  let u; try { u = new URL(url); } catch { throw new Error('DATABASE_URL is not a valid postgres:// URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
  return u;
}
/** PG* variables equivalent to a connection URL (host, port, user, password, database, sslmode). */
function pgEnv(url) {
  const u = parseUrl(url);
  const env = { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username || ''), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode'); if (ssl) env.PGSSLMODE = ssl;
  else if (['1', 'true', 'require'].includes(String(process.env.DATABASE_SSL || '').toLowerCase())) env.PGSSLMODE = 'require';
  if (process.env.DATABASE_SSL_CA) env.PGSSLROOTCERT = process.env.DATABASE_SSL_CA;
  return env;
}
/** user@host:port/db with no password: safe to print. */
function describe(url) { const u = parseUrl(url); return `${decodeURIComponent(u.username || '')}@${u.hostname}:${u.port || 5432}/${decodeURIComponent(u.pathname.replace(/^\//, ''))}`; }
const dbName = (url) => decodeURIComponent(parseUrl(url).pathname.replace(/^\//, ''));
const withDb = (url, name) => { const u = parseUrl(url); u.pathname = '/' + name; return u.toString(); };

/** Run a PostgreSQL client tool; throws with the tool's own stderr (which never contains the password). */
function runTool(bin, args, url, { input, timeoutMs = 30 * 60 * 1000 } = {}) {
  const exe = process.env[`PG_${bin.toUpperCase().replace(/-/g, '_')}`] || bin;
  const r = spawnSync(exe, args, { env: { ...process.env, ...pgEnv(url) }, encoding: 'utf8', input, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) { if (r.error.code === 'ENOENT') throw new Error(`${bin} not found. Install the PostgreSQL client tools (version 16 or newer) or set PG_${bin.toUpperCase()} to its path.`); throw r.error; }
  if (r.status !== 0) throw new Error(`${bin} failed (exit ${r.status}): ${String(r.stderr || '').trim().slice(0, 800)}`);
  return r.stdout;
}
module.exports = { parseUrl, pgEnv, describe, dbName, withDb, runTool };
