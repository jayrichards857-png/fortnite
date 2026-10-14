'use strict';
// READ-ONLY report of seller accounts against the beta cap. Changes nothing.   node scripts/inventory-sellers.js
const { Client } = require('pg');
const config = require('../src/config');
(async () => {
  if (!config.db.url) { console.log('DATABASE_URL is not set.'); return; }
  const c = new Client({ connectionString: config.db.url, ssl: config.db.ssl }); await c.connect();
  try {
    await c.query('SET default_transaction_read_only = on');
    const one = async (sql) => { try { return (await c.query(sql)).rows[0]; } catch { return null; } };
    const sellers = (await c.query('SELECT id, handle, store_name, banned, created_at FROM users WHERE is_seller = 1 ORDER BY id')).rows;
    const pending = (await one("SELECT COUNT(*) n FROM invitations WHERE kind = 'seller' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > CAST(EXTRACT(EPOCH FROM now()) AS BIGINT)"))?.n ?? 0;
    console.log(`Seller accounts: ${sellers.length}   pending seller invitations: ${pending}`);
    for (const s of sellers) console.log(`  #${s.id} @${s.handle} ${s.store_name || ''}${s.banned ? '  [suspended]' : ''}`);
  } finally { await c.end(); }
})().catch((e) => { console.error('inventory failed:', e.message); process.exit(1); });
