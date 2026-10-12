'use strict';
// Seller thumbs-up reviews, tied to real PairPlug orders.
//   * Only the BUYER of an order can review it, only once the order reached 'delivered'/'released' (the buyer marks external orders received; tracking alone is never treated as delivery),
//     one review per order (UNIQUE), enforced in this module, by DB triggers, and by transactions.
//   * "Order-linked review" is deliberately not "verified purchase": external payments are seller-confirmed and PairPlug does not independently verify them.
//   * Moderators can only HIDE or RESTORE (with a recorded reason). They cannot edit text or the thumbs-up, and every change is in the append-only review_events log + audit_log.
//   * Counts are shown as raw counts (thumbs-up, written reviews, reviews); there is no average or score that could imply more certainty than a handful of votes carries.
const { q, tx, now } = require('./db');
const { HttpError, clean, esc, date } = require('./util');
const { rateLimit } = require('./auth');
const { audit } = require('./audit');

const COMPLETE = ['delivered', 'released'];
const MAX_BODY = 1000;

function input({ thumbsUp, body }) {
  const t = thumbsUp === true || thumbsUp === 1 || thumbsUp === '1' || thumbsUp === 'on' ? 1 : 0;
  const text = clean(body, MAX_BODY + 1) || null;
  if (text && text.length > MAX_BODY) throw new HttpError(422, 'Please fix the highlighted fields.', { body: `Keep your review under ${MAX_BODY} characters.` });
  if (!t && !text) throw new HttpError(422, 'Please fix the highlighted fields.', { body: 'Give a thumbs-up, write a few words, or both.' });
  return { t, text };
}
const event = (reviewId, actor, role, kind, detail) =>
  q.run('INSERT INTO review_events(review_id, actor_id, actor_role, kind, detail, created_at) VALUES(?,?,?,?,?,?)', reviewId, actor.id, role, kind, detail ? JSON.stringify(detail).slice(0, 1500) : null, now());
const forOrder = (orderId) => q.get('SELECT * FROM seller_reviews WHERE order_id = ?', Number(orderId));
const staffRole = (u) => (u.is_admin ? 'admin' : 'moderator');

/** The order must be the caller's own purchase. Anything else is a 404, so order numbers of others are never confirmed. */
function ownOrder(user, orderId) {
  const o = q.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', Number(orderId), user.id);
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.seller_id === user.id) throw new HttpError(403, "You can't review your own store.");
  return o;
}

function submit(user, orderId, data) {
  rateLimit(`review:${user.id}`, 20, 3600);
  const { t, text } = input(data);
  return tx(() => {
    const o = ownOrder(user, orderId);
    if (!COMPLETE.includes(o.status)) throw new HttpError(409, 'You can review a seller after you have marked the order received.');
    const cur = forOrder(o.id);
    if (cur && cur.status !== 'removed') throw new HttpError(409, 'You have already reviewed this order. You can edit or remove your review.');
    if (cur) {                                                                              // the buyer removed it earlier and is writing it again: same row, never a second review
      q.run("UPDATE seller_reviews SET thumbs_up = ?, body = ?, status = 'published', edited_at = ? WHERE id = ?", t, text, now(), cur.id);
      event(cur.id, user, 'buyer', 'reinstated', { thumbs_up: t, hasText: Boolean(text) });
      return cur.id;
    }
    let id;
    try { id = Number(q.run('INSERT INTO seller_reviews(order_id, buyer_id, seller_id, thumbs_up, body, created_at) VALUES(?,?,?,?,?,?)', o.id, user.id, o.seller_id, t, text, now()).lastInsertRowid); }
    catch (e) { if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'You have already reviewed this order.'); throw e; }
    event(id, user, 'buyer', 'created', { thumbs_up: t, hasText: Boolean(text) });
    return id;
  });
}
function edit(user, orderId, data) {
  rateLimit(`review:${user.id}`, 20, 3600);
  const { t, text } = input(data);
  return tx(() => {
    const o = ownOrder(user, orderId), cur = forOrder(o.id);
    if (!cur || cur.status === 'removed') throw new HttpError(404, 'You have no review on this order.');
    if (cur.status === 'hidden') throw new HttpError(403, 'This review was hidden by PairPlug moderation and can no longer be changed.');
    q.run('UPDATE seller_reviews SET thumbs_up = ?, body = ?, edited_at = ? WHERE id = ?', t, text, now(), cur.id);
    event(cur.id, user, 'buyer', 'edited', { before: { thumbs_up: cur.thumbs_up, body: cur.body }, after: { thumbs_up: t, body: text } });
    return cur.id;
  });
}
function remove(user, orderId) {
  return tx(() => {
    const o = ownOrder(user, orderId), cur = forOrder(o.id);
    if (!cur || cur.status === 'removed') throw new HttpError(404, 'You have no review on this order.');
    if (cur.status === 'hidden') throw new HttpError(403, 'This review was hidden by PairPlug moderation; it can only be restored by moderators.');
    q.run("UPDATE seller_reviews SET status = 'removed', edited_at = ? WHERE id = ?", now(), cur.id);
    event(cur.id, user, 'buyer', 'removed', null);
    return cur.id;
  });
}

