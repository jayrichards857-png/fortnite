'use strict';
const express = require('express');
const config = require('../config');
const { q, tx, now } = require('../db');
const { esc, money, clean, cleanLine, date, HttpError } = require('../util');
const V = require('../views');
const auth = require('../auth');
const L = require('../listings');
const checkout = require('../checkout');
const payments = require('../payments');
const escrow = require('../escrow');
const { isLocalShip } = require('../pricing');
const { saveUpload, ownedUploads } = require('../images');
const { notify } = require('../notify');
const { transition, PAID_STATES } = require('../orderMachine');
const X = require('../externalCheckout');
const { resolveLink } = require('../paymentLinks');

const r = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const D = require('../discovery');
const RV = require('../reviews');
const LEGAL = require('../legal');
const favSet = (user) => new Set(user ? q.all('SELECT listing_id FROM favorites WHERE user_id = ?', user.id).map((f) => f.listing_id) : []);
const page = (req, res, opts) => res.send(V.layout({ user: req.user, path: req.path, ...opts }));
const stars = (n) => `<span class="stars" aria-label="${n} out of 5">${'★'.repeat(Math.round(n))}${'☆'.repeat(5 - Math.round(n))}</span>`;
const sellerRating = (id) => q.get('SELECT COUNT(*) n, AVG(rating) avg FROM reviews WHERE seller_id = ?', id);
const place = (u) => [u.city || u.seller_city, u.region || u.seller_region, u.country || u.seller_country].filter(Boolean).join(', ');

// ---------- Home ----------
r.get('/', (req, res) => {
  const latest = L.searchListings({ sort: 'newest' }).items.slice(0, 12);
  const cats = L.facets().categories;
  const disc = D.withPreviews(D.discoverSellers({ per: 8 }).items), fol = D.followedSet(req.user);
  const sellerStrip = disc.length ? `<section class="discover" aria-labelledby="disc-h"><div class="sechead"><h2 id="disc-h">Discover Sellers</h2><a href="/sellers" class="small">View all sellers →</a></div><p class="muted small" style="margin:-6px 0 10px">Real stores, most recently listed first.</p>
    <div class="scroller" role="list">${disc.map((s) => `<div role="listitem" class="scroller-item">${D.sellerCard(s, { following: fol, user: req.user })}</div>`).join('')}</div></section>` : '';
  const body = `<section class="hero"><p class="hero-kicker">PairPlug</p><h1>The Clothing Marketplace.</h1><p class="hero-sub">Discover independent sellers, find your next favorite piece, and follow the stores bringing fresh drops.</p>
    <form action="/shop" role="search"><label class="sr" for="hq2">Search listings</label><input id="hq2" name="q" type="search" placeholder="Search brand, item or size"><button class="btn">Search</button></form></section>
    <div class="chips" aria-label="Categories">${config.categories.map(([s, n]) => `<a class="chip" href="/shop?category=${s}">${esc(n)}${cats[s] ? ` <span class="muted">${cats[s]}</span>` : ''}</a>`).join('')}</div>
    ${sellerStrip}
    <div class="sechead"><h2>Just listed</h2><a href="/shop?sort=newest" class="small">View all →</a></div>
    ${latest.length ? V.grid(latest, { favs: favSet(req.user) }) : V.empty('No listings yet', 'The marketplace is empty right now. Check back soon.', ['/shop', 'Browse the shop'])}`;
  page(req, res, { title: 'The Clothing Marketplace', body });
});

