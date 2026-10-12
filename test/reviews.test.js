'use strict';
// Seller thumbs-up reviews: eligibility, anti-abuse, safe rendering, accurate counts, reports, moderation with an audit trail.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_rev1';
const get = async (c, u) => (await c.get(u)).text;
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const uid = async (email) => (await q.get('SELECT id FROM users WHERE email = ?', email)).id;
const mkAdmin = async () => { const a = await H.newUser('Boss'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
async function newMod(adm) {
  const email = `rm${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`, inv = await adm.post('/api/admin/moderators/invite', { email });
  const c = new H.Client(); c.email = email; await c.post('/api/moderator/setup', { token: inv.json.link.split('/').pop(), display_name: 'Rev Mod', password: 'a-very-long-passphrase', terms: true }); return c;
}
/** A real order driven through the real endpoints up to the requested stage. */
async function order(stage, seller) {
  seller = seller || await H.newSeller('Rev'); const buyer = await H.newUser('Reviewer'), id = await H.makeListing(seller, { payment_url: LINK });
  const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text); const o = oid(r);
  if (stage === 'pending') return { seller, buyer, o };
  await seller.post(`/api/seller/orders/${o}/confirm-payment`, {}); if (stage === 'paid') return { seller, buyer, o };
  await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '94001' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0') }); if (stage === 'shipped') return { seller, buyer, o };
  const rcv = await buyer.post(`/api/orders/${o}/received`, {}); assert.equal(rcv.status, 200, rcv.text); return { seller, buyer, o };
}
const rev = async (o) => await q.get('SELECT * FROM seller_reviews WHERE order_id = ?', o);

test('an eligible buyer can review a delivered order; the order page shows the form, then their review', async () => {
  const { seller, buyer, o } = await order('delivered');
  const page = await get(buyer, `/orders/${o}`); assert.match(page, /Leave a review/); assert.match(page, /name="thumbsUp"/); assert.match(page, /does not verify external payments/);
  const r = await buyer.post(`/api/orders/${o}/review`, { thumbsUp: true, body: 'Fast shipping, item as described.' }); assert.equal(r.status, 200, r.text);
  const row = await rev(o); assert.equal(row.thumbs_up, 1); assert.equal(row.status, 'published'); assert.equal(row.buyer_id, await uid(buyer.email)); assert.equal(row.seller_id, await uid(seller.email));
  const after = await get(buyer, `/orders/${o}`); assert.match(after, /Posted/); assert.match(after, /Fast shipping/); assert.match(after, /Remove my review/);
  assert.equal((await buyer.post(`/api/orders/${o}/review`, { thumbsUp: true })).status, 409, 'one review per order');
  assert.deepEqual((await q.all('SELECT kind FROM review_events WHERE review_id = ?', row.id)).map((e) => e.kind), ['created']);
  // text only (no thumbs-up) is allowed; empty is not
  const t2 = await order('delivered'); assert.equal((await t2.buyer.post(`/api/orders/${t2.o}/review`, { thumbsUp: false, body: '' })).status, 422); assert.equal((await t2.buyer.post(`/api/orders/${t2.o}/review`, { thumbsUp: false, body: 'Took a while but arrived.' })).status, 200); assert.equal((await rev(t2.o)).thumbs_up, 0);
});

test('only the buyer of a completed order can review: strangers, sellers, other buyers, missing orders, wrong states', async () => {
  const { seller, buyer, o } = await order('delivered'), stranger = await H.newUser('Stranger'), other = await order('delivered');
  for (const who of [stranger, other.buyer]) assert.equal((await who.post(`/api/orders/${o}/review`, { thumbsUp: true })).status, 404, 'cannot review someone else\'s order');
  assert.equal((await seller.post(`/api/orders/${o}/review`, { thumbsUp: true, body: 'I am great' })).status, 404, 'the seller is not the buyer of the order');
  assert.equal((await new H.Client().post(`/api/orders/${o}/review`, { thumbsUp: true })).status, 401);
  assert.equal((await buyer.post('/api/orders/999999/review', { thumbsUp: true })).status, 404);
  // arbitrary seller/order ids in the body are ignored: only the URL order, owned by the caller, counts
  assert.equal((await buyer.post(`/api/orders/${o}/review`, { thumbsUp: true, seller_id: await uid(other.seller.email), order_id: other.o, buyer_id: 1 })).status, 200);
  const row = await rev(o); assert.equal(row.seller_id, await uid(seller.email)); assert.equal(row.order_id, o); assert.equal(row.buyer_id, await uid(buyer.email));
  // a seller who also bought from themselves is impossible; a seller reviewing another store via their own purchase works only as a buyer of that order
  for (const stage of ['pending', 'paid', 'shipped']) { const x = await order(stage); const r = await x.buyer.post(`/api/orders/${x.o}/review`, { thumbsUp: true }); assert.equal(r.status, 409, stage); assert.equal(await rev(x.o), undefined); assert.doesNotMatch(await get(x.buyer, `/orders/${x.o}`), /Leave a review/); }
  // the database enforces it too, whatever the application does
  const pend = await order('pending'); await assert.rejects(async () => await q.run('INSERT INTO seller_reviews(order_id, buyer_id, seller_id, thumbs_up, created_at) VALUES(?,?,?,1,1)', pend.o, await uid(pend.buyer.email), await uid(pend.seller.email)), /completed order/);
  const done = await order('delivered'); await assert.rejects(async () => await q.run('INSERT INTO seller_reviews(order_id, buyer_id, seller_id, thumbs_up, created_at) VALUES(?,?,?,1,1)', done.o, await uid(stranger.email), await uid(done.seller.email)), /completed order/, 'wrong buyer');
  await assert.rejects(async () => await q.run('INSERT INTO seller_reviews(order_id, buyer_id, seller_id, thumbs_up, created_at) VALUES(?,?,?,1,1)', done.o, await uid(done.buyer.email), await uid(stranger.email)), /completed order/, 'wrong seller');
  await assert.rejects(async () => await q.run('UPDATE seller_reviews SET seller_id = ? WHERE order_id = ?', await uid(stranger.email), o), /immutable/); await assert.rejects(async () => await q.run('DELETE FROM seller_reviews WHERE order_id = ?', o), /never deleted/);
});

test('concurrent submissions create exactly one review', async () => {
  const { buyer, o } = await order('delivered');
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => buyer.post(`/api/orders/${o}/review`, { thumbsUp: true, body: `try ${i}` })));
  assert.equal(res.filter((r) => r.status === 200).length, 1); assert.equal(res.filter((r) => r.status === 409).length, 7); assert.equal((await q.get('SELECT COUNT(*) n FROM seller_reviews WHERE order_id = ?', o)).n, 1);
});

