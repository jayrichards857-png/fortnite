'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { q, now } = require('./db');
const { HttpError } = require('./util');

// Images stay on the local filesystem in this release (PAIRPLUG_UPLOADS); the directory must be on persistent storage in production.
// Where the bytes go is decided in src/storage.js: local disk (default), S3-compatible object storage (required on Vercel), or nowhere.
// Nothing is created on disk unless the local-disk driver is the one in use.
const storage = require('./storage');
if (storage.driver().kind === 'fs') fs.mkdirSync(config.uploadDir, { recursive: true });

const MAX_SIDE = 8000, MAX_PIXELS = 40e6;

// We trust file *contents*, not the client-declared type: check magic bytes and pick the extension ourselves.
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** Read pixel dimensions from the file header without decoding the image (no image library, no decompression). null = unreadable. */
function dimensions(buf, ext = sniff(buf)) {
  try {
    if (ext === 'png') return buf.length >= 24 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i++; continue; }
        if ((m >= 0xc0 && m <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (ext === 'webp') {
      const fmt = buf.subarray(12, 16).toString();
      if (fmt === 'VP8 ' && buf.length >= 30) return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L' && buf.length >= 25) return { w: 1 + (((buf[22] & 0x3f) << 8) | buf[21]), h: 1 + (((buf[24] & 0xf) << 10) | (buf[23] << 2) | ((buf[22] & 0xc0) >> 6)) };
      if (fmt === 'VP8X' && buf.length >= 30) return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
  } catch { /* fall through */ }
  return null;
}

async function saveUpload(userId, buf) {
  if (storage.driver().kind === 'none') throw new HttpError(503, 'Photo uploads are unavailable: this deployment has no durable image storage configured (set the S3_* variables, see docs/VERCEL.md).');
  if (!buf || !buf.length) throw new HttpError(400, 'Empty upload');
  if (buf.length > config.limits.imageBytes) throw new HttpError(413, `Image is larger than ${Math.round(config.limits.imageBytes / 1048576)} MB`);
  const ext = sniff(buf);
  if (!ext) throw new HttpError(415, 'Only JPEG, PNG or WebP images are allowed');
  const d = dimensions(buf, ext);
  if (!d || !(d.w > 0 && d.h > 0)) throw new HttpError(415, 'That image could not be read. Try exporting it again as JPEG or PNG.');
  if (d.w > MAX_SIDE || d.h > MAX_SIDE || d.w * d.h > MAX_PIXELS) throw new HttpError(413, `Image dimensions are too large (max ${MAX_SIDE}px per side).`);
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  try { await storage.driver().put(file, buf, storage.MIME[ext]); }
  catch (e) { console.error('image storage failed:', e.message); throw new HttpError(503, 'Photo storage is temporarily unavailable. Please try again in a moment.'); }
  try { await q.run('INSERT INTO uploads(file, user_id, created_at) VALUES(?,?,?)', file, userId, now()); }
  catch (e) { await storage.driver().del(file).catch(() => {}); throw e; }     // never leave an object that no record knows about
  return file;
}

/** Only filenames this user actually uploaded may be attached to a listing/dispute/storefront. */
async function ownedUploads(userId, files) {
  const out = [];
  for (const f of files) {
    if (typeof f !== 'string' || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f)) throw new HttpError(400, 'Invalid image reference');
    if (!await q.get('SELECT 1 x FROM uploads WHERE file = ? AND user_id = ?', f, userId)) throw new HttpError(403, 'Image not found in your uploads');
    out.push(f);
  }
  return out;
}

/** Dimensions of an already-stored upload (re-read from storage, so the caller can't lie about them). */
async function storedDimensions(file) {
  try { const b = await storage.driver().get(file); return b ? dimensions(b) : null; } catch { return null; }
}

/** Is any record still pointing at this file? Order snapshots, evidence, listings and storefronts all count. */
async function isReferenced(file) {
  const like = `%${file}%`;
  return Boolean(
    await q.get('SELECT 1 x FROM listing_images WHERE file = ?', file) || await q.get('SELECT 1 x FROM order_items WHERE image = ?', file) ||
    await q.get('SELECT 1 x FROM dispute_evidence WHERE image = ?', file) || await q.get('SELECT 1 x FROM case_events WHERE image = ?', file) ||
    await q.get('SELECT 1 x FROM storefronts WHERE draft_json ILIKE ? OR published_json ILIKE ?', like, like) ||
    await q.get('SELECT 1 x FROM orders WHERE snapshot_json ILIKE ?', like));
}
/** Delete an uploaded file ONLY if nothing references it any more. Never throws. */
async function removeIfUnreferenced(file) {
  try {
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(file) || await isReferenced(file)) return false;
    await storage.driver().del(file);
    await q.run('DELETE FROM uploads WHERE file = ?', file);
    return true;
  } catch { return false; }
}
/** Housekeeping: uploads that were never attached to anything and are older than the grace period. */
async function cleanupOrphanUploads(graceSeconds = 24 * 3600) {
  let n = 0;
  for (const u of await q.all('SELECT file FROM uploads WHERE created_at < ?', now() - graceSeconds)) if (await removeIfUnreferenced(u.file)) n++;
  return n;
}
module.exports = { saveUpload, ownedUploads, sniff, dimensions, storedDimensions, isReferenced, removeIfUnreferenced, cleanupOrphanUploads };
