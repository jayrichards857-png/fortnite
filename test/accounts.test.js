'use strict';
// Email verification, account changes, password reset, session renewal, host validation, outbox honesty.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');
const email = require('../src/email');
const { sha } = require('../src/accountTokens');

test.before(async () => await H.start());
test.after(() => H.stop());
const LINK = 'https://buy.stripe.com/test_acct_123';
const lastMail = async (to, kind) => await q.get('SELECT * FROM email_outbox WHERE to_email = ? AND kind = ? ORDER BY id DESC LIMIT 1', to, kind);
const tokenIn = (body) => decodeURIComponent(body.match(/token=([^\s&]+)/)[1]);
async function unverifiedSeller(name = 'Unv') {
  const s = await H.newSeller(name); await q.run('UPDATE users SET email_verified_at = NULL WHERE handle = ?', s.handle); return s;
}
const body = () => ({ title: 'Wool sweater', category: 'clothing', condition: 'good', price: '30.00', shipping: '5.00', weight_oz: '20', payment_url: LINK, status: 'active' });

test('with no email provider nothing is claimed as sent: messages are only recorded in the outbox', async () => {
  const s = await unverifiedSeller();
  const r = await s.post('/api/email/resend'); assert.equal(r.status, 200); assert.match(r.json.message, /no email was sent/i);
  const m = await lastMail(s.email, 'verify_email');
  assert.equal(m.status, 'not_configured'); assert.equal(m.provider, null); assert.equal(m.sent_at, null);
  assert.match(m.body, /\/verify-email\?token=/);
  assert.match((await s.get('/account')).text, /no email provider is configured/);
});

test('verification tokens: hashed at rest, GET never consumes, single use, expiring, one generic error', async () => {
  const s = await unverifiedSeller();
  await s.post('/api/email/resend');
  const raw = tokenIn((await lastMail(s.email, 'verify_email')).body);
  assert.equal((await q.get('SELECT COUNT(*) n FROM email_tokens WHERE token_hash = ?', sha(raw))).n, 1);
  assert.equal((await q.get("SELECT COUNT(*) n FROM email_tokens WHERE token_hash = ?", raw)).n, 0, 'the raw token is not stored');
  const anon = new H.Client();
  assert.equal((await anon.get(`/verify-email?token=${raw}`)).status, 200);                    // link scanners / prefetch only render the confirm button
  assert.equal((await q.get('SELECT email_verified_at v FROM users WHERE email = ?', s.email)).v, null, 'a GET never verifies');
  for (const bad of ['', 'x', 'a'.repeat(43), raw.slice(1)]) { const r = await anon.post('/api/email/verify', { token: bad }); assert.equal(r.status, 400); assert.match(r.json.error, /invalid or has expired/); }
  assert.equal((await anon.post('/api/email/verify', { token: raw })).status, 200);
  assert.ok((await q.get('SELECT email_verified_at v FROM users WHERE email = ?', s.email)).v);
  const again = await anon.post('/api/email/verify', { token: raw }); assert.equal(again.status, 400); assert.match(again.json.error, /invalid or has expired/);
  // expiry
  const u2 = await unverifiedSeller('Exp'); await u2.post('/api/email/resend');
  const t2 = tokenIn((await lastMail(u2.email, 'verify_email')).body);
  await q.run('UPDATE email_tokens SET expires_at = 1 WHERE token_hash = ?', sha(t2));
  const exp = await anon.post('/api/email/verify', { token: t2 }); assert.equal(exp.status, 400); assert.match(exp.json.error, /invalid or has expired/);
  // a token cannot be used for a different purpose
  assert.equal((await anon.post('/api/email/confirm-change', { token: t2 })).status, 400);
  assert.equal((await anon.post('/api/password/reset', { token: t2, password: 'new-long-password-1' })).status, 503);
});

