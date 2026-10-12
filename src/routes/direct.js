'use strict';
// Direct (seller-owned) checkout: buyer purchase pages, buyer/seller order pages, seller checkout settings.
// Mounted BEFORE the legacy routers so it can take over /orders/:id for direct orders and switch the cart/escrow
// surfaces off while CHECKOUT_MODE=external. Legacy (platform) orders fall through to the old handlers untouched.
const express = require('express');
const config = require('../config');
const { q, now, getSettings } = require('../db');
const { esc, money, clean, cleanLine, date, HttpError } = require('../util');
const V = require('../views');
const auth = require('../auth');
const X = require('../externalCheckout');
const RV = require('../reviews');
const DISC = require('../disclosure');
const PP = require('../paymentPolicy');
const { validatePaymentUrl, trackingUrl, LABEL_PROVIDERS } = require('../paymentLinks');
const L = require('../listings');
const SP = require('./support');
const SHP = require('../shipments');
const SHIPPO = require('../shippo');

const r = express.Router();
const page = (req, res, opts) => res.send(V.layout({ user: req.user, path: req.path, ...opts }));
const notFound = (req, res, what = 'Not found') => res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty(what, 'It may not exist, or it belongs to someone else.', ['/shop', 'Browse the shop']) }));
const reqNo = (o) => `PP-${o.id}`;

// ---------- Switch the PairPlug-held cart/escrow checkout off in direct-checkout mode ----------
r.all(['/cart', '/checkout', '/api/cart', '/api/cart/:id', '/api/checkout', '/pay/:id', '/api/sandbox/pay/:id'], (req, res, next) => {
  if (!X.isExternal()) return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'The cart is not used in the private beta. Each item is purchased directly from its seller.' });
  return page(req, res, { title: 'Checkout', body: V.empty('There is no cart in the private beta', 'Each item is bought directly from the seller through their own checkout. Open an item and choose “Continue to seller checkout”.', ['/shop', 'Browse the shop']) });
});

const HOW_IT_WORKS = `<div class="panel notice"><h3>How payment works</h3><ul class="plain">
  <li><strong>You pay the seller through their external checkout</strong> (for example Stripe). PairPlug does not currently hold or directly control those funds.</li>
  <li>The seller confirms your payment on PairPlug, then ships. Until they confirm, the order shows as <em>awaiting payment confirmation</em>. That confirmation is the seller's statement; PairPlug does not independently verify it.</li>
  <li><strong>If an issue arises, contact PairPlug.</strong> We may review the order, contact the seller, and report the problem to the payment processor with the evidence we have. We cannot promise a refund or recovery.</li></ul>${DISC.canCannot({ compact: true })}<p class="small" style="margin:8px 0 0">Details: <a href="/payments">Payments, Refunds &amp; Disputes</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></div>`;

