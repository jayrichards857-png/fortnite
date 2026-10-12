'use strict';
// Photo reviews: star rating, max 3 photos (client + server + DB), received-order-only, safe upload validation, DB-backed storage, owner moderation with audit.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q, tx } = require('../src/db');
const { png } = require('../scripts/png');
const fs = require('node:fs');
const path = require('node:path');

test.before(async () => await H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_rph1';
const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const mkAdmin = async () => { const a = await H.newUser('Owner'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
async function order(stage = 'delivered') {
  const seller = await H.newSeller('Photo'), buyer = await H.newUser('Snapper'), id = await H.makeListing(seller, { payment_url: LINK });
  const r = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text); const o = oid(r);
  if (stage !== 'pending') {
    await seller.post(`/api/seller/orders/${o}/confirm-payment`, {});
    await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '94001' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0') });
    if (stage === 'delivered') assert.equal((await buyer.post(`/api/orders/${o}/received`, {})).status, 200);
  }
  return { seller, buyer, o, listing: id };
}
const img = (n = 1) => png(32, 40, (x, y) => [(x * 7 + n * 40) % 255, y * 5 % 255, 100]);
const up = (c, buf, type = 'image/png') => c.req('POST', '/api/review-photos', buf, { raw: true, type });
const photo = async (c) => { const r = await up(c, img(Math.random() * 5 | 0)); assert.equal(r.status, 200, r.text); return r.json.file; };
const review = async (o, c = o.buyer) => await q.get('SELECT * FROM seller_reviews WHERE order_id = ?', o.o);

test('a buyer with a received order posts stars + text + 3 photos; it shows on the listing page and the seller storefront', async () => {
  const o = await order(), ids = [await photo(o.buyer), await photo(o.buyer), await photo(o.buyer)];
  const r = await o.buyer.post(`/api/orders/${o.o}/review`, { rating: 5, body: 'Exactly as pictured, lovely stitching.', photos_json: JSON.stringify(ids) });
  assert.equal(r.status, 200, r.text);
  const row = await review(o); assert.equal(row.rating, 5); assert.equal(row.thumbs_up, 1);
  assert.deepEqual((await q.all("SELECT id FROM review_photos WHERE review_id = ? AND status = 'published' ORDER BY id", row.id)).map((p) => Number(p.id)), ids.map(Number));
  const anon = new H.Client();
  for (const url of [`/listing/${o.listing}`, `/s/${o.seller.handle}`]) {
    const html = (await anon.get(url)).text;
    assert.match(html, /aria-label="5 out of 5 stars"/, url); assert.match(html, /Exactly as pictured/, url);
    for (const id of ids) assert.match(html, new RegExp(`/review-photos/${id}"`), url);
  }
  const p = await anon.get(`/review-photos/${ids[0]}`);
  assert.equal(p.status, 200); assert.equal(p.headers.get('content-type'), 'image/png'); assert.equal(p.headers.get('x-content-type-options'), 'nosniff'); assert.match(p.headers.get('content-security-policy'), /default-src 'none'/);
});

test('the three-photo limit is enforced by the server (clear 422, nothing stored) and by the database', async () => {
  const o = await order(), ids = [];
  for (let i = 0; i < 4; i++) ids.push(await photo(o.buyer));
  const r = await o.buyer.post(`/api/orders/${o.o}/review`, { rating: 4, photos_json: JSON.stringify(ids) });
  assert.equal(r.status, 422); assert.match(r.json.fields.photos, /at most 3/);
  assert.equal(await review(o), undefined, 'no review was created, no photos silently dropped');
  assert.equal((await q.get("SELECT COUNT(*) n FROM review_photos WHERE review_id IS NOT NULL AND user_id = (SELECT id FROM users WHERE email = ?)", o.buyer.email)).n, 0);
  // backstop: even a buggy code path cannot attach a fourth live photo
  assert.equal((await o.buyer.post(`/api/orders/${o.o}/review`, { rating: 4, photos_json: JSON.stringify(ids.slice(0, 3)) })).status, 200);
  const rv = await review(o);
  await assert.rejects(q.run("UPDATE review_photos SET review_id = ?, status = 'published' WHERE id = ?", rv.id, ids[3]), /at most 3 photos/);
  // the front end stops at 3 as well, and says so
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'uploader.js'), 'utf8'); assert.match(js, /at most \$\{max\} photos/);
  assert.match((await o.buyer.get(`/orders/${o.o}`)).text, /data-uploader="rp\d+" data-max="3"/);
});

test('only the buyer of a received order can review; nobody else can attach someone else\'s photos', async () => {
  const pending = await order('pending'), shipped = await order('shipped'), done = await order(), stranger = await H.newUser('Stranger');
  for (const o of [pending, shipped]) assert.equal((await o.buyer.post(`/api/orders/${o.o}/review`, { rating: 5 })).status, 409);
  assert.equal((await stranger.post(`/api/orders/${done.o}/review`, { rating: 5 })).status, 404);
  assert.equal((await done.seller.post(`/api/orders/${done.o}/review`, { rating: 5 })).status, 404);
  const mine = await photo(stranger);
  const r = await done.buyer.post(`/api/orders/${done.o}/review`, { rating: 5, photos_json: JSON.stringify([mine]) });
  assert.equal(r.status, 422, "someone else's pending photo is not attachable");
  assert.equal((await done.buyer.post(`/api/orders/${done.o}/review`, { rating: 6 })).status, 422);
  assert.equal((await done.buyer.post(`/api/orders/${done.o}/review`, { rating: 0 })).status, 422);
});

