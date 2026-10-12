'use strict';
// Phone-sized journeys in real Chromium on a throwaway PostgreSQL database (same seeded marketplace as scripts/mobile-audit.js).
//   node scripts/browser-mobile.js
// Emulation only: mobile viewport, touch, device pixel ratio and an iPhone user agent. Real iOS Safari / Android hardware is NOT
// available here, so Safari-only rendering, the on-screen keyboard and the real safe-area insets are not exercised.
// Two parts:
//  1. interactions a phone user depends on (menu sheet, mobile search, filter drawer, gallery, sticky buy box, stacked tables,
//     inventory row actions, chat list -> thread -> back), at 320/375/390/430 px;
//  2. a layout gate: the audit's measure() on core pages must report no horizontal overflow, no undersized touch targets, no
//     iOS-zoom inputs, no images without dimensions, and no control that is on the desktop page but unreachable on a phone.
process.env.PAYMENTS_MODE = process.env.PAYMENTS_MODE || 'sandbox'; process.env.SELLER_ONBOARDING = 'open'; process.env.CHECKOUT_MODE = 'external';
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const H = require('../test/helpers');
const { seed } = require('./mobile/seed');
const { measure, VIEWPORTS } = require('./mobile-audit');

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PHONES = [320, 375, 390, 430];
const step = (m) => console.log('•', m);

