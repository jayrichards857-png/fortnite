'use strict';
// Scheduled work. Safe to trigger from anywhere, any number of times: every job runs under a database lease (table job_leases), so
// overlapping triggers (Vercel Cron retries, an external scheduler plus a manual call, several instances) never run the same job twice at
// once, and a job with a minimum interval is skipped until that interval has passed. Each job body is itself idempotent.
const { q, now } = require('./db');

const JOBS = {
  // frequent: free expired reservations, release escrow that is due, lift ended suspensions
  sweep: { everySec: 0, leaseSec: 120, run: async () => {
    await require('./payments').expireStaleCheckouts();
    await require('./escrow').autoReleaseDue();
    await require('./moderation').liftExpired();
  } },
  // hourly: clean-ups
  housekeeping: { everySec: 3600, leaseSec: 300, run: async () => {
    await require('./images').cleanupOrphanUploads();
    await require('./discovery').purgeSearchLog();
    await q.run('DELETE FROM sessions WHERE expires_at < ?', now());
    await require('./auth').purgeRateLimits();
  } },
};

/** Atomically take the lease. Returns false when another run holds it or the minimum interval has not passed. */
async function acquire(name, def) {
  await q.run('INSERT INTO job_leases(name) VALUES(?) ON CONFLICT DO NOTHING', name);
  const t = now();
  const r = await q.run('UPDATE job_leases SET locked_until = ?, last_started_at = ?, runs = runs + 1 WHERE name = ? AND locked_until <= ? AND (? = 0 OR last_finished_at IS NULL OR last_finished_at <= ?)', t + def.leaseSec, t, name, t, def.everySec, t - def.everySec);
  return r.changes === 1;
}

/** Run every due job (or just `only`). Never throws for a failing job: the outcome is returned and recorded. */
async function runDue({ only } = {}) {
  const report = [];
  for (const [name, def] of Object.entries(JOBS)) {
    if (only && only !== name) continue;
    if (!await acquire(name, def)) { report.push({ job: name, ran: false, reason: 'not due or already running' }); continue; }
    let status = 'ok', error = null;
    try { await def.run(); } catch (e) { status = 'error'; error = e.message; console.error(`job ${name} failed:`, e); }
    await q.run('UPDATE job_leases SET locked_until = 0, last_finished_at = ?, last_status = ? WHERE name = ?', now(), status, name);
    report.push({ job: name, ran: true, status, ...(error ? { error: 'see logs' } : {}) });
  }
  return report;
}
module.exports = { JOBS, runDue };
