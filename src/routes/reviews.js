'use strict';
// Seller reviews: buyer actions on their own order, reports on reviews, and the moderators' queue. All authorization is in src/reviews.js and again by the guards here.
const express = require('express');
const auth = require('../auth');
const RV = require('../reviews');
const RP = require('../reviewPhotos');
const V = require('../views');
const { esc, date } = require('../util');
const { page: adminPage } = require('./admin');

const r = express.Router();
const U = [auth.requireUser];
const S = [auth.requireStaff];
const when = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');

// The order id comes from the URL but ownership is checked server-side: only the buyer of that order can ever touch its review.
r.post('/api/orders/:id(\\d+)/review', U, async (req, res) => res.json({ ok: true, id: await RV.submit(req.user, req.params.id, req.body) }));
r.put('/api/orders/:id(\\d+)/review', U, async (req, res) => res.json({ ok: true, id: await RV.edit(req.user, req.params.id, req.body) }));
r.post('/api/orders/:id(\\d+)/review/remove', U, async (req, res) => res.json({ ok: true, id: await RV.remove(req.user, req.params.id) }));
r.post('/api/review-photos', U, express.raw({ type: ['image/*'], limit: '5mb' }), async (req, res) => res.json({ file: await RP.upload(req.user, req.body) }));
r.get('/review-photos/:id(\\d+)', async (req, res) => {
  const p = await RP.visible(req.user, req.params.id);
  if (!p) return res.status(404).type('text/plain').send('Not found');
  res.set({ 'Content-Type': p.mime, 'Content-Length': String(p.data.length), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300' });
  res.send(p.data);
});
r.post('/api/moderation/review-photos/:id(\\d+)/remove', S, async (req, res) => { auth.rateLimit(`mod:${req.user.id}`, 200, 3600); await RP.staffRemove(req.user, req.params.id, req.body.reason); res.json({ ok: true }); });
r.post('/api/reviews/:id(\\d+)/report', U, async (req, res) => res.json({ ok: true, id: await RV.report(req.user, req.params.id, req.body.reason) }));

r.get('/moderation/reviews', S, async (req, res) => {
  const { reported, hidden, recent } = await RV.moderationQueue();
  const card = (v, actions) => `<div class="panel"><p class="small muted" style="margin:0">Review #${v.id} of <a href="/s/${esc(v.handle)}">${esc(v.store_name || v.handle)}</a> by ${esc(v.buyer)} · order #${v.order_id} · ${when(v.created_at)} UTC${v.edited_at ? ' · edited' : ''} · ${v.thumbs_up ? 'thumbs-up' : 'no thumbs-up'}</p>
    ${RV.starsHtml(v.rating)}<p style="white-space:pre-wrap;margin:6px 0">${v.body ? esc(v.body) : '<span class="muted">(no text)</span>'}</p>${(v.photos || []).map((id) => `<span class="review-photo-mod"><a href="/review-photos/${id}" target="_blank" rel="noopener"><img src="/review-photos/${id}" alt="Review photo ${id}" width="96" height="96" loading="lazy"></a><button class="btn ghost small" data-photo="${id}">Remove photo</button></span>`).join(' ')}${v.reasons ? `<p class="small"><strong>Reports (${v.open_reports}):</strong> ${esc(v.reasons)}</p>` : ''}
    <p class="small muted">Moderators can hide or restore a review but cannot change its text or thumbs-up. <a href="/moderation/reviews/${v.id}">History</a></p>${actions}</div>`;
  const form = (v, buttons) => `<form class="revmod" data-review="${v.id}"><input name="reason" maxlength="1000" minlength="5" required placeholder="Reason (recorded)" aria-label="Reason">${buttons}<span class="small err-out" aria-live="polite"></span></form>`;
  await adminPage(req, res, { title: 'Review moderation', body: `<h1>Review moderation</h1>
    <p class="small muted">Inspect every review below; hide a whole review, or remove just a photo. Each action needs a reason and is written to the audit log.</p>
    <h2>Recent reviews (${recent.length})</h2>${recent.length ? recent.map((v) => card(v, form(v, '<button class="btn danger small" data-act="hide">Hide review</button>'))).join('') : '<p class="muted">None.</p>'}
    <h2>Reported reviews (${reported.length})</h2>${reported.length ? reported.map((v) => card(v, form(v, '<button class="btn danger small" data-act="hide">Hide review</button> <button class="btn ghost small" data-act="dismiss">Dismiss reports</button>'))).join('') : '<p class="muted">No open reports.</p>'}
    <h2>Hidden reviews (${hidden.length})</h2>${hidden.length ? hidden.map((v) => card(v, form(v, '<button class="btn small" data-act="restore">Restore review</button>'))).join('') : '<p class="muted">None.</p>'}
    <script>document.addEventListener('click',async function(e){var b=e.target.closest('[data-photo]');if(!b)return;var why=prompt('Reason for removing this photo (recorded in the audit log):');if(!why||why.trim().length<5)return;try{await pp.api('POST','/api/moderation/review-photos/'+b.dataset.photo+'/remove',{reason:why.trim()});location.reload()}catch(x){alert(x.message)}});
    document.querySelectorAll('.revmod').forEach(function(f){f.addEventListener('click',async function(e){var b=e.target.closest('[data-act]');if(!b)return;e.preventDefault();var o=f.querySelector('.err-out');o.textContent='';var why=f.reason.value.trim();
      if(why.length<5){o.textContent=' Write a reason first.';return}if(!confirm('Really '+b.dataset.act+' this review?\\n\\nReason: '+why))return;
      try{await pp.api('POST','/api/moderation/reviews/'+f.dataset.review+'/'+b.dataset.act,{reason:why});location.reload()}catch(x){o.textContent=' '+x.message}})})</script>` });
});
r.get('/moderation/reviews/:id(\\d+)', S, async (req, res) => {
  const h = await RV.history(req.params.id);
  await adminPage(req, res, { title: 'Review history', body: `<p><a href="/moderation/reviews">← Review moderation</a></p><h1>Review #${Number(req.params.id)} history</h1>${h.length ? `<ul class="timeline">${h.map((e) => `<li><strong>${esc(e.display_name)}</strong> <span class="muted small">(${esc(e.actor_role)}) · ${when(e.created_at)} UTC · ${esc(e.kind.replace('_', ' '))}</span>${e.detail ? `<p style="margin:2px 0;white-space:pre-wrap" class="small">${esc(e.detail)}</p>` : ''}</li>`).join('')}</ul>` : V.empty('No history', '')}` });
});
for (const [act, fn] of [['hide', RV.hide], ['restore', RV.restore], ['dismiss', RV.dismiss]]) {
  r.post(`/api/moderation/reviews/:id(\\d+)/${act}`, S, async (req, res) => { auth.rateLimit(`mod:${req.user.id}`, 200, 3600); await fn(req.user, req.params.id, req.body.reason); res.json({ ok: true }); });
}
void date;
module.exports = { router: r };
