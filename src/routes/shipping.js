'use strict';
// Seller shipping endpoints (labels in TEST MODE). Every route requires a seller session; ownership is enforced inside src/shipments.js
// (other sellers' orders are 404). JSON in/out; the label itself is only reachable through the authenticated redirect below.
const express = require('express');
const auth = require('../auth');
const ship = require('../shipments');
const { wrap } = require('../util');

const r = express.Router();
const S = [auth.requireSeller];
const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });

r.get('/api/seller/orders/:id(\\d+)/shipping', S, (req, res) => res.set('Cache-Control', 'no-store').json(ship.state(req.user, req.params.id)));
r.put('/api/seller/ship-from', S, (req, res) => res.json(ship.saveShipFrom(req.user, req.body)));
r.post('/api/seller/orders/:id(\\d+)/shipping/rates', S, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await ship.quote(req.user, req.params.id, req.body))));
r.post('/api/seller/orders/:id(\\d+)/shipping/buy', S, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await ship.buy(req.user, req.params.id, req.body))));
r.post('/api/seller/orders/:id(\\d+)/shipping/refresh', S, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await ship.refresh(req.user, req.params.id))));
r.post('/api/seller/orders/:id(\\d+)/shipping/release', S, (req, res) => res.set('Cache-Control', 'no-store').json(ship.release(req.user, req.params.id, req.body)));
r.get('/dashboard/orders/:id(\\d+)/label', S, (req, res) => { const url = ship.labelUrl(req.user, req.params.id); noStore(res).redirect(302, url); });

module.exports = { router: r };
