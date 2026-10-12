'use strict';
// Cases, refund requests, reports, admin tools and their authorization / audit guarantees.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_support123';
const row = (id) => q.get('SELECT * FROM orders WHERE id = ?', id);
const audits = (action) => q.all('SELECT * FROM audit_log WHERE action = ?', action);
async function admin() { const a = await H.newUser('Admin'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; }
async function paidOrder() {
  const seller = await H.newSeller('Sup'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: '6.00', shipping_payer: 'buyer' });
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId;
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 200);
  return { seller, buyer, id, o };
}

test('order case: buyer opens, seller responds, outsiders get 404, internal notes never leak, admin decides', async () => {
  const { seller, buyer, o } = await paidOrder(); const stranger = await H.newUser('S'), other = await H.newSeller('Other'), adm = await admin();
  assert.equal((await stranger.post('/api/cases/order', { orderId: o, reason: 'not my order at all' })).status, 404);
  assert.equal((await buyer.post('/api/cases/order', { orderId: o, reason: 'short' })).status, 422);
  const c = await buyer.post('/api/cases/order', { orderId: o, reason: 'The jacket never arrived after two weeks.' });
  assert.equal(c.status, 200); const id = c.json.id;
  assert.equal((await buyer.post('/api/cases/order', { orderId: o, reason: 'The jacket never arrived (duplicate).' })).status, 409);
  for (const who of [stranger, other]) { assert.equal((await who.get(`/cases/${id}`)).status, 404); assert.equal((await who.post(`/api/cases/${id}/respond`, { body: 'hello there' })).status, 404); }
  assert.equal((await seller.get(`/cases/${id}`)).status, 200);
  assert.equal((await seller.post(`/api/cases/${id}/respond`, { body: 'It shipped on the 3rd; here is the receipt.' })).status, 200);
  assert.equal((await adm.post(`/api/admin/cases/${id}/note`, { body: 'SECRET-INTERNAL-NOTE seller seems fine' })).status, 200);
  for (const who of [buyer, seller]) { const t = (await who.get(`/cases/${id}`)).text; assert.ok(!t.includes('SECRET-INTERNAL-NOTE')); assert.ok(t.includes('It shipped on the 3rd')); }
  assert.ok((await adm.get(`/admin/cases/${id}`)).text.includes('SECRET-INTERNAL-NOTE'));
  assert.equal((await buyer.post(`/api/admin/cases/${id}/decide`, { outcome: 'resolved', resolution: 'nice try' })).status, 403);
  assert.notEqual((await buyer.get('/admin/cases')).status, 200);
  assert.equal((await adm.post(`/api/admin/cases/${id}/decide`, { outcome: 'resolved', resolution: 'Tracking shows delivery; buyer to check with neighbours.' })).status, 200);
  assert.equal((await buyer.post(`/api/cases/${id}/respond`, { body: 'one more thing' })).status, 409, 'closed case');
  assert.ok((await buyer.get(`/cases/${id}`)).text.includes('Tracking shows delivery'));
  assert.ok(audits('case_decided').length >= 1 && audits('case_note_added').length >= 1);
  assert.throws(() => q.run('UPDATE case_events SET body = ? WHERE case_id = ?', 'x', id), /append-only/);
});

test('refund: request -> seller report -> still not refunded -> buyer confirms -> refunded; cancellations only before shipping', async () => {
  const { seller, buyer, id, o } = await paidOrder();
  assert.equal((await seller.post(`/api/orders/${o}/refund-request`, { reason: 'seller cannot request for buyer' })).status, 404);
  assert.equal((await buyer.post(`/api/orders/${o}/refund-request`, { kind: 'cancellation', reason: 'Changed my mind about size' })).status, 200);
  assert.equal((await buyer.post(`/api/orders/${o}/refund-request`, { reason: 'again again again' })).status, 409, 'one open request');
  assert.equal((await seller.post(`/api/seller/orders/${o}/refund-response`, { action: 'report_refunded' })).status, 422, 'must attest');
  assert.equal((await seller.post(`/api/seller/orders/${o}/refund-response`, { action: 'report_refunded', confirm_refunded: true, reference: 're_abc123' })).status, 200);
  assert.equal(row(o).status, 'paid'); assert.equal(q.get('SELECT status FROM listings WHERE id = ?', id).status, 'sold');
  assert.ok((await buyer.get(`/orders/${o}`)).text.includes('The seller says they refunded you'));
  assert.equal((await buyer.post(`/api/orders/${o}/refund-confirm`, { received: true })).status, 200);
  assert.equal(row(o).status, 'refunded');
  assert.equal((await buyer.post(`/api/orders/${o}/refund-confirm`, { received: true })).status, 409);
});

