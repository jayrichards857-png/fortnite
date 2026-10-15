'use strict';
// Scam reporting: evidence, duplicate prevention, operator tools, restriction (a Grailedside-side measure only), provider packets, and honest payment states.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const { q } = require('../src/db');
const F = require('../src/fraud');
const config = require('../src/config');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_fraud1';
const get = async (c, u) => (await c.get(u)).text;
const admin = async () => { const a = await H.newUser('Op'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
const notifs = async (email, like) => await q.all('SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? AND n.title LIKE ?', email, like);
async function scene(name = 'Scam') {
  const seller = await H.newSeller(name), buyer = await H.newUser('Buyer'), id = await H.makeListing(seller, { payment_url: LINK, price: '40.00' });
  const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text);
  const orderId = Number(String(r.json.redirect).match(/(\d+)/)[1]);
  return { seller, buyer, id, orderId };
}
const order = async (id) => await q.get('SELECT * FROM orders WHERE id = ?', id);

test('order reports: only for orders the buyer engaged with; evidence persists; duplicates refused; payment state is never changed by a report', async () => {
  const { seller, buyer, orderId } = await scene('Rep'), adm = await admin();
  const reason = 'I paid through the link but the seller will not answer.';
  let r = await buyer.post('/api/cases/order', { orderId, reason }); assert.equal(r.status, 409, 'nothing to report before the buyer has opened the payment link or said they paid');
  assert.equal((await buyer.get(`/orders/${orderId}/pay`)).status, 302, 'buyer opens the seller\'s external link');
  assert.match(await get(buyer, `/orders/${orderId}`), /Report a problem to Grailedside support/, 'the report form is offered on an unconfirmed order');
  const shot = await H.upload(buyer);
  assert.equal((await buyer.post('/api/cases/order', { orderId, reason, category: 'bogus' })).status, 422);
  r = await buyer.post('/api/cases/order', { orderId, reason, category: 'payment_not_confirmed', evidence_json: JSON.stringify([shot]) }); assert.equal(r.status, 200, r.text);
  const cid = r.json.id, c = await q.get('SELECT * FROM cases WHERE id = ?', cid);
  assert.equal(c.category, 'payment_not_confirmed'); assert.equal(c.order_id, orderId); assert.equal(c.reporter_id, (await q.get('SELECT id FROM users WHERE email = ?', buyer.email)).id); assert.equal(c.subject_user_id, (await q.get('SELECT id FROM users WHERE handle = ?', seller.handle)).id);
  assert.equal((await q.get("SELECT COUNT(*) n FROM case_events WHERE case_id = ? AND kind = 'evidence' AND image = ?", cid, shot)).n, 1, 'evidence reference persisted');
  assert.ok(fs.existsSync(path.join(config.uploadDir, shot)));
  assert.equal((await buyer.post('/api/cases/order', { orderId, reason })).status, 409, 'a second open report for the same order is refused');
  assert.equal((await notifs(seller.email, 'A buyer reported%')).length, 1, 'the seller is told about an order case exactly once');
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'case_opened' AND target_id = ?", String(cid)));
  // nothing about the money changed: still unconfirmed, nobody marked it verified
  const o = await order(orderId); assert.equal(o.status, 'pending_payment'); assert.equal(o.payment_confirmed_at, null); assert.equal(o.payment_confirmed_by, null);
  // the operator cannot "verify" an external payment: no such route, and an admin cannot confirm for the seller
  assert.equal((await adm.post(`/api/seller/orders/${orderId}/confirm-payment`, {})).status >= 400, true); assert.equal((await order(orderId)).status, 'pending_payment');
  // other people cannot see or write to the case
  const stranger = await H.newUser('Nosy'); assert.equal((await stranger.get(`/cases/${cid}`)).status, 404); assert.equal((await stranger.post(`/api/cases/${cid}/respond`, { body: 'hi there' })).status, 404);
  // an order the buyer never touched, belonging to someone else, is not reportable
  assert.equal((await stranger.post('/api/cases/order', { orderId, reason })).status, 404);
});

test('seller reports: evidence, category, optional own order, duplicate prevention, reported seller not notified, multi-reporter visibility for the operator', async () => {
  const { seller, buyer, orderId } = await scene('Multi'), buyer2 = await H.newUser('Second'), adm = await admin();
  const handle = seller.handle, shot = await H.upload(buyer);
  assert.match(await get(buyer, '/support'), /name="category"/); assert.match(await get(buyer, '/support'), /data-uploader="evidence"/);
  const other = await scene('Other'); assert.equal((await buyer.post('/api/cases/seller', { handle, reason: 'Looks like a scam seller.', orderId: other.orderId })).status, 404, 'cannot attach someone else\'s order');
  let r = await buyer.post('/api/cases/seller', { handle, reason: 'Took payment for several items and vanished.', category: 'non_delivery', orderId, evidence_json: JSON.stringify([shot]) }); assert.equal(r.status, 200, r.text);
  const c1 = await q.get('SELECT * FROM cases WHERE id = ?', r.json.id); assert.equal(c1.kind, 'seller_issue'); assert.equal(c1.order_id, orderId); assert.equal(c1.status, 'open'); assert.equal(c1.category, 'non_delivery');
  assert.equal((await q.get("SELECT COUNT(*) n FROM case_events WHERE case_id = ? AND image = ?", c1.id, shot)).n, 1);
  assert.equal((await buyer.post('/api/cases/seller', { handle, reason: 'Reporting the same seller again.' })).status, 409, 'one open report per reporter and seller');
  assert.equal((await notifs(seller.email, '%')).filter((n) => /report/i.test(n.title)).length, 0, 'the reported seller is not tipped off');
  assert.equal((await seller.get(`/cases/${c1.id}`)).status, 404, 'and cannot open a seller report');
  assert.equal((await new H.Client().post('/api/cases/seller', { handle, reason: 'anonymous report attempt' })).status, 401);
  assert.equal((await seller.post('/api/cases/seller', { handle, reason: 'reporting myself here' })).status, 403);
  // one reporter is not "repeat"; a second different reporter makes the seller show up in the operator's queue
  assert.ok(!(await F.repeatReported()).some((s) => s.handle === handle));
  r = await buyer2.post('/api/cases/seller', { handle, reason: 'Same thing happened to me, never shipped.', category: 'suspected_scam' }); assert.equal(r.status, 200);
  const rep = (await F.repeatReported()).find((s) => s.handle === handle); assert.equal(rep.reporters, 2); assert.equal(rep.open, 2);
  assert.match(await get(adm, '/admin/risk'), new RegExp('@' + handle)); assert.equal((await buyer.get('/admin/risk')).status === 200, false, 'operator-only');
  const page = await get(adm, `/admin/cases/${c1.id}`); assert.match(page, /<strong>2<\/strong> different buyer\(s\) have reported/); assert.match(page, /Grailedside has not verified any of these payments/); assert.match(page, /Counts of reports, not findings/);
  assert.match(page, /reporter says: I paid and never received/);
});

test('restricting selling is a Grailedside-side measure: blocks publishing, new orders and the payment redirect, hides the store, warns buyers, is reversible and audited', async () => {
  const { seller, buyer, id, orderId } = await scene('Restrict'), adm = await admin(), cust = await H.newUser('Cust');
  const spare = await H.makeListing(seller, { payment_url: LINK, title: 'Second item' });
  await cust.post('/api/sellers/' + seller.handle + '/follow');
  const rep = await buyer.post('/api/cases/seller', { handle: seller.handle, reason: 'Suspected scam, please look.', category: 'suspected_scam' }); const cid = rep.json.id;
  assert.equal((await buyer.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'trying' })).status >= 400, true, 'non-admins cannot restrict');
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'x' })).status, 422, 'a reason is required');
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'Multiple unconfirmed payments, investigating' })).status, 200);
  const u = await q.get('SELECT * FROM users WHERE handle = ?', seller.handle); assert.ok(u.selling_restricted_at); assert.equal(u.selling_restricted_case, cid); assert.equal(u.banned, 0, 'a restriction is not a ban');
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'again please' })).status, 409, 'no duplicate action');
  // listings paused, nothing publishable, store and discovery hidden
  assert.equal((await q.get("SELECT COUNT(*) n FROM listings WHERE seller_id = ? AND status = 'active'", u.id)).n, 0);
  const body = async (over = {}) => ({ title: 'New drop', description: 'Worn twice', category: 'outerwear', size: 'M', condition: 'good', price: '40.00', shipping: '5.00', weight_oz: '20', images: [await H.upload(seller)], status: 'active', ...over });
  const pub = await seller.post('/api/seller/listings', await body()); assert.equal(pub.status, 403, pub.text); assert.match(pub.text, /paused/i);
  assert.equal((await seller.post('/api/seller/listings', await body({ status: 'draft' }))).status, 200, 'drafts can still be saved');
  const anon = new H.Client(); assert.match(await get(anon, `/s/${seller.handle}`), /temporarily unavailable/); assert.doesNotMatch(await get(anon, '/sellers'), new RegExp('@' + seller.handle + '\\b'));
  assert.equal((await cust.post('/api/sellers/' + seller.handle + '/follow')).status, 404, 'a restricted store can\'t gain followers');
  // payment redirect refused, new purchase refused, buyer and seller are told
  const pay = await buyer.get(`/orders/${orderId}/pay`); assert.notEqual(pay.status, 302, 'buyers are not sent to the seller\'s payment link while held'); assert.match(pay.text, /do not pay yet|not sending buyers/i);
  assert.equal((await cust.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status >= 400, true);
  assert.equal((await notifs(buyer.email, 'Please do not pay%')).length, 1, 'buyer with an unpaid order is warned'); assert.equal((await notifs(seller.email, 'Selling is paused%')).length, 1);
  assert.match(await get(seller, '/dashboard'), /Selling is paused on your account/);
  // seller can still log in, reply and handle the existing order (fairness)
  assert.equal((await seller.get('/dashboard/orders')).status, 200); assert.equal((await seller.get(`/dashboard/orders/${orderId}`)).status, 200);
  // the money state is untouched by any of this
  const o = await order(orderId); assert.equal(o.status, 'pending_payment'); assert.equal(o.payment_confirmed_by, null);
  // internal record + audit
  assert.ok(await q.get("SELECT 1 x FROM case_events WHERE case_id = ? AND internal = 1 AND body LIKE 'restrict selling%'", cid)); assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'moderation_restrict_selling'"));
  const view = await get(adm, `/admin/cases/${cid}`); assert.match(view, /does not freeze, hold or reverse anything in their Stripe\/PayPal account/); assert.match(view, /selling restricted since/);
  // lift: allowed again, listings stay paused until the seller republishes
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'lift_restriction', reason: 'cleared' })).status, 200);
  assert.equal((await q.get('SELECT selling_restricted_at r FROM users WHERE handle = ?', seller.handle)).r, null); assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'moderation_lift_restriction'"));
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', spare)).status, 'archived');
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'lift_restriction', reason: 'not restricted anyway' })).status, 409);
  assert.equal((await seller.post('/api/seller/listings', await body())).status, 200, 'after the restriction is lifted the seller can publish again');
});

