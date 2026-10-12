'use strict';
// Moderator provisioning for the operator, on the machine that runs PairPlug (reads the same database as the server).
//   node scripts/moderator.js status                              slots used, active moderators, setup links (emails only)
//   node scripts/moderator.js invite --email person@example.com   create ONE individual, single-use setup link (72 h) and print it once
//   node scripts/moderator.js revoke --id 3                       revoke an unused setup link
// The link is the only secret: PairPlug stores just its SHA-256, nothing is emailed, there is no shared password, and the person chooses their own.
// Capacity is five slots in total (active moderators + unused links); the database refuses a sixth. Administrators can do the same from /admin/moderators.
const M = require('../src/moderation');
const { q, now } = require('../src/db');

const args = process.argv.slice(2), cmd = args[0] || 'status';
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(m); process.exit(1); };
const ts = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

(async () => {
try {
  if (cmd === 'status') {
    const s = await M.slots(), r = await M.roster();
    console.log(`Moderator slots: ${s.active + s.pending} of ${s.cap} used (${s.active} active, ${s.pending} unused setup link(s)); ${s.available} free.`);
    for (const u of r.active) console.log(`  active   ${u.email}  (${u.display_name})${u.banned ? '  [banned]' : ''}`);
    for (const i of r.invites.filter((x) => !x.used_at && !x.revoked_at && x.expires_at > now())) console.log(`  pending  #${i.id} ${i.email}  expires ${ts(i.expires_at)}`);
  } else if (cmd === 'invite') {
    const email = String(opt('--email') || '').trim();
    if (!email) fail('Usage: node scripts/moderator.js invite --email person@example.com');
    const out = await M.invite('cli:root', { email, note: opt('--note') });
    console.log(`\nSetup link for ${email.toLowerCase()} (valid until ${ts(out.expiresAt)}, single use):\n\n    ${out.link}\n`);
    console.log('Send it to that person yourself, privately. It is shown once and cannot be recovered; if lost, revoke it and create another.');
    console.log('NOTE: set PUBLIC_URL in the environment first so the link points at the real site (currently ' + require('../src/config').publicUrl + ').');
  } else if (cmd === 'revoke') {
    const id = Number(opt('--id')); if (!id) fail('Usage: node scripts/moderator.js revoke --id <setup link number from "status">');
    await M.revokeInvite('cli:root', id); console.log(`Setup link #${id} revoked.`);
  } else fail('Commands: status | invite --email <address> | revoke --id <n>');
} catch (e) { fail(e.message || String(e)); }
process.exit(0);
})();
void q;
