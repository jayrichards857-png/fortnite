'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { q, now } = require('./db');
const { HttpError } = require('./util');

// We trust file *contents*, not the client-declared type: check magic bytes and pick the extension ourselves.
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

function saveUpload(userId, buf) {
  if (!buf || !buf.length) throw new HttpError(400, 'Empty upload');
  if (buf.length > config.limits.imageBytes) throw new HttpError(413, 'Image is larger than 5 MB');
  const ext = sniff(buf);
  if (!ext) throw new HttpError(415, 'Only JPEG, PNG or WebP images are allowed');
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.uploadDir, file), buf);
  q.run('INSERT INTO uploads(file, user_id, created_at) VALUES(?,?,?)', file, userId, now());
  return file;
}

/** Only filenames this user actually uploaded may be attached to a listing/dispute. */
function ownedUploads(userId, files) {
  const out = [];
  for (const f of files) {
    if (typeof f !== 'string' || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f)) throw new HttpError(400, 'Invalid image reference');
    if (!q.get('SELECT 1 x FROM uploads WHERE file = ? AND user_id = ?', f, userId)) throw new HttpError(403, 'Image not found in your uploads');
    out.push(f);
  }
  return out;
}
module.exports = { saveUpload, ownedUploads, sniff };