// ------------------------------------------------------------------ reports + moderation
function report(user, reviewId, reason) {
  rateLimit(`review-report:${user.id}`, 10, 3600);
  const why = clean(reason, 501);
  if (why.length < 5 || why.length > 500) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'Tell us what is wrong (5 to 500 characters).' });
  return tx(() => {
    const r = q.get("SELECT * FROM seller_reviews WHERE id = ? AND status = 'published'", Number(reviewId));
    if (!r) throw new HttpError(404, 'Review not found');
    if (r.buyer_id === user.id) throw new HttpError(403, "You can't report your own review; edit or remove it instead.");
    try { q.run('INSERT INTO review_reports(review_id, reporter_id, reason, created_at) VALUES(?,?,?,?)', r.id, user.id, why, now()); }
    catch (e) { if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'You already reported this review.'); throw e; }
    event(r.id, user, user.id === r.seller_id ? 'seller' : 'user', 'reported', { reason: why });
    return r.id;
  });
}
function staffOnly(actor) { if (!(actor && (actor.is_admin || actor.is_moderator))) throw new HttpError(403, 'Moderator access required'); }
const why5 = (v) => { const t = clean(v, 1001); if (t.length < 5 || t.length > 1000) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'A reason of 5 to 1000 characters is required.' }); return t; };

