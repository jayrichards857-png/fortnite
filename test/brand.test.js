'use strict';
// Brand: customers see "Grailedside". The old name survives only in the official support mailbox address (a real inbox that has not moved)
// and in internal identifiers (cookie/header/env names), which are never shown as a brand.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => await H.start());
test.after(() => H.stop());

const strip = (t) => t.replace(/<script[\s\S]*?<\/script>/g, '').replace(/pairplugservice(@|%40)gmail\.com/gi, 'SUPPORT-MAILBOX');
const oldName = /pair\s*plug/i;

test('public, buyer, seller and admin pages show Grailedside and never the old name', async () => {
  const anon = new H.Client(), buyer = await H.newUser('Brand'), seller = await H.newSeller('Brandseller'), adm = await H.newUser('Brandadmin');
  await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', adm.email);
  const id = await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_brand1' });
  const pages = [[anon, ['/', '/shop', '/sellers', '/login', '/register', '/sell', '/contact', '/support', '/terms', '/privacy', '/payments', '/rules', '/legal', '/forgot-password', `/listing/${id}`, `/s/${seller.handle}`]],
    [buyer, ['/account', '/orders', '/following', '/messages', `/listing/${id}`]],
    [seller, ['/dashboard', '/dashboard/inventory', '/dashboard/listings/new', '/dashboard/storefront', '/dashboard/settings', '/dashboard/orders']],
    [adm, ['/admin', '/admin/users', '/admin/sellers', '/admin/applications', '/admin/invitations', '/admin/outbox', '/admin/accounts']]];
  let seen = 0;
  for (const [c, urls] of pages) for (const u of urls) {
    const r = await c.get(u); if (r.status !== 200) continue;            // the point is the wording; access rules are tested elsewhere
    const t = strip(r.text); seen++;
    assert.doesNotMatch(t, oldName, `${u} still shows the old name`);
  }
  assert.ok(seen >= 25, `checked ${seen} pages`);
  const home = (await anon.get('/')).text;
  assert.match(home, /<a class="wordmark" href="\/" aria-label="Grailedside home">Grailedside<\/a>/); assert.match(home, /<title>[^<]*· Grailedside<\/title>/);
  assert.match(home, /Grailedside — The Clothing Marketplace\./); assert.match(home, /Grailedside · The Clothing Marketplace/);
  assert.match(home, /%3EG%3C\/text%3E/, 'favicon letter');
});

test('emails and downloads carry the new name', async () => {
  const u = await H.newUser('Mail'), user = await q.get('SELECT * FROM users WHERE email = ?', u.email);
  await require('../src/accountTokens').sendVerification(user);
  const rows = await q.all('SELECT subject, body FROM email_outbox WHERE to_email = ?', u.email);
  assert.ok(rows.length >= 1, 'a verification message was recorded');
  for (const r of rows) { assert.doesNotMatch(strip(r.subject + r.body), oldName); assert.match(r.subject, /Grailedside/); assert.match(r.body, /for Grailedside:/); }
  const seller = await H.newSeller('Dl'), csv = await seller.get('/api/seller/tax.csv');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition') || '', /grailedside-tax-summary\.csv/);
});
