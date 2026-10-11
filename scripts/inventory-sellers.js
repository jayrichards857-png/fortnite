'use strict';
// READ-ONLY report of seller accounts against the beta cap. Changes nothing.   node scripts/inventory-sellers.js
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const config = require('../src/config');
if (!fs.existsSync(config.dbFile)) { console.log('No database at ' + config.dbFile); process.exit(0); }
const db = new DatabaseSync(config.dbFile, { readOnly: true });
const one = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };
const cap = Number(one("SELECT value FROM settings WHERE key = 'seller_cap'")?.value ?? 3);
const sellers = db.prepare('SELECT id, handle, store_name, banned, created_at FROM users WHERE is_seller = 1 ORDER BY id').all();
const pending = one("SELECT COUNT(*) n FROM invitations WHERE kind = 'seller' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%s','now')")?.n ?? 0;
console.log(`Seller accounts: ${sellers.length}   cap: ${cap}   pending seller invitations: ${pending}`);
for (const s of sellers) console.log(`  #${s.id} @${s.handle} ${s.store_name || ''}${s.banned ? '  [suspended]' : ''}`);
if (sellers.length > cap) console.log(`OVER CAP by ${sellers.length - cap}. Nothing is deleted; new seller onboarding stays blocked until slots are released by an admin.`);
else console.log(`Free slots (before pending invitations): ${cap - sellers.length}`);
db.close();
