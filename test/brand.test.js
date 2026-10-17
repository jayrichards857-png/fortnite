'use strict';
// Brand: customers see "Grailedside" and the support address grailedside@gmail.com. The old name survives only in internal identifiers
// (header/env/db-value names), which are never rendered to customers.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => await H.start());
test.after(() => H.stop());

const strip = (t) => t.replace(/<script[\s\S]*?<\/script>/g, '');
const oldName = /pair\s*plug/i, SUPPORT = 'grailedside@gmail.com';

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

test('support address and subject: footer, contact, support and legal pages use grailedside@gmail.com with Grailedside Support', async () => {
  const anon = new H.Client(), pages = {};
  for (const u of ['/', '/contact', '/support', '/terms', '/privacy', '/payments', '/rules', '/legal']) { const r = await anon.get(u); assert.equal(r.status, 200, u); pages[u] = r.text; }
  const all = Object.values(pages).join('\n');
  assert.match(all, /mailto:grailedside@gmail\.com\?subject=Grailedside%20Support/); assert.match(all, /to=grailedside%40gmail\.com&(?:amp;)?su=Grailedside%20Support/);
  assert.match(pages['/contact'], /class="email-copy">grailedside@gmail\.com</);
  for (const u of ['/contact', '/terms', '/privacy']) assert.match(pages[u], /grailedside@gmail\.com/, u);
  const addrs = new Set((all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi) || []).map((a) => a.toLowerCase()));
  assert.deepEqual([...addrs], [SUPPORT], 'the only email address shown anywhere is the official one');
  assert.equal(require('../src/config').officialSupportEmail, SUPPORT);
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
