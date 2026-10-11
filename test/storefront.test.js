'use strict';
// Storefront customisation, listing lifecycle, contact routes, image safety.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const SF = require('../src/storefront');
const { png } = require('../scripts/png');
const images = require('../src/images');

test.before(() => H.start());
test.after(() => H.stop());
const LINK = 'https://buy.stripe.com/test_sf_123';
const bigPng = (w = 800, h = 220) => png(w, h, (x, y) => [60 + (x % 100), 90, 120 + (y % 80)]);
async function upload(c, buf) { const r = await c.req('POST', '/api/uploads', buf, { raw: true, type: 'image/png' }); assert.equal(r.status, 200, r.text); return r.json.file; }
const text = async (c, u) => (await c.get(u)).text;

test('palette: every theme/accent combination meets WCAG contrast', () => {
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const [t, v] of Object.entries(SF.PALETTE.themes)) {
    assert.ok(ratio(v.text, v.bg) >= 4.5, `${t} text`); assert.ok(ratio(v.muted, v.bg) >= 4.5, `${t} muted`); assert.ok(ratio(v.muted, v.card) >= 4.5, `${t} muted on card`);
    for (const [a, [light, dark]] of Object.entries(SF.PALETTE.accents)) {
      const acc = t === 'dark' ? dark : light;
      assert.ok(ratio(v.ink, acc) >= 4.5, `${t}/${a}: button text on accent`); assert.ok(ratio(acc, v.bg) >= 3, `${t}/${a}: accent against background`);
    }
  }
  const css = SF.themeCss(); assert.match(css, /\.store\.theme-dark\.acc-forest/); assert.doesNotMatch(css, /[<>]|expression|javascript:|url\(/);
});

test('storefront settings persist as a private draft, preview only for the owner, publish makes them public; survive restart-like reloads', async () => {
  const s = await H.newSeller('Brand'), other = await H.newSeller('Other'), anon = new H.Client(), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(s, { payment_url: LINK, title: 'Featured jacket' }); await H.makeListing(s, { payment_url: LINK, title: 'Plain tee' });
  const avatar = await upload(s, bigPng(200, 200)), banner = await upload(s, bigPng(1200, 300));
  const settings = { theme: 'dark', accent: 'ocean', layout: 'large', sort: 'price_desc', headline: 'Vintage workwear', announcement: 'Shipping on Fridays!', about: 'I restore workwear.\nSecond line', avatar, banner, featured: [id],
    links: [{ kind: 'instagram', url: 'https://www.instagram.com/brand' }], showLocation: false };
  assert.equal((await s.put('/api/seller/storefront', settings)).status, 200);
  // not public yet: visitors still see the default storefront; the owner can preview the draft
  let pub = await text(anon, `/s/${s.handle}`); assert.doesNotMatch(pub, /Vintage workwear/); assert.match(pub, /theme-light acc-forest/);
  assert.doesNotMatch(await text(buyer, `/s/${s.handle}?preview=1`), /Vintage workwear/, 'a visitor adding ?preview=1 gets no draft');
  assert.doesNotMatch(await text(other, `/s/${s.handle}?preview=1`), /Vintage workwear/, "another seller can't preview someone else's draft");
  const prev = await text(s, `/s/${s.handle}?preview=1`);
  assert.match(prev, /Preview\./); assert.match(prev, /theme-dark acc-ocean/); assert.match(prev, /Vintage workwear/); assert.match(prev, /Shipping on Fridays!/); assert.match(prev, /l-large/); assert.match(prev, new RegExp(avatar)); assert.match(prev, new RegExp(banner));
  assert.match(prev, /Featured/); assert.doesNotMatch(prev, /Local ship/, 'location hidden by the seller');
  // publish -> identical content for everybody
  assert.equal((await s.post('/api/seller/storefront/publish')).status, 200);
  pub = await text(anon, `/s/${s.handle}`);
  for (const re of [/theme-dark acc-ocean/, /Vintage workwear/, /Shipping on Fridays!/, /instagram ↗/, /l-large/]) assert.match(pub, re);
  assert.doesNotMatch(pub, /Preview\./);
  assert.ok(pub.indexOf('Featured jacket') < pub.indexOf('Plain tee'), 'featured items come first');
  assert.match(pub, /rel="noopener noreferrer nofollow ugc"/);
  assert.match(pub, /Contact seller/); assert.match(pub, /aim to reply to messages within 48 hours/); assert.doesNotMatch(pub, new RegExp(s.email.replace('.', '\\.')), 'private email is never exposed');
  // persistence: the editor re-renders the saved values; draft vs published tracking; discard
  const editor = await text(s, '/dashboard/storefront'); assert.match(editor, /No unpublished changes/); assert.match(editor, /value="dark" checked/); assert.match(editor, /Vintage workwear/);
  await s.put('/api/seller/storefront', { ...settings, headline: 'Draft headline', theme: 'warm' });
  assert.match(await text(s, '/dashboard/storefront'), /unpublished changes/); assert.match(await text(anon, `/s/${s.handle}`), /Vintage workwear/);
  assert.equal((await s.post('/api/seller/storefront/discard')).status, 200);
  assert.doesNotMatch(await text(s, `/s/${s.handle}?preview=1`), /Draft headline/);
  assert.equal((await s.post('/api/seller/storefront/publish')).status, 409, 'nothing to publish');
  // another seller cannot touch it; buyers cannot use the editor APIs
  assert.equal((await buyer.put('/api/seller/storefront', settings)).status, 403); assert.equal((await new H.Client().put('/api/seller/storefront', settings)).status, 401);
  const evil = await other.put('/api/seller/storefront', { ...settings, avatar });   // someone else's upload
  assert.equal(evil.status, 422); assert.ok(evil.json.fields.avatar);
  assert.equal((await other.put('/api/seller/storefront', { featured: [id] })).status, 422, "can't feature another seller's item");
  assert.match(await text(anon, `/s/${s.handle}`), /Vintage workwear/, 'the other seller changed nothing');
  // the storefront stylesheet is generated from the curated palette only
  const css = await text(anon, '/storefront.css'); assert.match(css, /--accent:/);
});

