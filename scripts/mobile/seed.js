'use strict';
// Builds a realistic, throwaway marketplace for the mobile audit by driving the REAL application (HTTP API) on a disposable PostgreSQL
// database: storefronts with banners/themes, listings with several photos (including awkward long titles/words), orders in every state,
// reviews and reports, cases with staff replies, chat, notifications, moderation, invitations. Nothing here touches real data.
// Used by scripts/mobile-audit.js and scripts/browser-mobile.js (so the audit and its regression test see identical pages).
const { png } = require('../png');

const LONG_WORD = 'Supercalifragilisticexpialidocious_ThisIsAnUnbrokenStringThatMustNeverBreakTheLayout_0123456789';
const swatch = (i, w = 640, h = 800) => { const hues = [[196, 168, 130], [92, 110, 96], [60, 72, 96], [150, 98, 84], [210, 205, 190], [40, 40, 44], [120, 138, 150], [176, 140, 60]]; const [r, g, b] = hues[i % hues.length]; return png(w, h, (x, y) => { const k = 1 - y / (h * 3) - (((x >> 5) + (y >> 5)) % 2) * 0.04; return [r * k | 0, g * k | 0, b * k | 0]; }); };

/** @param H the test helpers module (starts an in-process server on a random port)  @param {{mode?: 'external'|'platform'}} opts */
async function seed(H, { mode = 'external' } = {}) {
  const { q } = require('../../src/db');
  const up = async (c, i, w, h) => { const r = await c.req('POST', '/api/uploads', swatch(i, w, h), { raw: true, type: 'image/png' }); if (r.status !== 200) throw new Error('upload failed ' + r.text); return r.json.file; };
  const uid = async (email) => (await q.get('SELECT id FROM users WHERE email = ?', email)).id;
  const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
  const LINK = 'https://buy.stripe.com/test_mobile1';

  // ---- people
  const admin = await H.newUser('Avery Admin'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', admin.email);
  const inv = await admin.post('/api/admin/moderators/invite', { email: `mod${Date.now()}@example.test` });
  const mod = new H.Client(); mod.email = `mod-${Date.now()}@example.test`;
  const modInv = await admin.post('/api/admin/moderators/invite', { email: mod.email });
  const rs = await mod.post('/api/moderator/setup', { token: modInv.json.link.split('/').pop(), display_name: 'Morgan Moderator', password: 'a-very-long-passphrase', terms: true });
  if (rs.status !== 200) throw new Error('moderator setup failed ' + rs.text);
  const sellerInv = await admin.post('/api/admin/accounts/invite', { role: 'seller', email: `invited${Date.now()}@example.test`, confirm: true });
  const s1 = await H.newSeller('Northfield Vintage'), s2 = await H.newSeller('Maple Resale'), s3 = await H.newSeller('Brand New Store');
  const b1 = await H.newUser('Alex Rivera'), b2 = await H.newUser('Sam Chen'), b3 = await H.newUser('Jordan Lee');

  // ---- storefronts: dark/large with banner+avatar+announcement, light/list, default
  const avatar = await up(s1, 3, 200, 200), banner = await up(s1, 1, 1200, 300);
  await s1.put('/api/seller/storefront', { theme: 'dark', accent: 'ocean', layout: 'large', sort: 'newest', headline: 'Vintage workwear & outerwear — restored by hand', announcement: 'Shipping on Fridays. Messages answered within 24h!', about: 'I restore workwear and outerwear.\nEvery piece is cleaned, repaired and photographed in daylight.', avatar, banner, links: [{ kind: 'instagram', url: 'https://www.instagram.com/northfield' }], showLocation: true });
  await s1.post('/api/seller/storefront/publish');
  await s2.put('/api/seller/storefront', { theme: 'light', accent: 'forest', layout: 'list', sort: 'price_asc', headline: 'Sneakers and streetwear from Toronto', about: 'Everything ships within two business days.', showLocation: true }); await s2.post('/api/seller/storefront/publish');

  // ---- listings
  const titles1 = ['Heavyweight crewneck sweatshirt', 'Waxed field jacket — size M, great condition, minor wear on the cuffs and collar', 'Straight-leg selvedge jeans', `Wool overcoat ${LONG_WORD}`, 'Corduroy work shirt', 'Leather belt, brass buckle', 'Flannel overshirt', 'Denim trucker jacket'];
  const titles2 = ['Nylon track jacket', 'Graphic tee, 90s print', 'Chelsea boots', 'Relaxed carpenter pants', 'Canvas tote bag', 'Silver chain necklace', 'Knit beanie', 'Fleece quarter-zip'];
  const mk = async (s, i, title, over = {}) => {
    const imgs = []; for (let k = 0; k < (over.photos || 1 + (i % 4)); k++) imgs.push(await up(s, i + k));
    const r = await s.post('/api/seller/listings', { title, description: over.description || `${title}. Gently used, photographed as shown.\n\nMeasurements: pit to pit 22in, length 28in. No stains, no holes.`, category: ['clothing', 'outerwear', 'denim', 'sneakers', 'shoes', 'accessories', 'bags'][i % 7], brand: over.brand ?? ['Harbor & Co', 'Ridgeline', 'Northfield Mills', 'Alder'][i % 4], size: ['S', 'M', 'L', 'XL', '32', '11'][i % 6], condition: ['good', 'like_new', 'fair', 'new_with_tags'][i % 4], price: String(20 + i * 7) + '.00', shipping: String(4 + (i % 3)) + '.00', shipping_payer: 'buyer', weight_oz: String(12 + i), payment_url: LINK, payment_amount_ack: true, status: 'active', images: imgs, quantity: over.quantity || 1, sku: 'M-' + s.handle.slice(-4) + i });
    if (r.status !== 200) throw new Error('listing failed ' + r.text); return r.json.id;
  };
  const L1 = [], L2 = [];
  for (const [i, t] of titles1.entries()) L1.push(await mk(s1, i, t, i === 1 ? { quantity: mode === 'platform' ? 1 : 3, brand: `Ridgeline Outfitters International ${LONG_WORD}`, photos: 4, description: `A long description with an unbroken string: ${LONG_WORD} and a link-like token https://example.com/${'a'.repeat(70)}\n\nSecond paragraph.` } : {}));
  for (const [i, t] of titles2.entries()) L2.push(await mk(s2, i + 8, t));
  await s1.post(`/api/seller/listings/${L1[7]}/pause`, {});

  // ---- platform (cart) checkout mode: PairPlug-hosted checkout paid through the payments sandbox. The external-link order states
  // below do not exist in this mode, so it gets its own small fixture: one paid order and a filled cart for the audited buyer.
  if (mode === 'platform') {
    const cart = async (b, id) => { const r = await b.post('/api/cart', { listingId: id }); if (r.status !== 200) throw new Error('cart failed ' + r.text); };
    await cart(b1, L1[5]); const ck = await H.checkout(b1); if (ck.status !== 200) throw new Error('checkout failed ' + ck.text);
    if (!(await H.pay(b1, ck.json.checkoutId)).json.paid) throw new Error('sandbox payment failed');
    await cart(b1, L1[6]); await cart(b1, L2[2]);
    const ids = { L1, L2, s1handle: s1.handle, s2handle: s2.handle, s3handle: s3.handle };
    return { clients: { anon: new H.Client(), buyer: b1, buyer2: b2, buyer3: b3, seller: s1, seller2: s2, admin, mod }, ids,
      routes: { anon: ['/', '/shop', `/listing/${L1[1]}`, `/listing/${L2[2]}`, `/s/${s1.handle}`], buyer: ['/cart', '/checkout', '/orders', `/listing/${L1[2]}`], platformBuyer: [] } };
  }

  // ---- orders in every state
  const buy = async (b, id) => { const r = await b.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); if (r.status !== 200) throw new Error('purchase failed ' + r.text); return oid(r); };
  const oPending = await buy(b1, L1[0]);                                                     // waiting: "Before you pay"
  const oClaimed = await buy(b2, L1[1]); await b2.post(`/api/orders/${oClaimed}/claim-paid`, {});
  const oPaid = await buy(b1, L1[2]); await s1.post(`/api/seller/orders/${oPaid}/confirm-payment`, {});
  const oShipped = await buy(b1, L1[3]); await s1.post(`/api/seller/orders/${oShipped}/confirm-payment`, {}); await s1.post(`/api/seller/orders/${oShipped}/ship`, { carrier: 'USPS', tracking: '9400111899223344', note: 'Packed in a box, left Friday' });
  const oDone = await buy(b1, L1[4]); await s1.post(`/api/seller/orders/${oDone}/confirm-payment`, {}); await s1.post(`/api/seller/orders/${oDone}/ship`, { carrier: 'UPS', tracking: '1Z999AA10123456784' }); await b1.post(`/api/orders/${oDone}/received`, {});
  await b1.post(`/api/orders/${oDone}/review`, { thumbsUp: true, body: 'Fast shipping, exactly as described. Would buy again!' });
  const oDone2 = await buy(b3, L1[5]); await s1.post(`/api/seller/orders/${oDone2}/confirm-payment`, {}); await s1.post(`/api/seller/orders/${oDone2}/ship`, { carrier: 'USPS', tracking: '9400111899223355' }); await b3.post(`/api/orders/${oDone2}/received`, {});   // review form visible
  const oRefund = await buy(b2, L2[0]); await s2.post(`/api/seller/orders/${oRefund}/confirm-payment`, {}); await b2.post(`/api/orders/${oRefund}/refund-request`, { kind: 'refund', reason: 'The jacket is smaller than the listing says.' });
  const oCancelled = await buy(b3, L2[1]); await s2.post(`/api/seller/orders/${oCancelled}/reject-payment`, {});
  // ---- reports / cases / reviews moderation
  const rpt = await b1.post(`/api/cases/order`, { orderId: oPaid, reason: 'The seller has not shipped and stopped answering messages.', category: 'other' }); const caseId = rpt.json && rpt.json.id;
  await b3.post('/api/cases/seller', { handle: s2.handle, reason: 'Listing photos look like they were copied from another store.', category: 'other' });
  await s2.post('/api/seller/appeal', { reason: 'My listing was removed by mistake. It is a genuine pair that I own and can show proof of.' });
  const rv = await q.get('SELECT id FROM seller_reviews ORDER BY id LIMIT 1'); if (rv) await b3.post(`/api/reviews/${rv.id}/report`, { reason: 'This reads like an advertisement.' });
  const cases = await q.all('SELECT id FROM cases ORDER BY id');
  if (cases[0]) await admin.post(`/api/admin/cases/${cases[0].id}/reply`, { body: 'Thanks for reporting. We have asked the seller to respond within two days.' });
  // ---- chat, follows, favorites, notifications, moderation log
  const conv = await b1.post('/api/chat/conversations', { listingId: L1[1] }); const convId = conv.json.id || conv.json.conversationId || (conv.json.data && conv.json.data.id);
  const say = (c, text) => c.post('/api/chat/command', { op: 'send', conversationId: convId, clientId: 'm-' + Math.random().toString(36).slice(2), body: text });
  for (let i = 0; i < 9; i++) await say(i % 2 ? s1 : b1, i % 2 ? `Reply ${i}: yes, it is still available and ships Friday. ${i === 3 ? LONG_WORD : ''}` : `Question ${i}: could you share the measurements and a photo of the tag? ${i === 4 ? 'https://example.com/' + 'b'.repeat(60) : ''}`);
  await b1.put(`/api/favorites/${L1[2]}`, {}); await b1.put(`/api/favorites/${L2[3]}`, {}); await b1.post(`/api/sellers/${s1.handle}/follow`, {}); await b1.post(`/api/sellers/${s2.handle}/follow`, {});
  const b4 = await H.newUser('Banned Example'); const b4id = await uid(b4.email);
  await mod.post(`/api/moderation/users/${b4id}/ban`, { reason: 'Mobile audit fixture: exercising the ban log' });
  for (const t of ['nike dunk', 'carhartt jacket', 'levis 501']) await q.run('INSERT INTO search_log(term, created_at) VALUES(?, ?)', t, Math.floor(Date.now() / 1000));

  const ids = { L1, L2, oPending, oClaimed, oPaid, oShipped, oDone, oDone2, oRefund, oCancelled, caseId: caseId || (cases[0] && cases[0].id), convId, s1handle: s1.handle, s2handle: s2.handle, s3handle: s3.handle,
    userS1: await uid(s1.email), modInvite: modInv.json.link.split('/').pop(), sellerInvite: (sellerInv.json.link || '').split('/').pop(), saleListing: L2[5] };
  const buyer2Routes = ['/orders', `/orders/${oClaimed}`, `/orders/${oRefund}`], buyer3Routes = ['/orders', `/orders/${oDone2}`, `/orders/${oCancelled}`], seller2Routes = ['/dashboard', '/dashboard/orders', `/dashboard/orders/${oRefund}`, `/dashboard/orders/${oCancelled}`, '/dashboard/appeal'];
  const buyerRoutes = ['/account', '/orders', `/orders/${oPending}`, `/orders/${oShipped}`, `/orders/${oDone}`, `/orders/${oPaid}`, `/buy/${L2[2]}`, '/notifications', '/following', '/favorites', '/messages', `/messages/${convId}`, '/support', caseId ? `/cases/${caseId}` : null].filter(Boolean);
  const sellerRoutes = ['/dashboard', '/dashboard/inventory', '/dashboard/orders', `/dashboard/orders/${oPending}`, `/dashboard/orders/${oPaid}`, `/dashboard/orders/${oShipped}`, '/dashboard/storefront', '/dashboard/analytics', '/dashboard/finance', '/dashboard/listings/new', `/dashboard/listings/${L1[1]}/edit`, `/dashboard/listings/${L1[0]}/record-sale`, '/dashboard/import', '/dashboard/settings', '/dashboard/appeal', '/messages', `/messages/${convId}`];
  const staffRoutes = ['/admin', '/admin/users', '/admin/orders', '/admin/cases', ids.caseId ? `/admin/cases/${ids.caseId}` : null, '/admin/accounts', '/admin/moderators', '/admin/invitations', '/admin/audit', '/admin/sellers', '/admin/risk', '/admin/listings', '/admin/outbox', '/admin/settings', '/admin/responses', '/admin/disputes', '/admin/withdrawals'].filter(Boolean);
  const modRoutes = ['/moderation', '/moderation/users?q=Alex', `/moderation/users/${await uid(b1.email)}`, '/moderation/log', '/moderation/reviews', '/moderation/payment-links'];
  const anonRoutes = ['/', '/shop', '/shop?q=jacket', '/shop?category=outerwear&size=M&sort=price_asc', '/shop?q=jacket&tab=sellers', '/sellers', `/listing/${L1[1]}`, `/listing/${L1[2]}`, `/listing/${L2[2]}`, `/s/${s1.handle}`, `/s/${s2.handle}`, `/s/${s3.handle}`, '/login', '/register', '/sell', '/contact', '/support', '/legal', '/terms', '/privacy', '/payments', '/rules', '/prohibited', '/refunds', '/forgot-password', '/reset-password', `/invite/${ids.sellerInvite}`, `/moderator/setup/${ids.modInvite}`, '/nope-this-page-does-not-exist'];
  return { clients: { anon: new H.Client(), buyer: b1, buyer2: b2, buyer3: b3, seller: s1, seller2: s2, admin, mod }, ids, routes: { anon: anonRoutes, buyer: buyerRoutes, buyer2: buyer2Routes, buyer3: buyer3Routes, seller2: seller2Routes, seller: sellerRoutes, admin: staffRoutes, mod: modRoutes,
    platformBuyer: [] } };
}
module.exports = { seed, LONG_WORD };
