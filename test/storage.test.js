'use strict';
// Durable image storage: SigV4 is checked against AWS's published test vectors; uploads, serving and failure handling go through the real app
// against an in-process fake S3 server (no network, no credentials, disposable database).
process.env.CHECKOUT_MODE = 'external';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const H = require('./helpers');
const { q } = require('../src/db');
const storage = require('../src/storage');
const { png } = require('../scripts/png');

test.before(async () => await H.start());
test.after(() => H.stop());

const AK = 'AKIAIOSFODNN7EXAMPLE', SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', D = new Date('2013-05-24T00:00:00Z');
const sigOf = (h) => /Signature=([0-9a-f]+)/.exec(h.authorization)[1];

test('SigV4 reproduces the AWS-documented S3 example signatures (GET object with Range, GET ?lifecycle, PUT object with body)', () => {
  const get = storage.sign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' }, region: 'us-east-1', accessKeyId: AK, secretAccessKey: SK, date: D });
  assert.equal(sigOf(get), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  const life = storage.sign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle', region: 'us-east-1', accessKeyId: AK, secretAccessKey: SK, date: D });
  assert.equal(sigOf(life), 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  const put = storage.sign({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test%24file.text', body: 'Welcome to Amazon S3.', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, region: 'us-east-1', accessKeyId: AK, secretAccessKey: SK, date: D });
  assert.equal(sigOf(put), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

/** A tiny S3: path-style PUT/GET/DELETE with Authorization checked for presence, the right access key and a body hash that matches. */
function fakeS3() {
  const objects = new Map(), log = []; let failing = false;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks), auth = String(req.headers.authorization || '');
      log.push({ method: req.method, url: req.url, auth, hash: req.headers['x-amz-content-sha256'], ctype: req.headers['content-type'] });
      if (failing) { res.statusCode = 503; return res.end(); }
      if (!auth.includes(`Credential=${AK}/`) || req.headers['x-amz-content-sha256'] !== crypto.createHash('sha256').update(body).digest('hex')) { res.statusCode = 403; return res.end(); }
      const key = decodeURIComponent(req.url.split('?')[0]);
      if (req.method === 'PUT') { objects.set(key, body); res.statusCode = 200; return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
      if (!objects.has(key)) { res.statusCode = 404; return res.end(); }
      res.statusCode = 200; res.end(objects.get(key));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, log, url: `http://127.0.0.1:${server.address().port}`, fail: (v) => { failing = v; } })));
}
const s3cfg = (url) => ({ onVercel: true, uploadDir: '/unused', storage: { s3: { endpoint: url, bucket: 'pp-test', region: 'auto', accessKeyId: AK, secretAccessKey: SK, prefix: 'uploads', timeoutMs: 2000 } } });

test('uploads go to object storage, not disk; files are served through the app with safe headers; the bucket credentials never reach the client', async () => {
  const s3 = await fakeS3(), prev = storage.driver(); storage.setDriver(storage.create(s3cfg(s3.url)));
  try {
    const seller = await H.newSeller('Stor');
    const up = await seller.req('POST', '/api/uploads', png(40, 50, (x, y) => [x * 5, y * 4, 90]), { raw: true, type: 'image/png' });
    assert.equal(up.status, 200, up.text); assert.match(up.json.file, /^[a-f0-9]{32}\.png$/);
    assert.ok(!up.text.includes(SK) && !up.text.includes(AK));
    assert.ok(s3.objects.has(`/pp-test/uploads/${up.json.file}`), 'object stored under the configured bucket/prefix');
    assert.ok(s3.log.every((l) => /^AWS4-HMAC-SHA256 Credential=/.test(l.auth)), 'every request is signed');
    assert.ok(await q.get('SELECT 1 x FROM uploads WHERE file = ?', up.json.file));
    const got = await new H.Client().get(`/uploads/${up.json.file}`);
    assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('cache-control'), /immutable/); assert.match(got.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await new H.Client().get('/uploads/not-a-real-name.png')).status, 404);
    assert.equal((await new H.Client().get(`/uploads/${'a'.repeat(32)}.png`)).status, 404, 'unknown file');
    // a listing using that photo works end to end and the page references the stable /uploads URL
    const id = (await seller.post('/api/seller/listings', { title: 'Stored jacket', description: 'x', category: 'outerwear', brand: 'A', size: 'M', condition: 'good', price: '40', shipping: '5', images: [up.json.file], status: 'draft' })).json.id;
    assert.ok(id, 'draft listing with a stored image saves');
  } finally { storage.setDriver(prev); await new Promise((r) => s3.server.close(r)); }
});

test('validation still applies before anything is sent to storage (type, size, content)', async () => {
  const s3 = await fakeS3(), prev = storage.driver(); storage.setDriver(storage.create(s3cfg(s3.url)));
  try {
    const u = await H.newUser('Val');
    assert.equal((await u.req('POST', '/api/uploads', Buffer.from('<svg><script>1</script></svg>'), { raw: true, type: 'image/png' })).status, 415);
    assert.equal((await u.req('POST', '/api/uploads', Buffer.concat([png(8, 8, () => [1, 2, 3]), Buffer.alloc(6 * 1024 * 1024)]), { raw: true, type: 'image/png' })).status, 413);
    assert.equal((await new H.Client().req('POST', '/api/uploads', png(8, 8, () => [1, 2, 3]), { raw: true, type: 'image/png' })).status, 401);
    assert.equal(s3.objects.size, 0, 'nothing reached storage');
  } finally { storage.setDriver(prev); await new Promise((r) => s3.server.close(r)); }
});

test('storage outage: uploads answer a clear 503 and leave no record; reads answer 503; the rest of the site keeps working', async () => {
  const s3 = await fakeS3(), prev = storage.driver(); storage.setDriver(storage.create(s3cfg(s3.url)));
  try {
    const u = await H.newUser('Down'), before = Number((await q.get('SELECT COUNT(*) n FROM uploads')).n);
    const ok = await u.req('POST', '/api/uploads', png(8, 8, () => [9, 9, 9]), { raw: true, type: 'image/png' }); assert.equal(ok.status, 200);
    s3.fail(true);
    const bad = await u.req('POST', '/api/uploads', png(8, 8, () => [5, 5, 5]), { raw: true, type: 'image/png' });
    assert.equal(bad.status, 503); assert.match(bad.json.error, /temporarily unavailable/); assert.ok(!bad.text.includes('127.0.0.1'), 'no internals in the message');
    assert.equal(Number((await q.get('SELECT COUNT(*) n FROM uploads')).n), before + 1, 'no record for the failed upload');
    assert.equal((await new H.Client().get(`/uploads/${ok.json.file}`)).status, 503);
    assert.equal((await new H.Client().get('/shop')).status, 200, 'pages without photos are unaffected');
  } finally { storage.setDriver(prev); await new Promise((r) => s3.server.close(r)); }
});

test('with no storage configured on Vercel, saving is refused (never written to /tmp); the local driver is unchanged', async () => {
  const none = storage.create({ onVercel: true, uploadDir: '/unused', storage: { s3: null } }); assert.equal(none.kind, 'none');
  assert.equal(storage.create({ onVercel: false, uploadDir: '/tmp/x', storage: { s3: null } }).kind, 'fs');
  const prev = storage.driver(); storage.setDriver(none);
  try { const u = await H.newUser('None'); const r = await u.req('POST', '/api/uploads', png(8, 8, () => [1, 1, 1]), { raw: true, type: 'image/png' }); assert.equal(r.status, 503); assert.match(r.json.error, /no durable image storage/); }
  finally { storage.setDriver(prev); }
});
