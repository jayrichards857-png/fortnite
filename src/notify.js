'use strict';
const { q, now } = require('./db');

// dedupeKey identifies the *event* (e.g. "order:12:shipped"). UNIQUE(user_id, dedupe_key) +
// INSERT OR IGNORE means retried webhooks / double clicks never produce duplicate notifications.
// In-app only: no email/SMS/push integration exists.
function notify(userId, dedupeKey, title, body, link) {
  q.run('INSERT OR IGNORE INTO notifications(user_id, title, body, link, dedupe_key, created_at) VALUES(?,?,?,?,?,?)',
    userId, title, body || null, link || null, dedupeKey, now());
}
module.exports = { notify };
