'use strict';
// Mobile-readiness of the server-rendered HTML (fast, no browser). Layout itself is checked in real Chromium by
// scripts/browser-mobile.js (npm run test:browser) and audited page-by-page by scripts/mobile-audit.js.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const { png } = require('../scripts/png');

test.before(async () => await H.start());
test.after(() => H.stop());

const html = async (c, u) => { const r = await c.get(u); assert.equal(r.status, 200, `${u} → ${r.status}`); return r.text.replace(/<script[\s\S]*?<\/script>/g, ''); };
const imgs = (h) => h.match(/<img\b[^>]*>/g) || [];
const uploadSized = async (c, w, h) => (await c.req('POST', '/api/uploads', png(w, h, (x, y) => [x % 255, y % 255, 120]), { raw: true, type: 'image/png' })).json.file;

test('every page shell is phone-ready: device-width viewport with safe areas, pinch-zoom kept, menu + labelled mobile search', async () => {
  const anon = new H.Client(), buyer = await H.newUser('Phone');
  for (const [c, u] of [[anon, '/'], [anon, '/shop'], [anon, '/login'], [buyer, '/orders'], [buyer, '/account']]) {
    const h = await html(c, u), vp = (h.match(/<meta name="viewport" content="([^"]+)"/) || [])[1];
    assert.ok(vp, `${u}: viewport meta`);
    assert.match(vp, /width=device-width/); assert.match(vp, /initial-scale=1/); assert.match(vp, /viewport-fit=cover/);
    assert.doesNotMatch(vp, /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?(\D|$)/, `${u}: users must be able to zoom`);
    assert.match(h, /<details class="dd right mobile-only"><summary class="iconlink" aria-label="Menu">/, `${u}: mobile menu`);
    assert.match(h, /<form class="msearch mobile-only" action="\/shop" role="search"><label class="sr" for="hq-m">Search<\/label>/, `${u}: labelled mobile search`);
    assert.match(h, /<input id="hq-m" name="q" type="search"/, `${u}: search input type`);
  }
});

test('photos reserve their space (width/height on every <img>) on shop, listing, storefront and dashboard pages', async () => {
  const seller = await H.newSeller('Pics'), buyer = await H.newUser('Pics');
  const id = await H.makeListing(seller);
  const avatar = await uploadSized(seller, 200, 200), banner = await uploadSized(seller, 1200, 300);
  assert.equal((await seller.put('/api/seller/storefront', { theme: 'light', accent: 'forest', layout: 'grid', sort: 'newest', avatar, banner, links: [], featured: [], showLocation: true })).status, 200);
  assert.equal((await seller.post('/api/seller/storefront/publish')).status, 200);
  const pages = [[buyer, '/'], [buyer, '/shop'], [buyer, `/listing/${id}`], [buyer, `/s/${seller.handle}`], [seller, '/dashboard/inventory'], [seller, '/dashboard']];
  let seen = 0;
  for (const [c, u] of pages) for (const tag of imgs(await html(c, u))) {
    seen++;
    assert.match(tag, /\swidth="\d+"/, `${u}: ${tag}`); assert.match(tag, /\sheight="\d+"/, `${u}: ${tag}`);
    assert.match(tag, /\salt="/, `${u}: alt text on ${tag}`);
  }
  assert.ok(seen >= 6, `expected photos on these pages, saw ${seen}`);
  const store = await html(buyer, `/s/${seller.handle}`);
  assert.match(store, /class="banner-img"[^>]*width="1200" height="300"/); assert.match(store, /class="avatar-img"[^>]*width="92" height="92"/);
});

test('sign-in and sign-up give phones the right keyboard and autofill (email, name, password)', async () => {
  const anon = new H.Client();
  const login = await html(anon, '/login'), reg = await html(anon, '/register');
  assert.match(login, /<input id="e" name="email" type="email" autocomplete="email"/);
  assert.match(login, /type="password"[^>]*autocomplete="current-password"|autocomplete="current-password"[^>]*type="password"/);
  assert.match(reg, /autocomplete="new-password"/);
  assert.match(reg, /name="display_name" autocomplete="name"/);
});

test('the inventory row actions use their own class: ".actions" is reserved for the header bar, which hides ghost buttons on phones', async () => {
  // regression: naming the row cell "actions" hid Edit/Duplicate/Delete on phones (header rule .actions .btn.ghost{display:none})
  const seller = await H.newSeller('Rows'); await H.makeListing(seller);
  const inv = await html(seller, '/dashboard/inventory');
  assert.match(inv, /<td class="row-actions nowrap"><a class="btn ghost small" href="\/dashboard\/listings\/\d+\/edit">Edit<\/a>/);
  const offenders = [];
  for (const dir of ['src', 'src/routes']) for (const f of fs.readdirSync(path.join(__dirname, '..', dir)).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8');
    for (const m of src.matchAll(/class="([^"$]*)"/g)) if (m[1].split(/\s+/).includes('actions')) offenders.push(`${dir}/${f}: class="${m[1]}"`);
  }
  assert.deepEqual(offenders.filter((o) => !o.startsWith('src/views.js')), [], 'only the header (src/views.js) may use class "actions"');
});

test('the storefront header is closed before the page body (unbalanced divs squeezed the store name to a sliver on phones)', async () => {
  const seller = await H.newSeller('Nest'), anon = new H.Client(); await H.makeListing(seller);
  for (const c of [anon, seller]) {   // visitor (Follow / Contact / Report) and owner (Customize) variants
    const h = await html(c, `/s/${seller.handle}`);
    const head = h.slice(h.indexOf('<div class="store-head">'), h.indexOf('<p class="small store-expect">'));
    assert.ok(head.length > 0, 'storefront header rendered');
    const opens = (head.match(/<div\b/g) || []).length, closes = (head.match(/<\/div>/g) || []).length;
    assert.equal(opens, closes, `store header must close its own divs (opened ${opens}, closed ${closes})`);
    assert.match(head, /<div class="store-head"><div class="store-id">[\s\S]*<\/div><\/div><\/div>\s*<div class="store-actions">[\s\S]*<\/div><\/div>/);
  }
});