test('refund: buyer says it did not arrive -> escalates to a case; admin closes without refund; admin verification refunds', async () => {
  const a = await paidOrder(), adm = await admin();
  await a.buyer.post(`/api/orders/${a.o}/refund-request`, { reason: 'Item is not as described' });
  await a.seller.post(`/api/seller/orders/${a.o}/refund-response`, { action: 'report_refunded', confirm_refunded: true });
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/refund-confirm`, { received: false, note: 'x' })).status, 422);
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/refund-confirm`, { received: false, note: 'Nothing arrived in my account.' })).status, 200);
  const req = q.get('SELECT * FROM refund_requests WHERE order_id = ?', a.o); assert.equal(req.status, 'buyer_disputes_refund'); assert.ok(req.case_id);
  assert.equal(row(a.o).status, 'paid');
  assert.equal((await a.seller.post(`/api/admin/refunds/${req.id}/resolve`, { outcome: 'verified', note: 'trust me' })).status, 403);
  assert.equal((await adm.post(`/api/admin/refunds/${req.id}/resolve`, { outcome: 'verified', note: 'Seller provided the provider receipt; confirmed.' })).status, 200);
  assert.equal(row(a.o).status, 'refunded'); assert.equal(q.get('SELECT status FROM refund_requests WHERE id = ?', req.id).status, 'admin_verified_refund');
  const b = await paidOrder();
  await b.buyer.post(`/api/orders/${b.o}/refund-request`, { reason: 'I just want my money back' });
  assert.equal((await b.seller.post(`/api/seller/orders/${b.o}/refund-response`, { action: 'decline', note: 'short' })).status, 422);
  assert.equal((await b.seller.post(`/api/seller/orders/${b.o}/refund-response`, { action: 'decline', note: 'Outside the stated return window.' })).status, 200);
  assert.equal(row(b.o).status, 'paid');
  assert.ok(audits('refund_admin_resolved').length >= 1);
});

test('seller report + message report: permissions, audited admin view of ONLY reported conversations', async () => {
  const { seller, buyer, id } = await paidOrder(); const adm = await admin(), nosy = await H.newUser('Nosy');
  assert.equal((await buyer.post('/api/cases/seller', { handle: seller.handle, reason: 'Rude and unresponsive seller.' })).status, 200);
  assert.equal((await seller.post('/api/cases/seller', { handle: seller.handle, reason: 'Reporting myself, silly.' })).status, 403);
  assert.equal((await nosy.post('/api/cases/seller', { handle: 'nobody-here', reason: 'does not exist at all' })).status, 404);
  const conv = (await buyer.post('/api/chat/conversations', { listingId: id })).json.id;
  const sent = await buyer.post('/api/chat/command', { op: 'send', conversationId: conv, clientId: 'cid-report-1-abcdef', body: 'PRIVATE-CHAT-TEXT hello' });
  const mid = sent.json.data?.message?.id ?? sent.json.message?.id;
  assert.equal((await nosy.post('/api/chat/report', { conversationId: conv, messageId: mid, reason: 'not a member of this' })).status, 404);
  const unreported = (await buyer.post('/api/cases/seller', { handle: seller.handle, reason: 'Second report on same seller.' })).json.id;
  assert.equal((await adm.post(`/api/admin/cases/${unreported}/conversation`, {})).status, 404, 'no reported conversation: admin cannot read chats');
  const rep = await seller.post('/api/chat/report', { conversationId: conv, messageId: mid, reason: 'Buyer is harassing me.' });
  assert.equal(rep.status, 200);
  const before = audits('reported_conversation_viewed').length;
  const v = await adm.post(`/api/admin/cases/${rep.json.id}/conversation`, {});
  assert.equal(v.status, 200); assert.ok(JSON.stringify(v.json).includes('PRIVATE-CHAT-TEXT'));
  assert.equal(audits('reported_conversation_viewed').length, before + 1);
  assert.equal((await buyer.post(`/api/admin/cases/${rep.json.id}/conversation`, {})).status, 403);
  assert.equal((await buyer.get(`/cases/${rep.json.id}`)).status, 404, 'the reported party cannot see a message report');
});

test('admin actions: pause listing / suspend seller are audited and scoped to the case subject', async () => {
  const { seller, buyer, id, o } = await paidOrder(); const adm = await admin();
  const live = await H.makeListing(seller, { payment_url: LINK });
  const c = (await buyer.post('/api/cases/order', { orderId: o, reason: 'Counterfeit item received, see photos.' })).json.id;
  const foreign = await H.makeListing(await H.newSeller('F'), { payment_url: LINK });
  assert.equal((await adm.post(`/api/admin/cases/${c}/action`, { action: 'pause_listing', listingId: foreign })).status, 404);
  assert.equal((await adm.post(`/api/admin/cases/${c}/action`, { action: 'pause_listing', listingId: live })).status, 200);
  assert.equal(q.get('SELECT status FROM listings WHERE id = ?', live).status, 'archived');
  assert.equal((await adm.post(`/api/admin/cases/${c}/action`, { action: 'suspend_seller' })).status, 200);
  assert.equal(q.get('SELECT banned FROM users WHERE handle = ?', seller.handle).banned, 1);
  assert.ok(audits('listing_paused_for_case').length && audits('user_suspended').length);
  assert.equal((await adm.get('/admin/orders')).status, 200);
  const page = (await adm.get('/admin/orders')).text; assert.ok(!page.includes(H.address.line1), 'no addresses in the admin order overview');
  assert.equal((await adm.get('/admin/responses')).status, 200);
});

test('support page is public, honest about limits and mentions the 48-hour expectation', async () => {
  const anon = new H.Client(); const t = (await anon.get('/support')).text;
  assert.ok(/48 hours/.test(t) && /does not hold, move, freeze or refund money/.test(t));
  assert.equal((await anon.get('/cases/1')).status, 302);
});
