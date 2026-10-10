'use strict';
// Support cases (order issues, seller reports, reported messages) and refund requests. Founder-managed, deliberately simple.
//   * case_events are append-only (DB triggers). Internal notes (internal=1) can only be written by admins and are never shown to users.
//   * A refund request records who SAID what. PairPlug moves no money and cannot verify a Stripe refund:
//       requested -> seller_reported_refunded -> buyer_confirmed_refund   (the buyer independently confirms receipt)
//                                              -> buyer_disputes_refund    (escalates to an admin case)
//       requested -> seller_declined | admin_closed | admin_verified_refund
//     The order only becomes 'refunded' on buyer confirmation or an admin verification — never on the seller's say-so alone.
const { q, tx, now } = require('./db');
const { HttpError, clean } = require('./util');
const { rateLimit } = require('./auth');
const { ownedUploads } = require('./images');
const { transition } = require('./orderMachine');
const { notify } = require('./notify');
const { audit } = require('./audit');
const { memberConversation } = require('./chat/service');

const OPEN = ['open', 'awaiting_seller', 'under_review'];
const role = (c, userId) => (c.reporter_id === userId ? 'reporter' : c.subject_user_id === userId ? 'subject' : null);
const text = (v, min = 10, max = 2000, field = 'reason') => {
  const t = clean(v, max + 1);
  if (t.length < min) throw new HttpError(422, 'Please fix the highlighted fields.', { [field]: `Write at least ${min} characters.` });
  if (t.length > max) throw new HttpError(422, 'Please fix the highlighted fields.', { [field]: `Keep this under ${max} characters.` });
  return t;
};
const addEvent = (caseId, actor, actorRole, kind, body, { image = null, internal = 0 } = {}) =>
  q.run('INSERT INTO case_events(case_id, actor_id, actor_role, kind, body, image, internal, created_at) VALUES(?,?,?,?,?,?,?,?)', caseId, actor.id, actorRole, kind, body || null, image, internal, now());
const touch = (id, status) => q.run('UPDATE cases SET updated_at = ?, status = COALESCE(?, status) WHERE id = ?', now(), status || null, id);

// ------------------------------------------------------------------ opening cases
function reportOrder(user, orderId, { reason, evidence = [] }) {
  rateLimit(`case:${user.id}`, 10, 3600);
  const why = text(reason); const imgs = ownedUploads(user.id, evidence.slice(0, 4));
  return tx(() => {
    const o = q.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', Number(orderId), user.id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (o.status === 'cancelled' && !o.payment_confirmed_at) throw new HttpError(409, 'There is nothing to report on an order that was never paid.');
    if (q.get("SELECT 1 x FROM cases WHERE order_id = ? AND reporter_id = ? AND kind = 'order_issue' AND status IN ('open','awaiting_seller','under_review')", o.id, user.id)) throw new HttpError(409, 'You already have an open report for this order.');
    const c = q.run("INSERT INTO cases(kind, order_id, reporter_id, subject_user_id, reason, status, created_at, updated_at) VALUES('order_issue',?,?,?,?, 'awaiting_seller', ?, ?)", o.id, user.id, o.seller_id, why, now(), now());
    const id = Number(c.lastInsertRowid);
    addEvent(id, user, 'buyer', 'report', why); imgs.forEach((f) => addEvent(id, user, 'buyer', 'evidence', null, { image: f }));
    notify(o.seller_id, `case:${id}:opened`, 'A buyer reported a problem with an order', `Order #${o.id}: please respond so it can be resolved.`, `/cases/${id}`);
    audit(user, 'case_opened', { type: 'case', id, detail: { kind: 'order_issue', order: o.id } });
    return id;
  });
}
function reportSeller(user, handle, { reason }) {
  rateLimit(`case:${user.id}`, 10, 3600);
  const why = text(reason);
  const s = q.get('SELECT id FROM users WHERE handle = ? COLLATE NOCASE AND is_seller = 1', String(handle || '').slice(0, 40));
  if (!s) throw new HttpError(404, 'Seller not found');
  if (s.id === user.id) throw new HttpError(403, "You can't report yourself.");
  return tx(() => {
    const c = q.run("INSERT INTO cases(kind, reporter_id, subject_user_id, reason, status, created_at, updated_at) VALUES('seller_issue',?,?,?, 'open', ?, ?)", user.id, s.id, why, now(), now());
    addEvent(Number(c.lastInsertRowid), user, 'buyer', 'report', why); audit(user, 'case_opened', { type: 'case', id: c.lastInsertRowid, detail: { kind: 'seller_issue' } });
    return Number(c.lastInsertRowid);
  });
}
function reportMessage(user, { conversationId, messageId, reason }) {
  rateLimit(`case:${user.id}`, 10, 3600);
  const why = text(reason);
  const conv = memberConversation(user, conversationId);                       // only a member can report a conversation
  let mid = null;
  if (messageId) { const m = q.get('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', Number(messageId), conv.id); if (!m) throw new HttpError(404, 'Message not found'); mid = m.id; }
  const subject = conv.buyer_id === user.id ? conv.seller_id : conv.buyer_id;
  return tx(() => {
    const c = q.run("INSERT INTO cases(kind, conversation_id, message_id, reporter_id, subject_user_id, reason, status, created_at, updated_at) VALUES('message_report',?,?,?,?,?, 'under_review', ?, ?)", conv.id, mid, user.id, subject, why, now(), now());
    addEvent(Number(c.lastInsertRowid), user, conv.buyer_id === user.id ? 'buyer' : 'seller', 'report', why); audit(user, 'message_reported', { type: 'case', id: c.lastInsertRowid, detail: { conversation: conv.id, message: mid } });
    return Number(c.lastInsertRowid);
  });
}