// ---------- Shop ----------
r.get('/shop', (req, res) => {
  const f = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]));
  let result, error = '';
  try { result = L.searchListings(f); } catch (e) { console.error(e); error = 'Search is temporarily unavailable. Please try again.'; result = { items: [], total: 0, page: 1, pages: 1 }; }
  const fx = L.facets();
  const params = Object.fromEntries(['q', 'category', 'brand', 'size', 'condition', 'min', 'max', 'sort', 'seller'].filter((k) => f[k]).map((k) => [k, f[k]]));
  const without = (k) => '/shop?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([x]) => x !== k)));
  const label = { category: (v) => (config.categories.find((c) => c[0] === v) || [])[1] || v, condition: (v) => config.conditions[v] || v, min: (v) => `Min $${v}`, max: (v) => `Max $${v}`, q: (v) => `"${v}"` };
  const tags = Object.entries(params).filter(([k]) => k !== 'sort').map(([k, v]) => `<a class="tag" href="${without(k)}" aria-label="Remove filter ${esc(k)}">${esc((label[k] || ((x) => x))(v))}</a>`).join('');
  const radio = (name, items, cur) => items.map(([v, l]) => `<label><input type="radio" name="${name}" value="${esc(v)}"${cur === v ? ' checked' : ''}> ${esc(l)}</label>`).join('');
  const filters = `<aside class="filters" aria-label="Filters"><form id="ff" method="get">
    ${f.q ? `<input type="hidden" name="q" value="${esc(f.q)}">` : ''}<input type="hidden" name="sort" value="${esc(f.sort || '')}">
    <details open><summary>Category</summary><div class="opts"><label><input type="radio" name="category" value=""${!f.category ? ' checked' : ''}> All</label>${radio('category', config.categories.map(([s, n]) => [s, n]), f.category)}</div></details>
    <details${f.brand ? ' open' : ''}><summary>Brand</summary><div class="opts scroll">${fx.brands.length ? radio('brand', [['', 'Any'], ...fx.brands.map((b) => [b, b])], f.brand || '') : '<span class="muted small">No brands yet</span>'}</div></details>
    <details${f.size ? ' open' : ''}><summary>Size</summary><div class="opts scroll">${fx.sizes.length ? radio('size', [['', 'Any'], ...fx.sizes.map((b) => [b, b])], f.size || '') : '<span class="muted small">No sizes yet</span>'}</div></details>
    <details open><summary>Condition</summary><div class="opts">${radio('condition', [['', 'Any'], ...Object.entries(config.conditions)], f.condition || '')}</div></details>
    <details open><summary>Price</summary><div class="row pair" style="margin-top:6px"><div><label class="sr" for="pmin">Min price</label><input id="pmin" name="min" inputmode="decimal" placeholder="Min $" value="${esc(f.min || '')}"></div><div><label class="sr" for="pmax">Max price</label><input id="pmax" name="max" inputmode="decimal" placeholder="Max $" value="${esc(f.max || '')}"></div></div></details>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn small">Apply</button><a class="btn small ghost" href="/shop">Reset</a></div></form></aside>`;
  const tab = f.tab === 'sellers' ? 'sellers' : 'products';
  const spage = tab === 'sellers' ? f.page : 1;
  let sellerRes = { items: [], total: 0, page: 1, pages: 1 };
  if (f.q || tab === 'sellers') { try { sellerRes = D.searchSellers(f.q || '', { page: spage, per: tab === 'sellers' ? 12 : 3 }); } catch (e) { console.error(e); } }
  if (f.q && !(parseInt(f.page, 10) > 1)) { try { D.recordSearch(f.q, req.ip); } catch (e) { console.error(e); } }       // genuine searches only; see src/discovery.js for privacy rules
  const fol = D.followedSet(req.user), qs = (o) => '/shop?' + new URLSearchParams(o);
  const tabs = f.q || tab === 'sellers' ? `<nav class="tabs" aria-label="Result type"><a href="${qs({ ...(f.q ? { q: f.q } : {}), })}"${tab === 'products' ? ' aria-current="page"' : ''}>Products <span class="muted">${result.total}</span></a><a href="${qs({ ...(f.q ? { q: f.q } : {}), tab: 'sellers' })}"${tab === 'sellers' ? ' aria-current="page"' : ''}>Sellers <span class="muted">${sellerRes.total}</span></a></nav>` : '';
  if (tab === 'sellers') {
    const cards = D.withPreviews(sellerRes.items, { term: f.q || '' });
    return page(req, res, { title: f.q ? `Sellers: “${f.q}”` : 'Sellers', body: `<h1>${f.q ? `Sellers for “${esc(f.q)}”` : 'Sellers'}</h1>${tabs}
      ${cards.length ? `<div class="sgrid">${cards.map((x) => D.sellerCard(x, { following: fol, user: req.user })).join('')}</div>${V.pager(sellerRes.page, sellerRes.pages, { ...(f.q ? { q: f.q } : {}), tab: 'sellers' })}`
        : V.empty('No sellers match', f.q ? `No public seller matches “${f.q}” yet. Try another word, or see the products tab.` : 'No sellers yet.', [f.q ? qs({ q: f.q }) : '/shop', f.q ? 'See matching products' : 'Browse the shop'])}
      <p><a class="small" href="/shop">← Back to all results</a> · <a class="small" href="/sellers">View all sellers</a></p>` });
  }
  const related = f.q ? D.relatedDiscoveries(f.q) : { brands: [], categories: [] }, popular = f.q ? D.relatedPopular(f.q) : [];
  const sellerSec = f.q && sellerRes.items.length ? `<section class="sec-sellers" aria-labelledby="ss-h"><div class="sechead"><h2 id="ss-h">Seller profiles</h2><a class="small" href="${qs({ q: f.q, tab: 'sellers' })}">See all ${sellerRes.total} →</a></div><div class="sgrid">${D.withPreviews(sellerRes.items, { term: f.q }).map((x) => D.sellerCard(x, { following: fol, user: req.user })).join('')}</div></section>` : '';
  const popSec = popular.length ? `<section aria-labelledby="pop-h"><h2 id="pop-h">Popular searches</h2><div class="chips">${popular.map((t) => `<a class="chip" href="${qs({ q: t })}">${esc(t)}</a>`).join('')}</div></section>` : '';
  const relSec = related.brands.length || related.categories.length ? `<section aria-labelledby="rel-h"><h2 id="rel-h">Related discoveries</h2><div class="chips">${related.brands.map((b) => `<a class="chip" href="${qs({ q: f.q, brand: b.v })}">${esc(b.v)} <span class="muted">${b.n}</span></a>`).join('')}${related.categories.map((c) => `<a class="chip" href="${qs({ q: f.q, category: c.v })}">${esc(c.label)} <span class="muted">${c.n}</span></a>`).join('')}</div></section>` : '';
  const body = `<h1>${f.q ? `Results for “${esc(f.q)}”` : 'Shop'}</h1>${tabs}<p class="muted small">${result.total} item${result.total === 1 ? '' : 's'}</p>
  <div class="shop">${filters}<section>
    <div class="toolbar"><div class="tags">${tags}${tags ? '<a class="small" href="/shop">Clear all</a>' : ''}</div>
    <form method="get">${Object.entries(params).filter(([k]) => k !== 'sort').map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}
    <label class="sr" for="sort">Sort</label><select id="sort" name="sort" data-autosubmit>${[['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low']].map(([v, l]) => `<option value="${v}"${(f.sort || 'newest') === v ? ' selected' : ''}>${l}</option>`).join('')}</select><noscript><button>Sort</button></noscript></form></div>
    ${error ? `<div class="form-err" role="alert">${esc(error)}</div>` : ''}
    ${result.items.length ? V.grid(result.items, { favs: favSet(req.user) }) + V.pager(result.page, result.pages, params)
      : V.empty(f.q || tags ? 'No matching items' : 'No listings yet', f.q || tags ? (sellerRes.total ? 'No products match, but matching sellers are shown below. Try removing a filter or searching for something broader.' : 'Try removing a filter or searching for something broader.') : 'Nothing has been listed yet.', tags ? ['/shop', 'Clear filters and see all results'] : ['/shop', 'Browse the shop'])}
    ${sellerSec}${popSec}${relSec}
  </section></div>`;
  page(req, res, { title: f.q ? `“${f.q}”` : 'Shop', body });
});

// Direct-checkout buy box: shows exactly what the buyer will pay and who they pay BEFORE they leave PairPlug.
function directBuyBox(l, user) {
  const t = X.terms(l);
  const rows = `<div class="summary-row"><span>Item</span><span>${money(t.itemCents)}</span></div>
    <div class="summary-row"><span>Shipping</span><span>${t.shippingPayer === 'seller' ? 'Free (seller pays)' : money(t.shippingCents) + ' flat'}</span></div>
    <div class="summary-row total"><span>You pay the seller</span><span>${money(t.totalCents)}</span></div>`;
  let cta;
  if (l.status === 'sold') cta = '<button class="btn block" disabled>Sold</button>';
  else if (l.status === 'reserved') cta = '<button class="btn block" disabled>Reserved — another buyer is paying</button><p class="small muted" style="margin:6px 0 0">If they don\'t complete payment, this item becomes available again.</p>';
  else if (l.status !== 'active') cta = '';
  else if (!X.purchasable(l).ok) cta = `<p class="small muted" style="margin:0">${esc(X.purchasable(l).reason)} Use <strong>Contact seller</strong> to arrange payment and shipping.</p>`;   // no fake checkout button
  else cta = `<a class="btn block" href="/buy/${l.id}">Buy now</a><p class="small muted" style="margin:6px 0 0">You'll pay <strong>${esc(l.seller_name || l.seller_handle)}</strong> directly through their own Stripe checkout. PairPlug doesn't process or hold your payment and can't guarantee a refund. <a href="/buy/${l.id}">How it works</a></p>`;
  return `<div class="panel" style="margin:14px 0">${rows}${cta ? `<div style="margin-top:12px">${cta}</div>` : ''}</div>`;
}