// ---------- Buyer: review terms + address, then reserve ----------
r.get('/buy/:id(\\d+)', auth.requireUser, (req, res) => {
  if (!X.isExternal()) return notFound(req, res);
  const l = L.getListing(Number(req.params.id));
  if (!l || !['active', 'reserved', 'sold'].includes(l.status)) return notFound(req, res, 'Listing not found');
  const mine = l.reserved_checkout_id && q.get(`SELECT o.id FROM orders o WHERE o.checkout_id = ? AND o.buyer_id = ? AND o.status = 'pending_payment'`, l.reserved_checkout_id, req.user.id);
  if (mine) return res.redirect(`/orders/${mine.id}`);
  if (l.seller_id === req.user.id) return res.redirect(`/listing/${l.id}`);
  const p = X.purchasable(l), t = X.terms(l);
  if (!p.ok) return page(req, res, { title: 'Unavailable', body: V.empty(l.status === 'sold' ? 'Sold' : 'Not available right now', p.reason || 'This item is not available.', [`/listing/${l.id}`, 'Back to listing']) });
  const field = (n, label, extra = '') => `<div><label for="a_${n}">${label}</label><input id="a_${n}" name="${n}" ${extra}></div>`;
  const body = `<h1>Continue to seller checkout</h1><div class="two"><section>
    ${HOW_IT_WORKS}
    <form class="panel" id="buyform" data-listing="${l.id}"><h3>Where should the seller ship it?</h3><p class="small muted">Only ${esc(l.seller_name || l.seller_handle)} sees this, and only after confirming your payment. We ship within the US, Canada and Mexico.</p>
      ${field('name', 'Full name', 'autocomplete="name" required')}${field('line1', 'Address', 'autocomplete="address-line1" required')}${field('line2', 'Apt, suite <span class="opt">(optional)</span>', 'autocomplete="address-line2"')}
      <div class="row">${field('city', 'City', 'autocomplete="address-level2" required')}${field('region', 'State / province', 'autocomplete="address-level1" required')}${field('postal', 'ZIP / postal code', 'autocomplete="postal-code" required')}</div>
      <label for="a_country">Country</label><select id="a_country" name="country"><option value="US">United States</option><option value="CA">Canada</option><option value="MX">Mexico</option></select>
      <label style="font-weight:400;display:flex;gap:8px;margin-top:14px"><input type="checkbox" id="ack" name="acknowledged"> ${esc(DISC.ACK)}</label>
      <button class="btn block" style="margin-top:14px" type="submit">Reserve item &amp; continue</button>
      <p class="small muted" style="margin-bottom:0">The item is held for you for ${getSettings().external_hold_minutes} minutes while you pay. Nothing is charged by PairPlug.</p></form></section>
    <aside class="panel sticky"><h3>Order summary</h3><div class="line" style="grid-template-columns:56px 1fr"><a href="/listing/${l.id}">${V.img(l.images[0], 'thumb', l.title)}</a><div><strong>${esc(l.title)}</strong><div class="muted small">${esc([l.size && 'Size ' + l.size, l.condition && config.conditions[l.condition]].filter(Boolean).join(' · '))}</div></div></div>
      <div class="summary-row"><span>Item</span><span>${money(t.itemCents)}</span></div>
      <div class="summary-row"><span>Shipping${t.shippingPayer === 'seller' ? ' (seller pays)' : ' (flat fee)'}</span><span>${t.shippingCents ? money(t.shippingCents) : 'Free'}</span></div>
      <div class="summary-row total"><span>You pay the seller</span><span>${money(t.totalCents)}</span></div>
      ${PP.buyerWarning(t, { id: 'byp-buy', reportHref: '/support#payment-mismatch' })}</aside></div>`;
  const script = `<script>document.getElementById('buyform').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,b=f.querySelector('button[type=submit]');b.disabled=true;f.querySelectorAll('.err,.form-err').forEach(x=>x.remove());
    const d=Object.fromEntries(new FormData(f));try{const r=await pp.api('POST','/api/purchases',{listingId:Number(f.dataset.listing),acknowledged:f.elements.acknowledged.checked,address:d});location.href=r.redirect}catch(x){const fl=x.fields||{};for(const[k,m]of Object.entries(fl)){const el=f.elements[k];if(el&&el.insertAdjacentHTML)el.insertAdjacentHTML('afterend','<div class="err">'+m+'</div>')}f.insertAdjacentHTML('afterbegin','<div class="form-err" role="alert"></div>');f.firstChild.textContent=x.message;b.disabled=false}})</script>`;
  res.send(V.layout({ user: req.user, path: '/buy', title: 'Continue to seller checkout', body, scripts: script }));
});

r.post('/api/purchases', auth.requireUser, (req, res) => {
  const out = X.startPurchase(req.user, { listingId: req.body.listingId, address: req.body.address, acknowledged: req.body.acknowledged === true });
  res.json({ ok: true, orderId: out.orderId, reference: out.reference, existing: out.existing, redirect: `/orders/${out.orderId}` });
});

