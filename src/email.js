'use strict';
// Transactional email boundary. EVERY message is recorded in `email_outbox` first. With no provider configured the row stays
// 'not_configured' and nothing is claimed as delivered (an admin can read the outbox to hand a link over manually).
// Providers: 'resend' (HTTP API, needs EMAIL_API_KEY + EMAIL_FROM; NOT verified against the live service) or the test-only mock.
const config = require('./config');
const { q, now } = require('./db');

let mock = null;                      // tests inject a function; such rows are labelled provider='mock-test' so they can never be mistaken for real sends
const setMockProvider = (fn) => { mock = fn; };
const isConfigured = () => Boolean(mock) || (config.email.provider === 'resend' && config.email.apiKey && config.email.from);

const providers = {
  async resend(m) {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.email.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.email.from, to: [m.to], subject: m.subject, text: m.text }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`provider rejected the message (${res.status})`);
    return { ref: json.id || null };
  },
};

/**
 * Record, then (if a provider is configured) attempt delivery. Returns a promise of the final status; callers may ignore it.
 * `dedupeKey` makes retries/double-submits record at most one message.
 */
function send({ to, subject, text, kind, dedupeKey = null }) {
  const t = now();
  const r = q.run("INSERT OR IGNORE INTO email_outbox(to_email, subject, body, kind, dedupe_key, status, created_at) VALUES(?,?,?,?,?, 'not_configured', ?)", to, subject, text, kind, dedupeKey, t);
  if (r.changes === 0) return Promise.resolve({ status: 'duplicate' });
  const id = Number(r.lastInsertRowid);
  if (!isConfigured()) return Promise.resolve({ status: 'not_configured', id });
  const deliver = mock ? async (m) => ({ ref: await mock(m) || 'mock' }) : providers[config.email.provider];
  const provider = mock ? 'mock-test' : config.email.provider;
  return Promise.resolve().then(() => deliver({ to, subject, text })).then((out) => {
    // delivered: drop the body (it may contain a one-time link) and keep only the fact of delivery
    q.run("UPDATE email_outbox SET status='sent', provider=?, provider_ref=?, sent_at=?, body='(sent; body not retained)' WHERE id=?", provider, out.ref, now(), id);
    return { status: 'sent', id };
  }).catch((e) => {
    q.run("UPDATE email_outbox SET status='failed', provider=?, error=? WHERE id=?", provider, String(e.message).slice(0, 200), id);
    return { status: 'failed', id };
  });
}
module.exports = { send, isConfigured, setMockProvider };