// ---------- Listing detail ----------
r.get('/listing/:id(\\d+)', (req, res) => {
  const l = L.getListing(Number(req.params.id));
  const owner = req.user && l && l.seller_id === req.user.id;
  if (!l || (['draft', 'archived'].includes(l.status) && !owner)) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Listing not found', 'It may have been removed or is no longer available.', ['/shop', 'Browse the shop']) }));
  const rate = sellerRating(l.seller_id), seller = place({ city: l.seller_city, region: l.seller_region, country: l.seller_country });
  const faved = favSet(req.user).has(l.id);
  const mine = owner, avail = l.status === 'active';
  const status = { active: 'Available', reserved: 'Reserved — another buyer is checking out', sold: 'Sold', draft: 'Draft (only you can see this)', archived: 'Archived (only you can see this)' }[l.status];
  const inCart = req.user && q.get('SELECT 1 x FROM cart_items WHERE user_id=? AND listing_id=?', req.user.id, l.id);
  const ext = X.isExternal();
  const body = `<div class="product">
  <div class="gallery"><div class="main">${l.images.length ? `<img id="gmain" src="/uploads/${esc(l.images[0])}" alt="${esc(l.title)}">` : '<div class="noimg" style="height:100%"></div>'}</div>
  ${l.images.length > 1 ? `<div class="thumbs">${l.images.map((f, i) => `<button type="button" data-thumb="/uploads/${esc(f)}" aria-current="${i === 0}" aria-label="Photo ${i + 1}"><img src="/uploads/${esc(f)}" alt=""></button>`).join('')}</div>` : ''}</div>
  <div><h1>${esc(l.title)}</h1><div class="pprice">${money(l.price_cents)} <span class="muted small">${esc(l.currency || 'USD')}</span></div>
    <div>${avail ? '<span class="pill s-active">Available</span>' : `${V.statusPill(l.status)} <span class="muted small">${esc(status)}</span>`}</div>
    <dl class="facts">${l.brand ? `<dt>Brand</dt><dd>${esc(l.brand)}</dd>` : ''}${l.size ? `<dt>Size</dt><dd>${esc(l.size)}</dd>` : ''}${l.condition ? `<dt>Condition</dt><dd>${esc(config.conditions[l.condition])}</dd>` : ''}
      <dt>Category</dt><dd><a href="/shop?category=${esc(l.category)}">${esc((config.categories.find((c) => c[0] === l.category) || [])[1])}</a></dd>
      ${l.status === 'active' && l.quantity > 1 ? `<dt>Available</dt><dd>${l.quantity} units</dd>` : ''}
      <dt>Shipping</dt><dd>${l.shipping_payer === 'seller' || !l.shipping_cents ? '<strong>Free shipping</strong> — the seller covers the label' : `${money(l.shipping_cents)} flat fee, paid by the buyer`}</dd>
      <dt>Ships from</dt><dd>${esc(seller || '—')} ${isLocalShip(l.seller_country) ? '<span class="badge-local">Local ship</span>' : ''}</dd></dl>
    ${ext && !mine ? directBuyBox(l, req.user) : ''}
    ${mine ? `<a class="btn block" href="/dashboard/listings/${l.id}/edit">Edit listing</a>` : ext ? `<p style="margin:8px 0 0">${['active', 'reserved', 'sold'].includes(l.status) ? `<button class="btn small" data-chat-start="${l.id}">Contact seller</button> ` : ''}<button class="btn ghost small${faved ? ' on' : ''}" data-fav="${l.id}" aria-pressed="${faved}" aria-label="${faved ? 'Remove from favorites' : 'Save to favorites'}">${V.icon('heart')} Save</button></p>` : `${['active', 'reserved', 'sold'].includes(l.status) ? `<p style="margin:0 0 4px"><button class="btn ghost small" data-chat-start="${l.id}">Contact seller</button></p>` : ''}<div class="buybox">
      ${avail ? (inCart ? '<a class="btn" href="/cart">In cart — view cart</a>' : `<button class="btn" data-cart-add="${l.id}" data-buy>Buy now</button><button class="btn ghost" data-cart-add="${l.id}">Add to cart</button>`) : `<button class="btn" disabled>${l.status === 'sold' ? 'Sold' : 'Unavailable'}</button>`}
      <button class="btn ghost${faved ? ' on' : ''}" style="flex:0" data-fav="${l.id}" aria-pressed="${faved}" aria-label="${faved ? 'Remove from favorites' : 'Save to favorites'}">${V.icon('heart')}</button></div>`}
    ${l.description ? `<h2>Description</h2><p style="white-space:pre-wrap">${esc(l.description)}</p>` : ''}
    <div class="panel" style="margin-top:18px"><a href="/s/${esc(l.seller_handle)}" style="text-decoration:none"><strong>${esc(l.seller_name || l.seller_handle)}</strong></a>
      <div class="small muted">${RV.line(l.seller_id) || 'No reviews yet'} · Member since ${date(l.seller_since).slice(0, 4)}</div>
      ${l.seller_bio ? `<p class="small">${esc(l.seller_bio)}</p>` : ''}
      <p class="small muted" style="margin:6px 0 0">${ext ? 'You pay this seller directly. PairPlug does not hold or refund payments — message the seller about any payment problem.' : 'Payment is held in escrow until you confirm delivery.'}</p><p class="small muted" style="margin:4px 0 0">PairPlug sellers aim to reply within 48 hours (an expectation, not a guarantee).</p></div></div></div>`;
  page(req, res, { title: l.title, body, description: l.description.slice(0, 150) });
});

