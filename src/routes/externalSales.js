'use strict';
// "Record sale": the seller's own record of a sale that did not come through a PairPlug checkout order, with origin, payment attestation, fulfilment and corrections.
// Seller-only; ownership is enforced in src/externalSales.js (404 otherwise). Recipient details are shown only to the owning seller.
const express = require('express');
const config = require('../config');
const auth = require('../auth');
const ES = require('../externalSales');
const V = require('../views');
const { q } = require('../db');
const { esc, money, date } = require('../util');
const { trackingUrl, LABEL_PROVIDERS } = require('../paymentLinks');

const r = express.Router();
const S = [auth.requireSeller];
const wrap = async (req, res, title, body, status = 200) => res.status(status).send(await V.layout({ user: req.user, path: '/dashboard/orders', title, body: V.dashNav('/dashboard/orders') + body }));
const originOpts = (cur = '') => `<option value="">Choose…</option>${Object.entries(ES.ORIGINS).map(([k, v]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}`;
const carrierOpts = (cur = '') => config.carriers.map((c) => `<option${cur === c ? ' selected' : ''}>${esc(c)}</option>`).join('');
const countryOpts = (cur = 'US') => ['US', 'CA', 'MX'].map((c) => `<option${cur === c ? ' selected' : ''}>${c}</option>`).join('');
const addrFields = (p, v = {}) => `<label for="${p}n">Recipient's full name</label><input id="${p}n" name="name" maxlength="60" value="${esc(v.recipient_name || '')}" autocomplete="off">
  <label for="${p}1">Address line 1</label><input id="${p}1" name="line1" maxlength="100" value="${esc(v.recipient_line1 || '')}"><label for="${p}2">Address line 2 <span class="opt">(optional)</span></label><input id="${p}2" name="line2" maxlength="100" value="${esc(v.recipient_line2 || '')}">
  <div class="row"><div><label for="${p}c">City</label><input id="${p}c" name="city" maxlength="60" value="${esc(v.recipient_city || '')}"></div><div><label for="${p}r">State / province / region</label><input id="${p}r" name="region" maxlength="40" value="${esc(v.recipient_region || '')}"></div><div><label for="${p}p">Postal code</label><input id="${p}p" name="postal" maxlength="12" value="${esc(v.recipient_postal || '')}"></div></div>
  <label for="${p}k">Country</label><select id="${p}k" name="country">${countryOpts(v.recipient_country || 'US')}</select>`;
const NOT_VERIFIED = 'Recording a sale documents the transaction. It does <strong>not</strong> independently verify any payment: PairPlug cannot see your payment provider.';

