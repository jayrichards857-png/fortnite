'use strict';
// Moderator interface (/moderation), moderator setup links, and the administrator-only moderator management page.
// Authorization is enforced here and again inside src/moderation.js; hiding a button is never the control.
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const { esc, date, HttpError, money } = require('../util');
const V = require('../views');
const auth = require('../auth');
const M = require('../moderation');
const { page: adminPage, stat } = require('./admin');

const r = express.Router();
const S = [auth.requireStaff];
const A = [auth.requireAdmin];
const when = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');
const label = (s) => esc(String(s).replace(/_/g, ' '));
const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
const limit = (req) => auth.rateLimit(`mod:${req.user.id}`, 200, 3600);
const roleLabel = (u) => (u.is_admin ? 'administrator' : u.is_moderator ? 'moderator' : u.is_seller ? 'seller' : 'buyer');
const stateBadges = (u) => `${u.banned ? '<span class="pill s-disputed">banned</span> ' : ''}${u.selling_restricted_at ? '<span class="pill s-pending_payment">selling restricted</span> ' : ''}`;

// ------------------------------------------------------------------ setup link (public, individual, single-use)
r.get('/moderator/setup/:token', (req, res) => {
  noStore(res); auth.rateLimit(`modsetup-view:${req.ip}`, 60, 3600);
  const inv = M.lookup(req.params.token);
  const body = !inv ? V.empty('This setup link is invalid, expired or already used', 'Ask a PairPlug administrator for a new one.', ['/', 'Home'])
    : `<div class="narrow panel form-wide" style="max-width:520px"><h1>Set up your moderator account</h1>
    <p class="muted small">For <strong>${esc(inv.email)}</strong> · link expires ${when(inv.expires_at)} UTC. You choose your own password; nobody else sees it. This is a personal account: do not share it.</p>
    <form data-api="/api/moderator/setup" data-redirect="/moderation"><input type="hidden" name="token" value="${esc(req.params.token)}">
      <label for="n">Your name</label><input id="n" name="display_name" autocomplete="name" required>
      <label for="p">Password <span class="opt">(${M.MIN_PASSWORD}+ characters)</span></label><input id="p" name="password" type="password" autocomplete="new-password" minlength="${M.MIN_PASSWORD}" required>
      <label style="font-weight:400;display:flex;gap:8px;margin-top:12px"><input type="checkbox" name="terms" required> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and have read the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
      <button class="btn block" style="margin-top:14px" type="submit">Create moderator account</button></form></div>`;
  res.send(V.layout({ user: req.user, title: 'Moderator setup', body }));
});
r.post('/api/moderator/setup', (req, res) => {
  noStore(res); auth.rateLimit(`modsetup:${req.ip}`, 20, 3600);
  const uid = M.accept(String(req.body.token || ''), req.body);
  auth.createSession(res, uid);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ interface
r.get('/moderation', S, (req, res) => {
  const open = q.get("SELECT COUNT(*) n FROM cases WHERE status IN ('open','awaiting_seller','under_review')").n;
  const restricted = q.get('SELECT COUNT(*) n FROM users WHERE selling_restricted_at IS NOT NULL AND banned = 0').n, banned = q.get('SELECT COUNT(*) n FROM users WHERE banned = 1').n;
  const log = M.recentActions(8);
  adminPage(req, res, { title: 'Moderation', body: `<h1>Moderation</h1>
    <div class="stats">${stat('Open cases', open)}${stat('Selling restricted', restricted)}${stat('Banned accounts', banned)}</div>
    <form class="panel" action="/moderation/users" style="margin:12px 0"><label for="uq">Find a user <span class="opt">(name, store, handle or email)</span></label><div class="row" style="align-items:end"><div><input id="uq" name="q" minlength="2" required></div><div><button class="btn" type="submit">Search</button></div></div></form>
    <p><a class="btn ghost" href="/admin/cases">Review cases →</a> <a class="btn ghost" href="/admin/risk">Sellers reported by several buyers →</a></p>
    <h2>Recent actions</h2>${actionTable(log)}
    <p class="small muted">Every ban, unban, restriction and reversal needs a reason and is recorded permanently. Email is not a case: the contact inbox is ${V.contactLink()} and reports sent there must be entered or investigated by hand.</p>` });
});
const actionTable = (rows) => (rows.length ? `<div class="tablewrap"><table><thead><tr><th>When (UTC)</th><th>By</th><th>Action</th><th>Account</th><th>Reason</th><th>Case</th></tr></thead><tbody>${rows.map((a) => `<tr><td>${when(a.created_at)}</td><td>${esc(a.actor)} <span class="muted small">${a.actor_role}</span></td><td>${label(a.action)}</td><td><a href="/moderation/users/${a.target_id}">${esc(a.targetName || '')}${a.handle ? ` @${esc(a.handle)}` : ''}</a></td><td>${esc(a.reason)}</td><td>${a.case_id ? `<a href="/admin/cases/${a.case_id}">#${a.case_id}</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No moderation actions yet.</p>');
r.get('/moderation/log', S, (req, res) => adminPage(req, res, { title: 'Moderation log', body: `<h1>Moderation log</h1><p class="small muted">Append-only. Showing the latest 200.</p>${actionTable(M.recentActions(200))}` }));
r.get('/moderation/users', S, (req, res) => {
  const term = String(req.query.q || ''), rows = M.searchUsers(term);
  adminPage(req, res, { title: 'Find users', body: `<h1>Find users</h1><form class="panel" style="margin-bottom:12px"><label for="uq">Name, store, handle or email</label><div class="row" style="align-items:end"><div><input id="uq" name="q" value="${esc(term)}" minlength="2" required></div><div><button class="btn" type="submit">Search</button></div></div></form>
    ${term.length < 2 ? '<p class="muted">Enter at least 2 characters.</p>' : rows.length ? `<div class="tablewrap"><table><thead><tr><th>User</th><th>Role</th><th>Email (masked)</th><th>State</th><th>Joined</th></tr></thead><tbody>${rows.map((u) => `<tr><td><a href="/moderation/users/${u.id}">${esc(u.display_name)}</a>${u.handle ? ` <span class="muted small">@${esc(u.handle)}</span>` : ''}</td><td>${roleLabel(u)}</td><td class="muted">${esc(u.emailMasked)}</td><td>${stateBadges(u) || '—'}</td><td>${date(u.created_at)}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No matching users', 'Try a different name, store or handle.')}` });
});
r.get('/moderation/users/:id(\\d+)', S, (req, res) => {
  const v = M.userView(req.params.id);
  if (!v) return adminPage(req, res, { title: 'Not found', body: V.empty('User not found', '', ['/moderation/users', 'Find users']) });
  const u = v.user, me = req.user, staffTarget = u.is_admin || u.is_moderator, self = u.id === me.id;
  const blocked = self ? 'This is your own account.' : staffTarget && !me.is_admin ? 'Moderators cannot act on administrator or moderator accounts.' : '';
  const adminBan = u.banned && !me.is_admin && (!u.bannedBy || u.bannedBy.admin) ? 'This ban was placed by an administrator (or predates the moderation log); only an administrator can lift it.' : '';
  const ctl = (act, text, cls, show) => (show ? `<button type="button" class="btn ${cls} small" data-mod="${act}">${text}</button>` : '');
  const controls = blocked ? `<p class="muted small">${esc(blocked)}</p>` : `<form id="modform" class="panel"><h3>Actions</h3>
    <label for="mr">Reason <span class="opt">(required, recorded permanently, staff-only)</span></label><textarea id="mr" name="reason" maxlength="1000" required></textarea>
    <label for="mc">Related case <span class="opt">(optional case number)</span></label><input id="mc" name="caseId" inputmode="numeric" pattern="[0-9]*">
    <p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${ctl('ban', 'Ban account', 'danger', !u.banned)}${ctl('unban', 'Unban account', '', u.banned && !adminBan)}${ctl('restrict', 'Restrict selling', 'ghost', !u.banned && !u.selling_restricted_at && u.is_seller)}${ctl('lift', 'Lift selling restriction', 'ghost', Boolean(u.selling_restricted_at))}</p>
    ${adminBan ? `<p class="small muted">${esc(adminBan)}</p>` : ''}<p class="small muted">A ban takes effect immediately: sessions end, active listings are paused, orders, evidence and history are kept. It affects PairPlug only and does not disable the person's external payment links.</p><div id="modout" aria-live="polite"></div></form>
    <script>(function(){var f=document.getElementById('modform'),o=document.getElementById('modout'),T={ban:'ban',unban:'unban',restrict:'restrict selling for',lift:'lift the selling restriction for'};
    f.addEventListener('click',async function(e){var b=e.target.closest('[data-mod]');if(!b)return;var reason=f.reason.value.trim();o.textContent='';
      if(reason.length<5){o.innerHTML='<div class="form-err"></div>';o.firstChild.textContent='Write a reason of at least 5 characters first.';return}
      if(!confirm('Really '+T[b.dataset.mod]+' this account?\\n\\nReason: '+reason))return;
      try{await pp.api('POST','/api/moderation/users/${u.id}/'+b.dataset.mod,{reason:reason,caseId:f.caseId.value||null});location.href='/moderation/users/${u.id}?done='+b.dataset.mod}catch(x){o.innerHTML='<div class="form-err"></div>';o.firstChild.textContent=x.message}})})()</script>`;
  const done = { ban: 'Account banned. Sessions ended and listings paused.', unban: 'Account unbanned.', restrict: 'Selling restricted.', lift: 'Selling restriction lifted.' }[req.query.done];
  adminPage(req, res, { title: u.display_name, body: `<p><a href="/moderation/users">← Find users</a></p><h1>${esc(u.display_name)} ${stateBadges(u)}</h1>
    ${done ? `<div class="panel notice strong" role="status">${esc(done)}</div>` : ''}
    <p class="muted small">${roleLabel(u)}${u.handle ? ` · @${esc(u.handle)}` : ''}${u.store_name ? ` · store “${esc(u.store_name)}”` : ''} · joined ${date(u.created_at)} · ${esc(u.emailMasked)} · ${v.orders.asBuyer} order(s) as buyer, ${v.orders.asSeller} as seller${u.handle && !u.banned && !u.selling_restricted_at ? ` · <a href="/s/${esc(u.handle)}" target="_blank" rel="noopener">public profile ↗</a>` : ''}</p>
    ${u.banned ? `<div class="panel notice"><strong>Banned</strong> ${when(u.banned_at)} UTC${u.bannedBy ? ` by ${esc(u.bannedBy.name)} (${u.bannedBy.admin ? 'administrator' : 'moderator'})` : ' (before the moderation log existed)'}.<br>Reason: ${esc(u.banned_reason || 'not recorded')}</div>` : ''}
    ${u.selling_restricted_at ? `<div class="panel notice"><strong>Selling restricted</strong> since ${when(u.selling_restricted_at)} UTC. Reason: ${esc(u.selling_restricted_reason || 'not recorded')}</div>` : ''}
    <div class="two"><section>${controls}
      <div class="panel"><h3>Public bio</h3><p style="margin:0">${u.bio ? esc(u.bio) : '<span class="muted">None</span>'}</p></div>
      <div class="panel"><h3>Listings (${v.listings.length})</h3>${v.listings.length ? `<ul class="plain">${v.listings.map((l) => `<li>#${l.id} ${esc(l.title)} · ${money(l.price_cents)} · ${label(l.status)}</li>`).join('')}</ul>` : '<p class="muted small">None.</p>'}</div></section>
    <aside><div class="panel"><h3>Reports &amp; cases</h3>${v.cases.length ? `<ul class="plain">${v.cases.map((c) => `<li><a href="/admin/cases/${c.id}">Case #${c.id}</a> · ${label(c.kind)} · ${label(c.status)} · they are the ${c.role}</li>`).join('')}</ul>` : '<p class="muted small">None.</p>'}</div>
      <div class="panel"><h3>Moderation history</h3>${v.actions.length ? `<ul class="plain">${v.actions.map((a) => `<li>${when(a.created_at)} · <strong>${label(a.action)}</strong> by ${esc(a.actor)} (${a.actor_role}) — ${esc(a.reason)}${a.case_id ? ` · case #${a.case_id}` : ''}</li>`).join('')}</ul>` : '<p class="muted small">None.</p>'}</div></aside></div>` });
});
const act = (fn) => (req, res) => { limit(req); const o = fn(req.user, req.params.id, req.body.reason, req.body.caseId); res.set('Cache-Control', 'no-store').json({ ok: true, ...(o || {}) }); };
r.post('/api/moderation/users/:id(\\d+)/ban', S, act(M.ban));
r.post('/api/moderation/users/:id(\\d+)/unban', S, act(M.unban));
r.post('/api/moderation/users/:id(\\d+)/restrict', S, act(M.restrictSelling));
r.post('/api/moderation/users/:id(\\d+)/lift', S, act(M.liftRestriction));

// ------------------------------------------------------------------ administrator-only: moderator slots
r.get('/admin/moderators', A, (req, res) => {
  const s = M.slots(), ro = M.roster(), st = (i) => (i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at <= now() ? 'expired' : 'pending');
  adminPage(req, res, { title: 'Moderators', body: `<h1>Moderators</h1>
    <div class="stats">${stat('Moderator slots', `${s.active + s.pending} / ${s.cap}`, 'active moderators plus unused setup links')}${stat('Active moderators', s.active)}${stat('Unused setup links', s.pending)}${stat('Free slots', s.available)}</div>
    <div class="panel form-wide" style="margin-top:16px"><h3>Create a setup link</h3><p class="small muted">Creates one individual, single-use link (valid ${M.TTL_HOURS} hours) for a <strong>new</strong> email address. PairPlug does <strong>not</strong> email it: copy it and send it to that person yourself. Only a hash is stored, so it is shown once. The person chooses their own password.</p>
      <form id="mform" class="row" style="align-items:end"><div><label for="me">Moderator's email</label><input id="me" name="email" type="email" required></div><div><label for="mn">Note <span class="opt">(private)</span></label><input id="mn" name="note" maxlength="200"></div><div><button class="btn" type="submit"${s.available ? '' : ' disabled'}>Create setup link</button></div></form><div id="mout" aria-live="polite"></div></div>
    <h2>Active moderators</h2>${ro.active.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Since</th><th></th></tr></thead><tbody>${ro.active.map((u) => `<tr><td>${esc(u.display_name)}${u.banned ? ' <span class="pill s-disputed">banned</span>' : ''}</td><td>${esc(u.email)}</td><td>${date(u.created_at)}</td><td><button class="btn ghost small danger" data-deact="${u.id}">Deactivate</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No moderators yet.</p>'}
    <h2>Setup links</h2>${ro.invites.length ? `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Status</th><th>Created (UTC)</th><th>Expires (UTC)</th><th>Via</th><th></th></tr></thead><tbody>${ro.invites.map((i) => `<tr><td>${esc(i.email)}${i.note ? `<div class="muted small">${esc(i.note)}</div>` : ''}</td><td>${st(i)}</td><td>${when(i.created_at)}</td><td>${when(i.expires_at)}</td><td>${esc(i.created_via)}</td><td>${st(i) === 'pending' ? `<button class="btn ghost small" data-post="/api/admin/moderators/invites/${i.id}/revoke" data-confirm="Revoke this setup link?">Revoke</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None yet.</p>'}
    <script>document.getElementById('mform').addEventListener('submit',async e=>{e.preventDefault();var f=e.target,o=document.getElementById('mout');o.textContent='';try{var r=await pp.api('POST','/api/admin/moderators/invite',Object.fromEntries(new FormData(f)));o.innerHTML='<div class="panel notice strong" style="margin-top:12px"><strong>Copy this link now — it will not be shown again:</strong><p style="word-break:break-all;user-select:all"></p></div>';o.querySelector('p').textContent=r.link;f.reset()}catch(x){o.innerHTML='<div class="form-err"></div>';o.firstChild.textContent=x.message}});
    document.querySelectorAll('[data-deact]').forEach(b=>b.addEventListener('click',async()=>{var why=prompt('Reason for deactivating this moderator (recorded):');if(!why)return;try{await pp.api('POST','/api/admin/moderators/'+b.dataset.deact+'/deactivate',{reason:why});location.reload()}catch(x){alert(x.message)}}))</script>` });
});
r.post('/api/admin/moderators/invite', A, (req, res) => {
  auth.rateLimit(`modinvite:${req.user.id}`, 20, 3600);
  const out = M.invite(req.user, { email: req.body.email, note: req.body.note });
  res.set('Cache-Control', 'no-store').json({ ok: true, id: out.id, link: out.link, expiresAt: out.expiresAt });
});
r.post('/api/admin/moderators/invites/:id(\\d+)/revoke', A, (req, res) => { M.revokeInvite(req.user, req.params.id); res.json({ ok: true }); });
r.post('/api/admin/moderators/:id(\\d+)/deactivate', A, (req, res) => { auth.rateLimit(`modinvite:${req.user.id}`, 20, 3600); M.deactivate(req.user, req.params.id, req.body.reason); res.json({ ok: true }); });

void config; void HttpError;
module.exports = { router: r };
