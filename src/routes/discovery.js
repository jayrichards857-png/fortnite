'use strict';
// Seller discovery routes: "View all sellers", the Following page, and the follow/unfollow API (authentication enforced server-side).
const express = require('express');
const auth = require('../auth');
const D = require('../discovery');
const V = require('../views');
const { esc } = require('../util');

const r = express.Router();
const page = (req, res, o) => res.send(V.layout({ user: req.user, ...o }));

r.get('/sellers', (req, res) => {
  const result = D.discoverSellers({ page: req.query.page, per: 12 }), cards = D.withPreviews(result.items), fol = D.followedSet(req.user);
  page(req, res, { title: 'Sellers', path: '/sellers', body: `<h1>Discover sellers</h1><p class="muted small">Public seller profiles — stores with items available now come first, then newer stores that haven't listed anything yet. ${result.total} seller${result.total === 1 ? '' : 's'}.</p>
    ${cards.length ? `<div class="sgrid">${cards.map((s) => D.sellerCard(s, { following: fol, user: req.user })).join('')}</div>${V.pager(result.page, result.pages, {})}` : V.empty('No sellers to show yet', 'Approved sellers appear here as soon as their store is open.', ['/shop', 'Browse the shop'])}` });
});
r.get('/following', auth.requireUser, (req, res) => {
  const list = D.withPreviews(D.followedSellers(req.user), { perSeller: 4 }), fol = new Set(list.map((s) => s.id));
  page(req, res, { title: 'Following', path: '/following', body: `<h1>Following</h1><p class="muted small">Sellers you follow, with their newest available items. You get an in-app notification when they list something new.</p>
    ${list.length ? `<div class="sgrid">${list.map((s) => D.sellerCard(s, { following: fol, user: req.user })).join('')}</div>` : V.empty('You aren\'t following anyone yet', 'Tap the heart on a seller to follow them and see their new items here.', ['/sellers', 'Discover sellers'])}` });
});
const H = '/api/sellers/:handle([A-Za-z0-9_-]{1,40})/follow';
r.post(H, auth.requireUser, (req, res) => { auth.rateLimit(`follow:${req.user.id}`, 120, 3600); res.json({ ok: true, ...D.follow(req.user, req.params.handle) }); });
r.put(H, auth.requireUser, (req, res) => { auth.rateLimit(`follow:${req.user.id}`, 120, 3600); res.json({ ok: true, ...D.follow(req.user, req.params.handle) }); });
r.delete(H, auth.requireUser, (req, res) => { auth.rateLimit(`follow:${req.user.id}`, 120, 3600); res.json({ ok: true, ...D.unfollow(req.user, req.params.handle) }); });
void esc;
module.exports = { router: r };
