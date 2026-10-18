'use strict';
// Vercel Web Analytics for the server-rendered pages: present only on Vercel (kill switch WEB_ANALYTICS=off), same-origin, CSP-compatible,
// not swallowed by the catch-all rewrite, and disclosed in the privacy policy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const config = require('../src/config');

test.before(async () => await H.start());
test.after(() => H.stop());

const SCRIPT = /<script defer src="\/_vercel\/insights\/script\.js"><\/script><\/body>/;

test('not rendered locally or in tests (no VERCEL env); rendered on Vercel; off switch honoured', async () => {
  const anon = new H.Client(), keep = config.webAnalytics;
  try {
    assert.equal(keep, false, 'off by default outside Vercel');
    assert.doesNotMatch((await anon.get('/')).text, /_vercel\/insights/);
    config.webAnalytics = true;
    for (const u of ['/', '/shop', '/login', '/privacy', '/contact']) { const t = (await anon.get(u)).text; assert.match(t, SCRIPT, u); assert.match(t, /window\.va=window\.va\|\|function/, u); }
    const seller = await H.newSeller('Ana'), buyer = await H.newUser('Anb');
    assert.match((await seller.get('/dashboard')).text, SCRIPT); assert.match((await buyer.get('/orders')).text, SCRIPT);
    config.webAnalytics = false;
    assert.doesNotMatch((await anon.get('/')).text, /_vercel\/insights/);
  } finally { config.webAnalytics = keep; }
});

test('the script is same-origin so the existing CSP already allows it; no CSP change was needed', async () => {
  const r = await new H.Client().get('/'), csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self' 'unsafe-inline'/); assert.match(csp, /connect-src 'self'/);
});

test('config: enabled only when VERCEL is set and WEB_ANALYTICS is not "off" (checked in a clean child process)', () => {
  const { execFileSync } = require('node:child_process');
  const run = (env) => execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/config').webAnalytics))"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, NODE_ENV: 'development', ...env }, encoding: 'utf8' });
  assert.equal(run({}), 'false'); assert.equal(run({ VERCEL: '1' }), 'true'); assert.equal(run({ VERCEL: '1', WEB_ANALYTICS: 'off' }), 'false');
});

test('vercel.json keeps the catch-all rewrite but excludes /_vercel/ so the platform can serve the insights script', () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')), rule = v.rewrites[0];
  assert.equal(rule.destination, '/api');
  const re = new RegExp('^' + rule.source.replace(/^\//, '/') + '$');
  for (const ok of ['/', '/shop', '/listing/12', '/api/cron/tick', '/s/store', '/dashboard/inventory']) assert.match(ok, re, ok);
  for (const no of ['/_vercel/insights/script.js', '/_vercel/insights/view']) assert.doesNotMatch(no, re, no);
  assert.equal(v.crons[0].path, '/api/cron/tick', 'cron untouched');
});

test('the privacy policy discloses Vercel Web Analytics and no longer claims there are no analytics', async () => {
  const t = (await new H.Client().get('/privacy')).text.replace(/<[^>]+>/g, ' ');
  assert.match(t, /Vercel Web Analytics/); assert.match(t, /sets no cookies/); assert.doesNotMatch(t, /have no third-party trackers/);
  assert.match(t, /pp_session/, 'the one session cookie is still described');
});
