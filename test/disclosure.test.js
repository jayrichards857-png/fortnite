'use strict';
// Buyer payment disclosure (one source of truth), dispute handling that never pretends to control external money, preserved case records, and the future-design document.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./helpers');
const { q } = require('../src/db');
const { esc } = require('../src/util');
const DISC = require('../src/disclosure');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_disc2';
const get = async (c, u) => (await c.get(u)).text;
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const mkAdmin = async () => { const a = await H.newUser('Op'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
async function scene(over = {}) {
  const seller = await H.newSeller('Disc'), buyer = await H.newUser('Disc'), id = await H.makeListing(seller, { payment_url: LINK, ...over });
  const o = oid(await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })); return { seller, buyer, id, o };
}
const OBSOLETE = [/I understand I'm paying the seller directly through their own checkout, and that PairPlug doesn't hold or refund my payment/i, /PairPlug doesn't process or hold your payment/i, /PairPlug does not hold or refund payments/i,
  /PairPlug does not hold your payment and cannot refund it/i, /PairPlug does not collect, hold or protect your payment/i, /not by PairPlug\. Message the seller first/i, /PairPlug does not hold or process the payment/i, /does not hold, move, refund or insure your money/i,
  /PairPlug support cannot move money\./i, /We do not hold, freeze or move money/i];