// ------------------------------------------------------------------ record form
const gone = async (req, res) => res.status(404).send(await V.layout({ user: req.user, title: 'Not found', body: V.empty('Not found', 'It may not exist, or it belongs to someone else.', ['/dashboard/inventory', 'Inventory']) }));
r.get('/dashboard/listings/:id(\\d+)/external-sale', S, (req, res) => res.redirect(301, `/dashboard/listings/${req.params.id}/record-sale`));
r.get('/dashboard/listings/:id(\\d+)/record-sale', S, async (req, res) => {
  const l = await q.get('SELECT * FROM listings WHERE id = ? AND seller_id = ?', Number(req.params.id), req.user.id);
  if (!l) return await gone(req, res);
  const back = '<p><a class="btn ghost" href="/dashboard/inventory">Back to inventory</a></p>';
  const done = await q.get('SELECT id FROM external_sales WHERE listing_id = ? AND voided_at IS NULL', l.id);
  if (done) return await wrap(req, res, 'Record sale', `<div class="narrow panel"><h1>Already recorded</h1><p>A sale is already recorded for <strong>${esc(l.title)}</strong>.</p><p><a class="btn" href="/dashboard/sales/${done.id}">Open the sale</a></p>${back}</div>`);
  if (await ES.hasOrder(l.id)) return await wrap(req, res, 'Record sale', `<div class="narrow panel"><h1>This item already has a PairPlug order</h1><p>${esc(l.title)} came through a PairPlug checkout, so that order <em>is</em> its sale record: confirm payment and ship from the order. Recording it here as well would duplicate it.</p><p><a class="btn" href="/dashboard/orders">Go to Orders</a></p>${back}</div>`);
  if (!['active', 'sold'].includes(l.status)) return await wrap(req, res, 'Record sale', `<div class="narrow panel"><h1>Not available</h1><p>Only items that are for sale, or already marked Sold, can be recorded as a sale. This item is <strong>${esc(l.status)}</strong>.</p>${back}</div>`);
  const today = new Date().toISOString().slice(0, 10);
  await wrap(req, res, 'Record sale', `<h1>Record sale</h1><div class="narrow panel form-wide" style="max-width:640px">
    <p><strong>${esc(l.title)}</strong> <span class="muted">listed at ${money(l.price_cents)}</span></p>
    <div class="panel notice">${NOT_VERIFIED} ${l.status === 'active' ? 'The item is marked <strong>Sold</strong> as soon as you save, so no one else can buy it here.' : 'The item is already marked Sold.'} No buyer account or checkout order is created.</div>
    <form id="rsform" data-api="/api/seller/listings/${l.id}/record-sale" data-redirect="/dashboard/orders">
      <label for="or">Where did this sale originate?</label><select id="or" name="origin" required>${originOpts()}</select>
      <div id="or-pp" class="small muted" hidden>The buyer found or ordered the item through PairPlug. The payment may still have been collected through your own Stripe, PayPal or other payment link — that doesn't make it an outside sale. <em>(If the buyer used “Buy now”, the PairPlug order already exists under Orders; this form is for sales made another way.)</em></div>
      <div id="or-detail" hidden><label for="ch">Platform or name <span class="opt">(optional)</span></label><input id="ch" name="channel" maxlength="60" placeholder="e.g. Depop, Instagram, pop-up market"></div>
      <label for="rf">Reference <span class="opt">(optional)</span></label><input id="rf" name="reference" maxlength="80" placeholder="Order, payment or message reference">
      <div class="row"><div><label for="so">Date sold</label><input id="so" name="sold_on" type="date" value="${today}" max="${today}"></div><div><label for="pr">Sale price <span class="opt">(USD; leave blank only if unknown)</span></label><input id="pr" name="price" inputmode="decimal" maxlength="12" placeholder="e.g. 85.00"></div></div>
      <label for="ps">Payment status</label><select id="ps" name="payment_status"><option value="unconfirmed" selected>Not confirmed yet</option><option value="confirmed_by_seller">I confirmed the payment arrived (my own check)</option></select>
      <p class="small muted" style="margin:4px 0 0">Choose “confirmed” only if you saw the money in your own account. PairPlug does not verify it either way.</p>
      <label for="fu">Fulfillment</label><select id="fu" name="fulfillment"><option value="ship" selected>Needs shipping</option><option value="pickup">Local pickup / no shipping required</option></select>
      <div id="fu-ship"><p class="small muted" style="margin:6px 0">You can save now and add the delivery address, carrier and tracking later.</p>${addrFields('rs_')}</div>
      <div id="fu-pickup" hidden><p class="small muted">No address or tracking number is needed for pickup. Add a note below if useful.</p></div>
      <label for="be">Buyer email <span class="opt">(optional, for your own reference)</span></label><input id="be" name="buyer_email" type="email" maxlength="120"><p class="small muted" style="margin:4px 0 0">PairPlug does not email buyers about recorded sales.</p>
      <label for="nt">Notes <span class="opt">(optional)</span></label><textarea id="nt" name="note" maxlength="500"></textarea>
      <button class="btn" type="submit" style="margin-top:14px">Record sale</button> <a class="btn ghost" href="/dashboard/inventory" style="margin-top:14px">Cancel</a></form></div>
    <script>(function(){var o=document.getElementById('or'),f=document.getElementById('fu');function sync(){var v=o.value;document.getElementById('or-pp').hidden=v!=='pairplug';document.getElementById('or-detail').hidden=!(v==='other_marketplace'||v==='social'||v==='other');var s=f.value==='ship';document.getElementById('fu-ship').hidden=!s;document.getElementById('fu-pickup').hidden=s}o.addEventListener('change',sync);f.addEventListener('change',sync);sync()})()</script>`);
});
r.post('/api/seller/listings/:id(\\d+)/record-sale', S, async (req, res) => res.json({ ok: true, ...await ES.record(req.user, req.params.id, req.body) }));
r.post('/api/seller/listings/:id(\\d+)/external-sale', S, async (req, res) => res.json({ ok: true, ...await ES.record(req.user, req.params.id, req.body) }));   // older clients