// ---------- Seller storefront ----------
r.get('/s/:handle', (req, res) => {
  const s = q.get('SELECT * FROM users WHERE handle = ? AND is_seller = 1 AND banned = 0', req.params.handle);
  if (!s) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Seller not found', 'This storefront does not exist.', ['/shop', 'Browse the shop']) }));
  const result = L.searchListings({ seller: s.handle, sort: req.query.sort, page: req.query.page });
  const rate = sellerRating(s.id), sold = q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND status = 'released'", s.id).n;
  const reviews = q.all('SELECT r.*, u.display_name FROM reviews r JOIN users u ON u.id = r.buyer_id WHERE r.seller_id = ? ORDER BY r.created_at DESC LIMIT 5', s.id);
  const body = `<div class="storehead"><div class="avatar" aria-hidden="true">${esc((s.store_name || s.handle)[0].toUpperCase())}</div><div><h1>${esc(s.store_name || s.handle)}</h1>
    <div class="muted small">@${esc(s.handle)} · ${esc(place(s))} ${isLocalShip(s.country) ? '<span class="badge-local">Local ship</span>' : ''}</div>
    <div class="small">${RV.line(s.id) || '<span class="muted">No reviews yet</span>'} · ${sold} completed sale${sold === 1 ? '' : 's'}</div></div></div>
    ${s.bio ? `<p>${esc(s.bio)}</p>` : ''}<h2>Available (${result.total})</h2>
    ${result.items.length ? V.grid(result.items, { favs: favSet(req.user) }) + V.pager(result.page, result.pages, {}) : V.empty('No listings yet', 'No listings yet — check back for their next drop.')}
    ${RV.section(s.id, req.user)}`;
  page(req, res, { title: s.store_name || s.handle, body });
});

// ---------- Auth pages + API ----------
const authForm = (kind, next) => {
  const reg = kind === 'register';
  return `<div class="narrow panel"><h1>${reg ? 'Create your account' : 'Log in'}</h1>
  <p class="muted small" style="margin-top:-6px">${reg ? 'Join PairPlug — The Clothing Marketplace. A free buyer account lets you follow independent sellers, message them, save favorites and order. Selling is invitation-only during the private beta.' : 'Welcome back to PairPlug — The Clothing Marketplace. Approved beta sellers and staff sign in here too.'}</p>
  <form data-api="/api/${kind}" data-redirect="${esc(next)}" novalidate>
    ${reg ? '<label for="n">Name</label><input id="n" name="display_name" autocomplete="name" required>' : ''}
    <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required>
    <label for="p">Password ${reg ? '<span class="opt">(8+ characters)</span>' : ''}</label><input id="p" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="${reg ? 8 : 1}">
    <input type="hidden" name="next" value="${esc(next)}">
    ${reg ? `<label style="font-weight:400;display:flex;gap:8px;margin-top:12px"><input type="checkbox" name="terms" required> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and have read the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="/payments" target="_blank" rel="noopener">how payments and refunds work</a>.</span></label>` : ''}
    <button class="btn block" type="submit" style="margin-top:16px">${reg ? 'Sign up' : 'Log in'}</button></form>
  <p class="small muted" style="margin-top:14px">${reg ? 'Already have an account? <a href="/login">Log in</a>' : 'New here? <a href="/register">Create an account</a>'}${reg ? '' : '<br><a href="/forgot-password">Forgot your password?</a>'}<br>Questions or trouble signing in? <a href="/contact">Contact us</a> or email ${V.contactLink()}.</p></div>`;
};
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : '/');
r.get('/login', (req, res) => (req.user ? res.redirect('/') : page(req, res, { title: 'Log in', body: authForm('login', safeNext(req.query.next)) })));
r.get('/register', (req, res) => (req.user ? res.redirect('/') : page(req, res, { title: 'Sign up', body: authForm('register', safeNext(req.query.next)) })));

