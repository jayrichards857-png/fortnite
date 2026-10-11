# PairPlug

A secondhand clothing / sneakers / streetwear marketplace for North America (US, Canada, Mexico). Node 22 + Express + SQLite (built-in `node:sqlite`),
server-rendered pages with a little vanilla JS. Runtime dependencies: `express`, `ws`.

## Private-beta payment model (read first)

**PairPlug does not collect, hold, escrow, split or refund buyer money.** For the beta, each seller is paid *directly* through their **own Stripe Payment Link**:

1. Buyer opens a listing and sees item price, shipping terms and the **total they will pay the seller** before leaving PairPlug.
2. Buyer enters a shipping address and reserves the item, then is sent to the seller's own checkout link (`buy.stripe.com`, allowlisted, validated server-side; the destination always comes from the database, never from a request parameter).
3. The order shows **“Awaiting payment confirmation.”** Clicking through, returning, or pressing “I've completed payment” **never** marks it paid. **Only the seller can confirm** (after checking their own Stripe dashboard).
4. The seller buys a label themselves (PairPlug does not), enters carrier + tracking; the buyer gets a safe tracking link.

| Question | Answer |
|---|---|
| Who processes payments? | The seller's payment provider (Stripe). |
| Who handles refunds, chargebacks, payment disputes, sales tax? | The seller and their provider — **not PairPlug**. Stated on the listing, purchase and order pages. |
| Is there escrow / buyer protection? | **No.** The earlier escrow/wallet/fee/dispute code is kept (history is preserved) but is disabled for new orders. |
| PairPlug fees? | None in the beta. |
| Is the Stripe link flow verified live? | **No.** The server side (validation, redirect, `client_reference_id=PP-<order>` parameter, seller confirmation) is tested; **no real Stripe payment has been made.** Do a real test purchase first. |

**Invite-only, closed sign-ups.** Nobody can create an account on their own: `/register` and `/sell` show **“Coming soon — selling available <release date>”**. People join through single-use, expiring, hashed invitations issued by the admin. At most **3 seller accounts** exist (enforced in SQLite triggers, race-tested). `PUBLIC_RELEASE_DATE` is a **placeholder in the deployment example — the founder must confirm the real date**.

Operating guide: [docs/BETA_RUNBOOK.md](docs/BETA_RUNBOOK.md) · Deployment & hosting research: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Run it locally
```bash
npm install
npm start                       # http://localhost:3000 — direct-checkout beta mode, empty database, nothing seeded
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run create-admin
```
In local development (not production) sign-ups default to open so you can click around; set `SIGNUPS=closed SELLER_ONBOARDING=invite` to see the beta behaviour.
Needs Node ≥ 22.13 (prints an “experimental SQLite” warning — expected). The database and `data/uploads` are created and migrated automatically (migrations are additive).
For the real beta use `NODE_ENV=production` with the settings in `deploy/pairplug.env.example` (HTTPS `PUBLIC_URL`, `SIGNUPS=closed`, `SELLER_ONBOARDING=invite`, `PUBLIC_RELEASE_DATE`).

| Command | Purpose |
|---|---|
| `npm test` | 111 unit/HTTP/WebSocket/real-process tests (each file on a throwaway DB): cap & races, invitations, accounts, storefronts, cases/refunds, migrations, backup/restore, production guards |
| `npm run check` | Syntax-checks every JS file (no build step; no typechecker/linter in this project) |
| `npm run test:browser` | Four real-Chromium journeys on empty temp DBs: legacy platform checkout, chat, the direct-checkout journey, and **`browser-final.js`** (closed sign-ups → invitations → cap → verification via outbox → storefront → contact-first listing → checkout → refund → case → mobile). Stripe is never contacted (redirect captured). |
| `npm run backup` / `npm run restore -- <snapshot> [--force]` | Consistent DB snapshot + photos (owner-only perms) / integrity- and version-checked restore that keeps a `.pre-restore` copy |
| `npm run inventory:sellers` | Read-only report of seller accounts vs. the cap |
| `node scripts/dump-schema.js` | Regenerates `docs/schema.sql` from the migrations |
| `npm run seed:demo` / `npm run screenshots` | **Isolated fixture DB** for the older (platform-mode) screenshots. Never touches the live DB |

