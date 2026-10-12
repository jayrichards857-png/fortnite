'use strict';
// Restore a backup made by scripts/backup.js into PostgreSQL. STOP THE APP FIRST.
//   node scripts/restore.js <dump file> [--uploads <dir>] [--photos <backup uploads dir>] [--force]      (target = $DATABASE_URL)
// Safety rules:
//   * the dump must match its manifest (SHA-256) and be readable by pg_restore; a schema version newer than this code is refused;
//   * a target database that already contains tables is NEVER touched without --force, and --force first takes a full backup of it
//     into <backup dir>/pre-restore/ (the way back if the restore was a mistake);
//   * the restore runs in ONE transaction (all or nothing) and is verified table by table against the manifest's row counts;
//   * photos are copied back without overwriting existing files.
// Tip: the safest restore is into a NEW empty database (create it, point DATABASE_URL at it, restore, switch the app over).
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const config = require('../src/config');
const { describe, runTool } = require('./lib/pg');
const { backup, snapshotFacts, sha256 } = require('./backup');

const PHOTO = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

async function restore({ dump, databaseUrl = config.db.url, uploadDir, photosDir, force = false, supportedVersion, preRestoreDir }) {
  if (!dump || !fs.existsSync(dump)) throw new Error('backup not found: ' + dump);
  if (!fs.existsSync(dump + '.json')) throw new Error(`manifest ${dump}.json is missing: this dump was not made by scripts/backup.js, so it cannot be verified`);
  const manifest = JSON.parse(fs.readFileSync(dump + '.json', 'utf8'));
  if (sha256(dump) !== manifest.sha256) throw new Error('backup failed its integrity check: the file does not match its manifest (corrupted or modified)');
  try { runTool('pg_restore', ['--list', dump], databaseUrl); } catch (e) { throw new Error('backup failed its integrity check: ' + e.message); }
  if (manifest.schemaVersion > supportedVersion) throw new Error(`backup schema v${manifest.schemaVersion} is newer than this code (v${supportedVersion}); restore with a matching release`);
  const probe = new Client({ connectionString: databaseUrl, ssl: config.db.ssl }); await probe.connect();
  let preRestore = null, nonEmpty;
  try { nonEmpty = Number((await probe.query("SELECT COUNT(*) n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n) > 0; } finally { await probe.end(); }
  if (nonEmpty) {
    if (!force) throw new Error(`${describe(databaseUrl)} already contains tables; refusing to overwrite without --force (or restore into a new empty database)`);
    const pre = await backup({ databaseUrl, uploadDir: path.join(path.dirname(dump), '__none__'), dir: preRestoreDir || path.join(path.dirname(path.dirname(path.resolve(dump))), 'pre-restore'), stamp: 'pre-restore-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) });
    preRestore = pre.database;
  }
  runTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', ...(nonEmpty ? ['--clean', '--if-exists'] : []), `--dbname=${require('./lib/pg').pgEnv(databaseUrl).PGDATABASE}`, dump], databaseUrl);
  // verify: every table's row count equals the manifest
  const check = new Client({ connectionString: databaseUrl, ssl: config.db.ssl }); await check.connect();
  let facts;
  try { await check.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); facts = await snapshotFacts(check); await check.query('COMMIT'); } finally { await check.end(); }
  const bad = Object.entries(manifest.tables).filter(([t, n]) => facts.tables[t] !== n).map(([t, n]) => `${t}: expected ${n}, found ${facts.tables[t]}`);
  if (bad.length) throw new Error('restored database does not match the backup: ' + bad.join('; '));
  if (facts.version !== manifest.schemaVersion) throw new Error(`restored schema version ${facts.version} does not match the backup (${manifest.schemaVersion})`);
  let photos = 0;
  if (photosDir && uploadDir && fs.existsSync(photosDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    for (const f of fs.readdirSync(photosDir)) { const to = path.join(uploadDir, f); if (PHOTO.test(f) && !fs.existsSync(to)) { fs.copyFileSync(path.join(photosDir, f), to); photos++; } }
  }
  return { schemaVersion: facts.version, integrity: 'ok', tables: Object.keys(facts.tables).length, rows: Object.values(facts.tables).reduce((a, b) => a + b, 0), preRestore, photosRestored: photos };
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const { MIGRATIONS } = require('../src/db');
  const dump = a.find((x) => !x.startsWith('--') && ![opt('--uploads'), opt('--photos')].includes(x));
  const photosDir = opt('--photos') || (dump && path.join(path.dirname(path.dirname(path.resolve(dump))), 'uploads'));
  restore({ dump, uploadDir: opt('--uploads') || config.uploadDir, photosDir, force: a.includes('--force'), supportedVersion: MIGRATIONS.length }).then((r) => {
    console.log(`RESTORED into ${describe(config.db.url)}  schema v${r.schemaVersion}  tables=${r.tables} rows=${r.rows}  verified against the backup manifest  photos restored=${r.photosRestored}${r.preRestore ? `\nprevious database saved at ${r.preRestore}` : ''}`);
  }).catch((e) => { console.error('RESTORE FAILED:', e.message); process.exit(1); });
}
module.exports = { restore };
