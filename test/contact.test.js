'use strict';
// Contact page + links, rendering regressions (no leaked template syntax), and the owner's Account Management page.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const M = require('../src/moderation');
const config = require('../src/config');

test.before(() => H.start());
test.after(() => H.stop());

const EMAIL = 'pairplugservice@gmail.com';
const get = async (c, u) => (await c.get(u)).text;
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const mkAdmin = async () => { const a = await H.newUser('Owner'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
const uid = (email) => q.get('SELECT id FROM users WHERE email = ?', email).id;

test('the login page renders a real mailto link (no leaked template syntax) and links to the Contact page', async () => {
  const anon = new H.Client(), html = await get(anon, '/login');
  assert.ok(!html.includes('${'), 'no literal template expression'); assert.doesNotMatch(html, /V\.contactLink/);
  assert.match(html, new RegExp(`<a href="mailto:${EMAIL}">${EMAIL}</a>`)); assert.match(html, /href="\/contact"/); assert.match(html, /href="\/forgot-password"/);
  const reg = await get(anon, '/register'); assert.ok(!reg.includes('${')); assert.match(reg, new RegExp(`mailto:${EMAIL}`)); assert.match(reg, /The Clothing Marketplace/);
});

test('no page leaks template syntax, [object Object], undefined or NaN (public, buyer, seller, moderator and admin views)', async () => {
  const adm = await mkAdmin(), seller = await H.newSeller('Scan'), buyer = await H.newUser('Scan');
  const inv = await adm.post('/api/admin/moderators/invite', { email: `scan${Date.now()}@example.test` }), mod = new H.Client();
  await mod.post('/api/moderator/setup', { token: inv.json.link.split('/').pop(), display_name: 'Scan Mod', password: 'a-very-long-passphrase', terms: true });
  const id = await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_scan1' }); const o = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address });
  const sets = [
    [new H.Client(), ['/', '/shop', '/shop?q=jacket', '/shop?q=jacket&tab=sellers', '/sellers', '/login', '/register', '/contact', '/support', '/legal', '/terms', '/privacy', '/payments', '/rules', '/forgot-password', '/sell', `/listing/${id}`, `/s/${seller.handle}`]],
    [buyer, ['/account', '/orders', `/orders/${String(o.json.redirect).match(/(\d+)/)[1]}`, '/notifications', '/following', '/favorites', '/messages', '/support']],
    [seller, ['/dashboard', '/dashboard/inventory', '/dashboard/orders', '/dashboard/storefront', '/dashboard/listings/new', `/dashboard/listings/${id}/edit`, '/dashboard/analytics', '/dashboard/finance', '/account']],
    [mod, ['/moderation', '/moderation/users?q=Scan', `/moderation/users/${uid(seller.email)}`, '/moderation/log', '/moderation/reviews', '/admin/cases', '/admin/risk']],
    [adm, ['/admin', '/admin/accounts', '/admin/moderators', '/admin/invitations', '/admin/users', '/admin/cases', '/admin/orders', '/admin/audit', '/admin/sellers', '/moderation']],
  ];
  for (const [who, pages] of sets) for (const p of pages) {
    const r = await who.get(p); assert.equal(r.status, 200, `${p} -> ${r.status}`); const v = visible(r.text);
    assert.ok(!v.includes('${'), `${p} leaks "\${"`); for (const m of r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(m[1]), `${p}: inline script must parse`); assert.doesNotMatch(v, /\[object Object\]/, p); assert.doesNotMatch(v.replace(/<[^>]+>/g, ' '), /\bundefined\b|\bNaN\b/, `${p} shows undefined/NaN`);
  }
});

test('the Contact page: email, Email us (mailto), Open Gmail (encoded compose URL), plain address for any client, shopping link', async () => {
  const anon = new H.Client(), r = await anon.get('/contact'); assert.equal(r.status, 200); const html = r.text;
  assert.match(html, /<h1>Contact PairPlug<\/h1>/); assert.match(html, /account access, orders, seller issues, scam and safety reports/);
  assert.match(html, new RegExp(`<a class="btn" href="mailto:${EMAIL}\\?subject=PairPlug%20Support">Email us</a>`));
  assert.match(html, new RegExp(`<a href="mailto:${EMAIL}\\?subject=PairPlug%20Support">${EMAIL}</a>`), 'the address itself is a normal clickable link');
  const gmail = html.match(/href="(https:\/\/mail\.google\.com[^"]+)"[^>]*>Open Gmail/)[1].replaceAll('&amp;', '&'); const u = new URL(gmail);
  assert.equal(u.origin + u.pathname, 'https://mail.google.com/mail/'); assert.equal(u.searchParams.get('view'), 'cm'); assert.equal(u.searchParams.get('fs'), '1'); assert.equal(u.searchParams.get('to'), EMAIL); assert.equal(u.searchParams.get('su'), 'PairPlug Support');
  assert.match(gmail, /to=pairplugservice%40gmail\.com/, 'the @ is URL-encoded'); assert.match(gmail, /su=PairPlug%20Support/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"[^>]*>Open Gmail|rel="noopener noreferrer"[^>]*target="_blank"|target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /Don't use either of those\? Copy the address/); assert.match(html, /class="email-copy">pairplugservice@gmail\.com</, 'works without a configured email app: the address is plain text too');
  assert.match(html, /href="\/shop"[^>]*>← Back to shopping/); assert.match(html, /only open an email draft/); assert.match(html, /does not create a case or ticket automatically/); assert.doesNotMatch(html, /we (have )?sent|message sent|thank you for contacting/i);
  assert.match(html, /name="viewport"/); const css = await get(anon, '/app.css'); assert.match(css, /\.contact-actions\{[^}]*flex-wrap:wrap/); assert.match(css, /\.contact-email\{[^}]*word-break/);
});

test('every Contact link in the header, footer and on sign-in, sign-up, help, legal and invitation pages goes to /contact, with no duplicate or broken routes', async () => {
  const anon = new H.Client();
  for (const p of ['/', '/shop', '/sellers', '/login', '/register', '/support', '/legal', '/terms', '/privacy', '/payments', '/rules', '/contact', '/forgot-password']) {
    const h = await get(anon, p);
    assert.match(h, /<nav class="legal-links"|<footer/); assert.match(h, /<a href="\/contact">Contact<\/a>/, `${p} footer/header Contact link`);
    assert.ok(!/href="mailto:[^"]*"[^>]*>\s*Contact\s*</.test(h), `${p}: no "Contact" link that is a bare mailto`);
    const contacts = [...h.matchAll(/<a [^>]*href="([^"]+)"[^>]*>\s*Contact(?: us)?\s*<\/a>/g)].map((m) => m[1]); for (const href of contacts) assert.equal(href, '/contact', `${p}`);
  }
  assert.equal((await anon.get('/contact')).status, 200); assert.equal((await anon.get('/contact/')).status, 200);
  assert.match(await get(anon, '/login'), /<a href="\/contact">Contact us<\/a>/);
  const adm = await mkAdmin(), inv = await adm.post('/api/admin/invitations', { kind: 'buyer', email: `c${Date.now()}@example.test` });
  assert.match(await get(anon, `/invite/${inv.json.link.split('/').pop()}`), /<a href="\/contact">Contact us<\/a>/);
  // the address lives in one place
  const { spawnSync } = require('node:child_process'), path = require('node:path');
  const files = spawnSync('grep', ['-rl', EMAIL, path.join(__dirname, '..', 'src')], { encoding: 'utf8' }).stdout.trim().split('\n').map((f) => path.basename(f)); assert.deepEqual(files, ['config.js']);
});

// ---------------------------------------------------------------- Account Management
const link = (r) => r.json.link.split('/').pop();
const post = (c, body) => c.post('/api/admin/accounts/invite', body);
const clear = () => { q.run('UPDATE users SET is_moderator = 0 WHERE is_moderator = 1'); q.run("UPDATE moderator_invites SET revoked_at = strftime('%s','now') WHERE used_at IS NULL AND revoked_at IS NULL"); q.run("UPDATE invitations SET revoked_at = strftime('%s','now') WHERE used_at IS NULL AND revoked_at IS NULL"); };

test('Account Management: only the owner/admin can open it or create invitations; everyone else is refused server-side', async () => {
  clear(); const adm = await mkAdmin(), seller = await H.newSeller('Sly'), buyer = await H.newUser('Pal'), inv = await adm.post('/api/admin/moderators/invite', { email: `m${Date.now()}@example.test` });
  const mod = new H.Client(); mod.email = inv.json.link && q.get('SELECT email FROM moderator_invites ORDER BY id DESC LIMIT 1').email; await mod.post('/api/moderator/setup', { token: link(inv), display_name: 'Staff Mod', password: 'a-very-long-passphrase', terms: true });
  const body = { role: 'seller', email: `new${Date.now()}@example.test`, name: 'New Person', confirm: true };
  for (const who of [new H.Client(), buyer, seller, mod]) {
    const s = (await who.get('/admin/accounts')).status; assert.ok([401, 302, 403].includes(s), `page ${s}`);
    for (const role of ['seller', 'moderator', 'buyer']) assert.ok([401, 403].includes((await post(who, { ...body, role })).status), role);
  }
  assert.equal(q.get('SELECT COUNT(*) n FROM users WHERE email = ?', body.email).n, 0); assert.equal(q.get('SELECT COUNT(*) n FROM invitations WHERE email = ?', body.email).n, 0);
  // role self-escalation attempts
  assert.equal((await mod.post(`/api/admin/users/${uid(mod.email)}/admin`, { admin: true, password: 'x' })).status, 403); assert.equal((await seller.req('PATCH', '/api/account', { display_name: 'Sly', is_admin: 1, is_moderator: 1 })).status, 200);
  assert.deepEqual({ ...q.get('SELECT is_admin a, is_moderator m FROM users WHERE email = ?', seller.email) }, { a: 0, m: 0 });
  // CSRF: no custom header, no action
  const raw = await fetch(`${H.base}/api/admin/accounts/invite`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adm.cookie }, body: JSON.stringify(body) }); assert.equal(raw.status, 403);
});

