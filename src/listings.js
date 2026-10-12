'use strict';
const config = require('./config');
const { q, tx, now } = require('./db');
const { clean, cleanLine, dollarsToCents, HttpError } = require('./util');
const { ownedUploads } = require('./images');
const { notify } = require('./notify');
const { validatePaymentUrl, resolveLink } = require('./paymentLinks');
const { audit } = require('./audit');
const D = require('./discovery');

const CATS = new Set(config.categories.map((c) => c[0]));
const SELLER_STATUSES = new Set(['draft', 'active', 'archived']); // 'sold'/'reserved' are owned by the order system
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

const IMG_SQL = `(SELECT file FROM listing_images WHERE listing_id = l.id ORDER BY position, id LIMIT 1) AS image`;
const SELLER_SQL = `u.handle AS seller_handle, u.store_name AS seller_name, u.country AS seller_country, u.region AS seller_region, u.city AS seller_city`;

/** Public marketplace search. Every filter becomes SQL; nothing is filtered client-side. */
function searchListings(f) {
  const where = ["l.status = 'active'"], p = [];
  const terms = clean(f.q || '', 100).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  for (const t of terms) {
    where.push(`(l.title LIKE ? ESCAPE '\\' OR l.brand LIKE ? ESCAPE '\\' OR l.category LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\' OR l.size LIKE ? ESCAPE '\\')`);
    const v = `%${likeEsc(t)}%`; p.push(v, v, v, v, v);
  }
  if (f.category && CATS.has(f.category)) { where.push('l.category = ?'); p.push(f.category); }
  if (f.brand) { where.push('l.brand = ? COLLATE NOCASE'); p.push(f.brand); }
  if (f.size) { where.push('l.size = ? COLLATE NOCASE'); p.push(f.size); }
  if (f.condition && config.conditions[f.condition]) { where.push('l.condition = ?'); p.push(f.condition); }
  if (f.seller) { where.push('u.handle = ? COLLATE NOCASE'); p.push(f.seller); }
  if (Array.isArray(f.exclude) && f.exclude.length) where.push(`l.id NOT IN (${f.exclude.map((x) => Number(x) | 0).join(',')})`);
  const min = dollarsToCents(f.min), max = dollarsToCents(f.max);
  if (min && !Number.isNaN(min)) { where.push('l.price_cents >= ?'); p.push(min); }
  if (max && !Number.isNaN(max)) { where.push('l.price_cents <= ?'); p.push(max); }
  const order = { price_asc: 'l.price_cents ASC, l.id DESC', price_desc: 'l.price_cents DESC, l.id DESC' }[f.sort] || 'l.published_at DESC, l.id DESC';
  const perPage = 24, page = Math.max(1, parseInt(f.page, 10) || 1);
  const from = `FROM listings l JOIN users u ON u.id = l.seller_id AND u.banned = 0 WHERE ${where.join(' AND ')}`;
  const total = q.get(`SELECT COUNT(*) n ${from}`, ...p).n;
  const items = q.all(`SELECT l.*, ${IMG_SQL}, ${SELLER_SQL} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, perPage, (page - 1) * perPage);
  return { items, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
}

function facets() {
  const col = (c) => q.all(`SELECT ${c} v, COUNT(*) n FROM listings WHERE status='active' AND ${c} IS NOT NULL AND ${c} <> '' GROUP BY ${c} COLLATE NOCASE ORDER BY n DESC, v LIMIT 30`).map((r) => r.v);
  return { brands: col('brand'), sizes: col('size'),
    categories: q.all("SELECT category v, COUNT(*) n FROM listings WHERE status='active' GROUP BY category").reduce((a, r) => ({ ...a, [r.v]: r.n }), {}) };
}

function getListing(id) {
  const l = q.get(`SELECT l.*, ${SELLER_SQL}, u.bio AS seller_bio, u.created_at AS seller_since, u.plan AS seller_plan FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`, id);
  if (l) l.images = q.all('SELECT file FROM listing_images WHERE listing_id = ? ORDER BY position, id', id).map((r) => r.file);
  return l;
}

function validateListing(body, { publish }) {
  const errors = {};
  const title = cleanLine(body.title, 120);
  if (title.length < 3) errors.title = 'Enter a title (at least 3 characters).';
  const category = String(body.category || '');
  if (!CATS.has(category)) errors.category = 'Choose a category.';
  const price = dollarsToCents(body.price);
  if (price == null || Number.isNaN(price) || price < 100 || price > 1000000) errors.price = 'Enter a price between $1.00 and $10,000.00.';
  const condition = body.condition || null;
  if (publish && !config.conditions[condition]) errors.condition = 'Choose a condition.';
  else if (condition && !config.conditions[condition]) errors.condition = 'Invalid condition.';
  const cost = dollarsToCents(body.cost);
  if (Number.isNaN(cost) || (cost != null && cost > 10000000)) errors.cost = 'Enter a valid cost, e.g. 12.50.';
  // Shipping terms: 'buyer' pays a flat fee; 'seller' offers free shipping and covers the label. If the client doesn't say, infer it.
  let shipping = dollarsToCents(body.shipping) ?? 0;
  if (Number.isNaN(shipping) || shipping > 100000) { errors.shipping = 'Enter a shipping price up to $1,000.00.'; shipping = 0; }
  let shipping_payer = body.shipping_payer;
  if (shipping_payer == null || shipping_payer === '') shipping_payer = shipping > 0 ? 'buyer' : 'seller';
  if (!['buyer', 'seller'].includes(shipping_payer)) { errors.shipping_payer = 'Choose who pays for shipping.'; shipping_payer = 'buyer'; }
  else if (shipping_payer === 'seller') shipping = 0;   // free shipping: the buyer is never charged shipping
  else if (shipping <= 0 && !errors.shipping) errors.shipping = 'Enter the flat shipping fee the buyer pays, or choose free shipping.';
  let payment_url = null;
  if (body.payment_url != null && String(body.payment_url).trim() !== '') {
    try { payment_url = validatePaymentUrl(body.payment_url); } catch (e) { errors.payment_url = (e.fields && e.fields.payment_url) || e.message; }
  }
  // Quantity: how many identical units are for sale. Direct checkout reserves/sells one unit per order; the platform (legacy) checkout is single-unit only.
  let quantity = 1;
  if (body.quantity !== undefined && body.quantity !== null && body.quantity !== '') {
    const n = /^\d{1,3}$/.test(String(body.quantity).trim()) ? Number(body.quantity) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 999) errors.quantity = 'Enter a whole number of units from 1 to 999.';
    else if (config.checkoutMode !== 'external' && n !== 1) errors.quantity = 'Only one unit per listing is supported in this checkout mode.';
    else quantity = n;
  }
  const num = (k, max) => { const v = body[k]; if (v === '' || v == null) return null; const n = Number(v); if (!(n > 0 && n <= max)) { errors[k] = 'Enter a positive number.'; return null; } return n; };
  const weight_oz = num('weight_oz', 2400), length_in = num('length_in', 120), width_in = num('width_in', 120), height_in = num('height_in', 120);
  const sku = cleanLine(body.sku, 60) || null;
  const images = Array.isArray(body.images) ? body.images.slice(0, config.limits.maxImages) : [];
  if (publish && images.length < 1) errors.images = 'Add at least one photo before publishing.';
  if (publish && !(weight_oz > 0)) errors.weight_oz = 'Add a shipping weight so buyers can be charged correctly.';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields.', errors);
  return { title, description: clean(body.description, 4000), category, brand: cleanLine(body.brand, 60) || null, size: cleanLine(body.size, 30) || null,
    condition, price_cents: price, cost_cents: cost, shipping_cents: shipping, shipping_payer, payment_url, sku, weight_oz, length_in, width_in, height_in, images, quantity };
}

function saveListing(user, id, body) {
  const publish = body.status === 'active';
  if (body.status && !SELLER_STATUSES.has(body.status)) throw new HttpError(422, 'Invalid status');
  const v = validateListing(body, { publish });
  const files = ownedUploads(user.id, v.images);
  // Verified email is required to publish (and to stay eligible for new orders; see externalCheckout.purchasable).
  if (publish && q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', user.id).r) throw new HttpError(403, 'Selling is paused on your account while PairPlug reviews a report. You can still reply to PairPlug and handle existing orders.');
  if (publish && !q.get('SELECT email_verified_at v FROM users WHERE id = ?', user.id).v) throw new HttpError(403, 'Verify your email address before publishing listings. You can still save drafts.');
  // Hybrid checkout: a listing needs no payment link to be published. Without one it is contact-only (no Buy now button).
  const saved = tx(() => {
    const t = now();
    let cur = null;
    if (id) {
      cur = q.get('SELECT * FROM listings WHERE id = ?', id);
      if (!cur || cur.seller_id !== user.id) throw new HttpError(404, 'Listing not found'); // 404 (not 403) so IDs of others' listings aren't confirmed
      if (['sold', 'reserved'].includes(cur.status)) throw new HttpError(409, `This item is ${cur.status} and can't be edited.`);
    }
    if (v.sku) {
      const dup = q.get('SELECT id FROM listings WHERE seller_id = ? AND sku = ? AND id <> ?', user.id, v.sku, id || 0);
      if (dup) throw new HttpError(422, 'Please fix the highlighted fields.', { sku: 'You already use this SKU on another listing.' });
    }
    const status = body.status || (cur ? cur.status : 'draft');
    // The seller's confirmation that their fixed-price payment link charges exactly item + buyer-paid shipping. It is tied to that total, so any later price/shipping change un-confirms it.
    const total = v.price_cents + (v.shipping_payer === 'buyer' ? v.shipping_cents : 0);
    const given = body.payment_amount_ack, unchanged = cur && cur.payment_url === v.payment_url && cur.payment_total_ack_cents === total;
    v.payment_total_ack_cents = v.payment_url && (given === true || (given === undefined && unchanged)) ? total : null;       // an explicit false (box unticked) clears it; silence keeps it only if link and total are unchanged
    const cols = ['quantity', 'payment_total_ack_cents', 'title', 'description', 'category', 'brand', 'size', 'condition', 'price_cents', 'cost_cents', 'shipping_cents', 'shipping_payer', 'payment_url', 'sku', 'weight_oz', 'length_in', 'width_in', 'height_in'];
    const vals = cols.map((c) => v[c]);
    let listingId = id;
    if (id) {
      const published_at = status === 'active' && !cur.published_at ? t : cur.published_at;
      q.run(`UPDATE listings SET ${cols.map((c) => c + ' = ?').join(', ')}, status = ?, published_at = ?, updated_at = ? WHERE id = ?`, ...vals, status, published_at, t, id);
      if (cur.price_cents > v.price_cents && status === 'active') notifyPriceDrop(id, v.title, cur.price_cents, v.price_cents);
    } else {
      const r = q.run(`INSERT INTO listings(seller_id, ${cols.join(',')}, status, published_at, created_at, updated_at) VALUES(?, ${cols.map(() => '?').join(',')}, ?,?,?,?)`,
        user.id, ...vals, status, status === 'active' ? t : null, t, t);
      listingId = Number(r.lastInsertRowid);
    }
    q.run('DELETE FROM listing_images WHERE listing_id = ?', listingId);
    files.forEach((f, i) => q.run('INSERT INTO listing_images(listing_id, file, position) VALUES(?,?,?)', listingId, f, i));
    return q.get('SELECT * FROM listings WHERE id = ?', listingId);
  });
  if (saved.status === 'active') D.announceDrop(saved.id);        // after commit; announces only a FIRST publication, once (see discovery.announceDrop)
  return saved;
}

