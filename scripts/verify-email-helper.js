'use strict';
// TEST-ONLY helper for the browser scripts: marks accounts in a THROWAWAY database as email-verified so journeys can continue
// without a real mailbox. Never point it at a real database: it refuses any database whose name does not start with pp_test_.
const { Client } = require('pg');
const { dbName } = require('./lib/pg');
module.exports = async function verifyAll(databaseUrl, where = '') {
  if (!/^pp_test_/.test(dbName(databaseUrl))) throw new Error('verify-email-helper only runs against throwaway pp_test_* databases');
  const c = new Client({ connectionString: databaseUrl }); await c.connect();
  try { await c.query(`UPDATE users SET email_verified_at = CAST(EXTRACT(EPOCH FROM now()) AS BIGINT) WHERE email_verified_at IS NULL ${where}`); } finally { await c.end(); }
};
