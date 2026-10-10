# PairPlug

A secondhand clothing / sneakers / streetwear marketplace for North America (US, Canada, Mexico) with
escrow payments, disputes, and a reseller dashboard ("Reseller OS"). Node 22 + Express + SQLite (built-in `node:sqlite`),
server-rendered pages with a little vanilla JS. **Two runtime dependencies (`express`, `ws`)**; `playwright-core` is dev-only (screenshots/browser test).

> The repository was empty when this work started, so there was no existing PairPlug code, schema, auth or payment
> integration to preserve. Everything here was built from scratch.

## Run it

```bash
npm install
cp .env.example .env            # optional; values can also be exported in the shell
PAYMENTS_MODE=sandbox npm start # http://localhost:3000   (npm run dev for auto-reload)

# create an administrator
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run create-admin
```

Requires Node ≥ 22.13 (uses `node:sqlite`; it prints an "experimental" warning, which is expected).
The database is created and migrated automatically on first start (`data/pairplug.db`). The live DB starts **empty** — nothing is seeded.

| Command | What it does |
|---|---|
| `npm test` | 43 unit + HTTP/WebSocket end-to-end tests (incl. 13 chat tests), each file on a throwaway DB |
| `npm run check` | Syntax-checks every JS file (no build step / no linter dependency) |
| `npm run test:browser` | Two real-Chromium scenarios on empty temp DBs: `browser-journey.js` (seller → listing → buyer → checkout → ship → release) and `browser-chat.js` (two browsers chatting; add `--screenshots` to refresh the chat screenshots) |
| `npm run seed:demo` | Builds an **isolated** fixture DB (`data/demo.db`) by driving the real API — for screenshots/QA only |
| `npm run screenshots` | Boots the app on the fixture DB (and an empty DB) and captures `artifacts/screenshots/*.png` |

## Features (all backed by the database)

**Buyer** – home, shop with SQL-level search/category/brand/size/condition/price filters, sort, pagination, shareable URLs,
product pages with working gallery, favorites, cart, checkout, order tracking page, confirm receipt, disputes with photo evidence, reviews, in-app notifications.
**Seller** – onboarding (NA-only ships-from), listing editor with photo upload + drafts + live profit calculator and payout preview, inventory table
(search, filters, pagination, bulk select, bulk status/price, duplicate, archive), CSV import by SKU, orders (ship with tracking, cancel & refund),
overview/analytics/aging/item profitability derived from orders, earnings, wallet, withdrawal requests, monthly tax summary (+CSV), public storefront.
**Admin** – marketplace overview, dispute resolution (side-by-side evidence → refund or release), user ban + Pro plan toggle, listing removal, withdrawal queue, fee settings.

### Money model (`src/pricing.js`, single source of truth)
`seller payout = item price + shipping − platform fee − processing fee`; `platform revenue = platform fee (+ label markup)`.
Defaults: 10% transaction fee (6% Pro), 2.9% + $0.30 estimated processing (passed to the seller), configurable by admins (affects new orders only).
Prices are always recomputed on the server; the browser never submits a price.

### Trust & escrow (`src/orderMachine.js`, `src/escrow.js`)
`pending_payment → paid → shipped → delivered → released`, or `… → disputed → refunded | released`. Funds credit the seller's ledger only on `released`
(buyer confirmation, or auto-release N days after delivery via the background job). `UNIQUE(order_id,'sale_release')` makes a double release impossible.

### Concurrency
Unique items are reserved in a `BEGIN IMMEDIATE` transaction with a conditional `UPDATE … WHERE status='active'`; reservations expire after 15 min (configurable).
Verified by a test where 12 buyers race for one item: exactly one wins. Checkout is idempotent per `(buyer, key)`.

## Messaging (buyer ↔ seller chat)

Private chat at `/messages` (header chat icon, plus **Message seller** on every listing). Runs locally with no external service, account or Redis.

