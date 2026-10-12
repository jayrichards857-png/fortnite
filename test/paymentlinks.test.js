'use strict';
// Stripe-only payment-link policy: exact host checks, seller confirmation that resets on change, buyer warnings, mismatch reports, timed suspensions, appeals, audit.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q, now } = require('../src/db');
const config = require('../src/config');
const PP = require('../src/paymentPolicy');
const M = require('../src/moderation');
const { validatePaymentUrl, APPROVED_HOSTS, resolveLink } = require('../src/paymentLinks');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_policy1', LINK2 = 'https://buy.stripe.com/test_policy2';
const get = async (c, u) => (await c.get(u)).text;
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const uid = async (email) => (await q.get('SELECT id FROM users WHERE email = ?', email)).id;
const mkAdmin = async () => { const a = await H.newUser('Boss'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
async function newMod(adm) {
  const email = `pm${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`, inv = await adm.post('/api/admin/moderators/invite', { email });
  const c = new H.Client(); c.email = email; assert.equal((await c.post('/api/moderator/setup', { token: inv.json.link.split('/').pop(), display_name: 'Policy Mod', password: 'a-very-long-passphrase', terms: true })).status, 200); return c;
}
const body = async (seller, over = {}) => ({ title: 'Policy hoodie', description: 'x', category: 'clothing', size: 'M', condition: 'good', price: '40.00', shipping: '8.00', weight_oz: '20', images: [await H.upload(seller)], status: 'active', payment_url: LINK, payment_amount_ack: true, quantity: 3, ...over });
const row = async (id) => await q.get('SELECT * FROM listings WHERE id = ?', id);
const audits = async (action, like) => await q.all('SELECT * FROM audit_log WHERE action = ?' + (like ? ' AND detail LIKE ?' : ''), ...(like ? [action, like] : [action]));

test('only exact Stripe checkout hosts are accepted; lookalikes, other providers and unsafe forms are rejected', async () => {
  assert.deepEqual(APPROVED_HOSTS, ['buy.stripe.com']);
  for (const ok of ['https://buy.stripe.com/test_abc123', 'HTTPS://BUY.STRIPE.COM/aBcDeFgHiJkL', 'https://buy.stripe.com:443/abcdef1']) assert.ok(validatePaymentUrl(ok), ok);
  assert.equal(validatePaymentUrl('https://buy.stripe.com/aBcDeFgHiJkL?x=1#f'), 'https://buy.stripe.com/aBcDeFgHiJkL', 'query and fragment are dropped');
  const bad = ['http://buy.stripe.com/abcdef', 'https://buy.stripe.com.evil.com/abcdef', 'https://evil.com/buy.stripe.com/abcdef', 'https://buy.stripe.com@evil.com/abcdef', 'https://evil.com#@buy.stripe.com/abcdef', 'https://buy-stripe.com/abcdef', 'https://xbuy.stripe.com/abcdef', 'https://stripe.com/abcdef',
    'https://www.stripe.com/abcdef', 'https://checkout.stripe.com/c/pay/cs_test_a1', 'https://buy.stripe.com./abcdef', 'https://buy.stripe.com\\@evil.com/abcdef', 'https://buy.stripe.com:8443/abcdef', 'https://buy.stripe.com/', 'https://buy.stripe.com/a/b/c123456', 'https://buy.stripe.com/abc',
    'https://paypal.me/someone123', 'https://cash.app/$someone', 'https://bսy.stripe.com/abcdef', 'https://buy.stripe.com/abc def1', 'javascript:alert(1)', 'https:buy.stripe.com/abcdef', 'https:///buy.stripe.com/abcdef', 'https://user:pw@buy.stripe.com/abcdef', 'ftp://buy.stripe.com/abcdef', '//buy.stripe.com/abcdef', '', '   '];
  for (const b of bad) assert.throws(() => validatePaymentUrl(b), (e) => e.status === 422 && Boolean(e.fields.payment_url), b);
  // the configuration can only narrow the list, never add a host or provider
  assert.deepEqual(config.paymentLinkHosts.filter((h) => !APPROVED_HOSTS.includes(h)), [], 'default config has no extra hosts'); assert.throws(() => validatePaymentUrl('https://paypal.me/someone123', ['paypal.me']));
  // the same rules apply at the API
  const seller = await H.newSeller('Hosts');
  for (const b of ['https://buy.stripe.com.evil.com/abcdef', 'https://paypal.me/someone123', 'http://buy.stripe.com/abcdef']) { const r = await seller.post('/api/seller/listings', await body(seller, { payment_url: b })); assert.equal(r.status, 422, b); assert.ok(r.json.fields.payment_url); }
  const ok = await seller.post('/api/seller/listings', await body(seller, { payment_url: 'https://buy.stripe.com/test_policy1?utm=x#y' })); assert.equal(ok.status, 200); assert.equal((await row(ok.json.id)).payment_url, 'https://buy.stripe.com/test_policy1');
  // and again right before a buyer would be sent there
  const { buyerUrl } = require('../src/paymentLinks'); assert.throws(() => buyerUrl('https://paypal.me/someone123', 1));
});

test('Stripe test-mode links are rejected in production (and never followed)', () => {
  const keep = config.isProd;
  try {
    config.isProd = true; for (const t of ['https://buy.stripe.com/test_abc123', 'https://buy.stripe.com/TEST_abc123']) assert.throws(() => validatePaymentUrl(t), (e) => /TEST-mode link/.test(e.fields.payment_url), t);
    assert.ok(validatePaymentUrl('https://buy.stripe.com/aBcLIVE12345')); config.isProd = false; assert.ok(validatePaymentUrl('https://buy.stripe.com/test_abc123'), 'allowed outside production');
  } finally { config.isProd = keep; }
});

test('the seller form shows the Stripe-only policy, the exact notice, and says the confirmation is not verification', async () => {
  const seller = await H.newSeller('Form'), page = await get(seller, '/dashboard/listings/new'), t = text(page);
  assert.match(t, /Stripe checkout links only/); assert.ok(t.includes(PP.SELLER_NOTICE), 'exact notice text'); assert.ok(t.includes(PP.SELLER_ACK)); assert.ok(t.includes(PP.SELLER_ACK_FOOT));
  assert.match(page, /role="note"/); assert.match(page, /aria-describedby="purl-notice purl-hint"/); assert.match(page, /name="payment_ack_total_cents"/); assert.match(page, /name="payment_ack_url"/); assert.match(t, /buy\.stripe\.com/);
  assert.match(t, /does not verify the amount charged at Stripe/); assert.match(t, /not automatically correct or safe/); assert.doesNotMatch(t, /verified by PairPlug|PairPlug verifies/i);
  const js = await get(seller, '/editor.js'); assert.match(js, /pack\.checked = false/, 'the editor un-ticks the box when price, shipping or link change');
});

test('the seller\'s confirmation is cleared by any price, shipping, payer or link change; re-confirming needs proof of the new total; everything is audited', async () => {
  const seller = await H.newSeller('Ack'), s = await seller.post('/api/seller/listings', await body(seller)), id = s.json.id;
  assert.equal((await row(id)).payment_total_ack_cents, 4800); assert.ok((await row(id)).payment_ack_at); assert.equal((await row(id)).payment_ack_policy, PP.VERSION);
  assert.equal((await audits('listing_payment_total_acknowledged', `%"listing":%`)).length >= 0, true); assert.ok((await audits('listing_payment_link_changed')).some((a) => a.target_id === String(id)), 'creating a link is audited'); assert.ok((await audits('listing_payment_total_acknowledged')).some((a) => a.target_id === String(id) && /seller statement; not verified by PairPlug/.test(a.detail) && a.detail.includes(PP.VERSION)));
  const edit = async (over, extra = {}) => seller.put(`/api/seller/listings/${id}`, { ...(await body(seller, over)), ...extra });
  const proof = (total, url = LINK) => ({ payment_ack_total_cents: total, payment_ack_url: url });
  // silence about the box keeps an unchanged confirmation; other fields do not matter
  let r = await edit({ title: 'Renamed', payment_amount_ack: undefined }); assert.equal(r.status, 200); assert.equal((await row(id)).payment_total_ack_cents, 4800);
  // price changed with the old tick still sent -> refused without fresh proof; accepted with it
  r = await edit({ price: '45.00' }); assert.equal(r.status, 422); assert.match(r.json.fields.payment_amount_ack, /changed\. Tick the box again to confirm the new total of \$53\.00/); assert.equal((await row(id)).price_cents, 4000, 'nothing was saved');
  r = await edit({ price: '45.00', payment_amount_ack: undefined }); assert.equal(r.status, 200); assert.equal((await row(id)).payment_total_ack_cents, null, 'changing the price un-confirms it'); assert.ok((await audits('listing_payment_ack_cleared')).some((a) => a.target_id === String(id) && /price or shipping changed/.test(a.detail)));
  assert.equal((await edit({ price: '45.00' }, proof(1, LINK))).status, 422, 'stale proof (wrong total) is refused');
  assert.equal((await edit({ price: '45.00' }, proof(5300, LINK2))).status, 422, 'proof for another link is refused');
  assert.equal((await edit({ price: '45.00' }, proof(5300))).status, 200); assert.equal((await row(id)).payment_total_ack_cents, 5300);
  // shipping change, payer change, link change each clear it
  r = await edit({ price: '45.00', shipping: '9.00', payment_amount_ack: undefined }); assert.equal((await row(id)).payment_total_ack_cents, null); await edit({ price: '45.00', shipping: '9.00' }, proof(5400));
  assert.equal((await row(id)).payment_total_ack_cents, 5400); await edit({ price: '45.00', shipping: '9.00', shipping_payer: 'seller', payment_amount_ack: undefined }); assert.equal((await row(id)).payment_total_ack_cents, null, 'free shipping changes the total too');
  await edit({ price: '45.00', shipping: '0', shipping_payer: 'seller' }, proof(4500)); assert.equal((await row(id)).payment_total_ack_cents, 4500);
  await edit({ price: '45.00', shipping: '0', shipping_payer: 'seller', payment_url: LINK2, payment_amount_ack: undefined }); assert.equal((await row(id)).payment_total_ack_cents, null, 'changing the link clears it'); assert.ok((await audits('listing_payment_link_changed')).some((a) => a.target_id === String(id) && a.detail.includes(LINK2)));
  assert.equal((await edit({ price: '45.00', shipping: '0', shipping_payer: 'seller', payment_url: LINK2 }, proof(4500, LINK))).status, 422, 'a tick made for the old link does not carry over');
  assert.equal((await edit({ price: '45.00', shipping: '0', shipping_payer: 'seller', payment_url: LINK2 }, proof(4500, LINK2))).status, 200); assert.equal((await row(id)).payment_total_ack_cents, 4500);
  // an explicit false clears it
  await edit({ price: '45.00', shipping: '0', shipping_payer: 'seller', payment_url: LINK2, payment_amount_ack: false }); assert.equal((await row(id)).payment_total_ack_cents, null); assert.ok((await audits('listing_payment_ack_cleared')).some((a) => /box unticked/.test(a.detail)));
  // the database itself clears a stale confirmation for any other code path (bulk price tools, CSV, manual SQL)
  await edit({ price: '45.00', shipping: '0', shipping_payer: 'seller', payment_url: LINK2 }, proof(4500, LINK2)); assert.equal((await row(id)).payment_total_ack_cents, 4500);
  await q.run('UPDATE listings SET price_cents = 5000 WHERE id = ?', id); assert.equal((await row(id)).payment_total_ack_cents, null); assert.equal((await row(id)).payment_ack_at, null);
  // CSV import that changes the link also clears it
  await edit({ price: '50.00', shipping: '0', shipping_payer: 'seller', payment_url: LINK2, sku: 'CSV1' }, proof(5000, LINK2)); assert.equal((await row(id)).payment_total_ack_cents, 5000);
  const csv = 'sku,title,category,price,shipping,payment_url\nCSV1,Policy hoodie,clothing,50.00,0,https://buy.stripe.com/test_policy3\n'; const imp = await seller.post('/api/seller/import', { csv });
  assert.equal(imp.status, 200, imp.text); assert.equal(imp.json.updated, 1, JSON.stringify(imp.json)); assert.equal((await row(id)).payment_total_ack_cents, null, 'a CSV link/price change clears the confirmation'); assert.equal((await row(id)).payment_url, 'https://buy.stripe.com/test_policy3'); assert.ok((await audits('listing_payment_link_changed')).some((a) => /"via":"csv"/.test(a.detail)));
  const bad = await seller.post('/api/seller/import', { csv: 'sku,title,category,price,shipping,payment_url\nCSV1,Policy hoodie,clothing,50.00,0,https://buy.stripe.com.evil.com/abcdef\n' }); assert.equal(bad.json.updated || 0, 0, 'a lookalike link in a CSV is rejected too');
  // a confirmation never exists without a link
  const none = await seller.post('/api/seller/listings', await body(seller, { payment_url: '', payment_amount_ack: true })); assert.equal(none.status, 200); assert.equal((await row(none.json.id)).payment_total_ack_cents, null);
});

test('checkout cannot start without a current seller confirmation (enforced by the API, not just the page)', async () => {
  const seller = await H.newSeller('Gate'), buyer = await H.newUser('Gate'), id = (await seller.post('/api/seller/listings', await body(seller))).json.id;
  const buy = (uid2) => (uid2 || buyer).post('/api/purchases', { listingId: id, acknowledged: true, address: H.address });
  await q.run('UPDATE listings SET payment_total_ack_cents = NULL WHERE id = ?', id); let r = await buy(); assert.equal(r.status, 409); assert.match(r.text, /still needs to confirm that their Stripe link charges the current total/); assert.doesNotMatch(await get(buyer, `/listing/${id}`), />Buy now</);
  await q.run('UPDATE listings SET payment_total_ack_cents = 1 WHERE id = ?', id); assert.equal((await buy()).status, 409, 'a confirmation for another total does not count');
  await q.run('UPDATE listings SET payment_total_ack_cents = 4800, payment_url = NULL WHERE id = ?', id); assert.equal((await buy()).status, 409, 'no link, no checkout');
  await q.run("UPDATE listings SET payment_url = 'https://evil.example/abcdef' WHERE id = ?", id); r = await buy(); assert.equal(r.status, 409); assert.match(r.text, /no longer accepted/);
  await q.run("UPDATE listings SET payment_url = ? WHERE id = ?", LINK, id); assert.equal((await buy()).status, 200);
  // the seller-wide default link can no longer start a checkout
  const def = await H.newSeller('Def'); await q.run("UPDATE users SET checkout_url = ?, checkout_url_any_amount = 1 WHERE handle = ?", LINK, def.handle);
  const d = await def.post('/api/seller/listings', await body(def, { payment_url: '', payment_amount_ack: false })); assert.equal((await buy2(d.json.id)).status, 409);
  async function buy2(listingId) { return buyer.post('/api/purchases', { listingId, acknowledged: true, address: H.address }); }
});

test('the "Before you pay" warning, expected total and mismatch link appear beside Buy now, on the buy page and before leaving for Stripe', async () => {
  const seller = await H.newSeller('Warn'), buyer = await H.newUser('Warn'), id = (await seller.post('/api/seller/listings', await body(seller, { price: '100.00', shipping: '7.85', quantity: 2 }))).json.id;
  const listing = await get(buyer, `/listing/${id}`), lt = text(listing);
  assert.match(listing, /<section class="byp" role="note" aria-labelledby="byp-listing-h">/); assert.match(listing, /<h3 id="byp-listing-h">Before you pay<\/h3>/); assert.ok(lt.includes(PP.BUYER_TEXT), 'exact warning text');
  assert.match(lt, /Item price \$100\.00/); assert.match(lt, /Shipping \$7\.85/); assert.match(lt, /Expected total \$107\.85/); assert.ok(lt.includes(PP.BUYER_FOOT)); assert.match(listing, /<dl class="byp-total" aria-label="Expected total">/);
  assert.match(listing, /href="\/support#payment-mismatch">Report a payment mismatch<\/a>/);
  assert.ok(listing.indexOf('Before you pay') < listing.indexOf('>Buy now<'), 'the warning sits above the Buy now button');
  assert.doesNotMatch(lt, /PairPlug (has )?verified (the|that) (price|amount)|verified by PairPlug|guarantees? (the|that) (amount|price)/i);
  const buyPage = await get(buyer, `/buy/${id}`); assert.ok(text(buyPage).includes(PP.BUYER_TEXT)); assert.match(text(buyPage), /Expected total \$107\.85/);
  const o = oid(await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })), order = await get(buyer, `/orders/${o}`);
  assert.ok(text(order).includes(PP.BUYER_TEXT)); assert.match(text(order), /Expected total \$107\.85/); assert.match(order, new RegExp(`href="/support\\?order=${o}#payment-mismatch"`)); assert.ok(order.indexOf('Before you pay') < order.indexOf('Go to seller checkout'), 'repeated right before leaving PairPlug');
  const css = await get(buyer, '/app.css'); assert.match(css, /\.byp\{/); assert.match(css, /@media \(max-width:480px\)\{\.byp\{/);
  assert.equal((await buyer.get(`/orders/${o}/pay`)).status, 302);
  // an unbuyable listing shows the plain totals, not a warning that implies checkout
  const sold = (await seller.post('/api/seller/listings', await body(seller, { quantity: 1 }))).json.id; await q.run("UPDATE listings SET payment_total_ack_cents = NULL WHERE id = ?", sold); assert.doesNotMatch(await get(buyer, `/listing/${sold}`), /byp-listing-h/);
});

test('reporting a payment mismatch opens a flagged case for staff and never changes payment state', async () => {
  const adm = await mkAdmin(), mod = await newMod(adm), seller = await H.newSeller('Mis'), buyer = await H.newUser('Mis'), other = await H.newUser('Other');
  const id = (await seller.post('/api/seller/listings', await body(seller, { price: '100.00', shipping: '7.85' }))).json.id, o = oid(await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }));
  const sup = await get(buyer, `/support?order=${o}`); assert.match(sup, /id="payment-mismatch"/); assert.match(sup, new RegExp(`<option value="${o}" selected>`)); assert.match(text(sup), /Do not complete that payment/); assert.match(text(sup), /PairPlug has not verified the amount at Stripe and cannot see it/);
  assert.equal((await new H.Client().post('/api/cases/payment-mismatch', { orderId: o })).status, 401); assert.equal((await other.post('/api/cases/payment-mismatch', { orderId: o, reason: 'not mine' })).status, 404);
  assert.equal((await buyer.post('/api/cases/payment-mismatch', { orderId: o, seenAmount: 'abc' })).status, 422);
  const before = { ...await q.get('SELECT status, payment_confirmed_at, payment_confirmed_by, buyer_claimed_paid_at, total_cents FROM orders WHERE id = ?', o) };
  const r = await buyer.post('/api/cases/payment-mismatch', { orderId: o, seenAmount: '21.00', reason: 'Stripe showed a different product and amount.', evidence_json: JSON.stringify([await H.upload(buyer)]) }); assert.equal(r.status, 200, r.text);
  const c = await q.get('SELECT * FROM cases WHERE id = ?', r.json.id); assert.equal(c.payment_mismatch, 1); assert.equal(c.order_id, o); assert.equal(c.subject_user_id, await uid(seller.email)); assert.match(c.reason, /PairPlug expected \$107\.85; the buyer says the checkout page showed \$21\.00/);
  assert.deepEqual({ ...await q.get('SELECT status, payment_confirmed_at, payment_confirmed_by, buyer_claimed_paid_at, total_cents FROM orders WHERE id = ?', o) }, before, 'payment state untouched: not paid, not confirmed, not refunded');
  assert.equal((await q.get('SELECT COUNT(*) n FROM refund_requests WHERE order_id = ?', o)).n, 0); assert.ok(await q.get("SELECT 1 x FROM notifications WHERE title = 'A buyer says your checkout amount did not match' AND user_id = ?", await uid(seller.email)));
  assert.equal((await buyer.post('/api/cases/payment-mismatch', { orderId: o, reason: 'again' })).status, 409, 'one open report per order');
  assert.match(await get(mod, `/admin/cases/${c.id}`), /PAYMENT MISMATCH report/); assert.match(await get(mod, '/moderation/payment-links'), new RegExp(`/admin/cases/${c.id}`));
  assert.equal((await q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', await uid(seller.email))).r, null, 'a report alone never restricts a seller');
  // a buyer saying they paid (or reporting) never makes the order paid; only the seller can
  await buyer.post(`/api/orders/${o}/claim-paid`, {}); assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', o)).status, 'pending_payment'); assert.equal((await buyer.post(`/api/seller/orders/${o}/confirm-payment`, {})).status >= 400, true); assert.equal((await mod.post(`/api/seller/orders/${o}/confirm-payment`, {})).status >= 400, true);
});

test('timed suspensions: staff only, a documented case and reason, limited days, explicit confirmation, audited, never automatic, self-ending', async () => {
  const adm = await mkAdmin(), mod = await newMod(adm), seller = await H.newSeller('Susp'), buyer = await H.newUser('Susp'), bystander = await H.newUser('By'), sid = await uid(seller.email);
  const id = (await seller.post('/api/seller/listings', await body(seller))).json.id, o = oid(await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }));
  const stock = (await row(id)).quantity, orders0 = (await q.get('SELECT COUNT(*) n FROM orders')).n;
  // nothing happens automatically: failed validations and a complaint do not restrict anyone
  for (let i = 0; i < 4; i++) await seller.post('/api/seller/listings', await body(seller, { payment_url: 'https://evil.example/abcdef' }));
  const cid = (await buyer.post('/api/cases/payment-mismatch', { orderId: o, reason: 'Amount differed at checkout.' })).json.id; const lone = await get(mod, `/moderation/users/${sid}`);
  assert.equal((await q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', sid)).r, null); assert.match(lone, /Only one reporter so far/); assert.match(lone, /Temporary selling suspension \(up to 5 days\)/);
  const go = (c, o2) => c.post(`/api/moderation/users/${sid}/suspend`, { days: 3, reason: 'Two checks of the listing show the Stripe link charges a different amount.', caseId: cid, confirm: true, ...o2 });
  for (const who of [new H.Client(), bystander, seller, buyer]) assert.ok([401, 403].includes((await go(who)).status), 'only staff'); assert.equal((await q.get('SELECT selling_restricted_at r FROM users WHERE id = ?', sid)).r, null);
  for (const [over, field] of [[{ days: 6 }, 'days'], [{ days: 0 }, 'days'], [{ days: 'x' }, 'days'], [{ days: 2.5 }, 'days'], [{ reason: 'too short' }, 'reason'], [{ confirm: false }, 'confirm'], [{ caseId: undefined }, 'caseId'], [{ caseId: 999999 }, 'caseId']]) { const r = await go(mod, over); assert.equal(r.status, 422, JSON.stringify(over)); assert.ok(r.json.fields && r.json.fields[field], field); }
  const wrongCase = (await seller.post('/api/seller/listings', await body(seller))).json && (await buyer.post('/api/cases/seller', { handle: (await H.newSeller('Else')).handle, reason: 'Some other seller entirely.' })).json.id; assert.equal((await go(mod, { caseId: wrongCase })).status, 422, 'the case must be about this seller');
  assert.equal((await mod.post(`/api/moderation/users/${await uid(adm.email)}/suspend`, { days: 1, reason: 'a'.repeat(25), caseId: cid, confirm: true })).status, 403, 'staff cannot be suspended by moderators');
  const t0 = now(), ok = await go(mod); assert.equal(ok.status, 200, ok.text); assert.ok(ok.json.until >= t0 + 3 * 86400 - 5 && ok.json.until <= t0 + 3 * 86400 + 5);
  const u = await q.get('SELECT * FROM users WHERE id = ?', sid); assert.ok(u.selling_restricted_at); assert.equal(u.selling_restricted_until, ok.json.until); assert.equal(u.banned, 0); assert.equal(u.selling_restricted_case, cid);
  assert.equal((await q.get("SELECT COUNT(*) n FROM listings WHERE seller_id = ? AND status = 'active'", sid)).n, 0); assert.equal((await seller.post('/api/seller/listings', await body(seller))).status, 403); assert.doesNotMatch(await get(new H.Client(), '/sellers'), new RegExp('@' + seller.handle + '\\b'));
  const fresh = await H.newUser('Fresh'); assert.equal((await fresh.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 409);
  assert.match(text(await get(seller, '/dashboard')), /Selling is paused on your account until /); assert.match(await get(seller, '/dashboard'), /Appeal this decision/); assert.ok(await q.get("SELECT 1 x FROM notifications WHERE title = 'Selling is suspended for 3 days' AND user_id = ?", sid));
  assert.equal((await go(mod)).status, 409, 'no duplicate action');
  // recorded, with who, why, which case
  const act = await q.get('SELECT * FROM moderation_actions WHERE target_id = ? ORDER BY id DESC LIMIT 1', sid); assert.equal(act.actor_id, await uid(mod.email)); assert.equal(act.actor_role, 'moderator'); assert.equal(act.case_id, cid); assert.match(act.reason, /^Temporary suspension \(3 days, until \d{4}-\d\d-\d\d\): Two checks/);
  const modId = await uid(mod.email);
  assert.ok((await audits('seller_suspended_temporarily')).some((a) => a.target_id === String(sid) && /"days":3/.test(a.detail) && a.actor_id === modId));
  // nothing about money, orders or stock changed
  assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', o)).status, 'pending_payment'); assert.equal((await q.get('SELECT COUNT(*) n FROM orders')).n, orders0); assert.equal((await q.get('SELECT COUNT(*) n FROM refund_requests')).n, 0); assert.equal((await q.get('SELECT COUNT(*) n FROM ledger')).n, 0);
  assert.equal((await row(id)).quantity, stock, 'inventory counts are untouched'); assert.match(text(await get(adm, `/admin/cases/${cid}`)), /does not freeze, hold or reverse anything in their Stripe\/PayPal account/);
  // it ends on its own, restoring selling (listings stay paused until the seller republishes)
  await q.run('UPDATE users SET selling_restricted_until = ? WHERE id = ?', now() - 1, sid); assert.equal(await M.liftExpired(), 1); const after = await q.get('SELECT * FROM users WHERE id = ?', sid); assert.equal(after.selling_restricted_at, null); assert.equal(after.selling_restricted_until, null); assert.equal(await M.liftExpired(), 0);
  assert.ok((await audits('seller_suspension_expired')).some((a) => a.target_id === String(sid) && a.actor_label === 'system')); assert.ok(await q.get("SELECT 1 x FROM notifications WHERE title = 'Your selling suspension has ended' AND user_id = ?", sid));
  assert.equal((await q.get("SELECT COUNT(*) n FROM listings WHERE seller_id = ? AND status = 'active'", sid)).n, 0); assert.equal((await seller.post('/api/seller/listings', await body(seller))).status, 200);
  // lifting early works, and the configured ceiling is honoured
  assert.equal((await go(mod, { days: 1 })).status, 200); assert.equal((await mod.post(`/api/moderation/users/${sid}/lift`, { reason: 'Seller fixed the link; lifting early' })).status, 200); assert.equal((await q.get('SELECT selling_restricted_until u FROM users WHERE id = ?', sid)).u, null);
  const keep = config.enforcement.maxSuspensionDays; try { config.enforcement.maxSuspensionDays = 2; assert.equal((await go(mod, { days: 3 })).status, 422); assert.equal((await go(mod, { days: 2 })).status, 200); assert.match(PP.sellerNotice(), /up to 2 days/); } finally { config.enforcement.maxSuspensionDays = keep; }
  assert.match(PP.sellerNotice(), /up to 5 days/);
});

test('sellers can appeal; staff see appeals, repeat violations and unconfirmed links, and appeals do not count as reports against the seller', async () => {
  const adm = await mkAdmin(), mod = await newMod(adm), seller = await H.newSeller('App'), buyer = await H.newUser('App'), sid = await uid(seller.email);
  assert.equal((await buyer.post('/api/seller/appeal', { reason: 'I am not a seller at all.' })).status, 403); assert.equal((await new H.Client().post('/api/seller/appeal', { reason: 'anonymous appeal' })).status, 401);
  const page = await get(seller, '/dashboard/appeal'); assert.match(page, /Appeal a decision/); assert.match(page, /data-uploader="evidence"/);
  assert.equal((await seller.post('/api/seller/appeal', { reason: 'short' })).status, 422);
  const r = await seller.post('/api/seller/appeal', { reason: 'The link does charge item plus shipping; screenshots attached.', evidence_json: JSON.stringify([await H.upload(seller)]) }); assert.equal(r.status, 200, r.text); const cid = r.json.id;
  const c = await q.get('SELECT * FROM cases WHERE id = ?', cid); assert.equal(c.reporter_id, sid); assert.equal(c.subject_user_id, sid); assert.match(c.reason, /^Appeal:/); assert.equal((await q.get("SELECT COUNT(*) n FROM case_events WHERE case_id = ? AND kind = 'evidence'", cid)).n, 1);
  assert.equal((await seller.post('/api/seller/appeal', { reason: 'a second appeal while one is open' })).status, 409); assert.equal((await seller.get(`/cases/${cid}`)).status, 200); assert.equal((await buyer.get(`/cases/${cid}`)).status, 404);
  assert.ok((await audits('appeal_opened')).some((a) => a.target_id === String(cid)));
  const F = require('../src/fraud'); assert.equal((await F.sellerRisk(sid)).reporters, 0, 'an appeal is not a report against the seller'); assert.ok(!(await F.repeatReported()).some((s) => s.id === sid));
  const staff = await get(mod, '/moderation/payment-links'); assert.match(staff, new RegExp(`/admin/cases/${cid}`)); assert.match(staff, /Appeals \(1 open\)/);
  assert.equal((await mod.post(`/api/admin/cases/${cid}/decide`, { outcome: 'resolved', resolution: 'Link checked with the seller; no violation found.' })).status, 200);
  // staff screens: restricted-by-mistake review works through the normal lift action, and the page is staff-only
  for (const who of [new H.Client(), buyer, seller]) assert.ok([401, 302, 403].includes((await who.get('/moderation/payment-links')).status));
  const id = (await seller.post('/api/seller/listings', await body(seller))).json.id; await q.run('UPDATE listings SET payment_total_ack_cents = NULL WHERE id = ?', id); assert.match(await get(mod, '/moderation/payment-links'), new RegExp(`#${id} Policy hoodie`));
  assert.match(await get(mod, '/moderation/payment-links'), /cannot see the amount Stripe charges/);
});

test('existing data stays intact: migration 16 is additive, old listings simply start unconfirmed, and seller-written text is untouched', () => {
  const { DatabaseSync } = require('node:sqlite'), { MIGRATIONS } = require('../src/db'); assert.ok(MIGRATIONS.length >= 16);
  const d = new DatabaseSync(':memory:'); for (let i = 0; i < 15; i++) d.exec(MIGRATIONS[i]);
  d.prepare('INSERT INTO users(email, password_hash, display_name, created_at, bio) VALUES(?,?,?,?,?)').run('s@x.test', 'x', 'S', 1, 'My bio');
  d.prepare("INSERT INTO listings(seller_id, title, category, price_cents, shipping_cents, shipping_payer, status, payment_url, payment_total_ack_cents, quantity, created_at, updated_at) VALUES(1,'Old','clothing',5000,500,'buyer','active','https://buy.stripe.com/old_link1',5500,2,1,1)").run();
  d.prepare("INSERT INTO cases(kind, reporter_id, subject_user_id, reason, status, created_at, updated_at) VALUES('seller_issue',1,1,'old','open',1,1)").run();
  d.exec(MIGRATIONS[15]);
  const l = d.prepare('SELECT title, price_cents, payment_url, payment_total_ack_cents a, payment_ack_at, payment_ack_policy, quantity FROM listings').get(); assert.deepEqual({ ...l }, { title: 'Old', price_cents: 5000, payment_url: 'https://buy.stripe.com/old_link1', a: 5500, payment_ack_at: null, payment_ack_policy: null, quantity: 2 });
  assert.equal(d.prepare('SELECT payment_mismatch m FROM cases').get().m, 0); assert.equal(d.prepare('SELECT bio FROM users').get().bio, 'My bio'); assert.equal(d.prepare('SELECT selling_restricted_until u FROM users').get().u, null);
  d.exec('UPDATE listings SET price_cents = 6000'); assert.equal(d.prepare('SELECT payment_total_ack_cents a FROM listings').get().a, null, 'the DB trigger clears a confirmation that no longer matches'); d.close();
  assert.equal(resolveLink({ payment_url: 'https://buy.stripe.com/old_link1' }).source, 'listing');
});
