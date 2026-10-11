'use strict';
// Restore a backup made by scripts/backup.js. STOP THE APP FIRST.
//   node scripts/restore.js <snapshot.db> [--db <target.db>] [--uploads <dir>] [--photos <backup uploads dir>] [--force]
// Safety rules:
//   * the snapshot must pass PRAGMA integrity_check and have a schema version this code can run (not newer than the code);
//   * an existing target database is NEVER overwritten without --force, and is first copied to <target>.pre-restore-<timestamp>;
//   * stale -wal/-shm files next to the target are removed (they belong to the database being replaced);
//   * photos are copied back without overwriting existing files.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function restore({ snapshot, dbFile, uploadDir, photosDir, force = false, supportedVersion }) {
  if (!snapshot || !fs.existsSync(snapshot)) throw new Error('snapshot not found: ' + snapshot);
  const snap = new DatabaseSync(snapshot, { readOnly: true });
  let version, integrity;
  try { integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check; version = snap.prepare('PRAGMA user_version').get().user_version; } finally { snap.close(); }
  if (integrity !== 'ok') throw new Error('snapshot failed integrity check: ' + integrity);
  if (version > supportedVersion) throw new Error(`snapshot schema v${version} is newer than this code (v${supportedVersion}); restore with a matching release`);
  let preRestore = null;
  if (fs.existsSync(dbFile)) {
    if (!force) throw new Error(`${dbFile} already exists; refusing to overwrite without --force`);
    preRestore = `${dbFile}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(dbFile, preRestore); fs.chmodSync(preRestore, 0o600);
  }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.copyFileSync(snapshot, dbFile); fs.chmodSync(dbFile, 0o600);
  const check = new DatabaseSync(dbFile, { readOnly: true });
  const ok = check.prepare('PRAGMA integrity_check').get().integrity_check; check.close();
  if (ok !== 'ok') throw new Error('restored database failed integrity check: ' + ok);
  let photos = 0;
  if (photosDir && uploadDir && fs.existsSync(photosDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    for (const f of fs.readdirSync(photosDir)) { const to = path.join(uploadDir, f); if (/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f) && !fs.existsSync(to)) { fs.copyFileSync(path.join(photosDir, f), to); photos++; } }
  }
  return { schemaVersion: version, integrity: ok, preRestore, photosRestored: photos };
}

if (require.main === module) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const config = require('../src/config'); const { MIGRATIONS } = require('../src/db');
  const snapshot = a.find((x) => !x.startsWith('--') && ![opt('--db'), opt('--uploads'), opt('--photos')].includes(x));
  const dbFile = opt('--db') || config.dbFile;
  const photosDir = opt('--photos') || (snapshot && path.join(path.dirname(path.dirname(path.resolve(snapshot))), 'uploads'));
  try {
    const r = restore({ snapshot, dbFile, uploadDir: opt('--uploads') || config.uploadDir, photosDir, force: a.includes('--force'), supportedVersion: MIGRATIONS.length });
    console.log(`RESTORED ${dbFile}  schema v${r.schemaVersion}  integrity=${r.integrity}  photos restored=${r.photosRestored}${r.preRestore ? `\nprevious database kept at ${r.preRestore}` : ''}`);
  } catch (e) { console.error('RESTORE FAILED:', e.message); process.exit(1); }
}
module.exports = { restore };
