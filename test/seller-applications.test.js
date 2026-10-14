'use strict';
// Self-service seller access: buyer applies -> admin approves/rejects -> seller lists; free, no seller limit or waitlist, race-proof; no privilege from client input.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const config = require('../src/config');

const keepMode = config.sellerOnboarding;
test.before(async () => { await H.start(); config.sellerOnboarding = 'invite'; });        // production behaviour: instant dev onboarding is off
test.after(async () => { config.sellerOnboarding = keepMode; await H.stop(); });

const LINK = 'https://buy.stripe.com/test_apply1';
let n = 0;
const store = () => { n++; return { store_name: `Apply Store ${n}`, handle: `apply${n}x${Date.now() % 100000}`, country: 'US', region: 'NY', city: 'Brooklyn', agree: true }; };
const mkAdmin = async () => { const a = await H.newUser('Owner'); await q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
const row = async (c) => await q.get('SELECT * FROM users WHERE email = ?', c.email);
const apply = (c, over = {}) => c.post('/api/sell/apply', { ...store(), ...over });
const sellers = async () => Number((await q.get('SELECT COUNT(*) n FROM users WHERE is_seller = 1')).n);
const decide = (admin, id, what, body = {}) => admin.post(`/api/admin/applications/${id}/${what}`, body);
const appOf = async (c) => await q.get('SELECT * FROM seller_applications WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1', c.email);

test.beforeEach(async () => { await q.run("UPDATE seller_applications SET status = 'withdrawn' WHERE status = 'pending'"); });   // each test starts with an empty queue
const newSeller = async (name) => { config.sellerOnboarding = 'open'; try { return await H.newSeller(name); } finally { config.sellerOnboarding = 'invite'; } };   // fixture only

test('FLOW: new buyer -> requests seller access -> admin approves -> seller publishes a listing (free, no email verification, no contact with the owner)', async () => {
  const admin = await mkAdmin(), c = new H.Client(), email = `newbuyer${Date.now()}@example.test`;
  assert.equal((await c.post('/api/register', { email, display_name: 'New Buyer', password: 'a-long-password-1', terms: true })).status, 200); c.email = email;
  assert.equal((await q.get('SELECT is_seller, email_verified_at FROM users WHERE email = ?', email)).is_seller, 0);
  const form = (await c.get('/sell')).text; assert.match(form, /name="store_name"/); assert.match(form, /Free to list|free/i); assert.doesNotMatch(form, /card number|billing|subscribe|Coming Soon!/i);
  const before = await c.post('/api/seller/listings', { title: 'x', status: 'active' }); assert.ok([401, 403, 404].includes(before.status), 'not a seller yet: ' + before.status);
  assert.notEqual((await c.get('/dashboard')).status, 200, 'seller dashboard is closed to buyers');
  const r = await apply(c, { is_seller: 1, is_admin: 1, role: 'admin', plan: 'pro' }); assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'pending');
  assert.deepEqual([(await row(c)).is_seller, (await row(c)).is_admin], [0, 0], 'applying grants nothing; client-sent roles are ignored');
  assert.match((await c.get('/sell')).text, /Waiting for review/);
  const a = await appOf(c); assert.equal((await decide(admin, a.id, 'approve')).status, 200);
  const u = await row(c); assert.deepEqual([u.is_seller, u.is_admin, u.handle, u.email_verified_at], [1, 0, a.handle, null]);
  assert.ok(await q.get("SELECT 1 x FROM notifications WHERE user_id = ? AND title LIKE 'You can sell%'", u.id), 'the applicant is told in the app');
  assert.ok(await q.get("SELECT 1 x FROM audit_log WHERE action = 'seller_application_approved'"));
  const id = await H.makeListing(c, { payment_url: LINK, price: '30.00' });                      // create + publish: free, unverified email
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'active');
  assert.equal((await c.get('/sell')).status, 302, 'sellers go to their dashboard'); assert.equal((await apply(c)).status, 409, 'already a seller');
  const buyer = await H.newUser('Shopper'); assert.match((await buyer.get(`/listing/${id}`)).text, /Buy now/); assert.equal((await buyer.get('/shop')).status, 200);
});

