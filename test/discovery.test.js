'use strict';
// Seller discovery: search (products + sellers), homepage, following, new-drop notifications, search popularity (real data only, privacy-conscious).
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q, now } = require('../src/db');
const D = require('../src/discovery');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_disc1';
const get = async (c, u) => (await c.get(u)).text;
async function shop(name, handle, titles = [], extra = {}) {
  const s = await H.newSeller(name); q.run('UPDATE users SET store_name = ?, handle = ?, bio = ? WHERE handle = ?', name, handle, extra.bio || null, s.handle); s.handle = handle;
  s.ids = []; for (const t of titles) s.ids.push(await H.makeListing(s, { payment_url: LINK, title: t, ...(extra.listing || {}) }));
  return s;
}
const notifs = (email, title) => q.all(`SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? ${title ? 'AND n.title LIKE ?' : ''}`, ...(title ? [email, title] : [email]));

test('with no sellers or listings, discovery pages show honest empty states and invent nothing', async () => {
  const anon = new H.Client(); const home = await get(anon, '/'); assert.doesNotMatch(home, /Discover Sellers/); assert.match((await get(anon, '/sellers')), /No sellers to show yet/);
  assert.match(await get(anon, '/shop?q=sp5der&tab=sellers'), /No sellers match/); assert.doesNotMatch(await get(anon, '/shop?q=sp5der'), /Popular searches|Seller profiles/);
  assert.equal(D.popular({ force: true }).length, 0); assert.equal((await anon.get('/following')).status, 302);
});

test('search shows Products and Seller profiles separately, ranks sellers by real relevance, and works for anonymous visitors', async () => {
  const a = await shop('Sp5der Closet', 'sp5dercloset', ['Sp5der hoodie pink', 'Sp5der tee'], { bio: 'Streetwear resale' });
  const b = await shop('Vintage Vault', 'vintagevault', ['Nike windbreaker'], { bio: 'Vintage finds and a Sp5der collector corner' });
  const c = await shop('Plain Shop', 'plainshop', ['Gap sweater']);
  const anon = new H.Client(), t = await get(anon, '/shop?q=sp5der');
  assert.match(t, /Results for “sp5der”/); assert.match(t, /Products <span class="muted">2<\/span>/); assert.match(t, /Sellers <span class="muted">2<\/span>/); assert.match(t, /Sp5der hoodie pink/);
  assert.match(t, /Seller profiles/); assert.ok(t.indexOf('Sp5der Closet') < t.indexOf('Vintage Vault'), 'name match outranks a bio-only match'); assert.doesNotMatch(t, /Plain Shop/);
  const s = await get(anon, '/shop?q=sp5der&tab=sellers');
  assert.match(s, /Sellers for “sp5der”/); assert.match(s, /@sp5dercloset/); assert.match(s, /Streetwear resale/); assert.match(s, /href="\/s\/sp5dercloset"/); assert.match(s, /data-follow="sp5dercloset"[^>]*aria-pressed="false"/); assert.match(s, /scard-av-fb/, 'initial fallback when there is no avatar');
  assert.ok(s.includes('/listing/' + a.ids[0]) || s.includes('/listing/' + a.ids[1]), 'relevant active listings are previewed'); assert.ok(s.indexOf('Sp5der Closet') < s.indexOf('Vintage Vault'));
  assert.match(s, /Back to all results/); assert.match(s, /Products <span/);
  // brand / category / description and multi-word matching also find sellers; non-matching sellers are excluded
  q.run("UPDATE listings SET brand = 'Carhartt' WHERE id = ?", c.ids[0]); assert.match(await get(anon, '/shop?q=carhartt&tab=sellers'), /Plain Shop/);
  assert.doesNotMatch(await get(anon, '/shop?q=carhartt+zzzz&tab=sellers'), /Plain Shop/);
  // existing behaviour preserved: filters, sorting, params
  const f = await get(anon, '/shop?q=sp5der&category=outerwear&sort=price_asc'); assert.equal((await anon.get('/shop?q=sp5der&category=outerwear&sort=price_asc')).status, 200); assert.match(f, /Results for “sp5der”/);
  assert.match(await get(anon, '/shop?sort=price_desc&category=outerwear'), /Shop/);
  // empty states
  const none = await get(anon, '/shop?q=zzzzqq'); assert.match(none, /No matching items/); assert.match(none, /Clear filters and see all results|Browse the shop/); assert.match(await get(anon, '/shop?q=zzzzqq&tab=sellers'), /No sellers match/);
  // only public, available inventory counts: a paused listing or banned seller disappears
  q.run("UPDATE listings SET status = 'archived' WHERE id = ?", a.ids[0]); q.run("UPDATE listings SET status = 'archived' WHERE id = ?", a.ids[1]);
  assert.match(await get(anon, '/shop?q=sp5der&tab=sellers'), /Sp5der Closet/, 'still found by name'); assert.doesNotMatch(await get(anon, '/shop?q=sp5der'), /Sp5der hoodie pink/);
  q.run('UPDATE users SET banned = 1 WHERE handle = ?', 'sp5dercloset'); assert.doesNotMatch(await get(anon, '/shop?q=sp5der&tab=sellers'), /Sp5der Closet/); q.run('UPDATE users SET banned = 0 WHERE handle = ?', 'sp5dercloset'); void b;
});

