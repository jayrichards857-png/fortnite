'use strict';
const express = require('express');
const config = require('../config');
const { q, tx, now, getSettings, setSetting } = require('../db');
const { esc, money, clean, date, HttpError, wrap } = require('../util');
const V = require('../views');
const auth = require('../auth');
const escrow = require('../escrow');
const { notify } = require('../notify');
const { transition } = require('../orderMachine');
const { audit } = require('../audit');
const invitations = require('../invitations');

const M = require('../moderation');
const r = express.Router();
const A = [auth.requireAdmin];
const STAFF_NAV = [['/moderation', 'Moderation'], ['/moderation/users', 'Find users'], ['/moderation/reviews', 'Reviews'], ['/moderation/payment-links', 'Payment links'], ['/admin/cases', 'Cases'], ['/admin/risk', 'Reported sellers'], ['/moderation/log', 'Action log']];
const nav = (p, staffOnly) => `<nav class="subnav">${(staffOnly ? STAFF_NAV : [['/admin', 'Overview'], ['/admin/accounts', 'Accounts'], ['/moderation', 'Moderation'], ['/moderation/reviews', 'Reviews'], ['/moderation/payment-links', 'Payment links'], ['/admin/moderators', 'Moderators'], ['/admin/invitations', 'Invitations'], ['/admin/sellers', 'Sellers'], ['/admin/cases', 'Cases'], ['/admin/risk', 'Reported sellers'], ['/admin/orders', 'Orders'], ['/admin/users', 'Users'], ['/admin/listings', 'Listings'], ['/admin/responses', 'Response times'], ['/admin/audit', 'Audit'], ['/admin/outbox', 'Email outbox'], ['/admin/disputes', 'Legacy disputes'], ['/admin/withdrawals', 'Legacy payouts']]).map(([h, l]) => `<a href="${h}"${p === h ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
const page = async (req, res, opts) => res.send(await V.layout({ user: req.user, wide: true, path: '/admin', ...opts, body: nav(req.path, !(req.user && req.user.is_admin)) + opts.body }));
const stat = (k, v, n = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${n ? `<div class="n">${n}</div>` : ''}</div>`;

r.get('/admin', A, async (req, res) => {
  const o = await q.get(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('pending_payment','cancelled')) orders,
    COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid','shipped','delivered','released','disputed')),0) gmv,
    COALESCE(SUM(platform_fee_cents) FILTER (WHERE status IN ('paid','shipped','delivered','released','disputed')),0) fees,
    COALESCE(SUM(processing_fee_cents) FILTER (WHERE status IN ('paid','shipped','delivered','released','disputed')),0) proc,
    COALESCE(SUM(refunded_cents) FILTER (WHERE status = 'refunded'),0) refunds,
    COALESCE(SUM(seller_payout_cents) FILTER (WHERE payment_mode = 'platform' AND status IN ('paid','shipped','delivered','disputed')),0) escrow FROM orders`);
  const c = await q.get(`SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM users WHERE is_seller=1) sellers, (SELECT COUNT(*) FROM listings WHERE status='active') active,
    (SELECT COUNT(*) FROM disputes WHERE status='open') disputes, (SELECT COUNT(*) FROM withdrawals WHERE status='requested') wd`);
  const failedRefunds = (await q.get("SELECT COUNT(*) n FROM refunds WHERE status <> 'succeeded'")).n;
  const sl = await invitations.slots(), openCases = (await q.get("SELECT COUNT(*) n FROM cases WHERE status IN ('open','awaiting_seller','under_review')")).n;
  await page(req, res, { title: 'Admin', body: `<h1>Marketplace</h1>${sl.over ? `<div class="form-err">There are ${sl.used} seller accounts but the beta cap is ${sl.cap}. Nothing was deleted; new sellers are blocked until this is resolved.</div>` : ''}<div class="stats">${stat('Seller slots', `${sl.used} / ${sl.cap}`, `${sl.liveInvites} pending invitation(s), ${sl.available} free`)}${stat('Open support cases', openCases)}${stat('Users', c.users, `${c.sellers} sellers`)}${stat('Active listings', c.active)}${stat('Orders', o.orders)}${stat('Gross merchandise value', money(o.gmv), 'buyer totals incl. shipping & tax')}
    ${stat('Platform fees', money(o.fees))}${stat('Processing fees (est.)', money(o.proc), 'paid to the processor')}${stat('Refunded', money(o.refunds))}${stat('Held in escrow', money(o.escrow), 'seller payouts pending')}
    ${stat('Open disputes', c.disputes)}${stat('Pending withdrawals', c.wd)}${stat('Refunds needing attention', failedRefunds)}</div>` });
});

