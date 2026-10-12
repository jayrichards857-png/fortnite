'use strict';
// Seller discovery: seller search/ranking, discovery lists, follows, new-drop notifications and privacy-conscious search popularity. Real data only.
const crypto = require('node:crypto');
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, clean, esc, money } = require('./util');
const V = require('./views');

const PUBLIC = 'u.is_seller = 1 AND u.banned = 0 AND u.selling_restricted_at IS NULL';
const SF = "LEFT JOIN (SELECT seller_id, json_extract(published_json,'$.headline') headline, json_extract(published_json,'$.about') about, json_extract(published_json,'$.avatar') avatar FROM storefronts) sf ON sf.seller_id = u.id";
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const termsOf = (s) => clean(s || '', 100).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
const L = (t) => `%${likeEsc(t)}%`;

// ------------------------------------------------------------------ seller lists
/** Every public seller profile (approved seller, not banned), including sellers who have not listed anything yet. Transparent ranking: sellers with available items first
 *  (latest listing, then number of items), then newer profiles. The count is a plain COUNT over users; the per-row subqueries run only for the page being shown. */
function discoverSellers({ page = 1, per = 12 } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  const total = q.get(`SELECT COUNT(*) c FROM users u WHERE ${PUBLIC}`).c;
  const items = q.all(`SELECT u.id, u.handle, u.store_name, u.bio, sf.headline, sf.about, sf.avatar, u.created_at,
    (SELECT MAX(published_at) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') latest,
    (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') n FROM users u ${SF} WHERE ${PUBLIC} ORDER BY latest IS NULL, latest DESC, n DESC, u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, per, (page - 1) * per);
  return { items, total, page, per, pages: Math.max(1, Math.ceil(total / per)) };
}
/** Sellers relevant to a query. Every term must match the seller's name/handle/bio/published storefront text OR one of their available listings (title, brand, category, description). Sellers with no listings are found by profile text alone. */
function searchSellers(qstr, { page = 1, per = 12 } = {}) {
  const terms = termsOf(qstr); if (!terms.length) return discoverSellers({ page, per });
  page = Math.max(1, parseInt(page, 10) || 1);
  const whole = terms.join(' '), wp = [], sp = [], mp = [];
  const where = terms.map((t) => { const v = L(t); wp.push(v, v, v, v, v, v, v, v, v); return `((u.handle LIKE ? ESCAPE '\\' OR u.store_name LIKE ? ESCAPE '\\' OR u.bio LIKE ? ESCAPE '\\' OR sf.headline LIKE ? ESCAPE '\\' OR sf.about LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM listings l WHERE l.seller_id = u.id AND l.status = 'active' AND (l.title LIKE ? ESCAPE '\\' OR l.brand LIKE ? ESCAPE '\\' OR l.category LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')))`; }).join(' AND ');
  // transparent relevance: name match (exact > prefix > contains), then storefront text, then how many available listings match (capped), then recency
  const lw = L(whole), pre = `${likeEsc(whole)}%`;
  sp.push(whole, whole, pre, pre, lw, lw, lw, lw, lw);
  const matchCnt = terms.map((t) => { const v = L(t); mp.push(v, v, v, v); return '(l.title LIKE ? ESCAPE \'\\\' OR l.brand LIKE ? ESCAPE \'\\\' OR l.category LIKE ? ESCAPE \'\\\' OR l.description LIKE ? ESCAPE \'\\\')'; }).join(' AND ');
  const score = `(CASE WHEN lower(u.handle) = ? OR lower(u.store_name) = ? THEN 100 WHEN lower(u.handle) LIKE ? ESCAPE '\\' OR lower(u.store_name) LIKE ? ESCAPE '\\' THEN 60 WHEN u.handle LIKE ? ESCAPE '\\' OR u.store_name LIKE ? ESCAPE '\\' THEN 40 ELSE 0 END
    + CASE WHEN u.bio LIKE ? ESCAPE '\\' OR sf.headline LIKE ? ESCAPE '\\' OR sf.about LIKE ? ESCAPE '\\' THEN 15 ELSE 0 END
    + 5 * MIN(10, (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active' AND ${matchCnt})))`;
  const from = `FROM users u ${SF} WHERE ${PUBLIC} AND ${where}`;
  const total = q.get(`SELECT COUNT(*) c ${from}`, ...wp).c;
  const items = q.all(`SELECT u.id, u.handle, u.store_name, u.bio, sf.headline, sf.about, sf.avatar, ${score} AS score, (SELECT MAX(published_at) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') latest,
    (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') n ${from} ORDER BY score DESC, latest IS NULL, latest DESC, u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, ...sp, ...mp, ...wp, per, (page - 1) * per);
  return { items, total, page, per, pages: Math.max(1, Math.ceil(total / per)) };
}
/** Attach each seller's newest available listings (one query for the whole page). */
function withPreviews(sellers, { perSeller = 3, term = '' } = {}) {
  if (!sellers.length) return sellers;
  const ids = sellers.map((s) => s.id), ts = termsOf(term);
  const rows = q.all(`SELECT l.id, l.seller_id, l.title, l.price_cents, (SELECT file FROM listing_images WHERE listing_id = l.id ORDER BY position, id LIMIT 1) image,
    ${ts.length ? '(' + ts.map(() => "(l.title LIKE ? ESCAPE '\\' OR l.brand LIKE ? ESCAPE '\\' OR l.category LIKE ? ESCAPE '\\')").join(' AND ') + ')' : '0'} AS rel
    FROM listings l WHERE l.status = 'active' AND l.seller_id IN (${ids.map(() => '?').join(',')}) ORDER BY rel DESC, l.published_at DESC, l.id DESC`, ...ts.flatMap((t) => [L(t), L(t), L(t)]), ...ids);
  const by = new Map(); for (const r of rows) { const a = by.get(r.seller_id) || []; if (a.length < perSeller) { a.push(r); by.set(r.seller_id, a); } }
  return sellers.map((s) => ({ ...s, previews: by.get(s.id) || [] }));
}

// ------------------------------------------------------------------ follows
const publicSeller = (handle) => q.get('SELECT id, handle, store_name FROM users u WHERE u.handle = ? COLLATE NOCASE AND ' + PUBLIC, String(handle || '').slice(0, 40));
const followedSet = (user) => new Set(user ? q.all('SELECT seller_id FROM seller_follows WHERE follower_id = ?', user.id).map((r) => r.seller_id) : []);
function follow(user, handle) {
  const s = publicSeller(handle); if (!s) throw new HttpError(404, 'Seller not found');
  if (s.id === user.id) throw new HttpError(400, 'You can\'t follow your own store.');
  const r = q.run('INSERT OR IGNORE INTO seller_follows(follower_id, seller_id, created_at) VALUES(?,?,?)', user.id, s.id, now());      // PK makes a duplicate a no-op
  return { following: true, changed: r.changes === 1 };
}
function unfollow(user, handle) {
  const s = q.get('SELECT id FROM users WHERE handle = ? COLLATE NOCASE AND is_seller = 1', String(handle || '').slice(0, 40)); if (!s) throw new HttpError(404, 'Seller not found');
  const r = q.run('DELETE FROM seller_follows WHERE follower_id = ? AND seller_id = ?', user.id, s.id);
  return { following: false, changed: r.changes === 1 };
}
const followedSellers = (user) => q.all(`SELECT u.id, u.handle, u.store_name, u.bio, sf.headline, sf.about, sf.avatar, (SELECT MAX(published_at) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') latest,
  (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') n FROM seller_follows f JOIN users u ON u.id = f.seller_id ${SF} WHERE f.follower_id = ? AND ${PUBLIC} ORDER BY f.created_at DESC`, user.id);

// ------------------------------------------------------------------ new-drop notifications
/** Announce a listing's FIRST publication to its seller's followers: one set-based INSERT (safe for large follower counts), claimed exactly once via drop_notified_at,
 *  deduplicated per follower by notifications' UNIQUE(user_id, dedupe_key). Drafts, paused/sold items, banned sellers and the seller themself are never notified. In-app only. */
function announceDrop(listingId) {
  try {
    return tx(() => {
      const l = q.get('SELECT l.*, u.store_name, u.handle, u.banned, u.is_seller FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?', Number(listingId));
      if (!l || l.status !== 'active' || !l.published_at || l.banned || !l.is_seller) return 0;
      if (q.run('UPDATE listings SET drop_notified_at = ? WHERE id = ? AND drop_notified_at IS NULL', now(), l.id).changes !== 1) return 0;     // already announced
      const img = (q.get('SELECT file FROM listing_images WHERE listing_id = ? ORDER BY position, id LIMIT 1', l.id) || {}).file || null, who = l.store_name || l.handle;
      return q.run(`INSERT OR IGNORE INTO notifications(user_id, title, body, link, image, dedupe_key, created_at) SELECT f.follower_id, ?, ?, ?, ?, ?, ? FROM seller_follows f JOIN users fu ON fu.id = f.follower_id AND fu.banned = 0 WHERE f.seller_id = ? AND f.follower_id <> ?`,
        `New from ${who}`, `${l.title} · ${money(l.price_cents)}`, `/listing/${l.id}`, img, `drop:${l.id}`, now(), l.seller_id, l.seller_id).changes;
    });
  } catch (e) { console.error('new-drop notification failed:', e.message); return 0; }       // never let a notification problem break publishing
}

// ------------------------------------------------------------------ search activity (privacy-conscious)
const WINDOW_DAYS = 14, RETENTION_DAYS = 30, MIN_COUNT = 3;
const seen = new Map(), perHour = new Map();
/** Lower-case, collapse whitespace, strip symbols; reject noise and anything that could be personal (emails, long digit runs, URLs). */
function normalizeTerm(raw) {
  let t = String(raw || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!t || /@|https?:|www\.|\d{6,}/.test(t)) return null;
  t = t.replace(/[^\p{L}\p{N} '&.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (t.length < 2 || !/[\p{L}\p{N}]/u.test(t) || t.split(' ').length > 6 || /^(.)\1{4,}$/.test(t)) return null;
  return t;
}
/** Record one search. `source` (an IP) is hashed in memory only to drop rapid repeats and floods; it is never stored. */
function recordSearch(raw, source = '') {
  const term = normalizeTerm(raw); if (!term) return false;
  const key = crypto.createHash('sha1').update(`${source}|${term}`).digest('hex'), t = Date.now();
  if (t - (seen.get(key) || 0) < 30000) return false;
  const hk = crypto.createHash('sha1').update(String(source)).digest('hex'), h = perHour.get(hk) || { at: t, n: 0 }; if (t - h.at > 3600000) { h.at = t; h.n = 0; }
  if (h.n >= 30 * Math.max(1, config.rateLimitScale)) return false; h.n++; perHour.set(hk, h); seen.set(key, t);
  if (seen.size > 5000) for (const [k, v] of seen) if (t - v > 30000) seen.delete(k);
  if (perHour.size > 5000) for (const [k, v] of perHour) if (t - v.at > 3600000) perHour.delete(k);
  q.run('INSERT INTO search_log(term, created_at) VALUES(?,?)', term, now());
  return true;
}
let cache = { at: 0, rows: [] };
/** Real counts over the recent window; only queries searched at least MIN_COUNT times qualify. Cached briefly so a page view costs no extra query. */
function popular({ force = false } = {}) {
  if (!force && Date.now() - cache.at < 60000) return cache.rows;
  cache = { at: Date.now(), rows: q.all('SELECT term, COUNT(*) n FROM search_log WHERE created_at >= ? GROUP BY term HAVING n >= ? ORDER BY n DESC, term LIMIT 50', now() - WINDOW_DAYS * 86400, MIN_COUNT) };
  return cache.rows;
}
const resetPopularCache = () => { cache = { at: 0, rows: [] }; };
/** Popular searches that share a word with the current query (never the query itself). Empty when there isn't enough real data. */
function relatedPopular(qstr, limit = 6) {
  const me = normalizeTerm(qstr) || '', words = new Set(me.split(' ').filter((w) => w.length > 1));
  return popular().filter((r) => r.term !== me && r.term.split(' ').some((w) => words.has(w))).slice(0, limit).map((r) => r.term);
}
const purgeSearchLog = () => q.run('DELETE FROM search_log WHERE created_at < ?', now() - RETENTION_DAYS * 86400).changes;
/** Brands and categories among the AVAILABLE listings that match the query. */
function relatedDiscoveries(qstr) {
  const ts = termsOf(qstr); if (!ts.length) return { brands: [], categories: [] };
  const cond = ts.map(() => "(l.title LIKE ? ESCAPE '\\' OR l.brand LIKE ? ESCAPE '\\' OR l.category LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')").join(' AND '), p = ts.flatMap((t) => [L(t), L(t), L(t), L(t)]);
  const base = `FROM listings l JOIN users u ON u.id = l.seller_id AND u.banned = 0 WHERE l.status = 'active' AND ${cond}`, me = ts.join(' ');
  return { brands: q.all(`SELECT l.brand v, COUNT(*) n ${base} AND l.brand IS NOT NULL AND l.brand <> '' GROUP BY l.brand COLLATE NOCASE ORDER BY n DESC, v LIMIT 6`, ...p).filter((r) => r.v.toLowerCase() !== me),
    categories: q.all(`SELECT l.category v, COUNT(*) n ${base} GROUP BY l.category ORDER BY n DESC LIMIT 4`, ...p).map((r) => ({ ...r, label: (config.categories.find((c) => c[0] === r.v) || [])[1] || r.v })) };
}

// ------------------------------------------------------------------ rendering
const heartBtn = (handle, on, cls = '') => `<button type="button" class="follow${on ? ' on' : ''} ${cls}" data-follow="${esc(handle)}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${on ? 'Unfollow' : 'Follow'} @${esc(handle)}">${V.icon('heart', 'follow-ico')}<span class="follow-label">${on ? 'Following' : 'Follow'}</span></button>`;
function sellerCard(s, { following = new Set(), user = null } = {}) {
  const name = s.store_name || s.handle, bio = String(s.headline || s.about || s.bio || '').trim().slice(0, 140);
  const avatar = s.avatar ? `<img class="scard-av" src="/uploads/${esc(s.avatar)}" alt="" loading="lazy">` : `<div class="scard-av scard-av-fb" aria-hidden="true">${esc(name[0].toUpperCase())}</div>`;
  return `<article class="scard"><a class="scard-head" href="/s/${esc(s.handle)}">${avatar}<span><strong>${esc(name)}</strong><span class="muted small">@${esc(s.handle)}</span></span></a>
    ${bio ? `<p class="scard-bio">${esc(bio)}</p>` : ''}
    ${(s.previews || []).length ? `<div class="scard-prev">${s.previews.map((l) => `<a href="/listing/${l.id}" title="${esc(l.title)}">${V.img(l.image, 'thumb', l.title)}</a>`).join('')}</div>` : '<p class="muted small scard-empty">No listings yet — check back for their next drop.</p>'}
    <div class="scard-foot">${user && user.id === s.id ? '<span class="muted small">Your store</span>' : heartBtn(s.handle, following.has(s.id))}<a class="small" href="/s/${esc(s.handle)}">View storefront →</a></div></article>`;
}

module.exports = { discoverSellers, searchSellers, withPreviews, publicSeller, followedSet, follow, unfollow, followedSellers, announceDrop, normalizeTerm, recordSearch, popular, resetPopularCache, relatedPopular, purgeSearchLog, relatedDiscoveries, heartBtn, sellerCard, MIN_COUNT, WINDOW_DAYS, RETENTION_DAYS };
