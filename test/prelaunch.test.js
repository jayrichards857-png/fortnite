'use strict';
// Pre-deployment verification: each test here pins a launch-blocking behaviour or a defect found in the pre-launch review.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const H = require('./helpers');
const { q } = require('../src/db');
const { png } = require('../scripts/png');

const ROOT = path.resolve(__dirname, '..');
const LINK = 'https://buy.stripe.com/test_5kA3cs0abc123';
const parseEnvFile = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*#/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const cfgIn = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `
  const c=require('./src/config');const {assertProductionConfig}=require('./src/server');
  console.log(JSON.stringify({onb:c.sellerOnboarding,signups:c.signups,mode:c.checkoutMode,host:c.host,prod:c.isProd,problems:assertProductionConfig(),release:c.releaseDate}))`],
  { cwd: ROOT, env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://app@127.0.0.1:5432/pairplug', PAIRPLUG_UPLOADS: path.join(os.tmpdir(), 'pp-cfg-up'), ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop());

test.before(async () => await H.start());
test.after(() => H.stop());

// ------------------------------------------------------------------ configuration fails closed
test('deploy env examples are valid for systemd (no inline comments) and pass the production guard', () => {
  for (const f of ['deploy/pairplug.env.example', '.env.example']) {
    const kv = parseEnvFile(path.join(ROOT, f));
    for (const [k, v] of Object.entries(kv)) assert.ok(!/\s#/.test(v) && !/^#/.test(v), `${f}: ${k} has an inline comment`);
  }
  const kv = parseEnvFile(path.join(ROOT, 'deploy/pairplug.env.example'));
  for (const k of ['NODE_ENV', 'PUBLIC_URL', 'CHECKOUT_MODE', 'DATABASE_URL', 'PAIRPLUG_UPLOADS', 'TRUST_PROXY', 'SELLER_ONBOARDING', 'SIGNUPS', 'PUBLIC_RELEASE_DATE', 'EMAIL_PROVIDER']) assert.ok(k in kv, 'missing ' + k);
  assert.ok(!('PAYMENTS_MODE' in kv) && !('RATE_LIMIT_SCALE' in kv));
  const c = cfgIn({ ...kv, PUBLIC_URL: 'https://beta.example.test' });
  assert.deepEqual(c.problems, []); assert.equal(c.prod, true); assert.equal(c.onb, 'invite'); assert.equal(c.mode, 'external'); assert.equal(c.host, '127.0.0.1');
  assert.equal(c.signups, 'open', 'buyer sign-up open; sellers stay invitation-only'); assert.match(c.release, /^\d{4}-\d{2}-\d{2}$/);
});

test('malformed settings can never widen access: inline comments, junk values, and production defaults', () => {
  // the original defect: `invite   # note` used to be read as "open" (anyone can become a seller)
  const c = cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test', SELLER_ONBOARDING: 'invite     # only the emails below' });
  assert.equal(c.onb, 'invite'); assert.ok(c.problems.some((p) => /SELLER_ONBOARDING contains an inline/.test(p)));
  assert.equal(cfgIn({ SELLER_ONBOARDING: 'wide-open' }).onb, 'invite', 'unknown value => restrictive');
  assert.ok(cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test', SELLER_ONBOARDING: 'wide-open' }).problems.some((p) => /SELLER_ONBOARDING must be/.test(p)));
  // 'production # comment' is still production (not silently dev mode) and is reported
  const p2 = cfgIn({ NODE_ENV: 'production # live', PUBLIC_URL: 'https://x.test' });
  assert.equal(p2.prod, true); assert.ok(p2.problems.some((p) => /NODE_ENV contains an inline/.test(p)));
  assert.ok(cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test', CHECKOUT_MODE: 'escrow' }).problems.some((p) => /CHECKOUT_MODE must be/.test(p)));
  // defaults: production => invite-only + loopback; development => open + all interfaces
  const prod = cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test' }); assert.equal(prod.onb, 'invite'); assert.equal(prod.host, '127.0.0.1'); assert.deepEqual(prod.problems, []);
  const dev = cfgIn({}); assert.equal(dev.onb, 'invite', 'invitation-only even in development unless explicitly opted out');
  assert.equal(cfgIn({ SELLER_ONBOARDING: 'open' }).onb, 'open', 'explicit dev/test opt-out');
  assert.equal(cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test', SELLER_ONBOARDING: 'open' }).onb, 'invite', 'never open in production');
  assert.ok(cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test', SELLER_ONBOARDING: 'open' }).problems.some((p) => /not allowed in production/.test(p)), 'start-up refuses it outright');
  assert.equal(prod.signups, 'open', 'buyer sign-up is open by default (buyer accounts only)'); assert.equal(dev.host, '0.0.0.0');
  assert.equal(cfgIn({ NODE_ENV: 'production', PUBLIC_URL: 'https://x.test', HOST: '0.0.0.0' }).host, '0.0.0.0', 'explicit opt-in still possible');
});

// ------------------------------------------------------------------ real production process: persistence, cookies, invite-only, loopback
function startProd(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: 'production', PUBLIC_URL: 'https://beta.example.test', CHECKOUT_MODE: 'external', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve({ p, out }); }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (c) => reject(new Error(`exited ${c}: ${err}`)));
    setTimeout(() => reject(new Error('timeout: ' + err)), 15000);
  });
}
const stopProc = (p) => new Promise((r) => { p.removeAllListeners('exit'); p.on('exit', r); p.kill('SIGTERM'); });
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// Run the real create-admin script, boot a production process, and return helpers to talk to it.
function adminScript(env, extra) { return execFileSync(process.execPath, ['scripts/create-admin.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
const J = { 'x-requested-with': 'pairplug', 'content-type': 'application/json' };
// A reverse proxy forwards the public hostname; production rejects any other Host header (see src/host.js).
const http = require('node:http');
// fetch() ignores a custom Host header, so use http.request and expose the small fetch-like surface the tests need.
const pf = (u, o = {}) => new Promise((resolve, reject) => {
  const url = new URL(u);
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: o.method || 'GET', headers: { host: 'beta.example.test', ...(o.headers || {}) } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, text: async () => buf.toString(), json: async () => JSON.parse(buf.toString()), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }); });
  });
  req.on('error', reject); if (o.body) req.write(o.body); req.end();
});
async function loginAdmin(base) { const l = await pf(base + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ email: 'boss@example.test', password: 'a-long-admin-password' }) }); assert.equal(l.status, 200); return l.headers.get('set-cookie').split(';')[0]; }
async function inviteBuyer(base, adminCookie, email) {
  const r = await pf(base + '/api/admin/invitations', { method: 'POST', headers: { ...J, cookie: adminCookie }, body: JSON.stringify({ kind: 'buyer', email }) });
  assert.equal(r.status, 200); return (await r.json()).link.replace(/^https?:\/\/[^/]+/, '');
}

