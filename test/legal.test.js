'use strict';
// Legal pages: routes, links on the right screens, honest wording, recorded (never assumed) acceptance, and privacy of the data the policies describe.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { q } = require('../src/db');
const LEGAL = require('../src/legal');

test.before(() => H.start());
test.after(() => H.stop());

const LINK = 'https://buy.stripe.com/test_legal1';
const PAGES = ['/terms', '/privacy', '/payments', '/rules'];
const get = async (c, u) => (await c.get(u)).text;
const admin = async () => { const a = await H.newUser('Admin'); q.run('UPDATE users SET is_admin = 1 WHERE email = ?', a.email); return a; };
const user = (email) => q.get('SELECT * FROM users WHERE email = ?', email);
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('legal pages are public, versioned, linked from the global footer on desktop and mobile layouts, and old paths redirect', async () => {
  const anon = new H.Client();
  const idx = await anon.get('/legal'); assert.equal(idx.status, 200); for (const p of PAGES) assert.match(idx.text, new RegExp(`href="${p}"`));
  for (const p of PAGES) { const r = await anon.get(p); assert.equal(r.status, 200, p); assert.match(r.text, new RegExp(`Version ${LEGAL.VERSION}`)); assert.match(r.text, /<h1>/); assert.match(r.text, /name="viewport"/); }
  assert.equal((await anon.get('/refunds')).status, 301); assert.equal((await anon.get('/prohibited')).status, 301);
  for (const page of ['/', '/shop', '/login', '/register', '/sellers', '/support', '/terms']) { const h = await get(anon, page); for (const p of PAGES) assert.match(h, new RegExp(`<nav class="legal-links"[^]*href="${p}"`), `${page} footer links ${p}`); }
  const buyer = await H.newUser('Footer'); assert.match(await get(buyer, '/account'), /href="\/privacy"/);
  const css = await get(anon, '/app.css'); assert.match(css, /\.legal-links/, 'footer links are styled'); assert.match(css, /flex-wrap:wrap/);
});