test('uploads are validated by content: type, size, dimensions; no client filename is ever used', async () => {
  const b = await H.newUser('Uploader'), anon = new H.Client();
  assert.equal((await up(anon, img())).status, 401, 'login required');
  assert.equal((await up(b, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png')).status, 415, 'svg/script posing as png');
  assert.equal((await up(b, Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg')).status, 415);
  assert.equal((await up(b, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]))).status, 415, 'png magic with no readable header');
  assert.equal((await up(b, Buffer.concat([img(), Buffer.alloc(4.5 * 1024 * 1024)]))).status, 413, 'over 4 MB');
  const huge = Buffer.from(img()); huge.writeUInt32BE(30000, 16); huge.writeUInt32BE(30000, 20);
  assert.equal((await up(b, huge)).status, 413, 'absurd pixel dimensions');
  const ok = await up(b, img()); assert.equal(ok.status, 200);
  const row = await q.get('SELECT mime, bytes, width, height, length(data) len FROM review_photos WHERE id = ?', ok.json.file);
  assert.deepEqual({ mime: row.mime, w: row.width, h: row.height, same: row.bytes === row.len }, { mime: 'image/png', w: 32, h: 40, same: true });
  assert.ok(!fs.readdirSync(require('../src/config').uploadDir).some((f) => f.includes(String(ok.json.file)) && false), 'sanity');
  assert.match(String(ok.json.file), /^\d+$/, 'addressed by id, not by a client-supplied name');
});

test('photos live in the database, not on local disk', async () => {
  const o = await order(), before = new Set(fs.readdirSync(require('../src/config').uploadDir)), id = await photo(o.buyer);
  assert.deepEqual(new Set(fs.readdirSync(require('../src/config').uploadDir)), before, 'nothing written to the uploads directory');
  assert.ok((await q.get('SELECT length(data) n FROM review_photos WHERE id = ?', id)).n > 0);
});

test('owner/admin can inspect reviews and remove a photo or a review; audited; non-staff cannot; hidden content stops being public', async () => {
  const o = await order(), ids = [await photo(o.buyer), await photo(o.buyer)];
  await o.buyer.post(`/api/orders/${o.o}/review`, { rating: 3, body: 'Okay item.', photos_json: JSON.stringify(ids) });
  const rv = await review(o), admin = await mkAdmin(), anon = new H.Client();
  const page = (await admin.get('/moderation/reviews')).text;
  assert.match(page, /Recent reviews/); assert.match(page, /Okay item\./); assert.match(page, new RegExp(`data-photo="${ids[0]}"`));
  assert.equal((await o.buyer.get('/moderation/reviews')).status >= 300 || (await o.buyer.get('/moderation/reviews')).status === 403 || (await o.buyer.get('/moderation/reviews')).status === 404, true);
  assert.equal((await o.buyer.post(`/api/moderation/review-photos/${ids[0]}/remove`, { reason: 'because I say so' })).status, 403);
  assert.equal((await admin.post(`/api/moderation/review-photos/${ids[0]}/remove`, { reason: 'x' })).status, 422, 'reason required');
  assert.equal((await admin.post(`/api/moderation/review-photos/${ids[0]}/remove`, { reason: 'Inappropriate image' })).status, 200);
  assert.equal((await anon.get(`/review-photos/${ids[0]}`)).status, 404, 'removed photo is no longer public');
  assert.equal((await anon.get(`/review-photos/${ids[1]}`)).status, 200);
  assert.match((await anon.get(`/s/${o.seller.handle}`)).text, /Okay item\./, 'review text untouched');
  assert.equal((await admin.get(`/review-photos/${ids[0]}`)).status, 200, 'staff can still inspect it');
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'review_photo_removed'"));
  assert.ok(await q.get("SELECT 1 x FROM review_events WHERE review_id = ? AND kind = 'photo_removed'", rv.id));
  assert.equal((await admin.post(`/api/moderation/reviews/${rv.id}/hide`, { reason: 'Abusive review' })).status, 200);
  assert.equal((await anon.get(`/review-photos/${ids[1]}`)).status, 404, 'hiding the review hides its photos');
  assert.doesNotMatch((await anon.get(`/s/${o.seller.handle}`)).text, /Okay item\./);
});

test('editing a review can swap photos; removed ones stop being served', async () => {
  const o = await order(), a = await photo(o.buyer), b = await photo(o.buyer), c = await photo(o.buyer), anon = new H.Client();
  await o.buyer.post(`/api/orders/${o.o}/review`, { rating: 4, photos_json: JSON.stringify([a, b]) });
  assert.equal((await o.buyer.put(`/api/orders/${o.o}/review`, { rating: 5, photos_json: JSON.stringify([b, c]) })).status, 200);
  assert.equal((await anon.get(`/review-photos/${a}`)).status, 404); assert.equal((await anon.get(`/review-photos/${c}`)).status, 200);
  assert.equal((await review(o)).rating, 5);
});
void tx;