test('production process: DB, sessions and uploaded photos survive a restart; cookie flags; closed sign-ups; loopback-only bind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prod-')), port = await free(), fresh = require('./testdb').createSync();      // own empty PostgreSQL database
  const env = { PORT: String(port), DATABASE_URL: fresh.url, PAIRPLUG_UPLOADS: path.join(dir, 'up'), SIGNUPS: 'closed' };
  adminScript({ ...env, PUBLIC_URL: 'https://beta.example.test' }, { ADMIN_EMAIL: 'boss@example.test', ADMIN_PASSWORD: 'a-long-admin-password' });
  const base = `http://127.0.0.1:${port}`;
  let { p, out } = await startProd(env);
  try {
    assert.match(out, /bound to 127\.0\.0\.1:/);
    // the development email preview does not exist in a production process, even for an administrator
    { const ck = await loginAdmin(base); assert.equal((await pf(base + '/dev/emails', { headers: { cookie: ck } })).status, 404); }
    // public sign-up is closed: the page says Coming soon, the API refuses, no account appears
    assert.match(await (await pf(base + '/register')).text(), /Coming soon/);
    const closed = await pf(base + '/api/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'walkin@example.test', display_name: 'Walk In', terms: true, password: 'a-long-password-1' }) });
    assert.equal(closed.status, 403);
    // the admin invites a buyer; accepting the invitation is the only way in
    const adminCookie = await loginAdmin(base);
    const invitePath = await inviteBuyer(base, adminCookie, 'persist@example.test');
    const acc = await pf(base + '/api/invitations/accept', { method: 'POST', headers: J, body: JSON.stringify({ token: invitePath.split('/').pop(), display_name: 'Persist', terms: true, password: 'a-long-password-1' }) });
    assert.equal(acc.status, 200);
    const sc = acc.headers.get('set-cookie'); assert.match(sc, /HttpOnly/i); assert.match(sc, /Secure/i); assert.match(sc, /SameSite=Lax/i); assert.match(sc, /Path=\//);
    assert.equal(acc.headers.get('strict-transport-security'), 'max-age=31536000');
    const cookie = sc.split(';')[0];
    // buyers cannot become sellers: invite-only onboarding
    const onboard = await pf(base + '/api/sell/onboard', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ store_name: 'S', handle: 'sneaky', country: 'US', region: 'NY', city: 'B', agree: true, terms: true }) });
    assert.equal(onboard.status, 403);
    const sellPage = await (await pf(base + '/sell', { headers: { cookie } })).text(); assert.match(sellPage, /Request seller access|Sell on PairPlug/); assert.doesNotMatch(sellPage, /Coming soon/i);
    // upload a photo
    const photo = png(8, 8, (x, y) => [x * 30, y * 30, 90]);
    const up = await pf(base + '/api/uploads', { method: 'POST', headers: { 'x-requested-with': 'pairplug', 'content-type': 'image/png', cookie }, body: photo });
    assert.equal(up.status, 200); const { file } = await up.json();
    assert.equal(Buffer.compare(Buffer.from(await (await pf(`${base}/uploads/${file}`)).arrayBuffer()), photo), 0);
    // only the loopback interface is bound
    for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs) if (a.family === 'IPv4' && !a.internal) {
      const refused = await new Promise((r) => { const s = net.connect({ host: a.address, port, timeout: 1500 }); s.on('connect', () => { s.destroy(); r(false); }); s.on('error', () => r(true)); s.on('timeout', () => { s.destroy(); r(true); }); });
      assert.equal(refused, true, `port reachable on ${a.address}`);
    }
    // graceful restart, then boot again on the same files
    await stopProc(p);
    ({ p } = await startProd(env));
    const acct = await pf(base + '/account', { headers: { cookie }, redirect: 'manual' });
    assert.equal(acct.status, 200, 'session survived the restart'); assert.match(await acct.text(), /persist@example\.test/);
    assert.equal(Buffer.compare(Buffer.from(await (await pf(`${base}/uploads/${file}`)).arrayBuffer()), photo), 0, 'uploaded photo survived the restart');
    const login = await pf(base + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ email: 'persist@example.test', password: 'a-long-password-1' }) });
    assert.equal(login.status, 200, 'account (DB row) survived the restart');
    assert.deepEqual(await (await pf(base + '/healthz')).json(), { ok: true, checkoutMode: 'external', schema: require('../src/db').MIGRATIONS.length });
    await pf(base + '/api/logout', { method: 'POST', headers: { ...J, cookie } });
    assert.equal((await pf(base + '/account', { headers: { cookie }, redirect: 'manual' })).status, 302);
  } finally { await stopProc(p); require('./testdb').dropSync(fresh.name); }
});

