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

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
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

app.use(require('./routes/buyer').router);
app.use(require('./routes/seller').router);
app.use(require('./routes/admin').router);

app.get('/healthz', (req, res) => { q.get('SELECT 1'); res.json({ ok: true }); });

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

if (require.main === module) {
  app.listen(config.port, () => {
    startJobs();
    const p = payments.getProvider();
    console.log(`PairPlug listening on ${config.publicUrl}  (payments: ${p ? p.name : 'DISABLED — set STRIPE_SECRET_KEY or PAYMENTS_MODE=sandbox'})`);
  });
}
module.exports = { app, startJobs };