test('suspension also warns buyers with unpaid orders and keeps the payment state honest', async () => {
  const { seller, buyer, orderId } = await scene('Susp'), adm = await admin();
  const cid = (await buyer.post('/api/cases/seller', { handle: seller.handle, reason: 'This seller is running a scam.' })).json.id;
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'suspend_seller', reason: 'Running a scam, banned pending review' })).status, 200);
  assert.equal((await q.get('SELECT banned FROM users WHERE handle = ?', seller.handle)).banned, 1); assert.equal((await notifs(buyer.email, 'Please do not pay%')).length, 1);
  assert.equal((await order(orderId)).status, 'pending_payment'); assert.equal((await buyer.get(`/orders/${orderId}/pay`)).status === 302, false);
});

test('payment-provider packet: factual, labelled by who said what, no internal notes or private data, not duplicated, immutable once submitted, nothing sent automatically', async () => {
  const { seller, buyer, orderId } = await scene('Packet'), adm = await admin();
  await buyer.get(`/orders/${orderId}/pay`); await buyer.post(`/api/orders/${orderId}/claim-paid`, {});
  const cid = (await buyer.post('/api/cases/order', { orderId, reason: 'Paid by card, seller silent for a week.', category: 'payment_not_confirmed' })).json.id;
  await adm.post(`/api/admin/cases/${cid}/note`, { body: 'INTERNAL-SECRET-NOTE suspect pattern' });
  assert.equal((await buyer.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'stripe' })).status >= 400, true, 'operator only');
  assert.deepEqual((await F.providersFor(await q.get('SELECT * FROM cases WHERE id = ?', cid))).map((p) => p.provider), ['stripe'], 'provider comes from the payment link actually used');
  assert.equal(F.providerOf('www.paypal.com'), 'paypal'); assert.equal(F.providerOf('paypal.me'), 'paypal'); assert.equal(F.providerOf('buy.stripe.com'), 'stripe'); assert.equal(F.providerOf('pay.example.com'), 'other');
  assert.equal((await adm.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'nonsense' })).status, 422);
  const mk = await adm.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'stripe', host: 'buy.stripe.com' }); assert.equal(mk.status, 200, mk.text); const pid = mk.json.id;
  assert.equal((await adm.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'stripe' })).status, 409, 'no duplicate packet while one is waiting');
  const dl = await adm.get(`/admin/processor-packets/${pid}`); assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /attachment/); assert.match(dl.headers.get('content-type'), /text\/plain/);
  const t = dl.text; assert.match(t, new RegExp(`PP-${orderId}`)); assert.match(t, /has NOT independently verified/); assert.match(t, /buyer said they paid/); assert.match(t, /seller has not confirmed payment/); assert.match(t, /Paid by card, seller silent/);
  assert.doesNotMatch(t, /INTERNAL-SECRET-NOTE/); assert.doesNotMatch(t, new RegExp(H.address.line1)); assert.doesNotMatch(t, new RegExp(buyer.email.replace(/[.+]/g, '\\$&'))); assert.doesNotMatch(t, new RegExp(seller.email.replace(/[.+]/g, '\\$&')));
  assert.doesNotMatch(t, /verified payment|payment verified/i);
  assert.equal((await buyer.get(`/admin/processor-packets/${pid}`)).status >= 400, true);
  // recording submission needs a channel; Grailedside sends nothing itself
  assert.equal((await adm.post(`/api/admin/processor-packets/${pid}/submitted`, { channel: '' })).status, 422);
  assert.equal((await adm.post(`/api/admin/processor-packets/${pid}/submitted`, { channel: 'Stripe fraud report form', reference: 'ST-123' })).status, 200);
  const row = await q.get('SELECT * FROM processor_reports WHERE id = ?', pid); assert.equal(row.status, 'submitted'); assert.equal(row.reference, 'ST-123'); assert.ok(row.submitted_at);
  assert.equal((await adm.post(`/api/admin/processor-packets/${pid}/submitted`, { channel: 'again' })).status, 409);
  await assert.rejects(async () => await q.run("UPDATE processor_reports SET packet = 'edited' WHERE id = ?", pid), /cannot be changed/); await assert.rejects(async () => await q.run("UPDATE processor_reports SET reference = 'x' WHERE id = ?", pid), /cannot be changed/); await assert.rejects(async () => await q.run('DELETE FROM processor_reports WHERE id = ?', pid), /append-only/);
  assert.equal((await adm.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'stripe' })).status, 409, 'already reported; no new evidence');
  await buyer.post(`/api/cases/${cid}/respond`, { body: 'Seller still has not answered after two more days.' });
  assert.equal((await adm.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'stripe' })).status, 200, 'new evidence allows a follow-up packet');
  assert.ok(await q.get("SELECT 1 x FROM case_events WHERE case_id = ? AND internal = 1 AND body LIKE '%did not send it automatically%'", cid));
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'processor_packet_submitted'")); assert.match(await get(adm, `/admin/cases/${cid}`), /Grailedside has no integration with Stripe or PayPal/);
  // still nothing about the payment changed
  const o = await order(orderId); assert.equal(o.status, 'pending_payment'); assert.equal(o.payment_confirmed_at, null);
  assert.ok(o.buyer_claimed_paid_at, 'the buyer\'s claim is recorded as a claim');
});