test('production start-up refuses unsafe configuration (real process, non-zero exit, no listener)', async () => {
  const bad = (env) => new Promise((resolve) => { const p = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: 'production', PAIRPLUG_UPLOADS: path.join(os.tmpdir(), 'pp-bad-up'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let err = '', out = ''; p.stderr.on('data', (d) => { err += d; }); p.stdout.on('data', (d) => { out += d; }); p.on('exit', (code) => resolve({ code, err, out })); setTimeout(() => p.kill(), 8000); });
  for (const [env, re] of [[{ PUBLIC_URL: 'http://insecure.test' }, /https/], [{ PUBLIC_URL: 'https://x.test', PAYMENTS_MODE: 'sandbox' }, /sandbox/], [{ PUBLIC_URL: 'https://x.test', SELLER_ONBOARDING: 'invite # c' }, /inline/]]) {
    const r = await bad(env); assert.equal(r.code, 1); assert.match(r.err, re); assert.doesNotMatch(r.out, /listening/);
  }
});

// ------------------------------------------------------------------ admin creation
test('create-admin: creates a working admin, promotes an existing user, rejects weak passwords', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adm-')), port = await free(), fresh = require('./testdb').createSync();
  const env = { PATH: process.env.PATH, DATABASE_URL: fresh.url, PAIRPLUG_UPLOADS: path.join(dir, 'up') };
  const run = (extra) => { try { return { code: 0, out: execFileSync(process.execPath, ['scripts/create-admin.js'], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stderr) }; } };
  assert.equal(run({ ADMIN_EMAIL: 'boss@example.test', ADMIN_PASSWORD: 'short' }).code, 1);
  assert.equal(run({}).code, 1);
  const ok = run({ ADMIN_EMAIL: 'Boss@Example.test', ADMIN_PASSWORD: 'a-long-admin-password' }); assert.equal(ok.code, 0); assert.match(ok.out, /Administrator account: boss@example\.test/);
  assert.doesNotMatch(ok.out, /a-long-admin-password/, 'password is never echoed');
  const { p } = await startProd({ ...env, PORT: String(port) });
  try {
    const base = `http://127.0.0.1:${port}`, hdr = { 'x-requested-with': 'pairplug', 'content-type': 'application/json' };
    const login = await pf(base + '/api/login', { method: 'POST', headers: hdr, body: JSON.stringify({ email: 'boss@example.test', password: 'a-long-admin-password' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await pf(base + '/admin', { headers: { cookie } })).status, 200);
    assert.equal((await pf(base + '/api/admin/settings', { method: 'PUT', headers: { ...hdr, cookie }, body: '{}' })).status, 422, 'admin is authorised (validation, not 403)');
    // a normal user (created through an invitation) is not an admin
    const path2 = await inviteBuyer(base, cookie, 'normal@example.test');
    const u = await pf(base + '/api/invitations/accept', { method: 'POST', headers: J, body: JSON.stringify({ token: path2.split('/').pop(), display_name: 'Normal', terms: true, password: 'a-long-password-1' }) });
    assert.equal((await pf(base + '/admin', { headers: { cookie: u.headers.get('set-cookie').split(';')[0] } })).status, 403);
  } finally { await stopProc(p); }
  // recovery: reset sets a new operator-chosen password for the existing administrator (full coverage in test/admin.test.js)
  await new Promise((r) => setTimeout(r, 100));
  const reset = execFileSync(process.execPath, ['scripts/create-admin.js', 'reset', '--email', 'boss@example.test'], { cwd: ROOT, env: { ...env, ADMIN_PASSWORD: 'another-long-password' }, encoding: 'utf8' });
  assert.match(reset, /Administrator account: boss@example\.test/); assert.doesNotMatch(reset, /another-long-password/);
  require('./testdb').dropSync(fresh.name);
});

// ------------------------------------------------------------------ direct-checkout defects found in review
async function scene() {
  const seller = await H.newSeller('PL'), buyer = await H.newUser('Buyer');
  const id = await H.makeListing(seller, { payment_url: LINK, price: '40.00', shipping: '6.00', shipping_payer: 'buyer' });
  return { seller, buyer, id };
}
const buy = (b, id, over = {}) => b.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address, ...over });

