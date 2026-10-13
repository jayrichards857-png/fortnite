'use strict';
// Deliberate, explicit schema migration for the ONE database named by the current environment. It never runs on application start-up.
//
//   npm run migrate
//       READ-ONLY. Shows which database it reached (host + name only, never credentials), what is in it (table count, and row counts of a
//       few core tables if they exist), the schema version, and which migrations would run. Changes nothing.
//   npm run migrate -- --apply --confirm-host <host>
//       Applies ALL pending migrations in order (one transaction each, serialised by an advisory lock). It refuses unless:
//         * PAIRPLUG_DB_LABEL is set (production | preview | ...), so the operator states which environment this is,
//         * --confirm-host equals the host the dry run printed (you read it, you retype it: a wrong/old URL cannot be applied by accident),
//         * the host is a DIRECT connection (not a "-pooler" host: session locks do not work through a transaction pooler),
//         * the database is empty or already managed by this tool (tables without migration history are never touched).
// Connection: DATABASE_URL_UNPOOLED when set, else DATABASE_URL. Neon: use the branch's DIRECT connection string.
// A URL cannot tell us which Neon branch it belongs to; that is why the host must be confirmed against the branch's page in the Neon console.
const { Client } = require('pg');
const config = require('../src/config');
const { applyMigrations, schemaVersionOn, MIGRATIONS } = require('../src/db');

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };
const LOCAL = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;

(async () => {
  const url = config.db.urlDirect || config.db.url;
  if (!url) fail('Set DATABASE_URL_UNPOOLED (the direct connection string) for the environment you mean to migrate.');
  let u; try { u = new URL(url); } catch { fail('The database URL is not a valid URL (value not shown).'); }
  const apply = process.argv.includes('--apply'), label = String(process.env.PAIRPLUG_DB_LABEL || '').trim();
  const pooled = /-pooler\b/i.test(u.hostname);
  console.log(`target: host=${u.hostname} database=${u.pathname.replace(/^\//, '')} (${config.db.urlDirect ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL'})  label=${label || '(PAIRPLUG_DB_LABEL not set)'}`);
  if (pooled) console.log('WARNING: this is a POOLED host. Migrations need the DIRECT connection string.');
  if (apply) {                                               // every refusal that needs no connection happens before connecting
    if (pooled) fail('Refusing to apply through a pooled host. Use the branch\'s direct (non-pooler) connection string in DATABASE_URL_UNPOOLED.');
    if (!label) fail('Refusing to apply: set PAIRPLUG_DB_LABEL (e.g. production or preview) to state which environment this database is.');
    if (arg('--confirm-host') !== u.hostname) fail(`Refusing to apply: re-run with --confirm-host ${u.hostname}  (only after checking that host belongs to the intended Neon branch).`);
  }

  const c = new Client({ connectionString: url, ssl: config.db.ssl, application_name: 'pairplug-migrate' });
  await c.connect();
  try {
    const have = await schemaVersionOn(c);
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename).filter((t) => t !== 'schema_migrations');
    console.log(`schema version: v${have} (this release needs v${MIGRATIONS.length}); tables in public schema (excluding schema_migrations): ${tables.length}`);
    if (tables.length) {                                      // counts only: never row contents
      const counts = [];
      for (const t of ['users', 'listings', 'orders', 'seller_reviews', 'uploads'].filter((t) => tables.includes(t))) counts.push(`${t}=${(await c.query(`SELECT COUNT(*) n FROM "${t}"`)).rows[0].n}`);
      if (counts.length) console.log(`existing data (row counts): ${counts.join(', ')}`);
    }
    if (have > MIGRATIONS.length) fail('The database is NEWER than this code. Deploy the newer release instead.', 1);
    if (have === MIGRATIONS.length) return console.log('Up to date. Nothing to do.');
    if (have === 0 && tables.length) fail(`This database already has ${tables.length} table(s) but no migration history. It was not created by this tool, so nothing will be applied. Check you are on the right Neon branch/database.`, 1);
    console.log(`Pending migrations, in order: ${Array.from({ length: MIGRATIONS.length - have }, (_, i) => have + i + 1).join(', ')}`);
    if (!apply) return console.log('DRY RUN: nothing was changed. To apply, re-run with: --apply --confirm-host <the host printed above> (and PAIRPLUG_DB_LABEL set).');
    await applyMigrations(c);
    console.log(`Applied. Schema is now v${await schemaVersionOn(c)}.`);
  } finally { await c.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