test('rejection: a reason is required and shown to the applicant, who can apply again; duplicates and withdrawal behave', async () => {
  const admin = await mkAdmin(), c = await H.newUser('Rej');
  assert.equal((await apply(c, { store_name: '' })).status, 422); assert.equal((await apply(c, { handle: 'a b' })).status, 422); assert.equal((await apply(c, { country: 'FR' })).status, 422); assert.equal((await apply(c, { agree: false })).status, 422);
  const r1 = await apply(c); assert.equal(r1.status, 200);
  assert.equal((await apply(c)).status, 409, 'no duplicate open requests'); const dup = await Promise.all([apply(c), apply(c)]); assert.deepEqual(dup.map((d) => d.status).sort(), [409, 409]);
  assert.equal(Number((await q.get("SELECT COUNT(*) n FROM seller_applications WHERE user_id = (SELECT id FROM users WHERE email = ?) AND status = 'pending'", c.email)).n), 1);
  const a = await appOf(c);
  assert.equal((await decide(admin, a.id, 'reject', { reason: 'no' })).status, 422);
  assert.equal((await decide(admin, a.id, 'reject', { reason: 'We need photos of your inventory first.' })).status, 200);
  assert.equal((await decide(admin, a.id, 'reject', { reason: 'second time' })).status, 409); assert.equal((await decide(admin, a.id, 'approve')).status, 409, 'decided once');
  assert.equal((await row(c)).is_seller, 0); const page = (await c.get('/sell')).text; assert.match(page, /not approved/); assert.match(page, /We need photos of your inventory first/); assert.match(page, /name="store_name"/);
  assert.ok(await q.get("SELECT 1 x FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = ?) AND title LIKE 'Seller request not approved%'", c.email));
  const again = await apply(c); assert.equal(again.status, 200, 'may ask again'); assert.equal((await c.post('/api/sell/apply/withdraw')).status, 200); assert.equal((await c.post('/api/sell/apply/withdraw')).status, 404);
  assert.equal((await apply(c)).status, 200, 'and again after withdrawing');
});

test('only an administrator decides: anonymous, applicants, buyers, sellers and moderators are refused; nothing changes', async () => {
  const c = await H.newUser('Cand'), other = await H.newUser('Other'), seller = await newSeller('S'), mod = await H.newUser('Mod'); await q.run('UPDATE users SET is_moderator = 1 WHERE email = ?', mod.email);
  await apply(c); const a = await appOf(c);
  for (const [who, cl] of [['anon', new H.Client()], ['applicant', c], ['buyer', other], ['seller', seller], ['moderator', mod]]) {
    for (const what of ['approve', 'reject']) { const r = await decide(cl, a.id, what, { reason: 'because I can do it' }); assert.ok([401, 403].includes(r.status), `${who} ${what}: ${r.status}`); }
    assert.ok([302, 401, 403].includes((await cl.get('/admin/applications')).status), `${who} page`);
  }
  assert.equal((await new H.Client().post('/api/sell/apply', store())).status, 401, 'must be signed in to apply');
  assert.deepEqual([(await row(c)).is_seller, (await appOf(c)).status], [0, 'pending']);
  assert.equal((await mkAdmin().then((ad) => ad.get('/admin/applications'))).status, 200);
});

test('no cap, no waitlist: onboarding keeps working with 10, 50 and 100 existing sellers', async () => {
  const admin = await mkAdmin();
  for (const target of [10, 50, 100]) {
    const missing = target - await sellers();
    if (missing > 0) await q.run(`INSERT INTO users(email, password_hash, display_name, is_seller, handle, store_name, country, created_at)
      SELECT 'bulk' || g || '-${target}@x.test', 'x', 'Bulk', 1, 'bulk' || g || 'x${target}', 'Bulk Store', 'US', 1 FROM generate_series(1, ${missing}) g`);
    assert.ok(await sellers() >= target);
    const c = await H.newUser('Late' + target), r = await apply(c);
    assert.equal(r.status, 200, `${target} sellers: ${r.text}`); assert.equal(r.json.status, 'pending');
    assert.doesNotMatch((await c.get('/sell')).text, /waitlist|capacity|no spots|\bis full\b/i);
    assert.equal((await decide(admin, r.json.id, 'approve')).status, 200, `${target} sellers: approval is not blocked`);
    assert.equal((await row(c)).is_seller, 1);
  }
  assert.ok(await sellers() > 100);
});