test('input is validated and rendered safely; edit and remove work and are recorded; counts stay accurate', async () => {
  const seller = await H.newSeller('Counts'); const a = await order('delivered', seller), b = await order('delivered', seller), c = await order('delivered', seller), d = await order('delivered', seller);
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> & "quotes"';
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/review`, { thumbsUp: true, body: 'x'.repeat(1001) })).status, 422);
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/review`, { thumbsUp: true, body: evil })).status, 200);
  assert.equal((await b.buyer.post(`/api/orders/${b.o}/review`, { thumbsUp: true })).status, 200);                       // thumbs-up, no text
  assert.equal((await c.buyer.post(`/api/orders/${c.o}/review`, { thumbsUp: false, body: 'Slow to reply.' })).status, 200);   // text, no thumbs-up
  const anon = new H.Client(), store = await get(anon, `/s/${seller.handle}`);
  assert.ok(!store.includes('<script>alert(1)'), 'script tag is escaped'); assert.ok(!store.includes('<img src=x'), 'markup is escaped'); assert.match(store, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const nums = (html) => ({ thumbs: Number(html.match(/<strong>(\d+)<\/strong><span>thumbs-up/)[1]), written: Number(html.match(/<strong>(\d+)<\/strong><span>written review/)[1]), reviews: Number(html.match(/<strong>(\d+)<\/strong><span>order-linked review/)[1]) });
  assert.deepEqual(nums(store), { thumbs: 2, written: 2, reviews: 3 }, 'thumbs-up, written reviews and reviews are counted separately');
  assert.match(store, /not a rating or a guarantee|not independently verified/); assert.doesNotMatch(store, /verified purchase/i); assert.match(store, /order-linked/); assert.doesNotMatch(store, /★|out of 5|average/i);
  assert.match(store, /Slow to reply/); assert.match(store, /\bReviewer\b/, 'first name only'); assert.doesNotMatch(store, new RegExp(a.buyer.email.replace(/[.+]/g, '\\$&')));
  // edit (recorded with before/after) and remove
  assert.equal((await a.buyer.put(`/api/orders/${a.o}/review`, { thumbsUp: false, body: 'Changed my mind about the wording.' })).status, 200); assert.deepEqual(nums(await get(anon, `/s/${seller.handle}`)), { thumbs: 1, written: 2, reviews: 3 });
  assert.match(await get(anon, `/s/${seller.handle}`), /edited/); const ev = await q.all('SELECT kind, detail FROM review_events WHERE review_id = ? ORDER BY id', (await rev(a.o)).id); assert.deepEqual(ev.map((e) => e.kind), ['created', 'edited']); assert.match(ev[1].detail, /"before"/);
  assert.equal((await b.buyer.put(`/api/orders/${a.o}/review`, { thumbsUp: true })).status, 404, 'cannot edit someone else\'s review');
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/review/remove`, {})).status, 200); assert.deepEqual(nums(await get(anon, `/s/${seller.handle}`)), { thumbs: 1, written: 1, reviews: 2 });
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/review/remove`, {})).status, 404); assert.match(await get(a.buyer, `/orders/${a.o}`), /Leave a review/, 'a removed review can be written again');
  assert.equal((await a.buyer.post(`/api/orders/${a.o}/review`, { thumbsUp: true, body: 'Rewritten.' })).status, 200); assert.equal((await q.get('SELECT COUNT(*) n FROM seller_reviews WHERE order_id = ?', a.o)).n, 1, 'still one row per order');
  // a seller with no reviews shows an honest empty state, never a perfect score
  const fresh = await H.newSeller('Fresh'), empty = await get(anon, `/s/${fresh.handle}`); assert.match(empty, /No reviews yet/); assert.doesNotMatch(empty, /rep-counts/);
  // cards show raw counts only when there are reviews
  assert.match(await get(anon, '/sellers?page=1'), /rep-line|No listings yet|scard/);
  assert.match(await get(b.buyer, `/s/${seller.handle}`), /Report this review/); assert.doesNotMatch(store, /Report this review/, 'reporting needs a login');
  void d;
});