r.get('/admin/disputes', A, async (req, res) => {
  const ds = await q.all(`SELECT d.*, o.total_cents, b.display_name buyer, s.store_name seller FROM disputes d JOIN orders o ON o.id = d.order_id JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id ORDER BY d.status = 'open' DESC, d.created_at DESC LIMIT 100`);
  await page(req, res, { title: 'Disputes', body: `<h1>Disputes</h1>${ds.length ? `<div class="tablewrap"><table><thead><tr><th>Dispute</th><th>Order</th><th>Buyer</th><th>Seller</th><th class="num">Amount</th><th>Status</th><th>Opened</th></tr></thead><tbody>${ds.map((d) => `<tr><td><a href="/admin/disputes/${d.id}">#${d.id}</a></td><td>#${d.order_id}</td><td>${esc(d.buyer)}</td><td>${esc(d.seller)}</td><td class="num">${money(d.total_cents)}</td><td>${V.statusPill(d.status === 'open' ? 'disputed' : d.status.replace('resolved_', ''))}</td><td>${date(d.created_at)}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No disputes', 'Disputes opened by buyers appear here.')}` });
});
r.get('/admin/disputes/:id(\\d+)', A, async (req, res) => {
  const d = await q.get('SELECT * FROM disputes WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).send(await V.layout({ user: req.user, title: 'Not found', body: V.empty('Not found', '') }));
  const o = await q.get('SELECT o.*, b.display_name buyer, s.store_name seller FROM orders o JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id WHERE o.id = ?', d.order_id);
  const items = await q.all('SELECT * FROM order_items WHERE order_id = ?', o.id), ev = await q.all('SELECT * FROM dispute_evidence WHERE dispute_id = ? ORDER BY id', d.id);
  const col = (party, name) => `<div class="panel"><h3>${name}</h3>${ev.filter((e) => e.party === party).map((e) => `${e.note ? `<p>${esc(e.note)}</p>` : ''}${e.image ? `<a href="/uploads/${esc(e.image)}" target="_blank" rel="noopener"><img src="/uploads/${esc(e.image)}" alt="${party} evidence" style="max-width:100%;border-radius:6px;margin-bottom:8px"></a>` : ''}`).join('') || '<p class="muted small">Nothing submitted.</p>'}</div>`;
  await page(req, res, { title: `Dispute #${d.id}`, body: `<h1>Dispute #${d.id} ${V.statusPill(d.status === 'open' ? 'disputed' : d.status.replace('resolved_', ''))}</h1>
  <p><a href="/orders/${o.id}">Order #${o.id}</a> · ${money(o.total_cents)} · ${V.statusPill(o.status)}</p><div class="panel"><strong>Items:</strong> ${items.map((i) => esc(i.title)).join(', ')}<p><strong>Buyer's reason:</strong> ${esc(d.reason)}</p></div>
  <h2>Evidence side by side</h2><div class="evid">${col('buyer', 'Buyer — ' + esc(o.buyer))}${col('seller', 'Seller — ' + esc(o.seller))}</div>
  ${d.status === 'open' ? `<div class="panel"><h3>Resolve</h3><label for="rn">Resolution note (shared with both parties)</label><textarea id="rn"></textarea>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn danger" id="rf">Refund buyer ${money(o.total_cents)}</button><button class="btn" id="rr">Release ${money(o.seller_payout_cents)} to seller</button></div></div>
    <script>for(const[id,dec]of[['rf','refund'],['rr','release']])document.getElementById(id).onclick=async()=>{if(!confirm('This is final. Continue?'))return;try{await pp.api('POST','/api/admin/disputes/${d.id}/resolve',{decision:dec,note:rn.value});location.reload()}catch(e){pp.toast(e.message,true)}}</script>`
    : `<div class="panel"><strong>Resolved</strong> ${date(d.resolved_at)}<p>${esc(d.resolution_note || '')}</p></div>`}` });
});
r.post('/api/admin/disputes/:id(\\d+)/resolve', A, wrap(async (req, res) => {
  const note = clean(req.body.note, 1000);
  if (!['refund', 'release'].includes(req.body.decision)) throw new HttpError(422, 'Choose refund or release.');
  const d = await q.get("SELECT * FROM disputes WHERE id = ? AND status = 'open'", Number(req.params.id));
  if (!d) throw new HttpError(404, 'No open dispute');
  // Resolve the dispute first (claim it atomically), then move the money.
  const claimed = await q.run("UPDATE disputes SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
    req.body.decision === 'refund' ? 'resolved_refund' : 'resolved_release', note || null, req.user.id, now(), d.id);
  if (claimed.changes !== 1) throw new HttpError(409, 'Already resolved');
  if (req.body.decision === 'refund') await escrow.refundOrder(d.order_id, { actor: `admin:${req.user.id}`, reason: `Dispute #${d.id} resolved for buyer`, relist: false });
  else await escrow.releaseToSeller(d.order_id, `admin:${req.user.id}`);
  res.json({ ok: true });
}));

r.get('/admin/users', A, async (req, res) => {
  const f = String(req.query.q || '').slice(0, 80), t = `%${f.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const us = await q.all(`SELECT * FROM users WHERE email ILIKE ? ESCAPE '\\' OR display_name ILIKE ? ESCAPE '\\' OR handle ILIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100`, t, t, t);
  await page(req, res, { title: 'Users', body: `<h1>Users</h1><form class="filterbar"><input type="search" name="q" placeholder="Search email, name, handle" value="${esc(f)}" aria-label="Search users"><button class="btn ghost small">Search</button></form>
  <div class="tablewrap"><table><thead><tr><th>User</th><th>Role</th><th>Plan</th><th>Joined</th><th>Actions</th></tr></thead><tbody>${us.map((u) => `<tr><td>${esc(u.display_name)}<div class="muted small">${esc(u.email)}</div></td><td>${[u.is_admin && 'admin', u.is_seller && 'seller'].filter(Boolean).join(', ') || 'buyer'}${u.banned ? ' <span class="pill s-disputed">banned</span>' : ''}</td><td>${u.plan}</td><td>${date(u.created_at)}</td>
    <td>${u.id === req.user.id ? '—' : `<button class="btn ghost small" data-reset-pw="${u.id}" data-email="${esc(u.email)}">Reset password</button> <button class="btn ghost small" data-post="/api/admin/users/${u.id}/ban" data-body='{"banned":${!u.banned}}'>${u.banned ? 'Unban' : 'Ban'}</button> ${u.is_seller ? `<a class="btn ghost small" href="/admin/sellers">Manage seller access</a>` : (u.is_admin ? '' : `<button class="btn ghost small" data-seller-invite="${u.id}" data-email="${esc(u.email)}">Invite as seller</button>`)} <button class="btn ghost small" data-admin-role="${u.id}" data-make="${!u.is_admin}" data-email="${esc(u.email)}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>`}</td></tr>`).join('')}</tbody></table></div>
  <p class="small muted">Seller access is invitation-only and limited to ${(await invitations.slots()).cap} accounts: “Invite as seller” creates a single-use invitation for that person's email (it uses one slot). Revoking or suspending sellers is on the Sellers page. Admin role changes ask for your password and are audit-logged.</p>
  <script>
  document.addEventListener('click',async e=>{
    const inv=e.target.closest('[data-seller-invite]'),role=e.target.closest('[data-admin-role]'),rst=e.target.closest('[data-reset-pw]');
    try{
      if(inv){if(!confirm('Create a seller invitation for '+inv.dataset.email+'? It reserves one of the seller slots.'))return;
        const r=await pp.api('POST','/api/admin/users/'+inv.dataset.sellerInvite+'/seller-invite',{});
        prompt('Copy this invitation link now. It will not be shown again:',r.link)}
      if(rst){if(!confirm('Reset the password for '+rst.dataset.email+'? Their current password stops working and they are signed out everywhere. Ban/suspension status is not changed.'))return;
        const r=await pp.api('POST','/api/admin/users/'+rst.dataset.resetPw+'/reset-password',{});
        prompt('Temporary password for '+rst.dataset.email+' (copy it now; it is shown once and they must replace it at first login):',r.tempPassword)}
      if(role){const make=role.dataset.make==='true';
        if(!confirm((make?'Give ADMINISTRATOR access to ':'Remove administrator access from ')+role.dataset.email+'?'))return;
        const pw=prompt('Confirm with YOUR password:');if(!pw)return;
        await pp.api('POST','/api/admin/users/'+role.dataset.adminRole+'/admin',{admin:make,password:pw});location.reload()}
    }catch(x){alert(x.message)}
  });
  </script>` });
});
// Administrator role changes: re-authenticate with the acting admin's own password; never yourself; never the last administrator. Always audited.
r.post('/api/admin/users/:id(\\d+)/admin', A, async (req, res) => {
  await auth.rateLimit(`admin-role:${req.user.id}`, 10, 3600);
  const id = Number(req.params.id), make = req.body.admin === true;
  if (!auth.verifyPassword(String(req.body.password || ''), req.user.password_hash)) throw new HttpError(403, 'Your password is incorrect.');
  if (id === req.user.id) throw new HttpError(400, "You can't change your own administrator role.");
  await tx(async () => {
    const t = await q.get('SELECT id, is_admin, banned FROM users WHERE id = ?', id);
    if (!t) throw new HttpError(404, 'User not found');
    if (Boolean(t.is_admin) === make) throw new HttpError(409, make ? 'Already an administrator.' : 'Not an administrator.');
    if (!make && (await q.get('SELECT COUNT(*) n FROM users WHERE is_admin = 1')).n <= 1) throw new HttpError(409, 'There must always be at least one administrator.');
    if (make && t.banned) throw new HttpError(409, 'Unban this account before making it an administrator.');
    await q.run('UPDATE users SET is_admin = ? WHERE id = ?', make ? 1 : 0, id);
    await audit(req.user, make ? 'admin_granted' : 'admin_revoked', { type: 'user', id });
  });
  res.json({ ok: true });
});
// "Approve seller access": issues the normal single-use invitation (so the cap, expiry and slot reservation all apply). The link is returned once.
r.post('/api/admin/users/:id(\\d+)/seller-invite', A, async (req, res) => {
  await auth.rateLimit(`inv-create:${req.user.id}`, 30, 3600);
  const u = await q.get('SELECT id, email, is_seller FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  if (u.is_seller) throw new HttpError(409, 'Already a seller.');
  const out = await invitations.create(req.user, { kind: 'seller', email: u.email, note: 'Created from Users page' });
  res.set('Cache-Control', 'no-store').json({ ok: true, link: out.link, expiresAt: out.expiresAt });
});
// Kept for back-compat with the Users table; now a thin wrapper over the moderation service (reason required, logged in moderation_actions + audit).
r.post('/api/admin/users/:id(\\d+)/ban', A, async (req, res) => {
  await auth.rateLimit(`mod:${req.user.id}`, 200, 3600);
  const out = req.body.banned ? await M.ban(req.user, req.params.id, req.body.reason, req.body.caseId) : await M.unban(req.user, req.params.id, req.body.reason, req.body.caseId);
  res.json({ ok: true, ...(out || {}) });
});
r.post('/api/admin/users/:id(\\d+)/plan', A, async (req, res) => {
  if (!['standard', 'pro'].includes(req.body.plan)) throw new HttpError(422, 'Invalid plan');
  await q.run('UPDATE users SET plan = ? WHERE id = ? AND is_seller = 1', req.body.plan, Number(req.params.id)); await audit(req.user, 'seller_plan_changed', { type: 'user', id: req.params.id, detail: { plan: req.body.plan } }); res.json({ ok: true });
});

r.get('/admin/listings', A, async (req, res) => {
  const ls = await q.all(`SELECT l.id, l.title, l.status, l.price_cents, l.created_at, u.store_name, u.handle FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.status <> 'draft' ORDER BY l.created_at DESC LIMIT 100`);
  await page(req, res, { title: 'Listings', body: `<h1>Listings</h1>${ls.length ? `<div class="tablewrap"><table><thead><tr><th>Listing</th><th>Seller</th><th class="num">Price</th><th>Status</th><th></th></tr></thead><tbody>${ls.map((l) => `<tr><td><a href="/listing/${l.id}">${esc(l.title)}</a></td><td>${esc(l.store_name || l.handle)}</td><td class="num">${money(l.price_cents)}</td><td>${V.statusPill(l.status)}</td><td>${l.status === 'active' ? `<button class="btn ghost small" data-post="/api/admin/listings/${l.id}/remove" data-confirm="Remove this listing from the marketplace?">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No listings', '')}` });
});
r.post('/api/admin/listings/:id(\\d+)/remove', A, async (req, res) => {
  const l = await q.get('SELECT * FROM listings WHERE id = ?', Number(req.params.id)); if (!l) throw new HttpError(404, 'Not found');
  await q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'", now(), l.id);
  await audit(req.user, 'listing_removed', { type: 'listing', id: l.id });
  await notify(l.seller_id, `listing:${l.id}:removed`, 'Listing removed', `“${l.title}” was removed by a moderator.`, '/dashboard/inventory'); res.json({ ok: true });
});

r.get('/admin/withdrawals', A, async (req, res) => {
  const ws = await q.all('SELECT w.*, u.store_name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.status = \'requested\' DESC, w.id DESC LIMIT 100');
  await page(req, res, { title: 'Withdrawals', body: `<h1>Withdrawals</h1>${ws.length ? `<div class="tablewrap"><table><thead><tr><th>Seller</th><th class="num">Amount</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>${ws.map((w) => `<tr><td>${esc(w.store_name || w.email)}</td><td class="num">${money(w.amount_cents)}</td><td>${V.statusPill(w.status === 'requested' ? 'pending_payment' : w.status === 'paid' ? 'active' : 'cancelled')} ${w.status}</td><td>${date(w.created_at)}</td>
    <td>${w.status === 'requested' ? `<button class="btn small" data-post="/api/admin/withdrawals/${w.id}" data-body='{"status":"paid"}' data-confirm="Mark as paid? Only after you've sent the funds.">Mark paid</button> <button class="btn ghost small" data-post="/api/admin/withdrawals/${w.id}" data-body='{"status":"rejected"}'>Reject</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No withdrawal requests', '')}` });
});
r.post('/api/admin/withdrawals/:id(\\d+)', A, async (req, res) => {
  if (!['paid', 'rejected'].includes(req.body.status)) throw new HttpError(422, 'Invalid status');
  await tx(async () => {
    const w = await q.get("SELECT * FROM withdrawals WHERE id = ? AND status = 'requested'", Number(req.params.id));
    if (!w) throw new HttpError(409, 'Already processed');
    await q.run('UPDATE withdrawals SET status = ?, resolved_at = ? WHERE id = ?', req.body.status, now(), w.id);
    if (req.body.status === 'rejected') await q.run("INSERT INTO ledger(user_id, kind, amount_cents, note, created_at) VALUES(?, 'adjustment', ?, ?, ?)", w.user_id, w.amount_cents, `Withdrawal #${w.id} rejected`, now());
    await notify(w.user_id, `withdrawal:${w.id}:${req.body.status}`, `Withdrawal ${req.body.status}`, `Withdrawal #${w.id} for ${money(w.amount_cents)} was ${req.body.status}.`, '/dashboard/finance');
  });
  res.json({ ok: true });
});

const FEE_FIELDS = [['fee_bps_standard', 'Standard transaction fee (basis points)'], ['fee_bps_pro', 'Pro transaction fee (basis points)'], ['processing_bps', 'Processing fee estimate (basis points)'], ['processing_fixed_cents', 'Processing fixed fee (cents)'], ['shipping_margin_bps', 'Shipping label margin (basis points)'], ['auto_release_days', 'Escrow auto-release (days after delivery)'], ['reservation_minutes', 'Checkout hold (minutes)']];
r.get('/admin/settings', A, async (req, res) => {
  const s = await getSettings();
  await page(req, res, { title: 'Settings', body: `<h1>Fees & settings</h1><div class="panel form-wide"><p class="small muted">Changes apply to <strong>new</strong> orders only; fees on existing orders are fixed at checkout. 100 basis points = 1%.</p>
  <form data-api="/api/admin/settings" data-method="PUT">${FEE_FIELDS.map(([k, l]) => `<label for="${k}">${l}</label><input id="${k}" name="${k}" inputmode="numeric" value="${s[k]}">`).join('')}<button class="btn" style="margin-top:14px" type="submit">Save</button></form></div>` });
});
r.put('/api/admin/settings', A, async (req, res) => {
  const lim = { fee_bps_standard: [0, 3000], fee_bps_pro: [0, 3000], processing_bps: [0, 1000], processing_fixed_cents: [0, 200], shipping_margin_bps: [0, 5000], auto_release_days: [0, 30], reservation_minutes: [5, 120] };
  const fields = {};
  for (const [k, [lo, hi]] of Object.entries(lim)) { const v = Number(req.body[k]); if (!Number.isInteger(v) || v < lo || v > hi) fields[k] = `Enter a whole number from ${lo} to ${hi}.`; }
  if (Object.keys(fields).length) throw new HttpError(422, 'Please fix the highlighted fields.', fields);
  for (const k of Object.keys(lim)) await setSetting(k, Number(req.body[k]));
  await audit(req.user, 'settings_changed', { type: 'settings', detail: Object.fromEntries(Object.keys(lim).map((k) => [k, Number(req.body[k])])) });
  res.json({ ok: true, message: 'Settings saved' });
});

module.exports = { router: r, page, nav, stat };
