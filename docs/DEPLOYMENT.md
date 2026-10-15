# Grailedside private beta — deployment & operations

**Status: NOT deployed.** I (the assistant) have no cloud account, credentials or domain, so nothing is live and nothing here was run on a real server.
What *was* verified in this repo (against a local PostgreSQL 16): the app starts in production mode and refuses unsafe settings, `/healthz`, backup → restore → verify, the SQLite → PostgreSQL import, concurrency on orders/stock, and the whole
buyer/seller journey in a real browser. The systemd/Caddy files below are written but **untested on a real VM**.

> **The database is PostgreSQL** (since schema v16 was ported; see `docs/POSTGRES_MIGRATION.md`). The old SQLite file (`data/pairplug.db`) is no longer read by the app; it is only the *input* of the one-off import in §8. **Uploaded photos are still plain files on disk** and still need persistent storage.

## 1. What the app needs (verified from the code)
| Requirement | Detail |
|---|---|
| Runtime | Node **22.x, tested on 22.22.0** (≥ 22.13 is still required: the one-off SQLite importer uses `node:sqlite`). One long-running process. In production it listens on **127.0.0.1 only**; the reverse proxy is the public entry point. |
| Database | **PostgreSQL 16** (tested on 16.15), reached through `DATABASE_URL` (`postgres://user:pass@host:5432/db`). The role must be able to create tables and `CREATE EXTENSION citext` (a *trusted* extension, available on managed PostgreSQL). Migrations run automatically at start-up under an advisory lock. A database on another host **must** use TLS (`?sslmode=require` or `DATABASE_SSL=1`); production refuses to start otherwise. Pool size `PGPOOL_MAX` (default 10). The PostgreSQL client tools `pg_dump`/`pg_restore` (16+) are needed on the machine that runs backups. |
| Photos | Files in `PAIRPLUG_UPLOADS` (random names, never overwritten). **Persistent disk required** — if lost, listings lose their photos. |
| Sessions | Stored in the database (survive restarts). |
| WebSockets | Chat uses `/api/chat/ws`; it falls back to long-polling automatically if a proxy blocks WebSockets. Caddy/nginx proxy WebSockets fine. |
| HTTPS / env | HTTPS terminated by a reverse proxy; config via environment variables (`deploy/pairplug.env.example`). The only secret in beta mode is the **database password** inside `DATABASE_URL`. |
| Build / start / health | Build: `npm ci --omit=dev` · Start: `node src/server.js` · Health: `GET /healthz` → `{"ok":true,"checkoutMode":"external","schema":16}` (HTTP 503 `{"ok":false}` when the database cannot be reached) |
| Single instance | Run **one** app process: the chat live-push hub, rate limiter and search caches are in-memory (the database itself now tolerates several writers, and background jobs are safe to overlap). |

