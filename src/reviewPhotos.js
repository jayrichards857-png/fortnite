'use strict';
// Photos on reviews. Stored as bytea in PostgreSQL (migration 17), never on the local disk, so they persist on serverless hosts such as Vercel.
//   * Content is trusted, not the client: magic bytes + readable dimensions are checked (src/images.js); the stored type comes from the bytes.
//   * No client filename is ever kept or used. Photos are addressed by numeric id and served with nosniff + a locked-down CSP.
//   * At most MAX_PHOTOS per review: enforced here (rejected with 422, never silently truncated) and by a database trigger.
//   * A photo is public only while it is 'published' AND its review is published; the uploader and staff can always see it.
const { q, now } = require('./db');
const { HttpError } = require('./util');
const { rateLimit } = require('./auth');
const { sniff, dimensions } = require('./images');
const { audit } = require('./audit');

const MAX_PHOTOS = 3, MAX_BYTES = 4 * 1024 * 1024, MAX_SIDE = 8000, MAX_PIXELS = 40e6, MAX_PENDING = 6;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Validate and store one uploaded image as a pending photo owned by the user. Returns its id. */
async function upload(user, buf) {
  rateLimit(`rphoto:${user.id}`, 30, 3600);
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'Send the image as the request body.');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'Review photos can be at most 4 MB each.');
  const ext = sniff(buf);
  if (!ext) throw new HttpError(415, 'Only JPEG, PNG or WebP photos are allowed.');
  const d = dimensions(buf, ext);
  if (!d || !(d.w > 0 && d.h > 0)) throw new HttpError(415, 'That photo could not be read. Try exporting it again as JPEG or PNG.');
  if (d.w > MAX_SIDE || d.h > MAX_SIDE || d.w * d.h > MAX_PIXELS) throw new HttpError(413, `Photo dimensions are too large (max ${MAX_SIDE}px per side).`);
  if (Number((await q.get('SELECT COUNT(*) n FROM review_photos WHERE user_id = ? AND review_id IS NULL AND status = ?', user.id, 'pending')).n) >= MAX_PENDING)
    throw new HttpError(429, 'You have several photos waiting to be attached. Post your review or remove some first.');
  return Number(await q.insert('INSERT INTO review_photos(user_id, mime, bytes, width, height, data, created_at) VALUES(?,?,?,?,?,?,?)', user.id, MIME[ext], buf.length, d.w, d.h, buf, now()));
}

/** Parse the client's list of photo ids. More than MAX_PHOTOS is an error, not a silent cut. */
function ids(raw) {
  let list = raw;
  if (typeof list === 'string') { try { list = JSON.parse(list || '[]'); } catch { throw new HttpError(400, 'Invalid photo list.'); } }
  if (list == null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, 'Invalid photo list.');
  const out = [...new Set(list.map((v) => Number(v)))];
  if (out.some((n) => !Number.isInteger(n) || n < 1)) throw new HttpError(400, 'Invalid photo reference.');
  if (out.length > MAX_PHOTOS) throw new HttpError(422, 'Please fix the highlighted fields.', { photos: `You can attach at most ${MAX_PHOTOS} photos to a review.` });
  return out;
}

/** Make the review's photo set exactly `want` (inside the caller's transaction, review row already locked). */
async function setPhotos(user, reviewId, want) {
  const have = await q.all("SELECT id FROM review_photos WHERE review_id = ? AND status <> 'removed'", reviewId), haveIds = have.map((p) => Number(p.id));
  for (const id of haveIds) if (!want.includes(id)) await q.run("UPDATE review_photos SET status = 'removed', removed_by = ?, removed_at = ? WHERE id = ?", user.id, now(), id);
  for (const id of want) {
    if (haveIds.includes(id)) continue;
    const r = await q.run("UPDATE review_photos SET review_id = ?, status = 'published' WHERE id = ? AND user_id = ? AND review_id IS NULL AND status = 'pending'", reviewId, id, user.id);
    if (!r.changes) throw new HttpError(422, 'Please fix the highlighted fields.', { photos: 'One of the photos is not available any more. Remove it and add it again.' });
  }
  return want.length;
}
const forReview = async (reviewId) => (await q.all("SELECT id FROM review_photos WHERE review_id = ? AND status = 'published' ORDER BY id", reviewId)).map((p) => Number(p.id));
const forReviews = async (list) => {
  const out = new Map(); if (!list.length) return out;
  for (const p of await q.all("SELECT id, review_id FROM review_photos WHERE review_id = ANY(?) AND status = 'published' ORDER BY id", list)) (out.get(Number(p.review_id)) || out.set(Number(p.review_id), []).get(Number(p.review_id))).push(Number(p.id));
  return out;
};

/** The image bytes, if this viewer may see them. */
async function visible(viewer, id) {
  const p = await q.get('SELECT p.*, r.status review_status FROM review_photos p LEFT JOIN seller_reviews r ON r.id = p.review_id WHERE p.id = ?', Number(id));
  if (!p) return null;
  const staff = viewer && (viewer.is_admin || viewer.is_moderator), own = viewer && viewer.id === Number(p.user_id);
  if (staff || (own && p.status !== 'removed')) return p;
  return p.status === 'published' && p.review_status === 'published' ? p : null;
}

/** Staff: remove one photo from a published review without touching the review text. Recorded in review_events and the audit log. */
async function staffRemove(actor, photoId, reason) {
  if (!(actor && (actor.is_admin || actor.is_moderator))) throw new HttpError(403, 'Moderator access required');
  const why = String(reason || '').trim();
  if (why.length < 5 || why.length > 1000) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'A reason of 5 to 1000 characters is required (it is recorded).' });
  const p = await q.get('SELECT * FROM review_photos WHERE id = ?', Number(photoId));
  if (!p || !p.review_id) throw new HttpError(404, 'Photo not found');
  if (p.status === 'removed') throw new HttpError(409, 'This photo was already removed.');
  await q.run("UPDATE review_photos SET status = 'removed', removed_by = ?, removed_at = ? WHERE id = ?", actor.id, now(), p.id);
  await q.run('INSERT INTO review_events(review_id, actor_id, actor_role, kind, detail, created_at) VALUES(?,?,?,?,?,?)', p.review_id, actor.id, actor.is_admin ? 'admin' : 'moderator', 'photo_removed', JSON.stringify({ photo: Number(p.id), reason: why }), now());
  await audit(actor, 'review_photo_removed', { type: 'review', id: Number(p.review_id), detail: { photo: Number(p.id), reason: why } });
}
module.exports = { MAX_PHOTOS, upload, ids, setPhotos, forReview, forReviews, visible, staffRemove };