test('validation: unsafe, unsupported or oversized values are rejected; text is escaped; no HTML/CSS/JS can be injected', async () => {
  const s = await H.newSeller('Valid'), file = await upload(s, bigPng(300, 300));
  const bad = async (patch, field) => { const r = await s.put('/api/seller/storefront', patch); assert.equal(r.status, 422, JSON.stringify(patch)); assert.ok(r.json.fields[field], field + ' ' + JSON.stringify(r.json.fields)); };
  await bad({ theme: 'hotpink' }, 'theme'); await bad({ accent: '#ff0000' }, 'accent'); await bad({ accent: 'red;background:url(//evil)' }, 'accent'); await bad({ layout: 'masonry' }, 'layout'); await bad({ sort: 'random' }, 'sort');
  await bad({ headline: 'x'.repeat(81) }, 'headline'); await bad({ announcement: 'x'.repeat(241) }, 'announcement'); await bad({ about: 'x'.repeat(1201) }, 'about');
  await bad({ about: 'Guaranteed by PairPlug and protected by escrow' }, 'about'); await bad({ headline: 'Official PairPlug staff' }, 'headline'); await bad({ announcement: 'PairPlug buyer protection included' }, 'announcement');
  await bad({ links: [{ kind: 'instagram', url: 'http://instagram.com/x' }] }, 'links'); await bad({ links: [{ kind: 'instagram', url: 'https://evil.example/instagram.com' }] }, 'links'); await bad({ links: [{ kind: 'instagram', url: 'javascript:alert(1)' }] }, 'links');
  await bad({ links: [{ kind: 'website', url: 'https://example.com' }] }, 'links'); await bad({ links: [{ kind: 'instagram', url: 'https://instagram.com@evil.example/x' }] }, 'links');
  await bad({ links: Array(5).fill({ kind: 'etsy', url: 'https://etsy.com/shop/x' }) }, 'links'); await bad({ links: [{ kind: 'etsy', url: 'https://etsy.com/a' }, { kind: 'etsy', url: 'https://etsy.com/b' }] }, 'links');
  await bad({ avatar: '../../etc/passwd' }, 'avatar'); await bad({ avatar: 'a'.repeat(32) + '.png' }, 'avatar'); await bad({ banner: file }, 'banner');   // a 300x300 image is too small for a banner
  await bad({ featured: [1, 2, 3, 4, 5, 6, 7] }, 'featured'); await bad({ featured: [99999] }, 'featured');
  // HTML/script in text is stored as text and always escaped on output
  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  assert.equal((await s.put('/api/seller/storefront', { headline: xss.slice(0, 60), announcement: xss, about: xss, avatar: file })).status, 200);
  await s.post('/api/seller/storefront/publish');
  for (const u of [`/s/${s.handle}`, '/dashboard/storefront']) { const t = await text(s, u); assert.ok(!t.includes('<img src=x onerror') && !t.includes('<script>alert('), u); }
  assert.match(await text(new H.Client(), `/s/${s.handle}`), /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  // stored settings contain only whitelisted keys: smuggled keys (css, html, style) are dropped
  await s.put('/api/seller/storefront', { theme: 'light', css: 'body{display:none}', html: '<b>x</b>', style: 'x', customCss: 'x', avatar: file });
  const stored = JSON.parse(q.get('SELECT draft_json d FROM storefronts WHERE seller_id = (SELECT id FROM users WHERE handle = ?)', s.handle).d);
  assert.deepEqual(Object.keys(stored).sort(), Object.keys(SF.defaults()).sort());
  assert.doesNotMatch(await text(s, `/s/${s.handle}?preview=1`), /display:none/);
});

test('images: dimensions are checked, replaced files are removed only when nothing references them', async () => {
  const s = await H.newSeller('Img'), anon = new H.Client();
  assert.equal((await s.req('POST', '/api/uploads', png(9000, 10, () => [1, 2, 3]), { raw: true, type: 'image/png' })).status, 413, 'absurd dimensions are refused');
  assert.equal((await s.req('POST', '/api/uploads', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6)]), { raw: true, type: 'image/png' })).status, 415, 'truncated/unreadable header');
  const dims = images.dimensions(bigPng(321, 123)); assert.deepEqual(dims, { w: 321, h: 123 });
  const one = await upload(s, bigPng(300, 300)), two = await upload(s, bigPng(310, 310)), shared = await upload(s, bigPng(320, 320));
  const f = (n) => path.join(config.uploadDir, n);
  // listing uses `shared`; storefront avatar uses `shared` too, then switches away: the file must survive because the listing still uses it
  const id = await H.makeListing(s, { payment_url: LINK }); q.run('UPDATE listing_images SET file = ? WHERE listing_id = ?', shared, id);
  await s.put('/api/seller/storefront', { avatar: shared }); await s.post('/api/seller/storefront/publish');
  await s.put('/api/seller/storefront', { avatar: one }); await s.post('/api/seller/storefront/publish');
  assert.ok(fs.existsSync(f(shared)), 'still referenced by a listing => kept');
  await s.put('/api/seller/storefront', { avatar: two }); assert.ok(fs.existsSync(f(one)), 'published image kept until the replacement is published');
  await s.post('/api/seller/storefront/publish'); assert.equal(fs.existsSync(f(one)), false, 'unreferenced after publish => removed'); assert.ok(fs.existsSync(f(two)));
  assert.equal((await fetch(H.base + '/uploads/' + one)).status, 404);
  // a file that an order snapshot or evidence references is never deleted
  assert.equal(images.removeIfUnreferenced(shared), false); assert.ok(fs.existsSync(f(shared)));
  q.run('INSERT INTO uploads(file, user_id, created_at) VALUES(?,?,?)', 'e'.repeat(32) + '.png', 1, 1); fs.writeFileSync(f('e'.repeat(32) + '.png'), bigPng(20, 20));
  assert.equal(images.cleanupOrphanUploads(), 1, 'old unreferenced uploads are cleaned up'); assert.ok(fs.existsSync(f(two)));
  assert.equal(images.removeIfUnreferenced('../../package.json'), false);
});