test('Account Management: confirmation required, links are bound to email+role, shown once, never stored/logged in plaintext, not emailed', async () => {
  clear(); const adm = await mkAdmin(), page = await get(adm, '/admin/accounts');
  assert.match(page, /Account management/); assert.match(page, /confirm\(/); assert.match(page, /not emailed/); assert.match(page, /Seller slots used/); assert.match(page, /Moderator slots used/); assert.doesNotMatch(page, /password_hash|scrypt/);
  const email = `seller${Date.now()}@example.test`;
  assert.equal((await post(adm, { role: 'seller', email, name: 'Nina Seller' })).status, 422, 'no confirmation, no invitation'); assert.equal(q.get('SELECT COUNT(*) n FROM invitations WHERE email = ?', email).n, 0);
  assert.equal((await post(adm, { role: 'admin', email, confirm: true })).status, 422, 'admins cannot be created here'); assert.equal((await post(adm, { role: 'seller', email: 'nope', confirm: true })).status, 422);
  const r = await post(adm, { role: 'seller', email: ` ${email.toUpperCase()} `, name: 'Nina Seller', note: 'friend of the owner', confirm: true }); assert.equal(r.status, 200, r.text); assert.equal(r.headers.get('cache-control'), 'no-store');
  const raw = link(r), row = q.get('SELECT * FROM invitations WHERE email = ?', email); assert.equal(row.kind, 'seller'); assert.equal(row.suggested_name, 'Nina Seller'); assert.notEqual(row.token_hash, raw);
  const dump = JSON.stringify([q.all('SELECT * FROM invitations'), q.all('SELECT * FROM audit_log'), q.all('SELECT * FROM email_outbox')]); assert.ok(!dump.includes(raw), 'the token is stored nowhere'); assert.equal(q.get('SELECT COUNT(*) n FROM email_outbox WHERE to_email = ?', email).n, 0, 'nothing was emailed');
  assert.ok(q.get("SELECT 1 x FROM audit_log WHERE action = 'admin_account_invite' AND detail LIKE ?", `%${email}%`)); assert.ok(q.get("SELECT 1 x FROM audit_log WHERE action = 'invitation_created'"));
  const listed = await get(adm, '/admin/accounts'); assert.match(listed, new RegExp(email)); assert.match(listed, /pending/); assert.ok(!listed.includes(raw), 'the link is never shown again');
  // the invited person sets their own password; the suggested name is pre-filled; the account is a seller and nothing more
  const anon = new H.Client(); assert.match(await get(anon, `/invite/${raw}`), /value="Nina Seller"/);
  const body = { token: raw, display_name: 'Nina Seller', password: 'a-long-password-1', store_name: 'Nina Store', handle: 'nina' + Date.now() % 1e5, country: 'US', region: 'NY', city: 'Brooklyn', agree: true, terms: true };
  assert.equal((await anon.post('/api/invitations/accept', body)).status, 200); const u = q.get('SELECT * FROM users WHERE email = ?', email); assert.deepEqual({ s: u.is_seller, a: u.is_admin, m: u.is_moderator }, { s: 1, a: 0, m: 0 });
  assert.equal((await new H.Client().post('/api/invitations/accept', body)).status, 400, 'one-time use'); assert.match(await get(adm, '/admin/accounts'), /used/);
  // duplicates, revocation and expiry
  assert.equal((await post(adm, { role: 'seller', email, confirm: true })).status, 409, 'that seller already exists');
  const e2 = `rev${Date.now()}@example.test`, i2 = await post(adm, { role: 'buyer', email: e2, confirm: true }); assert.equal((await post(adm, { role: 'buyer', email: e2, confirm: true })).status, 409, 'one live link per email');
  const id2 = q.get('SELECT id FROM invitations WHERE email = ?', e2).id; assert.equal((await adm.post(`/api/admin/invitations/${id2}/revoke`, {})).status, 200); assert.equal((await new H.Client().post('/api/invitations/accept', { token: link(i2), display_name: 'Rev Buyer', password: 'a-long-password-1', terms: true })).status, 400);
  const e3 = `exp${Date.now()}@example.test`, i3 = await post(adm, { role: 'buyer', email: e3, confirm: true }); q.run('UPDATE invitations SET expires_at = 5 WHERE email = ?', e3); assert.equal((await new H.Client().post('/api/invitations/accept', { token: link(i3), display_name: 'Old Buyer', password: 'a-long-password-1', terms: true })).status, 400);
});

test('Account Management: moderator links share the five-slot cap, are bound to the moderator role, and creating one never grants admin', async () => {
  clear(); const adm = await mkAdmin(); const made = [];
  for (let i = 0; i < 5; i++) { const r = await post(adm, { role: 'moderator', email: `acm${i}-${Date.now()}@example.test`, name: `Mod ${i}`, confirm: true }); assert.equal(r.status, 200, r.text); made.push(r); }
  const sixth = await post(adm, { role: 'moderator', email: `acm6-${Date.now()}@example.test`, confirm: true }); assert.equal(sixth.status, 409); assert.match(sixth.text, /moderator slots/i);
  assert.equal((await post(adm, { role: 'seller', email: `okseller${Date.now()}@example.test`, confirm: true })).status, 200, 'seller slots are separate');
  assert.match(await get(adm, '/admin/accounts'), /5 \/ 5/);
  const c = new H.Client(); assert.match(await get(c, `/moderator/setup/${link(made[0])}`), /value="Mod 0"/);
  assert.equal((await c.post('/api/moderator/setup', { token: link(made[0]), display_name: 'Mod Zero', password: 'a-very-long-passphrase', terms: true })).status, 200);
  const u = q.get("SELECT is_admin a, is_moderator m, is_seller s FROM users WHERE display_name = 'Mod Zero'"); assert.deepEqual({ ...u }, { a: 0, m: 1, s: 0 });
  assert.equal((await c.get('/admin/accounts')).status, 403); assert.equal((await post(c, { role: 'moderator', email: 'x@example.test', confirm: true })).status, 403, 'a moderator cannot create moderators');
  assert.equal(M.slots().available, 0); const rev = q.get("SELECT id FROM moderator_invites WHERE email LIKE 'acm1-%'").id; assert.equal((await adm.post(`/api/admin/moderators/invites/${rev}/revoke`, {})).status, 200); assert.equal(M.slots().available, 1);
  assert.equal((await new H.Client().post('/api/moderator/setup', { token: link(made[1]), display_name: 'Revoked Mod', password: 'a-very-long-passphrase', terms: true })).status, 400);
});

test('no fake accounts are ever created: a fresh database has no users, and an existing owner keeps working', async () => {
  const { DatabaseSync } = require('node:sqlite'), { MIGRATIONS } = require('../src/db'); const d = new DatabaseSync(':memory:'); for (const m of MIGRATIONS) d.exec(m);
  for (const t of ['users', 'listings', 'orders', 'seller_reviews', 'invitations', 'moderator_invites']) assert.equal(d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} starts empty`); d.close();
  const adm = await mkAdmin(); const before = q.get('SELECT * FROM users WHERE email = ?', adm.email); assert.equal((await new H.Client().post('/api/login', { email: adm.email, password: 'correct-horse-9' })).status, 200);
  await post(adm, { role: 'seller', email: `fine${Date.now()}@example.test`, confirm: true }); const after = q.get('SELECT * FROM users WHERE email = ?', adm.email); assert.equal(after.password_hash, before.password_hash, 'the owner\'s credentials are untouched'); assert.equal(after.is_admin, 1);
  void config;
});
