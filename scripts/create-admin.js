'use strict';
// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/create-admin.js
const { q, now } = require('../src/db');
const { hashPassword } = require('../src/auth');
const email = (process.env.ADMIN_EMAIL || '').toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
if (!email || pw.length < 10) { console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ chars).'); process.exit(1); }
const u = q.get('SELECT id FROM users WHERE email = ?', email);
if (u) { q.run('UPDATE users SET is_admin = 1 WHERE id = ?', u.id); console.log('Existing user promoted to admin.'); }
else { q.run('INSERT INTO users(email, password_hash, display_name, is_admin, created_at) VALUES(?,?,?,1,?)', email, hashPassword(pw), 'Administrator', now()); console.log('Admin created.'); }
