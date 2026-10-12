'use strict';
// Support: report forms, case pages, refund requests, admin case/order tools, response-time visibility.
// All authorization lives in src/cases.js; these routes only render and translate.
const express = require('express');
const config = require('../config');
const { q, now } = require('../db');
const { esc, money, date, HttpError } = require('../util');
const V = require('../views');
const auth = require('../auth');
const cases = require('../cases');
const { audit } = require('../audit');
const F = require('../fraud');
const catSelect = (id) => `<label for="${id}">What happened?</label><select id="${id}" name="category">${Object.entries(F.CATEGORIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>`;
const { page: adminPage, stat } = require('./admin');

const r = express.Router();
const A = [auth.requireAdmin];
const S = [auth.requireStaff];
const M = require('../moderation');
const DISC = require('../disclosure');
const U = [auth.requireUser];
const when = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');
const label = (s) => esc(String(s).replace(/_/g, ' '));
const evidence = (b) => { try { const v = JSON.parse(b.evidence_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const uploader = (name, max) => `<div class="uploader" data-uploader="${name}" data-max="${max}"><label class="up-add"><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>+ Add photo</label></div><input type="hidden" name="${name}_json" data-uploader-value="${name}">`;
const UP = '<script src="/uploader.js" defer></script>';
const userPage = (req, res, opts) => res.send(V.layout({ user: req.user, path: '/support', ...opts }));

// ------------------------------------------------------------------ shared panels used by the order pages
/** Buyer order page: refund request / confirmation / report problem. Wording separates what each party SAYS from what PairPlug can verify. */
function buyerPanels(o) {
  const out = [];
  const req = cases.latestRequest(o.id);
  const label_ = { requested: 'Waiting for the seller to respond', seller_reported_refunded: 'The seller says they refunded you', seller_declined: 'The seller declined', buyer_confirmed_refund: 'You confirmed the refund', buyer_disputes_refund: 'You said the refund did not arrive. Support is reviewing', admin_verified_refund: 'PairPlug support verified the refund', admin_closed: 'Closed by PairPlug support' };
  if (req) {
    out.push(`<div class="panel"><h3>${req.kind === 'cancellation' ? 'Cancellation' : 'Refund'} request <span class="pill">${esc(label_[req.status] || req.status)}</span></h3>
      <p class="small muted" style="margin:0 0 8px">Requested ${date(req.requested_at)}. PairPlug does not move money and cannot see your payment account: a refund is only treated as complete when <strong>you</strong> confirm you received it, or PairPlug support independently verifies it.</p>
      <p style="margin:0 0 8px">${esc(req.reason)}</p>${req.seller_note ? `<p class="small" style="margin:0 0 8px"><strong>Seller:</strong> ${esc(req.seller_note)}${req.refund_reference ? ` (reference ${esc(req.refund_reference)})` : ''}</p>` : ''}
      ${req.status === 'seller_reported_refunded' ? `<div class="row" style="gap:8px"><button class="btn" data-post="/api/orders/${o.id}/refund-confirm" data-body='{"received":true}' data-confirm="Confirm that the money reached your account?">Yes, I received the refund</button>
        <details><summary class="btn ghost">I did not receive it</summary><form data-api="/api/orders/${o.id}/refund-confirm" data-reload style="margin-top:8px"><input type="hidden" name="received" value=""><label for="rn">What happened?</label><textarea id="rn" name="note" maxlength="1000" required></textarea><button class="btn danger" type="submit" style="margin-top:8px">Tell PairPlug support</button></form></details></div>` : ''}
      ${req.case_id ? `<p class="small" style="margin:8px 0 0"><a href="/cases/${req.case_id}">View support case #${req.case_id}</a></p>` : ''}</div>`);
  }
  if (['paid', 'shipped', 'delivered'].includes(o.status) && !cases.openRequest(o.id)) {
    out.push(`<details class="panel"><summary><strong>Request a refund${o.status === 'paid' ? ' or cancellation' : ''}</strong></summary>
      <form data-api="/api/orders/${o.id}/refund-request" data-reload style="margin-top:10px"><label for="rk">What do you want?</label><select id="rk" name="kind"><option value="refund">Refund</option>${o.status === 'paid' ? '<option value="cancellation">Cancel before shipping</option>' : ''}</select>
        <label for="rr">Reason</label><textarea id="rr" name="reason" maxlength="2000" required></textarea>
        <p class="small muted">The seller is asked to respond. They refund you themselves in their payment provider; PairPlug cannot refund for them. If they do not respond, you can report it below.</p><button class="btn" type="submit">Send request</button></form></details>`);
  }
  if (o.payment_confirmed_at || o.buyer_claimed_paid_at || o.pay_clicked_at) {
    const open = q.get("SELECT id FROM cases WHERE order_id = ? AND reporter_id = ? AND kind = 'order_issue' ORDER BY id DESC LIMIT 1", o.id, o.buyer_id);
    out.push(`<details class="panel"><summary><strong>Report a problem to PairPlug support</strong></summary>${open ? `<p class="small" style="margin-top:8px">You have a case for this order: <a href="/cases/${open.id}">case #${open.id}</a>.</p>` : ''}
      <form data-api="/api/cases/order" data-redirect="/cases/{id}" style="margin-top:10px"><input type="hidden" name="orderId" value="${o.id}">${catSelect('cat')}<label for="cr">Tell us what happened</label><textarea id="cr" name="reason" maxlength="2000" required></textarea>
        <label>Photos <span class="opt">(optional, up to 4)</span></label>${uploader('evidence', 4)}<p class="small muted">PairPlug reviews the evidence, can pause listings, restrict or suspend the seller's PairPlug account, and may report suspected fraud to the payment provider. PairPlug cannot move, freeze or refund money in the seller's payment account, so if you paid you should also contact your payment provider or card issuer, and keep your receipt.</p><button class="btn danger" type="submit">Open case</button></form></details>`);
  }
  return out.join('');
}
/** Seller order page: respond to a refund request and see any case. */
function sellerPanels(o) {
  const out = [];
  const req = cases.latestRequest(o.id);
  if (req && cases.openRequest(o.id)) {
    out.push(`<div class="panel notice strong"><h3>${req.kind === 'cancellation' ? 'Cancellation' : 'Refund'} request from the buyer</h3><p>${esc(req.reason)}</p>
      <p class="small muted">PairPlug moves no money. Refund the buyer in <strong>your</strong> payment provider, then tell us. The order is marked refunded only after the <strong>buyer</strong> confirms they received it.</p>
      ${req.status === 'requested' ? `<form data-api="/api/seller/orders/${o.id}/refund-response" data-reload><input type="hidden" name="action" value="report_refunded"><label for="rf">Refund reference <span class="opt">(optional)</span></label><input id="rf" name="reference" maxlength="80">
        <label style="font-weight:400;display:flex;gap:8px"><input type="checkbox" name="confirm_refunded" required> I have refunded the buyer in my payment provider.</label><button class="btn" type="submit" style="margin-top:10px">Report refund sent</button></form>
        <details style="margin-top:10px"><summary class="btn ghost">Decline</summary><form data-api="/api/seller/orders/${o.id}/refund-response" data-reload><input type="hidden" name="action" value="decline"><label for="dn">Explain why</label><textarea id="dn" name="note" maxlength="1000" required></textarea><button class="btn danger" type="submit" style="margin-top:8px">Decline request</button></form></details>`
      : `<p><strong>You reported this refund as sent.</strong> Waiting for the buyer to confirm${req.refund_reference ? ` (reference ${esc(req.refund_reference)})` : ''}.</p>`}</div>`);
  } else if (['paid', 'shipped', 'delivered'].includes(o.status)) {
    out.push(`<details class="panel"><summary><strong>Refund this order</strong></summary><p class="small muted">Refund the buyer in your payment provider first. The order is marked refunded only after the buyer confirms they received the money.</p>
      <form data-api="/api/seller/orders/${o.id}/refund-response" data-reload><input type="hidden" name="action" value="report_refunded"><label for="rf2">Refund reference <span class="opt">(optional)</span></label><input id="rf2" name="reference" maxlength="80">
        <label style="font-weight:400;display:flex;gap:8px"><input type="checkbox" name="confirm_refunded" required> I have refunded the buyer in my payment provider.</label><button class="btn danger" type="submit" style="margin-top:10px">Report refund sent</button></form></details>`);
  } else if (req) out.push(`<div class="panel"><h3>Refund request</h3><p class="small muted">Status: ${label(req.status)}.</p></div>`);
  const c = q.all("SELECT id, status FROM cases WHERE order_id = ? AND kind = 'order_issue' ORDER BY id DESC", o.id);
  if (c.length) out.push(`<div class="panel notice"><h3>Support case</h3>${c.map((x) => `<p style="margin:0"><a href="/cases/${x.id}">Case #${x.id}</a> · ${label(x.status)}</p>`).join('')}<p class="small muted">Please respond with your side and any evidence.</p></div>`);
  return out.join('');
}

// ------------------------------------------------------------------ user-facing
const eventLine = (e, admin) => {
  const who = e.actor_role === 'admin' ? 'PairPlug support' : esc(e.display_name) + ` <span class="muted small">(${esc(e.actor_role)})</span>`;
  const body = e.kind === 'evidence' && e.image ? `<a href="/uploads/${esc(e.image)}" target="_blank" rel="noopener"><img src="/uploads/${esc(e.image)}" alt="Evidence photo" style="max-width:240px;border-radius:6px"></a>` : `<p style="margin:2px 0 0;white-space:pre-wrap">${esc(e.body || '')}</p>`;
  return `<li${e.internal ? ' style="background:var(--warn-bg,#fff7e0);padding:6px;border-radius:6px"' : ''}><strong>${who}</strong> <span class="muted small">${when(e.created_at)} · ${label(e.kind)}${e.internal ? ' · INTERNAL, hidden from users' : ''}</span>${body}</li>`;
};

r.get('/support', (req, res) => {
  const mine = req.user ? cases.mine(req.user) : [];
  const contact = `<p><strong>Email ${V.contactLink()}</strong> for scam and fraud reports, concerns about a buyer or seller, account issues and appeals, safety concerns and general questions. <a href="/contact">Open the Contact page</a> for one-click email options.</p><p class="small muted">Email is read by the operator. It does not create a case automatically and there is no guaranteed response time; to attach photos and screenshots to a tracked case, use the report forms on this page.</p>`;
  const body = `<h1>Help &amp; reporting</h1><div class="two"><section>
    <div class="panel"><h3>How problems are handled</h3><ul class="plain"><li><strong>Message the seller first.</strong> Most problems are solved in a conversation. Sellers are expected to reply within <strong>48 hours</strong>. That is an expectation, not a guarantee.</li>
      <li>Buyers pay sellers through the seller's external payment link. <strong>PairPlug does not currently hold or directly control those funds</strong>, and cannot freeze, reverse or refund them. Refunds are issued by the seller in their own payment provider; <strong>your payment provider or card issuer handles chargebacks and payment disputes</strong>, so contact them as well if you were charged and did not get what you paid for.</li>
      <li><strong>Suspect a scam? Report it.</strong> PairPlug reviews reports and evidence, may contact both sides, and can pause listings, restrict selling, suspend accounts and report suspected fraud to the payment provider. These steps affect the seller's PairPlug account, not their payment account, and no outcome (such as a refund) is promised.</li>
      <li>Tracking shows where a carrier says a package is. It is not proof of delivery or of what was inside.</li></ul>${DISC.canCannot({ compact: true })}${contact}</div>
    <div class="panel" id="report-seller"><h3>Report a seller</h3>${req.user ? `<form data-api="/api/cases/seller" data-redirect="/cases/{id}"><label for="sh">Seller handle</label><input id="sh" name="handle" maxlength="40" value="${esc(req.query.seller || '')}" required>
      ${catSelect('sc')}<label for="so">Related order <span class="opt">(optional)</span></label><select id="so" name="orderId"><option value="">None / not sure</option>${q.all("SELECT o.id, s.handle FROM orders o JOIN users s ON s.id = o.seller_id WHERE o.buyer_id = ? AND o.payment_mode = 'external' ORDER BY o.id DESC LIMIT 30", req.user.id).map((o) => `<option value="${o.id}">Order #${o.id} · @${esc(o.handle)}</option>`).join('')}</select>
      <label for="sr">What happened?</label><textarea id="sr" name="reason" maxlength="2000" required></textarea>
      <label>Screenshots or photos <span class="opt">(optional, up to 4)</span></label>${uploader('evidence', 4)}
      <p class="small muted">The seller is not notified of a seller report. If you paid, keep your receipt and also contact your payment provider.</p><button class="btn danger" type="submit" style="margin-top:10px">Send report</button></form>` : `<p><a href="/login?next=/support">Log in</a> to send a report.</p>`}</div>
    <div class="panel"><h3>Report a review</h3><p class="small muted" style="margin:0">Open the seller's store, log in, and use <strong>Report this review</strong> under it. Moderators can hide a review that breaks the rules and the reason is recorded.</p></div>
    <div class="panel"><h3>Report a message</h3><p class="small muted">Open the conversation and use <strong>Report</strong> on the message. Only reported conversations can be read by PairPlug support, and each view is logged.</p></div></section>
    <aside class="panel"><h3>Your cases</h3>${mine.length ? `<ul class="plain">${mine.map((c) => `<li><a href="/cases/${c.id}">Case #${c.id}</a> · ${label(c.kind)} · ${label(c.status)}</li>`).join('')}</ul>` : '<p class="muted small">No cases yet.</p>'}</aside></div>`;
  userPage(req, res, { title: 'Help & reporting', body, scripts: UP });
});

r.get('/cases/:id(\\d+)', U, (req, res) => {
  let v; try { v = cases.view(req.user, req.params.id); } catch (e) { return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Case not found', 'It may not exist, or it belongs to someone else.', ['/support', 'Help & reporting']) })); }
  const c = v.case, open = cases.OPEN.includes(c.status);
  const body = `<h1>Case #${c.id} ${V.statusPill(c.status)}</h1><p class="muted small">${label(c.kind)} · opened ${date(c.created_at)}${c.order_id && v.access !== 'admin' ? ` · <a href="${v.access === 'subject' ? '/dashboard/orders/' : '/orders/'}${c.order_id}">Order #${c.order_id}</a>` : ''}</p>
    ${c.resolution ? `<div class="panel notice strong"><h3>Decision</h3><p style="margin:0">${esc(c.resolution)}</p></div>` : ''}
    <div class="panel"><h3>Conversation</h3><ul class="timeline">${v.events.map((e) => eventLine(e)).join('')}</ul></div>
    ${open ? `<form class="panel" data-api="/api/cases/${c.id}/respond" data-reload><h3>Add a reply or evidence</h3><textarea name="body" maxlength="2000" required aria-label="Reply"></textarea>${uploader('evidence', 4)}<button class="btn" type="submit" style="margin-top:10px">Send</button></form>` : ''}
    <p class="small muted">PairPlug support cannot freeze, reverse or refund money in the seller's payment account, and cannot promise an outcome; it can review the evidence, contact both sides, restrict the seller on PairPlug and report suspected fraud to the payment processor. Typical review time depends on the founder's availability; there is no guaranteed response time.</p>`;
  userPage(req, res, { title: `Case #${c.id}`, body, scripts: UP });
});

r.post('/api/cases/order', U, (req, res) => res.json({ ok: true, id: cases.reportOrder(req.user, req.body.orderId, { reason: req.body.reason, evidence: evidence(req.body), category: req.body.category }) }));
r.post('/api/cases/seller', U, (req, res) => res.json({ ok: true, id: cases.reportSeller(req.user, req.body.handle, { reason: req.body.reason, evidence: evidence(req.body), orderId: req.body.orderId, category: req.body.category }) }));
r.post('/api/chat/report', U, (req, res) => res.json({ ok: true, id: cases.reportMessage(req.user, { conversationId: req.body.conversationId, messageId: req.body.messageId, reason: req.body.reason }) }));
r.post('/api/cases/:id(\\d+)/respond', U, (req, res) => { cases.respond(req.user, req.params.id, { body: req.body.body, evidence: evidence(req.body) }); res.json({ ok: true }); });
r.post('/api/orders/:id(\\d+)/refund-request', U, (req, res) => res.json({ ok: true, id: cases.requestRefund(req.user, req.params.id, { kind: req.body.kind, reason: req.body.reason }) }));
r.post('/api/orders/:id(\\d+)/refund-confirm', U, (req, res) => { cases.buyerConfirm(req.user, req.params.id, { received: req.body.received === true, note: req.body.note }); res.json({ ok: true }); });
r.post('/api/seller/orders/:id(\\d+)/refund-response', auth.requireSeller, (req, res) => {
  if (req.body.action === 'report_refunded' && !(req.body.confirm_refunded === true || req.body.confirm_refunded === 'on')) throw new HttpError(422, 'Please confirm you refunded the buyer in your payment provider.', { confirm_refunded: 'Required' });
  cases.sellerRespond(req.user, req.params.id, { action: req.body.action, reference: req.body.reference, note: req.body.note });
  res.json({ ok: true });
});
// Back-compat endpoint: still only a REPORT. The order does not become refunded on the seller's word alone.
r.post('/api/seller/orders/:id(\\d+)/refunded', auth.requireSeller, (req, res) => {
  if (!(req.body.confirm_refunded === true || req.body.confirm_refunded === 'on')) throw new HttpError(422, 'Please confirm you refunded the buyer in your payment provider.', { confirm_refunded: 'Required' });
  cases.sellerRespond(req.user, req.params.id, { action: 'report_refunded', reference: req.body.reference });
  res.json({ ok: true, status: 'seller_reported_refunded' });
});

// ------------------------------------------------------------------ admin
r.get('/admin/cases', S, (req, res) => {
  const st = req.query.status === 'closed' ? 'closed' : 'open';
  const rows = q.all(`SELECT c.*, rp.display_name reporter, sj.display_name subject FROM cases c JOIN users rp ON rp.id = c.reporter_id LEFT JOIN users sj ON sj.id = c.subject_user_id
    WHERE c.status ${st === 'open' ? "IN ('open','awaiting_seller','under_review')" : "NOT IN ('open','awaiting_seller','under_review')"} ORDER BY c.updated_at DESC LIMIT 200`);
  adminPage(req, res, { title: 'Cases', body: `<h1>Cases</h1><p><a href="/admin/cases">Open</a> · <a href="/admin/cases?status=closed">Closed</a></p>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Case</th><th>Kind</th><th>Status</th><th>Reporter</th><th>About</th><th>Updated</th></tr></thead><tbody>${rows.map((c) => `<tr><td><a href="/admin/cases/${c.id}">#${c.id}</a></td><td>${label(c.kind)}</td><td>${V.statusPill(c.status)}</td><td>${esc(c.reporter)}</td><td>${esc(c.subject || '')}${c.order_id ? ` · order #${c.order_id}` : ''}</td><td>${when(c.updated_at)}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No cases', '', ['/admin', 'Back'])}` });
});
r.get('/admin/cases/:id(\\d+)', S, (req, res) => {
  const v = cases.view(req.user, req.params.id), c = v.case, open = cases.OPEN.includes(c.status);
  const o = c.order_id && q.get('SELECT id, status, total_cents, seller_id, buyer_id FROM orders WHERE id = ?', c.order_id);
  const listings = c.subject_user_id ? q.all("SELECT id, title, status FROM listings WHERE seller_id = ? AND status IN ('active','draft') ORDER BY id DESC LIMIT 50", c.subject_user_id) : [];
  const rr = c.order_id && q.get('SELECT * FROM refund_requests WHERE order_id = ? ORDER BY id DESC LIMIT 1', c.order_id);
  const risk = c.subject_user_id && c.kind !== 'message_report' ? F.sellerRisk(c.subject_user_id) : null, provs = risk ? F.providersFor(c) : [], packets = risk ? F.packetsFor(c.id) : [];
  const riskPanel = risk ? `<div class="panel"><h3>Seller: ${esc(risk.user.store_name || risk.user.handle)} <span class="muted small">@${esc(risk.user.handle)}</span></h3>
      <p class="small" style="margin:0 0 6px"><strong>${risk.reporters}</strong> different buyer(s) have reported this seller (${risk.cases} case(s): ${risk.open} open, ${risk.resolved} resolved, ${risk.dismissed} dismissed). Counts of reports, not findings.</p>
      <p class="small" style="margin:0 0 6px">Orders: ${risk.orders} (${risk.pending} awaiting payment confirmation, ${risk.seller_confirmed} the seller says were paid, ${risk.refunded} refunded). <em>PairPlug has not verified any of these payments.</em></p>
      <p class="small" style="margin:0 0 8px">${risk.user.banned ? '<span class="pill s-disputed">suspended</span> ' : ''}${risk.user.selling_restricted_at ? `<span class="pill s-pending_payment">selling restricted since ${when(risk.user.selling_restricted_at)}</span> <span class="muted">${esc(risk.user.selling_restricted_reason || '')}</span>` : 'No PairPlug restriction.'}</p>
      <p class="small muted" style="margin:0 0 8px">Restricting or suspending affects the seller's PairPlug account only. It does not freeze, hold or reverse anything in their Stripe/PayPal account.</p>
      ${risk.user.selling_restricted_at ? `<form data-api="/api/admin/cases/${c.id}/action" data-reload><input type="hidden" name="action" value="lift_restriction"><input name="reason" maxlength="300" placeholder="Why (optional)" aria-label="Reason to lift"><button class="btn ghost small" type="submit">Lift restriction</button></form>`
        : `<form data-api="/api/admin/cases/${c.id}/action" data-reload><input type="hidden" name="action" value="restrict_selling"><label for="rs">Restrict selling while this is investigated</label><input id="rs" name="reason" maxlength="500" required placeholder="Reason (kept internal)"><p class="small muted">Pauses their listings, blocks publishing and new orders, hides the store, warns buyers with unpaid orders, and stops sending buyers to their payment link.</p><button class="btn danger small" type="submit">Restrict selling</button></form>`}</div>
    ${req.user.is_admin ? `<div class="panel"><h3>Payment-provider report</h3><p class="small muted">PairPlug has no integration with Stripe or PayPal: this prepares a factual packet for <strong>you</strong> to send through the provider's own fraud/abuse channel, and records that you did. PairPlug cannot see the provider's response or make it act.</p>
      ${packets.length ? `<ul class="plain">${packets.map((p) => `<li>#${p.id} · ${esc(F.PROVIDER_NAME[p.provider])} · ${p.status === 'submitted' ? `submitted ${when(p.submitted_at)} via ${esc(p.channel)}${p.reference ? ` (ref ${esc(p.reference)})` : ''}` : `prepared ${when(p.prepared_at)}, not yet submitted`} · <a href="/admin/processor-packets/${p.id}">Download packet</a>
        ${p.status === 'prepared' ? `<form data-api="/api/admin/processor-packets/${p.id}/submitted" data-reload style="margin-top:6px"><input name="channel" maxlength="120" placeholder="How you submitted it (e.g. provider's fraud report form)" required aria-label="Channel"><input name="reference" maxlength="120" placeholder="Provider's reference (optional)" aria-label="Reference"><button class="btn small" type="submit">I submitted this</button></form>` : ''}</li>`).join('')}</ul>` : '<p class="small">No packets yet.</p>'}
      ${(provs.length ? provs : [{ provider: 'other', host: '' }]).map((p) => `<button class="btn ghost small" data-post="/api/admin/cases/${c.id}/processor-packet" data-body='${JSON.stringify({ provider: p.provider, host: p.host })}'>Prepare ${esc(F.PROVIDER_NAME[p.provider])} packet${p.host ? ` (${esc(p.host)})` : ''}</button>`).join(' ')}</div>` : ''}` : '';
  adminPage(req, res, { title: `Case #${c.id}`, body: `<h1>Case #${c.id} ${V.statusPill(c.status)}</h1><p class="muted small">${label(c.kind)}${c.category ? ` · reporter says: ${esc(F.CATEGORIES[c.category])}` : ''} · opened ${when(c.created_at)}${o ? ` · order #${o.id} (${label(o.status)}, ${money(o.total_cents)})` : ''}</p>
    <div class="two"><section><div class="panel"><h3>Timeline</h3><ul class="timeline">${v.events.map((e) => eventLine(e, true)).join('')}</ul></div>
      ${F.caseRecords(c.id).map((rc) => `<div class="panel"><h3>Preserved record <span class="muted small">(${when(rc.created_at)} UTC · sha256 ${esc(rc.sha256.slice(0, 12))}…)</span></h3><pre class="small" style="white-space:pre-wrap;margin:0">${esc(rc.content)}</pre><p class="small muted" style="margin:6px 0 0">Frozen when the report was filed. Staff-only; not shown to the buyer or seller.</p></div>`).join('')}
      ${c.conversation_id ? `<div class="panel"><h3>Reported conversation</h3><p class="small muted">Opening it is recorded in the audit log.</p><button class="btn ghost" id="vc">View reported conversation</button><div id="conv"></div></div>` : ''}
      ${c.resolution ? `<div class="panel notice"><h3>Decision</h3><p>${esc(c.resolution)}</p></div>` : ''}</section>
    <aside>${riskPanel}${open ? `<form class="panel" data-api="/api/admin/cases/${c.id}/note" data-reload><h3>Internal note</h3><textarea name="body" maxlength="2000" required aria-label="Internal note"></textarea><button class="btn ghost small" type="submit">Save note (hidden from users)</button></form>
      <form class="panel" data-api="/api/admin/cases/${c.id}/reply" data-reload><h3>Reply to the parties</h3><textarea name="body" maxlength="2000" required aria-label="Reply"></textarea><button class="btn small" type="submit">Send reply</button></form>
      <form class="panel" data-api="/api/admin/cases/${c.id}/status" data-reload><h3>Status</h3><select name="status" aria-label="Status">${cases.OPEN.map((s) => `<option value="${s}"${c.status === s ? ' selected' : ''}>${label(s)}</option>`).join('')}</select><button class="btn ghost small" type="submit">Update</button></form>
      <form class="panel" data-api="/api/admin/cases/${c.id}/action" data-reload><h3>Actions</h3>${listings.length ? `<input type="hidden" name="action" value="pause_listing"><label for="al">Pause a listing</label><select id="al" name="listingId">${listings.map((l) => `<option value="${l.id}">#${l.id} ${esc(l.title)}</option>`).join('')}</select><button class="btn ghost small" type="submit">Pause listing</button>` : '<p class="small muted">No active listings to pause.</p>'}</form>
      ${c.subject_user_id && risk && !risk.user.banned ? `<form class="panel" data-api="/api/admin/cases/${c.id}/action" data-reload><input type="hidden" name="action" value="suspend_seller"><h3>Ban from PairPlug</h3><label for="bn">Reason (recorded, staff-only)</label><input id="bn" name="reason" maxlength="1000" required>
        <label style="font-weight:400;display:flex;gap:8px;margin-top:8px"><input type="checkbox" name="confirm" required> I confirm: end their sessions, pause their listings and block this account. Orders and evidence are kept.</label><p class="small muted">A ban affects PairPlug only; it does not disable their external payment links.</p><button class="btn danger small" type="submit">Ban account</button></form>` : ''}
      <form class="panel" data-api="/api/admin/cases/${c.id}/decide" data-reload><h3>Decide and close</h3><select name="outcome" aria-label="Outcome"><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select><textarea name="resolution" maxlength="2000" required aria-label="Decision"></textarea><button class="btn small" type="submit">Close case</button></form>` : ''}
      ${req.user.is_admin && rr && ['requested', 'seller_reported_refunded', 'buyer_disputes_refund'].includes(rr.status) ? `<form class="panel" data-api="/api/admin/refunds/${rr.id}/resolve" data-reload><h3>Refund request (${label(rr.status)})</h3><p class="small muted">Mark verified only if you independently confirmed the refund (for example, the seller's provider receipt). Otherwise close without a refund.</p><select name="outcome" aria-label="Outcome"><option value="verified">Verified: refund happened</option><option value="closed">Close without refund</option></select><textarea name="note" maxlength="1000" required aria-label="Note"></textarea><button class="btn small" type="submit">Record outcome</button></form>` : ''}</aside></div>
    ${c.conversation_id ? `<script>document.getElementById('vc').addEventListener('click',async()=>{try{const r=await pp.api('POST','/api/admin/cases/${c.id}/conversation',{});const d=document.getElementById('conv');d.textContent='';for(const m of r.messages){const p=document.createElement('p');p.style.margin='4px 0';const s=document.createElement('strong');s.textContent=m.display_name+': ';p.append(s,document.createTextNode(m.body||''));d.append(p)}}catch(e){alert(e.message)}})</script>` : ''}` });
});
r.post('/api/admin/cases/:id(\\d+)/note', S, (req, res) => { cases.adminNote(req.user, req.params.id, req.body.body); res.json({ ok: true }); });
r.post('/api/admin/cases/:id(\\d+)/reply', S, (req, res) => { cases.adminMessage(req.user, req.params.id, req.body.body); res.json({ ok: true }); });
r.post('/api/admin/cases/:id(\\d+)/status', S, (req, res) => { cases.adminSetStatus(req.user, req.params.id, req.body.status); res.json({ ok: true }); });
r.post('/api/admin/cases/:id(\\d+)/decide', S, (req, res) => { cases.adminDecide(req.user, req.params.id, { outcome: req.body.outcome, resolution: req.body.resolution }); res.json({ ok: true }); });
r.post('/api/admin/cases/:id(\\d+)/action', S, (req, res) => { cases.adminAction(req.user, req.params.id, { action: req.body.action, listingId: req.body.listingId, reason: req.body.reason }); res.json({ ok: true }); });
r.post('/api/admin/cases/:id(\\d+)/processor-packet', A, (req, res) => {
  const c = q.get('SELECT * FROM cases WHERE id = ?', Number(req.params.id)); if (!c) throw new HttpError(404, 'Case not found');
  res.json({ ok: true, id: F.preparePacket(req.user, c, String(req.body.provider || ''), String(req.body.host || '').slice(0, 100)) });
});
r.post('/api/admin/processor-packets/:id(\\d+)/submitted', A, (req, res) => { F.markSubmitted(req.user, req.params.id, { channel: req.body.channel, reference: req.body.reference, note: req.body.note }); res.json({ ok: true }); });
r.get('/admin/processor-packets/:id(\\d+)', A, (req, res) => {
  const p = q.get('SELECT * FROM processor_reports WHERE id = ?', Number(req.params.id)); if (!p) return res.status(404).send('Not found');
  audit(req.user, 'processor_packet_downloaded', { type: 'case', id: p.case_id, detail: { packet: p.id } });
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="pairplug-case-${p.case_id}-${p.provider}-packet.txt"`, 'Cache-Control': 'no-store' }).send(p.packet);
});
r.get('/admin/risk', S, (req, res) => {
  const rows = F.repeatReported();
  adminPage(req, res, { title: 'Reported sellers', body: `<h1>Sellers reported by more than one buyer</h1><p class="small muted">Counts of reports by different buyers, not findings. Open the newest case to review evidence and act.</p>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Seller</th><th class="num">Different reporters</th><th class="num">Cases</th><th class="num">Open</th><th>State</th><th>Latest</th><th></th></tr></thead><tbody>${rows.map((s) => `<tr><td>${esc(s.store_name || s.handle)} <span class="muted small">@${esc(s.handle)}</span></td><td class="num">${s.reporters}</td><td class="num">${s.cases}</td><td class="num">${s.open}</td><td>${s.banned ? 'suspended' : s.selling_restricted_at ? 'selling restricted' : '—'}</td><td>${when(s.latest)}</td><td><a href="/admin/cases">Cases</a></td></tr>`).join('')}</tbody></table></div>` : V.empty('No repeat reports', 'No seller has been reported by two or more different buyers.')}` });
});
r.post('/api/admin/cases/:id(\\d+)/conversation', S, (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, messages: cases.adminConversation(req.user, req.params.id).map((m) => ({ display_name: m.display_name, body: m.body, created_at: m.created_at })) }));
r.post('/api/admin/refunds/:id(\\d+)/resolve', A, (req, res) => { cases.adminResolveRefund(req.user, req.params.id, { outcome: req.body.outcome, note: req.body.note }); res.json({ ok: true }); });

/** Orders overview: no addresses, no payment links, no message content. */
r.get('/admin/orders', A, (req, res) => {
  const rows = q.all(`SELECT o.id, o.status, o.payment_mode, o.total_cents, o.created_at, o.carrier, o.tracking_number, b.display_name buyer, s.store_name seller, s.handle,
      (SELECT status FROM refund_requests rr WHERE rr.order_id = o.id ORDER BY rr.id DESC LIMIT 1) refund, (SELECT COUNT(*) FROM cases c WHERE c.order_id = o.id AND c.status IN ('open','awaiting_seller','under_review')) open_cases
    FROM orders o JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id WHERE o.payment_mode = 'external' ORDER BY o.id DESC LIMIT 200`);
  adminPage(req, res, { title: 'Orders', body: `<h1>Orders</h1><p class="small muted">Direct-checkout orders. PairPlug holds no funds. Addresses and message content are not shown here.</p>${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Order</th><th>Status</th><th>Buyer</th><th>Seller</th><th class="num">Total</th><th>Refund</th><th>Open cases</th><th>Started</th></tr></thead><tbody>${rows.map((o) => `<tr><td>#${o.id}</td><td>${V.orderPill(o)}</td><td>${esc(o.buyer)}</td><td>${esc(o.seller || o.handle)}</td><td class="num">${money(o.total_cents)}</td><td>${o.refund ? label(o.refund) : '—'}</td><td>${o.open_cases || '—'}</td><td>${when(o.created_at)}</td></tr>`).join('')}</tbody></table></div>` : V.empty('No orders yet', '', ['/admin', 'Back'])}` });
});

/** Response-time visibility: conversations whose last message is from the buyer and has waited more than 48 hours. Metadata only; no message text. Informational, never an automatic penalty. */
r.get('/admin/responses', A, (req, res) => {
  const cutoff = now() - 48 * 3600;
  const rows = q.all(`SELECT c.id, c.seller_id, s.store_name, s.handle, m.created_at last_at FROM conversations c JOIN users s ON s.id = c.seller_id
    JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id) WHERE m.sender_id = c.buyer_id AND m.created_at < ? ORDER BY m.created_at`, cutoff);
  const by = new Map(); rows.forEach((x) => by.set(x.seller_id, { name: x.store_name || x.handle, n: (by.get(x.seller_id)?.n || 0) + 1, oldest: Math.min(by.get(x.seller_id)?.oldest || x.last_at, x.last_at) }));
  adminPage(req, res, { title: 'Response times', body: `<h1>Unanswered conversations</h1><p class="small muted">Buyer messages that have waited more than 48 hours without a reply. Elapsed time only; nothing is penalised automatically. Use it to check in with a seller.</p>
    ${by.size ? `<div class="tablewrap"><table><thead><tr><th>Seller</th><th class="num">Unanswered over 48h</th><th>Oldest waiting since</th></tr></thead><tbody>${[...by.values()].map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.n}</td><td>${when(s.oldest)} (${Math.floor((now() - s.oldest) / 3600)}h)</td></tr>`).join('')}</tbody></table></div>` : V.empty('Nothing waiting', 'No buyer message has gone unanswered for more than 48 hours.', ['/admin', 'Back'])}` });
});

module.exports = { router: r, buyerPanels, sellerPanels };