r.post('/api/register', wrap(async (req, res) => {
  auth.rateLimit('reg:' + req.ip, 10, 600);
  const email = cleanLine(req.body.email, 200).toLowerCase(), name = cleanLine(req.body.display_name, 80), pw = String(req.body.password || '');
  const fields = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email address.';
  if (name.length < 2) fields.display_name = 'Enter your name.';
  if (pw.length < 8 || pw.length > 200) fields.password = 'Use at least 8 characters.';
  if (req.body.terms !== true) fields.terms = 'Please accept the Terms of Service and Privacy Policy to create an account.';
  if (!fields.email && q.get('SELECT 1 x FROM users WHERE email = ?', email)) fields.email = 'An account with this email already exists.';
  if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the highlighted fields.', fields);
  const u = q.run('INSERT INTO users(email, password_hash, display_name, created_at, terms_version, terms_accepted_at) VALUES(?,?,?,?,?,?)', email, auth.hashPassword(pw), name, now(), LEGAL.VERSION, now());
  auth.createSession(res, Number(u.lastInsertRowid));
  res.json({ ok: true, redirect: safeNext(req.body.next) });
}));
r.post('/api/login', wrap(async (req, res) => {
  const email = cleanLine(req.body.email, 200).toLowerCase();
  auth.rateLimit(`login:${req.ip}:${email}`, 8, 600);
  const u = q.get('SELECT * FROM users WHERE email = ?', email);
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const ok = u ? auth.verifyPassword(String(req.body.password || ''), u.password_hash) : (auth.verifyPassword('x', auth.DUMMY_HASH), false);
  if (!u || !ok) throw new HttpError(401, 'Incorrect email or password.');
  if (u.banned) throw new HttpError(403, `This account has been suspended. To ask about it or appeal, email ${config.supportEmail}.`);
  auth.createSession(res, u.id);
  res.json({ ok: true });
}));
r.post('/api/logout', (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

// ---------- Account / notifications / favorites ----------
r.get('/account', auth.requireUser, (req, res) => {
  const u = req.user;
  page(req, res, { title: 'Account', body: `<h1>Account</h1><div class="panel form-wide"><form data-api="/api/account" data-method="PATCH">
    <label for="dn">Name</label><input id="dn" name="display_name" value="${esc(u.display_name)}">
    <label for="em">Email</label><input id="em" value="${esc(u.email)}" disabled>
    <button class="btn" type="submit" style="margin-top:14px">Save</button></form></div>
    ${u.is_seller ? `<p><a href="/dashboard">Go to seller dashboard →</a> · <a href="/s/${esc(u.handle)}">View my storefront</a></p>` : '<p class="muted small">Selling is invitation-only during the private beta.</p>'}` });
});
r.patch('/api/account', auth.requireUser, (req, res) => {
  const name = cleanLine(req.body.display_name, 80);
  if (name.length < 2) throw new HttpError(422, 'Please fix the highlighted fields.', { display_name: 'Enter your name.' });
  q.run('UPDATE users SET display_name = ? WHERE id = ?', name, req.user.id);
  res.json({ ok: true, message: 'Account updated' });
});
r.get('/notifications', auth.requireUser, (req, res) => {
  const ns = q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', req.user.id);
  q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), req.user.id);
  page(req, res, { title: 'Notifications', body: `<h1>Notifications</h1><p class="muted small">In-app only — email/SMS/push are not configured.</p>
    ${ns.length ? ns.map((n) => `<div class="panel notif">${n.image ? `<a href="${esc(n.link || '#')}" class="notif-img">${V.img(n.image, 'thumb', '')}</a>` : ''}<div><strong>${n.link ? `<a href="${esc(n.link)}">${esc(n.title)}</a>` : esc(n.title)}</strong>${n.read_at ? '' : ' <span class="pill s-active">new</span>'}<div class="small muted">${esc(n.body || '')} · ${date(n.created_at)}</div></div></div>`).join('') : V.empty('No notifications', 'Order updates, shipping updates and price drops on saved items show up here.')}` });
});
r.get('/favorites', auth.requireUser, (req, res) => {
  const items = q.all(`SELECT l.*, ${L.IMG_SQL}, ${L.SELLER_SQL} FROM favorites f JOIN listings l ON l.id = f.listing_id JOIN users u ON u.id = l.seller_id
    WHERE f.user_id = ? AND l.status IN ('active','reserved','sold') ORDER BY f.created_at DESC`, req.user.id);
  page(req, res, { title: 'Favorites', body: `<h1>Favorites</h1>${items.length ? V.grid(items, { favs: new Set(items.map((i) => i.id)) }) : V.empty('Nothing saved yet', 'Tap the heart on any item to save it here.', ['/shop', 'Browse the shop'])}` });
});
r.put('/api/favorites/:id', auth.requireUser, (req, res) => {
  const l = q.get("SELECT id FROM listings WHERE id = ? AND status IN ('active','reserved','sold')", Number(req.params.id));
  if (!l) throw new HttpError(404, 'Listing not found');
  q.run('INSERT OR IGNORE INTO favorites(user_id, listing_id, created_at) VALUES(?,?,?)', req.user.id, l.id, now());
  res.json({ ok: true });
});
r.delete('/api/favorites/:id', auth.requireUser, (req, res) => { q.run('DELETE FROM favorites WHERE user_id = ? AND listing_id = ?', req.user.id, Number(req.params.id)); res.json({ ok: true }); });

// ---------- Cart ----------
r.get('/cart', auth.requireUser, (req, res) => {
  const qt = checkout.quote(req.user.id);
  const lines = qt.lines.map((l) => `<div class="line"><a href="/listing/${l.id}">${V.img(l.image, 'thumb', l.title)}</a>
    <div><a href="/listing/${l.id}"><strong>${esc(l.title)}</strong></a><div class="muted small">${esc([l.size && 'Size ' + l.size, l.condition && config.conditions[l.condition]].filter(Boolean).join(' · '))} · Sold by ${esc(l.seller_name || l.seller_handle)}</div>
      ${l.available ? '<div class="small muted">Unique item · quantity 1</div>' : `<div class="err">No longer available</div>`}
      <button class="btn ghost small" data-cart-remove="${l.id}" style="margin-top:6px">Remove</button></div>
    <div><strong>${money(l.price_cents)}</strong></div></div>`).join('');
  const body = `<h1>Cart</h1>${qt.lines.length ? `<div class="two"><section class="panel">${lines}</section>${summary(qt, '<a class="btn block" href="/checkout" style="margin-top:12px">Checkout</a>')}</div>`
    : V.empty('Your cart is empty', 'Find something you like and add it here.', ['/shop', 'Browse the shop'])}`;
  page(req, res, { title: 'Cart', body });
});
function summary(qt, cta) {
  return `<aside class="panel sticky"><h3>Order summary</h3>
    <div class="summary-row"><span>Items</span><span>${money(qt.subtotalCents)}</span></div>
    <div class="summary-row"><span>Shipping${qt.groups.length > 1 ? ` (${qt.groups.length} sellers)` : ''}</span><span>${qt.shippingCents ? money(qt.shippingCents) : 'Free'}</span></div>
    ${qt.taxRateBps ? `<div class="summary-row"><span>Estimated tax (${(qt.taxRateBps / 100).toFixed(2)}%)</span><span>${money(qt.taxCents)}</span></div>` : ''}
    <div class="summary-row total"><span>Total</span><span>${money(qt.totalCents)}</span></div>
    <p class="small muted">No buyer fee. Seller fees are deducted from the seller's payout. Your payment is held in escrow until you confirm delivery.</p>${cta || ''}</aside>`;
}
r.post('/api/cart', auth.requireUser, (req, res) => { checkout.addToCart(req.user.id, Number(req.body.listingId)); res.json({ ok: true }); });
r.delete('/api/cart/:id', auth.requireUser, (req, res) => { q.run('DELETE FROM cart_items WHERE user_id = ? AND listing_id = ?', req.user.id, Number(req.params.id)); res.json({ ok: true }); });

