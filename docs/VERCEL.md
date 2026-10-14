# Running PairPlug on Vercel

PairPlug is an Express app. On Vercel it runs as **one serverless function** (`api/index.js` exports the app; `vercel.json` routes every request to it and ships `src/migrations/**`). A serverless function lives only for a request, so everything that used to depend on a long-running process or the local disk has an explicit replacement. **The app refuses to serve (HTTP 503, details in the deployment logs) until every one of them is configured.**

| Was | On Vercel | You need |
|---|---|---|
| Local disk for photos (`data/uploads`) | S3-compatible **object storage**, private bucket, served through the app at the same `/uploads/<file>` URLs | A bucket + access keys (Cloudflare R2, AWS S3, Backblaze B2, Supabase Storage…) |
| In-process timers (checkout expiry, escrow release, suspensions, clean-ups) | `GET /api/cron/tick` (Vercel Cron or any scheduler), bearer-authenticated, lease-protected, idempotent | `CRON_SECRET` |
| WebSocket chat | Same chat UI/API over **short polling** of the database (new messages appear within ~3 s; no typing indicator across instances) | Nothing extra |
| In-memory rate limits | Counters in PostgreSQL shared by all instances | Nothing extra (migration 18) |
| Schema migrated on start | **Never by a web request.** You run `npm run migrate -- --apply` per environment; the app only verifies the version | A direct DB connection for that command |
| Sessions | Already stored in PostgreSQL (cookie `pp_session`, `Secure`, `HttpOnly`) | `TRUST_PROXY=1` |

Customer **review photos** are stored in PostgreSQL (bytea), so they need nothing extra.

## Services you must set up (I cannot do these for you)
1. **PostgreSQL 16**, one database per environment (e.g. Neon / Supabase / Vercel Postgres). Give the app the **pooled** connection string; keep a **direct** one for migrations.
2. **Object storage bucket** (private) and an access key limited to that bucket (read/write/delete). Cloudflare R2 has a free tier; Vercel Blob is *not* used (it needs its SDK/token model).
3. **Email (optional for a 3-seller beta, recommended):** without it, verification/reset emails are only recorded in the admin **Email outbox** (`/admin/outbox`) and you hand each link to the seller yourself. Resend (free tier available) removes that manual step: set `EMAIL_PROVIDER=resend` + key + verified sender.
4. **A Vercel Cron schedule**: `vercel.json` ships a *daily* cron (valid on every plan). Reservation expiry is also enforced at purchase time, so correctness does not depend on frequency; for prompt "reservation expired" notices change the schedule to `*/5 * * * *` (needs the Pro plan) or call the endpoint from an external scheduler (see below).
5. Payments: nothing. The beta uses sellers' own Stripe Payment Links (`CHECKOUT_MODE=external`); no payment provider keys are read.

## Environment variables (names only — set them in Vercel, never in git)
Scope each variable to the right Vercel environment. **Preview and Production must use different databases and buckets.**

