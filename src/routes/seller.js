'use strict';
const express = require('express');
const config = require('../config');
const { q, tx, now, getSettings } = require('../db');
const { esc, money, clean, cleanLine, date, HttpError, dollarsToCents, wrap } = require('../util');
const V = require('../views');
const auth = require('../auth');
const L = require('../listings');
const stats = require('../stats');
const escrow = require('../escrow');
const { transition } = require('../orderMachine');
const { notify } = require('../notify');
const { PricingEngine } = require('../pricing');
const { getLabelProvider } = require('../shipping');
const { uploader } = require('./buyer');
const X = require('../externalCheckout');

const r = express.Router();
const page = (req, res, opts) => res.send(V.layout({ user: req.user, wide: true, ...opts, body: opts.dash ? V.dashNav(req.path) + opts.body : opts.body, scripts: opts.scripts || '' }));
// Beta direct checkout: PairPlug charges no fee, so the calculators must not subtract one.
const engine = () => { const st = getSettings(); if (X.isExternal()) { st.fee_bps_standard = 0; st.fee_bps_pro = 0; } return new PricingEngine(st, config.taxRateBps); };

// ---------- Onboarding ----------
r.get('/sell', (req, res) => {
  if (req.user && req.user.is_seller) return res.redirect('/dashboard');
  if (!req.user) return res.send(V.layout({ user: null, title: 'Sell on PairPlug', path: '/sell', body: `<div class="narrow panel" style="max-width:520px"><h1>Sell on PairPlug</h1>
    <p>List clothing, sneakers and accessories, manage inventory and ship from anywhere in North America.${X.isExternal() ? ' Buyers pay <strong>you</strong> directly through your own Stripe checkout link — PairPlug never holds your money.' : ' Payments are held in escrow until the buyer receives the item.'}</p>
    ${X.isExternal() ? '<ul class="muted"><li>No PairPlug fees during the private beta</li><li>You confirm payments, ship, and handle refunds and chargebacks with your own payment provider</li><li>You need a Stripe account with Payment Links</li></ul>'
      : `<ul class="muted"><li>${(getSettings().fee_bps_standard / 100).toFixed(0)}% transaction fee on item price (${(getSettings().fee_bps_pro / 100).toFixed(0)}% on Pro)</li><li>Estimated card processing: ${(getSettings().processing_bps / 100).toFixed(1)}% + ${money(getSettings().processing_fixed_cents)}</li><li>No listing fees</li></ul>`}
    <a class="btn block" href="/register?next=/sell">Create an account to start</a><p class="small muted">Already have one? <a href="/login?next=/sell">Log in</a></p></div>` }));
  if (config.sellerOnboarding === 'invite' && !config.sellerAllowedEmails.includes(String(req.user.email).toLowerCase())) {
    return res.send(V.layout({ user: req.user, title: 'Invite only', path: '/sell', body: V.empty('Selling is invite-only right now', 'PairPlug is in a private beta with a small group of sellers. You can still browse, save items and buy.', ['/shop', 'Browse the shop']) }));
  }
  const s = getSettings();
  res.send(V.layout({ user: req.user, title: 'Set up your store', path: '/sell', body: `<div class="narrow panel form-wide" style="max-width:560px"><h1>Set up your store</h1>
    <p class="muted small">${X.isExternal() ? 'Private beta: no PairPlug fees. Buyers pay you directly through your own checkout link (set it up next in Settings). You handle payment confirmation, refunds and chargebacks.' : `Fees: ${(s.fee_bps_standard / 100).toFixed(0)}% transaction fee + estimated processing ${(s.processing_bps / 100).toFixed(1)}% + ${money(s.processing_fixed_cents)} per order, deducted from your payout. Funds are released from escrow after delivery is confirmed.`}</p>
    <form data-api="/api/sell/onboard" data-redirect="/dashboard">
      <label for="sn">Store name</label><input id="sn" name="store_name" required maxlength="60">
      <label for="sh">Store URL <span class="opt">(pairplug.com/s/…)</span></label><input id="sh" name="handle" required pattern="[a-zA-Z0-9_-]{3,30}" placeholder="your-handle">
      <div class="row"><div><label for="sc">Ships from (country)</label><select id="sc" name="country"><option value="US">United States</option><option value="CA">Canada</option><option value="MX">Mexico</option></select></div>
      <div><label for="sr">State / province</label><input id="sr" name="region" required></div><div><label for="sy">City</label><input id="sy" name="city" required></div></div>
      <label for="sb">About <span class="opt">(optional)</span></label><textarea id="sb" name="bio" maxlength="500"></textarea>
      <label style="font-weight:400;display:flex;gap:8px;margin-top:14px"><input type="checkbox" name="agree" required> I'll only list items I own and will ship within the stated time.</label>
      <button class="btn block" type="submit" style="margin-top:14px">Create store</button></form></div>` }));
});
r.post('/api/sell/onboard', auth.requireUser, (req, res) => {
  if (req.user.is_seller) throw new HttpError(409, 'You already have a store.');
  if (config.sellerOnboarding === 'invite' && !config.sellerAllowedEmails.includes(String(req.user.email).toLowerCase())) throw new HttpError(403, 'Seller accounts are invite-only during the private beta. Contact PairPlug to be added.');
  const f = {}, handle = String(req.body.handle || '').trim(), country = String(req.body.country || '');
  const storeName = cleanLine(req.body.store_name, 60), region = cleanLine(req.body.region, 60), city = cleanLine(req.body.city, 60);
  if (!storeName) f.store_name = 'Enter a store name.';
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(handle)) f.handle = '3–30 letters, numbers, - or _.';
  else if (q.get('SELECT 1 x FROM users WHERE handle = ?', handle)) f.handle = 'That URL is taken.';
  if (!config.naCountries.includes(country)) f.country = 'Sellers must ship from the US, Canada or Mexico.';
  if (!region) f.region = 'Required'; if (!city) f.city = 'Required';
  if (!req.body.agree) f.agree = 'Please accept to continue.';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  q.run('UPDATE users SET is_seller=1, store_name=?, handle=?, country=?, region=?, city=?, bio=? WHERE id=?', storeName, handle, country, region, city, clean(req.body.bio, 500) || null, req.user.id);
  res.json({ ok: true });
});