test('CONCURRENT: parallel approvals of one request and parallel applications are safe', async () => {
  const admin = await mkAdmin(), c = await H.newUser('Dup');
  const dup = await Promise.all(Array.from({ length: 5 }, () => apply(c)));
  assert.equal(dup.filter((d) => d.status === 200).length, 1, JSON.stringify(dup.map((d) => d.status)));
  const a = await appOf(c);
  const res = await Promise.all(Array.from({ length: 4 }, () => decide(admin, a.id, 'approve')));
  assert.equal(res.filter((r) => r.status === 200).length, 1, JSON.stringify(res.map((r) => r.status)));
  assert.equal((await row(c)).is_seller, 1);
});

test('pending and rejected applicants cannot use seller-only functions; buyers cannot promote themselves', async () => {
  const admin = await mkAdmin(), pend = await H.newUser('Pend'), rej = await H.newUser('Rejd'), file = await H.upload(pend);
  await apply(pend); await apply(rej); await decide(admin, (await appOf(rej)).id, 'reject', { reason: 'Not enough information.' });
  for (const c of [pend, rej]) {
    for (const url of ['/dashboard', '/dashboard/inventory', '/dashboard/listings/new', '/dashboard/storefront', '/dashboard/settings']) assert.notEqual((await c.get(url)).status, 200, url);
    const r = await c.post('/api/seller/listings', { title: 'Sneaky', description: 'x', price: '10.00', category: 'tops', condition: 'good', photos: [file], status: 'active' });
    assert.ok([401, 403].includes(r.status), 'create listing: ' + r.status);
    for (const [m, u, b] of [['put', '/api/seller/settings', { payment_url: LINK }], ['put', '/api/seller/storefront', {}], ['post', '/api/sell/onboard', { ...store(), terms: true }], ['post', '/api/register', { is_seller: 1 }]]) assert.ok([400, 401, 403, 404, 409, 422].includes((await c[m](u, b)).status), `${u}`);
    assert.equal((await row(c)).is_seller, 0);
  }
  await pend.req('PATCH', '/api/account', { display_name: 'Still Buyer', is_seller: 1, is_admin: 1, role: 'admin' });
  assert.equal((await row(pend)).is_seller, 0);
  assert.equal((await row(pend)).is_admin, 0);
});

test('existing sellers and admins keep their access; an approved applicant is not an admin or moderator', async () => {
  const admin = await mkAdmin(), old = await newSeller('Old'), c = await H.newUser('Newbie');
  await apply(c); await decide(admin, (await appOf(c)).id, 'approve');
  assert.equal((await old.get('/dashboard')).status, 200); assert.equal((await c.get('/dashboard')).status, 200);
  assert.equal((await admin.get('/admin')).status, 200); assert.notEqual((await c.get('/admin')).status, 200, 'approved sellers are not admins');
  const u = await row(c); assert.deepEqual([u.is_admin, u.is_moderator], [0, 0]);
  const id = await H.makeListing(old, { payment_url: LINK, price: '19.00' });
  const buyer = await H.newUser('B'); const page = (await buyer.get(`/listing/${id}`)).text;
  assert.match(page, /19\.00/); assert.match(page, /Buy now/);
  assert.equal(config.sellerOnboarding, 'invite');
});

test('anonymous visitors cannot apply, and need an account first; banned applicants are not approvable; instant onboarding stays closed', async () => {
  const anon = new H.Client(), page = (await anon.get('/sell')).text;
  assert.equal((await anon.post('/api/sell/apply', store())).status, 401);
  assert.doesNotMatch(page, /name="store_name"/, 'no form without an account'); assert.match(page, /account/i);
  const admin = await mkAdmin(), c = await H.newUser('Bad'); await apply(c); const a = await appOf(c);
  await q.run('UPDATE users SET banned = 1 WHERE email = ?', c.email); const r = await decide(admin, a.id, 'approve'); assert.equal(r.status, 409); assert.equal((await row(c)).is_seller, 0);
  assert.equal((await (await H.newUser('Insta')).post('/api/sell/onboard', { ...store(), terms: true })).status, 403, 'the instant onboarding endpoint stays closed');
});
