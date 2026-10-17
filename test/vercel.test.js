'use strict';
// Vercel preview safety: no start-up mkdir under the read-only /var/task, product/avatar/banner uploads refuse clearly instead of
// pretending to persist, the Express app is exported as a callable handler, and a misconfigured production environment answers 503.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const testdb = require('./testdb');

const run = (code, env) => spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000,
  env: { PATH: process.env.PATH, PAIRPLUG_TEST_PG: process.env.PAIRPLUG_TEST_PG || '', ...env } });
const UNWRITABLE = path.join(__filename, 'uploads');   // a directory below a regular file can never be created (like /var/task on Vercel)

test('loading src/images.js on Vercel does not create any directory (the reported ENOENT crash); locally it still does', () => {
  const vercel = run("require('./src/images'); console.log('loaded'); process.exit(0)", { VERCEL: '1', PAIRPLUG_UPLOADS: UNWRITABLE });
  assert.equal(vercel.status, 0, vercel.stderr); assert.match(vercel.stdout, /loaded/);
  const local = run("require('./src/images'); process.exit(0)", { PAIRPLUG_UPLOADS: UNWRITABLE });          // unchanged local behaviour: the directory is created at start-up (and a bad path still fails loudly)
  assert.notEqual(local.status, 0); assert.match(local.stderr, /ENOTDIR|ENOENT/);
});