test('Related discoveries come from real matching listings; Popular searches appear only with enough genuine searches', async () => {
  const s = await shop('Brand Shop', 'brandshop', ['Supreme box logo hoodie', 'Supreme cap']); q.run("UPDATE listings SET brand = 'Supreme' WHERE seller_id = (SELECT id FROM users WHERE handle = 'brandshop')");
  const anon = new H.Client(); let t = await get(anon, '/shop?q=hoodie');
  assert.match(t, /Related discoveries/); assert.match(t, /brand=Supreme/); assert.match(t, /category=/); assert.doesNotMatch(t, /Popular searches/, 'no real popularity data yet');
  // two searches by distinct sources are below the threshold; the third makes it qualify
  q.run('DELETE FROM search_log'); D.resetPopularCache();
  assert.equal(D.recordSearch('supreme hoodie', 'ip-1'), true); assert.equal(D.recordSearch('Supreme  Hoodie ', 'ip-2'), true); D.resetPopularCache(); assert.deepEqual(D.popular(), []);
  assert.equal(D.recordSearch('supreme hoodie', 'ip-3'), true); D.resetPopularCache(); assert.deepEqual(D.popular().map((r) => [r.term, r.n]), [['supreme hoodie', 3]], 'normalised and counted from real rows');
  t = await get(anon, '/shop?q=hoodie'); assert.match(t, /Popular searches/); assert.match(t, /supreme hoodie/); assert.doesNotMatch(await get(anon, '/shop?q=supreme+hoodie'), /<h2 id="pop-h">Popular searches<\/h2><div class="chips"><a class="chip" href="\/shop\?q=supreme\+hoodie">/, 'never lists the query itself');
  assert.deepEqual(D.relatedPopular('zzz'), []); void s;
});

test('search logging is privacy-conscious: normalised, noise and personal data excluded, rapid repeats dropped, no user/IP stored, old rows purged', async () => {
  const cols = q.all('PRAGMA table_info(search_log)').map((c) => c.name); assert.deepEqual(cols.sort(), ['created_at', 'id', 'term']);
  for (const bad of ['', ' ', 'a', '!!!', 'person@example.com', 'call 4155551234 now', 'https://evil.example/x', 'aaaaaaaa', 'one two three four five six seven']) assert.equal(D.normalizeTerm(bad), null, JSON.stringify(bad));
  assert.equal(D.normalizeTerm('  Sp5der   HOODIE!! '), 'sp5der hoodie'); assert.equal(D.normalizeTerm('Levi’s 501'), 'levis 501');
  q.run('DELETE FROM search_log'); const before = q.get('SELECT COUNT(*) n FROM search_log').n;
  assert.equal(D.recordSearch('nike dunk', 'ip-A'), true); assert.equal(D.recordSearch('nike dunk', 'ip-A'), false, 'rapid repeat from the same source is dropped'); assert.equal(D.recordSearch('nike dunk', 'ip-B'), true);
  assert.equal(q.get('SELECT COUNT(*) n FROM search_log').n, before + 2);
  const anon = new H.Client(); await anon.get('/shop?q=carhartt+jacket'); await anon.get('/shop?q=carhartt+jacket'); assert.equal(q.get("SELECT COUNT(*) n FROM search_log WHERE term = 'carhartt jacket'").n, 1);
  await anon.get('/shop?q=carhartt+jacket2&page=2'); assert.equal(q.get("SELECT COUNT(*) n FROM search_log WHERE term LIKE 'carhartt jacket2'").n, 0, 'only the first page of a search counts'); await anon.get('/shop?q='); await anon.get('/shop');
  assert.equal(q.get("SELECT COUNT(*) n FROM search_log WHERE term = ''").n, 0);
  q.run("INSERT INTO search_log(term, created_at) VALUES('ancient query', ?)", now() - 40 * 86400); assert.ok(D.purgeSearchLog() >= 1); assert.equal(q.get("SELECT COUNT(*) n FROM search_log WHERE term = 'ancient query'").n, 0);
});