test('seller order list: no buyer location and no fake "payout" before payment is confirmed', async () => {
  const { seller, buyer, id } = await scene();
  const o = (await buy(buyer, id, { address: { ...H.address, city: 'Zzyzxville', region: 'ZZ' } })).json.orderId;
  const before = (await seller.get('/dashboard/orders')).text;
  assert.doesNotMatch(before, /Zzyzxville/); assert.doesNotMatch(before, /payout \$0\.00/); assert.match(before, /paid direct to you/);
  assert.doesNotMatch((await seller.get(`/dashboard/orders/${o}`)).text, /Zzyzxville/);
  assert.doesNotMatch((await seller.get('/dashboard')).text, /Zzyzxville/);
  assert.doesNotMatch(JSON.stringify((await seller.get('/api/chat/sync')).json), /Zzyzxville/);
  await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  assert.match((await seller.get('/dashboard/orders')).text, /Zzyzxville/, 'location shown only after the seller confirms payment');
});

test('the payment destination is frozen at order time (editing the listing\'s link cannot redirect an open order)', async () => {
  const seller = await H.newSeller('Frz'), buyer = await H.newUser('Buyer');
  const file = await H.upload(seller), mk = (extra) => ({ title: 'Link item', category: 'clothing', condition: 'good', price: '20.00', shipping: '4.00', weight_oz: '8', images: [file], status: 'active', ...extra });
  const l = await seller.post('/api/seller/listings', mk({ payment_url: 'https://buy.stripe.com/test_ORIGINAL_one', payment_amount_ack: true, quantity: 2 }));
  assert.equal(l.status, 200);
  const o = (await buy(buyer, l.json.id)).json.orderId;
  assert.equal(JSON.parse((await q.get('SELECT snapshot_json s FROM orders WHERE id = ?', o)).s).paymentLink.url, 'https://buy.stripe.com/test_ORIGINAL_one');
  const edit = await seller.put(`/api/seller/listings/${l.json.id}`, mk({ payment_url: 'https://buy.stripe.com/test_DIFFERENT_prod', payment_amount_ack: true, payment_ack_total_cents: 2400, payment_ack_url: 'https://buy.stripe.com/test_DIFFERENT_prod', quantity: 2 })); assert.equal(edit.status, 200, edit.text);
  const r = await buyer.get(`/orders/${o}/pay`);
  assert.equal(r.status, 302); assert.equal(new URL(r.headers.get('location')).pathname, '/test_ORIGINAL_one');
});

