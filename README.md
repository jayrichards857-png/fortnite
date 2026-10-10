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

Operating guide: [docs/BETA_RUNBOOK.md](docs/BETA_RUNBOOK.md) · Deployment & hosting research: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Run it locally
```bash
npm install
npm start                       # http://localhost:3000 — direct-checkout beta mode, empty database, nothing seeded
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run create-admin
```
Needs Node ≥ 22.13 (prints an “experimental SQLite” warning — expected). The database and `data/uploads` are created and migrated automatically (migrations are additive).
For the real beta use `NODE_ENV=production` with the settings in `deploy/pairplug.env.example` (HTTPS `PUBLIC_URL`, `SELLER_ONBOARDING=invite`, `SELLER_ALLOWED_EMAILS`).

| Command | Purpose |
|---|---|
| `npm test` | 78 unit/HTTP/WebSocket/real-process tests (each file on a throwaway DB); `test/prelaunch.test.js` pins the pre-deployment checks |
| `npm run check` | Syntax-checks every JS file (no build step; no typechecker/linter in this project) |
| `npm run test:browser` | Three real-Chromium journeys on empty temp DBs: legacy platform checkout, chat, and the **beta direct-checkout journey incl. mobile viewport** (`node scripts/browser-beta.js --screenshots` refreshes `artifacts/screenshots/beta-*.png`) |
| `npm run backup` | Consistent DB snapshot + incremental photo copy (see DEPLOYMENT.md) |
| `npm run seed:demo` / `npm run screenshots` | **Isolated fixture DB** for the older (platform-mode) screenshots. Never touches the live DB |

## What's implemented
* **Buyer:** search/filters/sort/pagination, product pages with gallery, favorites, direct-checkout purchase flow, order page with status/tracking, reviews, private chat with the seller.
* **Seller:** onboarding (invite-only switch for the beta), **Settings** (checkout link), listing editor (photos, shipping terms *buyer-pays flat fee* or *free shipping*, per-listing payment link, profit calculator), inventory, CSV import, **order page** (confirm/reject payment, tracking, delivered, record a refund), analytics.
* **Admin:** users/ban, listing removal; legacy dispute/withdrawal/fee tools for historical orders.
* **Messaging:** WebSocket with long-polling fallback, durable messages, unread/read receipts, offline queue (see below).

## Integrations & limitations (honest list)
| Area | Status |
|---|---|
| Seller payment links | Server-side tested. **Not tested against live Stripe.** Payment Links have a fixed product/price: the seller must create one per listing (item + shipping) — a default link is used only if the seller says it accepts any amount. |
| Payment verification | **Manual**, by the seller. PairPlug cannot verify Stripe payments (no webhook/API integration in beta). |
| Escrow, wallet, fees, withdrawals, Stripe adapter, sandbox | Legacy, **disabled for new orders** (`CHECKOUT_MODE=external`). Sandbox is refused in production. |
| Shipping labels | **Not integrated.** Seller buys elsewhere; PairPlug links to services (not verified live) and stores carrier + tracking. Delivery is marked by buyer/seller (the carrier webhook is optional and untested against a real carrier). |
| Tax | Not handled. The seller's Stripe configuration is responsible. |
| Email/SMS/push, password reset | Not implemented (in-app notifications only). |
| Hosting | **Not deployed.** Researched in DEPLOYMENT.md; needs a cloud account + hostname that I cannot create. |
| Backups | Local snapshots only; off-site copy is a manual step. |
| Scale | One process / SQLite; chat live-push is in-memory (single process). Fine for a private beta. |

## Messaging (buyer ↔ seller chat)
`/messages`. WebSocket by default, automatic long-polling fallback; the status pill names the transport actually in use. Messages persist before acknowledgement; idempotency keys + a UNIQUE constraint prevent duplicates; membership is enforced server-side; typing indicators are ephemeral and single-process.
Code: `src/chat/service.js` (logic), `src/chat/ws.js` + `src/routes/chat.js` (transports), `src/chat/hub.js` (swap for Redis to scale), `public/chat.js` (interchangeable client transports).

## Security notes
scrypt password hashes; hashed session tokens, HttpOnly + SameSite=Lax cookies (Secure + HSTS in production); CSRF via required custom header; per-client-IP rate limiting (proxy-aware via `TRUST_PROXY`); HTML-escaped output; uploads validated by magic bytes (JPEG/PNG/WebP ≤5 MB), server-chosen names; ownership checks return 404; payment links allowlisted + re-validated at redirect; order snapshots/terms/ledger protected by database triggers; generic error responses (no stack traces); production start-up guard. CSP currently allows inline scripts/styles (nonce tightening is future work).