(async () => {
  await H.start();
  let browser;
  try {
    const data = await seed(H, { mode: 'external' });
    const { ids, clients } = data;
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const errors = [];
    const ctxFor = async (w, client) => {
      const vp = VIEWPORTS[w];
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile, userAgent: vp.mobile ? UA : undefined });
      if (client && client.cookie) { const [name, ...v] = client.cookie.split('='); await ctx.addCookies([{ name, value: v.join('='), url: H.base }]); }
      const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${w}px ${page.url()}: ${e.message}`));
      return { ctx, page };
    };
    const go = (page, route) => page.goto(H.base + route, { waitUntil: 'networkidle' });
    const overflow = (page, w) => page.evaluate((vw) => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw, w);
    const inView = (page, sel, w) => page.locator(sel).first().evaluate((el, vw) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= vw + 1; }, w);

    // ---------- 1. interactions
    for (const w of PHONES) {
      step(`${w}px: anonymous browsing`);
      const { ctx, page } = await ctxFor(w);
      await go(page, '/');
      const vpMeta = await page.getAttribute('meta[name=viewport]', 'content');
      assert.match(vpMeta, /width=device-width/); assert.match(vpMeta, /viewport-fit=cover/); assert.doesNotMatch(vpMeta, /user-scalable=no|maximum-scale=1(\D|$)/, 'pinch-zoom must stay enabled');
      assert.ok(await overflow(page, w) <= 1, `home overflows at ${w}px`);
      // menu sheet: opens inside the viewport, closes on Escape, its links navigate
      const menu = page.locator('details.dd.mobile-only');
      assert.ok(await menu.locator('summary').isVisible(), 'hamburger visible on phones');
      assert.equal(await page.locator('nav.nav').isVisible().catch(() => false), false, 'desktop nav hidden on phones');
      await menu.locator('summary').tap();
      assert.equal(await menu.evaluate((d) => d.open), true);
      assert.ok(await inView(page, 'details.dd.mobile-only .dd-menu', w), 'menu sheet fits the screen');
      await page.keyboard.press('Escape');
      assert.equal(await menu.evaluate((d) => d.open), false, 'Escape closes the menu');
      await menu.locator('summary').tap();
      await Promise.all([page.waitForURL(/\/shop$/), menu.locator('.dd-menu a[href="/shop"]').first().tap()]);
      // mobile search bar
      await go(page, '/');
      assert.ok(await page.locator('#hq-m').isVisible(), 'mobile search visible');
      const fs = await page.locator('#hq-m').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(fs >= 16, `search input is ${fs}px (iOS zooms below 16px)`);
      await page.locator('#hq-m').fill('jacket');
      await Promise.all([page.waitForURL(/\/shop\?q=jacket/), page.locator('#hq-m').press('Enter')]);
      assert.ok(await page.locator('.card').count() > 0, 'search returns results');
      // filter drawer: collapsed on phones, opens, applies a filter
      await go(page, '/shop');
      const drawer = page.locator('[data-filter-drawer]');
      assert.equal(await drawer.evaluate((d) => d.open), false, 'filters start collapsed on phones');
      await drawer.locator('summary.filter-toggle').tap();
      assert.equal(await drawer.evaluate((d) => d.open), true);
      await page.locator('#ff input[name=category][value=outerwear]').check();
      await Promise.all([page.waitForURL(/category=outerwear/), page.locator('#ff button.btn').first().tap()]);
      assert.ok(await page.locator('a.tag').count() > 0, 'active filter shown as a removable tag');
      assert.ok(await overflow(page, w) <= 1, `filtered shop overflows at ${w}px`);
      // gallery thumbnails swap the main photo; buy box stays reachable
      await go(page, `/listing/${ids.L1[1]}`);
      const before = await page.getAttribute('#gmain', 'src');
      const thumbs = page.locator('[data-thumb]');
      assert.ok(await thumbs.count() >= 2, 'multi-photo listing shows thumbnails');
      await thumbs.nth(1).tap();
      assert.notEqual(await page.getAttribute('#gmain', 'src'), before, 'tapping a thumbnail changes the photo');
      assert.equal(await thumbs.nth(1).getAttribute('aria-current'), 'true');
      const box = await page.locator('#gmain').boundingBox(); assert.ok(box.width <= w && box.width > w * 0.8, 'main photo spans the screen');
      // external checkout: the "Before you pay" warning sits directly above Buy now (deliberately not a sticky bar that skips it)
      const buy = page.locator(`a.btn[href="/buy/${ids.L1[1]}"]`);
      assert.equal(await buy.count(), 1, 'Buy now present');
      assert.ok(await inView(page, `a.btn[href="/buy/${ids.L1[1]}"]`, w), 'Buy now inside the screen');
      assert.ok((await buy.boundingBox()).height >= 44, 'Buy now is a 44px target');
      assert.ok(await page.getByText('Before you pay').first().isVisible(), 'payment warning shown with the button');
      assert.ok(await overflow(page, w) <= 1, `listing with long words overflows at ${w}px`);
      await ctx.close();

      step(`${w}px: buyer orders + chat`);
      const b = await ctxFor(w, clients.buyer);
      await go(b.page, '/orders');
      assert.ok(await b.page.locator('table.stack').count() > 0, 'orders table stacks into cards');
      assert.ok(await b.page.locator('table.stack td[data-label]').count() > 0, 'stacked cells carry their column label');
      assert.ok(await overflow(b.page, w) <= 1);
      await go(b.page, '/messages');
      const conv = b.page.locator('a.conv').first();
      assert.ok(await conv.isVisible(), 'conversation list visible');
      const convBox = await conv.boundingBox(); assert.ok(convBox.width <= w && convBox.height >= 44, 'conversation row is a full-width tap target');
      await conv.tap();
      await b.page.waitForSelector('#chat.has-active');
      assert.equal(await b.page.locator('.chat-list').isVisible(), false, 'list gives way to the thread on phones');
      assert.ok(await b.page.locator('#composer textarea, #composer input').first().isVisible(), 'composer visible');
      assert.ok(await inView(b.page, '#composer', w), 'composer inside the screen');
      const txt = `mobile check ${w}`;
      await b.page.locator('#composer textarea, #composer input').first().fill(txt);
      await b.page.locator('#composer button[type=submit], #composer .btn').last().tap();
      await b.page.waitForFunction((t) => [...document.querySelectorAll('#msgs .bubble, #msgs .msg')].some((m) => m.textContent.includes(t)), txt, { timeout: 8000 });
      await b.page.locator('.chat-back').tap();
      await b.page.waitForFunction(() => !document.querySelector('#chat').classList.contains('has-active'));
      assert.ok(await b.page.locator('.chat-list').isVisible(), 'back returns to the list');
      await b.ctx.close();

      step(`${w}px: seller inventory row actions`);
      const s = await ctxFor(w, clients.seller);
      await go(s.page, '/dashboard/inventory');
      const rows = await s.page.locator('table.stack tbody tr').count();
      assert.ok(rows > 0);
      assert.equal(await s.page.locator('td.row-actions a.btn:visible', { hasText: 'Edit' }).count(), rows, 'every inventory card keeps its Edit action');
      assert.ok(await s.page.locator('td.row-actions button:visible', { hasText: 'Duplicate' }).count() === rows, 'every card keeps Duplicate');
      assert.ok(await overflow(s.page, w) <= 1);
      await s.ctx.close();
    }

    // ---------- 2. layout gate on core pages (desktop render is the reference for "nothing went missing")
    const core = {
      anon: ['/', '/shop', '/shop?category=outerwear&size=M&sort=price_asc', `/listing/${ids.L1[1]}`, `/s/${ids.s1handle}`, '/login', '/register', '/contact'],
      buyer: ['/orders', `/orders/${ids.oPending}`, '/messages', `/messages/${ids.convId}`, '/notifications', '/account'],
      seller: ['/dashboard', '/dashboard/inventory', '/dashboard/orders', `/dashboard/orders/${ids.oPending}`, '/dashboard/listings/new', '/dashboard/storefront'],
      admin: ['/admin', '/admin/accounts', '/admin/orders'],
      mod: ['/moderation'],
    };
    const ref = new Map();
    for (const w of [1280, 320, 390]) {
      step(`layout gate at ${w}px`);
      for (const [role, routes] of Object.entries(core)) {
        const { ctx, page } = await ctxFor(w, role === 'anon' ? null : clients[role]);
        for (const route of routes) {
          await go(page, route); await page.waitForTimeout(100);
          const m = await page.evaluate(measure, w), key = `${role} ${route}`;
          if (w === 1280) { ref.set(key, m.controls); continue; }
          const where = `${route} as ${role} @${w}px`;
          assert.ok(m.docOverflow <= 1, `${where}: page is ${m.docOverflow}px wider than the screen`);
          assert.deepEqual(m.offenders, [], `${where}: elements outside the screen`);
          assert.deepEqual(m.targets.small, [], `${where}: touch targets under 44px`);
          assert.deepEqual(m.inputs.zoom, [], `${where}: inputs under 16px (iOS zoom)`);
          assert.deepEqual(m.inputs.noName, [], `${where}: controls without an accessible name`);
          assert.deepEqual(m.images.noDims, [], `${where}: images without width/height`);
          assert.deepEqual(m.fonts.tiny, [], `${where}: text under 12px`);
          assert.deepEqual(m.crushed, [], `${where}: text squeezed into a sliver`);
          const have = new Map(); for (const k of m.controls) have.set(k, (have.get(k) || 0) + 1);
          const missing = []; for (const k of ref.get(key) || []) { const n = have.get(k) || 0; if (n) have.set(k, n - 1); else missing.push(k); }
          assert.deepEqual(missing, [], `${where}: controls on the desktop page are missing on the phone`);
        }
        await ctx.close();
      }
    }
    assert.deepEqual(errors, [], 'no JavaScript errors');
    console.log('\nMobile journeys passed (Chromium emulation at 320/375/390/430 px; not real iOS Safari).');
  } finally {
    if (browser) await browser.close();
    await H.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