test('homepage Discover Sellers and View all sellers use real, public stores with available items only', async () => {
  q.run("UPDATE users SET banned = 0"); const anon = new H.Client();
  const withItems = await shop('Home Seller One', 'homeone', ['Home jacket A', 'Home jacket B', 'Home jacket C', 'Home jacket D']), empty = await shop('Empty Store', 'emptystore', []), drafty = await shop('Draft Only', 'draftonly', ['Draft thing']);
  q.run("UPDATE listings SET status = 'draft' WHERE seller_id = (SELECT id FROM users WHERE handle = 'draftonly')");
  const home = await get(anon, '/'); assert.match(home, /Discover Sellers/); assert.match(home, /View all sellers/); assert.match(home, /@homeone/); assert.doesNotMatch(home, /@emptystore/); assert.doesNotMatch(home, /@draftonly/); assert.doesNotMatch(home, /Draft thing/);
  assert.equal((home.match(/href="\/listing\/\d+" title="Home jacket/g) || []).length, 3, 'a preview of up to 3 newest available items'); assert.match(home, /data-follow="homeone"/); assert.match(home, /Discover secondhand finds/);
  // pagination on /sellers (12 per page)
  for (let i = 0; i < 12; i++) await shop(`Pager Shop ${i}`, `pager${i}`, [`Pager item ${i}`]);
  const p1 = await get(anon, '/sellers'), p2 = await get(anon, '/sellers?page=2'); const n1 = (p1.match(/class="scard"/g) || []).length, n2 = (p2.match(/class="scard"/g) || []).length;
  assert.equal(n1, 12); assert.ok(n2 >= 1); assert.match(p1, /Page 1 of/); assert.match(p2, /Page 2 of/); assert.doesNotMatch(p1 + p2, /@emptystore|@draftonly/);
  void withItems; void empty; void drafty;
});

test('follow / unfollow: authentication required, idempotent, no self-follow, persistent across sessions, reflected on every page', async () => {
  const seller = await shop('Follow Me', 'followme', ['Follow item']), fan = await H.newUser('Fan'), other = await H.newUser('Other'), anon = new H.Client();
  assert.equal((await anon.post('/api/sellers/followme/follow')).status, 401); assert.equal((await anon.req('DELETE', '/api/sellers/followme/follow')).status, 401);
  assert.equal((await fan.post('/api/sellers/nobody-here/follow')).status, 404); const plain = fan.email;
  assert.equal((await seller.post('/api/sellers/followme/follow')).status, 400, 'cannot follow yourself');
  const f1 = await fan.post('/api/sellers/followme/follow'); assert.equal(f1.status, 200); assert.equal(f1.json.changed, true); assert.equal((await fan.post('/api/sellers/followme/follow')).json.changed, false, 'duplicate is a no-op');
  const fid = q.get('SELECT id FROM users WHERE email = ?', plain).id; assert.equal(q.get('SELECT COUNT(*) n FROM seller_follows WHERE follower_id = ?', fid).n, 1);
  assert.throws(() => q.run('INSERT INTO seller_follows(follower_id, seller_id, created_at) VALUES(?,?,1)', fid, fid), /CHECK|constraint/i); assert.throws(() => q.run('INSERT INTO seller_follows(follower_id, seller_id, created_at) VALUES(?, (SELECT id FROM users WHERE handle = ?), 1)', fid, 'followme'), /UNIQUE|constraint/i);
  q.run("UPDATE listings SET published_at = published_at + 1000000 WHERE seller_id = (SELECT id FROM users WHERE handle = 'followme')");   // newest => shown on the homepage strip
  for (const url of ['/shop?q=follow&tab=sellers', '/s/followme', '/', '/following']) assert.match(await get(fan, url), /data-follow="followme"[^>]*aria-pressed="true"/, url);
  assert.match(await get(other, '/s/followme'), /data-follow="followme"[^>]*aria-pressed="false"/, 'state is per user');
  // persists for a brand-new session (another device)
  const device2 = new H.Client(); await device2.post('/api/login', { email: plain, password: 'correct-horse-9' }); const fp = await get(device2, '/following'); assert.match(fp, /Follow Me/); assert.match(fp, /Follow item/); assert.match(await get(other, '/following'), /aren&#39;t following anyone yet|aren't following anyone yet/);
  assert.equal((await fan.req('DELETE', '/api/sellers/followme/follow')).json.following, false); assert.equal((await fan.req('DELETE', '/api/sellers/followme/follow')).json.changed, false); assert.match(await get(fan, '/s/followme'), /aria-pressed="false"/);
  // following grants no private data: the seller cannot see followers and a follower sees nothing private
  assert.doesNotMatch(await get(seller, '/dashboard'), /follower/i);
  q.run('UPDATE users SET banned = 1 WHERE handle = ?', 'followme'); assert.equal((await fan.post('/api/sellers/followme/follow')).status, 404, 'banned sellers can\'t be followed'); q.run('UPDATE users SET banned = 0 WHERE handle = ?', 'followme');
});

test('new-drop notifications: only first genuine publication, once, to eligible followers; read/unread and links work', async () => {
  const seller = await shop('Drop Seller', 'dropseller', []), fan = await H.newUser('DropFan'), nonFan = await H.newUser('NotFollowing'), banned = await H.newUser('BannedFan');
  for (const c of [fan, banned]) await c.post('/api/sellers/dropseller/follow'); q.run('UPDATE users SET banned = 1 WHERE email = ?', banned.email);
  // draft -> nothing
  const file = await H.upload(seller), body = { title: 'Fresh drop jacket', description: 'new', category: 'outerwear', brand: 'Acme', size: 'M', condition: 'good', price: '55.00', shipping: '6.00', shipping_payer: 'buyer', weight_oz: 20, payment_url: LINK, images: [file] };
  const d = await seller.post('/api/seller/listings', { ...body, status: 'draft' }); assert.equal(d.status, 200); assert.equal(notifs(fan.email).length, 0, 'drafts never notify');
  const dp = await seller.put(`/api/seller/listings/${d.json.id}`, { ...body, price: '50.00', status: 'draft' }); assert.equal(dp.status, 200); assert.equal(notifs(fan.email).length, 0, 'editing a draft never notifies');
  // publish -> exactly one notification for the eligible follower
  const pub = await seller.put(`/api/seller/listings/${d.json.id}`, { ...body, status: 'active' }); assert.equal(pub.status, 200);
  let ns = notifs(fan.email, 'New from%'); assert.equal(ns.length, 1); assert.equal(ns[0].title, 'New from Drop Seller'); assert.match(ns[0].body, /Fresh drop jacket/); assert.match(ns[0].body, /\$55\.00/); assert.equal(ns[0].link, `/listing/${d.json.id}`); assert.equal(ns[0].image, file); assert.equal(ns[0].read_at, null);
  assert.equal(notifs(nonFan.email).length, 0); assert.equal(notifs(banned.email).length, 0, 'banned followers are skipped'); assert.equal(notifs(seller.email, 'New from%').length, 0, 'the seller is never notified about their own listing');
  // retries / edits / pause+resume / bulk republish never duplicate
  await seller.put(`/api/seller/listings/${d.json.id}`, { ...body, status: 'active' }); await seller.put(`/api/seller/listings/${d.json.id}`, { ...body, price: '45.00', status: 'active' });
  await seller.post(`/api/seller/listings/${d.json.id}/pause`); await seller.post(`/api/seller/listings/${d.json.id}/resume`); await seller.post('/api/seller/listings/bulk', { ids: [d.json.id], action: 'status', status: 'active' });
  assert.equal(notifs(fan.email, 'New from%').length, 1, 'still exactly one'); assert.equal(D.announceDrop(d.json.id), 0, 'announcing again is a no-op'); assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?", `drop:${d.json.id}`).n, 1);
  // a brand-new listing created active directly notifies once; a paused/unpublished/sold one never does
  const direct = await seller.post('/api/seller/listings', { ...body, title: 'Direct active', status: 'active' }); assert.equal(notifs(fan.email, 'New from%').length, 2);
  const arch = await seller.post('/api/seller/listings', { ...body, title: 'Quietly paused', status: 'archived' }); assert.equal(notifs(fan.email, 'New from%').length, 2, 'a paused listing was never published'); void direct; void arch;
  // unverified sellers cannot publish, so nobody is notified
  q.run('UPDATE users SET email_verified_at = NULL WHERE handle = ?', 'dropseller'); const blocked = await seller.post('/api/seller/listings', { ...body, title: 'Blocked', status: 'active' }); assert.equal(blocked.status, 403); assert.equal(notifs(fan.email, 'New from%').length, 2); q.run("UPDATE users SET email_verified_at = 1 WHERE handle = ?", 'dropseller');
  // read / unread + link
  const page = await get(fan, '/notifications'); assert.match(page, /New from Drop Seller/); assert.match(page, /Fresh drop jacket/); assert.match(page, new RegExp(`href="/listing/${d.json.id}"`)); assert.match(page, new RegExp(`/uploads/${file}`));
  assert.equal(q.all("SELECT * FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? AND n.read_at IS NULL", fan.email).length, 0, 'viewing marks them read'); assert.equal((await fan.get(`/listing/${d.json.id}`)).status, 200);
  const unread = (await get(nonFan, '/')); void unread;
});

test('fan-out is set-based and safe for a seller with many followers', async () => {
  const seller = await shop('Popular Seller', 'popularseller', []); const sid = q.get('SELECT id FROM users WHERE handle = ?', 'popularseller').id, t = now();
  const ins = q.db ? null : null; void ins;
  const { db } = require('../src/db'); db.exec('BEGIN'); for (let i = 0; i < 1500; i++) { const r = q.run("INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?, 'x', ?, ?)", `bulk${i}@fan.test`, `Bulk ${i}`, t); q.run('INSERT INTO seller_follows(follower_id, seller_id, created_at) VALUES(?,?,?)', Number(r.lastInsertRowid), sid, t); } db.exec('COMMIT');
  const file = await H.upload(seller), t0 = Date.now(); const r = await seller.post('/api/seller/listings', { title: 'Mass drop', description: 'x', category: 'outerwear', size: 'M', condition: 'good', price: '30', shipping: '5', shipping_payer: 'buyer', weight_oz: 10, payment_url: LINK, images: [file], status: 'active' });
  assert.equal(r.status, 200); assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?", `drop:${r.json.id}`).n, 1500); assert.ok(Date.now() - t0 < 5000, 'one set-based insert');
  assert.equal(D.announceDrop(r.json.id), 0); assert.equal(q.get("SELECT COUNT(*) n FROM notifications WHERE dedupe_key = ?", `drop:${r.json.id}`).n, 1500);
});

test('existing behaviour is untouched: checkout, orders, shipping and seller privacy still work alongside discovery', async () => {
  const seller = await shop('Checkout Seller', 'checkoutseller', ['Checkout item']), buyer = await H.newUser('Buyer');
  const o = (await buyer.post('/api/purchases', { listingId: seller.ids[0], acknowledged: true, address: H.address })).json.orderId; assert.ok(o);
  assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`)).status, 200); assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: `9400${Date.now()}` })).status, 200);
  const stranger = await H.newSeller('Snoop'); assert.equal((await stranger.get(`/dashboard/orders/${o}`)).status, 404); assert.doesNotMatch(await get(stranger, '/dashboard/orders'), /Checkout item/);
  assert.doesNotMatch(await get(new H.Client(), '/shop?q=checkout&tab=sellers'), /1 Main St|Austin/, 'search never exposes buyer or recipient data');
});
