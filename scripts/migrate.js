'use strict';
// Deliberate, explicit schema migration for the database named by the CURRENT environment.
//   npm run migrate                 read-only: shows the database's schema version, this release's version and what would run
//   npm run migrate -- --apply      applies the pending migrations (one transaction each, serialised by an advisory lock)
// Uses DATABASE_URL_UNPOOLED when set (a direct connection: session locks do not work through a transaction pooler), else DATABASE_URL.
// It never creates, seeds or deletes data other than what the migration files themselves do. Run it per environment (preview / production).
const { Client } = require('pg');
const config = require('../src/config');
const { applyMigrations, schemaVersionOn, MIGRATIONS } = require('../src/db');

(async () => {
  const url = config.db.urlDirect || config.db.url;
  if (!url) { console.error('Set DATABASE_URL (or DATABASE_URL_UNPOOLED) for the environment you mean to migrate.'); process.exit(2); }
  const u = new URL(url);
  const c = new Client({ connectionString: url, ssl: config.db.ssl, application_name: 'pairplug-migrate' });
  await c.connect();
  try {
    const have = await schemaVersionOn(c);
    console.log(`database ${u.hostname}${u.pathname}: schema v${have}; this release: v${MIGRATIONS.length}`);
    if (have > MIGRATIONS.length) { console.error('The database is NEWER than this code. Deploy the newer release instead.'); process.exit(1); }
    if (have === MIGRATIONS.length) return console.log('Up to date. Nothing to do.');
    console.log(`Pending: ${Array.from({ length: MIGRATIONS.length - have }, (_, i) => have + i + 1).join(', ')}`);
    if (!process.argv.includes('--apply')) return console.log('Dry run. Re-run with --apply to apply them to the database above.');
    await applyMigrations(c);
    console.log(`Applied. Schema is now v${await schemaVersionOn(c)}.`);
  } finally { await c.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
