'use strict';
// Launches the real app against an ISOLATED database and captures screenshots with Playwright (Chromium).
//   node scripts/screenshots.js            -> uses data/demo.db (run `npm run seed:demo` first) and an empty DB for the empty-state shot
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts', 'screenshots');
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function startServer(port, db, uploads) {
  const p = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), PAIRPLUG_DB: db, PAIRPLUG_UPLOADS: uploads, PAYMENTS_MODE: 'sandbox', CHECKOUT_MODE: 'platform', PUBLIC_URL: `http://localhost:${port}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => { p.stdout.on('data', (d) => { if (String(d).includes('listening')) res(p); }); p.on('exit', (c) => rej(new Error('server exited ' + c))); setTimeout(() => rej(new Error('server start timeout')), 15000); });
}

(async () => {
  const demoDb = path.join(root, 'data', 'demo.db');
  if (!fs.existsSync(demoDb)) throw new Error('Run `npm run seed:demo` first');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-empty-'));
  const [demo, empty] = await Promise.all([startServer(3201, demoDb, path.join(root, 'data', 'demo-uploads')), startServer(3202, path.join(tmp, 'empty.db'), path.join(tmp, 'up'))]);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const B = 'http://localhost:3201';
  const login = async (ctx, email) => { const p = await ctx.newPage(); await p.goto(B + '/login'); await p.fill('#e', email); await p.fill('#p', 'demo-password-1'); await Promise.all([p.waitForURL(B + '/'), p.click('button[type=submit]')]); await p.close(); };
  const shot = async (page, name, url, { full = true, prep } = {}) => {
    await page.goto(url, { waitUntil: 'networkidle' }); if (prep) await prep(page);
    await page.screenshot({ path: path.join(out, name), fullPage: full }); console.log('✔', name);
  };
  try {
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pa = await anon.newPage();
    await shot(pa, '00-empty-marketplace.png', 'http://localhost:3202/', { full: false });
    await shot(pa, '01-marketplace-home.png', B + '/');
    await shot(pa, '02-search-results.png', B + '/shop?q=jacket&sort=price_asc');
    const firstListing = await pa.goto(B + '/shop?category=outerwear').then(() => pa.getAttribute('.card .title', 'href'));
    await shot(pa, '03-product-detail.png', B + firstListing);
    await shot(pa, '12-seller-storefront.png', B + '/s/northfield');

    const buyerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await login(buyerCtx, 'buyer@demo.test');
    const pb = await buyerCtx.newPage();
    await shot(pb, '04-cart.png', B + '/cart');
    await shot(pb, '05-checkout.png', B + '/checkout', { prep: async (p) => { await p.fill('#a_name', 'Alex Rivera'); await p.fill('#a_line1', '221 Example Street'); await p.fill('#a_city', 'Austin'); await p.fill('#a_region', 'TX'); await p.fill('#a_postal', '78701'); } });
    await shot(pb, '06-buyer-orders.png', B + '/orders');

    const sellerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await login(sellerCtx, 'seller@demo.test');
    const ps = await sellerCtx.newPage();
    await shot(ps, '07-seller-dashboard.png', B + '/dashboard');
    await shot(ps, '08-seller-inventory.png', B + '/dashboard/inventory', { prep: async (p) => { await p.check('.sel:not(:disabled) >> nth=0'); await p.check('.sel:not(:disabled) >> nth=1'); } });
    await shot(ps, '09-listing-editor.png', B + '/dashboard/listings/6/edit', { prep: (p) => p.waitForTimeout(600) });
    await shot(ps, '10-seller-orders.png', B + '/dashboard/orders');
    await shot(ps, '11-sales-analytics.png', B + '/dashboard/analytics');
    await shot(ps, '15-seller-earnings-tax.png', B + '/dashboard/finance');

    const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await login(adminCtx, 'admin@demo.test');
    const pd = await adminCtx.newPage();
    await shot(pd, '16-admin-dispute.png', B + '/admin/disputes/1');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pm = await mobile.newPage();
    await shot(pm, '13-mobile-home.png', B + '/', { full: false });
    await login(mobile, 'seller@demo.test');
    await shot(pm, '14-mobile-dashboard.png', B + '/dashboard', { full: false });
    await shot(pm, '17-mobile-product.png', B + firstListing, { full: false });
  } finally { await browser.close(); demo.kill(); empty.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
