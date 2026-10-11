'use strict';
// "Record external sale": the seller's own record of an item sold outside PairPlug. Seller-only; ownership is enforced in src/externalSales.js (404 otherwise).
const express = require('express');
const auth = require('../auth');
const ES = require('../externalSales');
const V = require('../views');
const { q } = require('../db');
const { esc, money } = require('../util');

const r = express.Router();
const S = [auth.requireSeller];

r.get('/dashboard/listings/:id(\\d+)/external-sale', S, (req, res) => {
  const l = q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', Number(req.params.id), req.user.id);
  const back = '<p><a class="btn ghost" href="/dashboard/inventory">Back to inventory</a></p>';
  const wrap = (body) => res.send(V.layout({ user: req.user, path: '/dashboard/orders', title: 'Record external sale', body: V.dashNav('/dashboard/orders') + body }));
  if (!l) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Listing not found', 'It may not exist, or it belongs to someone else.', ['/dashboard/inventory', 'Inventory']) }));
  const done = ES.listFor(req.user).find((x) => x.listing_id === l.id);
  if (done) return wrap(`<div class="narrow panel"><h1>Already recorded</h1><p>An external sale was recorded for <strong>${esc(l.title)}</strong> on ${esc(done.sold_on)}.</p>${back}</div>`);
  if (ES.hasOrder(l.id)) return wrap(`<div class="narrow panel"><h1>This item has a PairPlug order</h1><p>${esc(l.title)} was sold (or is being sold) through a PairPlug order, so it is tracked under Orders. External sales are only for items sold outside PairPlug.</p>${back}</div>`);
  if (!['active', 'sold'].includes(l.status)) return wrap(`<div class="narrow panel"><h1>Not available</h1><p>Only items that are for sale, or already marked Sold, can be recorded as an external sale. This item is <strong>${esc(l.status)}</strong>.</p>${back}</div>`);
  const today = new Date().toISOString().slice(0, 10);
  wrap(`<h1>Record external sale</h1><div class="narrow panel form-wide" style="max-width:600px">
    <p><strong>${esc(l.title)}</strong> <span class="muted">listed at ${money(l.price_cents)}</span></p>
    <div class="panel notice"><strong>This records a sale made outside PairPlug</strong> (in person, another marketplace, …). It is <strong>your own record</strong>: PairPlug creates no buyer or order, does not verify the sale or any payment, and ${l.status === 'active' ? 'the item will be marked Sold so no one can buy it here' : 'the item is already marked Sold'}. If a buyer purchased it through PairPlug, use the order instead.</div>
    <form data-api="/api/seller/listings/${l.id}/external-sale" data-redirect="/dashboard/orders">
      <label for="so">Date sold</label><input id="so" name="sold_on" type="date" value="${today}" max="${today}">
      <label for="pr">Sale price <span class="opt">(optional, USD)</span></label><input id="pr" name="price" inputmode="decimal" placeholder="e.g. 85.00" maxlength="12">
      <label for="ch">Where it sold <span class="opt">(optional)</span></label><input id="ch" name="channel" maxlength="60" placeholder="In person, Depop, …">
      <label for="rf">Reference <span class="opt">(optional)</span></label><input id="rf" name="reference" maxlength="80">
      <label for="nt">Note <span class="opt">(optional)</span></label><textarea id="nt" name="note" maxlength="500"></textarea>
      <p class="small muted">Records can't be edited or deleted afterwards, so double-check the details.</p>
      <button class="btn" type="submit" style="margin-top:12px">Record external sale</button> <a class="btn ghost" href="/dashboard/inventory" style="margin-top:12px">Cancel</a></form></div>`);
});
r.post('/api/seller/listings/:id(\\d+)/external-sale', S, (req, res) => res.json({ ok: true, ...ES.record(req.user, req.params.id, req.body) }));

module.exports = { router: r };
