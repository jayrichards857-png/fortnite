'use strict';
// Real-browser journey for the private-beta direct-checkout model, on a throwaway empty DB (Playwright + Chromium).
// External sites (Stripe) are NEVER contacted: the /orders/:id/pay redirect is captured (Location header) and replaced by a stub page,
// so this verifies WHERE the buyer is sent, not that Stripe works.   node scripts/browser-beta.js [--screenshots]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { png } = require('./png');

const SHOTS = process.argv.includes('--screenshots'), OUT = path.resolve(__dirname, '..', 'artifacts', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-beta-')), PORT = 3430, B = `http://localhost:${PORT}`;
const photo = path.join(tmp, 'photo.png'); fs.writeFileSync(photo, png(300, 380, (x, y) => [120 + (y >> 5), 100, 90 + (x >> 4)]));
const server = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(PORT), PAIRPLUG_DB: path.join(tmp, 'b.db'), PAIRPLUG_UPLOADS: path.join(tmp, 'up'), RATE_LIMIT_SCALE: '100', PAYMENTS_MODE: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
const ready = new Promise((r) => server.stdout.on('data', (d) => String(d).includes('listening') && r(String(d))));
const step = (m) => console.log('•', m);
const LINK = 'https://buy.stripe.com/test_beta_journey_123';

(async () => {
  const banner = await ready; assert.match(banner, /checkout: external/); step('server up in direct-checkout mode: ' + banner.trim());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [], external = [];
  const mk = async (viewport = { width: 1280, height: 800 }, extra = {}) => {
    const ctx = await browser.newContext({ viewport, ...extra });
    // Capture exactly where PairPlug redirects the buyer (the Location header), then serve a stub instead of following it.
    await ctx.route('**/orders/*/pay', async (r) => { const resp = await r.fetch({ maxRedirects: 0 }); external.push(resp.headers().location || ''); await r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Stub of the seller checkout (external site not contacted)</h1>' }); });
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message)); return { ctx, pg };
  };
  const shot = async (pg, name) => { if (SHOTS) { fs.mkdirSync(OUT, { recursive: true }); await pg.screenshot({ path: path.join(OUT, name), fullPage: true }); } };
  try {
    const s = await mk(), b = await mk();
    // ---- seller: account, store, checkout settings
    await s.pg.goto(B + '/register'); await s.pg.fill('#n', 'Riley Reseller'); await s.pg.fill('#e', 'riley@example.test'); await s.pg.fill('#p', 'a-long-password-1');
    await Promise.all([s.pg.waitForURL(B + '/'), s.pg.click('button[type=submit]')]);
    await s.pg.goto(B + '/sell'); assert.match(await s.pg.textContent('main'), /no PairPlug fees/i); assert.doesNotMatch(await s.pg.textContent('main'), /escrow/i);
    await s.pg.fill('#sn', 'Riley Resale'); await s.pg.fill('#sh', 'riley'); await s.pg.fill('#sr', 'OR'); await s.pg.fill('#sy', 'Portland'); await s.pg.check('input[name=agree]');
    await Promise.all([s.pg.waitForURL(B + '/dashboard'), s.pg.click('button[type=submit]')]); step('seller onboarded (no fees/escrow language)');
    await s.pg.goto(B + '/dashboard/settings');
    await s.pg.fill('#cu', 'http://evil.example/pay'); await s.pg.click('button[type=submit]'); await s.pg.locator('.err').first().waitFor(); step('unsafe checkout link rejected: "' + (await s.pg.locator('.err').first().textContent()) + '"');
    await shot(s.pg, 'beta-01-seller-settings.png');

    // ---- seller: listing with photos, shipping terms and its own payment link
    await s.pg.goto(B + '/dashboard/listings/new');
    await s.pg.setInputFiles('[data-uploader=images] input[type=file]', photo); await s.pg.waitForSelector('.up-item');
    await s.pg.fill('#title', 'Heavyweight hoodie'); await s.pg.fill('#desc', 'Grey, worn a handful of times.'); await s.pg.selectOption('#cat', 'clothing'); await s.pg.fill('#brand', 'Harbor'); await s.pg.fill('#size', 'L'); await s.pg.selectOption('#cond', 'good');
    await s.pg.fill('#price', '48'); await s.pg.fill('#cost', '15'); await s.pg.fill('#w', '24');
    await s.pg.click('[data-save=active]'); await s.pg.locator('.err').first().waitFor(); step('publish blocked without payment link / shipping fee: "' + (await s.pg.locator('.form-err').first().textContent()).trim() + '"');
    await s.pg.fill('#ship', '7'); await s.pg.fill('#purl', 'https://evil.example/x'); await s.pg.click('[data-save=active]'); await s.pg.waitForSelector('.err'); step('non-allowlisted listing link rejected');
    await s.pg.fill('#purl', LINK);
    await Promise.all([s.pg.waitForURL(/\/listing\/\d+$/), s.pg.click('[data-save=active]')]); step('listing published: ' + s.pg.url());
    const listingUrl = s.pg.url(), listingId = listingUrl.split('/').pop();

    // ---- buyer: sees terms before leaving PairPlug
    await b.pg.goto(listingUrl);
    const lp = await b.pg.textContent('main');
    assert.match(lp, /\$55\.00/); assert.match(lp, /\$7\.00 flat fee, paid by the buyer/); assert.match(lp, /Buy now/); assert.doesNotMatch(lp, /escrow|Add to cart/i);
    step('listing shows item $48 + shipping $7 = total $55 and "Buy now"'); await shot(b.pg, 'beta-02-listing.png');
    await b.pg.click('a:has-text("Buy now")'); await b.pg.waitForURL(/\/login/);
    await b.pg.goto(B + '/register?next=/buy/' + listingId); await b.pg.fill('#n', 'Jordan Buyer'); await b.pg.fill('#e', 'jordan@example.test'); await b.pg.fill('#p', 'a-long-password-2');
    await b.pg.click('button[type=submit]'); await b.pg.waitForURL((u) => u.pathname.startsWith('/buy/')); step('anonymous buyer is sent to sign up, then back to the purchase page');
    assert.match(await b.pg.textContent('main'), /does not collect, hold or protect/); assert.match(await b.pg.textContent('main'), /Refunds, chargebacks and payment problems are handled by the seller/);
    await b.pg.fill('#a_name', 'Jordan Buyer'); await b.pg.fill('#a_line1', '1 Test Way'); await b.pg.fill('#a_city', 'Seattle'); await b.pg.fill('#a_region', 'WA'); await b.pg.fill('#a_postal', '98101');
    await b.pg.click('button:has-text("Reserve item")'); await b.pg.locator('.err, .form-err').first().waitFor(); step('purchase blocked until the payment-model acknowledgement is ticked');
    await shot(b.pg, 'beta-03-buy.png');
    await b.pg.check('#ack'); await Promise.all([b.pg.waitForURL(/\/orders\/\d+$/), b.pg.click('button:has-text("Reserve item")')]);
    const orderUrl = b.pg.url(); assert.match(await b.pg.textContent('h1'), /Awaiting payment confirmation/); step('order created and shown as "Awaiting payment confirmation" (NOT paid)');
    await shot(b.pg, 'beta-04-buyer-order-pending.png');

    // ---- buyer goes to the seller's checkout (stubbed); returning/claiming does not make it paid
    const [popup] = await Promise.all([b.ctx.waitForEvent('page'), b.pg.click('a:has-text("Go to seller checkout")')]);
    await popup.waitForLoadState(); const dest = new URL(external.at(-1));
    assert.equal(dest.origin, 'https://buy.stripe.com'); assert.equal(dest.pathname, '/test_beta_journey_123'); assert.equal(dest.searchParams.get('client_reference_id'), 'PP-' + orderUrl.split('/').pop());
    step('"Go to seller checkout" redirected to the seller\'s own link ' + dest.origin + dest.pathname + ' with reference ' + dest.searchParams.get('client_reference_id') + ' (external site not contacted)'); await popup.close();
    await b.pg.reload(); assert.match(await b.pg.textContent('h1'), /Awaiting payment confirmation/);
    await b.pg.click("button:has-text(\"I've completed payment\")"); await b.pg.locator('text=You told us you paid').waitFor(); assert.match(await b.pg.textContent('h1'), /Awaiting payment confirmation/); step('after "I\'ve completed payment" the order is STILL awaiting the seller\'s confirmation');
    await b.pg.goto(B + '/listing/' + listingId); assert.match(await b.pg.textContent('main'), /Reserved/); step('listing shows reserved to other buyers');
    await b.pg.goto(B + '/shop'); await b.pg.click('[data-chat-start]').catch(() => {});  // (shop cards have no chat button; chat is exercised below)

    // ---- seller: sees unconfirmed order, address hidden, confirms, ships
    await s.pg.goto(B + '/dashboard'); assert.match(await s.pg.textContent('main'), /awaiting your payment check/i);
    await s.pg.goto(B + '/dashboard/orders'); assert.match(await s.pg.textContent('tbody'), /Unconfirmed/);
    await s.pg.click('a:has-text("Confirm payment")'); await s.pg.waitForSelector('text=Confirm the payment');
    assert.doesNotMatch(await s.pg.textContent('main'), /1 Test Way/); step('seller order page: payment unconfirmed, shipping address hidden'); await shot(s.pg, 'beta-05-seller-order-confirm.png');
    await s.pg.fill('#pr', 'ch_test_123'); await s.pg.click('button:has-text("Payment received")'); await s.pg.waitForSelector('text=Ship the order');
    assert.match(await s.pg.textContent('main'), /1 Test Way/); step('after the SELLER confirmed, status is paid and the address is revealed');
    assert.match(await s.pg.textContent('main'), /does not<\/?[a-z]*>? buy labels|does not buy labels|does\s+not\s+buy/i);
    await s.pg.fill('#tn', '9400111899223344'); await s.pg.click('button:has-text("Mark shipped")'); await s.pg.waitForSelector('text=Shipped'); step('seller recorded carrier + tracking'); await shot(s.pg, 'beta-06-seller-order-shipped.png');
    await s.pg.goto(B + '/listing/' + listingId); assert.match(await s.pg.textContent('main'), /Sold/);

    // ---- buyer: tracking link, received, review; messaging
    await b.pg.goto(orderUrl); const href = await b.pg.getAttribute('a:has-text("Track package")', 'href'); assert.match(href, /^https:\/\/tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9400111899223344$/); step('buyer sees a safe tracking link: ' + href);
    await b.pg.click('button:has-text("Mark as received")'); await b.pg.waitForSelector('h1:has-text("Delivered")');
    await b.pg.click('button:has-text("Message the seller")'); await b.pg.waitForURL(/\/messages\/\d+/); await b.pg.locator('.conn span', { hasText: /Live · / }).first().waitFor({ timeout: 15000 }); step('"Message the seller" opens chat: "' + await b.pg.locator('#conn span').textContent() + '"');
    await b.pg.goto(orderUrl); await shot(b.pg, 'beta-07-buyer-order-delivered.png');
    await s.pg.goto(B + '/dashboard'); const dash = await s.pg.textContent('main'); assert.match(dash, /Direct checkout/); assert.match(dash, /PairPlug does not process these payments/); await shot(s.pg, 'beta-08-seller-dashboard.png');

    // ---- mobile viewport
    const m = await mk({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await m.pg.goto(listingUrl); assert.match(await m.pg.textContent('main'), /Buy now|Sold/);
    const overflow = async (pg) => pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok((await overflow(m.pg)) <= 1, 'listing page has no horizontal scroll on mobile'); await shot(m.pg, 'beta-09-mobile-listing.png');
    const login = await fetch(B + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'pairplug', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'jordan@example.test', password: 'a-long-password-2' }) });
    await m.ctx.addCookies([{ name: 'pp_session', value: login.headers.get('set-cookie').split(';')[0].split('=')[1], url: B }]);
    await m.pg.goto(orderUrl); assert.ok((await overflow(m.pg)) <= 1, 'order page has no horizontal scroll on mobile'); await shot(m.pg, 'beta-10-mobile-order.png');
    step('mobile viewport: no horizontal overflow');
    assert.ok(external.length >= 1 && external.every((u) => new URL(u).hostname === 'buy.stripe.com'), 'PairPlug only ever redirected to the seller\'s allowlisted checkout host');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('\nBROWSER BETA JOURNEY PASSED');
  } finally { await browser.close(); server.kill(); }
})().catch((e) => { console.error('\nBROWSER BETA JOURNEY FAILED:', e.message); server.kill(); process.exit(1); });
