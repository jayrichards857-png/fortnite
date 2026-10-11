'use strict';
// Real-browser end-to-end journey on a brand-new empty database (Playwright + Chromium):
// seller registers → onboards → uploads photo → publishes via the editor → buyer finds it via search →
// adds to cart → checks out → sandbox pay → sees order → seller ships → buyer confirms → seller balance updates.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { png } = require('./png');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-journey-'));
const photo = path.join(tmp, 'photo.png'); fs.writeFileSync(photo, png(300, 380, (x, y) => [90 + (x >> 3), 110, 100 + (y >> 4)]));
const PORT = 3410, B = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(PORT), PAIRPLUG_DB: path.join(tmp, 'j.db'), PAIRPLUG_UPLOADS: path.join(tmp, 'up'), PAYMENTS_MODE: 'sandbox', CHECKOUT_MODE: 'platform', RATE_LIMIT_SCALE: '100' }, stdio: ['ignore', 'pipe', 'inherit'] });
const ready = new Promise((r) => server.stdout.on('data', (d) => String(d).includes('listening') && r()));

const step = (m) => console.log('•', m);
(async () => {
  await ready;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  try {
    const sctx = await browser.newContext(), s = await sctx.newPage();
    const errors = []; s.on('pageerror', (e) => errors.push(e.message));
    await s.goto(B + '/register'); await s.fill('#n', 'Riley Seller'); await s.fill('#e', 'riley@example.test'); await s.fill('#p', 'a-long-password-1');
    await Promise.all([s.waitForURL(B + '/'), s.click('button[type=submit]')]); step('seller registered');
    await s.goto(B + '/sell'); await s.fill('#sn', 'Riley Resale'); await s.fill('#sh', 'riley'); await s.fill('#sr', 'OR'); await s.fill('#sy', 'Portland'); await s.check('input[name=agree]');
    await Promise.all([s.waitForURL(B + '/dashboard'), s.click('button[type=submit]')]); step('seller onboarded → dashboard');
    require('./verify-email-helper')(path.join(tmp, 'j.db'));
    assert.match(await s.textContent('body'), /No orders yet/); // honest empty state

    await s.goto(B + '/dashboard/listings/new');
    // validation: publishing an empty form shows server errors and no success toast
    await s.click('[data-save=active]'); await s.waitForSelector('.form-err'); assert.match(await s.textContent('.form-err'), /fix the highlighted/); step('empty publish rejected with field errors');
    await s.setInputFiles('[data-uploader=images] input[type=file]', photo); await s.waitForSelector('.up-item');
    await s.fill('#title', 'Corduroy chore coat'); await s.fill('#desc', 'Brown corduroy, two chest pockets.'); await s.selectOption('#cat', 'outerwear');
    await s.fill('#brand', 'Test Brand'); await s.fill('#size', 'M'); await s.selectOption('#cond', 'good'); await s.fill('#price', '60'); await s.fill('#ship', '8'); await s.fill('#cost', '20'); await s.fill('#w', '28');
    await s.waitForSelector('#payout strong'); step('payout preview: ' + (await s.textContent('#payout')).replace(/\s+/g, ' '));
    await Promise.all([s.waitForURL(/\/listing\/\d+$/), s.click('[data-save=active]')]); step('published → listing page ' + s.url());
    assert.match(await s.textContent('h1'), /Corduroy chore coat/);

    const bctx = await browser.newContext(), b = await bctx.newPage(); b.on('pageerror', (e) => errors.push(e.message));
    await b.goto(B + '/'); assert.match(await b.textContent('.grid'), /Corduroy chore coat/);
    await b.fill('#hq2', 'chore'); await Promise.all([b.waitForURL(/\/shop\?q=chore/), b.click('.hero button')]);
    assert.match(await b.textContent('.grid'), /Corduroy chore coat/); step('buyer search finds the listing');
    await b.goto(B + '/shop?q=chore&max=10'); assert.match(await b.textContent('main'), /No matching items/); step('price filter excludes it');
    await b.goto(B + '/shop?q=chore&category=outerwear&condition=good&min=50&max=70'); await Promise.all([b.waitForURL(/\/listing\//), b.click('.card .title')]);
    await b.click('[data-cart-add]:has-text("Add to cart")'); await b.waitForURL(/\/login/); step('anonymous add-to-cart redirects to login');
    await b.goto(B + '/register'); await b.fill('#n', 'Jordan Buyer'); await b.fill('#e', 'jordan@example.test'); await b.fill('#p', 'a-long-password-2');
    await Promise.all([b.waitForURL(B + '/'), b.click('button[type=submit]')]);
    await b.goto(B + '/shop?q=chore'); await Promise.all([b.waitForURL(/\/listing\//), b.click('.card .title')]);
    await Promise.all([b.waitForURL(B + '/cart'), b.click('[data-cart-add][data-buy]')]);
    assert.match(await b.textContent('.summary-row.total'), /\$68\.00/); step('cart total $68.00 (60 + 8 shipping)');
    await b.click('a:has-text("Checkout")'); await b.waitForSelector('#ckform');
    await b.fill('#a_name', 'Jordan Buyer'); await b.fill('#a_line1', '1 Test Way'); await b.fill('#a_city', 'Seattle'); await b.fill('#a_region', 'WA'); await b.fill('#a_postal', '98101');
    await Promise.all([b.waitForURL(/\/pay\/\d+/), b.click('#ckform button')]); step('checkout created, redirected to sandbox payment');
    await Promise.all([b.waitForURL(/\/checkout\/\d+/), b.click('button:has-text("Pay")')]);
    await b.waitForSelector('h1:has-text("Order confirmed")'); step('payment webhook processed → order confirmed');
    await b.goto(B + '/orders'); assert.match(await b.textContent('tbody'), /paid/i); step('buyer order list shows paid order');

    await s.goto(B + '/dashboard/orders'); await s.fill('input[name=tracking]', '9400111899223344'); await s.click('button:has-text("Mark shipped")'); await s.waitForSelector('td:has-text("9400111899223344")');
    await s.goto(B + '/dashboard'); assert.match(await s.textContent('body'), /In escrow/); step('seller shipped; funds still in escrow');
    await b.goto(B + '/orders/1'); await b.click('button:has-text("Confirm receipt")'); await b.waitForSelector('h1 .s-released'); step('buyer confirmed receipt → released');
    await s.goto(B + '/dashboard'); const t = await s.textContent('body'); assert.match(t, /Completed sales/); await s.goto(B + '/dashboard/finance');
    assert.match(await s.textContent('body'), /Available to withdraw/); step('seller finance page: ' + (await s.textContent('.stat .v')));
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('\nBROWSER JOURNEY PASSED');
  } finally { await browser.close(); server.kill(); }
})().catch((e) => { console.error('\nBROWSER JOURNEY FAILED:', e.message); server.kill(); process.exit(1); });
