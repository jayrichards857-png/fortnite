# PairPlug private beta — deployment & operations

**Status: NOT deployed.** I (the assistant) have no cloud account, credentials or domain, so nothing is live and nothing here was run on a real server.
What *was* verified in this repo: the app starts in production mode and refuses unsafe settings, `/healthz`, backup → restore → boot, and the whole
buyer/seller journey in a real browser. The systemd/Caddy files below are written but **untested on a real VM**.

## 1. What the app needs (verified from the code)
| Requirement | Detail |
|---|---|
| Runtime | Node **22.x, tested on 22.22.0** (needs ≥ 22.13 for unflagged `node:sqlite`; use 22.22 or newer to match what was tested). One long-running process. In production it listens on **127.0.0.1 only**; the reverse proxy is the public entry point. |
| Database | One SQLite file (`PAIRPLUG_DB`), WAL mode. Needs a **persistent local disk**. Not safe on network filesystems. |
| Photos | Files in `PAIRPLUG_UPLOADS` (random names, never overwritten). **Persistent disk required** — if lost, listings lose their photos. |
| Sessions | Stored in the SQLite DB (survive restarts). |
| WebSockets | Chat uses `/api/chat/ws`; it falls back to long-polling automatically if a proxy blocks WebSockets. Caddy/nginx proxy WebSockets fine. |
| HTTPS / env | HTTPS terminated by a reverse proxy; config via environment variables (`deploy/pairplug.env.example`). **No secrets** are needed in beta mode. |
| Build / start / health | Build: `npm ci --omit=dev` · Start: `node src/server.js` · Health: `GET /healthz` → `{"ok":true,"checkoutMode":"external"}` |
| Single instance | Run **one** process (SQLite single writer; chat live-push hub is in-memory). |

