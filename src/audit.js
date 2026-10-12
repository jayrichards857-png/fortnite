'use strict';
// Append-only audit trail (database triggers forbid UPDATE/DELETE). Never put secrets, tokens or passwords in `detail`.
const { q, now } = require('./db');

/** @param actor a user object, or a string label such as 'cli:root' for command-line recovery operations */
async function audit(actor, action, { type = null, id = null, detail = null } = {}) {
  const isUser = actor && typeof actor === 'object';
  await q.run('INSERT INTO audit_log(actor_id, actor_label, action, target_type, target_id, detail, created_at) VALUES(?,?,?,?,?,?,?)',
    isUser ? actor.id : null, isUser ? `user:${actor.id}` : String(actor || 'system'), action, type, id == null ? null : String(id),
    detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000), now());
}
module.exports = { audit };
