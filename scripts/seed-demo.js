'use strict';
// ISOLATED FIXTURE DATA — never touches the live database.
// Builds data/demo.db by driving the real HTTP API (so every record is produced by production code paths),
// then back-dates a few rows so the analytics chart has history. Used only for screenshots / manual QA.
//   node scripts/seed-demo.js && PAIRPLUG_DB=data/demo.db PAIRPLUG_UPLOADS=data/demo-uploads PAYMENTS_MODE=sandbox npm start
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dbFile = path.join(root, 'data', 'demo.db'), upDir = path.join(root, 'data', 'demo-uploads');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
fs.rmSync(upDir, { recursive: true, force: true });
process.env.PAIRPLUG_DB = dbFile; process.env.PAIRPLUG_UPLOADS = upDir; process.env.PAYMENTS_MODE = 'sandbox'; process.env.TAX_RATE_BPS = '0';

const H = require('../test/helpers');
const { png } = require('./png');
const { q, getSettings } = require('../src/db');
const { hashPassword } = require('../src/auth');

const hues = [[196, 168, 130], [92, 110, 96], [60, 72, 96], [150, 98, 84], [210, 205, 190], [40, 40, 44], [120, 138, 150], [176, 140, 60]];
const swatch = (i, v) => { const [r, g, b] = hues[(i + v) % hues.length]; return png(240, 300, (x, y) => { const k = 1 - y / 900 - (((x >> 4) + (y >> 4)) % 2) * 0.04; return [r * k | 0, g * k | 0, b * k | 0]; }); }; // neutral colour blocks (not product photos)
const PW = 'demo-password-1';