const S = [auth.requireSeller];
const stat = (k, v, n = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${n ? `<div class="n">${n}</div>` : ''}</div>`;

// ---------- Overview ----------
r.get('/dashboard', S, (req, res) => {
  const o = stats.overview(req.user.id), recent = q.all(`SELECT * FROM orders WHERE seller_id = ? AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 5`, req.user.id);
  const todo = q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND status = 'paid'", req.user.id).n, toConfirm = q.get("SELECT COUNT(*) n FROM orders WHERE seller_id = ? AND payment_mode = 'external' AND status = 'pending_payment'", req.user.id).n;
  const body = `<h1>Overview</h1><p class="muted small">All figures come from your orders and listings. “Gross sales” is sales volume (item prices); “Net proceeds” is revenue after fees; “Profit” also subtracts what you paid for the item.</p>
  ${toConfirm ? `<div class="panel" style="border-color:var(--accent)"><strong>${toConfirm} order${toConfirm > 1 ? 's' : ''} awaiting your payment check.</strong> <a href="/dashboard/orders?status=pending_payment">Review →</a></div>` : ''}
  ${todo ? `<div class="panel" style="border-color:var(--accent)"><strong>${todo} order${todo > 1 ? 's' : ''} waiting to ship.</strong> <a href="/dashboard/orders?status=paid">Ship now →</a></div>` : ''}
  ${X.isExternal() ? `<h2>Direct checkout <span class="muted small">(buyers pay you through your own payment link)</span></h2><div class="stats">
    ${stat('Awaiting your payment check', o.direct.awaiting, 'reserved, NOT paid until you confirm')}${stat('Confirmed orders', o.direct.confirmed, `${o.direct.to_ship} to ship`)}${stat('Item sales confirmed', money(o.direct.gross), 'before your payment provider\'s fees')}
    ${stat('Shipping collected', money(o.direct.shipping_collected), 'flat fees buyers paid you')}${stat('Estimated margin', o.direct.margin.n ? money(o.direct.margin.margin) : '—', o.direct.margin.n ? `item price − your cost, ${o.direct.margin.n} item(s)` : 'record acquisition cost on listings')}${stat('Refunded (you reported)', money(o.direct.refunded_cents), `${o.direct.refunded} order(s)`)}</div>
    <p class="small muted">PairPlug does not process these payments, so it shows no fees, payouts or balance for them. Check your payment provider for the money itself.</p>` : ''}
  <h2>${X.isExternal() ? 'Earlier PairPlug-processed sales' : 'Sales'}</h2><div class="stats">
    ${stat('Active listings', o.listings.active, `${o.listings.drafts} draft${o.listings.drafts === 1 ? '' : 's'}`)}${stat('Total orders', o.orders, 'paid, excluding refunds')}${stat('Completed sales', o.completed, 'funds released')}
    ${stat('Gross sales', money(o.gross), 'item price volume')}${stat('Platform fees', money(o.platform_fees), `${(getSettings()[req.user.plan === 'pro' ? 'fee_bps_pro' : 'fee_bps_standard'] / 100).toFixed(0)}% transaction fee`)}${stat('Processing fees', money(o.processing_fees), 'estimated')}
    ${stat('Refunds', money(o.refunds), `${o.refund_count} order${o.refund_count === 1 ? '' : 's'}`)}${stat('Net proceeds', money(o.net), 'item + shipping − fees')}
    ${stat('Estimated profit', o.profit.orders ? money(o.profit.cents) : '—', o.profit.orders ? `from ${o.profit.orders} of ${o.orders} orders with cost recorded` : 'record acquisition cost on listings')}</div>
  <h2>Balance <span class="muted small">(historical PairPlug-held funds only)</span></h2><div class="stats">${stat('Available', money(o.balance.availableCents), 'released from escrow')}${stat('In escrow', money(o.balance.escrowCents), 'paid, awaiting delivery confirmation')}</div>
  <h2>Recent orders</h2>${recent.length ? `<div class="tablewrap"><table><thead><tr><th>Order</th><th>Date</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>${recent.map((x) => `<tr><td><a href="${x.payment_mode === 'external' ? '/dashboard/orders/' : '/orders/'}${x.id}">#${x.id}</a></td><td>${date(x.created_at)}</td><td class="num">${money(x.total_cents)}</td><td>${V.orderPill(x)}</td></tr>`).join('')}</tbody></table></div>`
    : V.empty('No orders yet', 'Orders appear here after a buyer completes checkout.', ['/dashboard/listings/new', 'Create a listing'])}`;
  page(req, res, { title: 'Seller dashboard', path: '/dashboard', body, dash: true });
});

// ---------- Inventory ----------
r.get('/dashboard/inventory', S, (req, res) => {
  const f = req.query, where = ['seller_id = ?'], p = [req.user.id];
  if (f.status && ['draft', 'active', 'reserved', 'sold', 'archived'].includes(f.status)) { where.push('status = ?'); p.push(f.status); }
  if (f.q) { const t = `%${String(f.q).slice(0, 80).replace(/[\\%_]/g, (c) => '\\' + c)}%`; where.push("(title LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR brand LIKE ? ESCAPE '\\')"); p.push(t, t, t); }
  const pg = Math.max(1, parseInt(f.page, 10) || 1), per = 25;
  const total = q.get(`SELECT COUNT(*) n FROM listings WHERE ${where.join(' AND ')}`, ...p).n;
  const rows = q.all(`SELECT l.*, ${L.IMG_SQL} FROM listings l WHERE ${where.join(' AND ').replace(/\b(seller_id|status|title|sku|brand)\b/g, 'l.$1')} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`, ...p, per, (pg - 1) * per);
  const sale = { sold: 'Sold', reserved: 'In checkout', active: 'For sale', draft: 'Not published', archived: 'Not for sale' };
  const body = `<h1>Inventory <span class="muted small">${total} item${total === 1 ? '' : 's'}</span></h1>
  <form class="filterbar" method="get"><label class="sr" for="iq">Search</label><input id="iq" type="search" name="q" placeholder="Search title, SKU, brand" value="${esc(f.q || '')}">
    <label class="sr" for="is">Status</label><select id="is" name="status" data-autosubmit><option value="">All statuses</option>${['draft', 'active', 'reserved', 'sold', 'archived'].map((s) => `<option${f.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select><button class="btn ghost small">Filter</button></form>
  ${rows.length ? `<div class="bulkbar" id="bulkbar" hidden><span id="bulkcount">0 selected</span>
    <select id="bstatus" aria-label="New status"><option value="">Change status…</option><option value="active">Publish</option><option value="draft">Move to draft</option><option value="archived">Archive</option></select>
    <input id="bprice" placeholder="New price $" inputmode="decimal" aria-label="New price"><input id="bpct" placeholder="or % change" inputmode="decimal" aria-label="Percent change"><button class="btn small" id="bapply">Apply</button></div>
  <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="selall" aria-label="Select all"></th><th></th><th>Title</th><th>SKU</th><th class="num">Price</th><th class="num">Cost</th><th>Status</th><th>Sales status</th><th>Created</th><th></th></tr></thead><tbody>
  ${rows.map((l) => `<tr><td><input type="checkbox" class="sel" value="${l.id}" aria-label="Select ${esc(l.title)}"${['sold', 'reserved'].includes(l.status) ? ' disabled' : ''}></td><td>${V.img(l.image, 'thumb', l.title)}</td>
    <td><a href="/dashboard/listings/${l.id}/edit">${esc(l.title)}</a><div class="muted small">${esc([l.brand, l.size].filter(Boolean).join(' · '))}</div></td><td>${esc(l.sku || '—')}</td>
    <td class="num">${money(l.price_cents)}</td><td class="num">${l.cost_cents == null ? '—' : money(l.cost_cents)}</td><td>${V.statusPill(l.status)}</td><td>${sale[l.status]}</td><td>${date(l.created_at)}</td>
    <td style="white-space:nowrap"><a class="btn ghost small" href="/dashboard/listings/${l.id}/edit">Edit</a> <button class="btn ghost small" data-post="/api/seller/listings/${l.id}/duplicate" data-redirect="/dashboard/listings/{id}/edit">Duplicate</button></td></tr>`).join('')}</tbody></table></div>
  ${V.pager(pg, Math.max(1, Math.ceil(total / per)), { q: f.q || '', status: f.status || '' })}`
    : V.empty(f.q || f.status ? 'No matching listings' : 'No listings yet', f.q || f.status ? 'Try clearing the filters.' : 'Create your first listing to start selling.', ['/dashboard/listings/new', 'Create a listing'])}`;
  const script = `<script>(()=>{const sel=()=>[...document.querySelectorAll('.sel:checked')].map(x=>Number(x.value)),bar=document.getElementById('bulkbar');if(!bar)return;
   const upd=()=>{const n=sel().length;bar.hidden=!n;document.getElementById('bulkcount').textContent=n+' selected'};
   document.addEventListener('change',e=>{if(e.target.id==='selall')document.querySelectorAll('.sel:not(:disabled)').forEach(c=>c.checked=e.target.checked);if(e.target.matches('.sel,#selall'))upd()});
   document.getElementById('bapply').onclick=async()=>{const ids=sel(),st=bstatus.value,pr=bprice.value.trim(),pc=bpct.value.trim();
    try{let r;if(st)r=await pp.api('POST','/api/seller/listings/bulk',{ids,action:'status',status:st});else if(pr||pc)r=await pp.api('POST','/api/seller/listings/bulk',{ids,action:'price',price:pr||undefined,percent:pc||undefined});else return pp.toast('Choose a status or price change',true);
     pp.toast(r.updated+' updated'+(r.skipped.length?', '+r.skipped.length+' skipped ('+r.skipped[0].reason+')':''),r.skipped.length&&!r.updated);setTimeout(()=>location.reload(),1200)}catch(e){pp.toast(e.message,true)}}})()</script>`;
  page(req, res, { title: 'Inventory', path: '/dashboard/inventory', body, dash: true, scripts: script });
});

// ---------- Listing editor ----------
function editor(req, res, l) {
  const v = (k, d = '') => esc(l && l[k] != null ? l[k] : d), cents = (k) => (l && l[k] != null ? (l[k] / 100).toFixed(2) : '');
  const opt = (items, cur) => items.map(([a, b]) => `<option value="${a}"${cur === a ? ' selected' : ''}>${esc(b)}</option>`).join('');
  const locked = l && ['sold', 'reserved'].includes(l.status);
  const body = `<h1>${l ? 'Edit listing' : 'New listing'} ${l ? V.statusPill(l.status) : ''}</h1>
  ${locked ? `<div class="form-err">This item is ${l.status}; it can't be edited.</div>` : ''}
  <div class="two"><form class="panel" id="lform" data-listing="${l ? l.id : ''}" novalidate ${locked ? 'inert' : ''}>
    <label>Photos <span class="opt">(JPEG/PNG/WebP, up to 5 MB each, first is the cover)</span></label>${uploader('images', config.limits.maxImages)}
    <label for="title">Title</label><input id="title" name="title" maxlength="120" value="${v('title')}" required>
    <label for="desc">Description</label><textarea id="desc" name="description" maxlength="4000">${v('description')}</textarea>
    <div class="row"><div><label for="cat">Category</label><select id="cat" name="category"><option value="">Choose…</option>${opt(config.categories, l && l.category)}</select></div>
      <div><label for="brand">Brand <span class="opt">(optional)</span></label><input id="brand" name="brand" maxlength="60" value="${v('brand')}"></div>
      <div><label for="size">Size <span class="opt">(optional)</span></label><input id="size" name="size" maxlength="30" value="${v('size')}"></div>
      <div><label for="cond">Condition</label><select id="cond" name="condition"><option value="">Choose…</option>${opt(Object.entries(config.conditions), l && l.condition)}</select></div></div>
    <div class="row"><div><label for="price">Price (USD)</label><input id="price" name="price" inputmode="decimal" value="${cents('price_cents')}" required></div>
      <div><label for="ship">Flat shipping fee <span class="opt">(if buyer pays)</span></label><input id="ship" name="shipping" inputmode="decimal" value="${l ? cents('shipping_cents') : ''}"></div>
      <div><label for="cost">Acquisition cost <span class="opt">(private)</span></label><input id="cost" name="cost" inputmode="decimal" value="${cents('cost_cents')}"></div>
      <div><label for="sku">SKU <span class="opt">(optional)</span></label><input id="sku" name="sku" maxlength="60" value="${v('sku')}"></div></div>
    <fieldset class="panel" style="margin:14px 0 0"><legend style="font-weight:600;font-size:13px;padding:0 6px">Shipping terms (shown to buyers before they leave PairPlug)</legend>
      <label style="font-weight:400;display:flex;gap:8px;margin:6px 0"><input type="radio" name="shipping_payer" value="buyer"${!l || l.shipping_payer === 'buyer' ? ' checked' : ''}> <span><strong>Buyer pays a flat shipping fee</strong> (the amount in “Flat shipping fee” above, collected by your checkout link)</span></label>
      <label style="font-weight:400;display:flex;gap:8px;margin:6px 0"><input type="radio" name="shipping_payer" value="seller"${l && l.shipping_payer === 'seller' ? ' checked' : ''}> <span><strong>Free shipping — I cover the label</strong> (buyer pays nothing extra)</span></label></fieldset>
    ${X.isExternal() ? `<label for="purl">Payment link for this item <span class="opt">(Stripe Payment Link)</span></label><input id="purl" name="payment_url" inputmode="url" placeholder="https://buy.stripe.com/…" value="${v('payment_url')}" autocomplete="off">
      <div class="hint">Create it in your Stripe dashboard for exactly <strong>item price + shipping fee</strong>. ${req.user.checkout_url && req.user.checkout_url_any_amount ? 'Leave blank to use your any-amount default link.' : 'Required to publish unless you set an any-amount default link in <a href="/dashboard/settings">Settings</a>.'}</div>` : ''}
    <div class="row"><div><label for="w">Weight (oz)</label><input id="w" name="weight_oz" inputmode="decimal" value="${v('weight_oz')}"></div><div><label for="len">Length (in)</label><input id="len" name="length_in" inputmode="decimal" value="${v('length_in')}"></div>
      <div><label for="wid">Width (in)</label><input id="wid" name="width_in" inputmode="decimal" value="${v('width_in')}"></div><div><label for="hei">Height (in)</label><input id="hei" name="height_in" inputmode="decimal" value="${v('height_in')}"></div></div>
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap"><button type="button" class="btn" data-save="active">${l && l.status === 'active' ? 'Save changes' : 'Publish'}</button>
      <button type="button" class="btn ghost" data-save="draft">Save as draft</button>${l && l.status !== 'archived' ? '<button type="button" class="btn ghost" data-save="archived">Archive</button>' : ''}</div></form>
  <aside class="panel sticky"><h3>Profit calculator</h3><p class="small muted">Recommends a retail price from your costs and target margin, using current fees.</p>
    <label for="pc-cost">Item cost ($)</label><input id="pc-cost" inputmode="decimal" value="${cents('cost_cents')}"><label for="pc-ship">Your shipping label cost ($)</label><input id="pc-ship" inputmode="decimal" placeholder="same as shipping charged"><div class="hint">Blank = assume the shipping you charge covers the label.</div>
    <label for="pc-margin">Target profit margin (%)</label><input id="pc-margin" inputmode="decimal" value="30"><div id="pc-out" class="small" style="margin-top:14px;line-height:1.7" aria-live="polite"></div>
    <button type="button" class="btn ghost small" id="pc-use" hidden style="margin-top:10px">Use recommended price</button>
    <hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><h3>Your payout at this price</h3><div id="payout" class="small muted">Enter a price.</div></aside></div>`;
  const script = `<script src="/uploader.js" defer></script><script>window.__EDIT=${JSON.stringify(l ? { images: l.images } : { images: [] }).replace(/</g, '\\u003c')};window.__PLAN=${JSON.stringify(req.user.plan)}</script><script src="/editor.js" defer></script>`;
  page(req, res, { title: l ? 'Edit listing' : 'New listing', path: '/dashboard/listings', body, dash: true, scripts: script });
}
r.get('/dashboard/listings/new', S, (req, res) => editor(req, res, null));
r.get('/dashboard/listings/:id(\\d+)/edit', S, (req, res) => {
  const l = L.getListing(Number(req.params.id));
  if (!l || l.seller_id !== req.user.id) return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Listing not found', '', ['/dashboard/inventory', 'Inventory']) }));
  editor(req, res, l);
});

// ---------- Listing APIs ----------
r.post('/api/seller/listings', S, (req, res) => { const l = L.saveListing(req.user, null, req.body); res.json({ ok: true, id: l.id, status: l.status }); });
r.put('/api/seller/listings/:id(\\d+)', S, (req, res) => { const l = L.saveListing(req.user, Number(req.params.id), req.body); res.json({ ok: true, id: l.id, status: l.status }); });
r.post('/api/seller/listings/:id(\\d+)/duplicate', S, (req, res) => res.json({ ok: true, id: L.duplicateListing(req.user, Number(req.params.id)) }));
r.post('/api/seller/listings/bulk', S, (req, res) => res.json(L.bulkAction(req.user, req.body)));
r.get('/api/seller/profit-calc', S, (req, res) => {
  const c = (k) => { const v = dollarsToCents(req.query[k]); return Number.isNaN(v) ? null : v || 0; };
  const cost = c('cost'), shipC = c('shipping'), margin = Number(req.query.margin);
  // If the seller hasn't entered a label cost, assume the shipping they charge just covers it (pass-through).
  const label = req.query.label ? c('label') : shipC;
  if (cost == null || label == null || shipC == null || !(margin >= 0 && margin < 90)) throw new HttpError(422, 'Enter valid numbers.');
  const rec = engine().recommendPrice({ costCents: cost, labelCostCents: label, shippingChargedCents: shipC, marginPct: margin, plan: req.user.plan });
  if (!rec) throw new HttpError(422, 'That margin is not achievable after fees.');
  res.json(rec);
});
r.get('/api/seller/payout-preview', S, (req, res) => {
  const price = dollarsToCents(req.query.price), ship = dollarsToCents(req.query.shipping) || 0, cost = dollarsToCents(req.query.cost);
  if (price == null || Number.isNaN(price) || Number.isNaN(ship)) throw new HttpError(422, 'Enter a valid price.');
  const label = req.query.label ? dollarsToCents(req.query.label) : ship; // pass-through assumption when blank
  if (Number.isNaN(label)) throw new HttpError(422, 'Enter a valid label cost.');
  const o = engine().priceOrder({ subtotalCents: price, shippingCents: ship, sellerPlan: req.user.plan });
  res.json({ ...o, labelCents: label, profitCents: cost != null && !Number.isNaN(cost) ? o.sellerPayoutCents - cost - label : null });
});

// ---------- Orders ----------
const FULFIL = { paid: 'Awaiting shipment', shipped: 'Shipped', delivered: 'Delivered — awaiting buyer', released: 'Completed', disputed: 'In dispute', refunded: 'Refunded', pending_payment: 'Awaiting payment', cancelled: 'Cancelled' };
r.get('/dashboard/orders', S, (req, res) => {
  const st = ['pending_payment', 'paid', 'shipped', 'delivered', 'released', 'disputed', 'refunded'].includes(req.query.status) ? req.query.status : null;
  const orders = q.all(`SELECT o.*, b.display_name buyer_name, c.ship_city, c.ship_region FROM orders o JOIN users b ON b.id = o.buyer_id JOIN checkouts c ON c.id = o.checkout_id
    WHERE o.seller_id = ? AND (o.status NOT IN ('pending_payment','cancelled') OR (o.payment_mode = 'external' AND o.status = 'pending_payment')) ${st ? 'AND o.status = ?' : ''} ORDER BY o.created_at DESC LIMIT 100`, ...(st ? [req.user.id, st] : [req.user.id]));
  const label = getLabelProvider();
  const rows = orders.map((o) => {
    const items = q.all('SELECT title FROM order_items WHERE order_id = ?', o.id);
    const ext = o.payment_mode === 'external';
    const act = ext ? `<a class="btn ${o.status === 'pending_payment' || o.status === 'paid' ? '' : 'ghost'} small" href="/dashboard/orders/${o.id}">${o.status === 'pending_payment' ? 'Confirm payment' : o.status === 'paid' ? 'Ship' : 'Details'}</a>` : o.status === 'paid' ? `<form data-api="/api/seller/orders/${o.id}/ship" data-reload style="display:flex;gap:4px;flex-wrap:wrap"><label class="sr" for="c${o.id}">Carrier</label><select id="c${o.id}" name="carrier" style="width:auto"><option>USPS</option><option>UPS</option><option>FedEx</option><option>Canada Post</option><option>Other</option></select>
        <label class="sr" for="t${o.id}">Tracking number</label><input id="t${o.id}" name="tracking" placeholder="Tracking #" required style="width:150px"><button class="btn small" type="submit">Mark shipped</button></form>
        <button class="btn ghost small" style="margin-top:4px" data-post="/api/seller/orders/${o.id}/cancel" data-confirm="Cancel and refund this order?">Cancel & refund</button>`
      : o.status === 'disputed' ? `<a class="btn ghost small" href="/orders/${o.id}">View dispute</a>` : `<a class="btn ghost small" href="/orders/${o.id}">Details</a>`;
    return `<tr><td class="nowrap"><a href="${o.payment_mode === 'external' ? '/dashboard/orders/' : '/orders/'}${o.id}">#${o.id}</a><div class="muted small">${date(o.created_at)}</div></td><td>${items.map((i) => esc(i.title)).join('<br>')}</td>
      <td>${esc(o.buyer_name.split(' ')[0])}${ext && !o.payment_confirmed_at ? '' : `<div class="muted small">${esc(o.ship_city)}, ${esc(o.ship_region)}</div>`}</td><td class="num">${money(o.total_cents)}<div class="muted small">${ext ? 'paid direct to you' : 'payout ' + money(o.seller_payout_cents)}</div></td>
      <td>${ext ? (o.status === 'pending_payment' ? '<span class="pill s-pending_payment">Unconfirmed</span>' : o.status === 'refunded' ? V.statusPill('refunded') : '<span class="pill s-paid">Confirmed by you</span>') : V.statusPill(o.status === 'refunded' ? 'refunded' : 'paid')}</td><td>${ext && o.status === 'pending_payment' ? 'Awaiting your payment check' : FULFIL[o.status]}</td><td>${o.tracking_number ? `${esc(o.carrier)} ${esc(o.tracking_number)}` : '—'}</td><td>${act}</td></tr>`;
  }).join('');
  const body = `<h1>Orders</h1><form class="filterbar" method="get"><label class="sr" for="os">Status</label><select id="os" name="status" data-autosubmit><option value="">All orders</option>${['pending_payment', 'paid', 'shipped', 'delivered', 'released', 'disputed', 'refunded'].map((s) => `<option value="${s}"${st === s ? ' selected' : ''}>${s}</option>`).join('')}</select></form>
  ${X.isExternal() ? '<p class="small muted">Direct checkout: buyers pay you through your own payment link. “Unconfirmed” orders are reserved but <strong>not paid</strong> until you confirm the payment arrived in your own account.</p>' : ''}
  <p class="small muted">${label ? 'Label purchasing is configured but not implemented yet.' : 'PairPlug does not buy shipping labels. Buy a label with your carrier or a shipping service, then enter the tracking number here.'}</p>
  ${orders.length ? `<div class="tablewrap"><table><thead><tr><th>Order</th><th>Items</th><th>Buyer</th><th class="num">Total</th><th>Payment</th><th>Fulfillment</th><th>Tracking</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : V.empty('No orders', st ? 'No orders with this status.' : 'Orders from buyers will appear here once paid.')}`;
  page(req, res, { title: 'Orders', path: '/dashboard/orders', body, dash: true });
});
r.post('/api/seller/orders/:id(\\d+)/ship', S, (req, res) => {
  const carrier = config.carriers.includes(req.body.carrier) ? req.body.carrier : '', tracking = cleanLine(req.body.tracking, 60).replace(/\s/g, '');
  if (!carrier) throw new HttpError(422, 'Choose a carrier.');
  if (!/^[A-Za-z0-9-]{6,40}$/.test(tracking)) throw new HttpError(422, 'Please fix the highlighted fields.', { tracking: 'Enter a valid tracking number (letters/numbers, 6–40 characters).' });
  tx(() => {
    const o = q.get('SELECT * FROM orders WHERE id = ? AND seller_id = ?', Number(req.params.id), req.user.id);
    if (!o) throw new HttpError(404, 'Order not found');
    try { transition(o.id, 'shipped', { actor: `seller:${req.user.id}`, note: `${carrier} ${tracking}`, set: { carrier, tracking_number: tracking, shipped_at: now() } }); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That tracking number is already used on another order.'); throw e; }
    notify(o.buyer_id, `order:${o.id}:shipped`, 'Your order shipped', `Order #${o.id} shipped with ${carrier}. Tracking: ${tracking}`, `/orders/${o.id}`);
  });
  res.json({ ok: true });
});
r.post('/api/seller/orders/:id(\\d+)/cancel', S, wrap(async (req, res) => {
  const o = q.get('SELECT * FROM orders WHERE id = ? AND seller_id = ?', Number(req.params.id), req.user.id);
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status !== 'paid') throw new HttpError(409, "Only orders that haven't shipped can be cancelled.");
  await escrow.refundOrder(o.id, { actor: `seller:${req.user.id}`, reason: 'Cancelled by seller before shipping', relist: false });
  res.json({ ok: true });
}));

// ---------- Analytics ----------
r.get('/dashboard/analytics', S, (req, res) => {
  const a = stats.analytics(req.user.id), max = Math.max(1, ...a.days.map((d) => d.gross));
  const empty = !a.orders;
  const body = `<h1>Analytics</h1><div class="stats">${stat('Items sold', a.itemsSold)}${stat('Orders', a.orders)}${stat('Average order value', a.orders ? money(a.aov) : '—')}${stat('Gross sales (all time)', money(a.gross))}</div>
  <h2>Gross sales, last 30 days</h2><div class="panel">${empty ? V.empty('No sales yet', 'Your sales chart will appear after your first paid order.') : `<div class="chart" role="img" aria-label="Daily gross sales for the last 30 days">${a.days.map((d) => `<div class="cbar" style="height:${Math.max(1, Math.round((d.gross / max) * 100))}%" title="${d.day}: ${money(d.gross)} (${d.orders} order${d.orders === 1 ? '' : 's'})"></div>`).join('')}</div>
    <div class="chart-axis"><span>${a.days[0].day}</span><span>Peak day ${money(max)}</span><span>${a.days[a.days.length - 1].day}</span></div>`}</div>
  <h2>Inventory aging <span class="muted small">(active listings, value ${money(a.aging.value)})</span></h2>
  <div class="stats">${stat('Under 7 days', a.aging.d7 || 0)}${stat('7–29 days', a.aging.d30 || 0)}${stat('30–89 days', a.aging.d90 || 0)}${stat('90+ days', a.aging.d90p || 0, 'consider repricing')}</div>
  <h2>Item profitability</h2>${a.itemProfit.length ? `<div class="tablewrap"><table><thead><tr><th>Item</th><th>Order</th><th class="num">Sale price</th><th class="num">Cost</th><th class="num">Gross margin</th></tr></thead><tbody>
    ${a.itemProfit.map((i) => `<tr><td>${esc(i.title)}</td><td><a href="/orders/${i.order_id}">#${i.order_id}</a></td><td class="num">${money(i.price_cents)}</td><td class="num">${money(i.cost_cents)}</td><td class="num">${money(i.price_cents - i.cost_cents)}</td></tr>`).join('')}</tbody></table></div><p class="small muted">Gross margin = sale price − acquisition cost, before marketplace fees. Only items with a recorded cost are listed.</p>`
    : V.empty('No profitability data', 'Record an acquisition cost on your listings to see per-item margins after they sell.')}`;
  page(req, res, { title: 'Analytics', path: '/dashboard/analytics', body, dash: true });
});

// ---------- Finance: earnings, wallet, tax ----------
r.get('/dashboard/finance', S, (req, res) => {
  const o = stats.overview(req.user.id), tax = stats.monthlyTax(req.user.id);
  const ledger = q.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30', req.user.id), wd = q.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 10', req.user.id);
  const s = getSettings();
  const body = `<h1>Earnings & tax</h1>${X.isExternal() ? '<div class="panel notice small">In the private beta, buyers pay you directly through your own payment provider, so those sales are <strong>not</strong> shown here and PairPlug holds no funds for them. This page covers earlier PairPlug-processed sales only. Use your payment provider\'s reports for taxes.</div>' : ''}<div class="stats">${stat('Available to withdraw', money(o.balance.availableCents), 'released from escrow')}${stat('In escrow', money(o.balance.escrowCents), 'released after delivery')}${stat('Net proceeds (all time)', money(o.net))}</div>
  <div class="panel" style="margin-top:16px"><h3>Withdraw funds</h3><p class="small muted">Withdrawals are requests reviewed by PairPlug staff. Automated bank payouts need a Stripe Connect integration, which isn't enabled.</p>
    <form data-api="/api/seller/withdrawals" data-reload style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><div><label for="wa">Amount ($)</label><input id="wa" name="amount" inputmode="decimal" value="${(o.balance.availableCents / 100).toFixed(2)}"></div><button class="btn" type="submit"${o.balance.availableCents > 0 ? '' : ' disabled'}>Request withdrawal</button></form>
    ${wd.length ? `<table style="margin-top:10px"><tbody>${wd.map((w) => `<tr><td>${date(w.created_at)}</td><td class="num">${money(w.amount_cents)}</td><td>${V.statusPill(w.status)}</td></tr>`).join('')}</tbody></table>` : ''}</div>
  <h2>Fee structure</h2><div class="panel small">Plan: <strong>${req.user.plan === 'pro' ? 'Pro' : 'Standard'}</strong> · Transaction fee ${((req.user.plan === 'pro' ? s.fee_bps_pro : s.fee_bps_standard) / 100).toFixed(2)}% of item price · Estimated processing ${(s.processing_bps / 100).toFixed(2)}% + ${money(s.processing_fixed_cents)} of the buyer total · Payout = item price + shipping − fees.${req.user.plan === 'pro' ? '' : ` Pro sellers pay ${(s.fee_bps_pro / 100).toFixed(2)}% (plan billing isn't automated yet; an admin can enable it).`}</div>
  <h2>Monthly tax summary <span class="muted small">(by release date)</span></h2>
  ${tax.length ? `<div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Orders</th><th class="num">Item sales</th><th class="num">Shipping</th><th class="num">Sales tax collected*</th><th class="num">Fees</th><th class="num">Net payout</th></tr></thead><tbody>${tax.map((t) => `<tr><td>${t.month}</td><td class="num">${t.orders}</td><td class="num">${money(t.gross)}</td><td class="num">${money(t.shipping)}</td><td class="num">${money(t.tax)}</td><td class="num">${money(t.fees)}</td><td class="num">${money(t.net)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">* Tax shown is held by the marketplace for remittance and is not part of your payout. This summary is informational, not tax advice. <a href="/api/seller/tax.csv">Download CSV</a></p>` : V.empty('No completed sales yet', 'Monthly summaries appear once funds are released.')}
  <h2>Wallet activity</h2>${ledger.length ? `<div class="tablewrap"><table><tbody>${ledger.map((l) => `<tr><td>${date(l.created_at)}</td><td>${esc(l.kind.replace('_', ' '))} ${esc(l.note || '')}</td><td class="num">${money(l.amount_cents)}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No wallet activity', '')}`;
  page(req, res, { title: 'Earnings & tax', path: '/dashboard/finance', body, dash: true });
});
r.get('/api/seller/tax.csv', S, (req, res) => {
  const rows = stats.monthlyTax(req.user.id);
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="pairplug-tax-summary.csv"')
    .send(['month,orders,item_sales,shipping,sales_tax_collected,fees,net_payout', ...rows.map((t) => [t.month, t.orders, ...[t.gross, t.shipping, t.tax, t.fees, t.net].map((c) => (c / 100).toFixed(2))].join(','))].join('\n') + '\n');
});
r.post('/api/seller/withdrawals', S, (req, res) => {
  const amt = dollarsToCents(req.body.amount);
  if (amt == null || Number.isNaN(amt) || amt <= 0) throw new HttpError(422, 'Please fix the highlighted fields.', { amount: 'Enter a valid amount.' });
  tx(() => {
    const bal = stats.wallet(req.user.id).availableCents;
    if (amt > bal) throw new HttpError(422, 'Please fix the highlighted fields.', { amount: `You can withdraw up to ${money(bal)}.` });
    // Reserve funds immediately with a negative ledger row so the same balance can't be requested twice.
    const w = q.run("INSERT INTO withdrawals(user_id, amount_cents, created_at) VALUES(?,?,?)", req.user.id, amt, now());
    q.run("INSERT INTO ledger(user_id, kind, amount_cents, note, created_at) VALUES(?, 'withdrawal', ?, ?, ?)", req.user.id, -amt, `Withdrawal #${w.lastInsertRowid}`, now());
  });
  res.json({ ok: true, message: 'Withdrawal requested' });
});

// ---------- CSV import ----------
r.get('/dashboard/import', S, (req, res) => {
  const body = `<h1>CSV import</h1><div class="panel form-wide"><p>Bulk create or update inventory, matched by <strong>sku</strong>. Existing SKUs have their fields updated; new SKUs are created as <em>drafts</em> (add photos in the editor, then publish). Sold or reserved items are never changed.</p>
  <p class="small muted">Columns: <code>sku</code> (required), title, description, category, brand, size, condition (new_with_tags, like_new, good, fair), price, cost, shipping, weight_oz, length_in, width_in, height_in. Max ${config.limits.csvRows} rows.</p>
  <label for="csvf">CSV file</label><input id="csvf" type="file" accept=".csv,text/csv"><button class="btn" id="csvgo" style="margin-top:12px">Import</button><div id="csvout" aria-live="polite" style="margin-top:14px"></div></div>`;
  const script = `<script>document.getElementById('csvgo').onclick=async()=>{const f=csvf.files[0];if(!f)return pp.toast('Choose a CSV file',true);const out=document.getElementById('csvout');
   try{const r=await pp.api('POST','/api/seller/import',{csv:await f.text()});out.innerHTML='<strong>'+r.created+' created, '+r.updated+' updated, '+r.errors.length+' rows with errors.</strong>'+(r.errors.length?'<ul>'+r.errors.map(e=>'<li>Line '+e.line+': '+e.error.replace(/</g,'&lt;')+'</li>').join('')+'</ul>':'')}catch(e){out.innerHTML='<div class="form-err">'+e.message+'</div>'}}</script>`;
  page(req, res, { title: 'CSV import', path: '/dashboard/import', body, dash: true, scripts: script });
});
r.post('/api/seller/import', S, express.json({ limit: '2mb' }), (req, res) => res.json(L.importCsv(req.user, req.body.csv)));

module.exports = { router: r };
