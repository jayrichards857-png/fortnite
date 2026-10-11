'use strict';
// Real-browser check of the seller shipping-label panel (TEST MODE) with a FAKE Shippo transport: the network and Shippo are never contacted.
//   node scripts/browser-shipping.js [--screenshots]
process.env.CHECKOUT_MODE = 'external';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const H = require('../test/helpers');            // throwaway database + upload dir
const config = require('../src/config');
const SH = require('../src/shippo');

const SHOTS = process.argv.includes('--screenshots'), OUT = path.resolve(__dirname, '..', 'artifacts', 'screenshots');
config.shippo = { apiKey: 'shippo_test_BROWSER_FAKE', mode: 'test' };
const rates = [{ object_id: 'rate_a', provider: 'USPS', servicelevel: { name: 'Priority Mail' }, amount: '7.58', currency: 'USD', estimated_days: 2 }, { object_id: 'rate_b', provider: 'UPS', servicelevel: { name: 'Ground' }, amount: '10.20', currency: 'USD', estimated_days: 4 }];
let bought = 0;
SH.setTransport(async (r) => {
  if (r.path === '/shipments/') return { status: 200, json: { object_id: 'shp_b', test: true, rates } };
  if (r.path === '/transactions/') { bought++; return { status: 200, json: { object_id: 'txn_browser_0001', status: 'SUCCESS', test: true, label_url: 'https://shippo-delivery-east.s3.amazonaws.com/browser.pdf', tracking_number: 'SHIPPO_TRANSIT' } }; }
  return { status: 404, json: {} };
});
const step = (m) => console.log('•', m);

(async () => {
  await H.start();
  const seller = await H.newSeller('Browser'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_browser1', price: '40.00', shipping: '6.00', shipping_payer: 'buyer' });
  const o = (await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).json.orderId; await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  const B = H.base, browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = []; let code = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }), pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(B + '/login'); await pg.fill('input[name=email]', seller.email); await pg.fill('input[name=password]', 'correct-horse-9'); await Promise.all([pg.waitForURL((u) => !u.pathname.startsWith('/login')), pg.click('button[type=submit]')]);
    await pg.goto(`${B}/dashboard/orders/${o}`); await pg.waitForSelector('#ship-panel h4');
    assert.match(await pg.textContent('#ship-panel'), /TEST MODE/); step('panel shows TEST MODE banner and asks for the ship-from address');
    await pg.fill('#sp_from_name', 'Browser Shop'); await pg.fill('#sp_from_line1', '5 Warehouse Rd'); await pg.fill('#sp_from_city', 'Brooklyn'); await pg.fill('#sp_from_region', 'NY'); await pg.fill('#sp_from_postal', '11201');
    await pg.click('text=Save ship-from address'); await pg.waitForSelector('#sp_parcel_weight_oz'); step('ship-from saved; delivery address + package form shown');
    await pg.fill('#sp_parcel_length_in', '12'); await pg.fill('#sp_parcel_width_in', '9'); await pg.fill('#sp_parcel_height_in', '4'); await pg.fill('#sp_parcel_weight_oz', '20');
    await pg.click('text=Get shipping rates'); await pg.waitForSelector('input[name=rate]'); const t = await pg.textContent('#ship-panel');
    assert.match(t, /Priority Mail/); assert.match(t, /\$7\.58/); assert.match(t, /\$10\.20/); assert.equal(bought, 0); step('rates listed with prices; nothing bought yet');
    await pg.screenshot({ path: path.join(fs.mkdirSync(OUT, { recursive: true }) || OUT, SHOTS ? 'shipping-1-rates.png' : 'tmp-shipping.png') });
    let dialog = ''; pg.once('dialog', (d) => { dialog = d.message(); d.dismiss(); });
    await pg.click('text=Buy shipping label'); await pg.waitForTimeout(300); assert.match(dialog, /Buy a TEST label/); assert.match(dialog, /\$7\.58/); assert.equal(bought, 0, 'dismissing the confirmation buys nothing');
    pg.once('dialog', (d) => d.accept()); await pg.click('text=Buy shipping label'); await pg.waitForSelector('text=Test label created'); assert.equal(bought, 1);
    const a = pg.locator('a:has-text("Print / download label")'); assert.equal(await a.getAttribute('href'), `/dashboard/orders/${o}/label`); assert.match(await pg.textContent('#ship-panel'), /SHIPPO_TRANSIT/);
    step('confirmed purchase created a TEST label with print/download link and tracking number'); if (SHOTS) await pg.screenshot({ path: path.join(OUT, 'shipping-2-label.png') });
    await pg.reload(); await pg.waitForSelector('text=Test label created'); assert.equal(bought, 1); step('reload shows the stored label; no second purchase');
    const m = await browser.newContext({ viewport: { width: 375, height: 760 } }), mp = await m.newPage();
    await mp.goto(B + '/login'); await mp.fill('input[name=email]', seller.email); await mp.fill('input[name=password]', 'correct-horse-9'); await Promise.all([mp.waitForURL((u) => !u.pathname.startsWith('/login')), mp.click('button[type=submit]')]);
    await mp.goto(`${B}/dashboard/orders/${o}`); await mp.waitForSelector('#ship-panel'); const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok(over <= 1, `mobile overflow ${over}px`); step('mobile (375px): no horizontal overflow');
    assert.deepEqual(errors, []); console.log('\nBROWSER SHIPPING TEST PASSED');
  } catch (e) { console.error('\nBROWSER SHIPPING TEST FAILED:', e.message); code = 1; }
  finally { await browser.close(); await H.stop(); fs.rmSync(path.join(OUT, 'tmp-shipping.png'), { force: true }); process.exit(code); }
})();