// ---------- Checkout ----------
r.get('/checkout', auth.requireUser, (req, res) => {
  const qt = checkout.quote(req.user.id), provider = payments.getProvider();
  if (!qt.lines.length) return res.redirect('/cart');
  const key = require('node:crypto').randomUUID();
  const field = (n, l, extra = '') => `<div><label for="a_${n}">${l}</label><input id="a_${n}" name="${n}" ${extra}></div>`;
  const body = `<h1>Checkout</h1>${!provider ? '<div class="form-err">Payments are not configured on this marketplace, so orders can\'t be placed yet. See the README for setup.</div>' : ''}
  ${qt.lines.some((l) => !l.available) ? '<div class="form-err">Some items are no longer available. <a href="/cart">Review your cart</a>.</div>' : ''}
  <div class="two"><section class="panel"><h3>Shipping address</h3><p class="small muted">We ship within the US, Canada and Mexico.</p>
    <form id="ckform" data-checkout><input type="hidden" name="idempotencyKey" value="${key}">
      ${field('name', 'Full name', 'autocomplete="name" required')}${field('line1', 'Address', 'autocomplete="address-line1" required')}${field('line2', 'Apt, suite <span class="opt">(optional)</span>', 'autocomplete="address-line2"')}
      <div class="row">${field('city', 'City', 'autocomplete="address-level2" required')}${field('region', 'State / province', 'autocomplete="address-level1" required')}${field('postal', 'ZIP / postal code', 'autocomplete="postal-code" required')}</div>
      <label for="a_country">Country</label><select id="a_country" name="country"><option value="US">United States</option><option value="CA">Canada</option><option value="MX">Mexico</option></select>
      <button class="btn block" style="margin-top:16px" ${provider && !qt.lines.some((l) => !l.available) ? '' : 'disabled'}>${provider && provider.sandbox ? 'Continue to sandbox payment' : 'Continue to payment'}</button></form></section>
    ${summary(qt)}</div>`;
  const script = `<script>document.getElementById('ckform').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,b=f.querySelector('button');b.disabled=true;f.querySelectorAll('.err,.form-err').forEach(x=>x.remove());
    const d=Object.fromEntries(new FormData(f));try{const r=await pp.api('POST','/api/checkout',{idempotencyKey:d.idempotencyKey,address:d});location.href=r.redirectUrl}catch(x){if(x.fields)for(const[k,m]of Object.entries(x.fields)){const el=f.elements[k];if(el)el.insertAdjacentHTML('afterend','<div class="err">'+m+'</div>')}f.insertAdjacentHTML('afterbegin','<div class="form-err" role="alert"></div>');f.firstChild.textContent=x.message;b.disabled=false}})</script>`;
  res.send(V.layout({ user: req.user, path: '/checkout', title: 'Checkout', body, scripts: script }));
});
r.post('/api/checkout', auth.requireUser, wrap(async (req, res) => {
  res.json(await checkout.createCheckout(req.user, { address: req.body.address, idempotencyKey: req.body.idempotencyKey }));
}));

// Sandbox payment page: ONLY exists when PAYMENTS_MODE=sandbox. It sends a signed webhook, like a real provider would.
r.get('/pay/:id(\\d+)', auth.requireUser, (req, res) => {
  const prov = payments.getProvider();
  const ck = q.get('SELECT * FROM checkouts WHERE id = ? AND buyer_id = ?', Number(req.params.id), req.user.id);
  if (!prov || !prov.sandbox || !ck) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Not found', '') }));
  if (ck.status !== 'pending') return res.redirect(`/checkout/${ck.id}`);
  const body = `<div class="narrow panel"><h1>Sandbox payment</h1><p class="muted">Test environment — no card is charged. This page simulates the payment provider sending a signed webhook.</p>
    <div class="summary-row total"><span>Amount</span><span>${money(ck.total_cents)}</span></div>
    <p class="small muted">Items are held for you until ${new Date(ck.expires_at * 1000).toLocaleTimeString()}.</p>
    <button class="btn block" data-post="/api/sandbox/pay/${ck.id}" data-body='{"outcome":"succeeded"}' data-redirect="/checkout/${ck.id}">Pay ${money(ck.total_cents)} (test)</button>
    <button class="btn ghost block" style="margin-top:8px" data-post="/api/sandbox/pay/${ck.id}" data-body='{"outcome":"failed"}' data-redirect="/checkout/${ck.id}">Simulate declined card</button></div>`;
  page(req, res, { title: 'Sandbox payment', body });
});
r.post('/api/sandbox/pay/:id(\\d+)', auth.requireUser, wrap(async (req, res) => {
  const prov = payments.getProvider();
  if (!prov || !prov.sandbox) throw new HttpError(404, 'Not found');
  const ck = q.get('SELECT * FROM checkouts WHERE id = ? AND buyer_id = ?', Number(req.params.id), req.user.id);
  if (!ck) throw new HttpError(404, 'Not found');
  const raw = JSON.stringify({ id: `evt_${ck.id}_${req.body.outcome}`, type: req.body.outcome === 'failed' ? 'payment_failed' : 'payment_succeeded', checkoutId: ck.id, amountCents: ck.total_cents });
  const resp = await fetch(`http://127.0.0.1:${config.port}/webhooks/payments/sandbox`, { method: 'POST', headers: { 'x-sandbox-signature': prov.sign(raw), 'content-type': 'application/json' }, body: raw });
  res.status(resp.status).json(await resp.json());
}));