// ------------------------------------------------------------------ reading
/** Cases a user may see: reporter always; the reported seller only for order issues (so they can respond). Admins see everything. */
function accessFor(user, c) {
  if (user.is_admin) return 'admin';
  if (c.reporter_id === user.id) return 'reporter';
  if (c.kind === 'order_issue' && c.subject_user_id === user.id) return 'subject';
  return null;
}
function view(user, id) {
  const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id));
  const access = c && accessFor(user, c);
  if (!access) throw new HttpError(404, 'Case not found');                     // 404, not 403: don't confirm it exists
  const events = q.all(`SELECT e.*, u.display_name FROM case_events e JOIN users u ON u.id = e.actor_id WHERE e.case_id = ? ${user.is_admin ? '' : 'AND e.internal = 0'} ORDER BY e.id`, c.id);
  return { case: c, access, events };
}
function mine(user) {
  return q.all('SELECT c.* FROM cases c WHERE c.reporter_id = ? OR (c.kind = \'order_issue\' AND c.subject_user_id = ?) ORDER BY c.updated_at DESC LIMIT 50', user.id, user.id);
}

// ------------------------------------------------------------------ parties respond
function respond(user, id, { body, evidence = [] }) {
  rateLimit(`case-msg:${user.id}`, 30, 3600);
  const t = text(body, 2, 2000, 'body'); const imgs = ownedUploads(user.id, evidence.slice(0, 4));
  return tx(() => {
    const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id)); const access = c && accessFor(user, c);
    if (!access || access === 'admin') throw new HttpError(404, 'Case not found');
    if (!OPEN.includes(c.status)) throw new HttpError(409, 'This case is closed.');
    const r = c.reporter_id === user.id ? (q.get('SELECT is_seller FROM users WHERE id = ?', user.id).is_seller && c.kind !== 'order_issue' ? 'seller' : 'buyer') : 'seller';
    addEvent(c.id, user, r, 'response', t); imgs.forEach((f) => addEvent(c.id, user, r, 'evidence', null, { image: f }));
    touch(c.id, access === 'subject' && c.status === 'awaiting_seller' ? 'under_review' : null);
    const other = access === 'subject' ? c.reporter_id : c.subject_user_id;
    if (other) notify(other, `case:${c.id}:msg:${Date.now() / 60000 | 0}`, 'New message on your case', `Case #${c.id} has a new reply.`, `/cases/${c.id}`);
    return true;
  });
}

