'use strict';
// Scam-report tooling for the operator. PairPlug moves no money and has NO provider integration, so nothing here can freeze, hold, reverse or refund
// funds in a seller's Stripe/PayPal account. What it can do is act on PairPlug itself (restrict selling, pause listings, suspend), keep an auditable
// evidence trail, and prepare a factual packet the operator submits to the payment provider BY HAND (and then records that they did).
const config = require('./config');
const { q, tx, now } = require('./db');
const { HttpError, clean } = require('./util');
const { notify } = require('./notify');
const { audit } = require('./audit');
const crypto = require('node:crypto');

const CATEGORIES = {
  non_delivery: 'I paid and never received the item',
  payment_not_confirmed: 'I paid but the seller will not confirm or respond',
  not_as_described: 'Item is not as described',
  counterfeit: 'Item looks counterfeit',
  fake_payment_or_tracking: 'Fake payment confirmation or tracking number',
  suspected_scam: 'Other suspected scam',
  other: 'Something else',
};
const category = (v) => { if (v === undefined || v === null || v === '') return 'suspected_scam'; if (!Object.hasOwn(CATEGORIES, v)) throw new HttpError(422, 'Please fix the highlighted fields.', { category: 'Choose what happened.' }); return v; };

/** Is selling currently blocked for this seller by PairPlug (restriction or suspension)? Account restrictions are not financial holds. */
const sellerHeld = (sellerId) => { const u = q.get('SELECT banned, selling_restricted_at r FROM users WHERE id = ?', Number(sellerId)); return Boolean(u && (u.banned || u.r)); };

/** Buyers with an unconfirmed order from this seller are warned, because the payment link itself is outside PairPlug and keeps working. */
function warnPendingBuyers(sellerId, why) {
  let n = 0;
  for (const o of q.all("SELECT id, buyer_id FROM orders WHERE seller_id = ? AND payment_mode = 'external' AND status = 'pending_payment'", sellerId)) {
    notify(o.buyer_id, `order:${o.id}:seller-held`, 'Please do not pay for this order yet', `Order #${o.id}: PairPlug is reviewing a report about this seller (${why}). If you already paid, keep your receipt and contact your payment provider if needed.`, `/orders/${o.id}`); n++;
  }
  return n;
}

// ------------------------------------------------------------------ risk summary (operator only)
/** Facts about reports against a seller. Counts only: how many different people reported, how many cases, order outcomes. Nothing is scored or auto-actioned. */
function sellerRisk(sellerId) {
  const c = q.get(`SELECT COUNT(*) cases, COUNT(DISTINCT reporter_id) reporters, COUNT(*) FILTER (WHERE status IN ('open','awaiting_seller','under_review')) open,
      COUNT(*) FILTER (WHERE status = 'resolved') resolved, COUNT(*) FILTER (WHERE status = 'dismissed') dismissed, COUNT(*) FILTER (WHERE payment_mismatch = 1) mismatch FROM cases WHERE subject_user_id = ? AND kind <> 'message_report' AND reporter_id <> subject_user_id`, sellerId);
  c.suspensions = q.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'seller_suspended_temporarily' AND target_id = ?", String(sellerId)).n;
  const o = q.get(`SELECT COUNT(*) orders, COUNT(*) FILTER (WHERE status = 'pending_payment') pending, COUNT(*) FILTER (WHERE status IN ('paid','shipped','delivered')) seller_confirmed,
      COUNT(*) FILTER (WHERE status = 'refunded') refunded FROM orders WHERE seller_id = ? AND payment_mode = 'external'`, sellerId);
  const u = q.get('SELECT handle, store_name, banned, selling_restricted_at, selling_restricted_reason, created_at FROM users WHERE id = ?', sellerId);
  const pr = q.get("SELECT COUNT(*) n, COUNT(*) FILTER (WHERE status = 'submitted') submitted FROM processor_reports WHERE seller_id = ?", sellerId);
  return { ...c, ...o, user: u, processorReports: pr };
}
/** Sellers reported by two or more different people (any status), for the operator's review queue. */
const repeatReported = () => q.all(`SELECT u.id, u.handle, u.store_name, u.banned, u.selling_restricted_at, COUNT(DISTINCT c.reporter_id) reporters, COUNT(*) cases,
    COUNT(*) FILTER (WHERE c.status IN ('open','awaiting_seller','under_review')) open, MAX(c.created_at) latest
  FROM cases c JOIN users u ON u.id = c.subject_user_id WHERE c.kind <> 'message_report' AND c.reporter_id <> c.subject_user_id GROUP BY u.id HAVING reporters >= 2 ORDER BY open DESC, reporters DESC, latest DESC LIMIT 100`);

