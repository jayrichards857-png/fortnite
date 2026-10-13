'use strict';
// Read-only configuration check for a Vercel environment. Prints which settings are present/missing and what the app's own production
// start-up checks say. It never connects to anything and never prints a value (only variable NAMES and database host names).
//   npm run check:config -- --as production      (run with that environment's variables loaded in the shell)
//   npm run check:config -- --as preview
const as = process.argv.includes('--as') ? process.argv[process.argv.indexOf('--as') + 1] : '';
if (!['production', 'preview'].includes(as)) { console.error('Usage: npm run check:config -- --as production|preview'); process.exit(2); }
Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: as, NODE_ENV: 'production' });
const { assertProductionConfig } = require('../src/server');
const config = require('../src/config');

const NAMES = ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'PAIRPLUG_DB_LABEL', 'PUBLIC_URL', 'CHECKOUT_MODE', 'SELLER_ONBOARDING', 'TRUST_PROXY', 'CRON_SECRET', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'EMAIL_PROVIDER'];
console.log(`Checking as: ${as}`);
for (const n of NAMES) console.log(`  ${process.env[n] ? 'set    ' : 'MISSING'} ${n}`);
const host = (v) => { try { return new URL(v).hostname; } catch { return null; } };
const notes = [];
if (config.db.url) console.log(`DATABASE_URL host: ${host(config.db.url) || '(invalid URL)'}`);
if (config.db.urlDirect) console.log(`DATABASE_URL_UNPOOLED host: ${host(config.db.urlDirect) || '(invalid URL)'}`);
if (config.db.url && !/-pooler\b/i.test(host(config.db.url) || '')) notes.push('DATABASE_URL does not look like a Neon POOLED host (no "-pooler"): the app should use the pooled string.');
if (config.db.urlDirect && /-pooler\b/i.test(host(config.db.urlDirect) || '')) notes.push('DATABASE_URL_UNPOOLED is a POOLED host: it must be the direct connection string.');
if (config.db.url && config.db.urlDirect && host(config.db.url).replace('-pooler', '') !== host(config.db.urlDirect).replace('-pooler', '')) notes.push('DATABASE_URL and DATABASE_URL_UNPOOLED point at DIFFERENT Neon endpoints (different branches?). They must be the same branch.');
if (as === 'production' && config.publicUrl !== 'https://pairplug.vercel.app') notes.push('PUBLIC_URL is not https://pairplug.vercel.app (fine only if you use another production domain).');
const problems = assertProductionConfig();
console.log(problems.length ? '\nThe app would REFUSE to serve (503) because:' : '\nThe app\'s own checks pass.');
for (const p of problems) console.log(' - ' + p);
for (const n of notes) console.log(' * ' + n);
process.exit(problems.length ? 1 : 0);
