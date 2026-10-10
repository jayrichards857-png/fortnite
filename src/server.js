'use strict';
const express = require('express');
const path = require('node:path');
const config = require('./config');
const { q } = require('./db');
const auth = require('./auth');
const V = require('./views');
const { HttpError } = require('./util');
const payments = require('./payments');
const escrow = require('./escrow');
const { attachWebSocket } = require('./chat/ws');

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy (Caddy/nginx) the real client IP comes from X-Forwarded-For; without this every user would share one
// rate-limit bucket. TRUST_PROXY defaults to 'loopback' (proxy on the same machine); set a number of hops for other platforms.
app.set('trust proxy', config.trustProxy);

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
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: (res) => res.set('Content-Disposition', 'inline') }));
app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0 }));

// Webhook routes need the raw body, so they are mounted before the JSON parser (they apply their own parsers).
app.use(auth.loadUser);
app.use((req, res, next) => (req.path.startsWith('/webhooks/') || req.path === '/api/uploads' ? next() : express.json({ limit: '2mb' })(req, res, next)));
app.use(auth.csrfGuard);

app.use(require('./routes/direct').router);   // direct (seller-owned) checkout; must precede the legacy routers
app.use(require('./routes/buyer').router);
app.use(require('./routes/seller').router);
app.use(require('./routes/admin').router);
app.use(require('./routes/chat').router);

// Health check for uptime monitors / process managers: proves the process is up AND the database answers.
app.get('/healthz', (req, res) => {
  try { q.get('SELECT 1'); res.json({ ok: true, checkoutMode: config.checkoutMode }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Page not found', "We couldn't find that page.", ['/shop', 'Browse the shop']) }));
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err instanceof SyntaxError ? 400 : 500);
  const deliberate = err instanceof HttpError; // our own, user-safe messages (incl. 502/503)
  if (status >= 500 && !deliberate) console.error(err);
  const msg = status >= 500 && !deliberate ? 'Something went wrong. Please try again.' : err.message;
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/') || req.headers.accept === 'application/json') return res.status(status).json({ error: msg, fields: err.fields });
  res.status(status).send(V.layout({ user: req.user, title: 'Error', body: V.empty(status === 500 ? 'Something went wrong' : msg, 'Please go back and try again.', ['/', 'Home']) }));
});

function startJobs() {
  // Background sweeps. Both are idempotent and also safe if several app instances run them.
  const tick = () => { try { payments.expireStaleCheckouts(); escrow.autoReleaseDue(); } catch (e) { console.error('job error', e); } };
  tick(); return setInterval(tick, 60 * 1000).unref();
}

/** Create the HTTP server with the WebSocket transport attached (used by `npm start` and by the tests). */
function createServer() {
  const server = require('node:http').createServer(app);
  attachWebSocket(server);
  return server;
}

/** Refuse to start in production with settings that would be unsafe or misleading. */
function assertProductionConfig() {
  const problems = [];
  if (!/^https:\/\//.test(config.publicUrl)) problems.push('PUBLIC_URL must be the public https:// address of the site');
  if (config.paymentsMode === 'sandbox') problems.push('PAYMENTS_MODE=sandbox simulates payments and must never run in production');
  if (config.rateLimitScale !== 1) problems.push('RATE_LIMIT_SCALE must not be changed in production');
  if (config.checkoutMode === 'platform' && !config.stripe.secretKey) problems.push('CHECKOUT_MODE=platform needs a configured payment provider; use CHECKOUT_MODE=external for the beta');
  return problems;
}

if (require.main === module) {
  if (config.isProd) {
    const problems = assertProductionConfig();
    if (problems.length) { console.error('Refusing to start:\n - ' + problems.join('\n - ')); process.exit(1); }
  }
  const server = createServer();
  server.listen(config.port, () => {
    startJobs();
    const p = payments.getProvider();
    console.log(`PairPlug listening on ${config.publicUrl}  (checkout: ${config.checkoutMode}${config.checkoutMode === 'platform' ? `, payments: ${p ? p.name : 'DISABLED'}` : ', sellers are paid directly'})`);
  });
}
// Graceful shutdown (systemd stop / deploy): stop accepting connections, flush the SQLite WAL, exit.
if (require.main === module) {
  const stop = (sig) => { console.log(`${sig}: shutting down`); setTimeout(() => process.exit(0), 5000).unref();
    require('./db').db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
module.exports = { app, createServer, startJobs, assertProductionConfig };