function notifyPriceDrop(listingId, title, oldC, newC) {
  const key = `listing:${listingId}:price:${newC}`;
  for (const f of q.all('SELECT user_id FROM favorites WHERE listing_id = ?', listingId))
    notify(f.user_id, key, 'Price drop on a saved item', `${title} dropped from $${(oldC / 100).toFixed(2)} to $${(newC / 100).toFixed(2)}.`, `/listing/${listingId}`);
}

function duplicateListing(user, id) {
  return tx(() => {
    const l = q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', id, user.id);
    if (!l) throw new HttpError(404, 'Listing not found');
    const t = now();
    const r = q.run(`INSERT INTO listings(seller_id,title,description,category,brand,size,condition,price_cents,cost_cents,shipping_cents,shipping_payer,payment_url,weight_oz,length_in,width_in,height_in,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`, user.id, l.title + ' (copy)', l.description, l.category, l.brand, l.size, l.condition, l.price_cents, l.cost_cents, l.shipping_cents, l.shipping_payer, null, l.weight_oz, l.length_in, l.width_in, l.height_in, t, t);
    q.run('INSERT INTO listing_images(listing_id,file,position) SELECT ?, file, position FROM listing_images WHERE listing_id = ?', r.lastInsertRowid, id);
    return Number(r.lastInsertRowid);
  });
}