(async () => {
  await H.start();
  const mkSeller = async (store, handle, country, region, city, bio) => {
    const c = await H.newUser(store); await c.post('/api/sell/onboard', { store_name: store, handle, country, region, city, bio, agree: true, terms: true }); c.handle = handle; return c;
  };
  const sellers = [
    await mkSeller('Northfield Vintage', 'northfield', 'US', 'NY', 'Brooklyn', 'Curated secondhand outerwear and denim. Ships within 2 business days.'),
    await mkSeller('Maple Resale', 'maple', 'CA', 'ON', 'Toronto', 'Sneakers and streetwear, shipped from Toronto.'),
    await mkSeller('Casa Thrift', 'casathrift', 'MX', 'CDMX', 'Mexico City', 'Accessories and bags.'),
  ];
  const uploadN = async (c, i, n) => { const out = []; for (let v = 0; v < n; v++) { const r = await c.req('POST', '/api/uploads', swatch(i, v * 3), { raw: true, type: 'image/png' }); out.push(r.json.file); } return out; };
  const items = [
    [0, 'Heavyweight crewneck sweatshirt', 'clothing', 'Harbor & Co', 'L', 'good', 38, 12, 6, 14],
    [0, 'Waxed field jacket', 'outerwear', 'Ridgeline', 'M', 'like_new', 120, 45, 9, 38],
    [0, 'Straight-leg selvedge jeans', 'denim', 'Northfield Mills', '32', 'good', 64, 20, 7, 24],
    [0, 'Wool overcoat', 'outerwear', 'Ridgeline', 'L', 'fair', 85, 30, 10, 48],
    [0, 'Corduroy work shirt', 'clothing', 'Harbor & Co', 'M', 'good', 34, 8, 5, 12],
    [0, 'Leather belt, brass buckle', 'accessories', null, '34', 'good', 22, 5, 4, 8],
    [1, 'Court sneakers, white', 'sneakers', 'Kestrel', '10', 'like_new', 75, 30, 10, 32],
    [1, 'Trail runners', 'sneakers', 'Kestrel', '9.5', 'good', 58, 22, 10, 30],
    [1, 'Nylon track jacket', 'outerwear', 'Alder', 'M', 'good', 52, 15, 7, 16],
    [1, 'Graphic tee, 90s print', 'clothing', 'Alder', 'L', 'good', 29, 6, 5, 8],
    [1, 'Chelsea boots', 'shoes', 'Marlowe', '11', 'good', 92, 35, 12, 44],
    [1, 'Relaxed carpenter pants', 'denim', 'Northfield Mills', '34', 'like_new', 48, 14, 7, 20],
    [2, 'Canvas tote bag', 'bags', null, null, 'like_new', 26, 6, 5, 10],
    [2, 'Silver chain necklace', 'accessories', null, null, 'new_with_tags', 32, 10, 4, 3],
    [2, 'Woven crossbody bag', 'bags', 'Casa', null, 'good', 40, 12, 6, 14],
    [2, 'Knit beanie', 'accessories', 'Alder', null, 'like_new', 16, 3, 4, 4],
    [0, 'Denim trucker jacket', 'denim', 'Northfield Mills', 'M', 'good', 70, 25, 8, 26],
    [1, 'Fleece quarter-zip', 'clothing', 'Ridgeline', 'XL', 'good', 36, 10, 6, 18],
  ];
  const ids = [];
  for (const [i, [si, title, category, brand, size, condition, price, cost, ship, oz]] of items.entries()) {
    const s = sellers[si], imgs = await uploadN(s, i, 1 + (i % 3));
    const r = await s.post('/api/seller/listings', { title, description: `${title}. Gently used, photographed as shown. Ships from ${['Brooklyn, NY', 'Toronto, ON', 'Mexico City'][si]}.`, category, brand: brand || '', size: size || '', condition, price: String(price), cost: String(cost), shipping: String(ship), weight_oz: String(oz), sku: `${s.handle.slice(0, 3).toUpperCase()}-${100 + i}`, images: imgs, status: 'active' });
    ids.push(r.json.id);
  }
  const draft = await sellers[0].post('/api/seller/listings', { title: 'Flannel overshirt (needs photos)', category: 'clothing', price: '42', cost: '11', sku: 'NOR-DRAFT', status: 'draft' });
  const buyer = await H.newUser('Alex Rivera'); const buyer2 = await H.newUser('Sam Chen');
  // Fixture login credentials are for the isolated demo DB only.
  q.run('UPDATE users SET email = ?, password_hash = ? WHERE email = ?', 'buyer@demo.test', hashPassword(PW), buyer.email);
  q.run('UPDATE users SET email = ?, password_hash = ? WHERE id = (SELECT id FROM users WHERE handle = ?)', 'seller@demo.test', hashPassword(PW), 'northfield');
  q.run('UPDATE users SET email = ?, password_hash = ? WHERE id = (SELECT id FROM users WHERE handle = ?)', 'seller2@demo.test', hashPassword(PW), 'maple');
  q.run("INSERT INTO users(email, password_hash, display_name, is_admin, created_at) VALUES('admin@demo.test', ?, 'Admin', 1, strftime('%s','now'))", hashPassword(PW));

  const buy = async (c, listingIds) => { for (const id of listingIds) await c.post('/api/cart', { listingId: id }); const ck = await H.checkout(c); await H.pay(c, ck.json.checkoutId); return q.all('SELECT * FROM orders WHERE checkout_id = ?', ck.json.checkoutId); };
  const ship = (s, o, n) => s.post(`/api/seller/orders/${o.id}/ship`, { carrier: 'USPS', tracking: `9400${1000000 + n}`.padEnd(14, '0') });
  const day = 86400, now = Math.floor(Date.now() / 1000);
  const back = (o, d) => q.run('UPDATE orders SET created_at = created_at - ?, paid_at = paid_at - ? WHERE id = ?', d * day, d * day, o.id);
  const s0 = sellers[0], s1 = sellers[1];
  // completed sales spread over the last weeks (released)
  const done = [[ids[0], 24], [ids[2], 19], [ids[4], 13], [ids[16], 9], [ids[1], 4]];
  let n = 1;
  for (const [id, d] of done) {
    const [o] = await buy(buyer2, [id]); await ship(s0, o, n++); await require('../src/escrow').markDelivered(o.id, 'carrier'); require('../src/escrow').releaseToSeller(o.id, 'system:auto-release'); back(o, d);
  }
  const [o2] = await buy(buyer, [ids[6]]); await ship(s1, o2, n++); back(o2, 3);        // shipped
  const [o3] = await buy(buyer, [ids[10]]); await ship(s1, o3, n++); require('../src/escrow').markDelivered(o3.id, 'carrier'); back(o3, 6); // delivered, awaiting confirmation
  const [o4] = await buy(buyer, [ids[3]]); back(o4, 1);                                      // paid, to ship
  const [o5] = await buy(buyer2, [ids[7]]); await ship(s1, o5, n++);                          // disputed
  const ev1 = (await buyer2.req('POST', '/api/uploads', swatch(3, 1), { raw: true, type: 'image/png' })).json.file;
  await buyer2.post(`/api/orders/${o5.id}/dispute`, { reason: 'Left shoe has a sole separation that is not shown in the listing photos.', evidence_json: JSON.stringify([ev1]) });
  const ev2 = (await s1.req('POST', '/api/uploads', swatch(5, 2), { raw: true, type: 'image/png' })).json.file;
  await s1.post(`/api/orders/${o5.id}/dispute/evidence`, { note: 'Shoes were packed as photographed; the listing noted normal sole wear. Happy to accept a return.', evidence_json: JSON.stringify([ev2]) });
  // cart contents for the buyer
  await buyer.post('/api/cart', { listingId: ids[12] }); await buyer.post('/api/cart', { listingId: ids[14] }); await buyer.post('/api/cart', { listingId: ids[13] });
  await buyer.put(`/api/favorites/${ids[8]}`); await buyer.put(`/api/favorites/${ids[11]}`);
  q.run('UPDATE listings SET published_at = published_at - ? WHERE id IN (?, ?)', 120 * day, ids[5], ids[9]); // aged inventory
  console.log('Demo DB ready:', dbFile, '| logins: buyer@demo.test, seller@demo.test, seller2@demo.test, admin@demo.test | password:', PW);
  await H.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
