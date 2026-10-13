'use strict';
// Production Host-header validation: the app only answers for its own public hostname (plus loopback for health checks).
// Prevents host-header poisoning of generated links and CSP, and stray traffic that reaches the origin by IP.
const config = require('./config');

function publicHost() { try { return new URL(config.publicUrl).host.toLowerCase(); } catch { return ''; } }
function hostAllowed(req) {
  if (!config.isProd) return true;
  const host = String(req.headers.host || '').toLowerCase();
  if (host && host === publicHost()) return true;
  const path = String(req.url || '').split('?')[0];
  if (path.startsWith('/api/cron/')) return true;       // called by the scheduler on whatever host the deployment has; protected by its own bearer secret
  return path === '/healthz' && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}
module.exports = { hostAllowed, publicHost };
