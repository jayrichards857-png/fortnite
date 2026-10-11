'use strict';
// TEST-ONLY helper for the browser scripts: marks accounts in a THROWAWAY database as email-verified so journeys can continue
// without a real mailbox. Never point it at a real database.
const { DatabaseSync } = require('node:sqlite');
module.exports = function verifyAll(dbFile) {
  const db = new DatabaseSync(dbFile);
  try { db.exec('PRAGMA busy_timeout = 5000'); db.exec("UPDATE users SET email_verified_at = strftime('%s','now') WHERE email_verified_at IS NULL"); } finally { db.close(); }
};
