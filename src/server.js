'use strict';
const express = require('express');
const path = require('node:path');
const config = require('./config');
const { q, ready: dbReady, close: dbClose, schemaVersion } = require('./db');
const auth = require('./auth');
const V = require('./views');
const { HttpError } = require('./util');
const payments = require('./payments');
const escrow = require('./escrow');
const { attachWebSocket } = require('./chat/ws');
const { hostAllowed } = require('./host');

// Express 4 does not route rejected promises from async handlers to the error middleware (the process would crash on an
// unhandled rejection). Patch the router layer once so `async (req,res) => {…}` handlers behave like synchronous ones.
const Layer = require('express/lib/router/layer');
if (!Layer.prototype.__asyncSafe) {
  const handleRequest = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function (req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();                       // error-handling middleware: leave to Express
    try { const r = fn(req, res, next); if (r && typeof r.then === 'function') r.then(undefined, next); }
    catch (err) { next(err); }
  };
  Layer.prototype.__asyncSafe = handleRequest && true;
}

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy (Caddy/nginx) the real client IP comes from X-Forwarded-For; without this every user would share one
// rate-limit bucket. TRUST_PROXY defaults to 'loopback' (proxy on the same machine); set a number of hops for other platforms.
app.set('trust proxy', config.trustProxy);

// On Vercel the app is imported, not started with `node src/server.js`, so the production start-up checks below would never run. Run them on
// the first request instead and answer 503 (details go to the deployment logs, never to the visitor) rather than serving a misconfigured site.
if (config.onVercel) {
  let problems = null;
  app.use((req, res, next) => {
    if (!problems) { problems = assertProductionConfig(); if (config.email.provider !== 'resend') console.warn('EMAIL_PROVIDER is not resend: verification/reset emails are only recorded in the admin Email outbox (/admin/outbox) and must be handed over manually.'); if (problems.length) console.error('Refusing to serve - fix these environment settings:\n - ' + problems.join('\n - ')); }
    if (!problems.length) return next();
    res.status(503).type('text/plain').send('PairPlug is not configured for production yet. See the deployment logs.');
  });
}