## 2. Hosting options checked (searched 2026-10-10; third-party sources noted — confirm on the provider's own pages before signing up)
**With PostgreSQL the database no longer needs the app's disk, but the product photos still do** (they remain files in `PAIRPLUG_UPLOADS`), so a host with an ephemeral filesystem still cannot run Grailedside without losing photos on every restart/redeploy. Moving photos to object storage is the remaining step to a fully "stateless" app server. Hosted PostgreSQL free tiers were **not** assumed permanent: e.g. [Render's free Postgres expires 30 days after creation and has no backups](https://render.com/docs/free) (per Render's docs as of 2026-10-12). Whatever you choose, check the provider's own current limits and backup terms before storing real data there.
| Option | Persistent disk? | Truly $0? | Verdict |
|---|---|---|---|
| **Render free web service** | **No.** [Free services have an ephemeral filesystem and spin down after 15 min idle; persistent disks are paid-only](https://render.com/docs/free) ([disks docs](https://docs.render.com/disks)) | $0 but would lose the photos (and a free Postgres expires after 30 days, no backups) | ❌ Unsuitable |
| **Fly.io** | Volumes exist | **No.** [New accounts get a short trial, not a free tier; volumes ≈ $0.15/GB-month](https://fly.io/docs/about/discontinued-plans/) (third-party summaries; unverified on Fly's pricing page) | ❌ Not $0 (small monthly cost) |
| **Google Cloud “Always Free” e2-micro** | **Yes**: [1 e2-micro VM/month in us-west1, us-central1 or us-east1 + 30 GB-month *standard* persistent disk + 1 GB/month North-America egress](https://cloud.google.com/free/docs/compute-getting-started) | $0 **if you stay inside the limits**. Needs a billing account/card on file. Choose the **Standard** disk (the default “Balanced” disk is not free). Set a budget alert; >1 GB/month egress is billed | ✅ **Best fit** |
| **Oracle Cloud Always Free** | Yes (200 GB block storage total) | $0 but needs card verification; [reports say the Arm allowance was cut in 2026 and over-limit instances can be terminated](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/) — check the console | ⚠️ Alternative; policy risk |
| **Cloudflare quick tunnel** (from a laptop) | n/a | [“No SLA/uptime”, temporary random URL, testing only; a stable named tunnel needs a domain on Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) | ❌ Not for real buyers |

**Recommendation:** one GCP Always Free e2-micro VM (Debian/Ubuntu, Standard disk, region us-central1/us-west1/us-east1) + Caddy for HTTPS + the files in `deploy/`.
**Blockers I cannot remove for you:** (1) someone must create the cloud account (a card is required for identity/billing, nothing is charged inside the free limits);
(2) a **hostname** is needed for HTTPS (a domain costs money; a free dynamic-DNS subdomain such as DuckDNS may work with Caddy's automatic certificates — **I did not verify this**);
(3) 1 GB of free egress/month is small — product photos are the main traffic; watch the budget alert.

## 3. First-time setup on a fresh Debian/Ubuntu VM (untested outline)
```bash
# 1. Node 22 (any method that gives node >= 22.13), git, Caddy (https://caddyserver.com/docs/install) and PostgreSQL 16 server + client tools
#    (or a managed PostgreSQL: then only the client tools are needed here)
# 1b. Database (local server example; a managed database gives you the URL instead):
#     sudo -u postgres createuser pairplug --pwprompt && sudo -u postgres createdb pairplug --owner pairplug
#     -> DATABASE_URL=postgres://pairplug:THE-PASSWORD@127.0.0.1:5432/pairplug
# 2. Service user + directories
sudo useradd --system --home /opt/pairplug --shell /usr/sbin/nologin pairplug
sudo mkdir -p /opt/pairplug /var/lib/pairplug/uploads /var/backups/pairplug      # uploads = product photos: PERSISTENT storage required
sudo git clone <your repo URL> /opt/pairplug && cd /opt/pairplug && sudo git checkout <the release branch>
sudo npm ci --omit=dev
sudo chown -R pairplug:pairplug /opt/pairplug /var/lib/pairplug /var/backups/pairplug
# 3. Config (the database password is the only secret in beta mode)
sudo cp deploy/pairplug.env.example /etc/pairplug.env && sudo chown root:pairplug /etc/pairplug.env && sudo chmod 640 /etc/pairplug.env
sudo nano /etc/pairplug.env   # set PUBLIC_URL, PUBLIC_RELEASE_DATE (confirm the real date). SUPPORT_EMAIL is optional: unset means the official pairplugservice@gmail.com. No trailing '# comments' after values (the app refuses to start if it sees one)
# 4. Service, proxy, backups
sudo cp deploy/pairplug.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now pairplug
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile && sudo systemctl reload caddy      # set your hostname
sudo cp deploy/pairplug-backup.cron /etc/cron.d/pairplug-backup
# 5. Check
curl -s https://YOUR-SITE-ADDRESS/healthz
# 6. Create the admin account (as the service user). It prints a random temporary password ONCE; change it at first login.
sudo -u pairplug bash -c 'set -a; . /etc/pairplug.env; set +a; cd /opt/pairplug; node scripts/create-admin.js setup --email you@example.com'
# later: `status` shows who the admin is; `reset --email you@example.com` issues a new temporary password (the old one is not recoverable)
```
In production the server **refuses to start** if `PUBLIC_URL` isn't https, if `PAYMENTS_MODE=sandbox` is set, if `CHECKOUT_MODE=platform` has no payment provider, if `SELLER_ONBOARDING`/`CHECKOUT_MODE` hold an unrecognised value, or if any setting contains an inline ` # comment`. Buyer sign-up is **open by default** (it creates buyer accounts only; `SIGNUPS=closed` pauses it), the public **Sell** page is “Coming Soon!” for everyone but approved sellers, seller onboarding is invitation-only and refused outright if `SELLER_ONBOARDING=open` is set in production, `HOST` defaults to 127.0.0.1, and requests whose `Host` header isn't the `PUBLIC_URL` host are rejected (421).

## 4. Backups and recovery
* Daily cron runs `scripts/backup.js`: `pg_dump` (custom format) taken inside one exported REPEATABLE READ snapshot, so the dump and its manifest describe the same instant while the site keeps serving. The manifest (`<dump>.json`) holds the schema version, the row count of **every table** and the dump's SHA-256; the archive is read back with `pg_restore --list` before the backup counts as good. Files `0600`, directories `0700`, newest 14 dumps kept in `/var/backups/pairplug`; new photos are copied incrementally (they are immutable, randomly named files). The database password is passed to `pg_dump` through `PG*` environment variables, never on a command line, and is not written anywhere.
* **Those backups live on the same machine.** If it is lost, so are they. Off-site copies are **recommended but not configured**: copy `/var/backups/pairplug` elsewhere regularly (e.g. `rclone` to storage you control). Nothing here automates it. A managed database's own backups/point-in-time recovery (if your plan includes them — check the provider's current terms) are a useful second layer, not a replacement for these.
* **Restore:** `sudo systemctl stop pairplug` → `sudo -u pairplug bash -c 'set -a; . /etc/pairplug.env; set +a; node scripts/restore.js /var/backups/pairplug/db/<dump>.dump'`. It verifies the SHA-256 and archive, refuses a dump from a **newer** schema than the code, restores in **one transaction** and then compares every table's row count with the manifest. A target that already has tables is **refused** unless you add `--force`, and `--force` first takes a full backup of the database it replaces into `/var/backups/pairplug/pre-restore/`. The safest restore is into a **new empty database** (create it, point `DATABASE_URL` at it, restore, start the app). Photos are copied back without overwriting.
* Backup → restore round trips (including a made-up password in the URL, corruption, a missing manifest, a too-new schema, and pre-restore copies) are **tested here against disposable local databases**; they have not been run on a real VM or managed database.
* Always take a backup immediately **before** every update.

## 5. Updating
```bash
cd /opt/pairplug && sudo -u pairplug bash -c 'set -a; . /etc/pairplug.env; set +a; BACKUP_DIR=/var/backups/pairplug node scripts/backup.js'
sudo -u pairplug git pull && sudo -u pairplug npm ci --omit=dev && sudo systemctl restart pairplug      # migrations run on start && curl -s https://YOUR-SITE-ADDRESS/healthz
```
Roll back = checkout the previous commit and restore the pre-update dump (a newer database must not be opened by older code: the app refuses to start on a schema newer than itself, and `restore.js` refuses a dump newer than the code it runs with). Migrations are append-only (`src/migrations/NN.sql`), run automatically at start-up inside transactions under an advisory lock, and a failing migration rolls back completely; take the backup first.

## 6. Monitoring
Point any free uptime monitor at `https://YOUR-SITE-ADDRESS/healthz` (not verified which free plans exist). Logs: `journalctl -u pairplug -f`.

## 7. Google Cloud plan (DOCUMENTED ONLY — nothing was created, enabled or billed)
No project, VM, disk, IP, bucket or billing account was created while preparing this. Everything below is a plan for **you** to run in **your own** account. Rules for credentials: never share your Google password or card number with anyone (including an assistant); use the console/`gcloud` yourself.

**Cost and safety.** The “Always Free” e2-micro is free only inside the limits in §2 (one e2-micro in us-west1/us-central1/us-east1, ≤30 GB-month *standard* persistent disk, ≤1 GB/month North-America egress; a billing account with a card is required; other regions, the Balanced disk, extra snapshots or a reserved/unused static IP can bill). **Free-tier terms change — re-check Google's pages before you start.** Do not promise “$0”: promise “$0 if you stay within the limits”. **Budget alerts only notify; they do not cap spending** — a budget does not stop resources. Check the Billing → Reports page weekly during the beta. Set an alert at a small amount (e.g. $1) so the first charge is visible.

**Plan (each item needs a real account — NONE of these were executed or validated here):**
1. Create a project; link billing; create a $1 budget alert. *(needs real account)*
2. Compute Engine: 1 × e2-micro in us-central1, Debian 12, **Standard persistent disk (not Balanced), ≤30 GB**, default ephemeral external IP (a static IP that is not attached to a running VM is billed). *(needs real account)*
3. Firewall: allow tcp:80 and tcp:443 from anywhere (Caddy), tcp:22 only from your own IP (or use IAP/OS Login); the app itself binds 127.0.0.1. *(needs real account)*
4. Install Node ≥ 22.13, PostgreSQL 16 (on the VM, or a managed database), Caddy, git; follow §3. The database password and any email key live only in `/etc/pairplug.env` (`chmod 640 root:pairplug`). Note the free VM has little memory (e2-micro ≈ 1 GB): PostgreSQL and Node share it, so keep `PGPOOL_MAX` small (e.g. 5) and watch swap; a managed database avoids that. *(needs real VM)*
5. DNS: point a hostname at the VM IP; Caddy obtains the certificate automatically. *(needs real DNS/HTTPS; not tested)*
6. Health check: `curl https://HOST/healthz`; add a free uptime monitor. Logs: `journalctl -u pairplug`; keep journald size limited (`SystemMaxUse=200M` in `/etc/systemd/journald.conf`). *(needs real VM)*
7. Upgrade / rollback: §5. Restore drill: restore the latest dump into a NEW scratch database and boot a second instance on another port before relying on backups. *(needs real VM)*

**What WAS validated in this repo (not on a VM):** production start-up refusals and Host validation (`test/prelaunch.test.js`, `test/ops.test.js`), `/healthz`, backup → restore → integrity (`test/ops.test.js`), migration v3→v4 on a populated database, the whole beta journey in Chromium. **NOT validated:** systemd unit, Caddy config, HTTPS/DNS, GCP provisioning, real email, real Stripe, off-site backups.

**Cleanup checklist (stop all charges):** delete the VM; delete its disk(s) and any snapshots; release any static IPs; delete the DNS records; remove the budget alert if no longer needed; delete the project (Resource Manager → Shut down); confirm the billing account shows no active resources and $0 usage next day.

## 8. Moving the existing SQLite data to PostgreSQL (cutover and rollback)
`scripts/sqlite-to-pg.js` copies a SQLite database (schema v1–v16) into an **empty** PostgreSQL database and proves the copy is exact. It never modifies or even opens the source in place (it works on a private copy), runs in **one transaction** (any error or failed check rolls everything back), and checks per-table row counts, a content checksum of every row, per-status order counts and money sums, ledger sums and inventory totals. It is **repeatable**: against an empty database it always produces the same result; against a non-empty one it refuses (`--replace --confirm-erase <dbname>` is the explicit way to start over). Tested here on 28 databases produced by the real application's test flows (9,586 rows) and by an in-repo round-trip test; **not yet run on the real `data/pairplug.db`** (it was deliberately never touched).

**Rehearse first (no downtime, nothing committed):**
```bash
# on the machine with the SQLite file; the app may keep running. Use a COPY made by the old release's backup (VACUUM INTO snapshot), not the live file.
createdb pairplug_rehearsal          # any scratch PostgreSQL database
node scripts/sqlite-to-pg.js --source /path/to/snapshot.db --target postgres://user:pass@host/pairplug_rehearsal --dry-run --report rehearsal.json --uploads data/uploads
```
Read the output: `IMPORTED/DRY RUN … N checks passed. Source untouched: true`, and every `WARNING` (e.g. uploads missing on disk, sellers above the cap — nothing is ever deleted).

**Cutover (a few minutes of maintenance window):**
1. Create the real empty database; set `DATABASE_URL` in `/etc/pairplug.env` for the **new** release (but do not start it yet).
2. Stop the OLD app (`systemctl stop` — this flushes the SQLite WAL). **Do not delete or rename `data/pairplug.db`**; make it read-only (`chmod a-w`) so nothing can write to it by accident.
3. Take a final snapshot with the **old** release (`node scripts/backup.js`) — or let the importer copy the stopped file directly (it copies the `-wal` too).
4. Import for real: `node scripts/sqlite-to-pg.js --source <snapshot or data/pairplug.db> --target "$DATABASE_URL" --uploads /var/lib/pairplug/uploads --report import-report.json`. Keep `import-report.json` (counts and checksums only, no personal data).
5. Take the first PostgreSQL backup (`node scripts/backup.js`), start the new release, check `/healthz` (`schema: 16`), log in as the admin, open Orders and Inventory, and compare the totals with `import-report.json`.
6. Photos are not in the database: leave the uploads directory where it is (or `rsync` it to the new host *before* the cutover and once more after, since new files may appear).

**Rollback:** before the new release accepts any order, rolling back is trivial and lossless — stop the new app and start the old release on the untouched `data/pairplug.db`. After PostgreSQL has accepted new orders there is **no automatic PostgreSQL → SQLite path**; going back would mean exporting those new orders by hand. That is why step 5 verifies before opening the site, and why the SQLite file and snapshots are kept until you are satisfied (suggest: at least one full release cycle).

## Vercel
See **[docs/VERCEL.md](VERCEL.md)** (architecture mapping, required services, environment variables per environment, migration and cron setup, known limits) and `deploy/vercel.env.example`.
