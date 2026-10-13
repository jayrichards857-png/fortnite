'use strict';
// Chat as it runs on a serverless host (Vercel): no WebSocket, the real client polls the database-backed sync endpoint every CHAT_POLL_MS.
// Two real Chromium browsers on a throwaway DB.   node scripts/browser-chat-polling.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { png } = require('./png');

const SHOTS = process.argv.includes('--screenshots'), OUT = path.resolve(__dirname, '..', 'artifacts', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chatpoll-')), PORT = 3421, B = `http://localhost:${PORT}`;
const fresh = require('../test/testdb').createSync(), dropFresh = () => require('../test/testdb').dropSync(fresh.name);   // own empty PostgreSQL database for this run
const server = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, SELLER_ONBOARDING: 'open', CHAT_POLL_MS: '1000', PORT: String(PORT), DATABASE_URL: fresh.url, PAIRPLUG_UPLOADS: path.join(tmp, 'up'), PAYMENTS_MODE: 'sandbox', CHECKOUT_MODE: 'platform', RATE_LIMIT_SCALE: '100' }, stdio: ['ignore', 'pipe', 'inherit'] });
const ready = new Promise((r) => server.stdout.on('data', (d) => String(d).includes('listening') && r()));
const step = (m) => console.log('•', m);

async function api(cookie, method, url, body, raw) {
  const res = await fetch(B + url, { method, headers: { 'X-Requested-With': 'pairplug', cookie: cookie || '', 'Content-Type': raw || 'application/json' }, body: raw ? body : body && JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
  return { cookie: sc ? sc.split(';')[0] : cookie, json };
}
const cookieObj = (c) => { const [name, value] = c.split('='); return { name, value, url: B }; };

(async () => {
  await ready;
  // --- data via the real API (throwaway DB) ---
  let s = await api('', 'POST', '/api/register', { email: 'sam@example.test', display_name: 'Sam Seller', terms: true, password: 'a-long-password-1' });
  const sellerCookie = (await api(s.cookie, 'POST', '/api/sell/onboard', { store_name: 'Sam Resale', handle: 'samresale', country: 'US', region: 'OR', city: 'Portland', agree: true, terms: true })).cookie || s.cookie;
  await require('./verify-email-helper')(fresh.url);
  const file = (await api(sellerCookie, 'POST', '/api/uploads', png(240, 300, (x, y) => [150 - (y >> 4), 120, 90 + (x >> 4)]), 'image/png')).json.file;
  const listing = (await api(sellerCookie, 'POST', '/api/seller/listings', { title: 'Waxed field jacket', category: 'outerwear', brand: 'Test', size: 'M', condition: 'good', price: '95', shipping: '9', weight_oz: '40', images: [file], status: 'active' })).json.id;
  const b = await api('', 'POST', '/api/register', { email: 'bea@example.test', display_name: 'Bea Buyer', terms: true, password: 'a-long-password-2' });

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];
  const mk = async (cookie, opts = {}) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts }); await ctx.addCookies([cookieObj(cookie)]); const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message)); return { ctx, pg }; };
  const label = (pg) => pg.locator('#conn span').textContent();
  const bodies = (pg) => pg.locator('#msgs .bubble .body').allTextContents();
  let wsOpened = false;
  try {
    const buyer = await mk(b.cookie), seller = await mk(sellerCookie);
    for (const x of [buyer, seller]) x.pg.on('websocket', () => { wsOpened = true; });
    await seller.pg.goto(B + '/messages'); await seller.pg.locator('#conn span').filter({ hasText: /refreshes every 1s/ }).waitFor({ timeout: 15000 }); step('seller inbox: "' + await label(seller.pg) + '"');
    await buyer.pg.goto(B + '/listing/' + listing); await Promise.all([buyer.pg.waitForURL(/\/messages\/\d+/), buyer.pg.click('[data-chat-start]')]);
    await buyer.pg.locator('#conn span').filter({ hasText: /refreshes every 1s/ }).waitFor({ timeout: 15000 });
    await buyer.pg.fill('#compose', 'Is the jacket still available?'); await buyer.pg.keyboard.press('Enter');
    await buyer.pg.locator('#msgs .msg.mine:not(.pending)').first().waitFor(); step('buyer message acknowledged');
    await seller.pg.locator('.conv.unread').waitFor({ timeout: 10000 }); step('seller sees it WITHOUT reloading (found by polling): "' + (await seller.pg.textContent('.conv')).replace(/\s+/g, ' ') + '"');
    await seller.pg.click('.conv'); await seller.pg.locator('#msgs .msg.theirs').waitFor();
    assert.deepEqual(await bodies(seller.pg), ['Is the jacket still available?']);
    await seller.pg.fill('#compose', 'Yes, ships Friday.'); await seller.pg.keyboard.press('Enter');
    await buyer.pg.locator('#msgs .msg.theirs .body', { hasText: 'Yes, ships Friday.' }).waitFor({ timeout: 10000 }); step('reply reached the buyer by polling');
    await buyer.pg.locator('.receipt', { hasText: 'Seen' }).waitFor({ timeout: 10000 }); step('read receipt delivered');
    assert.equal(wsOpened, false, 'no WebSocket was ever opened in polling mode');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('\nBROWSER CHAT POLLING TEST PASSED');
  } finally { await browser.close(); server.kill(); dropFresh(); }
})().catch((e) => { console.error('\nBROWSER CHAT POLLING TEST FAILED:', e.message); server.kill(); dropFresh(); process.exit(1); });
