'use strict';
// Beta administration: invitations + seller slots, sellers, email outbox, audit trail.
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const { esc, date, HttpError } = require('../util');
const V = require('../views');
const auth = require('../auth');
const invitations = require('../invitations');
const { audit } = require('../audit');
const { page, stat } = require('./admin');

const r = express.Router();
const A = [auth.requireAdmin];
const when = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');

r.get('/admin/invitations', A, async (req, res) => {
  const sl = await invitations.slots();
  const list = await q.all('SELECT i.*, c.display_name creator FROM invitations i JOIN users c ON c.id = i.created_by ORDER BY i.id DESC LIMIT 100');
  const status = (i) => (i.used_at ? 'accepted' : i.revoked_at ? 'revoked' : i.expires_at <= now() ? 'expired' : 'pending');
  await page(req, res, { title: 'Invitations', body: `<h1>Invitations</h1>
    ${sl.over ? `<div class="form-err">There are ${sl.used} seller accounts but the cap is ${sl.cap}. Existing accounts were preserved; no new seller can be added until a slot is released.</div>` : ''}
    <div class="stats">${stat('Seller slots used', `${sl.used} / ${sl.cap}`, 'suspended sellers still occupy a slot')}${stat('Pending seller invitations', sl.liveInvites, 'reserve a slot until used, revoked or expired')}${stat('Slots free to invite', sl.available)}</div>
    <div class="panel form-wide" style="margin-top:16px"><h3>Invite someone</h3><p class="small muted">The link is shown <strong>once</strong>; PairPlug stores only a hash. Invitations are single-use, bound to the email address, and expire after ${config.inviteTtlHours / 24} days. Buyers and sellers cannot create accounts any other way while sign-ups are closed.</p>
      <form id="invform" class="row" style="align-items:end"><div><label for="ie">Email</label><input id="ie" name="email" type="email" required></div>
        <div><label for="ik">Role</label><select id="ik" name="kind"><option value="buyer">Buyer</option><option value="seller">Seller (uses a slot)</option></select></div><div><label for="in">Note <span class="opt">(private)</span></label><input id="in" name="note" maxlength="200"></div><div><button class="btn" type="submit">Create invitation</button></div></form>
      <div id="invout" aria-live="polite"></div></div>
    <h2>History</h2>${list.length ? `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Expires</th><th>By</th><th></th></tr></thead><tbody>${list.map((i) => `<tr><td>${esc(i.email)}${i.note ? `<div class="muted small">${esc(i.note)}</div>` : ''}</td><td>${i.kind}</td><td>${status(i)}</td><td>${when(i.created_at)}</td><td>${when(i.expires_at)}</td><td>${esc(i.creator)}</td><td>${status(i) === 'pending' ? `<button class="btn ghost small" data-post="/api/admin/invitations/${i.id}/revoke" data-confirm="Revoke this invitation?">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No invitations yet', 'Create one above.')}
    <script>document.getElementById('invform').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,o=document.getElementById('invout');o.textContent='';try{const r=await pp.api('POST','/api/admin/invitations',Object.fromEntries(new FormData(f)));
      o.innerHTML='<div class="panel notice strong" style="margin-top:12px"><strong>Copy this link now — it will not be shown again:</strong><p style="word-break:break-all;user-select:all"></p></div>';o.querySelector('p').textContent=r.link;f.reset()}catch(x){o.innerHTML='<div class="form-err"></div>';o.firstChild.textContent=x.message}})</script>` });
});
// Direct, admin-only account creation and password reset. The temporary password is returned ONCE in this response (no-store) and nowhere else.
const accountsAdmin = require('../adminAccounts');
r.post('/api/admin/accounts/create', A, async (req, res) => { const out = await accountsAdmin.createAccount(req.user, req.body || {}); res.set('Cache-Control', 'no-store').json({ ok: true, ...out }); });
r.post('/api/admin/users/:id(\\d+)/reset-password', A, async (req, res) => { const out = await accountsAdmin.resetPassword(req.user, req.params.id); res.set('Cache-Control', 'no-store').json({ ok: true, ...out }); });
r.post('/api/admin/invitations', A, async (req, res) => {
  await auth.rateLimit(`inv-create:${req.user.id}`, 30, 3600);
  const out = await invitations.create(req.user, { kind: req.body.kind, email: req.body.email, note: req.body.note });
  res.set('Cache-Control', 'no-store').json({ ok: true, link: out.link, expiresAt: out.expiresAt });
});
r.post('/api/admin/invitations/:id(\\d+)/revoke', A, async (req, res) => { await invitations.revoke(req.user, req.params.id); res.json({ ok: true }); });

r.get('/admin/sellers', A, async (req, res) => {
  const sl = await invitations.slots();
  const sellers = await q.all(`SELECT u.*, (SELECT COUNT(*) FROM listings WHERE seller_id = u.id AND status = 'active') active_listings,
      (SELECT COUNT(*) FROM orders WHERE seller_id = u.id AND status IN ('pending_payment','paid','shipped')) open_orders,
      (SELECT COUNT(*) FROM cases WHERE subject_user_id = u.id AND status IN ('open','awaiting_seller','under_review')) open_cases FROM users u WHERE u.is_seller = 1 ORDER BY u.id`);
  await page(req, res, { title: 'Sellers', body: `<h1>Sellers <span class="muted small">${sl.used} of ${sl.cap} slots used</span></h1>
    <p class="small muted">Suspending a seller hides their active listings and signs them out; they <strong>keep</strong> their slot and can be reactivated. “Release slot” demotes the account to a buyer (needs no open orders) and frees the slot — use it only to replace a seller. Both actions are recorded in the audit log.</p>
    ${sellers.length ? `<div class="tablewrap"><table><thead><tr><th>Seller</th><th>Email</th><th>Status</th><th class="num">Active listings</th><th class="num">Open orders</th><th class="num">Open cases</th><th></th></tr></thead><tbody>${sellers.map((s) => `<tr><td><a href="/s/${esc(s.handle)}">${esc(s.store_name || s.handle)}</a><div class="muted small">@${esc(s.handle)}</div></td><td>${esc(s.email)}</td>
      <td>${s.banned ? '<span class="pill s-cancelled">Suspended</span>' : '<span class="pill s-active">Active</span>'} ${s.email_verified_at ? '<span class="pill s-paid">Email verified</span>' : '<span class="pill s-pending_payment">Email unverified</span>'}</td><td class="num">${s.active_listings}</td><td class="num">${s.open_orders}</td><td class="num">${s.open_cases}</td>
      <td style="white-space:nowrap"><button class="btn ghost small" data-post="/api/admin/users/${s.id}/ban" data-body='{"banned":${!s.banned}}' data-confirm="${s.banned ? 'Reactivate this seller?' : 'Suspend this seller? Their active listings will be hidden and they will be signed out.'}">${s.banned ? 'Reactivate' : 'Suspend'}</button>
      <button class="btn ghost small" data-post="/api/admin/sellers/${s.id}/release-slot" data-confirm="Release this seller's slot? They become a buyer and their listings are archived.">Release slot</button></td></tr>`).join('')}</tbody></table></div>` : V.empty('No sellers yet', 'Invite the first seller from the Invitations page.', ['/admin/invitations', 'Invitations'])}` });
});
r.post('/api/admin/sellers/:id(\\d+)/release-slot', A, async (req, res) => { await invitations.releaseSellerSlot(req.user, req.params.id); res.json({ ok: true }); });

r.get('/admin/outbox', A, async (req, res) => {
  const rows = await q.all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 100');
  await audit(req.user, 'outbox_viewed', { type: 'email_outbox' });
  const configured = require('../email').isConfigured();
  await page(req, res, { title: 'Email outbox', body: `<h1>Email outbox</h1>
    <div class="panel notice small">${configured ? 'An email provider is configured. Delivered messages keep no body.' : '<strong>No email provider is configured, so nothing below was sent.</strong> Verification and notification emails are only recorded here. You may hand a verification link to the right person yourself (for example for your first seller); treat links as secrets. Viewing this page is recorded in the audit log.'}</div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>To</th><th>Kind</th><th>Status</th><th>Message</th></tr></thead><tbody>${rows.map((m) => `<tr><td class="nowrap">${when(m.created_at)}</td><td>${esc(m.to_email)}</td><td>${esc(m.kind)}</td><td>${m.status === 'not_configured' ? '<span class="pill s-pending_payment">not sent</span>' : m.status === 'sent' ? `<span class="pill s-paid">sent${m.provider === 'mock-test' ? ' (test mock)' : ''}</span>` : '<span class="pill s-cancelled">failed</span>'}${m.error ? `<div class="muted small">${esc(m.error)}</div>` : ''}</td><td><pre style="white-space:pre-wrap;margin:0;font:12px/1.4 monospace">${esc(m.body)}</pre></td></tr>`).join('')}</tbody></table></div>` : V.empty('Nothing recorded', '')}` });
});

r.get('/admin/audit', A, async (req, res) => {
  const rows = await q.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
  await page(req, res, { title: 'Audit log', body: `<h1>Audit log</h1><p class="small muted">Append-only. Newest first (last 200).</p>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${rows.map((a) => `<tr><td class="nowrap">${when(a.created_at)}</td><td>${esc(a.actor_label)}</td><td>${esc(a.action)}</td><td>${esc([a.target_type, a.target_id].filter(Boolean).join(' #'))}</td><td class="small">${esc(a.detail || '')}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No entries yet', '')}` });
});

module.exports = { router: r };
