'use strict';
// Public seller storefronts (published settings, or the owner's private draft preview) + the storefront editor.
const express = require('express');
const config = require('../config');
const { q } = require('../db');
const { esc, date } = require('../util');
const V = require('../views');
const auth = require('../auth');
const L = require('../listings');
const SF = require('../storefront');
const { isLocalShip } = require('../pricing');
const { uploader } = require('./buyer');
const D = require('../discovery');
const RV = require('../reviews');

const r = express.Router();
const stars = (n) => `<span class="stars" aria-label="${n.toFixed(1)} out of 5">${'★'.repeat(Math.round(n))}${'☆'.repeat(5 - Math.round(n))}</span>`;
const cssEtag = require('node:crypto').createHash('sha1').update(SF.themeCss()).digest('hex').slice(0, 10);

// Generated from the curated palette only (no user input), so it is safe to cache.
r.get('/storefront.css', (req, res) => res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(SF.themeCss()));

const EXPECT = 'PairPlug sellers aim to reply to messages within 48 hours. This is an expectation, not a guarantee.';

r.get('/s/:handle', (req, res) => {
  const s = q.get('SELECT * FROM users WHERE handle = ? AND is_seller = 1 AND banned = 0', req.params.handle);
  const missing = () => res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Seller not found', 'This storefront does not exist or is not available.', ['/shop', 'Browse the shop']) }));
  if (!s) return missing();
  if (s.selling_restricted_at && !(req.user && req.user.id === s.id)) return res.status(200).send(V.layout({ user: req.user, title: 'Store unavailable', body: V.empty('This store is temporarily unavailable', 'PairPlug is reviewing this store. Please check back later, or browse other sellers.', ['/sellers', 'Discover sellers']) }));
  const owner = req.user && req.user.id === s.id, wantPreview = req.query.preview === '1' && owner;   // previews are visible to the owner only
  const { settings: st, isDraft } = SF.effective(s.id, { preview: wantPreview });
  const featuredIds = st.featured || [];
  const featured = featuredIds.length ? L.searchListings({ seller: s.handle, sort: 'newest' }).items.filter((l) => featuredIds.includes(l.id)).sort((a, b) => featuredIds.indexOf(a.id) - featuredIds.indexOf(b.id)) : [];
  const result = L.searchListings({ seller: s.handle, sort: st.sort, page: req.query.page, exclude: featured.map((l) => l.id) });
  const rate = q.get('SELECT COUNT(*) n, AVG(rating) avg FROM reviews WHERE seller_id = ?', s.id);
  const sold = q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND status IN ('delivered','released')", s.id).n;
  const reviews = q.all('SELECT r.*, u.display_name FROM reviews r JOIN users u ON u.id = r.buyer_id WHERE r.seller_id = ? ORDER BY r.created_at DESC LIMIT 5', s.id);
  const favs = new Set(req.user ? q.all('SELECT listing_id FROM favorites WHERE user_id = ?', req.user.id).map((f) => f.listing_id) : []);
  const name = s.store_name || s.handle, place = [s.city, s.region, s.country].filter(Boolean).join(', ');
  const img = (f, cls, alt) => (f ? `<img class="${cls}" src="/uploads/${esc(f)}" alt="${esc(alt)}">` : '');
  const links = (st.links || []).map((l) => `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow ugc">${esc(l.kind)} ↗</a>`).join('');
  const body = `${isDraft ? '<div class="form-err" style="margin-bottom:12px"><strong>Preview.</strong> Only you can see these unpublished changes. <a href="/dashboard/storefront">Back to the editor</a></div>' : ''}
  <div class="store theme-${esc(st.theme)} acc-${esc(st.accent)}">
    <div class="store-banner">${img(st.banner, 'banner-img', '')}</div>
    <div class="store-head"><div class="store-id">${st.avatar ? img(st.avatar, 'avatar-img', `${name} profile picture`) : `<div class="avatar" aria-hidden="true">${esc(name[0].toUpperCase())}</div>`}
      <div class="store-title">${st.logo ? img(st.logo, 'logo-img', `${name} logo`) : ''}<h1>${esc(name)}</h1>${st.headline ? `<p class="headline">${esc(st.headline)}</p>` : ''}
        <div class="meta">@${esc(s.handle)}${st.showLocation && place ? ` · ${esc(place)}` : ''} ${isLocalShip(s.country) && st.showLocation ? '<span class="badge-local">Local ship</span>' : ''}</div>
        <div class="meta">${RV.line(s.id) || 'No reviews yet'} · ${sold} completed order${sold === 1 ? '' : 's'}</div></div>
      <div class="store-actions">${owner ? '<a class="btn" href="/dashboard/storefront">Customize</a>' : `${D.heartBtn(s.handle, req.user ? D.followedSet(req.user).has(s.id) : false, 'btn ghost')}<button class="btn" data-chat-seller="${esc(s.handle)}">Contact seller</button><a class="btn ghost small" href="/support?seller=${esc(s.handle)}">Report</a>`}</div></div>
    ${links ? `<div class="chips" aria-label="Seller links">${links}</div>` : ''}
    ${st.announcement ? `<div class="store-announce" role="note">${esc(st.announcement)}</div>` : ''}
    ${st.about || s.bio ? `<p class="store-about">${esc(st.about || s.bio)}</p>` : ''}
    <p class="small store-expect">${esc(EXPECT)}</p>
    ${featured.length ? `<h2>Featured</h2><div class="grid store-grid l-${esc(st.layout)}">${featured.map((l) => V.card(l, { favs })).join('')}</div>` : ''}
    <div class="sechead"><h2>${featured.length ? 'All items' : 'Available'} (${result.total + featured.length})</h2></div>
    ${result.items.length || featured.length ? (result.items.length ? `<div class="grid store-grid l-${esc(st.layout)}">${result.items.map((l) => V.card(l, { favs })).join('')}</div>${V.pager(result.page, result.pages, req.query.preview ? { preview: 1 } : {})}` : '')
      : V.empty('No listings yet', 'No listings yet — check back for their next drop. Follow this store to be notified when they publish.')}
    ${RV.section(s.id, req.user)}
  </div>`;
  res.send(V.layout({ user: req.user, path: '/s', title: name, body, description: (st.headline || st.about || s.bio || '').slice(0, 150), head: `<link rel="stylesheet" href="/storefront.css?v=${cssEtag}">` }));
});