// ---------- Buyer: the order page for a direct order (everything else falls through to the legacy page) ----------
const stepper = (o) => {
  const steps = [['Reserved', true], ['Seller confirms payment', ['paid', 'shipped', 'delivered'].includes(o.status)], ['Shipped', ['shipped', 'delivered'].includes(o.status)], ['Delivered', o.status === 'delivered']];
  return `<ol class="steps">${steps.map(([l, done]) => `<li class="${done ? 'done' : ''}">${esc(l)}</li>`).join('')}</ol>`;
};
r.get('/orders/:id(\\d+)', auth.requireUser, (req, res, next) => {
  const o = q.get('SELECT o.*, u.store_name, u.handle FROM orders o JOIN users u ON u.id = o.seller_id WHERE o.id = ? AND (o.buyer_id = ? OR o.seller_id = ?)', Number(req.params.id), req.user.id, req.user.id);
  if (!o || o.payment_mode !== 'external') return next();            // not ours (or not visible): legacy handler decides
  if (o.seller_id === req.user.id) return res.redirect(`/dashboard/orders/${o.id}`);
  const snap = JSON.parse(o.snapshot_json), item = q.get('SELECT * FROM order_items WHERE order_id = ?', o.id);
  const ck = q.get('SELECT * FROM checkouts WHERE id = ?', o.checkout_id), events = q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', o.id);
  const review = q.get('SELECT * FROM reviews WHERE order_id = ?', o.id), track = trackingUrl(o.carrier, o.tracking_number), buyerLbl = SHP.realLabel(o.id);
  const pending = o.status === 'pending_payment', until = ck.expires_at;
  const action = pending ? `<div class="panel notice strong"><h3>Step 2: pay the seller</h3>
      <p>Your item is reserved until <strong>${new Date(until * 1000).toLocaleString()}</strong>. Pay <strong>${money(o.total_cents)}</strong> on the seller's own checkout page (opens in the seller's payment provider, not PairPlug).</p>
      ${PP.buyerWarning({ itemCents: o.subtotal_cents, shippingCents: o.shipping_cents, totalCents: o.total_cents }, { id: 'byp-order', reportHref: `/support?order=${o.id}#payment-mismatch` })}
      <p><a class="btn" href="/orders/${o.id}/pay" target="_blank" rel="noopener noreferrer">Go to seller checkout ↗</a></p>
      ${o.buyer_claimed_paid_at ? '<p class="small"><strong>You told us you paid.</strong> The seller has been notified and will confirm once they see the payment. Your reservation is extended while they check.</p>'
      : `<p class="small muted">Already paid? Tell the seller. This does <em>not</em> confirm the order — only the seller can do that.</p><p><button class="btn ghost" data-post="/api/orders/${o.id}/claim-paid">I've completed payment</button>
         <button class="btn ghost" data-post="/api/orders/${o.id}/cancel-purchase" data-confirm="Cancel this purchase and release the item?">Cancel purchase</button></p>`}</div>` : '';
  const body = `<h1>Order #${o.id} ${V.orderPill(o)}</h1>
  <p class="muted small">Started ${date(o.created_at)} · Sold by <a href="/s/${esc(o.handle)}">${esc(o.store_name || o.handle)}</a> · Reference <strong>${reqNo(o)}</strong></p>
  ${stepper(o)}<div class="two"><section>${action}
    <div class="panel"><div class="line"><a href="/listing/${item.listing_id}">${V.img(item.image, 'thumb', item.title)}</a><div><a href="/listing/${item.listing_id}"><strong>${esc(snap.listing.title)}</strong></a><div class="muted small">${esc([snap.listing.size && 'Size ' + snap.listing.size, snap.listing.condition && config.conditions[snap.listing.condition]].filter(Boolean).join(' · '))}</div></div><div>${money(o.subtotal_cents)}</div></div></div>
    <div class="panel"><h3>Shipping</h3><p style="margin:0 0 8px">${X.addressMissing(ck) ? '<strong>No delivery address on this order.</strong>' : `To ${esc(ck.ship_name)}, ${esc(ck.ship_line1)}${ck.ship_line2 ? ' ' + esc(ck.ship_line2) : ''}, ${esc(ck.ship_city)}, ${esc(ck.ship_region)} ${esc(ck.ship_postal)} ${esc(ck.ship_country)}`} · ${o.shipping_payer === 'seller' ? 'Free shipping (the seller covers postage)' : `Shipping ${money(o.shipping_cents)}, paid by you directly to the seller (not prepaid postage)`}</p>
      ${X.addressMissing(ck) && ['pending_payment', 'paid'].includes(o.status) ? `<form data-api="/api/orders/${o.id}/shipping-address" data-reload class="addr-form"><p class="small">The seller needs a delivery address to ship this order. It is shown only to the seller of this order.</p>
        <label for="ab_n">Full name</label><input id="ab_n" name="name" autocomplete="name" required><label for="ab_1">Address</label><input id="ab_1" name="line1" autocomplete="address-line1" required><label for="ab_2">Apt, suite <span class="opt">(optional)</span></label><input id="ab_2" name="line2" autocomplete="address-line2">
        <div class="row"><div><label for="ab_c">City</label><input id="ab_c" name="city" autocomplete="address-level2" required></div><div><label for="ab_r">State / province</label><input id="ab_r" name="region" autocomplete="address-level1" required></div><div><label for="ab_p">ZIP / postal code</label><input id="ab_p" name="postal" autocomplete="postal-code" required></div></div>
        <label for="ab_k">Country</label><select id="ab_k" name="country"><option value="US">United States</option><option value="CA">Canada</option><option value="MX">Mexico</option></select><button class="btn" type="submit" style="margin-top:10px">Save delivery address</button></form>` : ''}
      ${o.tracking_number ? `<p style="margin:0">Carrier: <strong>${esc(o.carrier)}</strong> · Tracking: <strong>${esc(o.tracking_number)}</strong>${track ? ` · <a href="${esc(track)}" target="_blank" rel="noopener noreferrer">Track package ↗</a>` : ''}</p>${o.ship_note ? `<p class="small" style="margin:6px 0 0"><strong>Seller note:</strong> ${esc(o.ship_note)}</p>` : ''}${buyerLbl && buyerLbl.tracking_status ? `<p class="small" style="margin:6px 0 0">Carrier status: <strong>${esc(buyerLbl.tracking_status)}</strong></p>` : ''}<p class="small muted" style="margin:6px 0 0">Tracking shows what the carrier reports. It is not proof of delivery.</p>` : '<p class="muted" style="margin:0">No tracking yet. The seller buys the label and adds it here after confirming payment.</p>'}</div>
    ${o.status === 'shipped' ? `<div class="panel"><h3>Received it?</h3><button class="btn" data-post="/api/orders/${o.id}/received">Mark as received</button></div>` : ''}
    ${RV.panel(o)}
    <div class="panel"><h3>Problem with your order?</h3><p style="margin:0 0 8px"><button class="btn ghost small" data-chat-start="${item.listing_id}">Message the seller</button></p><p class="small muted" style="margin:0">Message the seller first; they are expected to reply within 48 hours (an expectation, not a guarantee). Refunds are issued by the seller in their own payment provider. If it is not resolved, report it to PairPlug below. ${esc(DISC.SHORT)}</p>${DISC.canCannot({ compact: true })}</div>
    ${SP.buyerPanels(o)}
  </section><aside class="panel sticky"><h3>Amount</h3>
    <div class="summary-row"><span>Item</span><span>${money(o.subtotal_cents)}</span></div><div class="summary-row"><span>Shipping</span><span>${o.shipping_cents ? money(o.shipping_cents) : 'Free'}</span></div>
    <div class="summary-row total"><span>Total</span><span>${money(o.total_cents)}</span></div>
    <p class="small muted">Paid to the seller, outside PairPlug. ${o.payment_confirmed_at ? 'Seller confirmed payment on ' + date(o.payment_confirmed_at) + '.' : 'Not yet confirmed by the seller.'}</p>
    <h3 style="margin-top:16px">Progress</h3><ul class="timeline">${events.map((e) => `<li><strong>${esc(e.to_status.replace('_', ' '))}</strong> <span class="muted">${new Date(e.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</li>`).join('')}</ul></aside></div>`;
  res.send(V.layout({ user: req.user, path: '/orders', title: `Order #${o.id}`, body }));
});