* **Transport:** real **WebSocket** (`/api/chat/ws`, via `ws`) by default, with an automatic **long-polling** fallback (`GET /api/chat/sync`) when a WebSocket can't be established. The status pill always names the transport in use: `Live · WebSocket`, `Live · long-polling (WebSocket unavailable)`, `Connecting…`, `Reconnecting…`, `Offline`, `Signed out`. Force polling with `/messages?transport=polling`.
* **Model:** one conversation per buyer/seller pair (`conversations`, `UNIQUE(buyer_id, seller_id)`; the listing is shown as context). Messages are persisted (`messages`) **before** the sender gets an ack; `UNIQUE(conversation_id, sender_id, client_id)` + client-generated idempotency keys prevent duplicates. Unread counts and read receipts come from `conversation_reads`.
* **Security:** session-cookie auth reused for HTTP and the WebSocket upgrade (Origin checked); every command re-validates the session; membership is enforced server-side and ids come from the session/DB, never the client; non-members get 404; rate limits; bodies are rendered with `textContent`.
* **Recovery:** the client keeps a cursor (highest message id seen from a sync) and an outbox in `localStorage`; after offline/reload it catches up with `sync(after=cursor)` and re-sends queued messages with the same key (stored once).
* **Modular:** `src/chat/service.js` (all logic) ← `src/chat/ws.js` / `src/routes/chat.js` (transports) and `src/chat/hub.js` (pub/sub, in-process now). Client: `public/chat.js` has interchangeable `WebSocketTransport` / `PollingTransport`.
* **Limits (honest):** typing indicators and live push work within a **single server process** (the hub is in-memory); messages themselves are always durable. The header unread badge is accurate at page load and updates live only on the Messages page. No email/push notification for new messages, no attachments, no blocking/reporting yet.
* **Moving to Socket.IO + Redis later:** implement `subscribe/publish` of `hub.js` on Redis pub/sub (or the Socket.IO Redis adapter) and call `setHub()`; replace `ws.js` with a Socket.IO server calling `service.runCommand`, and add a `SocketIoTransport` to `public/chat.js` implementing `start/stop/rpc`. The service, schema and UI do not change. For multiple nodes also move rate limits to Redis and put the WebSocket behind a sticky/L4 load balancer.

## Integrations — what's real and what isn't

| Area | Status |
|---|---|
| **Payments – sandbox** (`PAYMENTS_MODE=sandbox`) | **Implemented and tested.** Simulates a provider; money never moves. Goes through the same signed, idempotent webhook as a real provider. |
| **Payments – Stripe** | **Implemented, NOT tested against Stripe.** Creates Checkout Sessions, verifies webhook signatures (unit-tested), issues refunds. Needs `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`. Test with Stripe *test mode* before any live use. |
| **Seller payouts (Stripe Connect transfers)** | **Not implemented.** Seller earnings are a ledger; withdrawals are requests an admin marks paid manually. |
| **Shipping labels (Shippo/EasyPost)** | **Not implemented.** Interface stub only (`src/shipping.js`). Sellers enter carrier + tracking from a label bought elsewhere. No fake labels/tracking numbers are generated. |
| **Tracking sync** | `POST /webhooks/tracking` (secret header) marks shipped orders delivered. Tested with simulated calls; not connected to any carrier. |
| **Sales tax** | Flat `TAX_RATE_BPS` estimate only (default 0). No jurisdiction lookup / remittance. |
| **Email / SMS / push, password reset** | **Not implemented.** Notifications are in-app only; password reset needs an email provider. |
| **Promoted listings, Pro billing** | **Not implemented.** (Admins can flag a seller Pro for the lower fee; nothing bills it.) |
| **Real-time updates** | Chat only (see Messaging). Orders/dashboards refresh on load. |

## Database & migrations
Schema lives in `src/db.js` (`MIGRATIONS`, tracked with `PRAGMA user_version`; append-only) and is exported to [`docs/schema.sql`](docs/schema.sql). No manual migration step.
Env vars: see `.env.example`.

## Security notes
scrypt password hashes; session tokens stored hashed, HttpOnly + SameSite=Lax cookies (Secure in production); CSRF via required custom header on all mutations;
login/registration rate limiting (in-memory, single node); all output HTML-escaped; uploads validated by magic bytes (JPEG/PNG/WebP ≤5 MB) and referenced by server-issued names only;
ownership checks return 404 for other sellers' resources; CSP set (inline scripts/styles are allowed because the pages use small inline snippets — tightening to nonces is future work).

## Screenshots
`artifacts/screenshots/` — captured from the running app against the **isolated fixture DB** (`npm run seed:demo`), except `00-empty-marketplace.png`, which is the real empty state.
Fixture images are neutral colour blocks, not product photos. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the schema/API/design write-up.