| Variable | Production | Preview | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | `production` | required |
| `DATABASE_URL` | pooled URL of the **production** DB | pooled URL of a **separate preview** DB | `?sslmode=require` for managed hosts |
| `DATABASE_URL_UNPOOLED` | direct URL (only for `npm run migrate`) | direct URL of preview DB | session locks need a direct connection |
| `PAIRPLUG_DB_LABEL` | `production` | `preview` | **must equal `VERCEL_ENV`**; stops a preview from ever running against production data |
| `PUBLIC_URL` | `https://your-domain` | the exact preview alias you browse | the app answers only on this host (HTTP 421 elsewhere) |
| `CHECKOUT_MODE` | `external` | `external` | |
| `SELLER_ONBOARDING` | `invite` | `invite` | disables only the dev-only instant onboarding; self-service requests still work |
| `TRUST_PROXY` | `1` | `1` | |
| `CRON_SECRET` | 32+ random chars (generate) | different value | Vercel sends it as `Authorization: Bearer …` |
| `S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` | preview bucket's endpoint | |
| `S3_BUCKET` / `S3_REGION` | bucket name / `auto` (R2) or the region | preview bucket | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | key for the production bucket | key for the preview bucket | server-side only, never sent to browsers |
| `S3_KEY_PREFIX` | optional | optional | |
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` | optional: `resend` + key + verified sender (otherwise manual handoff via `/admin/outbox`) | same | |
| `SIGNUPS`, `PUBLIC_RELEASE_DATE`, `SUPPORT_EMAIL` | as in `deploy/pairplug.env.example` | | |
| optional | `PGPOOL_MAX` (default 3), `PG_STATEMENT_TIMEOUT_MS` (set `0` on a transaction pooler that rejects the startup parameter), `CHAT_POLL_MS` (default 3000) | | |

Do **not** set: `PAYMENTS_MODE=sandbox`, `SHIPPO_API_KEY`, `RATE_LIMIT_SCALE`, `PAIRPLUG_SANDBOX`.
`vercel.json` already sets framework "Other", no build command, install `npm install`, output `public`.

## First deployment (in this order)
1. Create the database(s) and bucket(s); add the variables above per environment (Neon: one **branch** per environment — Production branch for Production, a separate Preview branch for Preview).
2. Check the settings you loaded (names only, no values): `npm run check:config -- --as production` (or `preview`). It also flags a pooled/direct mismatch.
3. Migrate **before** the first deploy serves traffic, per environment, from a trusted machine, with the **direct** (non-`-pooler`) connection string of that Neon branch:
   ```
   read -rs DATABASE_URL_UNPOOLED; export DATABASE_URL_UNPOOLED     # paste the DIRECT string, press Enter (nothing is echoed)
   export PAIRPLUG_DB_LABEL=production                              # or preview
   npm run migrate                                                  # DRY RUN: prints host, database, table counts, schema version, pending list
   npm run migrate -- --apply --confirm-host <host printed above>   # applies ALL pending migrations in order (v1..v18)
   npm run migrate                                                  # must say "Up to date"
   ```
   The dry run changes nothing. `--apply` refuses unless the label is set, you retype the exact host you verified against the Neon branch page, the host is a direct connection, and the database is empty or already managed by this tool (a database with tables but no migration history is never touched). It never seeds data or touches existing rows beyond what the migration files do.
4. Redeploy. Check `GET /healthz` → `{"ok":true,"schema":19}`. If the site answers 503, read the deployment logs: they list exactly which setting is missing or wrong.
5. Admin access: `node scripts/create-admin.js status` (names the database it reached and lists admins), then `reset --email <you> --confirm-host <host>` if the account exists, or `setup --email <you> --confirm-host <host>` if there is no admin yet (set `PAIRPLUG_DB_LABEL` and `DATABASE_URL` for that environment first; remote databases are never migrated by this tool). The temporary password is printed once in your terminal and must be changed at first login.
6. Sellers: any signed-in account opens a store immediately at **/sell** (free; no request, approval, invitation, waitlist or seller limit; an account is required first, so there is no anonymous listing or buying). **Admin → Seller requests** only lists older requests filed before selling became immediate. You can still create accounts directly (**Admin → Accounts → Create an account now**), invite by link, and reset passwords (**Admin → Users**). Keep `SELLER_ONBOARDING=invite`: it only controls the legacy dev-only switch; `/sell` works regardless. Email verification is not required to sell.

## Scheduled jobs
`GET /api/cron/tick` runs `sweep` (expired reservations, due escrow releases, ended suspensions) and `housekeeping` (hourly: orphaned uploads, search log, expired sessions, rate-limit rows). `?job=sweep` runs one. Overlapping or repeated calls are safe (database lease per job); a missing/wrong `CRON_SECRET` gets 401/503.
External scheduler example: `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain/api/cron/tick` every 5 minutes.

## Known limits on Vercel (honest list)
* Chat is near-real-time (polling), not push. True push would need a realtime service (Ably, Pusher, Supabase Realtime) and a client change.
* Uploads: request bodies are capped at 4.5 MB by Vercel, so the image limit is 4 MB there (5 MB elsewhere).
* Object-storage files are not included in `npm run backup` (database only): turn on bucket versioning/replication at your provider.
* Cold starts add latency to the first request; the first request after a deployment also verifies the schema version.
* The `/uploads` route serves images through the function (cacheable, immutable, 1 year). Heavy image traffic costs function time; put a CDN in front of the bucket later if needed.
* Search-log de-duplication (privacy/anti-spam) in `src/discovery.js` is still per-instance memory; it only affects analytics counts, not security.
* Not verified here: a real Vercel build/deploy, real R2/S3 or Resend traffic (all tested against local fakes and the documented AWS SigV4 vectors).
