'use strict';
// Administrator setup/reset CLI, forced password change, password security, and local-development email preview (+ production safeguards).
process.env.CHECKOUT_MODE = 'external';
process.env.SELLER_ONBOARDING = 'invite';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(() => H.start());
test.after(() => H.stop());

const ROOT = path.resolve(__dirname, '..');
function cli(args, extra = {}) {
  try { return { code: 0, out: execFileSync(process.execPath, ['scripts/create-admin.js', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, PAIRPLUG_DB: process.env.PAIRPLUG_DB, PAIRPLUG_UPLOADS: process.env.PAIRPLUG_UPLOADS, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }; }
  catch (e) { return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
}
const tempPassword = (out) => (out.match(/^\s{4}(\S{16,})$/m) || [])[1];
const login = async (email, password) => { const c = new H.Client(); const r = await c.post('/api/login', { email, password }); return { c, r }; };

test('admin setup: status with no admin, secure first-run creation with a one-time random temporary password', async () => {
  assert.match(cli(['status']).out, /No administrator exists yet/);
  assert.equal(cli(['setup']).code, 1, 'an email is required');
  assert.equal(cli(['setup', '--email', 'not-an-email']).code, 1);
  const a = cli(['setup', '--email', 'Owner@Example.test']); assert.equal(a.code, 0, a.err);
  const pw = tempPassword(a.out); assert.ok(pw && pw.length >= 20, 'a strong generated password is shown once');
  assert.match(a.out, /Administrator account: owner@example\.test/); assert.match(a.out, /ADMINISTRATOR login/);
  const row = q.get('SELECT * FROM users WHERE email = ?', 'owner@example.test');
  assert.equal(row.is_admin, 1); assert.equal(row.must_change_password, 1); assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes(pw));
  const dump = JSON.stringify(q.all('SELECT * FROM audit_log')); assert.ok(!dump.includes(pw), 'the password is not in the audit log');
  assert.equal(q.all("SELECT 1 FROM audit_log WHERE action = 'admin_created'").length, 1);
  // each run produces a different password (nothing hard-coded)
  const second = cli(['reset', '--email', 'owner@example.test']); assert.notEqual(tempPassword(second.out), pw);
  assert.equal((await login('owner@example.test', pw)).r.status, 401, 'the previous temporary password stopped working');
  // setup refuses to create a second admin and points to reset
  const again = cli(['setup', '--email', 'other@example.test']); assert.equal(again.code, 1); assert.match(again.err, /already exists: owner@example\.test/); assert.match(again.err, /reset --email owner@example\.test/);
  assert.match(cli(['status']).out, /owner@example\.test.*must be changed/);
});

test('temporary password forces a change: nothing else works until the Account password is changed; other sessions are signed out', async () => {
  const out = cli(['reset', '--email', 'owner@example.test']).out, pw = tempPassword(out);
  const { c, r } = await login('owner@example.test', pw); assert.equal(r.status, 200);
  const other = (await login('owner@example.test', pw)).c;
  assert.equal((await c.get('/admin')).status, 302); assert.equal((await c.get('/admin')).headers.get('location'), '/account');
  assert.equal((await c.get('/shop')).status, 302);
  const api = await c.post('/api/admin/settings', {}); assert.equal(api.status, 403); assert.equal(api.json.mustChangePassword, true);
  const acct = await c.get('/account'); assert.equal(acct.status, 200); assert.match(acct.text, /Your password is temporary/);
  assert.equal((await c.post('/api/account/password', { current: 'nope-nope-nope', next: 'a-brand-new-passphrase-1' })).status, 403, 'current password required');
  assert.equal((await c.post('/api/account/password', { current: pw, next: 'short' })).status, 422);
  assert.equal((await c.post('/api/account/password', { current: pw, next: pw })).status, 422, 'must differ');
  assert.equal((await c.post('/api/account/password', { current: pw, next: 'a-brand-new-passphrase-1' })).status, 200);
  assert.equal(q.get('SELECT must_change_password m FROM users WHERE email = ?', 'owner@example.test').m, 0);
  assert.equal((await c.get('/admin')).status, 200, 'admin works after the change');
  assert.equal((await other.get('/account')).status, 302, 'other sessions were invalidated');
  assert.equal((await login('owner@example.test', pw)).r.status, 401); assert.equal((await login('owner@example.test', 'a-brand-new-passphrase-1')).r.status, 200);
  assert.ok(q.all("SELECT 1 FROM audit_log WHERE action = 'password_changed'").length >= 1);
});

test('reset and promote: operator-chosen passwords are never echoed; reset signs everyone out; weak passwords and unknown accounts are refused', async () => {
  assert.equal(cli(['reset', '--email', 'ghost@example.test']).code, 1);
  const user = await H.newUser('Plain');
  assert.equal(cli(['reset', '--email', user.email]).code, 1, 'reset only applies to administrators');
  assert.equal(cli(['promote', '--email', user.email]).code, 0);
  assert.equal(q.get('SELECT is_admin a FROM users WHERE email = ?', user.email).a, 1);
  assert.equal(cli(['promote', '--email', user.email]).code, 1);
  assert.equal(cli(['reset', '--email', user.email], { ADMIN_PASSWORD: 'short' }).code, 1);
  const chosen = cli(['reset', '--email', user.email], { ADMIN_PASSWORD: 'my-own-long-passphrase' });
  assert.equal(chosen.code, 0); assert.doesNotMatch(chosen.out, /my-own-long-passphrase/); assert.equal(q.get('SELECT must_change_password m FROM users WHERE email = ?', user.email).m, 0);
  assert.equal((await user.get('/account')).status, 302, 'old session ended');
  assert.equal((await login(user.email, 'my-own-long-passphrase')).r.status, 200);
  assert.equal(cli(['bogus']).code, 1);
});

test('password change hashes with scrypt, needs the current password, and signs out other sessions (buyers too)', async () => {
  const a = await H.newUser('Pw'), b = new H.Client(); await b.post('/api/login', { email: a.email, password: 'correct-horse-9' });
  assert.equal((await a.post('/api/account/password', { current: 'wrong-wrong-1', next: 'another-long-passphrase-2' })).status, 403);
  assert.equal((await a.post('/api/account/password', { current: 'correct-horse-9', next: 'another-long-passphrase-2' })).status, 200);
  assert.match(q.get('SELECT password_hash h FROM users WHERE email = ?', a.email).h, /^scrypt\$/);
  assert.equal((await a.get('/account')).status, 200); assert.equal((await b.get('/account')).status, 302);
});

test('local email verification: recorded email preview works in development, still needs the real token step, and cannot bypass the seller gate', async () => {
  const adm = await H.newUser('Adm'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', adm.email);
  const inv = await adm.post('/api/admin/invitations', { kind: 'seller', email: `devseller-${Date.now()}@example.test` });
  const s = new H.Client(); const email = q.get('SELECT email FROM invitations ORDER BY id DESC LIMIT 1').email;
  assert.equal((await s.post('/api/invitations/accept', { token: inv.json.link.split('/').pop(), display_name: 'Dev Seller', password: 'a-long-password-1', store_name: 'Dev Store', handle: 'devstore', country: 'US', region: 'NY', city: 'B', agree: true, terms: true })).status, 200);
  assert.equal(q.get('SELECT email_verified_at v FROM users WHERE email = ?', email).v, null);
  // an unverified seller cannot publish
  const file = await H.upload(s);
  const body = { title: 'Wool sweater', description: 'x', category: 'clothing', condition: 'good', size: 'M', price: '30.00', shipping: '5.00', shipping_payer: 'buyer', weight_oz: 20, images: [file], status: 'active' };
  const blocked = await s.post('/api/seller/listings', body); assert.equal(blocked.status, 403); assert.match(blocked.json.error, /Verify your email/);
  assert.equal(q.get("SELECT COUNT(*) n FROM listings WHERE title = 'Wool sweater' AND status = 'active' AND seller_id = (SELECT id FROM users WHERE email = ?)", email).n, 0);
  // development preview shows the recorded message with its link, only to its recipient
  await s.post('/api/email/resend');
  const prev = await s.get('/dev/emails'); assert.equal(prev.status, 200); assert.match(prev.text, /Local development only/);
  const link = (prev.text.match(/href="(https?:\/\/[^"]*\/verify-email\?token=[^"]+)"/) || [])[1]; assert.ok(link, 'verification link is shown');
  assert.equal((await H.newUser('Snoop').then((u) => u.get('/dev/emails'))).text.includes(email), false, 'others cannot read it');
  assert.equal((await new H.Client().get('/dev/emails')).status, 302, 'login required');
  // opening the link does not verify; the button (POST) does, exactly like a real email
  const url = link.replace(/^https?:\/\/[^/]+/, '').replace(/&amp;/g, '&');
  assert.equal((await s.get(url)).status, 200); assert.equal(q.get('SELECT email_verified_at v FROM users WHERE email = ?', email).v, null);
  assert.equal((await s.post('/api/email/verify', { token: url.split('token=')[1] })).status, 200);
  assert.ok(q.get('SELECT email_verified_at v FROM users WHERE email = ?', email).v);
  assert.equal((await s.post('/api/seller/listings', body)).status, 200, 'verified seller can publish');
});

test('safeguards: a configured email provider switches the development preview off, and no env flag can enable it', async () => {
  const u = await H.newUser('Prod'); await u.post('/api/email/resend');
  assert.equal((await u.get('/dev/emails')).status, 200);
  const email = require('../src/email');       // (the real NODE_ENV=production process check lives in test/prelaunch.test.js)
  email.setMockProvider(async () => ({ id: 'm' }));
  try { assert.equal((await u.get('/dev/emails')).status, 404, 'real provider configured'); } finally { email.setMockProvider(null); }
  // there is no environment switch for it: the route is gated purely on NODE_ENV/provider
  const src = require('node:fs').readFileSync(path.join(ROOT, 'src/routes/account.js'), 'utf8');
  assert.doesNotMatch(src, /process\.env\.[A-Z_]*(DEV|BYPASS|VERIFY)/);
});