## 2. Hosting options checked (searched 2026-10-10; third-party sources noted — confirm on the provider's own pages before signing up)
| Option | Persistent disk? | Truly $0? | Verdict |
|---|---|---|---|
| **Render free web service** | **No.** [Free services have an ephemeral filesystem and spin down after 15 min idle; persistent disks are paid-only](https://render.com/docs/free) ([disks docs](https://docs.render.com/disks)) | $0 but would lose the DB/photos on every restart | ❌ Unsuitable |
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
# 1. Node 22 (any method that gives node >= 22.13), git, and Caddy (https://caddyserver.com/docs/install)
# 2. Service user + directories
sudo useradd --system --home /opt/pairplug --shell /usr/sbin/nologin pairplug
sudo mkdir -p /opt/pairplug /var/lib/pairplug/uploads /var/backups/pairplug
sudo git clone <your repo URL> /opt/pairplug && cd /opt/pairplug && sudo git checkout <the release branch>
sudo npm ci --omit=dev
sudo chown -R pairplug:pairplug /opt/pairplug /var/lib/pairplug /var/backups/pairplug
# 3. Config (no secrets in beta mode)
sudo cp deploy/pairplug.env.example /etc/pairplug.env && sudo chown root:pairplug /etc/pairplug.env && sudo chmod 640 /etc/pairplug.env
sudo nano /etc/pairplug.env   # set PUBLIC_URL, PUBLIC_RELEASE_DATE (confirm the real date). SUPPORT_EMAIL is optional: unset means the official pairplugservice@gmail.com. No trailing '# comments' after values (the app refuses to start if it sees one)
# 4. Service, proxy, backups
sudo cp deploy/pairplug.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now pairplug
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile && sudo systemctl reload caddy      # set your hostname
sudo cp deploy/pairplug-backup.cron /etc/cron.d/pairplug-backup
# 5. Check
curl -s https://YOUR-SITE-ADDRESS/healthz
# 6. Create the admin account (as the service user so DB file ownership stays correct). It prints a random temporary password ONCE; change it at first login.
sudo -u pairplug bash -c 'set -a; . /etc/pairplug.env; set +a; cd /opt/pairplug; node scripts/create-admin.js setup --email you@example.com'
# later: `status` shows who the admin is; `reset --email you@example.com` issues a new temporary password (the old one is not recoverable)
```
In production the server **refuses to start** if `PUBLIC_URL` isn't https, if `PAYMENTS_MODE=sandbox` is set, if `CHECKOUT_MODE=platform` has no payment provider, if `SELLER_ONBOARDING`/`CHECKOUT_MODE` hold an unrecognised value, or if any setting contains an inline ` # comment`. Buyer sign-up is **open by default** (it creates buyer accounts only; `SIGNUPS=closed` pauses it), the public **Sell** page is “Coming Soon!” for everyone but approved sellers, seller onboarding is invitation-only and refused outright if `SELLER_ONBOARDING=open` is set in production, `HOST` defaults to 127.0.0.1, and requests whose `Host` header isn't the `PUBLIC_URL` host are rejected (421).

## 4. Backups and recovery
* Daily cron runs `scripts/backup.js`: a transactionally-consistent `VACUUM INTO` snapshot (integrity-checked, files `0600`, directories `0700`), new photos copied incrementally, newest 14 snapshots kept, in `/var/backups/pairplug`.
* **Those backups live on the same VM disk.** If the VM is lost, so are they. Off-site copies are **recommended but not configured**: weekly copy them elsewhere (e.g. `scp -r` to a laptop, or `rclone` to storage you control). Nothing here automates it.
* **Restore:** `sudo systemctl stop pairplug` → `sudo -u pairplug node scripts/restore.js /var/backups/pairplug/db/<snapshot>.db --force` (checks integrity and that the snapshot's schema is not newer than the code, keeps `pairplug.db.pre-restore-<time>`, removes stale WAL/SHM, copies photos back without overwriting; pass `--db`, `--uploads`, `--photos` for non-default paths) → `sudo systemctl start pairplug` → `curl /healthz`. Without `--force` it refuses to overwrite an existing database.
* The restore script and a backup→restore round trip are **tested here against disposable data only**; it has not been run on a real VM.
* Always take a backup immediately **before** every update.

## 5. Updating
```bash
cd /opt/pairplug && sudo -u pairplug bash -c 'set -a; . /etc/pairplug.env; set +a; BACKUP_DIR=/var/backups/pairplug node scripts/backup.js'
sudo -u pairplug git pull && sudo -u pairplug npm ci --omit=dev && sudo systemctl restart pairplug && curl -s https://YOUR-SITE-ADDRESS/healthz
```
Roll back = checkout the previous commit and restore the pre-update snapshot (a newer database must not be opened by older code; `restore.js` refuses a snapshot newer than the code it runs with). Migrations are append-only and run automatically at start-up; take the backup first.

## 6. Monitoring
Point any free uptime monitor at `https://YOUR-SITE-ADDRESS/healthz` (not verified which free plans exist). Logs: `journalctl -u pairplug -f`.

## 7. Google Cloud plan (DOCUMENTED ONLY — nothing was created, enabled or billed)
No project, VM, disk, IP, bucket or billing account was created while preparing this. Everything below is a plan for **you** to run in **your own** account. Rules for credentials: never share your Google password or card number with anyone (including an assistant); use the console/`gcloud` yourself.

**Cost and safety.** The “Always Free” e2-micro is free only inside the limits in §2 (one e2-micro in us-west1/us-central1/us-east1, ≤30 GB-month *standard* persistent disk, ≤1 GB/month North-America egress; a billing account with a card is required; other regions, the Balanced disk, extra snapshots or a reserved/unused static IP can bill). **Free-tier terms change — re-check Google's pages before you start.** Do not promise “$0”: promise “$0 if you stay within the limits”. **Budget alerts only notify; they do not cap spending** — a budget does not stop resources. Check the Billing → Reports page weekly during the beta. Set an alert at a small amount (e.g. $1) so the first charge is visible.

**Plan (each item needs a real account — NONE of these were executed or validated here):**
1. Create a project; link billing; create a $1 budget alert. *(needs real account)*
2. Compute Engine: 1 × e2-micro in us-central1, Debian 12, **Standard persistent disk (not Balanced), ≤30 GB**, default ephemeral external IP (a static IP that is not attached to a running VM is billed). *(needs real account)*
3. Firewall: allow tcp:80 and tcp:443 from anywhere (Caddy), tcp:22 only from your own IP (or use IAP/OS Login); the app itself binds 127.0.0.1. *(needs real account)*
4. Install Node ≥ 22.13, Caddy, git; follow §3. Secrets live only in `/etc/pairplug.env` (`chmod 640 root:pairplug`); beta mode needs none unless you enable an email provider key. *(needs real VM)*
5. DNS: point a hostname at the VM IP; Caddy obtains the certificate automatically. *(needs real DNS/HTTPS; not tested)*
6. Health check: `curl https://HOST/healthz`; add a free uptime monitor. Logs: `journalctl -u pairplug`; keep journald size limited (`SystemMaxUse=200M` in `/etc/systemd/journald.conf`). *(needs real VM)*
7. Upgrade / rollback: §5. Restore drill: restore the latest snapshot into a scratch path on the VM and boot a second instance on another port before relying on backups. *(needs real VM)*

**What WAS validated in this repo (not on a VM):** production start-up refusals and Host validation (`test/prelaunch.test.js`, `test/ops.test.js`), `/healthz`, backup → restore → integrity (`test/ops.test.js`), migration v3→v4 on a populated database, the whole beta journey in Chromium. **NOT validated:** systemd unit, Caddy config, HTTPS/DNS, GCP provisioning, real email, real Stripe, off-site backups.

**Cleanup checklist (stop all charges):** delete the VM; delete its disk(s) and any snapshots; release any static IPs; delete the DNS records; remove the budget alert if no longer needed; delete the project (Resource Manager → Shut down); confirm the billing account shows no active resources and $0 usage next day.