test('only the seller can confirm payment; their confirmation stays labelled as theirs even after a report', async () => {
  const { seller, buyer, orderId } = await scene('Confirm'), adm = await admin();
  await buyer.post(`/api/orders/${orderId}/claim-paid`, {});
  assert.equal((await buyer.post(`/api/seller/orders/${orderId}/confirm-payment`, {})).status >= 400, true);
  assert.equal((await seller.post(`/api/seller/orders/${orderId}/confirm-payment`, { reference: 'abc123' })).status, 200);
  const o = await order(orderId); assert.equal(o.status, 'paid'); assert.equal(o.payment_confirmed_by, (await q.get('SELECT id FROM users WHERE handle = ?', seller.handle)).id);
  const cid = (await buyer.post('/api/cases/order', { orderId, reason: 'Item never arrived after weeks.', category: 'non_delivery' })).json.id;
  const view = await get(adm, `/admin/cases/${cid}`); assert.match(view, /the seller says were paid/); assert.match(view, /Grailedside has not verified/);
  assert.match(await get(buyer, `/orders/${orderId}`), /Payment confirmed/i);
});

test('legal and help pages describe the real scam-reporting role and its limits, without overpromising', async () => {
  const anon = new H.Client(), pages = {}; for (const p of ['/terms', '/privacy', '/payments', '/rules', '/support']) pages[p] = (await get(anon, p)).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const all = Object.values(pages).join(' ');
  assert.match(pages['/payments'], /Grailedside accepts and investigates reports/); assert.match(pages['/payments'], /restrict a seller's ability to sell/); assert.match(pages['/payments'], /report to payment providers|send the relevant payment provider a factual report/i);
  assert.match(pages['/payments'], /cannot freeze, hold, reverse or refund money/); assert.match(pages['/payments'], /not a financial hold/); assert.match(pages['/payments'], /contact your payment provider or card issuer/i);
  assert.match(pages['/payments'], /no guaranteed response time/i); assert.match(pages['/payments'], /no buyer-protection programme or insurance/i); assert.match(pages['/payments'], /not automatic/i);
  assert.match(pages['/terms'], /report it/i); assert.match(pages['/rules'], /restrict selling while we investigate/); assert.match(pages['/privacy'], /Payment providers \(fraud reports\)/); assert.match(pages['/privacy'], /not told who reported them|not told who reported/i);
  assert.match(pages['/support'], /Suspect a scam\? Report it/); assert.match(pages['/support'], /does not currently hold or directly control those funds/);
  assert.doesNotMatch(all, /we (will )?(freeze|recover|reverse) (your|the) (money|funds|payment)/i); assert.doesNotMatch(all, /guarantee[sd]? (a )?refund|you will be refunded|within \d+ (hours|days) we will|insured|covered by Grailedside/i);
  assert.doesNotMatch(all, /Grailedside (does not|doesn't) (investigate|review) (reports|scams)|no role in (resolving )?(disputes|scams)/i);
});

test('migration 12 is additive: older cases and users survive with NULL restriction/category', async () => {
  const { dbAt } = require('./pgmig'); const d = await dbAt(11);
  try {
    await d.run('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', 'a@x.test', 'x', 'A', 1); await d.run('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', 'b@x.test', 'x', 'B', 1);
    await d.run("INSERT INTO cases(kind, reporter_id, subject_user_id, reason, status, created_at, updated_at) VALUES('seller_issue',1,2,'old report text','open',1,1)");
    await d.applyNext();
    const c = await d.one('SELECT * FROM cases'); assert.equal(c.category, null); assert.equal(c.reason, 'old report text'); assert.equal((await d.one('SELECT selling_restricted_at r FROM users WHERE id = 2')).r, null);
    assert.equal(Number((await d.one('SELECT COUNT(*) n FROM processor_reports')).n), 0);
  } finally { await d.close(); }
});