// ------------------------------------------------------------------ re-assert the launch-critical money invariants end to end
test('invariants: nothing becomes paid/sold without the seller; no PairPlug money records; stranger cannot read order or address', async () => {
  const { seller, buyer, id } = await scene(), stranger = await H.newUser('Nosy'), other = await H.newSeller('Other');
  const o = (await buy(buyer, id)).json.orderId;
  // every buyer-side and anonymous action leaves the order unpaid and the item unsold
  await buyer.get(`/orders/${o}/pay`); await buyer.post(`/api/orders/${o}/claim-paid`); await new H.Client().get(`/orders/${o}/pay`);
  await buyer.post(`/api/orders/${o}/confirm`); await buyer.post(`/api/orders/${o}/received`);
  for (const c of [stranger, other]) { for (const u of [`/api/seller/orders/${o}/confirm-payment`, `/api/orders/${o}/claim-paid`, `/api/orders/${o}/cancel-purchase`, `/api/seller/orders/${o}/ship`]) assert.ok([401, 403, 404, 409, 422].includes((await c.post(u, { carrier: 'USPS', tracking: '9400111899223344' })).status), u); }
  assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', o)).status, 'pending_payment');
  assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'reserved');
  await seller.post(`/api/seller/orders/${o}/confirm-payment`);
  for (const c of [stranger, other]) for (const u of [`/orders/${o}`, `/dashboard/orders/${o}`]) { const r = await c.get(u); assert.ok(r.status === 404 || r.status === 302 || r.status === 403, u); assert.doesNotMatch(r.text, /1 Main St|Austin/); }
  assert.equal((await q.get('SELECT COUNT(*) n FROM ledger')).n, 0); assert.equal((await q.get('SELECT COUNT(*) n FROM payments')).n, 0); assert.equal((await q.get('SELECT COUNT(*) n FROM refunds')).n, 0);
  assert.equal((await q.get("SELECT COUNT(*) n FROM orders WHERE payment_mode = 'external' AND status NOT IN ('pending_payment','cancelled') AND payment_confirmed_at IS NULL")).n, 0, 'no direct order past pending without a seller confirmation');
});

