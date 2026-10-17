# Rebrand: PairPlug → Grailedside

Customers now see **Grailedside** everywhere: page titles and tab titles, the wordmark and footer, the favicon letter (P → G), every page, legal text, email subjects and bodies, CSV/packet download file names, CLI output and the docs. The layout, colours and behaviour are unchanged, except one CSS line that tightens the header gap between 861 and 900px so the longer wordmark does not cause horizontal scroll.

This was a naming change only. Nothing below was renamed, so existing deployments, sessions, data and integrations keep working.

## Intentionally unchanged (internal identifiers)

| Kept as `pairplug` / `PAIRPLUG_*` | Why |
|---|---|
| Environment variables `PAIRPLUG_DB_LABEL`, `PAIRPLUG_UPLOADS`, `PAIRPLUG_SANDBOX*`, `PAIRPLUG_TEST_*` | Set in Vercel / servers today; renaming would break deployments. |
| `X-Requested-With: pairplug` header (CSRF guard in `src/auth.js`, `public/app.js`, `public/chat.js`) | Browsers with the old cached JS would be rejected if renamed mid-deploy. |
| Session cookie `pp_session` | Renaming would sign every user out. |
| `external_sales.origin = 'pairplug'` (DB CHECK constraint; label now displays "Grailedside") | Persisted value in existing rows. |
| Migrations, `docs/schema.sql`, `scripts/legacy/` | Historical and applied; changing them would not match deployed databases. |
| `package.json` name `pairplug`, `application_name: 'pairplug'`, advisory-lock names | Internal; no customer visibility. |
| `deploy/pairplug.service`, `deploy/pairplug.env.example`, `deploy/pairplug-backup.cron`, `/opt/pairplug`, `/etc/pairplug.env`, `/var/backups/pairplug`, DB role/name `pairplug`, S3 bucket example `pairplug-uploads` | Server paths, users and resources that already exist on VMs/cloud accounts. |
| Sandbox-only secret `pairplug-sandbox-only-secret` | Test-mode constant. |
| Storefront claim guard still blocks "official PairPlug …" as well as "official Grailedside …" | Stops sellers impersonating either name. |
| Order references `PP-<order id>` (also the Stripe `client_reference_id`) and link-token prefixes `pp_inv_`, `pp_mod_` | Opaque identifiers that sellers reconcile against Stripe and that outstanding hashed invitation links depend on; renaming would break matching for existing orders. |
| Legal `VERSION` / "Last updated" dates (`src/legal.js`) are unchanged | Name-only edit: no policy changed, so nobody is asked to re-accept. Bump them if you want a fresh acceptance. |
| Old names in tracked screenshots under `artifacts/` | Generated output; regenerate with `npm run screenshots`. |

## Later, deliberate steps (not done; nothing here is required for the site to work)

1. **Website URL.** The official site is `https://grailedside.vercel.app/`. The app answers only on the host in `PUBLIC_URL` (HTTP 421 elsewhere), so the Vercel environment variable `PUBLIC_URL` must be `https://grailedside.vercel.app`. Do this in Vercel and redeploy; it was not changed from here. Sessions are host-bound (cookies are host-only), so users on the old host sign in again on the new one.
2. **Support email.** The official address is now `grailedside@gmail.com` (built into `src/config.js`). If the Vercel project still has `SUPPORT_EMAIL=pairplugservice@gmail.com` set, that override wins: delete that variable (or change it) and redeploy.
3. **Email sender name.** If `EMAIL_PROVIDER=resend`, set `EMAIL_FROM` to e.g. `Grailedside <hello@your-verified-domain>`; this is an environment value, not code.
4. **Stripe / processor dashboards.** Update the business display name in your own Stripe account and any processor packets. This repo never touches live Stripe settings.
5. **Logo.** The logo is a text wordmark plus a one-letter favicon. A custom Grailedside logo needs a design decision and would replace the `wordmark` element and the favicon data URI in `src/views.js`.
6. **Optional internal renames** (env vars, cookie, header, paths) can be done later with a backward-compatible plan (accept both names for a release). They are not needed for the rebrand.