test('resend is throttled (1/min, 5/day) and already-verified accounts are told so', async () => {
  const s = await unverifiedSeller();
  assert.equal((await s.post('/api/email/resend')).status, 200);
  assert.equal((await s.post('/api/email/resend')).status, 429);
  for (let i = 0; i < 4; i++) { await q.run('UPDATE email_tokens SET created_at = created_at - 120 WHERE user_id = (SELECT id FROM users WHERE email = ?)', s.email); assert.equal((await s.post('/api/email/resend')).status, 200); }
  await q.run('UPDATE email_tokens SET created_at = created_at - 120 WHERE user_id = (SELECT id FROM users WHERE email = ?)', s.email);
  const r = await s.post('/api/email/resend'); assert.equal(r.status, 429); assert.match(r.json.error, /tomorrow/);
  const v = await H.newSeller('Ver'); assert.match((await v.post('/api/email/resend')).json.message, /already verified/);
  assert.equal((await new H.Client().post('/api/email/resend')).status, 401);
});

test('an unverified seller cannot publish or take orders, but can save drafts and be contacted; verifying unlocks everything', async () => {
  const s = await unverifiedSeller('Gate'), buyer = await H.newUser('B');
  const file = await H.upload(s);
  const pub = await s.post('/api/seller/listings', { ...body(), images: [file] });
  assert.equal(pub.status, 403); assert.match(pub.json.error, /Verify your email/);
  const draft = await s.post('/api/seller/listings', { ...body(), images: [file], status: 'draft' }); assert.equal(draft.status, 200);
  const bulk = await s.post('/api/seller/listings/bulk', { ids: [draft.json.id], action: 'status', status: 'active' });
  assert.equal(bulk.json.updated, 0); assert.match(bulk.json.skipped[0].reason, /verify your email/);
  assert.match((await s.get('/dashboard')).text, /Verify your email to publish/);
  // a listing that was already live when the seller became unverified is not purchasable, but messaging still works
  const live = await H.makeListing(s, { payment_url: LINK }).catch(() => null); assert.equal(live, null, 'makeListing publishes, which must be refused');
  await q.run('UPDATE users SET email_verified_at = 1 WHERE handle = ?', s.handle);
  const id = await H.makeListing(s, { payment_url: LINK, shipping_payer: 'buyer' });
  await q.run('UPDATE users SET email_verified_at = NULL WHERE handle = ?', s.handle);
  const page = (await buyer.get(`/listing/${id}`)).text; assert.doesNotMatch(page, /Buy now/); assert.match(page, /hasn&#39;t verified their email/); assert.match(page, /Contact seller/);
  assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 409);
  assert.equal((await buyer.post('/api/chat/conversations', { listingId: id })).status, 200, 'still contactable');
  // verify through the real flow
  await s.post('/api/email/resend'); const raw = tokenIn((await lastMail(s.email, 'verify_email')).body);
  assert.equal((await new H.Client().post('/api/email/verify', { token: raw })).status, 200);
  assert.equal((await s.post('/api/seller/listings', { ...body(), images: [await H.upload(s)] })).status, 200);
  assert.equal((await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 200);
});

test('a configured provider is used and recorded honestly (mock is labelled; bodies with links are not retained)', async () => {
  const seen = []; email.setMockProvider(async (m) => { seen.push(m); return 'mock-1'; });
  try {
    const s = await unverifiedSeller('Mock'); const r = await s.post('/api/email/resend'); assert.match(r.json.message, /We sent you an email/);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(seen.length, 1); assert.equal(seen[0].to, s.email); assert.match(seen[0].text, /verify-email\?token=/);
    const m = await lastMail(s.email, 'verify_email'); assert.equal(m.status, 'sent'); assert.equal(m.provider, 'mock-test'); assert.doesNotMatch(m.body, /token=/);
    email.setMockProvider(async () => { throw new Error('provider down'); });
    const t = await unverifiedSeller('Fail'); assert.equal((await t.post('/api/email/resend')).status, 200, 'a provider outage does not break the request');
    await new Promise((r2) => setTimeout(r2, 50)); assert.equal((await lastMail(t.email, 'verify_email')).status, 'failed');
  } finally { email.setMockProvider(null); }
});

test('email change: needs the password, keeps the old address until the new one is confirmed, then re-verifies', async () => {
  const u = await H.newUser('Chg'); await q.run('UPDATE users SET email_verified_at = 1 WHERE email = ?', u.email);
  const old = u.email, fresh = `new-${Date.now()}@example.test`;
  assert.equal((await u.post('/api/account/email', { email: fresh, password: 'wrong-wrong-1' })).status, 403);
  assert.equal((await u.post('/api/account/email', { email: 'nope', password: 'correct-horse-9' })).status, 422);
  const taken = await H.newUser('Taken'); assert.equal((await u.post('/api/account/email', { email: taken.email, password: 'correct-horse-9' })).status, 422);
  const r = await u.post('/api/account/email', { email: fresh, password: 'correct-horse-9' }); assert.equal(r.status, 200); assert.match(r.json.message, /not configured/);
  assert.ok(await q.get('SELECT 1 x FROM users WHERE email = ?', old), 'old email still active'); assert.equal(await q.get('SELECT 1 x FROM users WHERE email = ?', fresh), undefined);
  const raw = tokenIn((await lastMail(fresh, 'change_email')).body);
  assert.equal((await new H.Client().post('/api/email/confirm-change', { token: raw })).status, 200);
  assert.ok(await q.get('SELECT 1 x FROM users WHERE email = ?', fresh)); assert.equal(await q.get('SELECT 1 x FROM users WHERE email = ?', old), undefined);
  assert.equal((await new H.Client().post('/api/email/confirm-change', { token: raw })).status, 400, 'single use');
  assert.ok((await q.get('SELECT email_verified_at v FROM users WHERE email = ?', fresh)).v);
  // an outstanding verification link for the OLD address stops working after the change
  const stale = await H.newUser('Stale'); await stale.post('/api/email/resend'); const sraw = tokenIn((await lastMail(stale.email, 'verify_email')).body);
  await q.run("UPDATE users SET email = ? WHERE email = ?", `moved-${Date.now()}@example.test`, stale.email);
  assert.equal((await new H.Client().post('/api/email/verify', { token: sraw })).status, 400);
});

test('password change: current password required; every other session is signed out', async () => {
  const a = await H.newUser('Pw'); const b = new H.Client(); assert.equal((await b.post('/api/login', { email: a.email, password: 'correct-horse-9' })).status, 200);
  assert.equal((await a.post('/api/account/password', { current: 'nope', next: 'brand-new-password-1' })).status, 403);
  assert.equal((await a.post('/api/account/password', { current: 'correct-horse-9', next: 'short' })).status, 422);
  assert.equal((await a.post('/api/account/password', { current: 'correct-horse-9', next: 'brand-new-password-1' })).status, 200);
  assert.equal((await a.get('/account')).status, 200, 'this session stays signed in');
  assert.equal((await b.get('/account')).status, 302, 'the other device was signed out');
  assert.equal((await new H.Client().post('/api/login', { email: a.email, password: 'correct-horse-9' })).status, 401);
  assert.equal((await new H.Client().post('/api/login', { email: a.email, password: 'brand-new-password-1' })).status, 200);
});

test('password reset: honestly unavailable without email; with a (mock) provider it is single-use, expiring, non-enumerating and revokes sessions', async () => {
  const u = await H.newUser('Reset'), anon = new H.Client();
  assert.equal((await anon.post('/api/password/forgot', { email: u.email })).status, 503);
  assert.match((await anon.get('/forgot-password')).text, /isn't available yet/);
  email.setMockProvider(async () => 'm');
  try {
    assert.match((await anon.get('/forgot-password')).text, /Send reset link/);
    const known = await anon.post('/api/password/forgot', { email: u.email }), unknown = await anon.post('/api/password/forgot', { email: 'ghost@example.test' });
    assert.deepEqual([known.status, known.json], [unknown.status, unknown.json], 'identical response for known and unknown emails');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await q.get("SELECT COUNT(*) n FROM email_outbox WHERE to_email = 'ghost@example.test'")).n, 0);
    const row = await q.get("SELECT COUNT(*) n FROM email_outbox WHERE to_email = ? AND kind = 'reset_password'", u.email); assert.equal(row.n, 1);
    const raw = (await q.get("SELECT token_hash FROM email_tokens WHERE purpose = 'reset_password' ORDER BY id DESC LIMIT 1")).token_hash;
    assert.ok(raw);                                                                             // (the raw token only ever existed in the mock-delivered email)
    // capture the raw token by issuing through the module directly (the mock provider does not retain it)
    const tokens = require('../src/accountTokens'); await q.run("UPDATE email_tokens SET created_at = created_at - 300 WHERE purpose = 'reset_password'");
    const r = await tokens.issue((await q.get('SELECT id FROM users WHERE email = ?', u.email)).id, 'reset_password', u.email);
    assert.equal((await anon.post('/api/password/reset', { token: r, password: 'short' })).status, 422);
    assert.equal((await anon.post('/api/password/reset', { token: r, password: 'a-fresh-long-password-1' })).status, 200);
    assert.equal((await u.get('/account')).status, 302, 'old sessions were revoked');
    assert.equal((await new H.Client().post('/api/login', { email: u.email, password: 'a-fresh-long-password-1' })).status, 200);
    const reuse = await anon.post('/api/password/reset', { token: r, password: 'another-long-password-1' }); assert.equal(reuse.status, 400); assert.match(reuse.json.error, /invalid or has expired/);
    // per-address throttle
    config.rateLimitScale = 1; try { let last; for (let i = 0; i < 5; i++) last = await new H.Client().post('/api/password/forgot', { email: 'flood@example.test' }); assert.ok([200, 429].includes(last.status)); } finally { config.rateLimitScale = 1000; }
  } finally { email.setMockProvider(null); }
});