test('the checkout checkbox uses the new, accurate wording; nothing else on the page contradicts it', async () => {
  const seller = await H.newSeller('Chk'), buyer = await H.newUser('Chk'), id = await H.makeListing(seller, { payment_url: LINK });
  const page = await get(buyer, `/buy/${id}`), t = text(page);
  assert.ok(page.includes(esc(DISC.ACK)), 'checkbox label is exactly the shared disclosure'); assert.match(page, /<input type="checkbox" id="ack" name="acknowledged">/);
  assert.match(t, /payment is processed through the seller's external checkout/); assert.match(t, /PairPlug does not currently hold or directly control those funds/); assert.match(t, /contact PairPlug for assistance/);
  assert.match(t, /report the problem to the payment processor with the evidence it has/); assert.match(t, /cannot promise a refund or recovery/);
  assert.doesNotMatch(t, /paying the seller directly through their own checkout/);
  // the how-it-works box and the can / cannot list
  assert.match(t, /What PairPlug can and cannot do|If something goes wrong, PairPlug can/); assert.match(t, /cannot:.*freeze, hold, reverse or refund money in the seller's Stripe, PayPal or other payment account/); assert.match(t, /restricting a seller on PairPlug is not a financial hold/);
  // the server still insists on the acknowledgement
  assert.equal((await buyer.post('/api/purchases', { listingId: id, address: H.address })).status, 422); assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 200);
});

test('listing, order, help and policy pages carry the same disclosure and none still has the obsolete wording', async () => {
  const { seller, buyer, id, o } = await scene(); const anon = new H.Client(), adm = await mkAdmin();
  const listing = text(await get(buyer, `/listing/${id}`)); assert.ok(!listing.includes('undefined')); const fresh = await H.makeListing(seller, { payment_url: LINK, title: 'Fresh one' });
  const lp = text(await get(await H.newUser('Look'), `/listing/${fresh}`)); assert.ok(lp.includes(DISC.SHORT), 'listing page uses the short disclosure'); assert.match(lp, /may review the order, contact the seller and report the problem to the payment processor/);
  const order = text(await get(buyer, `/orders/${o}`)); assert.match(order, /Check before you pay/); assert.match(order, /report it to PairPlug below\. You pay the seller through their external checkout\. PairPlug does not currently hold or directly control those funds/); assert.match(order, /If something goes wrong, PairPlug can/);
  const pages = { support: '/support', payments: '/payments', terms: '/terms', privacy: '/privacy', rules: '/rules', contact: '/contact', listing: `/listing/${id}`, buy: `/buy/${fresh}`, order: `/orders/${o}` };
  const sc = await H.newUser('Sc'); const sellerOrderPage = `/dashboard/orders/${o}`;
  for (const [name, url] of Object.entries(pages)) { const html = await get(name === 'buy' || name === 'order' ? buyer : anon, url); const raw = html.replace(/&#39;/g, "'"); for (const re of OBSOLETE) assert.doesNotMatch(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), re, `${name}: obsolete wording ${re}`); }
  for (const re of OBSOLETE) assert.doesNotMatch(text(await get(seller, sellerOrderPage)), re); void adm; void sc;
  // policy pages: consistent, with the key distinctions
  const pay = text(await get(anon, '/payments')); assert.match(pay, /pay the seller through their external checkout, not PairPlug/); assert.match(pay, /does not currently hold or directly control those funds/); assert.match(pay, /we may review the order, contact the seller, and report the problem to the payment processor/);
  assert.match(pay, /keep the order record, tracking details entered by the seller, the messages between you and the seller/); assert.match(pay, /not a financial hold/); assert.match(pay, /seller's statement/); assert.doesNotMatch(pay, /guaranteed refund|we will refund|you will be refunded/i);
  assert.match(text(await get(anon, '/terms')), /does not currently hold or directly control the funds buyers pay through sellers' external checkouts, and cannot freeze, reverse or refund them/);
  assert.match(text(await get(anon, '/support')), /does not currently hold or directly control those funds/);
  // the old exact sentence is gone from the whole source tree
  const { spawnSync } = require('node:child_process'); const hit = spawnSync('grep', ['-rnE', "doesn't hold or refund my payment|PairPlug doesn't process or hold|does not hold or refund payments", path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'public')], { encoding: 'utf8' }).stdout.trim(); assert.equal(hit, '');
});

test('seller restrictions and bans never mark external money as frozen, refunded or reversed, and the pages say so', async () => {
  const adm = await mkAdmin(); const { seller, buyer, o } = await scene({ price: '50.00' }); await seller.post(`/api/seller/orders/${o}/confirm-payment`, {});
  const o2 = (await scene()).o; const before = q.all('SELECT id, status, total_cents, refunded_cents, payment_confirmed_at, payment_confirmed_by FROM orders ORDER BY id').map((r) => ({ ...r }));
  const cid = (await buyer.post('/api/cases/order', { orderId: o, reason: 'Seller went silent after confirming payment.', category: 'non_delivery' })).json.id;
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'Documented risk review: non-delivery complaint' })).status, 200);
  assert.equal((await adm.post(`/api/admin/cases/${cid}/action`, { action: 'suspend_seller', reason: 'No response to repeated contact' })).status, 200);
  const after = q.all('SELECT id, status, total_cents, refunded_cents, payment_confirmed_at, payment_confirmed_by FROM orders ORDER BY id').map((r) => ({ ...r }));
  const paid = after.find((r) => r.id === o), was = before.find((r) => r.id === o); assert.deepEqual(paid, was, 'the confirmed order is exactly as it was: not refunded, not reversed, not frozen'); assert.equal(paid.refunded_cents, 0);
  assert.equal(after.find((r) => r.id === o2).status, 'pending_payment');
  assert.equal(q.get('SELECT COUNT(*) n FROM refund_requests WHERE order_id = ?', o).n, 0); assert.equal(q.get("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND to_status IN ('refunded','cancelled')", o).n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM ledger').n, 0, 'no ledger entry: no money moved'); assert.equal(q.get('SELECT COUNT(*) n FROM refunds').n, 0);
  const staff = text(await get(adm, `/admin/cases/${cid}`)), mine = text(await get(buyer, `/orders/${o}`)), support = text(await get(buyer, `/cases/${cid}`));
  assert.match(staff, /does not freeze, hold or reverse anything in their Stripe\/PayPal account/); for (const t of [staff, mine, support]) assert.doesNotMatch(t, /funds (are|have been|were) (frozen|held|returned)|payment (was|has been|is) (frozen|refunded|reversed)|your money (was|has been) (returned|refunded)/i);
  assert.match(mine, /Payment confirmed/); assert.match(mine, /freeze, hold, reverse or refund money in the seller's Stripe, PayPal or other payment account/);
  // the buyer is told clearly, in the case view, what happens next
  assert.match(support, /cannot freeze, reverse or refund money in the seller's payment account/); assert.match(support, /report suspected fraud to the payment processor/);
});

test('a reported order is preserved as a frozen, staff-only record; messages stay intact; decisions are recorded', async () => {
  const adm = await mkAdmin(); const { seller, buyer, id, o } = await scene();
  await seller.post(`/api/seller/orders/${o}/confirm-payment`, {}); await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '9400111899225566' });
  const conv = (await buyer.post('/api/chat/conversations', { listingId: id })).json.id; assert.ok(conv);
  const cid = (await buyer.post('/api/cases/order', { orderId: o, reason: 'Tracking never moved and the seller stopped replying.', category: 'non_delivery' })).json.id;
  const rec = q.get('SELECT * FROM case_records WHERE case_id = ?', cid); assert.ok(rec); assert.equal(rec.sha256, crypto.createHash('sha256').update(rec.content).digest('hex'));
  const c = JSON.parse(rec.content); assert.equal(c.order.tracking_entered_by_seller, '9400111899225566'); assert.equal(c.order.payment_independently_verified, false); assert.ok(c.order.seller_said_payment_received_at); assert.equal(c.order.status, 'shipped'); assert.match(c.note, /not verified any external payment/);
  assert.throws(() => q.run("UPDATE case_records SET content = 'x' WHERE id = ?", rec.id), /append-only/); assert.throws(() => q.run('DELETE FROM case_records WHERE id = ?', rec.id), /append-only/);
  assert.match(await get(adm, `/admin/cases/${cid}`), /Preserved record/); for (const who of [buyer, seller]) assert.doesNotMatch(await get(who, `/cases/${cid}`), /Preserved record|sha256/);
  // contacting both sides and recording the decision
  assert.equal((await adm.post(`/api/admin/cases/${cid}/reply`, { body: 'We have asked the seller for proof of shipment.' })).status, 200); assert.ok(q.get("SELECT 1 x FROM notifications WHERE title LIKE 'PairPlug replied%' AND user_id = (SELECT id FROM users WHERE email = ?)", buyer.email)); assert.ok(q.get("SELECT 1 x FROM notifications WHERE title LIKE 'PairPlug replied%' AND user_id = (SELECT id FROM users WHERE email = ?)", seller.email));
  assert.equal((await adm.post(`/api/admin/cases/${cid}/decide`, { outcome: 'resolved', resolution: 'Seller restricted; buyer told to contact the payment provider for the refund.' })).status, 200);
  for (const a of ['case_opened', 'case_replied', 'case_decided']) assert.ok(q.get('SELECT 1 x FROM audit_log WHERE action = ?', a), a);
  // a ban does not delete the conversation, order or evidence
  const msgsBefore = q.get('SELECT COUNT(*) n FROM messages').n; await adm.post(`/api/admin/cases/${cid}/action`, { action: 'suspend_seller', reason: 'Confirmed non-delivery' }); assert.equal(q.get('SELECT COUNT(*) n FROM messages').n, msgsBefore); assert.equal(q.get('SELECT COUNT(*) n FROM case_records WHERE case_id = ?', cid).n, 1);
});

test('the future payment-protection design is documented as design-only, makes no unsupported claims, and migration 15 is additive', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PAYMENT_PROTECTION_DESIGN.md'), 'utf8');
  for (const h of ['DESIGN ONLY', 'Stripe Connect', 'merchant of record', 'delayed payouts', 'Reserves', 'onboarding', 'Fees', 'already been paid out', 'verify']) assert.ok(doc.toLowerCase().includes(h.toLowerCase()), h);
  assert.match(doc, /Do not say PairPlug can freeze funds/); assert.match(doc, /No code in this repository calls any provider's Connect, transfer, payout or refund API/);
  const pay = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments.js'), 'utf8'); assert.ok(!/accounts\.create|transfers\.create|payouts\.create|\/v1\/transfers|\/v1\/accounts/.test(pay), 'no Connect/transfer/payout calls exist in the payment code');
  const { DatabaseSync } = require('node:sqlite'), { MIGRATIONS } = require('../src/db'); assert.ok(MIGRATIONS.length >= 15);
  const d = new DatabaseSync(':memory:'); for (let i = 0; i < 14; i++) d.exec(MIGRATIONS[i]);
  d.prepare('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)').run('a@x.test', 'x', 'A', 1); d.exec(MIGRATIONS[14]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n, 1); assert.equal(d.prepare('SELECT COUNT(*) n FROM case_records').get().n, 0); d.close();
});