// ------------------------------------------------------------------ admin
function adminNote(admin, id, body) { const t = text(body, 2, 2000, 'body'); const c = q.get('SELECT id FROM cases WHERE id = ?', Number(id)); if (!c) throw new HttpError(404, 'Case not found'); addEvent(c.id, admin, 'admin', 'internal_note', t, { internal: 1 }); touch(c.id); audit(admin, 'case_note_added', { type: 'case', id: c.id }); }
function adminMessage(admin, id, body) {
  const t = text(body, 2, 2000, 'body');
  return tx(() => {
    const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id)); if (!c) throw new HttpError(404, 'Case not found');
    addEvent(c.id, admin, 'admin', 'response', t); touch(c.id);
    for (const u of [c.reporter_id, c.kind === 'order_issue' ? c.subject_user_id : null]) if (u) notify(u, `case:${c.id}:admin:${now()}`, 'PairPlug replied to your case', `Case #${c.id} has a reply from PairPlug.`, `/cases/${c.id}`);
    audit(admin, 'case_replied', { type: 'case', id: c.id });
  });
}
function adminSetStatus(admin, id, status) {
  if (!OPEN.includes(status)) throw new HttpError(422, 'Choose open, awaiting seller or under review. Use Decide to close a case.');
  const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id)); if (!c) throw new HttpError(404, 'Case not found');
  if (!OPEN.includes(c.status)) throw new HttpError(409, 'This case is already closed.');
  addEvent(c.id, admin, 'admin', 'status', `Status set to ${status.replace('_', ' ')}`, { internal: 1 }); touch(c.id, status); audit(admin, 'case_status', { type: 'case', id: c.id, detail: { status } });
}
function adminDecide(admin, id, { outcome, resolution }) {
  if (!['resolved', 'dismissed'].includes(outcome)) throw new HttpError(422, 'Choose resolved or dismissed.');
  const note = text(resolution, 5, 2000, 'resolution');
  return tx(() => {
    const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id)); if (!c) throw new HttpError(404, 'Case not found');
    if (!OPEN.includes(c.status)) throw new HttpError(409, 'This case is already closed.');
    q.run('UPDATE cases SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?', outcome, note, admin.id, now(), now(), c.id);
    addEvent(c.id, admin, 'admin', 'decision', `${outcome === 'resolved' ? 'Resolved' : 'Dismissed'}: ${note}`);
    for (const u of [c.reporter_id, c.kind === 'order_issue' ? c.subject_user_id : null]) if (u) notify(u, `case:${c.id}:closed`, 'Your case was closed', `Case #${c.id}: ${outcome}. See the decision.`, `/cases/${c.id}`);
    audit(admin, 'case_decided', { type: 'case', id: c.id, detail: { outcome } });
  });
}
/** Consequential admin actions, recorded on the case (internal) and in the audit log. */
function adminAction(admin, id, { action, listingId }) {
  return tx(() => {
    const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id)); if (!c) throw new HttpError(404, 'Case not found');
    if (action === 'pause_listing') {
      const l = q.get('SELECT id, seller_id FROM listings WHERE id = ?', Number(listingId));
      if (!l || (c.subject_user_id && l.seller_id !== c.subject_user_id)) throw new HttpError(404, 'Listing not found for this case');
      q.run("UPDATE listings SET status = 'archived', updated_at = ? WHERE id = ? AND status IN ('active','draft')", now(), l.id);
      addEvent(c.id, admin, 'admin', 'action', `Listing #${l.id} paused`, { internal: 1 }); audit(admin, 'listing_paused_for_case', { type: 'listing', id: l.id, detail: { case: c.id } });
    } else if (action === 'suspend_seller') {
      if (!c.subject_user_id) throw new HttpError(409, 'This case has no seller to suspend.');
      q.run('UPDATE users SET banned = 1 WHERE id = ? AND is_admin = 0', c.subject_user_id); q.run('DELETE FROM sessions WHERE user_id = ?', c.subject_user_id);
      q.run("UPDATE listings SET status = 'archived' WHERE seller_id = ? AND status = 'active'", c.subject_user_id);
      addEvent(c.id, admin, 'admin', 'action', 'Seller suspended', { internal: 1 }); audit(admin, 'user_suspended', { type: 'user', id: c.subject_user_id, detail: { case: c.id } });
    } else throw new HttpError(422, 'Unknown action');
  });
}
/** Admin reads the conversation behind a REPORTED message/conversation. Only possible for cases that reference one; always audited. */
function adminConversation(admin, id) {
  const c = q.get('SELECT * FROM cases WHERE id = ?', Number(id));
  if (!c || !c.conversation_id) throw new HttpError(404, 'This case has no reported conversation.');
  audit(admin, 'reported_conversation_viewed', { type: 'case', id: c.id, detail: { conversation: c.conversation_id } });
  const around = c.message_id || Number.MAX_SAFE_INTEGER;
  const rows = q.all('SELECT m.*, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? AND m.id <= ? ORDER BY m.id DESC LIMIT 30', c.conversation_id, around).reverse();
  return rows;
}