// ------------------------------------------------------------------ sale page (recipient, shipping, payment, corrections, void)
const originLabel = (s) => (s.origin ? esc(ES.ORIGINS[s.origin]) : 'Earlier record (origin not captured)');
const payLabel = (s) => (s.payment_status === 'confirmed_by_seller' ? 'Confirmed by you · not verified by PairPlug' : 'Not confirmed');
r.get('/dashboard/sales/:id(\\d+)', S, async (req, res) => {
  let s; try { s = await ES.mine(req.user, req.params.id); } catch { return await gone(req, res); }
  const events = await ES.eventsFor(req.user, s.id), track = s.tracking_number ? trackingUrl(s.carrier, s.tracking_number) : null, voided = Boolean(s.voided_at), shipped = s.shipment_status === 'shipped';
  const fulfil = !s.fulfillment ? `<p class="muted">Fulfillment wasn't captured for this earlier record. You can set it below.</p>` : s.fulfillment === 'pickup' ? '<p><strong>Local pickup / no shipping required.</strong> No address or tracking number is needed.</p>' : '';
  const shipBlock = voided ? '' : s.fulfillment === 'ship' ? `<h3>Ship this sale</h3>
    ${ES.hasAddress(s) ? `<p style="margin:0 0 6px"><strong>Recipient</strong><br>${esc(s.recipient_name)}<br>${esc(s.recipient_line1)}${s.recipient_line2 ? '<br>' + esc(s.recipient_line2) : ''}<br>${esc(s.recipient_city)}, ${esc(s.recipient_region)} ${esc(s.recipient_postal)}<br>${esc(s.recipient_country)}</p>` : '<div class="form-err">The recipient\'s delivery address is not complete. Add it below before marking this shipped.</div>'}
    ${shipped ? `<p style="margin:6px 0">Shipped ${s.shipped_at ? date(s.shipped_at) : ''} · Carrier <strong>${esc(s.carrier)}</strong> · Tracking <strong>${esc(s.tracking_number)}</strong>${track ? ` · <a href="${esc(track)}" target="_blank" rel="noopener noreferrer">Track ↗</a>` : ''}</p>${s.ship_note ? `<p class="small">Message: ${esc(s.ship_note)}</p>` : ''}
        <details><summary class="small">Correct the carrier, tracking or message</summary><form data-api="/api/seller/sales/${s.id}/tracking" data-method="PUT" data-reload class="row" style="align-items:end;margin-top:8px"><div><label for="c2">Carrier</label><select id="c2" name="carrier">${carrierOpts(s.carrier)}</select></div><div><label for="t2">Tracking number</label><input id="t2" name="tracking" required maxlength="40" value="${esc(s.tracking_number)}"></div><div><label for="m2">Message</label><input id="m2" name="note" maxlength="200" value="${esc(s.ship_note || '')}"></div><div><button class="btn ghost" type="submit">Save correction</button></div></form></details>`
      : `<details ${ES.hasAddress(s) ? '' : 'open'}><summary class="small">${ES.hasAddress(s) ? 'Edit the recipient' : 'Add the recipient'}</summary><form data-api="/api/seller/sales/${s.id}/fulfillment" data-method="PUT" data-reload><input type="hidden" name="fulfillment" value="ship">${addrFields('ra_', s)}<button class="btn ghost" type="submit" style="margin-top:8px">Save recipient</button></form></details>
        <form data-api="/api/seller/sales/${s.id}/ship" data-reload class="row" style="align-items:end;margin-top:12px"><div><label for="ca">Carrier</label><select id="ca" name="carrier">${carrierOpts()}</select></div><div><label for="tn">Tracking number</label><input id="tn" name="tracking" required maxlength="40"></div><div><label for="sn">Message to the buyer <span class="opt">(optional)</span></label><input id="sn" name="note" maxlength="200"></div><div><button class="btn" type="submit">Mark shipped</button></div></form>
        <p class="small muted">Buy postage yourself (${LABEL_PROVIDERS.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a>`).join(' · ')}). Entering tracking records it here; it doesn't buy postage or guarantee delivery. PairPlug sends no notification for a recorded sale.</p>`}` : '';
  const body = `<h1>Sale: ${esc(s.title)} ${voided ? '<span class="pill s-cancelled">Voided</span>' : ''}</h1>
  <p class="muted small"><a href="/dashboard/orders">← Orders</a> · Recorded ${date(s.recorded_at)}</p>
  <div class="two"><section>
    <div class="panel"><h3>Sale</h3><div class="summary-row"><span>Origin</span><span>${originLabel(s)}${s.channel ? ' · ' + esc(s.channel) : ''}</span></div><div class="summary-row"><span>Date sold</span><span>${esc(s.sold_on)}</span></div><div class="summary-row"><span>Sale price</span><span>${s.price_cents == null ? 'not recorded' : money(s.price_cents)}</span></div>${s.reference ? `<div class="summary-row"><span>Reference</span><span>${esc(s.reference)}</span></div>` : ''}${s.buyer_email ? `<div class="summary-row"><span>Buyer email (yours only)</span><span>${esc(s.buyer_email)}</span></div>` : ''}${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}
      <p class="small muted" style="margin:8px 0 0">${NOT_VERIFIED} The item is ${voided ? 'no longer held by this record' : 'Sold'}; nobody was notified.</p></div>
    <div class="panel"><h3>Payment</h3><p style="margin:0 0 8px">${payLabel(s)}${s.payment_confirmed_at ? ' · ' + date(s.payment_confirmed_at) : ''}</p>${!voided && s.payment_status !== 'confirmed_by_seller' ? `<button class="btn ghost" data-post="/api/seller/sales/${s.id}/confirm-payment" data-confirm="Confirm that you personally saw this payment arrive? PairPlug can't verify it.">I confirmed the payment arrived</button>` : ''}</div>
    <div class="panel">${fulfil}${shipBlock}${!voided && !s.fulfillment ? `<form data-api="/api/seller/sales/${s.id}/fulfillment" data-method="PUT" data-reload><label for="fx">Fulfillment</label><select id="fx" name="fulfillment"><option value="pickup">Local pickup / no shipping required</option><option value="ship">Needs shipping</option></select><button class="btn ghost" type="submit" style="margin-top:8px">Save</button></form>` : ''}</div>
  </section><aside>
    ${voided ? `<div class="panel"><h3>Voided</h3><p class="small">${esc(s.void_reason)}</p></div>` : `<form class="panel" data-api="/api/seller/sales/${s.id}" data-method="PUT" data-reload><h3>Correct details</h3><label for="e1">Date sold</label><input id="e1" name="sold_on" type="date" value="${esc(s.sold_on)}"><label for="e2">Sale price</label><input id="e2" name="price" inputmode="decimal" value="${s.price_cents == null ? '' : (s.price_cents / 100).toFixed(2)}"><label for="e3">Platform or name</label><input id="e3" name="channel" maxlength="60" value="${esc(s.channel || '')}"><label for="e4">Reference</label><input id="e4" name="reference" maxlength="80" value="${esc(s.reference || '')}"><label for="e5">Notes</label><textarea id="e5" name="note" maxlength="500">${esc(s.note || '')}</textarea><button class="btn ghost" type="submit" style="margin-top:8px">Save corrections</button><p class="small muted">Changes are logged. The origin can't be changed; void this record and record it again if it was wrong.</p></form>
    ${shipped ? '' : `<form class="panel" data-api="/api/seller/sales/${s.id}/void" data-reload><h3>Void this record</h3><p class="small muted">For an accidental record. It stays in your history, and the item is <strong>paused</strong>, not re-listed; resume it from Inventory if it is really still for sale.</p><label for="vr">Reason</label><input id="vr" name="reason" required minlength="5" maxlength="300"><button class="btn danger" type="submit" style="margin-top:8px" >Void record</button></form>`}`}
    <div class="panel"><h3>History</h3><ul class="timeline">${events.map((e) => `<li><strong>${esc(e.action.replace(/_/g, ' '))}</strong> <span class="muted small">${new Date(e.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span></li>`).join('') || '<li class="muted">No changes recorded since this record was created.</li>'}</ul></div>
  </aside></div>`;
  await wrap(req, res, 'Sale', body);
});
r.put('/api/seller/sales/:id(\\d+)', S, async (req, res) => res.json(await ES.correct(req.user, req.params.id, req.body)));
r.post('/api/seller/sales/:id(\\d+)/confirm-payment', S, async (req, res) => res.json(await ES.confirmPayment(req.user, req.params.id)));
r.put('/api/seller/sales/:id(\\d+)/fulfillment', S, async (req, res) => res.json(await ES.saveFulfillment(req.user, req.params.id, req.body)));
r.post('/api/seller/sales/:id(\\d+)/ship', S, async (req, res) => res.json(await ES.ship(req.user, req.params.id, req.body)));
r.put('/api/seller/sales/:id(\\d+)/tracking', S, async (req, res) => res.json(await ES.correctTracking(req.user, req.params.id, req.body)));
r.post('/api/seller/sales/:id(\\d+)/void', S, async (req, res) => res.json(await ES.voidSale(req.user, req.params.id, req.body)));

module.exports = { router: r };