// ---------- Editor (seller only) ----------
const S = [auth.requireSeller];
r.get('/dashboard/storefront', S, (req, res) => {
  const u = req.user, st = SF.state(u.id), w = st.working;
  const mine = q.all("SELECT id, title FROM listings WHERE seller_id = ? AND status IN ('active','reserved') ORDER BY published_at DESC LIMIT 100", u.id);
  const radio = (name, map, cur, extra = () => '') => Object.entries(map).map(([k, l]) => `<label class="opt-pick"><input type="radio" name="${name}" value="${k}"${cur === k ? ' checked' : ''}> ${extra(k)}<span>${esc(l)}</span></label>`).join('');
  const links = [...(w.links || []), ...Array(SF.LIMITS.links).fill({ kind: '', url: '' })].slice(0, SF.LIMITS.links);
  const body = `<h1>Storefront</h1><p class="muted small">Make your public page your own. Changes are saved as a private <strong>draft</strong>; use <strong>Preview</strong> to see exactly what visitors will see, then <strong>Publish</strong>. ${st.publishedAt ? '' : 'Nothing is published yet, so visitors currently see the default storefront.'}</p>
  <div class="panel notice"><span id="sf-status">${st.hasUnpublished ? '<strong>You have unpublished changes.</strong>' : 'No unpublished changes.'}</span></div>
  <form id="sfform" class="panel" novalidate style="margin-top:12px">
    <h3>Look</h3>
    <fieldset><legend>Theme</legend><div class="picks">${radio('theme', SF.THEMES, w.theme)}</div></fieldset>
    <fieldset><legend>Accent colour</legend><div class="picks">${radio('accent', SF.ACCENTS, w.accent, (k) => `<i class="sw sw-${k}" aria-hidden="true"></i>`)}</div></fieldset>
    <fieldset><legend>Product layout</legend><div class="picks">${radio('layout', SF.LAYOUTS, w.layout)}</div></fieldset>
    <label for="sort">Order of items</label><select id="sort" name="sort">${Object.entries(SF.SORTS).map(([k, l]) => `<option value="${k}"${w.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <h3 style="margin-top:20px">Images</h3><p class="hint">JPEG, PNG or WebP, up to 5 MB. Avatar and logo at least 64px; banner at least 600×150px (wide images work best).</p>
    <div class="row"><div><label>Avatar</label>${uploader('avatar', 1)}</div><div><label>Logo <span class="opt">(optional)</span></label>${uploader('logo', 1)}</div><div><label>Banner <span class="opt">(optional)</span></label>${uploader('banner', 1)}</div></div>
    <h3 style="margin-top:20px">Words</h3>
    <label for="headline">Headline <span class="opt">(${SF.LIMITS.headline} max)</span></label><input id="headline" name="headline" maxlength="${SF.LIMITS.headline}" value="${esc(w.headline)}">
    <label for="announcement">Announcement / welcome message <span class="opt">(${SF.LIMITS.announcement} max)</span></label><textarea id="announcement" name="announcement" maxlength="${SF.LIMITS.announcement}" style="min-height:70px">${esc(w.announcement)}</textarea>
    <label for="about">About your store <span class="opt">(${SF.LIMITS.about} max, plain text)</span></label><textarea id="about" name="about" maxlength="${SF.LIMITS.about}">${esc(w.about)}</textarea>
    <p class="hint">Plain text only: HTML, scripts and styling are never executed. You can't claim PairPlug guarantees, escrow or staff status.</p>
    <h3 style="margin-top:20px">Featured items <span class="opt">(up to ${SF.LIMITS.featured}, shown first)</span></h3>
    ${mine.length ? `<div class="picks col">${mine.map((l) => `<label class="opt-pick"><input type="checkbox" name="featured" value="${l.id}"${(w.featured || []).includes(l.id) ? ' checked' : ''}> <span>${esc(l.title)}</span></label>`).join('')}</div>` : '<p class="muted small">You have no items for sale yet. Publish a listing first.</p>'}
    <h3 style="margin-top:20px">Links <span class="opt">(optional, up to ${SF.LIMITS.links})</span></h3>
    ${links.map((l, i) => `<div class="row"><div><label class="sr" for="lk${i}">Link type ${i + 1}</label><select id="lk${i}" data-link-kind="${i}"><option value="">Link type…</option>${Object.keys(SF.LINK_KINDS).map((k) => `<option value="${k}"${l.kind === k ? ' selected' : ''}>${k}</option>`).join('')}</select></div><div style="grid-column:span 2"><label class="sr" for="lu${i}">Link URL ${i + 1}</label><input id="lu${i}" data-link-url="${i}" inputmode="url" placeholder="https://…" value="${esc(l.url)}"></div></div>`).join('')}
    <p class="hint">Only https links to these sites are accepted. Your email address is never shown.</p>
    <label style="font-weight:400;display:flex;gap:8px;margin-top:14px"><input type="checkbox" name="showLocation"${w.showLocation ? ' checked' : ''}> Show my city, region and “Local ship” badge</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px"><button type="button" class="btn ghost" id="sf-save">Save draft</button><a class="btn ghost" id="sf-preview" href="/s/${esc(u.handle)}?preview=1" target="_blank" rel="noopener">Preview draft ↗</a>
      <button type="button" class="btn" id="sf-publish">Publish</button><button type="button" class="btn ghost" id="sf-discard">Discard draft</button><a class="btn ghost" href="/s/${esc(u.handle)}" target="_blank" rel="noopener">View live storefront ↗</a></div></form>
  <script>window.__SF=${JSON.stringify({ avatar: w.avatar, logo: w.logo, banner: w.banner }).replace(/</g, '\\u003c')}</script>`;
  res.send(V.layout({ user: req.user, wide: true, path: '/dashboard/storefront', title: 'Storefront', body: V.dashNav('/dashboard/storefront') + body, head: `<link rel="stylesheet" href="/storefront.css?v=${cssEtag}">`, scripts: '<script src="/uploader.js" defer></script><script src="/storefront-editor.js" defer></script>' }));
});
r.put('/api/seller/storefront', S, (req, res) => { const out = SF.saveDraft(req.user, req.body); res.json({ ok: true, settings: out }); });
r.post('/api/seller/storefront/publish', S, (req, res) => {
  // publish exactly what the editor last saved; if the form has newer edits the client saves first
  SF.publish(req.user); res.json({ ok: true, url: `/s/${req.user.handle}` });
});
r.post('/api/seller/storefront/discard', S, (req, res) => { SF.discardDraft(req.user); res.json({ ok: true }); });

module.exports = { router: r };