// Redirect to the seller's checkout. Only the buyer of a still-pending direct order; the destination is read from the DB.
r.get('/orders/:id(\\d+)/pay', auth.requireUser, (req, res) => {
  let url; try { url = X.payRedirect(req.user, req.params.id); } catch (e) { return res.status(e.status || 500).send(V.layout({ user: req.user, title: 'Unavailable', body: V.empty(e.status ? e.message : 'Something went wrong', '', [`/orders/${Number(req.params.id)}`, 'Back to order']) })); }
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).redirect(302, url);
});
r.post('/api/orders/:id(\\d+)/claim-paid', auth.requireUser, (req, res) => res.json(X.buyerClaimPaid(req.user, req.params.id)));
r.post('/api/orders/:id(\\d+)/cancel-purchase', auth.requireUser, (req, res) => res.json(X.buyerCancel(req.user, req.params.id)));
r.post('/api/orders/:id(\\d+)/received', auth.requireUser, (req, res) => res.json(X.markReceived(req.user, req.params.id, 'buyer')));

// ---------- Seller: checkout settings ----------
const S = [auth.requireSeller];
const dash = (req, res, opts) => res.send(V.layout({ user: req.user, wide: true, ...opts, body: V.dashNav(req.path) + opts.body }));
r.get('/dashboard/settings', S, (req, res) => {
  const u = req.user, hosts = config.paymentLinkHosts.join(', ');
  const body = `<h1>Store &amp; checkout settings</h1><form class="panel form-wide" data-api="/api/seller/settings" data-method="PUT">
    <h3>Your store</h3><label for="sn">Store name</label><input id="sn" name="store_name" maxlength="60" value="${esc(u.store_name)}" required>
    <div class="row"><div><label for="sc">Ships from (country)</label><select id="sc" name="country">${config.naCountries.map((c) => `<option value="${c}"${u.country === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
      <div><label for="sr">State / province</label><input id="sr" name="region" value="${esc(u.region)}" required></div><div><label for="sy">City</label><input id="sy" name="city" value="${esc(u.city)}" required></div></div>
    <label for="sb">About <span class="opt">(optional)</span></label><textarea id="sb" name="bio" maxlength="500">${esc(u.bio)}</textarea>
    <h3 style="margin-top:22px">Your checkout (how you get paid)</h3>
    <div class="panel notice"><ul class="plain"><li>Buyers pay <strong>you</strong>, directly, through your own Stripe Payment Link. <strong>PairPlug never holds or touches the money</strong> and takes no fee in the beta.</li>
      <li>You are responsible for confirming payment, refunds, chargebacks and taxes.</li><li>A Payment Link has a <strong>fixed product and price</strong>. The safest setup is a link <em>per listing</em> (set it in the listing editor). Make sure it charges the item price plus the shipping fee you show on PairPlug.</li></ul></div>
    <label for="cu">Default payment link <span class="opt">(optional)</span></label><input id="cu" name="checkout_url" inputmode="url" placeholder="https://buy.stripe.com/…" value="${esc(u.checkout_url || '')}" autocomplete="off">
    <div class="hint">Accepted: HTTPS Stripe Payment Links on ${esc(hosts)}. <strong>A default link can no longer start a checkout in the beta</strong>: add a Stripe link to each listing and confirm it charges that listing's item price plus shipping.</div>
    <label style="font-weight:400;display:flex;gap:8px;margin-top:10px"><input type="checkbox" name="checkout_url_any_amount"${u.checkout_url_any_amount ? ' checked' : ''}> This default link lets the buyer <strong>enter any amount</strong> (a “customer chooses price” link), so it can be used for any of my listings. Leave unticked if it is a fixed-price link — it will then <em>not</em> be used for listings without their own link.</label>
    <button class="btn" type="submit" style="margin-top:16px">Save settings</button></form>
    <p class="small muted">Testing tip: this link is untested with live Stripe in this beta build. Do a real test purchase of a cheap item with a friend before announcing the store.</p>`;
  dash(req, res, { title: 'Settings', path: '/dashboard/settings', body });
});
r.put('/api/seller/settings', S, (req, res) => {
  const f = {}, b = req.body;
  const store = cleanLine(b.store_name, 60), region = cleanLine(b.region, 60), city = cleanLine(b.city, 60), country = String(b.country || '');
  if (!store) f.store_name = 'Enter a store name.'; if (!region) f.region = 'Required'; if (!city) f.city = 'Required';
  if (!config.naCountries.includes(country)) f.country = 'Choose US, CA or MX.';
  let url = null;
  if (b.checkout_url && String(b.checkout_url).trim()) { try { url = validatePaymentUrl(b.checkout_url); } catch (e) { f.checkout_url = (e.fields && e.fields.payment_url) || e.message; } }
  const any = b.checkout_url_any_amount === true || b.checkout_url_any_amount === 'on' ? 1 : 0;
  if (any && !url) f.checkout_url_any_amount = 'Add a default link first, or untick this.';
  if (Object.keys(f).length) throw new HttpError(422, 'Please fix the highlighted fields.', f);
  q.run('UPDATE users SET store_name=?, region=?, city=?, country=?, bio=?, checkout_url=?, checkout_url_any_amount=? WHERE id=?', store, region, city, country, clean(b.bio, 500) || null, url, any, req.user.id);
  res.json({ ok: true, message: 'Settings saved' });
});

// ---------- Seller: order page + actions ----------
r.get('/dashboard/orders/:id(\\d+)', S, (req, res, next) => {
  const o = q.get('SELECT o.*, b.display_name buyer_name FROM orders o JOIN users b ON b.id = o.buyer_id WHERE o.id = ? AND o.seller_id = ?', Number(req.params.id), req.user.id);
  if (!o) return notFound(req, res, 'Order not found');
  if (o.payment_mode !== 'external') return res.redirect(`/orders/${o.id}`);
  const snap = JSON.parse(o.snapshot_json), item = q.get('SELECT * FROM order_items WHERE order_id = ?', o.id), ck = q.get('SELECT * FROM checkouts WHERE id = ?', o.checkout_id);
  const events = q.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', o.id), track = trackingUrl(o.carrier, o.tracking_number);
  const showAddress = Boolean(o.payment_confirmed_at) && o.status !== 'cancelled';     // data minimisation: address only once you've confirmed payment
  const conv = q.get('SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ?', o.buyer_id, req.user.id);
  const realLbl = SHP.realLabel(o.id), carrierName = (c) => config.carriers.find((x) => String(c || '').toLowerCase().startsWith(x.toLowerCase())) || 'Other';   // only REAL labels prefill; test labels never do
  const panels = [];
  if (o.status === 'pending_payment') panels.push(`<div class="panel notice strong"><h3>Confirm the payment</h3>
    <p>Open your Stripe dashboard and look for a payment of <strong>${money(o.total_cents)}</strong> with client reference <strong>${reqNo(o)}</strong>. ${o.buyer_claimed_paid_at ? '<strong>The buyer says they have paid.</strong>' : 'The buyer has not said they paid yet.'}</p>
    <p class="small"><strong>Only confirm once the money is in your own account.</strong> PairPlug cannot verify this for you. Confirming marks the item sold and shows you the shipping address.</p>
    <form data-api="/api/seller/orders/${o.id}/confirm-payment" data-reload><label for="pr">Payment reference <span class="opt">(optional note, e.g. last 6 characters of the Stripe payment id)</span></label><input id="pr" name="reference" maxlength="80">
      <p style="margin-top:12px"><button class="btn" type="submit">Payment received — confirm order</button> <button class="btn ghost" type="button" data-post="/api/seller/orders/${o.id}/reject-payment" data-confirm="Release the item? The buyer will be told no payment was received.">No payment received — release item</button></p></form>
    <p class="small muted">Reserved until ${new Date(ck.expires_at * 1000).toLocaleString()}; after that the item is released automatically.</p></div>`);
  // The Shippo label panel exists ONLY in the isolated development sandbox (SHIPPO.enabled() is false in the live beta): sellers buy postage themselves.
  if (SHIPPO.enabled() && ['paid', 'shipped', 'delivered'].includes(o.status)) panels.push(`<div class="panel" id="ship-panel" data-order="${o.id}"><h3>Shipping label (sandbox test)</h3><noscript><p>Enable JavaScript to use the sandbox label panel, or enter the tracking number below.</p></noscript></div>`);
  const miss = X.addressMissing(ck);
  const recipient = (heading = 'Recipient') => miss
    ? `<div class="form-err" role="alert"><strong>The buyer's delivery address is missing.</strong> This order predates address collection or the address is incomplete; PairPlug never invents one. ${['pending_payment', 'paid'].includes(o.status) ? `<p style="margin:8px 0 0"><button class="btn small" data-post="/api/seller/orders/${o.id}/request-address">Ask the buyer to add it</button> <span class="small">(in-app notification only; no email is sent)</span></p>` : ''}</div>`
    : `<h4 style="margin:12px 0 4px">${heading}</h4><p style="margin:0 0 12px">${esc(ck.ship_name)}<br>${esc(ck.ship_line1)}${ck.ship_line2 ? '<br>' + esc(ck.ship_line2) : ''}<br>${esc(ck.ship_city)}, ${esc(ck.ship_region)} ${esc(ck.ship_postal)}<br>${esc(ck.ship_country)}</p>`;
  const carrierSel = (cur) => config.carriers.map((c) => `<option${cur === c ? ' selected' : ''}>${esc(c)}</option>`).join('');
  if (o.status === 'paid') panels.push(`<div class="panel" id="ship-this-order"><h3>Ship this order</h3>
    <ol class="plain"><li><strong>Buy postage yourself</strong>, in your own account: Shippo, Pirate Ship, USPS, Canada Post or any carrier. <strong>PairPlug does not buy labels or pay postage.</strong> ${LABEL_PROVIDERS.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)} ↗</a>`).join(' · ')}</li>
      <li><strong>Pack it and ship it to the recipient below</strong> (visible because you confirmed payment).</li>
      <li><strong>Enter the carrier and tracking number</strong>, add an optional message for the buyer, and press <em>Mark shipped</em>. The buyer gets an in-app notification.</li></ol>
    <p class="small" style="margin:0 0 6px">${o.shipping_payer === 'seller' ? '<strong>Free shipping:</strong> you offered free shipping, so you pay the postage yourself.' : `<strong>Buyer-paid shipping:</strong> the buyer already paid you ${money(o.shipping_cents)} for shipping as part of the total. That money went directly to you; it is <em>not</em> a prepaid label, and you still buy and pay for postage yourself.`}</p>
    ${recipient()}
    ${miss ? '' : `<form data-api="/api/seller/orders/${o.id}/ship" data-reload class="row" style="align-items:end"><div><label for="ca">Carrier</label><select id="ca" name="carrier">${carrierSel(realLbl ? carrierName(realLbl.carrier) : '')}</select></div><div><label for="tn">Tracking number</label><input id="tn" name="tracking" required maxlength="40" value="${esc(realLbl ? realLbl.tracking_number : '')}"></div><div><label for="sn2">Message to the buyer <span class="opt">(optional)</span></label><input id="sn2" name="note" maxlength="200"></div><div><button class="btn" type="submit">Mark shipped</button></div></form>`}
    <p class="small muted" style="margin:8px 0 0">Entering tracking <strong>records</strong> it in PairPlug and shows it to the buyer. It does not buy postage and does not guarantee delivery; tracking is not proof of delivery or contents, so keep your receipt and photos of the package.</p></div>`);
  if (['shipped', 'delivered', 'released'].includes(o.status)) panels.push(`<div class="panel"><h3>${o.status === 'shipped' ? 'Shipped' : 'Delivered'}</h3>
    <p style="margin:0 0 6px">Carrier <strong>${esc(o.carrier)}</strong> · Tracking <strong>${esc(o.tracking_number)}</strong>${track ? ` · <a href="${esc(track)}" target="_blank" rel="noopener noreferrer">Track ↗</a>` : ''}</p>
    ${o.ship_note ? `<p class="small" style="margin:0 0 6px"><strong>Your message to the buyer:</strong> ${esc(o.ship_note)}</p>` : ''}<p class="small muted" style="margin:0 0 6px">${o.shipped_at ? 'Marked shipped ' + date(o.shipped_at) + '. ' : ''}${o.status === 'shipped' ? 'The order becomes <em>Delivered</em> only when the buyer confirms receipt (or a verified carrier report says so). Your own entry can\'t mark it delivered.' : 'Delivery was confirmed' + (o.delivered_at ? ' on ' + date(o.delivered_at) : '') + '.'}</p>
    ${recipient('Shipped to')}
    ${o.status === 'shipped' ? `<details><summary class="small">Correct the carrier, tracking or message</summary><form data-api="/api/seller/orders/${o.id}/tracking" data-method="PUT" data-reload class="row" style="align-items:end;margin-top:8px"><div><label for="ca2">Carrier</label><select id="ca2" name="carrier">${carrierSel(o.carrier)}</select></div><div><label for="tn2">Tracking number</label><input id="tn2" name="tracking" required maxlength="40" value="${esc(o.tracking_number)}"></div><div><label for="sn3">Message</label><input id="sn3" name="note" maxlength="200" value="${esc(o.ship_note || '')}"></div><div><button class="btn ghost" type="submit">Save correction</button></div></form></details>` : ''}</div>`);
  panels.push(SP.sellerPanels(o));
  const body = `<h1>Order #${o.id} ${V.orderPill(o)}</h1><p class="muted small">Reference <strong>${reqNo(o)}</strong> · Started ${date(o.created_at)} · Buyer ${esc(o.buyer_name)}${conv ? ` · <a href="/messages/${conv.id}">Message buyer</a>` : ''}</p>
  <div class="two"><section>${panels.join('')}
    <div class="panel"><h3>What was ordered (snapshot at checkout)</h3><div class="line"><a href="/listing/${item.listing_id}">${V.img(item.image, 'thumb', item.title)}</a><div><strong>${esc(snap.listing.title)}</strong><div class="muted small">${esc([snap.listing.brand, snap.listing.size && 'Size ' + snap.listing.size, snap.listing.condition && config.conditions[snap.listing.condition]].filter(Boolean).join(' · '))}</div></div><div>${money(snap.terms.itemCents)}</div></div>
      <p class="small muted" style="margin:0">Shipping terms offered: ${snap.terms.shippingPayer === 'seller' ? 'free (seller covers the label)' : `buyer pays ${money(snap.terms.shippingCents)} flat`}. Checkout link: ${esc(snap.paymentLink.source === 'listing' ? 'this listing\'s link' : 'your default link')} (${esc(snap.paymentLink.host)}).</p></div>
    ${showAddress ? '' : '<div class="panel"><h3>Recipient</h3><p class="muted" style="margin:0">The recipient\'s delivery address is shown here after you confirm the payment.</p></div>'}
  </section><aside class="panel sticky"><h3>Amount</h3><div class="summary-row"><span>Item</span><span>${money(o.subtotal_cents)}</span></div><div class="summary-row"><span>Shipping</span><span>${o.shipping_cents ? money(o.shipping_cents) : 'Free'}</span></div><div class="summary-row total"><span>Buyer pays you</span><span>${money(o.total_cents)}</span></div>
    <p class="small muted">Paid directly to you. PairPlug takes no fee and holds no funds.${o.payment_reference ? ` Your note: ${esc(o.payment_reference)}.` : ''}</p>
    <h3 style="margin-top:16px">History</h3><ul class="timeline">${events.map((e) => `<li><strong>${esc(e.to_status.replace('_', ' '))}</strong> <span class="muted">${new Date(e.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</li>`).join('')}</ul></aside></div>`;
  dash(req, res, { title: `Order #${o.id}`, path: '/dashboard/orders', body, scripts: SHIPPO.enabled() ? '<script src="/shipping.js" defer></script>' : '' });
});
r.post('/api/seller/orders/:id(\\d+)/confirm-payment', S, (req, res) => res.json(X.sellerConfirmPayment(req.user, req.params.id, { reference: req.body.reference })));
r.post('/api/seller/orders/:id(\\d+)/reject-payment', S, (req, res) => res.json(X.sellerRejectPayment(req.user, req.params.id)));
r.post('/api/seller/orders/:id(\\d+)/received', S, (req, res) => res.json(X.markReceived(req.user, req.params.id, 'seller')));   // refused for sellers: only the buyer can confirm delivery
// Shipping for direct orders (carrier + tracking entered by the seller; PairPlug buys no postage). Other order types fall through to the legacy handler.
const direct = (req) => { const o = q.get('SELECT payment_mode FROM orders WHERE id = ? AND seller_id = ?', Number(req.params.id), req.user.id); return Boolean(o && o.payment_mode === 'external'); };
r.post('/api/seller/orders/:id(\\d+)/ship', S, (req, res, next) => (direct(req) ? res.json(X.sellerShip(req.user, req.params.id, req.body)) : next()));
r.put('/api/seller/orders/:id(\\d+)/tracking', S, (req, res) => res.json(X.sellerCorrectTracking(req.user, req.params.id, req.body)));
r.post('/api/seller/orders/:id(\\d+)/request-address', S, (req, res) => res.json(X.sellerRequestAddress(req.user, req.params.id)));
r.post('/api/orders/:id(\\d+)/shipping-address', auth.requireUser, (req, res) => res.json(X.buyerSetAddress(req.user, req.params.id, req.body)));

module.exports = { router: r };
