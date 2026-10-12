'use strict';
// Seller discovery routes: "View all sellers", the Following page, and the follow/unfollow API (authentication enforced server-side).
const express = require('express');
const auth = require('../auth');
const D = require('../discovery');
const V = require('../views');
const { esc } = require('../util');

const r = express.Router();
const page = async (req, res, o) => res.send(await V.layout({ user: req.user, ...o }));

r.get('/sellers', async (req, res) => {
  const result = await D.discoverSellers({ page: req.query.page, per: 12 }), cards = await D.withPreviews(result.items), fol = await D.followedSet(req.user);
  await page(req, res, { title: 'Sellers', path: '/sellers', body: `<h1>Discover sellers</h1><p class="muted small" style="margin-top:-4px">Independent stores on PairPlug — The Clothing Marketplace.</p><p class="muted small">Public seller profiles — stores with items available now come first, then newer stores that haven't listed anything yet. ${result.total} seller${result.total === 1 ? '' : 's'}.</p>
    ${cards.length ? `<div class="sgrid">${(await Promise.all(cards.map(async (s) => await D.sellerCard(s, { following: fol, user: req.user })))).join('')}</div>${V.pager(result.page, result.pages, {})}` : V.empty('No sellers to show yet', 'Approved sellers appear here as soon as their store is open.', ['/shop', 'Browse the shop'])}` });
});
r.get('/following', auth.requireUser, async (req, res) => {
  const list = await D.withPreviews(await D.followedSellers(req.user), { perSeller: 4 }), fol = new Set(list.map((s) => s.id));
  await page(req, res, { title: 'Following', path: '/following', body: `<h1>Following</h1><p class="muted small">Sellers you follow, with their newest available items. You get an in-app notification when they list something new.</p>
    ${list.length ? `<div class="sgrid">${(await Promise.all(list.map(async (s) => await D.sellerCard(s, { following: fol, user: req.user })))).join('')}</div>` : V.empty('You aren\'t following anyone yet', 'Tap the heart on a seller to follow them and see their new items here.', ['/sellers', 'Discover sellers'])}` });
});
const H = '/api/sellers/:handle([A-Za-z0-9_-]{1,40})/follow';
r.post(H, auth.requireUser, async (req, res) => { auth.rateLimit(`follow:${req.user.id}`, 120, 3600); res.json({ ok: true, ...await D.follow(req.user, req.params.handle) }); });
r.put(H, auth.requireUser, async (req, res) => { auth.rateLimit(`follow:${req.user.id}`, 120, 3600); res.json({ ok: true, ...await D.follow(req.user, req.params.handle) }); });
r.delete(H, auth.requireUser, async (req, res) => { auth.rateLimit(`follow:${req.user.id}`, 120, 3600); res.json({ ok: true, ...await D.unfollow(req.user, req.params.handle) }); });
void esc;
module.exports = { router: r };