/**
 * Bulk actions. Every id is checked for ownership and for a state that the *seller* may change.
 * Items that are sold/reserved are skipped (reported back), since the order system owns those states.
 */
function bulkAction(user, { ids, action, status, price, percent }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new HttpError(422, 'Select between 1 and 500 listings.');
  ids = ids.map(Number).filter(Number.isInteger);
  const published = [];
  const out = tx(() => {
    const result = { updated: 0, skipped: [] };
    for (const id of ids) {
      const l = q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', id, user.id);
      if (!l) { result.skipped.push({ id, reason: 'not found' }); continue; }
      if (['sold', 'reserved'].includes(l.status)) { result.skipped.push({ id, reason: `${l.status} items can't be changed` }); continue; }
      if (action === 'status') {
        if (!SELLER_STATUSES.has(status)) throw new HttpError(422, 'Invalid status');
        if (status === 'active') {
          if (q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', user.id).r) { result.skipped.push({ id, reason: 'selling is paused on your account' }); continue; }
          if (!q.get('SELECT email_verified_at v FROM users WHERE id = ?', user.id).v) { result.skipped.push({ id, reason: 'verify your email first' }); continue; }
          const hasImg = q.get('SELECT 1 x FROM listing_images WHERE listing_id = ?', id);
          if (!hasImg || !l.condition || !(l.weight_oz > 0)) { result.skipped.push({ id, reason: 'incomplete (needs photo, condition, weight) — edit it first' }); continue; }
        }
        q.run('UPDATE listings SET status = ?, published_at = COALESCE(published_at, CASE WHEN ? = \'active\' THEN ? END), updated_at = ? WHERE id = ?', status, status, now(), now(), id);
        if (status === 'active') published.push(id);
      } else if (action === 'price') {
        let np;
        if (percent != null) { const pc = Number(percent); if (!(pc >= -90 && pc <= 500)) throw new HttpError(422, 'Percent must be between -90 and 500'); np = Math.round(l.price_cents * (1 + pc / 100)); }
        else { np = dollarsToCents(price); if (np == null || Number.isNaN(np)) throw new HttpError(422, 'Enter a valid price'); }
        if (np < 100 || np > 1000000) { result.skipped.push({ id, reason: 'price out of range' }); continue; }
        q.run('UPDATE listings SET price_cents = ?, updated_at = ? WHERE id = ?', np, now(), id);
        if (np < l.price_cents && l.status === 'active') notifyPriceDrop(id, l.title, l.price_cents, np);
      } else throw new HttpError(422, 'Unknown action');
      result.updated++;
    }
    return result;
  });
  for (const id of published) D.announceDrop(id);
  return out;
}

/** Minimal RFC4180 CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/**
 * CSV import keyed on SKU. Existing SKUs get their price/cost/shipping/etc updated; unknown SKUs become
 * *drafts* (photos can't come from a CSV, and publishing requires a photo). Never touches sold/reserved items.
 */
function importCsv(user, text) {
  const rows = parseCsv(String(text || '').replace(/^﻿/, ''));
  if (rows.length < 2) throw new HttpError(422, 'CSV needs a header row and at least one data row.');
  if (rows.length - 1 > config.limits.csvRows) throw new HttpError(422, `Maximum ${config.limits.csvRows} rows per import.`);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  if (!head.includes('sku')) throw new HttpError(422, 'CSV must have a "sku" column.');
  const report = { created: 0, updated: 0, errors: [] };
  tx(() => {
    rows.slice(1).forEach((r, i) => {
      const line = i + 2, rec = Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()]));
      try {
        if (!rec.sku) throw new Error('sku is required');
        const cur = q.get('SELECT * FROM listings WHERE seller_id = ? AND sku = ?', user.id, rec.sku);
        if (cur && ['sold', 'reserved'].includes(cur.status)) throw new Error(`item is ${cur.status}`);
        const merged = cur ? { title: cur.title, description: cur.description, category: cur.category, brand: cur.brand, size: cur.size, condition: cur.condition,
          shipping_payer: cur.shipping_payer, payment_url: cur.payment_url, price: (cur.price_cents / 100).toFixed(2), cost: cur.cost_cents == null ? '' : (cur.cost_cents / 100).toFixed(2), shipping: (cur.shipping_cents / 100).toFixed(2),
          weight_oz: cur.weight_oz, length_in: cur.length_in, width_in: cur.width_in, height_in: cur.height_in } : {};
        for (const k of ['title', 'description', 'category', 'brand', 'size', 'condition', 'price', 'cost', 'shipping', 'shipping_payer', 'payment_url', 'weight_oz', 'length_in', 'width_in', 'height_in']) if (rec[k] !== undefined && rec[k] !== '') merged[k] = rec[k];
        merged.sku = rec.sku;
        const v = validateListing({ ...merged, images: [] }, { publish: false });
        const t = now();
        if (cur) {
          q.run(`UPDATE listings SET title=?,description=?,category=?,brand=?,size=?,condition=?,price_cents=?,cost_cents=?,shipping_cents=?,shipping_payer=?,payment_url=?,weight_oz=?,length_in=?,width_in=?,height_in=?,updated_at=? WHERE id=?`,
            v.title, v.description, v.category, v.brand, v.size, v.condition, v.price_cents, v.cost_cents, v.shipping_cents, v.shipping_payer, v.payment_url, v.weight_oz, v.length_in, v.width_in, v.height_in, t, cur.id);
          report.updated++;
        } else {
          q.run(`INSERT INTO listings(seller_id,title,description,category,brand,size,condition,price_cents,cost_cents,shipping_cents,shipping_payer,payment_url,sku,weight_oz,length_in,width_in,height_in,status,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`, user.id, v.title, v.description, v.category, v.brand, v.size, v.condition, v.price_cents, v.cost_cents, v.shipping_cents, v.shipping_payer, v.payment_url, rec.sku, v.weight_oz, v.length_in, v.width_in, v.height_in, t, t);
          report.created++;
        }
      } catch (e) { report.errors.push({ line, error: e.fields ? Object.values(e.fields).join(' ') : e.message }); }
    });
  });
  return report;
}