// ------------------------------------------------------------------ payment-provider packet
const providerOf = (host) => (/(^|\.)stripe\.com$/i.test(host) ? 'stripe' : /(^|\.)paypal\.(com|me)$/i.test(host) ? 'paypal' : 'other');
const PROVIDER_NAME = { stripe: 'Stripe', paypal: 'PayPal', other: 'the payment provider' };
const ts = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const usd = (c) => `$${(c / 100).toFixed(2)}`;

/** Providers evident from the payment links the seller's orders in this case actually used (never guessed from a name). */
function providersFor(caseRow) {
  const hosts = new Map();
  const orders = caseRow.order_id ? [q.get('SELECT snapshot_json FROM orders WHERE id = ?', caseRow.order_id)] : q.all("SELECT snapshot_json FROM orders WHERE seller_id = ? AND payment_mode = 'external' ORDER BY id DESC LIMIT 50", caseRow.subject_user_id);
  for (const o of orders) { try { const h = JSON.parse(o.snapshot_json).paymentLink.host; if (h) hosts.set(providerOf(h) + '|' + h, { provider: providerOf(h), host: h }); } catch { /* order without a snapshot */ } }
  return [...hosts.values()];
}
/** Plain-text packet. Facts are labelled by who stated them. Excludes: internal notes, buyer address/email, passwords or anything not needed to identify the transactions. */
function buildPacket(caseRow, provider, host) {
  const subject = q.get('SELECT id, handle, store_name, created_at FROM users WHERE id = ?', caseRow.subject_user_id);
  const reporter = q.get('SELECT display_name FROM users WHERE id = ?', caseRow.reporter_id);
  const orders = caseRow.order_id ? q.all('SELECT * FROM orders WHERE id = ?', caseRow.order_id) : q.all("SELECT * FROM orders WHERE seller_id = ? AND payment_mode = 'external' AND status <> 'cancelled' ORDER BY id DESC LIMIT 20", caseRow.subject_user_id);
  const events = q.all('SELECT e.*, u.display_name FROM case_events e JOIN users u ON u.id = e.actor_id WHERE e.case_id = ? AND e.internal = 0 ORDER BY e.id', caseRow.id);
  const L = [];
  L.push(`PairPlug report of suspected fraud — case #${caseRow.id}`, `Prepared ${ts(now())} for ${PROVIDER_NAME[provider]}${host ? ` (seller's payment link host: ${host})` : ''}`, '',
    'WHAT THIS IS: a report from PairPlug, an online marketplace. PairPlug does not process, hold or see these payments; the payments were made through the seller\'s own payment link.',
    'Statements below are labelled by who made them. PairPlug has NOT independently verified any payment, shipment or delivery.', '',
    `SELLER (PairPlug account): ${subject.store_name || subject.handle} (@${subject.handle}), PairPlug account created ${ts(subject.created_at)}`,
    `REPORTER: ${reporter.display_name} (buyer)  ·  report category (reporter's choice): ${CATEGORIES[caseRow.category || 'suspected_scam']}  ·  opened ${ts(caseRow.created_at)}`, '');
  if (orders.length) {
    L.push('ORDERS (reference shown to the buyer as "PP-<number>" on the payment link):');
    for (const o of orders) {
      const claim = o.buyer_claimed_paid_at ? `buyer said they paid ${ts(o.buyer_claimed_paid_at)}` : 'buyer has not said they paid';
      const conf = o.payment_confirmed_at ? `seller said payment received ${ts(o.payment_confirmed_at)} (seller statement, unverified)` : 'seller has not confirmed payment';
      L.push(`  - PP-${o.id}: ${usd(o.total_cents)}, created ${ts(o.created_at)}, PairPlug status "${o.status}"; ${claim}; ${conf}${o.tracking_number ? `; seller-entered tracking ${o.carrier || ''} ${o.tracking_number}` : '; no tracking entered'}`);
    }
    L.push('');
  }
  L.push('TIMELINE (as written by each party; internal PairPlug notes are not included):');
  for (const e of events) L.push(`  [${ts(e.created_at)}] ${e.actor_role === 'admin' ? 'PairPlug support' : `${e.display_name} (${e.actor_role})`} — ${e.kind}${e.image ? `: photo attached (file ${e.image})` : e.body ? `: ${String(e.body).replace(/\s+/g, ' ').slice(0, 1000)}` : ''}`);
  const other = q.get("SELECT COUNT(DISTINCT reporter_id) n FROM cases WHERE subject_user_id = ? AND kind <> 'message_report' AND id <> ?", caseRow.subject_user_id, caseRow.id).n;
  L.push('', `OTHER REPORTS: ${other} other buyer(s) have reported this seller to PairPlug (counts only; not verified findings).`,
    'PAIRPLUG ACTIONS TO DATE: see the timeline; account restrictions are PairPlug-side only and do not affect any payment account.',
    'Evidence photos are held by PairPlug and can be supplied on request through the channel you use.');
  return L.join('\n');
}

/** Create (or refuse to duplicate) a packet for one provider. A second packet is allowed only when the case has new evidence since the last one. */
function preparePacket(admin, caseRow, provider, host) {
  if (!Object.hasOwn(PROVIDER_NAME, provider)) throw new HttpError(422, 'Choose a provider.');
  if (!caseRow.subject_user_id) throw new HttpError(409, 'This case has no seller to report.');
  return tx(() => {
    const open = q.get("SELECT id FROM processor_reports WHERE case_id = ? AND provider = ? AND status = 'prepared'", caseRow.id, provider);
    if (open) throw new HttpError(409, 'A packet for this provider is already prepared and waiting to be submitted.');
    const maxEv = q.get('SELECT COALESCE(MAX(id), 0) m FROM case_events WHERE case_id = ? AND internal = 0', caseRow.id).m;
    const last = q.get("SELECT events_through FROM processor_reports WHERE case_id = ? AND provider = ? ORDER BY id DESC LIMIT 1", caseRow.id, provider);
    if (last && maxEv <= last.events_through) throw new HttpError(409, 'This case was already reported to that provider and has no new evidence since.');
    const id = q.run('INSERT INTO processor_reports(case_id, seller_id, provider, provider_host, packet, events_through, prepared_by, prepared_at) VALUES(?,?,?,?,?,?,?,?)',
      caseRow.id, caseRow.subject_user_id, provider, host || null, buildPacket(caseRow, provider, host), maxEv, admin.id, now()).lastInsertRowid;
    q.run("INSERT INTO case_events(case_id, actor_id, actor_role, kind, body, internal, created_at) VALUES(?,?,?,?,?,1,?)", caseRow.id, admin.id, 'admin', 'action', `Prepared a ${PROVIDER_NAME[provider]} report packet (#${id}). Not yet submitted.`, now());
    audit(admin, 'processor_packet_prepared', { type: 'case', id: caseRow.id, detail: { provider, packet: Number(id) } });
    return Number(id);
  });
}
/** The operator records that THEY submitted the packet through the provider's own channel. PairPlug did not send anything. */
function markSubmitted(admin, id, { channel, reference, note }) {
  const ch = clean(channel, 120); if (ch.length < 3) throw new HttpError(422, 'Please fix the highlighted fields.', { channel: 'Say how you submitted it (for example the provider\'s abuse/fraud report form or support email).' });
  return tx(() => {
    const p = q.get('SELECT * FROM processor_reports WHERE id = ?', Number(id)); if (!p) throw new HttpError(404, 'Packet not found');
    if (p.status !== 'prepared') throw new HttpError(409, 'This packet was already recorded as submitted.');
    q.run("UPDATE processor_reports SET status = 'submitted', submitted_by = ?, submitted_at = ?, channel = ?, reference = ?, note = ? WHERE id = ?", admin.id, now(), ch, clean(reference, 120) || null, clean(note, 500) || null, p.id);
    q.run("INSERT INTO case_events(case_id, actor_id, actor_role, kind, body, internal, created_at) VALUES(?,?,?,?,?,1,?)", p.case_id, admin.id, 'admin', 'action', `Operator recorded submitting packet #${p.id} to ${PROVIDER_NAME[p.provider]} via "${ch}"${reference ? ` (their reference: ${clean(reference, 120)})` : ''}. PairPlug did not send it automatically and cannot see the provider's response.`, now());
    audit(admin, 'processor_packet_submitted', { type: 'case', id: p.case_id, detail: { packet: p.id, provider: p.provider } });
  });
}
const packetsFor = (caseId) => q.all('SELECT id, provider, provider_host, status, prepared_at, submitted_at, channel, reference FROM processor_reports WHERE case_id = ? ORDER BY id DESC', caseId);

/** Freeze the facts of a reported order at the moment of the report: order state and money figures as recorded (all unverified claims are labelled as claims), tracking as entered by the
 *  seller, and a fingerprint of the buyer/seller conversation (count, last id, SHA-256 of the message texts). The messages themselves stay stored unaltered; there is no delete path. */
function preserveOrderRecord(caseId, orderId) {
  const o = q.get('SELECT * FROM orders WHERE id = ?', Number(orderId)); if (!o) return null;
  const conv = q.get('SELECT id FROM conversations WHERE buyer_id = ? AND seller_id = ?', o.buyer_id, o.seller_id);
  const msgs = conv ? q.all('SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id', conv.id) : [];
  const h = crypto.createHash('sha256'); for (const m of msgs) h.update(`${m.id}|${m.sender_id}|${m.created_at}|${m.body}\n`);
  const ts = (t) => (t ? new Date(t * 1000).toISOString() : null);
  const content = JSON.stringify({
    order: { id: o.id, status: o.status, payment_mode: o.payment_mode, total_cents: o.total_cents, subtotal_cents: o.subtotal_cents, shipping_cents: o.shipping_cents, created_at: ts(o.created_at),
      buyer_said_paid_at: ts(o.buyer_claimed_paid_at), seller_said_payment_received_at: ts(o.payment_confirmed_at), payment_reference_entered_by_seller: o.payment_reference || null, payment_independently_verified: false,
      carrier_entered_by_seller: o.carrier || null, tracking_entered_by_seller: o.tracking_number || null, shipped_at: ts(o.shipped_at), delivered_at: ts(o.delivered_at) },
    conversation: { messages: msgs.length, first_id: msgs[0]?.id || null, last_id: msgs.length ? msgs[msgs.length - 1].id : null, sha256: msgs.length ? h.digest('hex') : null },
    note: 'Frozen when the order was reported. Payment figures are what the parties stated; PairPlug has not verified any external payment.' }, null, 1);
  q.run('INSERT INTO case_records(case_id, kind, content, sha256, created_at) VALUES(?,?,?,?,?)', Number(caseId), 'order_snapshot', content, crypto.createHash('sha256').update(content).digest('hex'), now());
  return content;
}
const caseRecords = (caseId) => q.all('SELECT * FROM case_records WHERE case_id = ? ORDER BY id', Number(caseId));

module.exports = { preserveOrderRecord, caseRecords, CATEGORIES, category, sellerHeld, warnPendingBuyers, sellerRisk, repeatReported, providersFor, providerOf, PROVIDER_NAME, preparePacket, markSubmitted, packetsFor };