test('reports, moderator hide/restore/dismiss with reasons, immutable content, and a full audit trail', async () => {
  const adm = await mkAdmin(), mod = await newMod(adm), seller = await H.newSeller('Mod'), x = await order('delivered', seller), y = await order('delivered', seller);
  await x.buyer.post(`/api/orders/${x.o}/review`, { thumbsUp: true, body: 'Totally legit, buy now at my-site.example' }); await y.buyer.post(`/api/orders/${y.o}/review`, { thumbsUp: true, body: 'Nice jacket.' });
  const rx = (await rev(x.o)).id, ry = (await rev(y.o)).id, rando = await H.newUser('Rando');
  // reporting
  assert.equal((await new H.Client().post(`/api/reviews/${rx}/report`, { reason: 'spam link' })).status, 401); assert.equal((await rando.post(`/api/reviews/${rx}/report`, { reason: 'no' })).status, 422);
  assert.equal((await x.buyer.post(`/api/reviews/${rx}/report`, { reason: 'reporting my own review' })).status, 403);
  assert.equal((await rando.post(`/api/reviews/${rx}/report`, { reason: 'Looks like an advertisement' })).status, 200); assert.equal((await rando.post(`/api/reviews/${rx}/report`, { reason: 'Looks like an advertisement' })).status, 409, 'one report per person');
  assert.equal((await seller.post(`/api/reviews/${rx}/report`, { reason: 'This is spam, not an order experience' })).status, 200, 'the reviewed seller can report too');
  assert.equal((await rando.post('/api/reviews/999999/report', { reason: 'does not exist' })).status, 404);
  // access control
  for (const who of [rando, seller, x.buyer, new H.Client()]) { assert.ok([401, 403].includes((await who.post(`/api/moderation/reviews/${rx}/hide`, { reason: 'I want to hide it' })).status)); assert.ok([401, 302, 403].includes((await who.get('/moderation/reviews')).status)); }
  const queue = await get(mod, '/moderation/reviews'); assert.match(queue, /my-site\.example/); assert.match(queue, /Looks like an advertisement/); assert.match(queue, /cannot change its text/);
  assert.equal((await mod.post(`/api/moderation/reviews/${rx}/hide`, {})).status, 422, 'a reason is required');
  assert.equal((await mod.post(`/api/moderation/reviews/${rx}/hide`, { reason: 'Advertisement, not an order experience', body: 'edited by moderator', thumbs_up: 0 })).status, 200);
  const hidden = await rev(x.o); assert.equal(hidden.status, 'hidden'); assert.equal(hidden.body, 'Totally legit, buy now at my-site.example', 'content is untouched'); assert.equal(hidden.thumbs_up, 1);
  const store = await get(new H.Client(), `/s/${seller.handle}`); assert.doesNotMatch(store, /my-site\.example/); assert.match(store, /<strong>1<\/strong><span>thumbs-up/, 'hidden reviews stop counting');
  assert.deepEqual((await q.all('SELECT status FROM review_reports WHERE review_id = ? ORDER BY id', rx)).map((r) => r.status), ['actioned', 'actioned']);
  assert.match(await get(x.buyer, `/orders/${x.o}`), /hidden the review/); assert.equal((await x.buyer.put(`/api/orders/${x.o}/review`, { thumbsUp: true, body: 'edit after hide' })).status, 403); assert.equal((await x.buyer.post(`/api/orders/${x.o}/review/remove`, {})).status, 403);
  assert.equal((await x.buyer.post(`/api/orders/${x.o}/review`, { thumbsUp: true })).status, 409, 'cannot dodge a hide by posting again');
  assert.equal((await mod.post(`/api/moderation/reviews/${rx}/hide`, { reason: 'already hidden' })).status, 409);
  assert.equal((await mod.post(`/api/moderation/reviews/${rx}/restore`, { reason: 'After checking, it is a genuine experience' })).status, 200); assert.equal((await rev(x.o)).status, 'published'); assert.match(await get(new H.Client(), `/s/${seller.handle}`), /my-site\.example/);
  // dismissing reports on a review that stays up
  await rando.post(`/api/reviews/${ry}/report`, { reason: 'I just do not like it' }); assert.equal((await mod.post(`/api/moderation/reviews/${ry}/dismiss`, { reason: 'Reviewed: normal opinion, no rule broken' })).status, 200);
  assert.equal((await rev(y.o)).status, 'published'); assert.equal((await q.get('SELECT status FROM review_reports WHERE review_id = ?', ry)).status, 'dismissed'); assert.equal((await mod.post(`/api/moderation/reviews/${ry}/dismiss`, { reason: 'nothing open any more' })).status, 409);
  // audit trail
  assert.deepEqual((await q.all('SELECT kind FROM review_events WHERE review_id = ? ORDER BY id', rx)).map((e) => e.kind), ['created', 'reported', 'reported', 'hidden', 'restored']);
  for (const a of ['review_hidden', 'review_restored', 'review_reports_dismissed']) assert.ok(await q.get('SELECT 1 x FROM audit_log WHERE action = ? AND actor_id = ?', a, await uid(mod.email)), a);
  assert.match(await get(mod, `/moderation/reviews/${rx}`), /hidden/); await assert.rejects(async () => await q.run("UPDATE review_events SET kind = 'created' WHERE review_id = ?", rx), /append-only/); await assert.rejects(async () => await q.run('DELETE FROM review_events WHERE review_id = ?', rx), /append-only/);
  assert.ok(await q.get("SELECT 1 x FROM review_events WHERE review_id = ? AND kind = 'hidden' AND actor_id = ? AND detail LIKE '%Advertisement%'", rx, await uid(mod.email)));
});

