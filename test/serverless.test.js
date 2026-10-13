'use strict';
// The serverless profile (what runs on Vercel): shared rate limits, scheduled-job authentication/leases, database-backed chat polling, and the
// core marketplace flow with image storage in an object store. Everything runs against a disposable database and an in-process fake S3.
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const H = require('./helpers');
const config = require('../src/config');
const { q } = require('../src/db');
const auth = require('../src/auth');
const jobs = require('../src/jobs');
const storage = require('../src/storage');

test.before(async () => await H.start());
test.after(() => H.stop());

const oid = (r) => Number(String(r.json.redirect).match(/(\d+)/)[1]);
const withFlags = async (flags, fn) => { const keep = Object.fromEntries(Object.keys(flags).map((k) => [k, k.includes('.') ? config[k.split('.')[0]][k.split('.')[1]] : config[k]])); const set = (o) => { for (const [k, v] of Object.entries(o)) { if (k.includes('.')) config[k.split('.')[0]][k.split('.')[1]] = v; else config[k] = v; } }; set(flags); try { return await fn(); } finally { set(keep); } };

test('shared rate limits: counters live in PostgreSQL, are atomic under concurrency, and each key/window is independent', async () => {
  await withFlags({ sharedRateLimit: true, rateLimitScale: 1 }, async () => {
    const key = 'test:rl:' + crypto.randomBytes(4).toString('hex');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => auth.rateLimit(key, 3, 60)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, 'exactly the allowed number got through, however many instances raced');
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 429));
    assert.equal(Number((await q.get('SELECT SUM(hits) n FROM rate_limits WHERE key = ?', key)).n), 10);
    await auth.rateLimit(key + ':other', 3, 60);                                        // another key is unaffected
    await q.run('UPDATE rate_limits SET expires_at = 1 WHERE key = ?', key);
    assert.ok(await auth.purgeRateLimits() >= 1); assert.equal(await q.get('SELECT 1 x FROM rate_limits WHERE key = ?', key), undefined, 'expired windows are purged');
  });
  const local = 'test:mem:' + crypto.randomBytes(4).toString('hex'); await auth.rateLimit(local, 1, 60);       // local mode is unchanged: in-memory, nothing written
  assert.equal(await q.get('SELECT 1 x FROM rate_limits WHERE key = ?', local), undefined);
});

test('login throttling works through the shared store (a request that hits the limit gets 429, a normal one still works)', async () => {
  await withFlags({ sharedRateLimit: true, rateLimitScale: 1 }, async () => {
    const u = await H.newUser('Throttle'); let last;
    for (let i = 0; i < 9; i++) last = await new H.Client().post('/api/login', { email: u.email, password: 'wrong-password-' + i });
    assert.equal(last.status, 429);
  });
  assert.equal((await new H.Client().post('/api/login', { email: 'nobody@example.test', password: 'x' })).status, 401, 'limits are per key');
});

test('scheduled jobs: the endpoint is authenticated (fail closed), constant-time compared, validated, and idempotent', async () => {
  const get = (c, h, u = '/api/cron/tick') => c.req('GET', u, undefined, { headers: h });
  await withFlags({ cronSecret: '' }, async () => assert.equal((await get(new H.Client(), {})).status, 503, 'no secret configured: disabled, not open'));
  await withFlags({ cronSecret: 's'.repeat(40) }, async () => {
    const c = new H.Client(), good = { Authorization: 'Bearer ' + 's'.repeat(40) };
    assert.equal((await get(c, {})).status, 401); assert.equal((await get(c, { Authorization: 'Bearer ' + 's'.repeat(39) })).status, 401); assert.equal((await get(c, { Authorization: 's'.repeat(40) })).status, 401);
    const u = await H.newUser('NotCron'); assert.equal((await get(u, {})).status, 401, 'a logged-in user is not the scheduler');
    const ok = await get(c, good); assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.ok, true); assert.ok(!ok.text.includes('s'.repeat(40)));
    assert.equal((await get(c, good, '/api/cron/tick?job=nope')).status, 400);
    assert.equal((await get(c, good, '/api/cron/tick?job=sweep')).json.jobs.length, 1);
  });
});