## What's implemented
* **Access:** closed sign-ups + “Coming soon” page; admin-issued buyer/seller invitations (hashed, single-use, expiring, email-bound); **seller cap of 3** with visible slot usage; seller email verification required to publish and to receive new orders; password change, email change, password reset (reset only works when an email provider is configured).
* **Buyer:** search/filters, product pages, **Contact seller** (always) and **Buy now** (only when the listing has a valid Stripe Payment Link and the seller is verified), order page with status/tracking/seller note, refund request, report a problem, reviews, private chat.
* **Seller:** invitation onboarding, **storefront customization** (avatar/logo/banner, curated themes/accents/layouts, featured items, ordering, social links, announcement; draft → preview → publish; no custom CSS/JS/HTML), listing editor and lifecycle (pause/resume/unpublish/mark sold/delete), inventory, CSV import, order page (confirm/reject payment, ship with tracking + note, respond to refund requests), analytics.
* **Messaging:** WebSocket with long-polling fallback, durable messages, unread/read receipts, per-message **Report**, “awaiting your reply” indicators, 48-hour *expectation* (never a guarantee, never an automatic penalty).
* **Support & admin:** cases (order issues, seller reports, reported messages) with evidence, internal notes (hidden from users), public replies, status, decisions, pause-listing / suspend-seller actions; refund-request resolution; invitations; sellers & slots; orders overview (no addresses); unanswered-conversation visibility; **append-only audit log**; email outbox. Admins can read a conversation **only** when it was reported, and each view is audited.

## Integrations & limitations (honest list)
| Area | Status |
|---|---|
| Seller payment links | Server-side tested. **Not tested against live Stripe.** Payment Links have a fixed product/price: the seller must create one per listing (item + shipping) — a default link is used only if the seller says it accepts any amount. |
| Payment verification | **Manual**, by the seller. PairPlug cannot verify Stripe payments (no webhook/API integration in beta). |
| Escrow, wallet, fees, withdrawals, Stripe adapter, sandbox | Legacy, **disabled for new orders** (`CHECKOUT_MODE=external`). Sandbox is refused in production. |
| Shipping labels | **Not integrated.** Seller buys elsewhere; PairPlug links to services (not verified live) and stores carrier + tracking. Delivery is marked by buyer/seller (the carrier webhook is optional and untested against a real carrier). |
| Tax | Not handled. The seller's Stripe configuration is responsible. |
| Email | Every message is recorded in `email_outbox`. With no provider configured nothing is sent and the UI says so (admin can hand a verification link over manually). The `resend` adapter exists but has **never sent a real email**. SMS/push: not implemented. |
| Refunds | PairPlug moves no money. The seller *reports* a refund; the order becomes `refunded` only when the **buyer confirms** or an **admin independently verifies**. |
| Hosting | **Not deployed.** Google Cloud plan documented in DEPLOYMENT.md (nothing provisioned; no cloud resources were created). |
| Backups | Local snapshots (owner-only) + a tested restore script. Off-site copy is **recommended but not configured**. |
| Scale | One process / SQLite; chat live-push is in-memory (single process). Fine for a private beta. |

## Messaging (buyer ↔ seller chat)
`/messages`. WebSocket by default, automatic long-polling fallback; the status pill names the transport actually in use. Messages persist before acknowledgement; idempotency keys + a UNIQUE constraint prevent duplicates; membership is enforced server-side; typing indicators are ephemeral and single-process.
Code: `src/chat/service.js` (logic), `src/chat/ws.js` + `src/routes/chat.js` (transports), `src/chat/hub.js` (swap for Redis to scale), `public/chat.js` (interchangeable client transports).

## Security notes
scrypt password hashes; hashed session tokens, HttpOnly + SameSite=Lax cookies (Secure + HSTS in production); CSRF via required custom header; per-client-IP rate limiting (proxy-aware via `TRUST_PROXY`); HTML-escaped output; uploads validated by magic bytes (JPEG/PNG/WebP ≤5 MB), server-chosen names; ownership checks return 404; payment links allowlisted + re-validated at redirect; order snapshots/terms/ledger protected by database triggers; generic error responses (no stack traces); production start-up guard. CSP currently allows inline scripts/styles (nonce tightening is future work). Admin views of reported conversations, outbox, and every consequential admin action are written to an append-only audit log. Production validates the `Host` header (HTTP and WebSocket).