test('existing accounts, orders and the old reviews table are untouched; migration 14 is additive', async () => {
  const { dbAt } = require('./pgmig'); const d = await dbAt(13);
  try {
    await d.run('INSERT INTO users(email, password_hash, display_name, is_admin, created_at) VALUES(?,?,?,?,?)', 'owner@x.test', 'x', 'Owner', 1, 1); await d.run('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', 'b@x.test', 'x', 'B', 1);
    const before = await d.all('SELECT * FROM users ORDER BY id'); await d.applyNext();
    const after = await d.all('SELECT * FROM users ORDER BY id'); for (let i = 0; i < before.length; i++) for (const k of Object.keys(before[i])) assert.equal(after[i][k], before[i][k], k);
    assert.equal(Number((await d.one('SELECT COUNT(*) n FROM seller_reviews')).n), 0, 'no review is invented'); assert.equal(Number((await d.one('SELECT COUNT(*) n FROM reviews')).n), 0);
  } finally { await d.close(); }
});

test('policies and help disclose reviews, order-linked labels, unverified payments and the amount check — without promises', async () => {
  const anon = new H.Client(), t = {}; for (const p of ['/terms', '/privacy', '/payments', '/rules', '/support', '/contact', '/']) t[p] = (await get(anon, p)).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  assert.match(t['/terms'], /order-linked/); assert.match(t['/terms'], /does not independently verify those payments/); assert.match(t['/terms'], /moderators can hide or restore a review with a recorded reason, but cannot edit/);
  assert.match(t['/privacy'], /Reviews: your thumbs-up/); assert.match(t['/privacy'], /first name/); assert.match(t['/rules'], /fake or incentivised reviews/); assert.match(t['/support'], /Report this review/);
  assert.match(t['/payments'], /cannot set, read or verify/); assert.match(t['/payments'], /make sure the seller's page shows the same total/i); assert.match(t['/payments'], /sellers may only use Stripe-hosted Payment Links, must confirm that their link charges exactly item price plus shipping/);
  assert.match(t['/'], /PairPlug\s*The Clothing Marketplace\./); assert.match(t['/'], /Discover independent sellers, find your next favorite piece, and follow the stores bringing fresh drops\./); assert.match(t['/'], /PairPlug · The Clothing Marketplace/);
  const all = Object.values(t).join(' '); assert.doesNotMatch(all, /North American secondhand|exclusively secondhand/i); assert.doesNotMatch(all, /verified purchase|buyer protection (program|guarantee)|guaranteed refund|biggest|most popular|safest marketplace/i);
  assert.match(await get(anon, '/'), /<title>[^<]*The Clothing Marketplace/);
});
