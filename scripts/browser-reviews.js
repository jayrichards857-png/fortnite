'use strict';
// Real-browser journeys for: seller reviews (leave / report / moderate), the Contact page on a phone-sized screen, and the owner's Account Management page.
// Throwaway database, Stripe never contacted.   node scripts/browser-reviews.js
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright-core');
const { png } = require('./png');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rev-')), PORT = 3450, B = `http://localhost:${PORT}`, root = path.resolve(__dirname, '..');
const DB = path.join(tmp, 'r.db'), env = { ...process.env, PORT: String(PORT), PAIRPLUG_DB: DB, PAIRPLUG_UPLOADS: path.join(tmp, 'up'), CHECKOUT_MODE: 'external', SELLER_ONBOARDING: 'open', PAYMENTS_MODE: '' };
const ADMIN = { email: 'owner@example.test', pw: 'owner-passphrase-123' };
execFileSync(process.execPath, ['scripts/create-admin.js'], { cwd: root, env: { ...env, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.pw }, stdio: 'ignore' });
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = new Promise((r) => server.stdout.on('data', (d) => String(d).includes('listening') && r()));
const step = (m) => console.log('•', m);
const photoBuf = png(300, 380, (x, y) => [110 + (y >> 5), 100, 90 + (x >> 4)]);