test('listing lifecycle: pause, resume, unpublish, mark sold, delete — ownership and legal transitions enforced', async () => {
  const s = await H.newSeller('Life'), other = await H.newSeller('Not'), buyer = await H.newUser('B');
  const id = await H.makeListing(s, { payment_url: LINK });
  const st = () => q.get('SELECT status FROM listings WHERE id = ?', id).status;
  for (const a of ['pause', 'resume', 'unpublish', 'mark-sold']) assert.equal((await other.post(`/api/seller/listings/${id}/${a}`)).status, 404, a);
  assert.equal((await other.req('DELETE', `/api/seller/listings/${id}`)).status, 404);
  assert.equal((await buyer.post(`/api/seller/listings/${id}/pause`)).status, 403);
  assert.equal((await s.post(`/api/seller/listings/${id}/resume`)).status, 409, 'active items cannot be resumed');
  assert.equal((await s.post(`/api/seller/listings/${id}/pause`)).status, 200); assert.equal(st(), 'archived');
  assert.equal((await buyer.get(`/listing/${id}`)).status, 404, 'a paused listing is not public');
  assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 409);
  assert.equal((await s.post(`/api/seller/listings/${id}/mark-sold`)).status, 409, 'only items for sale can be marked sold');
  q.run('UPDATE users SET email_verified_at = NULL WHERE handle = ?', s.handle);
  const blocked = await s.post(`/api/seller/listings/${id}/resume`); assert.equal(blocked.status, 422); assert.match(blocked.json.error, /Verify your email/);
  q.run('UPDATE users SET email_verified_at = 1 WHERE handle = ?', s.handle);
  assert.equal((await s.post(`/api/seller/listings/${id}/resume`)).status, 200); assert.equal(st(), 'active');
  assert.equal((await s.post(`/api/seller/listings/${id}/unpublish`)).status, 200); assert.equal(st(), 'draft');
  assert.equal((await s.post(`/api/seller/listings/${id}/resume`)).status, 409);
  q.run("UPDATE listings SET status = 'active' WHERE id = ?", id);
  assert.equal((await s.post(`/api/seller/listings/${id}/mark-sold`)).status, 200); assert.equal(st(), 'sold');
  assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 409, 'a sold listing cannot start an order');
  assert.match((await buyer.get(`/listing/${id}`)).text, /Sold/); assert.doesNotMatch((await buyer.get(`/listing/${id}`)).text, />Buy now</);
  assert.equal((await s.post(`/api/seller/listings/${id}/pause`)).status, 409); assert.equal((await s.req('DELETE', `/api/seller/listings/${id}`)).status, 409);
  assert.equal(q.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'external_sale_recorded'").n, 1); assert.equal(q.get('SELECT COUNT(*) n FROM external_sales WHERE listing_id = ?', id).n, 1, 'marking sold records an external sale');
  // reserved items are untouchable by the seller
  const r = await H.makeListing(s, { payment_url: LINK }); assert.equal((await buyer.post('/api/purchases', { listingId: r, acknowledged: true, address: H.address })).status, 200);
  for (const a of ['pause', 'unpublish', 'mark-sold']) assert.equal((await s.post(`/api/seller/listings/${r}/${a}`)).status, 409, a);
  // delete: drafts without history can go; items with orders/conversations are kept
  const d = await s.post('/api/seller/listings', { title: 'Scratch draft', category: 'clothing', price: '10', status: 'draft' }); assert.equal(d.status, 200);
  assert.equal((await s.req('DELETE', `/api/seller/listings/${d.json.id}`)).status, 200); assert.equal(q.get('SELECT 1 x FROM listings WHERE id = ?', d.json.id), undefined);
  const kept = await s.post('/api/seller/listings', { title: 'Has chat', category: 'clothing', price: '10', status: 'draft' }); q.run("UPDATE listings SET status = 'archived' WHERE id = ?", kept.json.id);
  q.run('INSERT INTO conversations(buyer_id, seller_id, listing_id, created_at) VALUES((SELECT id FROM users WHERE email = ?), (SELECT id FROM users WHERE handle = ?), ?, 1)', buyer.email, s.handle, kept.json.id);
  assert.equal((await s.req('DELETE', `/api/seller/listings/${kept.json.id}`)).status, 409);
  await H.makeListing(s, { payment_url: LINK, title: 'Still for sale' });
  assert.match((await s.get('/dashboard/inventory')).text, /Sold outside PairPlug/);
});