r.get('/checkout/:id(\\d+)', auth.requireUser, (req, res) => {
  const ck = q.get('SELECT * FROM checkouts WHERE id = ? AND buyer_id = ?', Number(req.params.id), req.user.id);
  if (!ck) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Not found', '') }));
  const orders = q.all('SELECT * FROM orders WHERE checkout_id = ?', ck.id);
  const msg = { paid: ['Order confirmed', 'Thanks! Your payment is held in escrow and released to the seller after you receive the item.'],
    pending: ['Waiting for payment confirmation', 'We only confirm an order once the payment provider tells us it succeeded. Refresh in a moment.'],
    failed: ['Payment failed', 'Your card was not charged and the items were released.'], expired: ['Checkout expired', 'The hold on your items timed out.'] }[ck.status];
  page(req, res, { title: msg[0], body: `<div class="narrow panel" style="max-width:560px"><h1>${msg[0]}</h1><p class="muted">${msg[1]}</p>
    ${orders.map((o) => `<div class="summary-row"><a href="/orders/${o.id}">Order #${o.id}</a><span>${money(o.total_cents)} ${V.statusPill(o.status)}</span></div>`).join('')}
    <p><a class="btn" href="/orders">View my orders</a> ${ck.status === 'pending' && payments.getProvider() && payments.getProvider().sandbox ? `<a class="btn ghost" href="/pay/${ck.id}">Back to payment</a>` : ''}</p></div>` });
});

// ---------- Buyer orders ----------
r.get('/orders', auth.requireUser, (req, res) => {
  const orders = q.all(`SELECT o.*, u.store_name, u.handle FROM orders o JOIN users u ON u.id = o.seller_id WHERE o.buyer_id = ? AND (o.status <> 'cancelled' OR o.payment_mode = 'external') ORDER BY o.created_at DESC, o.id DESC LIMIT 200`, req.user.id);
  const rows = orders.map((o) => {
    const items = q.all('SELECT * FROM order_items WHERE order_id = ?', o.id);
    return `<tr><td><a href="/orders/${o.id}">#${o.id}</a><div class="muted small">${o.payment_mode === 'external' ? `PP-${o.id} · ` : ''}${date(o.created_at)}</div></td>
      <td><div style="display:flex;gap:8px;align-items:center">${V.img(items[0] && items[0].image, 'thumb')}<div>${items.map((i) => esc(i.title)).join('<br>')}<div class="muted small">${esc(o.store_name || o.handle)}</div></div></div></td>
      <td class="num">${money(o.total_cents)}</td><td>${V.orderPill(o)}</td><td>${o.tracking_number ? `${esc(o.carrier || '')} ${esc(o.tracking_number)}` : '<span class="muted">—</span>'}</td></tr>`;
  }).join('');
  page(req, res, { title: 'My orders', body: `<h1>My orders</h1>${orders.length ? `<div class="tablewrap"><table><thead><tr><th>Order</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Tracking</th></tr></thead><tbody>${rows}</tbody></table></div>` : V.empty('No orders yet', 'When you buy something it will show up here.', ['/shop', 'Browse the shop'])}` });
});

const STEPS = ['paid', 'shipped', 'delivered', 'released'];
r.get('/orders/:id(\\d+)', auth.requireUser, (req, res) => {
  const o = q.get(`SELECT o.*, u.store_name, u.handle FROM orders o JOIN users u ON u.id = o.seller_id WHERE o.id = ? AND (o.buyer_id = ? OR o.seller_id = ?)`, Number(req.params.id), req.user.id, req.user.id);
  if (!o) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Order not found', '', ['/orders', 'My orders']) }));
  const isBuyer = o.buyer_id === req.user.id;
  const items = q.all('SELECT * FROM order_items WHERE order_id = ?', o.id), events = q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', o.id);
  const dispute = q.get('SELECT * FROM disputes WHERE order_id = ?', o.id), review = q.get('SELECT * FROM reviews WHERE order_id = ?', o.id);
  const ck = q.get('SELECT * FROM checkouts WHERE id = ?', o.checkout_id);
  const canDispute = isBuyer && !dispute && ['paid', 'shipped', 'delivered'].includes(o.status);
  const body = `<h1>Order #${o.id} ${V.statusPill(o.status)}</h1><p class="muted small">Placed ${date(o.created_at)} · ${isBuyer ? 'Sold by <a href="/s/' + esc(o.handle) + '">' + esc(o.store_name || o.handle) + '</a>' : 'You are the seller'}</p>
  <div class="two"><section>
    <div class="panel">${items.map((i) => `<div class="line"><a href="/listing/${i.listing_id}">${V.img(i.image, 'thumb', i.title)}</a><div><a href="/listing/${i.listing_id}"><strong>${esc(i.title)}</strong></a></div><div>${money(i.price_cents)}</div></div>`).join('')}</div>
    <div class="panel"><h3>Shipping</h3><p style="margin:0">${esc(ck.ship_name)}<br>${esc(ck.ship_line1)} ${esc(ck.ship_line2 || '')}<br>${esc(ck.ship_city)}, ${esc(ck.ship_region)} ${esc(ck.ship_postal)} ${esc(ck.ship_country)}</p>
      <p>${o.tracking_number ? `Carrier: <strong>${esc(o.carrier || '—')}</strong> · Tracking: <strong>${esc(o.tracking_number)}</strong>` : '<span class="muted">No tracking yet.</span>'}</p></div>
    ${isBuyer && ['shipped', 'delivered'].includes(o.status) ? `<div class="panel"><h3>Got your item?</h3><p class="small muted">Confirming releases the payment to the seller. Only confirm once you've received it as described.${o.status === 'delivered' && o.auto_release_at ? ` Otherwise funds release automatically on ${date(o.auto_release_at)}.` : ''}</p>
      <button class="btn" data-post="/api/orders/${o.id}/confirm">Confirm receipt</button></div>` : ''}
    ${canDispute ? `<details class="panel"><summary><strong>Something wrong? Open a dispute</strong></summary>
      <form data-api="/api/orders/${o.id}/dispute" data-reload><label for="dr">What went wrong?</label><textarea id="dr" name="reason" required minlength="10" placeholder="Describe the issue (not received, not as described, damaged…)"></textarea>
      <label>Photos <span class="opt">(optional, up to 4)</span></label>${uploader('evidence', 4)}<button class="btn danger" type="submit" style="margin-top:12px">Open dispute</button></form></details>` : ''}
    ${dispute ? disputePanel(dispute, req.user) : ''}
    ${isBuyer ? RV.panel(o) : ''}
  </section><aside class="panel sticky"><h3>Payment</h3>
    <div class="summary-row"><span>Items</span><span>${money(o.subtotal_cents)}</span></div><div class="summary-row"><span>Shipping</span><span>${o.shipping_cents ? money(o.shipping_cents) : 'Free'}</span></div>
    ${o.tax_cents ? `<div class="summary-row"><span>Tax</span><span>${money(o.tax_cents)}</span></div>` : ''}<div class="summary-row total"><span>Total</span><span>${money(o.total_cents)}</span></div>
    ${o.refunded_cents ? `<div class="summary-row"><span>Refunded</span><span>${money(o.refunded_cents)}</span></div>` : ''}
    <h3 style="margin-top:16px">Progress</h3><ul class="timeline">${events.map((e) => `<li><strong>${esc(e.to_status.replace('_', ' '))}</strong> <span class="muted">${new Date(e.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</li>`).join('')}</ul></aside></div>`;
  res.send(V.layout({ user: req.user, path: '/orders', title: `Order #${o.id}`, body, scripts: '<script src="/uploader.js" defer></script>' }));
});

function uploader(name, max) {
  return `<div class="uploader" data-uploader="${name}" data-max="${max}"><label class="up-add"><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>+ Add photo</label></div><input type="hidden" name="${name}_json" data-uploader-value="${name}">`;
}
function disputePanel(d, viewer) {
  const ev = q.all('SELECT * FROM dispute_evidence WHERE dispute_id = ? ORDER BY id', d.id);
  const mk = (party) => ev.filter((e) => e.party === party).map((e) => `<div>${e.note ? `<p style="margin:6px 0">${esc(e.note)}</p>` : ''}${e.image ? `<a href="/uploads/${esc(e.image)}" target="_blank" rel="noopener"><img src="/uploads/${esc(e.image)}" alt="${party} evidence"></a>` : ''}</div>`).join('');
  const open = d.status === 'open';
  return `<div class="panel"><h3>Dispute ${V.statusPill(open ? 'disputed' : d.status.replace('resolved_', ''))}</h3><p><strong>Reason:</strong> ${esc(d.reason)}</p>
    <div class="evid"><div><strong>Buyer</strong>${mk('buyer') || '<p class="muted small">No evidence.</p>'}</div><div><strong>Seller</strong>${mk('seller') || '<p class="muted small">No response yet.</p>'}</div></div>
    ${d.resolution_note ? `<p><strong>Resolution:</strong> ${esc(d.resolution_note)}</p>` : ''}
    ${open && !viewer.is_admin ? `<form data-api="/api/orders/${d.order_id}/dispute/evidence" data-reload style="margin-top:12px"><label for="en">Add a message or photos</label><textarea id="en" name="note" maxlength="1000"></textarea>${uploader('evidence', 4)}<button class="btn small" type="submit" style="margin-top:8px">Submit</button></form>` : ''}</div>`;
}

r.post('/api/uploads', auth.requireUser, express.raw({ type: ['image/*'], limit: '6mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Send the image as the request body.');
  auth.rateLimit('up:' + req.user.id, 60, 600);
  res.json({ file: saveUpload(req.user.id, req.body) });
});

r.post('/api/orders/:id(\\d+)/confirm', auth.requireUser, (req, res) => { escrow.buyerConfirm(Number(req.params.id), req.user.id); res.json({ ok: true }); });

r.post('/api/orders/:id(\\d+)/dispute', auth.requireUser, (req, res) => {
  const reason = clean(req.body.reason, 2000);
  if (reason.length < 10) throw new HttpError(422, 'Please fix the highlighted fields.', { reason: 'Describe the problem in at least 10 characters.' });
  const images = ownedUploads(req.user.id, JSON.parse(req.body.evidence_json || '[]').slice(0, 4));
  tx(() => {
    const o = q.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', Number(req.params.id), req.user.id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (o.payment_mode === 'external') throw new HttpError(409, 'This order was paid directly to the seller. Message the seller about problems; refunds and payment disputes are handled by the seller and their payment provider.');
    if (q.get('SELECT 1 x FROM disputes WHERE order_id = ?', o.id)) throw new HttpError(409, 'A dispute is already open for this order.');
    transition(o.id, 'disputed', { actor: `buyer:${req.user.id}`, note: reason.slice(0, 120), set: { auto_release_at: null } });
    const d = q.run('INSERT INTO disputes(order_id, opened_by, reason, created_at) VALUES(?,?,?,?)', o.id, req.user.id, reason, now());
    images.forEach((f) => q.run("INSERT INTO dispute_evidence(dispute_id, user_id, party, image, created_at) VALUES(?,?, 'buyer', ?, ?)", d.lastInsertRowid, req.user.id, f, now()));
    notify(o.seller_id, `order:${o.id}:disputed`, 'Dispute opened', `The buyer opened a dispute on order #${o.id}. Add your evidence.`, `/orders/${o.id}`);
  });
  res.json({ ok: true });
});
r.post('/api/orders/:id(\\d+)/dispute/evidence', auth.requireUser, (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE id = ? AND (buyer_id = ? OR seller_id = ?)', Number(req.params.id), req.user.id, req.user.id);
  const d = o && o.payment_mode === 'platform' && q.get("SELECT * FROM disputes WHERE order_id = ? AND status = 'open'", o.id);
  if (!d) throw new HttpError(404, 'No open dispute');
  const images = ownedUploads(req.user.id, JSON.parse(req.body.evidence_json || '[]').slice(0, 4)), note = clean(req.body.note, 1000);
  if (!images.length && !note) throw new HttpError(422, 'Add a message or at least one photo.');
  const party = o.buyer_id === req.user.id ? 'buyer' : 'seller';
  tx(() => {
    if (note) q.run('INSERT INTO dispute_evidence(dispute_id, user_id, party, note, created_at) VALUES(?,?,?,?,?)', d.id, req.user.id, party, note, now());
    images.forEach((f) => q.run('INSERT INTO dispute_evidence(dispute_id, user_id, party, image, created_at) VALUES(?,?,?,?,?)', d.id, req.user.id, party, f, now()));
  });
  res.json({ ok: true });
});

// ---------- Webhooks (signature-verified, idempotent) ----------
r.post('/webhooks/payments/:provider', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const prov = payments.getProviderByName(req.params.provider);
  if (!prov) throw new HttpError(404, 'Unknown provider');
  const raw = req.body.toString('utf8');
  const ev = prov.verifyWebhook(raw, req.headers);
  res.json({ ok: true, ...payments.handlePaymentEvent(prov.name, ev) });
}));
r.post('/webhooks/tracking', express.json(), (req, res) => {
  // Carrier/aggregator webhook (Shippo, EasyPost, ...). Authenticated by a shared secret header.
  const secret = config.carrierWebhookSecret;
  if (!secret || req.headers['x-webhook-secret'] !== secret) throw new HttpError(401, 'Unauthorized');
  const { carrier, trackingNumber, status } = req.body || {};
  const o = q.get('SELECT * FROM orders WHERE carrier = ? AND tracking_number = ?', carrier, trackingNumber);
  if (!o) return res.json({ ok: true, ignored: true });
  q.run("UPDATE shipments SET tracking_status = ?, updated_at = ? WHERE order_id = ? AND test = 0 AND status = 'success' AND tracking_number = ?", String(status || '').slice(0, 40) || null, now(), o.id, trackingNumber);
  if (String(status).toUpperCase() === 'DELIVERED' && o.status === 'shipped') {
    if (o.payment_mode === 'external') { transition(o.id, 'delivered', { actor: 'carrier', note: 'Carrier reported delivered (authenticated webhook)', set: { delivered_at: now() } }); notify(o.buyer_id, `order:${o.id}:delivered`, 'Order delivered', `Order #${o.id}: the carrier reports it was delivered.`, `/orders/${o.id}`); }
    else escrow.markDelivered(o.id, 'carrier');
  }
  res.json({ ok: true });
});

module.exports = { router: r, uploader, wrap, page, place };
