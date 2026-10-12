'use strict';
// Consistent online backup of the PostgreSQL database + uploaded photos. Safe to run while the app is serving traffic.
//   node scripts/backup.js [backupDir]        (default: ./backups, or $BACKUP_DIR; database = $DATABASE_URL)
// - The database is dumped with pg_dump (custom format) inside ONE exported REPEATABLE READ snapshot, so the dump and the manifest's
//   row counts describe exactly the same instant even while orders are being written. No locks block the app.
// - A manifest (<dump>.json) records schema version, per-table row counts and the dump's SHA-256; restore refuses a dump that does not
//   match it. The dump is also read back with `pg_restore --list` before the backup is declared good.
// - Uploaded photos have random, never-reused names, so they are copied incrementally (existing files are skipped).
// - Keeps the newest $BACKUP_KEEP (default 14) dumps. Backups hold personal data: files 0600, directories 0700.
// Restore: node scripts/restore.js <dump> (see that script; stop the app first).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const config = require('../src/config');
const { describe, runTool } = require('./lib/pg');

const PHOTO = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Row count of every table in the public schema, plus the schema version, read inside the given (already open) transaction. */
async function snapshotFacts(client) {
  const version = Number((await client.query('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations')).rows[0].v);
  const names = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((r) => r.tablename);
  const tables = {};
  for (const t of names) tables[t] = Number((await client.query(`SELECT COUNT(*) n FROM "${t}"`)).rows[0].n);
  return { version, tables };
}

async function backup({ databaseUrl = config.db.url, uploadDir = config.uploadDir, dir = process.env.BACKUP_DIR || path.resolve(__dirname, '..', 'backups'), keep = Number(process.env.BACKUP_KEEP || 14), stamp } = {}) {
  for (const d of [dir, path.join(dir, 'db'), path.join(dir, 'uploads')]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }   // backups hold personal data: owner-only
  const name = `pairplug-${stamp || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.dump`;
  const target = path.join(dir, 'db', name);
  if (fs.existsSync(target)) throw new Error('backup target already exists: ' + target);
  const client = new Client({ connectionString: databaseUrl, ssl: config.db.ssl });
  await client.connect();
  let facts;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() s')).rows[0].s;
    facts = await snapshotFacts(client);
    try { runTool('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, `--file=${target}`], databaseUrl); }
    catch (e) { fs.rmSync(target, { force: true }); throw e; }
    await client.query('COMMIT');
  } finally { await client.end(); }
  fs.chmodSync(target, 0o600);
  // verify the archive is readable before trusting it
  let toc;
  try { toc = runTool('pg_restore', ['--list', target], databaseUrl); } catch (e) { fs.rmSync(target, { force: true }); throw new Error('backup failed verification: ' + e.message); }
  if (!/TABLE DATA/.test(toc)) { fs.rmSync(target, { force: true }); throw new Error('backup failed verification: the archive contains no table data'); }
  const manifest = { format: 1, createdAt: new Date().toISOString(), source: describe(databaseUrl), schemaVersion: facts.version, tables: facts.tables, sha256: sha256(target), bytes: fs.statSync(target).size };
  fs.writeFileSync(target + '.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
  let copied = 0;
  if (fs.existsSync(uploadDir)) for (const f of fs.readdirSync(uploadDir)) {
    const to = path.join(dir, 'uploads', f);
    if (!PHOTO.test(f) || fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(uploadDir, f), to); fs.chmodSync(to, 0o600); copied++;
  }
  const dumps = fs.readdirSync(path.join(dir, 'db')).filter((f) => f.endsWith('.dump')).sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - keep))) for (const f of [old, old + '.json']) fs.rmSync(path.join(dir, 'db', f), { force: true });
  return { database: target, manifest, integrity: 'ok', photosCopied: copied, snapshotsKept: Math.min(dumps.length, keep) };
}

if (require.main === module) {
  backup({ dir: process.argv[2] || undefined }).then((r) => {
    const rows = Object.values(r.manifest.tables).reduce((a, b) => a + b, 0);
    console.log(`OK  db=${r.database}  schema=v${r.manifest.schemaVersion}  tables=${Object.keys(r.manifest.tables).length}  rows=${rows}  new photos=${r.photosCopied}  snapshots kept=${r.snapshotsKept}`);
  }).catch((e) => { console.error('BACKUP FAILED:', e.message); process.exit(1); });
}
module.exports = { backup, snapshotFacts, sha256 };
