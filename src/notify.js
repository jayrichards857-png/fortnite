'use strict';
const { q, now } = require('./db');

// dedupeKey identifies the *event* (e.g. "order:12:shipped"). UNIQUE(user_id, dedupe_key) +
// ON CONFLICT DO NOTHING means retried webhooks / double clicks never produce duplicate notifications.
// In-app only: no email/SMS/push integration exists.
async function notify(userId, dedupeKey, title, body, link) {
  await q.run('INSERT INTO notifications(user_id, title, body, link, dedupe_key, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    userId, title, body || null, link || null, dedupeKey, now());
}
module.exports = { notify };