/** Can this listing go live right now? Returns a human-readable reason it can't, or null. One rule set for publish, resume and bulk. */
function publishBlocker(user, l) {
  if (q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', user.id).r) return 'Selling is paused on your account while PairPlug reviews a report.';
  if (!q.get('SELECT email_verified_at v FROM users WHERE id = ?', user.id).v) return 'Verify your email address first.';
  if (!q.get('SELECT 1 x FROM listing_images WHERE listing_id = ?', l.id)) return 'Add at least one photo.';
  if (!l.condition) return 'Choose a condition.';
  if (!(l.weight_oz > 0)) return 'Add a shipping weight.';
  return null;
}

/**
 * Seller-driven listing state changes. Only legal transitions are allowed; sold/reserved items are owned by the order system
 * (a reserved item has a buyer mid-checkout and cannot be touched).
 *   pause: active -> archived     resume: archived -> active     unpublish: active -> draft
 *   (marking an item sold by hand is now `externalSales.record`: it also writes the seller's external-sale record)     delete: unused draft/archived -> removed
 */
function listingAction(user, id, action) {
  const out = tx(() => {
    const l = q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', Number(id), user.id);
    if (!l) throw new HttpError(404, 'Listing not found');
    if (l.status === 'reserved') throw new HttpError(409, 'A buyer is checking out this item right now. Try again after their reservation ends.');
    const t = now(), set = (status) => q.run('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?', status, t, l.id);
    const bad = (m) => { throw new HttpError(409, m); };
    switch (action) {
      case 'pause': if (l.status !== 'active') bad('Only items for sale can be paused.'); set('archived'); break;
      case 'unpublish': if (l.status !== 'active') bad('Only items for sale can be unpublished.'); set('draft'); break;
      case 'resume': {
        if (l.status !== 'archived') bad('Only paused items can be resumed.');
        const why = publishBlocker(user, l); if (why) throw new HttpError(422, `Can't resume yet: ${why}`);
        q.run('UPDATE listings SET status = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?', 'active', t, t, l.id); break;
      }
      case 'delete': {
        if (!['draft', 'archived'].includes(l.status)) bad('Pause or unpublish the item before deleting it.');
        if (q.get('SELECT 1 x FROM order_items WHERE listing_id = ?', l.id) || q.get('SELECT 1 x FROM conversations WHERE listing_id = ?', l.id)) bad('This item has orders or conversations, so it is kept for the record. Leave it paused instead.');
        const files = q.all('SELECT file FROM listing_images WHERE listing_id = ?', l.id).map((r) => r.file);
        q.run('DELETE FROM favorites WHERE listing_id = ?', l.id); q.run('DELETE FROM cart_items WHERE listing_id = ?', l.id); q.run('DELETE FROM listings WHERE id = ?', l.id);
        audit(user, 'listing_deleted', { type: 'listing', id: l.id });
        return { removed: true, files };
      }
      default: throw new HttpError(400, 'Unknown action');
    }
    return { status: q.get('SELECT status FROM listings WHERE id = ?', l.id).status };
  });
  if (action === 'resume' && out && out.status === 'active') D.announceDrop(id);
  return out;
}

module.exports = { publishBlocker, listingAction, searchListings, facets, getListing, saveListing, duplicateListing, bulkAction, importCsv, parseCsv, validateListing, IMG_SQL, SELLER_SQL };