/** Hide a published review (it stops counting and showing). Moderators cannot change its content. */
function hide(actor, reviewId, reason) {
  staffOnly(actor); const why = why5(reason);
  return tx(() => {
    const r = q.get('SELECT * FROM seller_reviews WHERE id = ?', Number(reviewId)); if (!r) throw new HttpError(404, 'Review not found');
    if (r.status !== 'published') throw new HttpError(409, 'Only a published review can be hidden.');
    q.run("UPDATE seller_reviews SET status = 'hidden' WHERE id = ?", r.id);
    q.run("UPDATE review_reports SET status = 'actioned', resolved_by = ?, resolved_at = ? WHERE review_id = ? AND status = 'open'", actor.id, now(), r.id);
    event(r.id, actor, staffRole(actor), 'hidden', { reason: why }); audit(actor, 'review_hidden', { type: 'review', id: r.id, detail: { reason: why, seller: r.seller_id } });
  });
}
function restore(actor, reviewId, reason) {
  staffOnly(actor); const why = why5(reason);
  return tx(() => {
    const r = q.get('SELECT * FROM seller_reviews WHERE id = ?', Number(reviewId)); if (!r) throw new HttpError(404, 'Review not found');
    if (r.status !== 'hidden') throw new HttpError(409, 'Only a hidden review can be restored.');
    q.run("UPDATE seller_reviews SET status = 'published' WHERE id = ?", r.id);
    event(r.id, actor, staffRole(actor), 'restored', { reason: why }); audit(actor, 'review_restored', { type: 'review', id: r.id, detail: { reason: why } });
  });
}
/** Close the open reports on a review without hiding it. */
function dismiss(actor, reviewId, reason) {
  staffOnly(actor); const why = why5(reason);
  return tx(() => {
    const r = q.get('SELECT id FROM seller_reviews WHERE id = ?', Number(reviewId)); if (!r) throw new HttpError(404, 'Review not found');
    const n = q.run("UPDATE review_reports SET status = 'dismissed', resolved_by = ?, resolved_at = ? WHERE review_id = ? AND status = 'open'", actor.id, now(), r.id).changes;
    if (!n) throw new HttpError(409, 'There are no open reports on this review.');
    event(r.id, actor, staffRole(actor), 'report_dismissed', { reason: why, reports: n }); audit(actor, 'review_reports_dismissed', { type: 'review', id: r.id, detail: { reason: why, reports: n } });
  });
}
const moderationQueue = () => ({
  reported: q.all(`SELECT r.*, b.display_name buyer, s.store_name, s.handle, (SELECT COUNT(*) FROM review_reports p WHERE p.review_id = r.id AND p.status = 'open') open_reports,
      (SELECT group_concat(p.reason, ' ¦ ') FROM review_reports p WHERE p.review_id = r.id AND p.status = 'open') reasons FROM seller_reviews r JOIN users b ON b.id = r.buyer_id JOIN users s ON s.id = r.seller_id
      WHERE EXISTS (SELECT 1 FROM review_reports p WHERE p.review_id = r.id AND p.status = 'open') ORDER BY r.id DESC LIMIT 100`),
  hidden: q.all(`SELECT r.*, b.display_name buyer, s.store_name, s.handle FROM seller_reviews r JOIN users b ON b.id = r.buyer_id JOIN users s ON s.id = r.seller_id WHERE r.status = 'hidden' ORDER BY r.id DESC LIMIT 100`),
});
const history = (reviewId) => q.all('SELECT e.*, u.display_name FROM review_events e JOIN users u ON u.id = e.actor_id WHERE e.review_id = ? ORDER BY e.id', Number(reviewId));

// ------------------------------------------------------------------ reading
/** Raw counts over PUBLISHED reviews only: reviews, thumbs-up among them, and how many have written text. */
function stats(sellerId) {
  const r = q.get("SELECT COUNT(*) reviews, COALESCE(SUM(thumbs_up), 0) thumbs, COUNT(body) written FROM seller_reviews WHERE seller_id = ? AND status = 'published'", Number(sellerId));
  return { reviews: r.reviews, thumbs: r.thumbs, written: r.written };
}
const recent = (sellerId, n = 8) => q.all("SELECT r.id, r.thumbs_up, r.body, r.created_at, r.edited_at, u.display_name FROM seller_reviews r JOIN users u ON u.id = r.buyer_id WHERE r.seller_id = ? AND r.status = 'published' AND r.body IS NOT NULL ORDER BY r.created_at DESC, r.id DESC LIMIT ?", Number(sellerId), n);

// ------------------------------------------------------------------ rendering (everything user-written goes through esc())
const THUMB = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><path d="M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9H19a2 2 0 0 1 2 2.3l-1.3 7a2 2 0 0 1-2 1.7H7"/></svg>';
const firstName = (n) => String(n || 'Buyer').split(' ')[0];

