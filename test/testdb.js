'use strict';
// Disposable PostgreSQL databases for tests. Every test file gets its own empty database (pp_test_<pid>_<random>) on the server named
// by PAIRPLUG_TEST_PG (an admin connection URL, default postgres://postgres@127.0.0.1:5432/postgres); it is dropped when the file's
// process exits. Safety rails: only databases whose name starts with pp_test_ are ever dropped, and a non-local server is refused
// unless PAIRPLUG_TEST_PG_ALLOW_REMOTE=1. Start a throwaway local server with scripts/pg-test.sh.
//   node test/testdb.js create      prints the new database's connection URL
//   node test/testdb.js drop <name>
//   node test/testdb.js ensure|recreate <pp_sandbox*|pp_demo*|pp_test_*>   create (or drop + create) a named throwaway database; prints its URL
//   node test/testdb.js sweep       drop leftover pp_test_* databases (crashed runs)
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const adminUrl = () => process.env.PAIRPLUG_TEST_PG || 'postgres://postgres@127.0.0.1:5432/postgres';
function assertLocal(u) {
  const host = new URL(u).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]', ''].includes(host) && process.env.PAIRPLUG_TEST_PG_ALLOW_REMOTE !== '1')
    throw new Error(`refusing to create/drop test databases on non-local server "${host}" (set PAIRPLUG_TEST_PG_ALLOW_REMOTE=1 only for a server that holds nothing of value)`);
}
const withDb = (u, name) => { const x = new URL(u); x.pathname = '/' + name; return x.toString(); };
const NAME = /^pp_(test_|sandbox|demo)[a-z0-9_]*$/;      // the only database names this tool will ever create or drop

async function create() {
  const { Client } = require('pg');
  const u = adminUrl(); assertLocal(u);
  const name = `pp_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const c = new Client({ connectionString: u }); await c.connect();
  try { await c.query(`CREATE DATABASE ${name}`); } finally { await c.end(); }
  return { name, url: withDb(u, name) };
}
async function drop(name) {
  if (!NAME.test(name)) throw new Error('refusing to drop a database that is not a pp_test_* test database: ' + name);
  const { Client } = require('pg');
  const u = adminUrl(); assertLocal(u);
  const c = new Client({ connectionString: u }); await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await c.end(); }
}
/** Create (or, with fresh=true, drop and recreate) a NAMED throwaway database; returns its URL. */
async function ensure(name, { fresh = false } = {}) {
  if (!NAME.test(name)) throw new Error('refusing to manage a database that is not named pp_test_*, pp_sandbox* or pp_demo*: ' + name);
  const { Client } = require('pg');
  const u = process.env.PAIRPLUG_SANDBOX_PG || adminUrl(); assertLocal(u);
  const c = new Client({ connectionString: u }); await c.connect();
  try {
    if (fresh) await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await c.query(`CREATE DATABASE ${name}`);
  } finally { await c.end(); }
  return withDb(u, name);
}
async function sweep() {
  const { Client } = require('pg');
  const u = adminUrl(); assertLocal(u);
  const c = new Client({ connectionString: u }); await c.connect();
  try { for (const r of (await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'pp\\_test\\_%'")).rows) { await c.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`); console.log('dropped', r.datname); } }
  finally { await c.end(); }
}

const ensureSync = (name, fresh = false) => execFileSync(process.execPath, [__filename, fresh ? 'recreate' : 'ensure', name], { encoding: 'utf8' }).trim();
const createSync = () => JSON.parse(execFileSync(process.execPath, [__filename, 'create'], { encoding: 'utf8' }).trim());
const dropSync = (name) => { try { execFileSync(process.execPath, [__filename, 'drop', name], { stdio: 'ignore' }); } catch { /* sweep later */ } };
module.exports = { createSync, dropSync, ensureSync, adminUrl, NAME };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  (async () => {
    if (cmd === 'create') console.log(JSON.stringify(await create()));
    else if (cmd === 'drop') await drop(arg);
    else if (cmd === 'ensure') console.log(await ensure(arg));
    else if (cmd === 'recreate') console.log(await ensure(arg, { fresh: true }));
    else if (cmd === 'sweep') await sweep();
    else { console.error('usage: node test/testdb.js create | drop <name> | sweep'); process.exit(2); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