// ------------------------------------------------------------------ refund requests
const REFUNDABLE = ['paid', 'shipped', 'delivered'];
const openRequest = (orderId) => q.get("SELECT * FROM refund_requests WHERE order_id = ? AND status IN ('requested','seller_reported_refunded','buyer_disputes_refund') ORDER BY id DESC LIMIT 1", orderId);
const latestRequest = (orderId) => q.get('SELECT * FROM refund_requests WHERE order_id = ? ORDER BY id DESC LIMIT 1', orderId);

function requestRefund(user, orderId, { kind = 'refund', reason }) {
  rateLimit(`refund:${user.id}`, 10, 3600);
  if (!['refund', 'cancellation'].includes(kind)) throw new HttpError(422, 'Choose refund or cancellation.');
  const why = text(reason);
  return tx(() => {
    const o = q.get("SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND payment_mode = 'external'", Number(orderId), user.id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!REFUNDABLE.includes(o.status)) throw new HttpError(409, 'A refund can only be requested after the seller has confirmed your payment.');
    if (kind === 'cancellation' && o.status !== 'paid') throw new HttpError(409, 'Cancellation is only possible before the order ships. Request a refund instead.');
    if (openRequest(o.id)) throw new HttpError(409, 'There is already an open refund request for this order.');
    const r = q.run("INSERT INTO refund_requests(order_id, kind, requested_by, reason, status, requested_at, updated_at) VALUES(?,?,?,?, 'requested', ?, ?)", o.id, kind, user.id, why, now(), now());
    notify(o.seller_id, `refund:${r.lastInsertRowid}:requested`, kind === 'cancellation' ? 'Cancellation requested' : 'Refund requested', `Order #${o.id}: respond in your order page. PairPlug does not move money; you refund through your own payment provider.`, `/dashboard/orders/${o.id}`);
    audit(user, 'refund_requested', { type: 'order', id: o.id, detail: { kind } });
    return Number(r.lastInsertRowid);
  });
}
/** The seller states what THEY did. This is an assertion: it does not change the order status. */
function sellerRespond(user, orderId, { action, reference, note }) {
  const ref = clean(reference, 80) || null;
  return tx(() => {
    const o = q.get("SELECT * FROM orders WHERE id = ? AND seller_id = ? AND payment_mode = 'external'", Number(orderId), user.id);
    if (!o) throw new HttpError(404, 'Order not found');
    let req = openRequest(o.id);
    if (action === 'report_refunded') {
      if (!REFUNDABLE.includes(o.status)) throw new HttpError(409, 'Only confirmed orders can be refunded.');
      if (req && req.status === 'seller_reported_refunded') throw new HttpError(409, 'You already reported this refund; waiting for the buyer to confirm.');
      if (!req) { const r = q.run("INSERT INTO refund_requests(order_id, kind, requested_by, reason, status, requested_at, updated_at) VALUES(?, 'refund', ?, 'Seller-initiated refund', 'requested', ?, ?)", o.id, user.id, now(), now()); req = q.get('SELECT * FROM refund_requests WHERE id = ?', r.lastInsertRowid); }
      q.run("UPDATE refund_requests SET status = 'seller_reported_refunded', refund_reference = ?, seller_note = ?, seller_responded_at = ?, updated_at = ? WHERE id = ?", ref, clean(note, 1000) || null, now(), now(), req.id);
      notify(o.buyer_id, `refund:${req.id}:reported`, 'The seller says your refund was sent', `Order #${o.id}: please check your payment account and confirm whether you received it. PairPlug cannot verify seller refunds.`, `/orders/${o.id}`);
    } else if (action === 'decline') {
      if (!req || req.status !== 'requested') throw new HttpError(409, 'There is no pending request to decline.');
      const n = text(note, 10, 1000, 'note');
      q.run("UPDATE refund_requests SET status = 'seller_declined', seller_note = ?, seller_responded_at = ?, resolved_at = ?, updated_at = ? WHERE id = ?", n, now(), now(), now(), req.id);
      notify(o.buyer_id, `refund:${req.id}:declined`, 'Your refund request was declined', `Order #${o.id}: the seller declined. You can report the issue to PairPlug support.`, `/orders/${o.id}`);
    } else throw new HttpError(422, 'Unknown action');
    audit(user, `refund_${action}`, { type: 'order', id: o.id });
    return true;
  });
}
function completeRefund(orderId, actorLabel, note) {
  const o = q.get('SELECT * FROM orders WHERE id = ?', orderId);
  transition(o.id, 'refunded', { actor: actorLabel, note, set: { refunded_cents: o.total_cents } });
  q.run("UPDATE listings SET status = 'archived', reserved_until = NULL, reserved_checkout_id = NULL WHERE id IN (SELECT listing_id FROM order_items WHERE order_id = ?)", o.id);   // the seller can resume it if they still have the item
}
/** The BUYER confirms (or denies) receiving the refund the seller reported. Only this completes it. */
function buyerConfirm(user, orderId, { received, note }) {
  return tx(() => {
    const o = q.get("SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND payment_mode = 'external'", Number(orderId), user.id);
    const req = o && openRequest(o.id);
    if (!req || req.status !== 'seller_reported_refunded') throw new HttpError(409, 'There is no seller-reported refund waiting for your confirmation.');
    if (received) {
      q.run("UPDATE refund_requests SET status = 'buyer_confirmed_refund', resolved_at = ?, updated_at = ? WHERE id = ?", now(), now(), req.id);
      completeRefund(o.id, `buyer:${user.id}`, 'Buyer confirmed the refund arrived');
      notify(o.seller_id, `refund:${req.id}:confirmed`, 'Buyer confirmed the refund', `Order #${o.id} is now marked refunded.`, `/dashboard/orders/${o.id}`);
    } else {
      const n = text(note, 10, 1000, 'note');
      q.run("UPDATE refund_requests SET status = 'buyer_disputes_refund', updated_at = ? WHERE id = ?", now(), req.id);
      let caseId = req.case_id;
      if (!caseId) {
        const c = q.run("INSERT INTO cases(kind, order_id, reporter_id, subject_user_id, reason, status, created_at, updated_at) VALUES('order_issue',?,?,?,?, 'under_review', ?, ?)", o.id, user.id, o.seller_id, `Refund not received: ${n}`, now(), now());
        caseId = Number(c.lastInsertRowid); q.run('UPDATE refund_requests SET case_id = ? WHERE id = ?', caseId, req.id);
        addEvent(caseId, user, 'buyer', 'report', `Refund not received: ${n}`);
      }
      notify(o.seller_id, `refund:${req.id}:disputed`, 'The buyer says the refund has not arrived', `Order #${o.id}: PairPlug support was notified (case #${caseId}).`, `/cases/${caseId}`);
      audit(user, 'refund_disputed', { type: 'order', id: o.id, detail: { case: caseId } });
    }
    return true;
  });
}
/** Admin outcome on a refund request: verified (the admin independently confirmed it) or closed without a refund. */
function adminResolveRefund(admin, requestId, { outcome, note }) {
  const n = text(note, 5, 1000, 'note');
  return tx(() => {
    const req = q.get('SELECT * FROM refund_requests WHERE id = ?', Number(requestId)); if (!req) throw new HttpError(404, 'Request not found');
    if (!['requested', 'seller_reported_refunded', 'buyer_disputes_refund'].includes(req.status)) throw new HttpError(409, 'This request is already resolved.');
    if (outcome === 'verified') {
      q.run("UPDATE refund_requests SET status = 'admin_verified_refund', seller_note = COALESCE(seller_note, ?), resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?", n, now(), admin.id, now(), req.id);
      completeRefund(req.order_id, `admin:${admin.id}`, `Admin verified the refund: ${n}`);
    } else if (outcome === 'closed') q.run("UPDATE refund_requests SET status = 'admin_closed', resolved_at = ?, resolved_by = ?, updated_at = ?, seller_note = COALESCE(seller_note, ?) WHERE id = ?", now(), admin.id, now(), n, req.id);
    else throw new HttpError(422, 'Choose verified or closed.');
    audit(admin, 'refund_admin_resolved', { type: 'refund_request', id: req.id, detail: { outcome } });
  });
}

module.exports = { OPEN, reportOrder, reportSeller, reportMessage, view, mine, respond, adminNote, adminMessage, adminSetStatus, adminDecide, adminAction, adminConversation, requestRefund, sellerRespond, buyerConfirm, adminResolveRefund, openRequest, latestRequest, REFUNDABLE };