// No request is served before the schema is current (a resolved promise after the first call).
app.use(async (req, res, next) => { try { await dbReady(); next(); } catch (e) { console.error(e); res.status(503).type('text/plain').send('Database unavailable'); } });
app.use((req, res, next) => { if (hostAllowed(req)) return next(); res.status(421).type('text/plain').send('Misdirected request'); });
app.use((req, res, next) => {
  const wsOrigin = `ws://${req.headers.host} wss://${req.headers.host}`; // explicit for browsers that don't treat 'self' as ws(s)
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000');
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; connect-src 'self' ${wsOrigin}`,
  });
  next();
});
// Uploaded files: served as inert images only (nosniff above + fixed extensions chosen by the server).
const UPLOAD_HEADERS = { 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' };
const storage = require('./storage');
const localUploads = express.static(config.uploadDir, { maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: (res) => res.set(UPLOAD_HEADERS) });
app.use('/uploads', async (req, res, next) => {
  if (storage.driver().kind === 'fs') return localUploads(req, res, next);       // local disk: exactly as before
  // object storage: the bucket is private, files are read server-side and served as inert images
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = req.path.slice(1);
  if (!storage.FILE.test(file)) return res.status(404).type('text/plain').send('Not found');
  try {
    const buf = await storage.driver().get(file);
    if (!buf) return res.status(404).type('text/plain').send('Not found');
    res.set({ ...UPLOAD_HEADERS, 'Content-Type': storage.mimeOf(file), 'Cache-Control': 'public, max-age=31536000, immutable' }).send(buf);   // names are random and never reused
  } catch (e) { console.error('image read failed:', e.message); res.status(503).type('text/plain').send('Image storage is temporarily unavailable'); }
});
app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0 }));

// Webhook routes need the raw body, so they are mounted before the JSON parser (they apply their own parsers).
let lastSweep = 0;
app.use(async (req, res, next) => { if (Date.now() - lastSweep > 5000) { lastSweep = Date.now(); try { await require('./moderation').liftExpired(); } catch (e) { console.error('suspension sweep failed', e.message); } } next(); });   // timed suspensions end on time even between background ticks
// Scheduled work (Vercel Cron or any external scheduler): GET /api/cron/tick[?job=sweep|housekeeping] with `Authorization: Bearer <CRON_SECRET>`.
// Fails closed when CRON_SECRET is unset, compares in constant time, rate-limits bad attempts, and runs under database leases so repeated or
// overlapping calls never run a job twice at once (src/jobs.js).
app.get('/api/cron/tick', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.cronSecret) return res.status(503).json({ error: 'Scheduled jobs are not configured (CRON_SECRET is not set).' });
  const got = Buffer.from(String(req.headers.authorization || '')), want = Buffer.from(`Bearer ${config.cronSecret}`);
  if (got.length !== want.length || !require('node:crypto').timingSafeEqual(got, want)) { await auth.rateLimit(`cron-auth:${req.ip}`, 30, 600); return res.status(401).json({ error: 'Unauthorized' }); }
  const jobs = require('./jobs'), only = req.query.job ? String(req.query.job) : undefined;
  if (only && !jobs.JOBS[only]) return res.status(400).json({ error: 'Unknown job' });
  res.json({ ok: true, jobs: await jobs.runDue({ only }) });
});
app.use(auth.loadUser);
app.use((req, res, next) => (req.path.startsWith('/webhooks/') || req.path === '/api/uploads' ? next() : express.json({ limit: '2mb' })(req, res, next)));
app.use(auth.csrfGuard);
// An account holding a CLI-issued temporary password can do nothing except change it (or log out) until it has.
app.use((req, res, next) => {
  if (!req.user || !req.user.must_change_password || ['/account', '/api/account/password', '/api/logout', '/healthz'].includes(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Change your temporary password first (Account page).', mustChangePassword: true });
  return res.redirect('/account');
});

app.use(require('./routes/legal').router);
app.use(require('./routes/reviews').router);      // seller reviews + review moderation (must precede the order routers)
app.use(require('./routes/moderation').router);   // moderator setup links, /moderation, moderator management (admin)   // terms, privacy, payments/refunds/disputes, seller rules (public)
app.use(require('./routes/account').router);  // closed sign-ups, invitations, verification, account settings
app.use(require('./routes/store').router);   // storefronts + editor (takes over /s/:handle)
app.use(require('./routes/shipping').router);  // seller shipping labels (test mode)
app.use(require('./routes/discovery').router);   // seller discovery + following
app.use(require('./routes/support').router);  // cases, refunds, reports, admin case tools
app.use(require('./routes/direct').router);   // direct (seller-owned) checkout; must precede the legacy routers
app.use(require('./routes/buyer').router);
app.use(require('./routes/externalSales').router);   // seller's own records of sales made outside PairPlug
app.use(require('./routes/seller').router);
app.use(require('./routes/admin').router);
app.use(require('./routes/adminBeta').router);
app.use(require('./routes/chat').router);

// Health check for uptime monitors / process managers: proves the process is up AND the database answers.
app.get('/healthz', async (req, res) => {
  try { await q.get('SELECT 1'); res.json({ ok: true, checkoutMode: config.checkoutMode, schema: await schemaVersion() }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(async (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).send(await V.layout({ user: req.user, title: 'Not found', body: V.empty('Page not found', "We couldn't find that page.", ['/shop', 'Browse the shop']) }));
});
app.use(async (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err instanceof SyntaxError ? 400 : 500);
  const deliberate = err instanceof HttpError; // our own, user-safe messages (incl. 502/503)
  if (status >= 500 && !deliberate) console.error(err);
  const msg = status >= 500 && !deliberate ? 'Something went wrong. Please try again.' : err.message;
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/') || req.headers.accept === 'application/json') return res.status(status).json({ error: msg, fields: err.fields });
  res.status(status).send(await V.layout({ user: req.user, title: 'Error', body: V.empty(status === 500 ? 'Something went wrong' : msg, 'Please go back and try again.', ['/', 'Home']) }));
});

async function startJobs() {
  // Long-running server (VM / local): run the due jobs every minute. They run under database leases (src/jobs.js), so several instances are safe.
  // On Vercel nothing like this exists: /api/cron/tick is called by Vercel Cron or another scheduler instead.
  const tick = async () => { try { await require('./jobs').runDue(); } catch (e) { console.error('job error', e); } };
  await tick(); return setInterval(tick, 60 * 1000).unref();
}

/** Create the HTTP server with the WebSocket transport attached (used by `npm start` and by the tests). */
function createServer() {
  const server = require('node:http').createServer(app);
  attachWebSocket(server);
  return server;
}

/** Refuse to start in production with settings that would be unsafe or misleading. */
function assertProductionConfig() {
  const problems = [...config.envProblems];
  if (!config.db.url) problems.push('DATABASE_URL is required (postgres://user:pass@host:5432/dbname)');
  else {
    let u = null; try { u = new URL(config.db.url); } catch { problems.push('DATABASE_URL is not a valid postgres:// URL'); }
    // a database reached over a network must be encrypted (managed databases): DATABASE_SSL=1 or ?sslmode=require. DATABASE_ALLOW_PLAINTEXT=1 is an explicit opt-out for a private network.
    if (u && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname) && !config.db.ssl && !/sslmode=(require|verify-ca|verify-full)/.test(config.db.url) && process.env.DATABASE_ALLOW_PLAINTEXT !== '1')
      problems.push('DATABASE_URL points at a remote database without TLS: set DATABASE_SSL=1 (or ?sslmode=require), or DATABASE_ALLOW_PLAINTEXT=1 on a private network');
  }
  if (!/^https:\/\//.test(config.publicUrl)) problems.push('PUBLIC_URL must be the public https:// address of the site');
  if (config.paymentsMode === 'sandbox') problems.push('PAYMENTS_MODE=sandbox simulates payments and must never run in production');
  if (config.isProd && config.shippo.apiKey) problems.push('SHIPPO_API_KEY must not be set in production: label purchasing is test-mode only until postage billing is verified (docs/SHIPPING.md)');
  if (config.isProd && config.sellerOnboardingRequested === 'open') problems.push('SELLER_ONBOARDING=open is not allowed in production (sellers are invitation-only)');
  if (config.sellerOnboarding !== 'invite') problems.push('SELLER_ONBOARDING must be "invite" in production (hard seller cap, invitation-only)');
  if (config.email.provider === 'resend' && !(config.email.apiKey && config.email.from)) problems.push('EMAIL_PROVIDER=resend needs EMAIL_API_KEY and EMAIL_FROM');
  if (config.rateLimitScale !== 1) problems.push('RATE_LIMIT_SCALE must not be changed in production');
  if (config.checkoutMode === 'platform' && !config.stripe.secretKey) problems.push('CHECKOUT_MODE=platform needs a configured payment provider; use CHECKOUT_MODE=external for the beta');
  if (config.onVercel) {            // serverless hosting: every service the app cannot do without must be configured (nothing is silently switched off)
    if (!config.isProd) problems.push('NODE_ENV must be production on Vercel');
    if (!config.storage.s3) problems.push('durable image storage is required on Vercel: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (docs/VERCEL.md)');
    if (config.cronSecret.length < 32) problems.push('CRON_SECRET (at least 32 random characters) is required for scheduled jobs (docs/VERCEL.md)');
    if (config.trustProxy === 'loopback') problems.push('TRUST_PROXY=1 is required behind Vercel (otherwise every visitor shares one rate-limit identity)');
    if (!process.env.PAIRPLUG_DB_LABEL || process.env.PAIRPLUG_DB_LABEL.trim() !== config.vercelEnv) problems.push(`PAIRPLUG_DB_LABEL must equal this deployment's environment ("${config.vercelEnv || 'unknown'}"): scope DATABASE_URL and PAIRPLUG_DB_LABEL per environment so a preview can never use production data`);
  }
  return problems;
}