test('duplicate execution is prevented: concurrent triggers run a job once; hourly work honours its interval; a crash does not wedge the lease', async () => {
  const sweep = jobs.JOBS.sweep, house = jobs.JOBS.housekeeping, keepS = sweep.run, keepH = house.run;
  try {
    await q.run('DELETE FROM job_leases');
    let runs = 0; sweep.run = async () => { runs++; await new Promise((r) => setTimeout(r, 150)); };
    const reports = await Promise.all(Array.from({ length: 6 }, () => jobs.runDue({ only: 'sweep' })));
    assert.equal(runs, 1, 'six overlapping triggers, one execution'); assert.equal(reports.filter((r) => r[0].ran).length, 1);
    await jobs.runDue({ only: 'sweep' }); assert.equal(runs, 2, 'a frequent job runs again once the previous run finished');
    let h = 0; house.run = async () => { h++; };
    await jobs.runDue({ only: 'housekeeping' }); const again = await jobs.runDue({ only: 'housekeeping' }); assert.equal(h, 1); assert.equal(again[0].ran, false);
    await q.run("UPDATE job_leases SET last_finished_at = last_finished_at - 7200 WHERE name = 'housekeeping'"); await jobs.runDue({ only: 'housekeeping' }); assert.equal(h, 2, 'due again after the interval');
    sweep.run = async () => { throw new Error('boom'); };
    const failed = await jobs.runDue({ only: 'sweep' }); assert.equal(failed[0].status, 'error'); assert.equal(failed[0].error, 'see logs', 'no internals in the report');
    sweep.run = async () => { runs++; }; const before = runs; await jobs.runDue({ only: 'sweep' }); assert.equal(runs, before + 1, 'the lease was released after the failure');
    // a holder that died leaves a lease that expires on its own
    await q.run("UPDATE job_leases SET locked_until = EXTRACT(EPOCH FROM now())::bigint + 3600 WHERE name = 'sweep'"); assert.equal((await jobs.runDue({ only: 'sweep' }))[0].ran, false, 'held');
    await q.run("UPDATE job_leases SET locked_until = 1 WHERE name = 'sweep'"); assert.equal((await jobs.runDue({ only: 'sweep' }))[0].ran, true, 'expired lease can be taken over');
  } finally { sweep.run = keepS; house.run = keepH; }
});

test('the real jobs do their work: an expired reservation is released and the item is purchasable again', async () => {
  const seller = await H.newSeller('Job'), a = await H.newUser('A'), b = await H.newUser('B'), id = await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_job1' });
  const r = await a.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text);
  assert.equal((await b.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status >= 400, true, 'held for the first buyer');
  await q.run("UPDATE checkouts SET expires_at = 1 WHERE status = 'pending' AND id IN (SELECT checkout_id FROM orders WHERE id = ?)", oid(r));
  await q.run('DELETE FROM job_leases');
  const rep = await jobs.runDue({ only: 'sweep' }); assert.equal(rep[0].status, 'ok');
  assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', oid(r))).status, 'cancelled');
  assert.equal((await b.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status, 200, 'released item can be bought');
});

test('chat on a serverless host: polling is forced, requests never hold the function open, and messages cross "instances" through the database', async () => {
  await withFlags({ 'chat.pollMs': 3000 }, async () => {
    const seller = await H.newSeller('Chat'), buyer = await H.newUser('Chatter'), id = await H.makeListing(seller);
    const conv = (await buyer.post('/api/chat/conversations', { listingId: id })).json.id;
    const page = (await buyer.get(`/messages/${conv}`)).text; const boot = JSON.parse(/<script id="chat-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(page)[1]);
    assert.equal(boot.forcedTransport, 'polling'); assert.equal(boot.pollMs, 3000);
    const t0 = Date.now(), idle = await seller.get('/api/chat/sync?after=999999999&wait=25'); assert.equal(idle.status, 200); assert.ok(Date.now() - t0 < 2000, `answered immediately, took ${Date.now() - t0} ms`);
    const cursor = (await seller.get('/api/chat/sync?after=0')).json.cursor || 0;
    assert.equal((await buyer.post('/api/chat/command', { op: 'send', conversationId: conv, clientId: 'c-' + Date.now(), body: 'Is this still available?' })).status, 200);
    const got = await seller.get(`/api/chat/sync?after=${cursor ? 0 : 0}&wait=25`);
    assert.ok(got.json.messages.some((m) => m.body === 'Is this still available?'), 'the other party sees it on their next poll');
    const stranger = await H.newUser('Nosy'); assert.equal((await stranger.post('/api/chat/command', { op: 'history', conversationId: conv })).status >= 400, true, 'membership still enforced');
  });
  const off = await H.newUser('Desktop'); assert.equal(JSON.parse(/<script id="chat-boot" type="application\/json">([\s\S]*?)<\/script>/.exec((await off.get('/messages')).text)[1]).forcedTransport, null, 'unchanged when not serverless');
});

function fakeS3() {
  const objects = new Map();
  const server = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { const body = Buffer.concat(ch), k = decodeURIComponent(req.url.split('?')[0]);
    if (!/Credential=AKIATEST\//.test(String(req.headers.authorization))) { res.statusCode = 403; return res.end(); }
    if (req.method === 'PUT') { objects.set(k, body); res.statusCode = 200; return res.end(); } if (req.method === 'DELETE') { objects.delete(k); res.statusCode = 204; return res.end(); }
    if (!objects.has(k)) { res.statusCode = 404; return res.end(); } res.end(objects.get(k)); }); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, url: `http://127.0.0.1:${server.address().port}` })));
}