(async () => {
  await ready;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];
  const mk = async (viewport = { width: 1280, height: 800 }) => { const ctx = await browser.newContext({ viewport }); const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message)); pg.on('dialog', (d) => d.accept()); return { ctx, pg }; };
  const api = async (ctx, method, url, data) => { const r = await ctx.request.fetch(B + url, { method, headers: { 'X-Requested-With': 'pairplug' }, data, failOnStatusCode: false }); let j = null; try { j = await r.json(); } catch {} return { status: r.status(), json: j }; };
  const upload = async (ctx) => (await ctx.request.fetch(B + '/api/uploads', { method: 'POST', headers: { 'X-Requested-With': 'pairplug', 'Content-Type': 'image/png' }, data: photoBuf })).json().then((j) => j.file);
  const login = async (pg, email, pw) => { await pg.goto(B + '/login'); await pg.fill('input[name=email]', email); await pg.fill('input[name=password]', pw); await Promise.all([pg.waitForURL((u) => !u.pathname.startsWith('/login')), pg.click('button[type=submit]')]); };
  const noOverflow = async (pg, label) => assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no horizontal overflow`);
  try {
    // ---- setup through the real API: a seller with a listing, a buyer with a delivered order
    const s = await mk(), b = await mk(), r2 = await mk(), mod = await mk(), adm = await mk();
    assert.equal((await api(s.ctx, 'POST', '/api/register', { email: 'seller@example.test', display_name: 'Sam Seller', password: 'a-long-password-1', terms: true })).status, 200);
    assert.equal((await api(s.ctx, 'POST', '/api/sell/onboard', { store_name: 'Sam Store', handle: 'samstore', country: 'US', region: 'OR', city: 'Portland', agree: true })).status, 200);
    const d = new DatabaseSync(DB); d.exec("UPDATE users SET email_verified_at = strftime('%s','now') WHERE handle = 'samstore'"); d.close();
    const l = await api(s.ctx, 'POST', '/api/seller/listings', { title: 'Vintage varsity jacket', description: 'Wool, size L', category: 'outerwear', brand: 'Champion', size: 'L', condition: 'good', price: '60.00', shipping: '8.00', weight_oz: '32', quantity: 2, images: [await upload(s.ctx)], status: 'active', payment_url: 'https://buy.stripe.com/test_rev_journey', payment_amount_ack: true });
    assert.equal(l.status, 200, JSON.stringify(l.json)); const listingId = l.json.id;
    assert.equal((await api(b.ctx, 'POST', '/api/register', { email: 'buyer@example.test', display_name: 'Bea Buyer', password: 'a-long-password-2', terms: true })).status, 200);
    const o = await api(b.ctx, 'POST', '/api/purchases', { listingId, acknowledged: true, address: { name: 'Bea Buyer', line1: '1 Main St', city: 'Austin', region: 'TX', postal: '78701', country: 'US' } }); const orderId = Number(String(o.json.redirect).match(/(\d+)/)[1]);
    assert.equal((await api(s.ctx, 'POST', `/api/seller/orders/${orderId}/confirm-payment`, {})).status, 200); assert.equal((await api(s.ctx, 'POST', `/api/seller/orders/${orderId}/ship`, { carrier: 'USPS', tracking: '9400111899223344' })).status, 200);
    { const dq = new DatabaseSync(DB); const row = dq.prepare('SELECT quantity, status FROM listings WHERE id = ?').get(listingId); dq.close(); assert.deepEqual({ ...row }, { quantity: 1, status: 'active' }); step('listing with quantity 2: one unit reserved by the order -> 1 left, still for sale'); }

    // ---- buyer leaves a review through the UI
    await b.pg.goto(B + `/orders/${orderId}`); await b.pg.click('button[data-post$="/received"]'); await b.pg.waitForLoadState('networkidle'); await b.pg.reload();
    assert.ok(await b.pg.locator('text=Leave a review').count(), 'review form appears once the order is received');
    await b.pg.check('input[name=thumbsUp]'); await b.pg.fill('textarea[name=body]', 'Great jacket <b>exactly</b> as described.'); await b.pg.click('#review button[type=submit]'); await b.pg.waitForSelector('text=Posted');
    step('buyer posted a thumbs-up review from the order page');
    // ---- the storefront shows counts, escaped text, "order-linked", and an honest line about payments
    const guest = await mk(); await guest.pg.goto(B + '/s/samstore');
    const body = await guest.pg.innerText('.reputation'); assert.match(body, /1\s*thumbs-up/); assert.match(body, /order-linked/i); assert.match(body, /not independently verified/); assert.match(body, /<b>exactly<\/b>/, 'markup shows as text, not as HTML');
    assert.equal(await guest.pg.locator('.reputation b').count(), 0, 'no injected bold element');
    // ---- someone else reports it from the store page
    assert.equal((await api(r2.ctx, 'POST', '/api/register', { email: 'other@example.test', display_name: 'Olly Other', password: 'a-long-password-3', terms: true })).status, 200);
    await r2.pg.goto(B + '/s/samstore'); await r2.pg.click('.reputation summary'); await r2.pg.fill('.reputation input[name=reason]', 'This looks like a friend of the seller'); await r2.pg.click('.reputation form button'); await r2.pg.waitForLoadState('networkidle');
    step('a second user reported the review');
    // ---- the owner creates a moderator through Account Management (UI, with the confirmation dialog)
    await login(adm.pg, ADMIN.email, ADMIN.pw); await adm.pg.goto(B + '/admin/accounts'); assert.match(adm.pg.url(), /\/admin\/accounts$/, 'admin page reachable: ' + adm.pg.url() + ' errors=' + errors.join('|'));
    await adm.pg.selectOption('#ar', 'moderator'); await adm.pg.fill('#ae', 'mod@example.test'); await adm.pg.fill('#an', 'Mo Derator'); await adm.pg.click('#acform button[type=submit]');
    await adm.pg.waitForSelector('#acout > div'); assert.ok(await adm.pg.locator('#acout .notice').count(), 'invite failed: ' + await adm.pg.innerText('#acout')); const setupLink = (await adm.pg.innerText('#acout p')).trim(); assert.match(setupLink, /\/moderator\/setup\/pp_mod_/);
    step('owner created a moderator setup link in the dashboard (shown once, not emailed)');
    // ---- the moderator sets up their own account and hides the review
    await mod.pg.goto(setupLink.replace(/^https?:\/\/[^/]+/, B)); assert.equal(await mod.pg.inputValue('input[name=display_name]'), 'Mo Derator', 'suggested name is pre-filled');
    await mod.pg.fill('input[name=password]', 'a-very-long-passphrase'); await mod.pg.check('input[name=terms]'); await Promise.all([mod.pg.waitForURL(B + '/moderation'), mod.pg.click('button[type=submit]')]);
    await mod.pg.goto(B + '/moderation/reviews'); assert.ok(await mod.pg.locator('text=This looks like a friend of the seller').count()); await mod.pg.fill('.revmod input[name=reason]', 'Reviewed the report: not an order experience'); await mod.pg.click('[data-act=hide]'); await mod.pg.waitForLoadState('networkidle');
    await guest.pg.goto(B + '/s/samstore'); assert.match(await guest.pg.innerText('.reputation'), /No reviews yet/, 'a hidden review stops showing and counting');
    await mod.pg.goto(B + '/moderation/reviews'); await mod.pg.fill('.revmod input[name=reason]', 'Checked again: it is genuine'); await mod.pg.click('[data-act=restore]'); await mod.pg.waitForLoadState('networkidle');
    await guest.pg.goto(B + '/s/samstore'); assert.match(await guest.pg.innerText('.reputation'), /1\s*thumbs-up/); step('moderator hid then restored the review with recorded reasons');
    // ---- a moderator can find and ban/unban a user in one flow
    await mod.pg.goto(B + '/moderation/users?q=Olly'); await mod.pg.click('text=Olly Other'); await mod.pg.fill('#mr', 'Test ban from the browser journey'); await mod.pg.click('[data-mod=ban]'); await mod.pg.waitForSelector('text=Account banned');
    assert.equal((await api(r2.ctx, 'POST', '/api/cases/seller', { handle: 'samstore', reason: 'banned users cannot do this' })).status, 401);
    await mod.pg.fill('#mr', 'Reversing the test ban'); await mod.pg.click('[data-mod=unban]'); await mod.pg.waitForSelector('text=Account unbanned'); await login(r2.pg, 'other@example.test', 'a-long-password-3'); step('ban enforced, unban restored access');

    // ---- Contact page on a phone-sized screen
    const ph = await mk({ width: 375, height: 700 }); await ph.pg.goto(B + '/contact'); await noOverflow(ph.pg, '/contact');
    assert.equal(await ph.pg.getAttribute('a.btn:has-text("Email us")', 'href'), 'mailto:pairplugservice@gmail.com?subject=PairPlug%20Support');
    assert.match(await ph.pg.getAttribute('a:has-text("Open Gmail")', 'href'), /^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=pairplugservice%40gmail\.com&su=PairPlug%20Support$/);
    assert.equal(await ph.pg.getAttribute('a:has-text("Open Gmail")', 'target'), '_blank');
    await ph.pg.click('a:has-text("Back to shopping")'); await ph.pg.waitForURL(B + '/shop'); await ph.pg.goto(B + '/login'); await ph.pg.click('a:has-text("Contact us")'); await ph.pg.waitForURL(B + '/contact');
    for (const p of ['/', '/shop', '/sellers', '/login', '/terms', '/s/samstore']) { await ph.pg.goto(B + p); await noOverflow(ph.pg, p); }
    await adm.pg.goto(B + '/admin/accounts'); await noOverflow(adm.pg, '/admin/accounts (desktop)');
    step('Contact page works on a 375px screen; its mailto and Gmail links are correct; no sent-email claims');
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
    console.log('\nBROWSER REVIEWS/MODERATION/CONTACT JOURNEY PASSED');
  } finally { await browser.close(); }
})().catch((e) => { console.error('\nBROWSER REVIEWS JOURNEY FAILED:', e.message); process.exitCode = 1; }).finally(() => { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