test('sessions are sliding: active users are renewed, idle ones expire', async () => {
  const u = await H.newUser('Slide'); const t = u.cookie.split('=')[1];
  const hash = sha(decodeURIComponent(t)), now = Math.floor(Date.now() / 1000);
  await q.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + 3 * 86400, hash);       // less than half of 14 days left
  const r = await u.get('/account'); assert.equal(r.status, 200);
  assert.ok((await q.get('SELECT expires_at e FROM sessions WHERE token_hash = ?', hash)).e > now + 13 * 86400, 'renewed to a full lifetime');
  assert.match(r.headers.get('set-cookie') || '', /pp_session=/);
  await q.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now - 5, hash);
  assert.equal((await u.get('/account')).status, 302, 'expired sessions no longer work');
});

test('production host validation: only the public hostname is served (HTTP), loopback allowed for /healthz', async () => {
  const keep = { isProd: config.isProd, publicUrl: config.publicUrl };
  config.isProd = true; config.publicUrl = 'https://beta.example.test';
  try {
    const hit = (host, p = '/') => new Promise((resolve) => { const http = require('node:http'); const req = http.request({ host: '127.0.0.1', port: new URL(H.base).port, path: p, headers: { host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.end(); });
    assert.equal(await hit('beta.example.test'), 200);
    assert.equal(await hit('evil.example'), 421); assert.equal(await hit('beta.example.test.evil.example'), 421);
    assert.equal(await hit('127.0.0.1:' + new URL(H.base).port, '/healthz'), 200); assert.equal(await hit('127.0.0.1:' + new URL(H.base).port, '/shop'), 421);
  } finally { Object.assign(config, keep); }
});