test('core beta workflow on the serverless profile: listing with an object-stored photo -> purchase -> payment confirmed -> shipped -> received, inventory consistent', async () => {
  const s3 = await fakeS3(), prev = storage.driver();
  storage.setDriver(storage.create({ onVercel: true, uploadDir: '/unused', storage: { s3: { endpoint: s3.url, bucket: 'b', region: 'auto', accessKeyId: 'AKIATEST', secretAccessKey: 'secret', prefix: '' } } }));
  try {
    await withFlags({ sharedRateLimit: true, 'chat.pollMs': 3000, rateLimitScale: 1000 }, async () => {
      const seller = await H.newSeller('Flow'), b1 = await H.newUser('One'), b2 = await H.newUser('Two'), stranger = await H.newUser('Other');
      const id = await H.makeListing(seller, { payment_url: 'https://buy.stripe.com/test_flow1' });
      assert.equal(s3.objects.size, 1, 'the listing photo is in object storage');
      const img = (await q.get('SELECT file FROM listing_images WHERE listing_id = ?', id)).file;
      assert.equal((await new H.Client().get(`/uploads/${img}`)).status, 200, 'photo is served from storage (same URL as before)');
      assert.match((await new H.Client().get(`/listing/${id}`)).text, new RegExp(`/uploads/${img}`));
      // authorization: only the owner edits; only the seller of an order confirms payment
      assert.equal((await stranger.put(`/api/seller/listings/${id}`, { title: 'Hijacked' })).status >= 400, true);
      const r = await b1.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address }); assert.equal(r.status, 200, r.text); const o = oid(r);
      assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'reserved');
      assert.equal((await b2.post('/api/purchases', { listingId: id, acknowledged: true, address: H.address })).status >= 400, true, 'cannot be bought twice');
      assert.equal((await stranger.post(`/api/seller/orders/${o}/confirm-payment`, {})).status >= 400, true);
      assert.equal((await b1.post(`/api/seller/orders/${o}/confirm-payment`, {})).status >= 400, true, 'a buyer cannot confirm their own payment');
      assert.equal((await seller.post(`/api/seller/orders/${o}/confirm-payment`, {})).status, 200);
      assert.equal((await seller.post(`/api/seller/orders/${o}/ship`, { carrier: 'USPS', tracking: '94001' + String(Date.now()).slice(-8) + '123456' })).status, 200);
      assert.equal((await b1.post(`/api/orders/${o}/received`, {})).status, 200);
      assert.equal((await q.get('SELECT status FROM orders WHERE id = ?', o)).status, 'delivered');
      assert.equal((await q.get('SELECT status FROM listings WHERE id = ?', id)).status, 'sold'); assert.equal((await q.get('SELECT quantity FROM listings WHERE id = ?', id)).quantity, 0);
      assert.equal(Number((await q.get("SELECT COUNT(*) n FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE listing_id = ?) AND status NOT IN ('cancelled')", id)).n), 1, 'exactly one live order for a one-off item');
    });
  } finally { storage.setDriver(prev); await new Promise((r) => s3.server.close(r)); }
});