// ------------------------------------------------------------------ concurrency on a single order
test('race: confirm / reject / buyer-cancel / expiry-sweep fired together leave order, checkout and listing consistent', async () => {
  const payments = require('../src/payments');
  const outcomes = {};
  for (let round = 0; round < 8; round++) {
    const seller = await H.newSeller('Race'), buyer = await H.newUser('RB');
    const id = await H.makeListing(seller, { payment_url: LINK, price: '30.00', shipping: '5.00', shipping_payer: 'buyer' });
    const o = (await buy(buyer, id)).json.orderId, ck = (await q.get('SELECT checkout_id c FROM orders WHERE id = ?', o)).c;
    if (round % 2) await q.run('UPDATE checkouts SET expires_at = 1 WHERE id = ?', ck);          // half the rounds are already past their hold
    const results = await Promise.all([
      seller.post(`/api/seller/orders/${o}/confirm-payment`), seller.post(`/api/seller/orders/${o}/confirm-payment`),
      seller.post(`/api/seller/orders/${o}/reject-payment`), buyer.post(`/api/orders/${o}/cancel-purchase`), buyer.post(`/api/orders/${o}/claim-paid`),
      Promise.resolve().then(async () => await payments.expireStaleCheckouts()),
    ]);
    const order = await q.get('SELECT status, payment_confirmed_at FROM orders WHERE id = ?', o), l = await q.get('SELECT status, reserved_checkout_id r FROM listings WHERE id = ?', id), c = await q.get('SELECT status FROM checkouts WHERE id = ?', ck);
    outcomes[order.status] = (outcomes[order.status] || 0) + 1;
    assert.ok(['paid', 'cancelled', 'pending_payment'].includes(order.status), order.status);
    if (order.status === 'paid') { assert.equal(l.status, 'sold'); assert.equal(c.status, 'paid'); assert.ok(order.payment_confirmed_at); assert.equal(results.slice(0, 2).filter((r) => r.status === 200 && !r.json.alreadyConfirmed).length, 1, 'exactly one confirm does the work (the repeat is reported as already confirmed)'); }
    else if (order.status === 'cancelled') { assert.equal(l.status, 'active'); assert.equal(l.r, null); assert.notEqual(c.status, 'paid'); assert.equal(order.payment_confirmed_at, null); }
    else { assert.equal(l.status, 'reserved'); assert.equal(c.status, 'pending'); }
    assert.equal((await q.get('SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND to_status IN (\'paid\',\'cancelled\')', o)).n, order.status === 'pending_payment' ? 0 : 1, 'exactly one terminal transition recorded');
    assert.equal((await q.get('SELECT COUNT(*) n FROM order_items WHERE listing_id = ?', id)).n, 1);
  }
  assert.ok(Object.keys(outcomes).length >= 1);
});