test('on Vercel without object storage the driver is "none" (never /tmp or /var/task); with S3 settings it is s3; locally it stays the local disk', () => {
  const probe = (env) => JSON.parse(run("const c = require('./src/config'); const s = require('./src/storage'); console.log(JSON.stringify({ kind: s.driver().kind, dir: c.uploadDir, mb: c.limits.imageBytes / 1048576 }))", env).stdout);
  const none = probe({ VERCEL: '1' }); assert.equal(none.kind, 'none'); assert.ok(!none.dir.startsWith(path.join(root, 'data')), none.dir); assert.ok(!fs.existsSync(none.dir), 'placeholder path must not be created'); assert.equal(none.mb, 4, 'Vercel rejects bodies over 4.5 MB');
  assert.equal(probe({ VERCEL: '1', S3_ENDPOINT: 'https://s3.example', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' }).kind, 's3');
  assert.equal(probe({ VERCEL: '1', S3_ENDPOINT: 'https://s3.example', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a' }).kind, 'none', 'incomplete settings do not half-enable it');
  const local = probe({}); assert.equal(local.kind, 'fs'); assert.equal(local.dir, path.join(root, 'data', 'uploads')); assert.equal(local.mb, 5);
});

test('with no durable storage configured, saving an upload is refused with a clear 503 and nothing is stored', () => {
  const r = run(`const { saveUpload } = require('./src/images'); const { png } = require('./scripts/png');
    saveUpload(1, png(8, 8, () => [1, 2, 3])).then(() => console.log('ACCEPTED'), (e) => console.log(JSON.stringify({ status: e.status, msg: e.message }))).finally(() => process.exit(0));`, { VERCEL: '1', PAIRPLUG_UPLOADS: UNWRITABLE });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /ACCEPTED/);
  const o = JSON.parse(r.stdout.trim().split('\n').pop()); assert.equal(o.status, 503); assert.match(o.msg, /no durable image storage/);
});

const GOOD = { VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', PUBLIC_URL: 'https://grailedside.example', CHECKOUT_MODE: 'external', SELLER_ONBOARDING: 'invite', SIGNUPS: 'open',
  TRUST_PROXY: '1', PAIRPLUG_DB_LABEL: 'preview', CRON_SECRET: 'c'.repeat(40), S3_ENDPOINT: 'http://127.0.0.1:9', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's',
  EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'Grailedside <hello@grailedside.example>' };
/** Drive the Vercel entry (api/index.js) over real HTTP with a chosen Host header; returns one JSON line per request. */
const drive = (env, paths) => run(`const app = require('./api/index.js'); if (typeof app !== 'function') { console.log('NOT_A_HANDLER'); process.exit(2); }
  const http = require('node:http'), srv = http.createServer(app).listen(0, async () => { const out = [];
    const hit = (p, headers = {}, method = 'GET') => new Promise((res) => { const r = http.request({ port: srv.address().port, path: p, method, headers: { Host: 'grailedside.example', ...headers } }, (m) => { let b = ''; m.on('data', (c) => b += c); m.on('end', () => res({ p, status: m.statusCode, body: b.slice(0, 200), h: m.headers })); }); r.end(); });
    for (const [p, h, m] of ${JSON.stringify(paths)}) out.push(await hit(p, h, m));
    console.log(JSON.stringify(out)); srv.close(); process.exit(0); });`, { ...GOOD, ...env });
const parse = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()); };

test('the Vercel entry exports the Express app; every missing production setting is reported (to the logs only) and answered with a plain 503', () => {
  const bare = drive({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', S3_ENDPOINT: '', CRON_SECRET: '', TRUST_PROXY: '', PAIRPLUG_DB_LABEL: '', EMAIL_PROVIDER: 'none', PUBLIC_URL: 'http://not-https.example' }, [['/healthz']]);
  const o = parse(bare)[0]; assert.equal(o.status, 503); assert.doesNotMatch(o.body, /S3_|CRON_SECRET|DATABASE_URL|TRUST_PROXY/, 'visitors see no configuration details');
  assert.match(bare.stderr, /EMAIL_PROVIDER is not resend.*Email outbox/, 'email is a warning, not a blocker');
  for (const needle of ['S3_ENDPOINT', 'CRON_SECRET', 'TRUST_PROXY=1', 'PAIRPLUG_DB_LABEL', 'PUBLIC_URL must be']) assert.match(bare.stderr, new RegExp(needle), `log names ${needle}`);
  const wrongLabel = drive({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', PAIRPLUG_DB_LABEL: 'production' }, [['/healthz']]);   // production-labelled database on a preview deployment
  assert.equal(parse(wrongLabel)[0].status, 503); assert.match(wrongLabel.stderr, /PAIRPLUG_DB_LABEL must equal this deployment's environment \("preview"\)/);
});

test('serverless safety: a web request never migrates; `npm run migrate` is a dry run unless --apply; a migrated database then serves, with scheduled jobs protected', async () => {
  const db = testdb.createSync(), { Client } = require('pg');
  const tables = async () => { const c = new Client({ connectionString: db.url }); await c.connect(); try { return Number((await c.query("SELECT COUNT(*) n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n); } finally { await c.end(); } };
  try {
    const env = { DATABASE_URL: db.url };
    const empty = parse(drive(env, [['/healthz'], ['/shop']])); assert.deepEqual(empty.map((r) => r.status), [503, 503], 'schema is behind this release: refuse to serve');
    assert.equal(await tables(), 0, 'a web request must not create or alter anything');
    const mig = (args, extra = {}, url = db.url) => spawnSync(process.execPath, ['scripts/migrate.js', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL_UNPOOLED: url, ...extra } });
    const host = new URL(db.url).hostname, LABEL = { PAIRPLUG_DB_LABEL: 'preview' };
    const status = mig([]);
    assert.equal(status.status, 0, status.stderr); assert.match(status.stdout, new RegExp(`target: host=${host.replace(/\./g, '\\.')} database=`)); assert.match(status.stdout, /schema version: v0 \(this release needs v\d+\)/);
    assert.match(status.stdout, /Pending migrations, in order: 1, 2, 3/); assert.match(status.stdout, /DRY RUN: nothing was changed/); assert.equal(await tables(), 0, 'dry run changes nothing');
    assert.doesNotMatch(status.stdout + status.stderr, /postgres(ql)?:\/\//, 'no connection string is ever printed');
    // every guard refuses BEFORE anything is changed
    for (const [why, r] of [['no label', mig(['--apply', '--confirm-host', host])], ['no host confirmation', mig(['--apply'], LABEL)], ['wrong host confirmation', mig(['--apply', '--confirm-host', 'some-other-host'], LABEL)],
      ['pooled host', mig(['--apply', '--confirm-host', 'ep-x-pooler.example'], LABEL, 'postgres://u:p@ep-x-pooler.example/db')]]) {
      assert.notEqual(r.status, 0, why); assert.match(r.stderr, /Refusing to apply/, why); assert.equal(await tables(), 0, `${why}: nothing changed`);
    }
    // a database that has tables but no migration history (wrong branch / foreign DB) is never touched
    { const c = new Client({ connectionString: db.url }); await c.connect(); await c.query('CREATE TABLE foreign_thing (id int)'); await c.end(); }
    const foreign = mig(['--apply', '--confirm-host', host], LABEL); assert.notEqual(foreign.status, 0); assert.match(foreign.stderr, /no migration history/); assert.equal(await tables(), 1, 'untouched');
    { const c = new Client({ connectionString: db.url }); await c.connect(); await c.query('DROP TABLE foreign_thing'); await c.end(); }
    const apply = mig(['--apply', '--confirm-host', host], LABEL);
    assert.equal(apply.status, 0, apply.stderr); assert.match(apply.stdout, /Applied\. Schema is now v\d+/);
    const after = mig([]); assert.match(after.stdout, /Up to date/); assert.match(after.stdout, /existing data \(row counts\): users=0/);
    const again = mig(['--apply', '--confirm-host', host], LABEL); assert.match(again.stdout, /Up to date/);
    const out = parse(drive(env, [['/healthz'], ['/api/cron/tick'], ['/api/cron/tick', { Authorization: 'Bearer wrong' }], ['/api/cron/tick', { Authorization: 'Bearer ' + 'c'.repeat(40) }], ['/api/cron/tick', { Authorization: 'Bearer ' + 'c'.repeat(40) }, 'GET'], ['/dashboard'], ['/api/logout', {}, 'POST'], ['/']]));
    assert.equal(out[0].status, 200, JSON.stringify(out[0])); assert.equal(out[1].status, 401, 'no token'); assert.equal(out[2].status, 401, 'wrong token');
    const first = JSON.parse(out[3].body), second = JSON.parse(out[4].body);
    assert.equal(out[3].status, 200); assert.deepEqual(first.jobs.map((j) => [j.job, j.ran]), [['sweep', true], ['housekeeping', true]]);
    assert.equal(second.jobs.find((j) => j.job === 'housekeeping').ran, false, 'an hourly job does not run twice in a row');
    assert.notEqual(out[5].status, 200, 'seller dashboard needs a login'); assert.equal(out[6].status, 403, 'state-changing request without the CSRF header is refused');
    assert.equal(out[7].status, 200); assert.match(out[7].h['strict-transport-security'], /max-age/); assert.match(out[7].h['content-security-policy'], /default-src 'self'/);
    assert.equal(await tables() > 40, true);
  } finally { testdb.dropSync(db.name); }
});

test('vercel.json routes everything to the exported app and ships the migrations (read from disk at run time)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.deepEqual(v.rewrites, [{ source: '/(.*)', destination: '/api' }]);
  assert.deepEqual(v.crons.map((c) => c.path), ['/api/cron/tick'], 'scheduled jobs are wired to the authenticated endpoint');
  assert.match(v.functions['api/index.js'].includeFiles, /src\/migrations\/\*\*/);
  assert.ok(fs.existsSync(path.join(root, 'api', 'index.js')));
});

test('check:config reports missing settings by NAME only, flags mismatched Neon endpoints, and never prints a value', () => {
  const run2 = (env, args = ['--as', 'production']) => spawnSync(process.execPath, ['scripts/check-config.js', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const bad = run2({}); assert.equal(bad.status, 1); assert.match(bad.stdout, /MISSING DATABASE_URL\b/); assert.match(bad.stdout, /durable image storage is required/); assert.equal(run2({}, []).status, 2, 'must say which environment');
  const secret = 'SECRET-VALUE-' + 'q'.repeat(30);
  const mism = run2({ DATABASE_URL: `postgres://u:${secret}@ep-aaa-pooler.example/db?sslmode=require`, DATABASE_URL_UNPOOLED: `postgres://u:${secret}@ep-bbb.example/db?sslmode=require`, PAIRPLUG_DB_LABEL: 'preview', CRON_SECRET: secret, S3_SECRET_ACCESS_KEY: secret });
  assert.doesNotMatch(mism.stdout + mism.stderr, new RegExp(secret), 'no secret value is ever printed'); assert.match(mism.stdout, /DIFFERENT Neon endpoints/);
  assert.match(mism.stdout, /PAIRPLUG_DB_LABEL must equal this deployment's environment \("production"\)/, 'a preview-labelled setup is rejected as production');
});