/** Compact reputation line for cards: raw counts only, nothing when there are no reviews. */
function line(sellerId) {
  const s = stats(sellerId);
  return s.reviews ? `<span class="rep-line" title="Order-linked reviews; not a rating">${THUMB} ${s.thumbs} thumbs-up · ${s.reviews} review${s.reviews === 1 ? '' : 's'}</span>` : '';
}
/** Storefront section. `viewer` enables the report button. */
function section(sellerId, viewer) {
  const s = stats(sellerId), list = recent(sellerId);
  const head = `<div class="sechead"><h2>Reviews</h2></div>`;
  if (!s.reviews) return `<section class="reputation" aria-label="Seller reviews">${head}<div class="panel"><p style="margin:0"><strong>No reviews yet.</strong> <span class="muted">Buyers can leave a thumbs-up and an optional review after they receive an order from this seller.</span></p></div></section>`;
  return `<section class="reputation" aria-label="Seller reviews">${head}
    <div class="rep-counts"><div><strong>${s.thumbs}</strong><span>thumbs-up</span></div><div><strong>${s.written}</strong><span>written review${s.written === 1 ? '' : 's'}</span></div><div><strong>${s.reviews}</strong><span>order-linked review${s.reviews === 1 ? '' : 's'}</span></div></div>
    <p class="small muted">Each review comes from a buyer who marked a PairPlug order from this seller as received. Payments happen outside PairPlug and are not independently verified, so these are buyers' opinions, not a rating or a guarantee. ${s.reviews < 10 ? 'This seller has only a few reviews so far.' : ''}</p>
    ${list.map((v) => `<div class="panel store-card review-card"><span class="rep-thumb ${v.thumbs_up ? 'up' : ''}">${v.thumbs_up ? THUMB + ' Thumbs-up' : 'Review'}</span> <strong>${esc(firstName(v.display_name))}</strong> <span class="muted small">${date(v.created_at)}${v.edited_at ? ' · edited' : ''} · order-linked</span><p style="margin:6px 0 0;white-space:pre-wrap">${esc(v.body)}</p>
      ${viewer && viewer.id ? `<details class="small"><summary>Report this review</summary><form data-api="/api/reviews/${v.id}/report" data-reload><label for="rr${v.id}" class="sr">Why are you reporting it?</label><input id="rr${v.id}" name="reason" maxlength="500" minlength="5" required placeholder="What is wrong with it?"><button class="btn ghost small" type="submit">Send report</button></form></details>` : ''}</div>`).join('')}</section>`;
}
/** Panel for the buyer's own order page. */
function panel(o) {
  if (!COMPLETE.includes(o.status)) return '';
  const cur = forOrder(o.id);
  const form = (url, method, c) => `<form data-api="${url}" data-method="${method}" data-reload>
      <label style="font-weight:400;display:flex;gap:8px;align-items:center"><input type="checkbox" name="thumbsUp"${c && c.thumbs_up ? ' checked' : ''}> ${THUMB} <strong>Thumbs-up</strong> — I had a good experience with this seller</label>
      <label for="rv${o.id}" style="margin-top:10px">Your review <span class="opt">(optional, up to ${MAX_BODY} characters)</span></label><textarea id="rv${o.id}" name="body" maxlength="${MAX_BODY}" placeholder="How was the item, the communication and the shipping?">${esc(c && c.body || '')}</textarea>
      <button class="btn" type="submit" style="margin-top:10px">${c ? 'Save changes' : 'Post review'}</button></form>`;
  if (!cur || cur.status === 'removed') return `<div class="panel" id="review"><h3>Leave a review</h3><p class="small muted">Shown on the seller's store as an order-linked review with your first name. PairPlug does not verify external payments. You can edit or remove it later.</p>${form(`/api/orders/${o.id}/review`, 'POST', null)}</div>`;
  if (cur.status === 'hidden') return `<div class="panel" id="review"><h3>Your review</h3><p class="small">You reviewed this order, but PairPlug moderation has hidden the review, so it is not shown and cannot be edited. Contact support if you think that is a mistake.</p></div>`;
  return `<div class="panel" id="review"><h3>Your review <span class="pill s-active">Posted</span></h3><p style="margin:0 0 8px">${cur.thumbs_up ? THUMB + ' <strong>Thumbs-up</strong>' : '<span class="muted">No thumbs-up</span>'}</p>${cur.body ? `<p style="white-space:pre-wrap">${esc(cur.body)}</p>` : ''}
    <details><summary class="btn ghost small">Edit</summary>${form(`/api/orders/${o.id}/review`, 'PUT', cur)}</details>
    <button class="btn ghost small" style="margin-top:8px" data-post="/api/orders/${o.id}/review/remove" data-confirm="Remove your review?">Remove my review</button></div>`;
}

module.exports = { COMPLETE, submit, edit, remove, report, hide, restore, dismiss, moderationQueue, history, stats, recent, line, section, panel, forOrder, THUMB };
