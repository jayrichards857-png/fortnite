'use strict';
// Administrator setup and recovery for a LOCAL or server installation. Passwords are never stored or shown after creation: only a scrypt hash is kept.
//   node scripts/create-admin.js status                       list administrator accounts (emails only) and whether each must still change its password
//   node scripts/create-admin.js setup [--email you@x.com]    first-run: create the first administrator (refuses if one exists)
//   node scripts/create-admin.js reset --email you@x.com      recovery: new temporary password for an existing administrator (old password is not recoverable)
//   node scripts/create-admin.js promote --email you@x.com    make an existing account an administrator (password unchanged)
// setup/reset generate a strong random TEMPORARY password, print it ONCE to this terminal, and force a password change at first login.
// Non-interactive deployments may instead pass ADMIN_EMAIL + ADMIN_PASSWORD (10+ chars) in the environment; that password is the operator's own choice.
const crypto = require('node:crypto');
const { q, now, ready, close } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { audit } = require('../src/audit');
const config = require('../src/config');

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'setup';
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const email = String(opt('--email') || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (m) => { console.error(m); process.exit(1); };
const admins = async () => await q.all('SELECT id, email, display_name, must_change_password, created_at FROM users WHERE is_admin = 1 ORDER BY id');
const temp = () => crypto.randomBytes(15).toString('base64url');            // 20 chars, ~120 bits
const base = process.env.PUBLIC_URL || `http://localhost:${config.port}`;

// ---- target safety. This tool changes WHO CAN LOG IN, so it must be certain which database it is talking to.
// Local databases behave as before. A REMOTE database (anything not on this machine, e.g. Neon): the target host is printed; every command that
// writes needs PAIRPLUG_DB_LABEL and --confirm-host <that host>; and the schema is only VERIFIED, never created or migrated (use `npm run migrate`).
let dbUrl = null; try { dbUrl = new URL(config.db.url); } catch { /* reported below */ }
const REMOTE = Boolean(dbUrl) && !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(dbUrl.hostname);
const WRITES = ['setup', 'reset', 'promote'];
if (!dbUrl) fail('DATABASE_URL is not set (or not a valid URL; value not shown). Point it at the database you mean to change.');
console.log(`database: ${dbUrl.hostname}${dbUrl.pathname}  (${REMOTE ? 'REMOTE' : 'local'})${process.env.PAIRPLUG_DB_LABEL ? `  label=${process.env.PAIRPLUG_DB_LABEL}` : ''}`);
if (REMOTE) {
  config.db.autoMigrate = false;                                  // never create or alter a remote schema from here
  if (WRITES.includes(cmd)) {
    if (!process.env.PAIRPLUG_DB_LABEL) fail('Refusing: this is a remote database. Set PAIRPLUG_DB_LABEL (production or preview) to state which environment it is.');
    if (opt('--confirm-host') !== dbUrl.hostname) fail(`Refusing: re-run with --confirm-host ${dbUrl.hostname}  (only after checking that host is the intended Neon branch; run \`status\` first).`);
  }
}

function announce(addr, pw, generated) {
  console.log(`\nAdministrator account: ${addr}`);
  if (generated) {
    console.log('TEMPORARY PASSWORD (shown once, not stored, not logged):');
    console.log(`\n    ${pw}\n`);
    console.log('Sign in, then change it immediately: you will be taken to the Account page automatically.');
  } else console.log('Password: the one you supplied in ADMIN_PASSWORD.');
  console.log(`Log in at ${base}/login   (administrator tools: ${base}/admin)`);
  console.log('This is an ADMINISTRATOR login. Buyer and seller accounts are separate and have no admin access.');
}
function chooseSecret() {
  const given = process.env.ADMIN_PASSWORD || '';
  if (given && given.length < 10) fail('ADMIN_PASSWORD must be at least 10 characters.');
  return given ? { pw: given, generated: false } : { pw: temp(), generated: true };
}

async function main() {
  await ready();                                   // connects and brings the schema up to date (a brand-new database is created here)
if (cmd === 'status') {
  const a = await admins();
  if (!a.length) console.log('No administrator exists yet. Run:  node scripts/create-admin.js setup --email you@example.com');
  for (const x of a) console.log(`admin #${x.id}  ${x.email}  (${x.display_name})${x.must_change_password ? '  [temporary password: must be changed at next login]' : ''}`);
  if (a.length) console.log('Forgot the password? It cannot be recovered. Run:  node scripts/create-admin.js reset --email <the email above>');
} else if (cmd === 'setup') {
  const a = await admins();
  if (a.length) fail(`An administrator already exists: ${a.map((x) => x.email).join(', ')}\nTo get back in, run:  node scripts/create-admin.js reset --email ${a[0].email}`);
  if (!EMAIL_RE.test(email)) fail('Provide your email:  node scripts/create-admin.js setup --email you@example.com');
  if (await q.get('SELECT 1 x FROM users WHERE email = ?', email)) fail(`${email} already has an account. Use:  node scripts/create-admin.js promote --email ${email}`);
  const { pw, generated } = chooseSecret();
  await q.run('INSERT INTO users(email, password_hash, display_name, is_admin, email_verified_at, must_change_password, created_at) VALUES(?,?,?,1,?,?,?)', email, hashPassword(pw), 'Administrator', now(), generated ? 1 : 0, now());
  await audit('cli', 'admin_created', { type: 'user', detail: { email } });
  announce(email, pw, generated);
} else if (cmd === 'reset') {
  if (!EMAIL_RE.test(email)) fail('Provide the administrator email:  node scripts/create-admin.js reset --email you@example.com');
  const u = await q.get('SELECT id, is_admin FROM users WHERE email = ?', email);
  if (!u) fail(`No account for ${email}. Run \`status\` to see administrators.`);
  if (!u.is_admin) fail(`${email} is not an administrator. Use \`promote\` first.`);
  const { pw, generated } = chooseSecret();
  await q.run('UPDATE users SET password_hash = ?, must_change_password = ?, banned = 0 WHERE id = ?', hashPassword(pw), generated ? 1 : 0, u.id);
  await q.run('DELETE FROM sessions WHERE user_id = ?', u.id);                       // every existing session is signed out
  await audit('cli', 'admin_password_reset', { type: 'user', id: u.id });
  announce(email, pw, generated);
} else if (cmd === 'promote') {
  if (!EMAIL_RE.test(email)) fail('Provide the account email:  node scripts/create-admin.js promote --email you@example.com');
  const u = await q.get('SELECT id, is_admin FROM users WHERE email = ?', email);
  if (!u) fail(`No account for ${email}.`);
  if (u.is_admin) fail(`${email} is already an administrator.`);
  await q.run('UPDATE users SET is_admin = 1 WHERE id = ?', u.id);
  await audit('cli', 'admin_promoted', { type: 'user', id: u.id });
  console.log(`${email} is now an administrator. Their password is unchanged.`);
} else fail('Usage: node scripts/create-admin.js status | setup --email X | reset --email X | promote --email X');
}
main().then(() => close().then(() => process.exit(0)), (e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
