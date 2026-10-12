'use strict';
// Official support email, the five-slot moderator system, moderator permissions, bans (server-enforced) and their audit trail.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const M = require('../src/moderation');

test.before(async () => await H.start());
test.after(() => H.stop());

const OFFICIAL = 'pairplugservice@gmail.com', LINK = 'https://buy.stripe.com/test_mod1';
const get = async (c, u) => (await c.get(u)).text;
const admin = async () => { const a = await H.newUser('Boss'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
const tokenOf = (link) => link.split('/').pop();
const uid = async (email) => (await q.get('SELECT id FROM users WHERE email = ?', email)).id;
const row = async (id) => await q.get('SELECT * FROM users WHERE id = ?', id);
let n = 0;
/** A moderator who set up their own account through the real link flow. */
async function newMod(adm, name = 'Mod') {
  const email = `mod${++n}-${Date.now()}@example.test`;
  const inv = await adm.post('/api/admin/moderators/invite', { email }); assert.equal(inv.status, 200, inv.text);
  const c = new H.Client(); c.email = email;
  const r = await c.post('/api/moderator/setup', { token: tokenOf(inv.json.link), display_name: `${name} ${n}`, password: 'a-very-long-passphrase', terms: true }); assert.equal(r.status, 200, r.text);
  return c;
}
const clearSlots = async () => { await q.run('UPDATE users SET is_moderator = 0 WHERE is_moderator = 1'); await q.run("UPDATE moderator_invites SET revoked_at = strftime('%s','now') WHERE used_at IS NULL AND revoked_at IS NULL"); };

test('the official support email is the default, clickable, consistent, and honest about what email is', async () => {
  assert.equal(config.supportEmail, OFFICIAL); assert.equal(config.supportEmailOverridden, false);
  const anon = new H.Client(); const pages = ['/support', '/terms', '/privacy', '/payments', '/rules', '/legal', '/register', '/login', '/contact'];
  for (const p of pages) { const h = await get(anon, p); assert.match(h, new RegExp(`href="mailto:${OFFICIAL}`), `${p} has a mailto link`); }
  for (const p of ['/', '/shop', '/sellers', '/login', '/register', '/support', '/terms']) assert.match(await get(anon, p), /href="\/contact"/, `${p} links to the Contact page`);
  const adm = await admin(), inv = await adm.post('/api/admin/invitations', { kind: 'buyer', email: `x${Date.now()}@example.test` });
  assert.match(await get(anon, `/invite/${tokenOf(inv.json.link)}`), new RegExp(`mailto:${OFFICIAL}`));
  const support = (await get(anon, '/support')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(support, /scam and fraud reports/); assert.match(support, /account issues and appeals/); assert.match(support, /does not create a case automatically/); assert.match(support, /no guaranteed response time/);
  const legal = (await get(anon, '/payments')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); assert.match(legal, /do not create a case or ticket automatically/);
  assert.doesNotMatch(support + legal, /we (will )?reply within|respond within \d|ticket (is|will be) (created|opened) automatically/i);
  assert.match((await anon.post('/api/login', { email: 'nobody@example.test', password: 'x' })).text, /Incorrect/); // generic
  // suspended users are told how to appeal
  const u = await H.newUser('Susp'); await q.run('UPDATE users SET banned = 1 WHERE email = ?', u.email); const login = await new H.Client().post('/api/login', { email: u.email, password: 'correct-horse-9' });
  assert.equal(login.status, 403); assert.match(login.text, new RegExp(OFFICIAL));
  // only the code's config holds the address: other source files don't hard-code it
  const grep = spawnSync('grep', ['-rl', OFFICIAL, path.join(__dirname, '..', 'src')], { encoding: 'utf8' }).stdout.trim().split('\n').map((f) => path.basename(f)); assert.deepEqual(grep, ['config.js']);
});

test('SUPPORT_EMAIL can override the default (flagged), and an invalid value falls back to the official address', () => {
  const run = (v) => JSON.parse(spawnSync(process.execPath, ['-e', "const c=require('./src/config');console.log(JSON.stringify({e:c.supportEmail,o:c.supportEmailOverridden}))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PAIRPLUG_DB: ':memory:', SUPPORT_EMAIL: v }, encoding: 'utf8' }).stdout.trim().split('\n').pop());
  assert.deepEqual(run('help@example.org'), { e: 'help@example.org', o: true }); assert.deepEqual(run('not-an-email'), { e: OFFICIAL, o: false }); assert.deepEqual(run(OFFICIAL.toUpperCase()), { e: OFFICIAL.toUpperCase(), o: false });
});

test('nobody can grant themselves moderator or admin rights: registration, invitations, profile, onboarding all ignore role fields', async () => {
  const email = `grab-${Date.now()}@example.test`, c = new H.Client();
  assert.equal((await c.post('/api/register', { email, display_name: 'Grabby', password: 'correct-horse-9', terms: true, is_moderator: 1, is_admin: 1, role: 'moderator' })).status, 200);
  assert.equal((await c.req('PATCH', '/api/account', { display_name: 'Grabby', is_moderator: 1, is_admin: 1 })).status, 200);
  assert.equal((await c.post('/api/sell/onboard', { store_name: 'G', handle: 'grab' + Date.now() % 1e5, country: 'US', region: 'NY', city: 'B', agree: true, is_moderator: 1 })).status < 500, true);
  const adm = await admin(), inv = await adm.post('/api/admin/invitations', { kind: 'seller', email: `s${Date.now()}@example.test` });
  await new H.Client().post('/api/invitations/accept', { token: tokenOf(inv.json.link), display_name: 'Sel', password: 'a-long-password-1', terms: true, agree: true, store_name: 'S', handle: 'sel' + Date.now() % 1e5, country: 'US', region: 'NY', city: 'B', is_moderator: 1 });
  assert.equal((await q.get('SELECT COUNT(*) n FROM users WHERE is_moderator = 1 AND email NOT LIKE ?', 'mod%')).n, 0, 'no ordinary route produced a moderator');
  const g = await row(await uid(email)); assert.equal(g.is_moderator, 0); assert.equal(g.is_admin, 0);
  // the admin-only endpoints are closed to ordinary users and to moderators alike
  const mod = await newMod(adm);
  for (const who of [c, mod]) {
    assert.equal((await who.post('/api/admin/moderators/invite', { email: 'z@example.test' })).status, 403);
    assert.equal((await who.post(`/api/admin/users/${await uid(email)}/admin`, { admin: true, password: 'x' })).status, 403, 'cannot promote anyone');
    assert.equal((await who.post(`/api/admin/moderators/${await uid(mod.email)}/deactivate`, { reason: 'because' })).status, 403);
    assert.equal((await who.post('/api/admin/invitations', { kind: 'buyer', email: 'q@example.test' })).status, 403);
    for (const p of ['/admin', '/admin/moderators', '/admin/invitations', '/admin/users', '/admin/audit']) assert.equal((await who.get(p)).status, 403, p);
  }
  assert.equal((await row(await uid(mod.email))).is_admin, 0);
  assert.equal((await new H.Client().post('/api/admin/moderators/invite', { email: 'a@example.test' })).status, 401);
});

test('exactly five moderator slots: active accounts and unused setup links share them; concurrent attempts cannot exceed five; slots free up on revoke/deactivate/expiry', async () => {
  await clearSlots(); const adm = await admin(); assert.equal((await q.get("SELECT value v FROM settings WHERE key = 'moderator_cap'")).v, '5');
  const emails = Array.from({ length: 8 }, (_, i) => `slot${i}-${Date.now()}@example.test`);
  const res = await Promise.all(emails.map((email) => adm.post('/api/admin/moderators/invite', { email })));
  assert.equal(res.filter((r) => r.status === 200).length, 5, 'exactly five concurrent invitations succeed'); assert.equal(res.filter((r) => r.status === 409).length, 3);
  assert.deepEqual(await M.slots(), { cap: 5, active: 0, pending: 5, available: 0 });
  assert.equal((await adm.post('/api/admin/moderators/invite', { email: `sixth${Date.now()}@example.test` })).status, 409);
  // all five set up at once
  const ok = res.filter((r) => r.status === 200);
  const setups = await Promise.all(ok.map((r, i) => new H.Client().post('/api/moderator/setup', { token: tokenOf(r.json.link), display_name: `Concurrent ${i}`, password: 'a-very-long-passphrase', terms: true })));
  assert.equal(setups.filter((r) => r.status === 200).length, 5); assert.equal((await q.get('SELECT COUNT(*) n FROM users WHERE is_moderator = 1')).n, 5); assert.deepEqual(await M.slots(), { cap: 5, active: 5, pending: 0, available: 0 });
  assert.equal((await adm.post('/api/admin/moderators/invite', { email: `sixth2${Date.now()}@example.test` })).status, 409);
  // the database refuses a sixth even if the application layer were bypassed
  const extra = await H.newUser('Extra'); await assert.rejects(async () => await q.run('UPDATE users SET is_moderator = 1 WHERE email = ?', extra.email), /moderator cap reached/);
  await assert.rejects(async () => await q.run("INSERT INTO users(email, password_hash, display_name, is_moderator, created_at) VALUES('raw@x.test','x','Raw',1,1)"), /moderator cap reached/);
  await assert.rejects(async () => await q.run("INSERT INTO moderator_invites(token_hash, email, created_at, expires_at) VALUES('h','r@x.test',1,9999999999)"), /slots exhausted/);
  // deactivation frees exactly one slot and ends that person's sessions
  const victim = (await q.get('SELECT id FROM users WHERE is_moderator = 1 ORDER BY id LIMIT 1')).id;
  assert.equal((await adm.post(`/api/admin/moderators/${victim}/deactivate`, { reason: '' })).status, 422); assert.equal((await adm.post(`/api/admin/moderators/${victim}/deactivate`, { reason: 'Left the team' })).status, 200);
  assert.equal((await row(victim)).is_moderator, 0); assert.equal((await q.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', victim)).n, 0); assert.equal((await M.slots()).available, 1);
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'moderator_deactivated' AND target_id = ?", String(victim)));
  const again = await adm.post('/api/admin/moderators/invite', { email: `again${Date.now()}@example.test` }); assert.equal(again.status, 200); assert.equal((await M.slots()).available, 0);
  // revoke frees it, expiry frees it
  assert.equal((await adm.post(`/api/admin/moderators/invites/${again.json.id}/revoke`, {})).status, 200); assert.equal((await M.slots()).available, 1);
  const exp = await adm.post('/api/admin/moderators/invite', { email: `exp${Date.now()}@example.test` }); await q.run('UPDATE moderator_invites SET expires_at = ? WHERE id = ?', 1, exp.json.id); assert.equal((await M.slots()).available, 1, 'an expired link no longer holds a slot');
  assert.equal((await new H.Client().post('/api/moderator/setup', { token: tokenOf(exp.json.link), display_name: 'Late One', password: 'a-very-long-passphrase', terms: true })).status, 400);
  assert.match(await get(adm, '/admin/moderators'), /4 \/ 5/);
});

test('setup links: hashed at rest, single-use, expiring, revocable, personal; the invited person picks their own password', async () => {
  await clearSlots(); const adm = await admin(), email = `link-${Date.now()}@example.test`;
  const inv = await adm.post('/api/admin/moderators/invite', { email }), raw = tokenOf(inv.json.link);
  assert.match(raw, /^pp_mod_/); assert.equal(inv.headers.get('cache-control'), 'no-store');
  const st = await q.get('SELECT * FROM moderator_invites WHERE id = ?', inv.json.id); assert.notEqual(st.token_hash, raw); assert.match(st.token_hash, /^[0-9a-f]{64}$/);
  const dump = JSON.stringify([await q.all('SELECT * FROM moderator_invites'), await q.all('SELECT * FROM audit_log'), await q.all('SELECT * FROM users'), await q.all('SELECT * FROM email_outbox')]); assert.ok(!dump.includes(raw), 'the raw token is stored nowhere');
  await assert.rejects(async () => await q.run("UPDATE moderator_invites SET token_hash = 'x' WHERE id = ?", st.id), /immutable/); await assert.rejects(async () => await q.run('DELETE FROM moderator_invites WHERE id = ?', st.id), /never deleted/);
  assert.equal((await adm.post('/api/admin/moderators/invite', { email })).status, 409, 'one live link per email');
  const existing = await H.newUser('Existing'); assert.equal((await adm.post('/api/admin/moderators/invite', { email: existing.email })).status, 409, 'moderator accounts are dedicated');
  const anon = new H.Client(); assert.match(await get(anon, `/moderator/setup/${raw}`), new RegExp(email.replace(/[.+]/g, '\\$&')));
  for (const bad of ['', 'garbage', 'pp_mod_' + 'a'.repeat(32), raw.slice(0, -2) + 'xx', 'pp_inv_' + raw.slice(7)]) assert.equal((await anon.post('/api/moderator/setup', { token: bad, display_name: 'X Y', password: 'a-very-long-passphrase', terms: true })).status, 400, bad);
  // validation failures do not consume the link
  for (const [over, field] of [[{ password: 'short' }, 'password'], [{ terms: false }, 'terms'], [{ display_name: 'x' }, 'display_name']]) { const r = await anon.post('/api/moderator/setup', { token: raw, display_name: 'Pat Mod', password: 'a-very-long-passphrase', terms: true, ...over }); assert.equal(r.status, 422); assert.ok(r.json.fields[field]); }
  assert.equal((await q.get('SELECT used_at FROM moderator_invites WHERE id = ?', st.id)).used_at, null);
  const ok = await anon.post('/api/moderator/setup', { token: raw, display_name: 'Pat Mod', password: 'a-very-long-passphrase', terms: true }); assert.equal(ok.status, 200);
  const u = await q.get('SELECT * FROM users WHERE email = ?', email); assert.equal(u.is_moderator, 1); assert.equal(u.is_admin, 0); assert.equal(u.is_seller, 0); assert.ok(u.terms_accepted_at); assert.equal((await q.get('SELECT used_by FROM moderator_invites WHERE id = ?', st.id)).used_by, u.id);
  assert.equal((await anon.get('/moderation')).status, 200, 'logged in by the setup itself');
  assert.equal((await new H.Client().post('/api/moderator/setup', { token: raw, display_name: 'Other Person', password: 'a-very-long-passphrase', terms: true })).status, 400, 'single use');
  assert.match(await get(new H.Client(), `/moderator/setup/${raw}`), /invalid, expired or already used/);
  assert.equal((await new H.Client().post('/api/login', { email, password: 'a-very-long-passphrase' })).status, 200, 'their own password works');
  // a revoked link is dead
  const inv2 = await adm.post('/api/admin/moderators/invite', { email: `rev-${Date.now()}@example.test` }); await adm.post(`/api/admin/moderators/invites/${inv2.json.id}/revoke`, {});
  assert.equal((await new H.Client().post('/api/moderator/setup', { token: tokenOf(inv2.json.link), display_name: 'Rev Oked', password: 'a-very-long-passphrase', terms: true })).status, 400);
  // an expired link is dead
  const inv3 = await adm.post('/api/admin/moderators/invite', { email: `old-${Date.now()}@example.test` }); await q.run('UPDATE moderator_invites SET expires_at = 5 WHERE id = ?', inv3.json.id);
  assert.equal((await new H.Client().post('/api/moderator/setup', { token: tokenOf(inv3.json.link), display_name: 'Old Link', password: 'a-very-long-passphrase', terms: true })).status, 400);
});

test('the setup command provisions moderators from the server, prints the link once, and refuses a sixth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mod-')), env = { ...process.env, PAIRPLUG_DB: path.join(dir, 'x.db'), PAIRPLUG_UPLOADS: path.join(dir, 'up'), PUBLIC_URL: 'https://example.test' };
  const run = (...a) => spawnSync(process.execPath, ['scripts/moderator.js', ...a], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  try {
    assert.match(run('status').stdout, /0 of 5 used/);
    for (let i = 0; i < 5; i++) { const o = run('invite', '--email', `cli${i}@example.test`); assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /https:\/\/example\.test\/moderator\/setup\/pp_mod_/); assert.doesNotMatch(o.stdout, /password/i); }
    const sixth = run('invite', '--email', 'cli5@example.test'); assert.notEqual(sixth.status, 0); assert.match(sixth.stderr, /All moderator slots are in use/);
    assert.match(run('status').stdout, /5 of 5 used/); assert.doesNotMatch(run('status').stdout, /pp_mod_/, 'status never prints links');
    assert.equal(run('revoke', '--id', '1').status, 0); assert.match(run('status').stdout, /4 of 5 used/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('moderators can search, view and ban/unban with recorded reasons; ban rules and the permission policy are enforced server-side', async () => {
  await clearSlots(); const adm = await admin(), mod = await newMod(adm), mod2 = await newMod(adm), victim = await H.newSeller('Villain'), bystander = await H.newUser('Bystander');
  const vid = await uid(victim.email), cid = (await bystander.post('/api/cases/seller', { handle: victim.handle, reason: 'Took my money, never shipped anything.', category: 'non_delivery' })).json.id;
  await H.makeListing(victim, { payment_url: LINK });
  // interface: search + view show useful but minimal data
  const found = await get(mod, `/moderation/users?q=${encodeURIComponent(victim.handle)}`); assert.match(found, new RegExp(victim.handle)); assert.ok(!found.includes(victim.email), 'full email is not shown'); assert.match(found, /\*\*\*?@example\.test/);
  const page = await get(mod, `/moderation/users/${vid}`); assert.ok(!page.includes(victim.email)); assert.match(page, /Ban account/); assert.match(page, new RegExp(`Case #${cid}`)); assert.match(page, /Listings \(1\)/); assert.doesNotMatch(page, /password_hash|scrypt/);
  // reason is mandatory; policy blocks
  assert.equal((await mod.post(`/api/moderation/users/${vid}/ban`, {})).status, 422); assert.equal((await mod.post(`/api/moderation/users/${vid}/ban`, { reason: 'bad' })).status, 422);
  assert.equal((await mod.post(`/api/moderation/users/${await uid(mod.email)}/ban`, { reason: 'banning myself' })).status, 400);
  assert.equal((await mod.post(`/api/moderation/users/${await uid(mod2.email)}/ban`, { reason: 'banning a fellow moderator' })).status, 403); assert.equal((await mod.post(`/api/moderation/users/${await uid(adm.email)}/ban`, { reason: 'banning an administrator' })).status, 403);
  assert.equal((await mod.post(`/api/moderation/users/${vid}/ban`, { reason: 'Linked case', caseId: 999999 })).status, 404);
  assert.equal((await row(vid)).banned, 0);
  // the one-click ban
  const sessionBefore = (await q.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', vid)).n; assert.ok(sessionBefore > 0);
  const ordersBefore = (await q.get('SELECT COUNT(*) n FROM orders')).n, casesBefore = (await q.get('SELECT COUNT(*) n FROM cases')).n, evBefore = (await q.get('SELECT COUNT(*) n FROM case_events')).n;
  const ban = await mod.post(`/api/moderation/users/${vid}/ban`, { reason: 'Multiple buyers report non-delivery', caseId: cid }); assert.equal(ban.status, 200, ban.text); assert.equal(ban.json.paused, 1);
  const u = await row(vid); assert.equal(u.banned, 1); assert.equal(u.banned_by, await uid(mod.email)); assert.equal(u.banned_reason, 'Multiple buyers report non-delivery'); assert.ok(u.banned_at);
  assert.equal((await q.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', vid)).n, 0);
  const act = await q.get('SELECT * FROM moderation_actions WHERE target_id = ? ORDER BY id DESC LIMIT 1', vid); assert.deepEqual({ a: act.actor_id, r: act.actor_role, act: act.action, c: act.case_id, why: act.reason }, { a: await uid(mod.email), r: 'moderator', act: 'ban', c: cid, why: 'Multiple buyers report non-delivery' }); assert.ok(act.created_at);
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'moderation_ban' AND target_id = ?", String(vid))); assert.ok(await q.get("SELECT 1 x FROM case_events WHERE case_id = ? AND internal = 1 AND body LIKE 'ban %'", cid));
  assert.equal((await mod.post(`/api/moderation/users/${vid}/ban`, { reason: 'ban them again please' })).status, 409);
  // nothing was deleted
  assert.equal((await q.get('SELECT COUNT(*) n FROM orders')).n, ordersBefore); assert.equal((await q.get('SELECT COUNT(*) n FROM cases')).n, casesBefore); assert.ok((await q.get('SELECT COUNT(*) n FROM case_events')).n > evBefore); assert.ok(await row(vid), 'the account still exists'); assert.equal((await q.get('SELECT COUNT(*) n FROM listings WHERE seller_id = ?', vid)).n, 1);
  assert.match(await get(mod, `/moderation/users/${vid}`), /Reason: Multiple buyers report non-delivery/); assert.match(await get(mod, `/moderation/users/${vid}`), /Unban account/);
  // permissions on lifting
  assert.equal((await bystander.post(`/api/moderation/users/${vid}/unban`, { reason: 'I am nobody' })).status, 403);
  assert.equal((await mod2.post(`/api/moderation/users/${vid}/unban`, {})).status, 422);
  assert.equal((await mod2.post(`/api/moderation/users/${vid}/unban`, { reason: 'Reviewed evidence, mistaken identity' })).status, 200, 'a moderator may lift a moderator-placed ban');
  assert.equal((await row(vid)).banned, 0); assert.deepEqual((await q.all('SELECT action, actor_role FROM moderation_actions WHERE target_id = ? ORDER BY id', vid)).map((x) => x.action), ['ban', 'unban']);
  // admin-placed (and legacy) bans can only be lifted by an administrator
  await adm.post(`/api/moderation/users/${vid}/ban`, { reason: 'Administrator decision after review' }); assert.equal((await q.get('SELECT actor_role r FROM moderation_actions ORDER BY id DESC LIMIT 1')).r, 'admin');
  assert.equal((await mod.post(`/api/moderation/users/${vid}/unban`, { reason: 'trying to undo an admin' })).status, 403); assert.match(await get(mod, `/moderation/users/${vid}`), /only an administrator can lift it/);
  assert.equal((await adm.post(`/api/moderation/users/${vid}/unban`, { reason: 'Appeal accepted' })).status, 200);
  await q.run('UPDATE users SET banned = 1 WHERE id = ?', vid); assert.equal((await mod.post(`/api/moderation/users/${vid}/unban`, { reason: 'legacy ban, unknown origin' })).status, 403, 'bans from before the log are admin-only to lift'); await q.run('UPDATE users SET banned = 0 WHERE id = ?', vid);
  // restrict / lift by a moderator
  assert.equal((await mod.post(`/api/moderation/users/${vid}/restrict`, { reason: 'Hold while investigating', caseId: cid })).status, 200); assert.ok((await row(vid)).selling_restricted_at);
  assert.equal((await mod.post(`/api/moderation/users/${vid}/restrict`, { reason: 'Hold while investigating' })).status, 409); assert.equal((await mod.post(`/api/moderation/users/${vid}/lift`, { reason: 'Cleared after review' })).status, 200); assert.equal((await row(vid)).selling_restricted_at, null);
  // an admin may ban a moderator; a banned moderator loses all access immediately
  assert.equal((await adm.post(`/api/moderation/users/${await uid(mod2.email)}/ban`, { reason: 'Compromised credentials suspected' })).status, 200);
  assert.equal((await mod2.get('/moderation')).status === 200, false); assert.equal((await mod2.post(`/api/moderation/users/${vid}/ban`, { reason: 'still moderating?' })).status, 401);
  // the legacy admin ban endpoint also needs a reason now and shares the same log
  const t = await H.newUser('Legacy'); assert.equal((await adm.post(`/api/admin/users/${await uid(t.email)}/ban`, { banned: true })).status, 422); assert.equal((await adm.post(`/api/admin/users/${await uid(t.email)}/ban`, { banned: true, reason: 'Spam accounts' })).status, 200); assert.equal((await q.get('SELECT action FROM moderation_actions ORDER BY id DESC LIMIT 1')).action, 'ban');
});

test('a ban is enforced on the server across login, sessions, listings, purchases, payment redirects, messaging and the moderation tools', async () => {
  await clearSlots(); const adm = await admin(), mod = await newMod(adm);
  // banned SELLER: existing orders/pending buyers, listings, public pages
  const seller = await H.newSeller('BanSeller'), buyer = await H.newUser('Buyer'), id = await H.makeListing(seller, { payment_url: LINK });
  const o = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); const oid = Number(String(o.json.redirect).match(/(\d+)/)[1]);
  const second = await H.makeListing(seller, { payment_url: LINK, title: 'Another one' });
  assert.equal((await mod.post(`/api/moderation/users/${await uid(seller.email)}/ban`, { reason: 'Fraud ring member per case review' })).status, 200);
  assert.equal((await seller.get('/dashboard')).status, 302, 'old session is dead'); assert.equal((await seller.post('/api/seller/listings', { title: 'x' })).status, 401); assert.equal((await seller.get('/api/chat/sync')).status, 401);
  assert.equal((await new H.Client().post('/api/login', { email: seller.email, password: 'correct-horse-9' })).status, 403, 'cannot log in again');
  const fresh = await H.newUser('Cust'); assert.equal((await fresh.post('/api/purchases', { listingId: second, acknowledged: true, address: H.address })).status >= 400, true, 'no new purchases');
  assert.notEqual((await buyer.get(`/orders/${oid}/pay`)).status, 302, 'PairPlug stops sending buyers to the banned seller\'s payment link'); assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', oid)).status, 'pending_payment');
  assert.equal((await fresh.post('/api/chat/conversations', { listingId: second })).status >= 400, true, 'cannot start a conversation about a banned seller\'s listing');
  assert.equal((await new H.Client().get(`/s/${seller.handle}`)).status, 404); assert.equal((await fresh.post(`/api/sellers/${seller.handle}/follow`)).status, 404);
  assert.equal((await q.get("SELECT COUNT(*) n FROM listings WHERE seller_id = ? AND status = 'active'", await uid(seller.email))).n, 0);
  assert.match((await buyer.get('/notifications')).text, /Please do not pay for this order yet/);
  // banned BUYER: nothing works with the old session
  const b2 = await H.newUser('BanBuyer'), l2 = await H.makeListing(await H.newSeller('Other'), { payment_url: LINK });
  assert.equal((await mod.post(`/api/moderation/users/${await uid(b2.email)}/ban`, { reason: 'Abusive messages to sellers' })).status, 200);
  for (const [m, u, body] of [['post', '/api/purchases', { listingId: l2, acknowledged: true, address: H.address }], ['post', '/api/chat/conversations', { listingId: l2 }], ['post', '/api/cases/seller', { handle: seller.handle, reason: 'banned user reports' }], ['post', `/api/sellers/${seller.handle}/follow`, {}]]) assert.equal((await b2[m](u, body)).status, 401, u);
  // client-side tampering has no effect: no role/state field is trusted from the request
  assert.equal((await b2.req('PATCH', '/api/account', { display_name: 'Still Banned', banned: 0 })).status, 401); assert.equal((await q.get('SELECT banned FROM users WHERE id = ?', await uid(b2.email))).banned, 1);
  // ordinary users and anonymous visitors cannot use the moderation tools
  const plain = await H.newUser('Plain');
  for (const who of [plain, new H.Client()]) { for (const p of ['/moderation', '/moderation/users?q=ab', `/moderation/users/${await uid(seller.email)}`, '/moderation/log', '/admin/cases', '/admin/risk']) assert.ok([401, 302, 403].includes((await who.get(p)).status), p);
    for (const a of ['ban', 'unban', 'restrict', 'lift']) assert.ok([401, 403].includes((await who.post(`/api/moderation/users/${await uid(buyer.email)}/${a}`, { reason: 'I want to' })).status)); }
  assert.equal((await row(await uid(buyer.email))).banned, 0);
  // CSRF: a state-changing request without the custom header is refused
  const raw = await fetch(`${H.base}/api/moderation/users/${await uid(buyer.email)}/ban`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: mod.cookie }, body: JSON.stringify({ reason: 'cross-site forgery attempt' }) });
  assert.equal(raw.status, 403); assert.equal((await row(await uid(buyer.email))).banned, 0);
});

test('every moderation action is auditable and the logs cannot be rewritten; moderators handle cases but not provider packets or refunds', async () => {
  await clearSlots(); const adm = await admin(), mod = await newMod(adm), s = await H.newSeller('Cased'), b = await H.newUser('Reporter');
  const cid = (await b.post('/api/cases/seller', { handle: s.handle, reason: 'Possible scam: fake tracking numbers.', category: 'fake_payment_or_tracking' })).json.id;
  // moderators work cases: view (incl. internal notes), note, reply, decide
  const page = await get(mod, `/admin/cases/${cid}`); assert.match(page, /Case #/); assert.match(page, /Ban account/); assert.ok(!/Payment-provider report/.test(page), 'provider packets are administrator-only');
  assert.equal((await mod.post(`/api/admin/cases/${cid}/note`, { body: 'INTERNAL: pattern matches earlier ring' })).status, 200); assert.equal((await mod.post(`/api/admin/cases/${cid}/reply`, { body: 'Thanks, we are looking into it.' })).status, 200);
  assert.ok(!(await get(b, `/cases/${cid}`)).includes('INTERNAL: pattern'), 'internal notes are hidden from the reporter'); assert.match(await get(mod, `/admin/cases/${cid}`), /INTERNAL: pattern/);
  assert.equal((await mod.post(`/api/admin/cases/${cid}/action`, { action: 'suspend_seller' })).status, 422, 'a reason is required to ban from a case');
  assert.equal((await mod.post(`/api/admin/cases/${cid}/action`, { action: 'restrict_selling', reason: 'Hold pending review' })).status, 200);
  assert.equal((await mod.post(`/api/admin/cases/${cid}/processor-packet`, { provider: 'stripe' })).status, 403); assert.equal((await mod.post('/api/admin/refunds/1/resolve', { outcome: 'closed', note: 'nope nope' })).status, 403);
  assert.equal((await mod.post(`/api/admin/cases/${cid}/decide`, { outcome: 'resolved', resolution: 'Seller restricted; reporter informed.' })).status, 200);
  assert.equal((await b.post(`/api/admin/cases/${cid}/note`, { body: 'reporter tries staff route' })).status, 403);
  // audit: actor, target, action, reason, time, case
  const acts = await q.all('SELECT * FROM moderation_actions WHERE case_id = ?', cid); assert.equal(acts.length, 1); assert.equal(acts[0].actor_id, await uid(mod.email)); assert.equal(acts[0].target_id, await uid(s.email)); assert.equal(acts[0].action, 'restrict_selling'); assert.equal(acts[0].reason, 'Hold pending review');
  for (const a of ['moderation_restrict_selling', 'case_decided']) assert.ok(await q.get('SELECT 1 x FROM audit_log WHERE action = ? AND actor_id = ?', a, await uid(mod.email)), a);
  await assert.rejects(async () => await q.run("UPDATE moderation_actions SET reason = 'rewritten history' WHERE id = ?", acts[0].id), /append-only/); await assert.rejects(async () => await q.run('DELETE FROM moderation_actions WHERE id = ?', acts[0].id), /append-only/);
  await assert.rejects(async () => await q.run("UPDATE audit_log SET action = 'x' WHERE actor_id = ?", await uid(mod.email)), /append-only/); await assert.rejects(async () => await q.run('DELETE FROM audit_log WHERE actor_id = ?', await uid(mod.email)), /append-only/);
  await assert.rejects(async () => await q.run("INSERT INTO moderation_actions(actor_id, actor_role, target_id, action, reason, created_at) VALUES(1,'moderator',1,'ban','no',1)"), /CHECK/);
  assert.match(await get(mod, '/moderation/log'), /restrict selling/); assert.match(await get(mod, '/moderation'), /Recent actions/);
  // a moderator is not shown admin-only navigation, and cannot read the admin audit page
  assert.doesNotMatch(await get(mod, '/moderation'), /href="\/admin\/moderators"/); assert.equal((await mod.get('/admin/audit')).status, 403);
});

test('policies describe the staff roles accurately', async () => {
  const t = (await get(new H.Client(), '/privacy')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(t, /moderators/i); assert.match(t, /masked email/i); assert.match(t, /Administrators/);
});

test('migration 13 is additive: existing users keep their roles; nobody becomes a moderator', () => {
  const { DatabaseSync } = require('node:sqlite'), { MIGRATIONS } = require('../src/db'); assert.ok(MIGRATIONS.length >= 13);
  const d = new DatabaseSync(':memory:'); for (let i = 0; i < 12; i++) d.exec(MIGRATIONS[i]);
  d.prepare('INSERT INTO users(email, password_hash, display_name, is_admin, banned, created_at) VALUES(?,?,?,?,?,?)').run('a@x.test', 'x', 'A', 1, 0, 1); d.prepare('INSERT INTO users(email, password_hash, display_name, banned, created_at) VALUES(?,?,?,?,?)').run('b@x.test', 'x', 'B', 1, 1);
  d.exec(MIGRATIONS[12]); const us = d.prepare('SELECT email, is_admin, banned, is_moderator, banned_by, banned_reason FROM users ORDER BY id').all();
  assert.deepEqual(us.map((u) => [u.email, u.is_admin, u.banned, u.is_moderator, u.banned_by, u.banned_reason]), [['a@x.test', 1, 0, 0, null, null], ['b@x.test', 0, 1, 0, null, null]]);
  assert.equal(d.prepare("SELECT value v FROM settings WHERE key = 'moderator_cap'").get().v, '5'); d.close();
});