if (require.main === module) {
  if (config.isProd) {
    const problems = assertProductionConfig();
    if (problems.length) { console.error('Refusing to start:\n - ' + problems.join('\n - ')); process.exit(1); }
  }
  if (config.supportEmailOverridden) console.warn(`NOTE: SUPPORT_EMAIL is set to ${config.supportEmail}, which overrides the official PairPlug address (${config.officialSupportEmail}). Make sure that is intended.`);
  dbReady().then(() => {
  const server = createServer();
  server.listen(config.port, config.host, async () => {
    try { await startJobs(); } catch (e) { console.error('startup jobs failed', e); process.exit(1); }
    const p = payments.getProvider();
    console.log(`PairPlug listening on ${config.publicUrl} [bound to ${config.host}:${config.port}]  (checkout: ${config.checkoutMode}${config.checkoutMode === 'platform' ? `, payments: ${p ? p.name : 'DISABLED'}` : ', sellers are paid directly'})`);
  });
  }, (e) => { console.error('Cannot start: ' + e.message); process.exit(1); });
}
// Graceful shutdown (systemd stop / deploy): close the PostgreSQL pool and exit.
if (require.main === module) {
  const stop = (sig) => { console.log(`${sig}: shutting down`); setTimeout(() => process.exit(0), 5000).unref();
    dbClose().catch(() => {}).finally(() => process.exit(0)); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
module.exports = { app, createServer, startJobs, assertProductionConfig };