test('the policies say what is true: direct payments, no custody, seller-handled refunds, no invented business details or compliance claims', async () => {
  const anon = new H.Client(), all = {}; for (const p of PAGES) all[p] = text(await get(anon, p)); const joined = Object.values(all).join(' ');
  assert.match(all['/payments'], /you pay the seller directly/i); assert.match(all['/payments'], /does not hold or process the payment/i); assert.match(all['/payments'], /not proof of payment/i);
  assert.match(all['/payments'], /seller decides and issues refunds/i); assert.match(all['/payments'], /chargebacks/i); assert.match(all['/payments'], /force a seller to refund/i);
  assert.match(all['/payments'], /seller's statement, not a check by PairPlug/i);
  assert.match(all['/terms'], /not the seller of the items/i); assert.match(all['/terms'], /rights you have under consumer-protection law/i);
  assert.match(all['/rules'], /counterfeit/i); assert.match(all['/rules'], /stolen/i); assert.match(all['/rules'], /does not authenticate/i);
  assert.match(all['/privacy'], /no self-service download or delete/i); assert.match(all['/privacy'], /do not strip|do not use advertising|not strip/i); assert.match(all['/privacy'], /pp_session/);
  assert.match(all['/privacy'], /Search terms/); assert.match(all['/privacy'], /at least 3 searches/); assert.match(all['/privacy'], /30 days/);
  // nothing fabricated: no address/entity unless configured, no regulatory or certification claims, no "guarantee/escrow/protection" promises PairPlug doesn't make
  assert.match(all['/terms'], /registered business name and mailing address have not been published yet/i);
  assert.doesNotMatch(joined, /\b(GDPR|CCPA|PIPEDA|SOC ?2|PCI|ISO ?27001|HIPAA)\b[^.]{0,40}(compliant|certified|compliance)/i); assert.doesNotMatch(joined, /we are (fully )?compliant|certified|bank-level|military-grade|100% secure/i);
  assert.doesNotMatch(joined, /buyer protection (program|guarantee)|money-back guarantee|PairPlug (will refund|holds your)/i);
  assert.doesNotMatch(joined, /@[a-z0-9-]+\.(com|net|org|io)\b/i, 'no email address is invented'); assert.doesNotMatch(joined, /\b\d{2,5} [A-Z][a-z]+ (Street|St|Ave|Avenue|Road|Rd)\b/);
});

test('contact details appear only when the operator configured them', async () => {
  const config = require('../src/config'), keep = { ...config }; const anon = new H.Client();
  config.supportEmail = 'help@pairplug.example'; config.legalEntity = 'Example Goods LLC'; config.legalAddress = '1 Example Way, Austin, TX';
  try { const t = await get(anon, '/terms'), p = await get(anon, '/privacy'); assert.match(t, /Example Goods LLC/); assert.match(t, /1 Example Way/); assert.match(p, /mailto:help@pairplug\.example/); assert.doesNotMatch(t, /have not been published yet/); }
  finally { config.supportEmail = keep.supportEmail; config.legalEntity = keep.legalEntity; config.legalAddress = keep.legalAddress; }
  assert.doesNotMatch(await get(anon, '/terms'), /Example Goods/);
});

test('sign-up needs an explicit tick; acceptance is recorded with version and time; failed attempts create nothing', async () => {
  const anon = new H.Client(); const page = await get(anon, '/register');
  assert.match(page, /name="terms"/); assert.match(page, /href="\/terms"/); assert.match(page, /href="\/privacy"/); assert.match(page, /href="\/payments"/);
  const email = `consent-${Date.now()}@example.test`, base = { email, display_name: 'Consent Person', password: 'correct-horse-9' };
  for (const bad of [{}, { terms: false }, { terms: 'on' }, { terms: 1 }]) { const r = await new H.Client().post('/api/register', { ...base, ...bad }); assert.equal(r.status, 422, JSON.stringify(bad)); assert.ok(r.json.fields && r.json.fields.terms, 'field error is shown against the checkbox'); }
  assert.equal(user(email), undefined, 'a refused sign-up creates no account');
  const before = Math.floor(Date.now() / 1000), ok = await new H.Client().post('/api/register', { ...base, terms: true }); assert.equal(ok.status, 200);
  const u = user(email); assert.equal(u.terms_version, LEGAL.VERSION); assert.ok(u.terms_accepted_at >= before - 1 && u.terms_accepted_at <= before + 5);
});

test('existing users are never silently marked as accepted; accepting is their own explicit action; nothing is blocked meanwhile', async () => {
  const email = `legacy-${Date.now()}@example.test`; const { hashPassword } = require('../src/auth');
  q.run('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)', email, hashPassword('correct-horse-9'), 'Legacy User', 1700000000);
  assert.equal(user(email).terms_version, null); assert.equal(user(email).terms_accepted_at, null);
  const c = new H.Client(); c.email = email; assert.equal((await c.post('/api/login', { email, password: 'correct-horse-9' })).status, 200);
  const acct = await get(c, '/account'); assert.match(acct, /haven&#39;t recorded acceptance|haven't recorded acceptance/); assert.match(acct, /nothing is blocked/i);
  await get(c, '/shop'); await get(c, '/orders'); assert.equal(user(email).terms_version, null, 'logging in and browsing does not record acceptance');
  // checkout is not gated by a new consent box
  const seller = await H.newSeller('LegalSeller'), id = await H.makeListing(seller, { payment_url: LINK }), buy = await get(c, `/buy/${id}`);
  assert.doesNotMatch(buy, /name="terms"/); assert.match(buy, /name="acknowledged"/); assert.match(buy, /href="\/payments"/);
  const r = await c.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, 'a user who never accepted can still buy');
  assert.equal((await new H.Client().post('/api/account/terms')).status, 401);
  assert.equal((await c.post('/api/account/terms')).status, 200); const u = user(email); assert.equal(u.terms_version, LEGAL.VERSION); assert.ok(u.terms_accepted_at);
  assert.match(await get(c, '/account'), new RegExp(`accepted version <strong>${LEGAL.VERSION}</strong>`));
  q.run("UPDATE users SET terms_version = '2020-01-01' WHERE email = ?", email); assert.match(await get(c, '/account'), /earlier version \(2020-01-01\)/, 'an older acceptance is not treated as accepting the new version');
  assert.equal(q.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'terms_accepted'").n >= 1, true);
});

test('invitations: new accounts must tick the terms (nothing is consumed on refusal); sellers also see the Seller Rules', async () => {
  const adm = await admin(), anon = new H.Client();
  const mk = async (kind, email) => (await adm.post('/api/admin/invitations', { kind, email })).json.link.split('/').pop();
  const tok = await mk('seller', `inv-${Date.now()}@example.test`), form = await get(anon, `/invite/${tok}`);
  assert.match(form, /name="terms"/); assert.match(form, /href="\/rules"/); assert.match(form, /name="agree"/);
  const b = { token: tok, display_name: 'Invited Seller', password: 'a-long-password-1', store_name: 'Inv Store', handle: `inv${Date.now() % 100000}`, country: 'US', region: 'NY', city: 'Brooklyn', agree: true };
  const no = await anon.post('/api/invitations/accept', b); assert.equal(no.status, 422); assert.ok(no.json.fields.terms);
  assert.equal(q.get('SELECT used_at FROM invitations WHERE token_hash IS NOT NULL ORDER BY id DESC LIMIT 1').used_at, null, 'the invitation is still usable');
  assert.equal((await anon.post('/api/invitations/accept', { ...b, terms: true })).status, 200);
  const u = q.get('SELECT * FROM users WHERE handle = ?', b.handle); assert.equal(u.terms_version, LEGAL.VERSION); assert.equal(u.is_seller, 1);
  // an existing buyer who never accepted is asked at the invitation; one who already accepted the current version is not asked again
  const old = await H.newUser('OldBuyer'); q.run('UPDATE users SET terms_version = NULL, terms_accepted_at = NULL WHERE email = ?', old.email);
  const t2 = await mk('seller', old.email); assert.match(await get(old, `/invite/${t2}`), /name="terms"/);
  assert.equal((await old.post('/api/invitations/accept', { ...b, token: t2, handle: `old${Date.now() % 100000}` })).status, 422);
  const fresh = await H.newUser('NewBuyer'), t3 = await mk('seller', fresh.email); assert.doesNotMatch(await get(fresh, `/invite/${t3}`), /name="terms"/, 'already accepted the current version');
});

test('policy links appear on listing and checkout screens, and the pages describe privacy accurately', async () => {
  const seller = await H.newSeller('RulesSeller'), buyer = await H.newUser('Pol'), id = await H.makeListing(seller, { payment_url: LINK });
  const editor = await get(seller, '/dashboard/listings/new'); assert.match(editor, /href="\/rules"/); assert.match(editor, /href="\/payments"/);
  const buy = await get(buyer, `/buy/${id}`); assert.match(buy, /href="\/payments"/); assert.match(buy, /href="\/terms"/); assert.match(buy, /href="\/privacy"/); assert.match(buy, /doesn't hold or refund my payment/);
  const o = await buyer.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(o.status, 200);
  const oid = Number(String(o.json.redirect).match(/(\d+)/)[1]);
  // privacy statements, checked against the real pages: the seller does not see the address until they confirm payment; admins' lists don't show it
  const pend = await get(seller, `/dashboard/orders/${oid}`); assert.doesNotMatch(pend, new RegExp(H.address.line1), 'address hidden from the seller until payment is confirmed');
  assert.equal((await seller.post(`/api/seller/orders/${oid}/confirm-payment`, {})).status, 200); assert.match(await get(seller, `/dashboard/orders/${oid}`), new RegExp(H.address.line1));
  assert.match(await get(buyer, `/orders/${oid}`), new RegExp(H.address.line1));
  const stranger = await H.newUser('Stranger'); assert.notEqual((await stranger.get(`/orders/${oid}`)).status, 200); assert.notEqual((await stranger.get(`/dashboard/orders/${oid}`)).status, 200);
  const adm = await admin(); assert.doesNotMatch(await get(adm, '/admin/orders'), new RegExp(H.address.line1));
});

test('public profiles, discovery and search never expose private account data', async () => {
  const seller = await H.newSeller('PrivSeller'), anon = new H.Client(); q.run("UPDATE users SET bio = 'Selling vintage denim' WHERE handle = ?", seller.handle);
  const row = q.get('SELECT * FROM users WHERE handle = ?', seller.handle); const secrets = [seller.email, row.password_hash];
  for (const u of [`/s/${seller.handle}`, '/sellers', '/', '/shop?q=denim&tab=sellers', '/shop?q=denim']) { const h = await get(anon, u); for (const s of secrets) assert.ok(!h.includes(s), `${u} leaks private data`); assert.doesNotMatch(h, /terms_version|terms_accepted_at/); }
  const buyer = await H.newUser('Priv'); assert.ok(!(await get(anon, `/s/${buyer.email}`)).includes(buyer.email));
  const sr = q.get('SELECT COUNT(*) n FROM search_log WHERE term LIKE ?', `%${seller.email.slice(0, 6)}%`).n; assert.equal(sr, 0);
  assert.deepEqual(Object.keys(q.get('SELECT * FROM search_log LIMIT 1') || { id: 1, term: 1, created_at: 1 }).sort(), ['created_at', 'id', 'term'], 'search log stores no user or address');
});

test('migration 11 is additive: users created before it keep NULL acceptance (nobody is marked as having accepted)', () => {
  const { DatabaseSync } = require('node:sqlite'), { MIGRATIONS } = require('../src/db'); assert.ok(MIGRATIONS.length >= 11);
  const d = new DatabaseSync(':memory:'); for (let i = 0; i < 10; i++) d.exec(MIGRATIONS[i]);
  d.prepare('INSERT INTO users(email, password_hash, display_name, created_at) VALUES(?,?,?,?)').run('old@x.test', 'x', 'Old', 1700000000);
  d.exec(MIGRATIONS[10]); const u = d.prepare('SELECT terms_version, terms_accepted_at, email FROM users').get();
  assert.equal(u.email, 'old@x.test'); assert.equal(u.terms_version, null); assert.equal(u.terms_accepted_at, null); d.close();
});
