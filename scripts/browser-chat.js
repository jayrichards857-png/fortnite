'use strict';
// Two real Chromium browsers chatting through the real client (public/chat.js) on a throwaway DB.
//   node scripts/browser-chat.js [--screenshots]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { png } = require('./png');

const SHOTS = process.argv.includes('--screenshots'), OUT = path.resolve(__dirname, '..', 'artifacts', 'screenshots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chat-')), PORT = 3420, B = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, SELLER_ONBOARDING: 'open', PORT: String(PORT), PAIRPLUG_DB: path.join(tmp, 'c.db'), PAIRPLUG_UPLOADS: path.join(tmp, 'up'), PAYMENTS_MODE: 'sandbox', CHECKOUT_MODE: 'platform', RATE_LIMIT_SCALE: '100' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  require('./verify-email-helper')(path.join(tmp, 'c.db'));
  const file = (await api(sellerCookie, 'POST', '/api/uploads', png(240, 300, (x, y) => [150 - (y >> 4), 120, 90 + (x >> 4)]), 'image/png')).json.file;
  const listing = (await api(sellerCookie, 'POST', '/api/seller/listings', { title: 'Waxed field jacket', category: 'outerwear', brand: 'Test', size: 'M', condition: 'good', price: '95', shipping: '9', weight_oz: '40', images: [file], status: 'active' })).json.id;
  const b = await api('', 'POST', '/api/register', { email: 'bea@example.test', display_name: 'Bea Buyer', terms: true, password: 'a-long-password-2' });

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];
  const mk = async (cookie, opts = {}) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts }); await ctx.addCookies([cookieObj(cookie)]); const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message)); return { ctx, pg }; };
  const conn = (pg) => pg.locator('#conn span').textContent();
  const waitConn = (pg, re, timeout = 15000) => pg.locator('#conn span').filter({ hasText: re }).waitFor({ timeout });
  const bodies = (pg) => pg.locator('#msgs .bubble .body').allTextContents();

  try {
    const buyer = await mk(b.cookie), seller = await mk(sellerCookie);
    // seller has the inbox open BEFORE any conversation exists
    await seller.pg.goto(B + '/messages'); await waitConn(seller.pg, /Live · WebSocket/); step('seller inbox connected: "' + await conn(seller.pg) + '"');
    assert.match(await seller.pg.textContent('#conv-list'), /No conversations yet/);

    // 1. buyer messages the seller from the product page
    await buyer.pg.goto(B + '/listing/' + listing); await Promise.all([buyer.pg.waitForURL(/\/messages\/\d+/), buyer.pg.click('[data-chat-start]')]);
    await waitConn(buyer.pg, /Live · WebSocket/); step('buyer opened conversation from listing; transport label: "' + await conn(buyer.pg) + '"');
    assert.match(await buyer.pg.textContent('#chat-listing'), /Waxed field jacket/);
    await buyer.pg.fill('#compose', 'Hi! Is the jacket still available?\nI am a size M.'); await buyer.pg.keyboard.press('Enter');
    await buyer.pg.locator('#msgs .msg.mine:not(.pending)').first().waitFor(); step('buyer message acknowledged by the server');

    // 2. live delivery to the seller (no reload) with unread badge
    await seller.pg.locator('.conv.unread').waitFor({ timeout: 8000 }); step('seller sees live unread conversation: "' + (await seller.pg.textContent('.conv')).replace(/\s+/g, ' ') + '"');
    assert.equal((await seller.pg.textContent('#hdr-msg-badge')).trim(), '1');
    await seller.pg.click('.conv'); await seller.pg.locator('#msgs .msg.theirs').waitFor();
    assert.deepEqual(await bodies(seller.pg), ['Hi! Is the jacket still available?\nI am a size M.']);
    await buyer.pg.locator('.receipt', { hasText: 'Seen' }).waitFor({ timeout: 8000 }); step('buyer sees read receipt "Seen"');
    assert.equal(await seller.pg.locator('.conv .badge-inline').count(), 0);

    // 3. typing indicator + reply
    await seller.pg.locator('#compose').pressSequentially('Yes, it is', { delay: 30 });
    await buyer.pg.locator('#typing', { hasText: 'is typing' }).waitFor({ timeout: 6000 }); step('buyer sees typing indicator: "' + await buyer.pg.textContent('#typing') + '"');
    await seller.pg.keyboard.press('Enter');
    await buyer.pg.locator('#msgs .msg.theirs .body', { hasText: 'Yes, it is' }).waitFor({ timeout: 8000 }); step('reply delivered live to buyer');
    if (SHOTS) { fs.mkdirSync(OUT, { recursive: true }); await buyer.pg.screenshot({ path: path.join(OUT, '18-chat-desktop-thread.png') }); }

    // 4. offline: buyer's network drops → honest state, message is queued, then delivered once, after reconnect
    await buyer.ctx.setOffline(true);
    await waitConn(buyer.pg, /Reconnecting|Offline/); step('buyer offline → label: "' + await conn(buyer.pg) + '"');
    await buyer.pg.fill('#compose', 'Sent while offline'); await buyer.pg.keyboard.press('Enter');
    await buyer.pg.locator('.msg.pending .receipt', { hasText: 'Waiting for connection' }).waitFor(); step('offline message shown as queued, not sent');
    await seller.pg.fill('#compose', 'Missed while you were away'); await seller.pg.keyboard.press('Enter');
    await buyer.ctx.setOffline(false);
    await waitConn(buyer.pg, /Live · /); step('buyer back online → label: "' + await conn(buyer.pg) + '"');
    await buyer.pg.locator('#msgs .msg.theirs .body', { hasText: 'Missed while you were away' }).waitFor({ timeout: 10000 });
    await buyer.pg.locator('.msg.pending').waitFor({ state: 'detached', timeout: 10000 });
    await seller.pg.locator('#msgs .msg.theirs .body', { hasText: 'Sent while offline' }).waitFor({ timeout: 10000 });
    const bb = await bodies(buyer.pg); assert.equal(bb.filter((x) => x === 'Sent while offline').length, 1, 'no duplicate after retry'); step('queued message delivered exactly once; missed message recovered');

    // 5. reload recovery (also with an unsent message surviving in localStorage)
    await buyer.pg.reload(); await waitConn(buyer.pg, /Live · /);
    await buyer.pg.locator('#msgs .msg').nth(3).waitFor(); assert.equal((await bodies(buyer.pg)).length, 4); step('reload restored full history (4 messages)');

    // 6. forced long-polling is labelled as polling and still live
    const poll = await mk(b.cookie); await poll.pg.goto(B + '/messages/1?transport=polling');
    await waitConn(poll.pg, /Live · long-polling/); const label = await conn(poll.pg); assert.doesNotMatch(label, /WebSocket/); step('polling client label: "' + label + '"');
    await seller.pg.fill('#compose', 'ping over polling'); await seller.pg.keyboard.press('Enter');
    await poll.pg.locator('#msgs .msg.theirs .body', { hasText: 'ping over polling' }).waitFor({ timeout: 8000 }); step('message delivered live to the long-polling client');

    // 7. WebSocket blocked (simulated proxy) → automatic fallback to polling with an honest label
    const blocked = await mk(b.cookie); await blocked.ctx.routeWebSocket(/\/api\/chat\/ws/, (ws) => ws.close()); // simulates a proxy that kills WebSocket connections
    await blocked.pg.goto(B + '/messages/1'); await waitConn(blocked.pg, /Live · long-polling \(WebSocket unavailable\)/); step('WebSocket blocked → fell back: "' + await conn(blocked.pg) + '"');

    // 8. signed out elsewhere → auth error state, composer disabled
    await api(b.cookie, 'POST', '/api/logout');
    await waitConn(poll.pg, /Signed out/, 30000); // a long-poll already being held notices on its next wake-up (≤20s) assert.equal(await poll.pg.locator('#composer button').isDisabled(), true); step('after logout the polling client shows: "' + await conn(poll.pg) + '"');
    await buyer.pg.fill('#compose', 'x'); await buyer.pg.keyboard.press('Enter');
    await waitConn(buyer.pg, /Signed out/, 10000); step('websocket client after logout: "' + await conn(buyer.pg) + '"');

    // 9. mobile layout screenshots
    if (SHOTS) {
      const login = await api('', 'POST', '/api/login', { email: 'bea@example.test', password: 'a-long-password-2' });
      const m = await mk(login.cookie, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await m.pg.goto(B + '/messages'); await m.pg.locator('.conn-list span').filter({ hasText: /Live · /}).waitFor({ timeout: 15000 }); await m.pg.screenshot({ path: path.join(OUT, '19-chat-mobile-inbox.png') });
      await m.pg.click('.conv'); await m.pg.locator('#msgs .msg').first().waitFor(); await m.pg.screenshot({ path: path.join(OUT, '20-chat-mobile-thread.png') });
      await seller.pg.goto(B + '/messages'); await seller.pg.waitForTimeout(500); await seller.pg.screenshot({ path: path.join(OUT, '21-chat-desktop-inbox.png') });
    }
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    console.log('\nBROWSER CHAT TEST PASSED');
  } finally { await browser.close(); server.kill(); }
})().catch((e) => { console.error('\nBROWSER CHAT TEST FAILED:', e.message); server.kill(); process.exit(1); });