test('listing validation & hybrid purchase UI: currency, prices, contact-only listings never show a checkout button', async () => {
  const s = await H.newSeller('Hyb'), buyer = await H.newUser('B'), file = await H.upload(s);
  const base = { title: 'Contact only', category: 'clothing', condition: 'good', weight_oz: '10', shipping: '4', images: [file], status: 'active' };
  for (const price of ['-5', '0', '0.50', 'abc', '12.345', '10001', '1e3', '$', '']) assert.equal((await s.post('/api/seller/listings', { ...base, price })).status, 422, price);
  const ok = await s.post('/api/seller/listings', { ...base, price: '19.99' }); assert.equal(ok.status, 200);
  assert.equal(q.get('SELECT price_cents p, currency c FROM listings WHERE id = ?', ok.json.id).p, 1999); assert.equal(q.get('SELECT currency c FROM listings WHERE id = ?', ok.json.id).c, 'USD');
  assert.throws(() => q.run("UPDATE listings SET currency = 'EUR' WHERE id = ?", ok.json.id), /CHECK/);
  const page = (await buyer.get(`/listing/${ok.json.id}`)).text;
  assert.doesNotMatch(page, />Buy now</); assert.doesNotMatch(page, /href="\/buy\//); assert.match(page, /Contact seller/); assert.match(page, /Online checkout|set up checkout|arrange payment/i); assert.match(page, /USD/);
  assert.equal((await buyer.post('/api/purchases', { listingId: ok.json.id, acknowledged: true, address: H.address })).status, 409, 'and the API agrees');
  const withLink = await s.post('/api/seller/listings', { ...base, title: 'With link', price: '25.00', payment_url: LINK });
  const p2 = (await buyer.get(`/listing/${withLink.json.id}`)).text; assert.match(p2, />Buy now</); assert.match(p2, /Contact seller/); assert.match(p2, /can&#39;t guarantee a refund|can't guarantee a refund/);
});

test('contact routes: every active seller is contactable from the storefront and listings, with or without a payment link', async () => {
  const s = await H.newSeller('Chat'), buyer = await H.newUser('B'), stranger = await H.newUser('C');
  assert.equal((await new H.Client().post('/api/chat/conversations', { sellerHandle: s.handle })).status, 401);
  assert.equal((await s.post('/api/chat/conversations', { sellerHandle: s.handle })).status, 403, "can't message yourself");
  assert.equal((await buyer.post('/api/chat/conversations', { sellerHandle: 'nobody-here' })).status, 404);
  assert.equal((await buyer.post('/api/chat/conversations', {})).status, 400);
  const c = await buyer.post('/api/chat/conversations', { sellerHandle: s.handle }); assert.equal(c.status, 200);
  assert.equal(q.get('SELECT listing_id l FROM conversations WHERE id = ?', c.json.id).l, null, 'no listing needed');
  assert.equal((await buyer.post('/api/chat/conversations', { sellerHandle: s.handle.toUpperCase() })).json.id, c.json.id, 'one conversation per pair, case-insensitive handle');
  const id = await H.makeListing(s, { payment_url: null }).catch(() => H.makeListing(s, { payment_url: LINK }));
  assert.equal((await buyer.post('/api/chat/conversations', { listingId: id })).json.id, c.json.id);
  assert.equal(q.get('SELECT listing_id l FROM conversations WHERE id = ?', c.json.id).l, id);
  // forged identity fields are ignored
  const forged = await stranger.post('/api/chat/conversations', { sellerHandle: s.handle, buyerId: 1, sellerId: 1, buyer_id: 1 });
  assert.equal(q.get('SELECT buyer_id b FROM conversations WHERE id = ?', forged.json.id).b, q.get('SELECT id FROM users WHERE email = ?', stranger.email).id);
  // a suspended seller is no longer contactable; the storefront shows the contact button for a live one
  assert.match((await buyer.get(`/s/${s.handle}`)).text, /data-chat-seller/);
  q.run('UPDATE users SET banned = 1 WHERE handle = ?', s.handle);
  assert.equal((await new H.Client().post('/api/chat/conversations', { sellerHandle: s.handle })).status, 401);
  assert.equal((await (await H.newUser('D')).post('/api/chat/conversations', { sellerHandle: s.handle })).status, 404);
  assert.equal((await buyer.get(`/s/${s.handle}`)).status, 404);
});
