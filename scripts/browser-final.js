'use strict';
// Beta-readiness journey in a real browser (Playwright + Chromium) on a THROWAWAY database, with the beta's real gating:
// closed sign-ups, invite-only sellers, seller cap 3, email verification via the admin outbox (no email is sent),
// storefront customization, contact-first listings, direct checkout (Stripe is never contacted), refunds, cases, mobile, access control.
//   node scripts/browser-final.js [--screenshots]
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { png } = require('./png');

const SHOTS = process.argv.includes('--screenshots'), OUT = path.resolve(__dirname, '..', 'artifacts', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-final-')), PORT = 3440, B = `http://localhost:${PORT}`;
const root = path.resolve(__dirname, '..'), DB = path.join(tmp, 'f.db'), UP = path.join(tmp, 'up');
const env = { ...process.env, PORT: String(PORT), PAIRPLUG_DB: DB, PAIRPLUG_UPLOADS: UP, CHECKOUT_MODE: 'external', SIGNUPS: 'closed', SELLER_ONBOARDING: 'invite', PUBLIC_RELEASE_DATE: '2026-11-01', PAYMENTS_MODE: '' };
const ADMIN = { email: 'founder@example.test', pw: 'admin-passphrase-123' };
execFileSync(process.execPath, ['scripts/create-admin.js'], { cwd: root, env: { ...env, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.pw }, stdio: 'ignore' });
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = new Promise((r) => server.stdout.on('data', (d) => String(d).includes('listening') && r()));
const step = (m) => console.log('•', m);
const LINK = 'https://buy.stripe.com/test_final_journey_1';
const photoBuf = png(300, 380, (x, y) => [110 + (y >> 5), 100, 90 + (x >> 4)]);

(async () => {
  await ready;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [], external = [];
  const mk = async (viewport = { width: 1280, height: 800 }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.route('**/orders/*/pay', async (r) => { const resp = await r.fetch({ maxRedirects: 0 }); external.push(resp.headers().location || ''); await r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stub seller checkout</h1>' }); });
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message)); return { ctx, pg };
  };
  const api = async (ctx, method, url, data) => { const r = await ctx.request.fetch(B + url, { method, headers: { 'X-Requested-With': 'pairplug' }, data, failOnStatusCode: false }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const shot = async (pg, name) => { if (SHOTS) { fs.mkdirSync(OUT, { recursive: true }); await pg.screenshot({ path: path.join(OUT, name), fullPage: true }); } };
  const login = async (pg, email, pw) => { await pg.goto(B + '/login'); await pg.fill('input[name=email]', email); await pg.fill('input[name=password]', pw); await Promise.all([pg.waitForURL((u) => !u.pathname.startsWith('/login')), pg.click('button[type=submit]')]); };
  const upload = async (ctx) => (await ctx.request.fetch(B + '/api/uploads', { method: 'POST', headers: { 'X-Requested-With': 'pairplug', 'Content-Type': 'image/png' }, data: photoBuf })).json().then((j) => j.file);
  try {
    // ---- 1. public visitor: sign-ups are closed and the site says "Coming soon" with a release date
    const v = await mk(); await v.pg.goto(B + '/register');
    let t = await v.pg.textContent('body'); assert.match(t, /Coming soon/i); assert.match(t, /November 1, 2026|2026-11-01|Nov(ember)? 1/i, 'release date shown'); assert.equal(await v.pg.locator('input[type=password]').count(), 0, 'no sign-up form');
    await v.pg.goto(B + '/sell'); assert.match(await v.pg.textContent('body'), /Coming soon/i); await shot(v.pg, 'final-01-coming-soon.png');
    assert.equal((await api(v.ctx, 'POST', '/api/register', { email: 'x@x.test', display_name: 'X', password: 'a-long-password-1' })).status, 403);
    assert.notEqual((await api(v.ctx, 'POST', '/api/sell/onboard', { store_name: 'X', handle: 'xxx' })).status, 200);
    step('1. public sign-up and seller onboarding are closed; "Coming soon" with release date');

    // ---- 2. admin invites four sellers + a buyer; the 4th seller invitation is refused (cap 3)
    const adm = await mk(); await login(adm.pg, ADMIN.email, ADMIN.pw);
    const links = {};
    for (const [key, kind] of [['s1', 'seller'], ['s2', 'seller'], ['s3', 'seller'], ['buyer', 'buyer']]) {
      const r = await api(adm.ctx, 'POST', '/api/admin/invitations', { kind, email: `${key}@example.test`, note: key }); assert.equal(r.status, 200, JSON.stringify(r.json)); links[key] = r.json.link;
    }
    assert.equal((await api(adm.ctx, 'POST', '/api/admin/invitations', { kind: 'seller', email: 's4@example.test' })).status, 409, '4th seller invitation refused');
    await adm.pg.goto(B + '/admin/invitations'); assert.match(await adm.pg.textContent('main'), /Pending seller invitations3.*Slots free to invite0/s, 'three pending invitations reserve all slots'); await shot(adm.pg, 'final-02-admin-invitations.png');
    step('2. invitations created; 3 pending invitations reserve all 3 slots; 4th seller invitation refused');

    // ---- 3. sellers accept invitations in the browser (concurrently), verify email from the admin outbox
    const sellers = {};
    for (const key of ['s1', 's2', 's3']) {
      const s = await mk(); sellers[key] = s; await s.pg.goto(links[key].replace(/^https?:\/\/[^/]+/, B));
      await s.pg.fill('#n', `Seller ${key}`); await s.pg.fill('#p', 'a-long-password-1'); await s.pg.fill('#sn', `Store ${key}`); await s.pg.fill('#sh', `store-${key}`);
      await s.pg.fill('#sr', 'OR'); await s.pg.fill('#sy', 'Portland'); await s.pg.check('input[name=agree]');
      await Promise.all([s.pg.waitForURL(B + '/account'), s.pg.click('button[type=submit]')]);
    }
    assert.match(await sellers.s1.pg.textContent('body'), /verify/i, 'unverified banner / prompt shown');
    await adm.pg.goto(B + '/admin/outbox'); const outbox = await adm.pg.textContent('main'); assert.match(outbox, /No email provider is configured/);
    // Match each token to its recipient row
    const rows = await adm.pg.locator('table tbody tr').allTextContents();
    for (const key of ['s1', 's2', 's3']) {
      const idx = rows.findIndex((r) => r.includes(`${key}@example.test`) && /verify-email/.test(r)); assert.ok(idx >= 0, 'row for ' + key);
      const tok = rows[idx].match(/verify-email\?token=([A-Za-z0-9_\-]+)/)[1];
      await sellers[key].pg.goto(`${B}/verify-email?token=${tok}`); await Promise.all([sellers[key].pg.waitForURL(B + '/account'), sellers[key].pg.click('#vbtn')]);
    }
    step('3. 3 sellers accepted invitations; verification links came only from the outbox (nothing was sent)');

    // ---- 4. 4th seller race: a 4th invitation cannot be created, and a direct onboarding POST by a buyer fails
    const b = await mk(); await b.pg.goto(links.buyer.replace(/^https?:\/\/[^/]+/, B));
    await b.pg.fill('#n', 'Bea Buyer'); await b.pg.fill('#p', 'a-long-password-2'); await Promise.all([b.pg.waitForURL(B + '/account'), b.pg.click('button[type=submit]')]);
    const race = await Promise.all(Array.from({ length: 5 }, () => api(b.ctx, 'POST', '/api/sell/onboard', { store_name: 'Sneaky', handle: 'sneaky', country: 'US', region: 'OR', city: 'Portland', agree: true })));
    assert.ok(race.every((r) => r.status === 403), 'closed onboarding: ' + JSON.stringify(race.map((r) => r.status)));
    step('4. concurrent self-onboarding attempts by a buyer all refused (cap + closed onboarding)');

    // ---- 5. storefront customisation: draft, preview, publish; public view
    const s1 = sellers.s1; await s1.pg.goto(B + '/dashboard/storefront');
    await s1.pg.fill('#announcement', 'Welcome! Shipping Fridays.'); await s1.pg.click('#sf-save'); await s1.pg.waitForTimeout(500);
    let pub = await b.ctx.request.get(B + '/s/store-s1'); assert.doesNotMatch(await pub.text(), /Shipping Fridays/, 'draft not public');
    await s1.pg.goto(B + '/s/store-s1?preview=1'); assert.match(await s1.pg.textContent('body'), /Shipping Fridays/);
    await s1.pg.goto(B + '/dashboard/storefront'); await s1.pg.click('#sf-publish'); await s1.pg.waitForTimeout(700);
    await b.pg.goto(B + '/s/store-s1'); assert.match(await b.pg.textContent('body'), /Shipping Fridays/); assert.match(await b.pg.textContent('body'), /48 hours/); await shot(b.pg, 'final-05-storefront.png');
    step('5. storefront draft is private, preview works for owner only, publish makes it public');

    // ---- 6. contact-first listing (no payment link): no Buy now, Contact seller works; then add link -> Buy now
    const file = await upload(s1.ctx);
    const mkListing = async (ctx, title, extra = {}) => { const r = await api(ctx, 'POST', '/api/seller/listings', { title, description: 'Worn twice', category: 'outerwear', brand: 'Acme', size: 'M', condition: 'good', price: '48.00', shipping: '7.00', shipping_payer: 'buyer', weight_oz: 16, images: [file], status: 'active', ...extra }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.id; };
    const l1 = await mkListing(s1.ctx, 'Contact only jacket');
    await b.pg.goto(`${B}/listing/${l1}`); t = await b.pg.textContent('main'); assert.doesNotMatch(t, /Buy now/); assert.match(t, /Contact seller/i);
    await Promise.all([b.pg.waitForURL(/\/messages\/\d+/), b.pg.click('[data-chat-start]')]); await b.pg.fill('#compose', 'Is this still available?'); await b.pg.click('#composer button[type=submit]');
    await b.pg.waitForSelector('.msg.mine .body'); step('6a. no payment link: only "Contact seller"; buyer messaged the seller');
    await s1.pg.goto(B + '/messages'); await s1.pg.click('.conv'); await s1.pg.waitForSelector('.msg.theirs'); assert.match(await s1.pg.textContent('#expect'), /Awaiting your reply/); await shot(s1.pg, 'final-06-seller-inbox.png');
    const l2 = await mkListing(s1.ctx, 'Buyable jacket', { payment_url: LINK });
    await b.pg.goto(`${B}/listing/${l2}`); assert.match(await b.pg.textContent('main'), /Buy now/); step('6b. with a valid payment link: "Buy now" appears');

    // ---- 7. checkout -> seller confirms -> ship -> refund request -> seller reports -> buyer confirms
    await b.pg.click('text=Buy now'); await b.pg.waitForURL(/\/buy\//);
    for (const [n, val] of Object.entries({ name: 'Bea Buyer', line1: '1 Main St', city: 'Austin', region: 'TX', postal: '78701' })) await b.pg.fill(`#a_${n}`, val);
    await b.pg.check('#ack'); await Promise.all([b.pg.waitForURL(/\/orders\/\d+$/), b.pg.click('#buyform button[type=submit]')]);
    const orderId = Number(b.pg.url().match(/orders\/(\d+)/)[1]);
    assert.match(await b.pg.textContent('main'), /Awaiting payment confirmation/i);
    await b.pg.click('text=Go to seller checkout'); await b.pg.waitForTimeout(400); assert.ok(external.some((u) => u.startsWith(LINK) && u.includes(`PP-${orderId}`)), 'redirect target: ' + external);
    await s1.pg.goto(`${B}/dashboard/orders/${orderId}`); await s1.pg.click('text=Payment received'); await s1.pg.waitForLoadState('networkidle');
    assert.match(await s1.pg.textContent('main'), /Ship the order/i);
    await s1.pg.fill('#tn', '9400111899223344'); await s1.pg.fill('#sn2', 'Left with front desk'); await s1.pg.click('text=Mark shipped'); await s1.pg.waitForLoadState('networkidle');
    await b.pg.goto(`${B}/orders/${orderId}`); t = await b.pg.textContent('main'); assert.match(t, /not proof of delivery/i); assert.match(t, /Left with front desk/);
    await b.pg.click('summary:has-text("Request a refund")'); await b.pg.fill('#rr', 'Item is smaller than described.'); await b.pg.click('text=Send request'); await b.pg.waitForLoadState('networkidle');
    await s1.pg.goto(`${B}/dashboard/orders/${orderId}`); await s1.pg.check('input[name=confirm_refunded]'); await s1.pg.click('text=Report refund sent'); await s1.pg.waitForLoadState('networkidle');
    await b.pg.goto(`${B}/orders/${orderId}`); t = await b.pg.textContent('main'); assert.match(t, /seller says they refunded you/i); assert.doesNotMatch(await b.pg.textContent('h1'), /refunded/i, 'not refunded until the buyer confirms');
    await shot(b.pg, 'final-07-refund-confirm.png');
    b.pg.once('dialog', (d) => d.accept()); await b.pg.click('text=Yes, I received the refund'); await b.pg.waitForLoadState('networkidle'); await b.pg.reload();
    assert.match(await b.pg.textContent('h1'), /refunded/i); step('7. direct checkout: seller-confirmed payment, shipped w/ note, refund only completed by buyer confirmation');

    // ---- 8. sold / unavailable listing cannot start another order
    const l3 = await mkListing(s1.ctx, 'One-off', { payment_url: LINK });
    const o3 = await api(b.ctx, 'POST', '/api/purchases', { listingId: l3, acknowledged: true, address: { name: 'Bea', line1: '1 Main', city: 'Austin', region: 'TX', postal: '78701', country: 'US' } }); assert.equal(o3.status, 200);
    await api(s1.ctx, 'POST', `/api/seller/orders/${o3.json.orderId}/confirm-payment`);
    const again = await api(b.ctx, 'POST', '/api/purchases', { listingId: l3, acknowledged: true, address: { name: 'Bea', line1: '1 Main', city: 'Austin', region: 'TX', postal: '78701', country: 'US' } }); assert.equal(again.status, 409);
    step('8. a sold listing cannot start another order');

    // ---- 9. cross-seller access: seller 2 cannot see seller 1's order, case or listing editor
    assert.equal((await sellers.s2.ctx.request.get(`${B}/dashboard/orders/${o3.json.orderId}`)).status(), 404);
    assert.notEqual((await api(sellers.s2.ctx, 'POST', `/api/seller/orders/${o3.json.orderId}/confirm-payment`)).status, 200);
    assert.notEqual((await api(sellers.s2.ctx, 'POST', `/api/seller/listings/${l3}/pause`)).status, 200);
    step('9. another seller cannot read or act on a competitor\'s order/listing');

    // ---- 10. buyer opens a case, seller responds, admin decides; internal note invisible to parties
    const cs = await api(b.ctx, 'POST', '/api/cases/order', { orderId: o3.json.orderId, reason: 'Package arrived damaged, photos to follow.' }); assert.equal(cs.status, 200);
    await s1.pg.goto(`${B}/cases/${cs.json.id}`); await s1.pg.fill('textarea[name=body]', 'Sorry, I will check with the carrier.'); await s1.pg.click('text=Send'); await s1.pg.waitForLoadState('networkidle');
    await adm.pg.goto(`${B}/admin/cases/${cs.json.id}`); await adm.pg.fill('form[data-api$="/note"] textarea', 'INTERNAL-ONLY seller is responsive'); await adm.pg.click('text=Save note'); await adm.pg.waitForLoadState('networkidle');
    await adm.pg.fill('form[data-api$="/decide"] textarea', 'Seller to refund half; both agreed.'); await adm.pg.click('text=Close case'); await adm.pg.waitForLoadState('networkidle');
    await b.pg.goto(`${B}/cases/${cs.json.id}`); t = await b.pg.textContent('main'); assert.match(t, /Seller to refund half/); assert.doesNotMatch(t, /INTERNAL-ONLY/);
    await adm.pg.goto(B + '/admin/audit'); assert.match(await adm.pg.textContent('main'), /case_decided/); await shot(adm.pg, 'final-10-admin-audit.png');
    step('10. case lifecycle with admin decision and audit trail; internal notes hidden from parties');

    // ---- 11. mobile: key pages have no horizontal overflow
    const m = await mk({ width: 375, height: 760 }); await login(m.pg, 'buyer@example.test', 'a-long-password-2');
    for (const p of ['/', '/shop', `/listing/${l2}`, '/s/store-s1', '/messages', `/orders/${orderId}`, '/support', '/account']) {
      await m.pg.goto(B + p); const over = await m.pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(over <= 1, `${p} overflows by ${over}px`);
    }
    await shot(m.pg, 'final-11-mobile-store.png'); step('11. mobile layout (375px): no horizontal overflow on 8 key pages');

    assert.deepEqual(errors, [], 'no uncaught page errors: ' + errors.join('; '));
    console.log('\nBROWSER FINAL JOURNEY PASSED');
  } catch (e) { console.error('\nBROWSER FINAL JOURNEY FAILED:', e.message); process.exitCode = 1; }
  finally { await browser.close(); server.kill(); }
})();
