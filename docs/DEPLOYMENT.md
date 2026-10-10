# PairPlug private beta — deployment & operations

**Status: NOT deployed.** I (the assistant) have no cloud account, credentials or domain, so nothing is live and nothing here was run on a real server.
What *was* verified in this repo: the app starts in production mode and refuses unsafe settings, `/healthz`, backup → restore → boot, and the whole
buyer/seller journey in a real browser. The systemd/Caddy files below are written but **untested on a real VM**.

## 1. What the app needs (verified from the code)
| Requirement | Detail |
|---|---|
| Runtime | Node **≥ 22.13** (uses built-in `node:sqlite`). One long-running process. |
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
sudo cp deploy/pairplug.env.example /etc/pairplug.env && sudo chmod 600 /etc/pairplug.env && sudo nano /etc/pairplug.env   # set PUBLIC_URL + SELLER_ALLOWED_EMAILS
# 4. Service, proxy, backups
sudo cp deploy/pairplug.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now pairplug
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile && sudo systemctl reload caddy      # set your hostname
sudo cp deploy/pairplug-backup.cron /etc/cron.d/pairplug-backup
# 5. Check
curl -s https://YOUR-SITE-ADDRESS/healthz
# 6. Create the admin account (run as the service user so file ownership stays correct)
sudo -u pairplug env $(grep -v '^#' /etc/pairplug.env | xargs) ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' node scripts/create-admin.js
```
In production the server **refuses to start** if `PUBLIC_URL` isn't https, if `PAYMENTS_MODE=sandbox` is set, or if `CHECKOUT_MODE=platform` has no payment provider.

## 4. Backups and recovery
* Daily cron runs `scripts/backup.js`: a transactionally-consistent `VACUUM INTO` snapshot (integrity-checked), new photos copied incrementally, newest 14 snapshots kept, in `/var/backups/pairplug`.
* **Those backups live on the same VM disk.** If the VM is lost, so are they. Weekly, copy them somewhere else at $0 (e.g. `scp -r pairplug@HOST:/var/backups/pairplug ~/pairplug-backups` to a laptop, or `rclone` to a free cloud drive). Nothing here automates off-site copies.
* **Restore (verified locally):** `sudo systemctl stop pairplug` → copy a snapshot over `/var/lib/pairplug/pairplug.db` (delete `pairplug.db-wal` / `-shm`) → copy photos back into `/var/lib/pairplug/uploads/` → `sudo systemctl start pairplug` → `curl /healthz`.
* Always run `node scripts/backup.js` immediately **before** every update (migrations are automatic and additive, but a fresh snapshot is your rollback).

## 5. Updating
```bash
cd /opt/pairplug && sudo -u pairplug env $(grep -v '^#' /etc/pairplug.env | xargs) node scripts/backup.js
sudo -u pairplug git pull && sudo -u pairplug npm ci --omit=dev && sudo systemctl restart pairplug && curl -s https://YOUR-SITE-ADDRESS/healthz
```
Roll back = checkout the previous commit and restore the pre-update snapshot (a newer database must not be opened by older code).

## 6. Monitoring
Point any free uptime monitor at `https://YOUR-SITE-ADDRESS/healthz` (not verified which free plans exist). Logs: `journalctl -u pairplug -f`.
