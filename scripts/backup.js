'use strict';
// Consistent online backup of the SQLite database + uploaded photos. Safe to run while the app is serving traffic.
//   node scripts/backup.js [backupDir]        (default: ./backups, or $BACKUP_DIR)
// - The DB is copied with `VACUUM INTO`, which produces a transactionally-consistent snapshot even in WAL mode.
// - Uploaded photos have random, never-reused names, so they are copied incrementally (existing files are skipped).
// - Keeps the newest $BACKUP_KEEP (default 14) database snapshots.
// Restore: node scripts/restore.js <snapshot.db> --force   (see that script; stop the app first).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');

function backup({ dbFile = config.dbFile, uploadDir = config.uploadDir, dir = process.env.BACKUP_DIR || path.resolve(__dirname, '..', 'backups'), keep = Number(process.env.BACKUP_KEEP || 14), stamp } = {}) {
  for (const d of [dir, path.join(dir, 'db'), path.join(dir, 'uploads')]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }   // backups hold personal data: owner-only
  const name = `pairplug-${stamp || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.db`;
  const target = path.join(dir, 'db', name);
  if (fs.existsSync(target)) throw new Error('backup target already exists: ' + target);
  const src = new DatabaseSync(dbFile);
  try { src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { src.close(); }
  fs.chmodSync(target, 0o600);
  // verify the snapshot is a healthy database before trusting it
  const snap = new DatabaseSync(target, { readOnly: true });
  const check = snap.prepare('PRAGMA integrity_check').get().integrity_check; snap.close();
  if (check !== 'ok') { fs.rmSync(target); throw new Error('backup failed integrity check: ' + check); }
  let copied = 0;
  if (fs.existsSync(uploadDir)) for (const f of fs.readdirSync(uploadDir)) {
    const to = path.join(dir, 'uploads', f);
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f) || fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(uploadDir, f), to); fs.chmodSync(to, 0o600); copied++;
  }
  const snaps = fs.readdirSync(path.join(dir, 'db')).filter((f) => f.endsWith('.db')).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - keep))) fs.rmSync(path.join(dir, 'db', old));
  return { database: target, integrity: check, photosCopied: copied, snapshotsKept: Math.min(snaps.length, keep) };
}

if (require.main === module) {
  try { const r = backup({ dir: process.argv[2] || undefined }); console.log(`OK  db=${r.database}  integrity=${r.integrity}  new photos=${r.photosCopied}  snapshots kept=${r.snapshotsKept}`); }
  catch (e) { console.error('BACKUP FAILED:', e.message); process.exit(1); }
}
module.exports = { backup };
