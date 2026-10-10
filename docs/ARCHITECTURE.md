# PairPlug architecture

> **Private-beta note.** New orders use **direct checkout** (`CHECKOUT_MODE=external`, `src/externalCheckout.js`): the seller is paid through their own payment link and PairPlug holds no money. Sections below that describe escrow, the wallet ledger, fees, PairPlug-processed refunds and disputes describe the **legacy `platform` mode**, which is preserved for historical orders and tests but guarded off for new orders. See “Direct checkout” at the end.

North-America-only marketplace (US/CA/MX). Brands, sizes and categories are **data**, not code: `listings.brand/size` are free-text fields and
filter facets are computed from live rows (`SELECT DISTINCT`-style), so no brand is hardcoded anywhere. The category list is a small fixed taxonomy in `src/config.js`.

## 1. Database schema
Full DDL (tables, FKs, indexes): [`schema.sql`](schema.sql). Money = integer cents. Highlights:

| Table | Purpose / key constraints |
|---|---|
| `users` | buyer/seller/admin flags, `plan` (standard/pro), `banned`, seller location (`country` ∈ US/CA/MX → "Local ship" badge) |
| `sessions` | SHA-256 of the session token (DB leak ≠ live sessions) |
| `listings` | `status` draft/active/reserved/sold/archived; `cost_cents` private; partial unique index `(seller_id, sku)`; indexes on `(status, published_at)`, category, price, seller |
| `checkouts` / `orders` / `order_items` | one checkout → one order per seller; fees frozen on the order at checkout; item title/price/cost **snapshotted** so edits never rewrite history; `UNIQUE(buyer_id, idempotency_key)` |
| `order_events` | audit trail of every state transition |
| `payments`, `payment_events` | provider refs; `PRIMARY KEY(provider, event_id)` = webhook idempotency |
| `refunds` | `UNIQUE(order_id)` → one refund per order |
| `ledger`, `withdrawals` | seller wallet; `UNIQUE(order_id, kind)` partial index makes escrow release idempotent |
| `disputes`, `dispute_evidence` | buyer/seller notes + photos, resolved by admin |
| `reviews` | `UNIQUE(order_id)`; only after `released` |
| `favorites`, `cart_items`, `notifications` | `UNIQUE(user_id, dedupe_key)` prevents duplicate notifications |
| `settings` | admin-editable fee parameters |
| `conversations`, `messages`, `conversation_reads` | chat (migration 2): `UNIQUE(buyer_id, seller_id)`; `messages.id` is AUTOINCREMENT (monotonic sync cursor) with `UNIQUE(conversation_id, sender_id, client_id)` for idempotency; per-user read pointer drives unread counts and read receipts |

There is no separate `shipments` table: shipment data (`carrier`, `tracking_number`, `label_ref`, timestamps) lives on `orders`, because the product ships one parcel per order. Split it out when multi-parcel orders or label purchases are added.

## 2. API (JSON, all mutations need header `X-Requested-With: pairplug` + session cookie)

| Area | Endpoints |
|---|---|
| Auth | `POST /api/register`, `/api/login`, `/api/logout`, `PATCH /api/account` |
| Discovery | `GET /`, `/shop?q=&category=&brand=&size=&condition=&min=&max=&sort=&page=`, `/listing/:id`, `/s/:handle` |
| Favorites / cart | `PUT|DELETE /api/favorites/:id`, `POST /api/cart`, `DELETE /api/cart/:id` |
| Checkout | `POST /api/checkout` (idempotency key), `POST /api/sandbox/pay/:id` (sandbox only) |
| Webhooks | `POST /webhooks/payments/:provider` (signature-verified), `POST /webhooks/tracking` (secret header) |
| Buyer orders | `POST /api/orders/:id/confirm`, `/dispute`, `/dispute/evidence`, `/review` |
| Uploads | `POST /api/uploads` (raw image body) |
| Seller | `POST /api/sell/onboard`; `POST|PUT /api/seller/listings[/:id]`, `POST /api/seller/listings/:id/duplicate`, `POST /api/seller/listings/bulk`, `POST /api/seller/import` (CSV); `GET /api/seller/profit-calc`, `/api/seller/payout-preview`; `POST /api/seller/orders/:id/ship`, `/cancel`; `POST /api/seller/withdrawals`; `GET /api/seller/tax.csv` |
| Chat | `POST /api/chat/conversations` (start from a listing), `POST /api/chat/command` (`send`/`read`/`typing`/`history`/`sync`), `GET /api/chat/sync?after=&wait=` (long-poll), `WS /api/chat/ws` (same commands as frames) |
| Admin | `POST /api/admin/disputes/:id/resolve`, `/api/admin/users/:id/ban`, `/plan`, `/api/admin/listings/:id/remove`, `/api/admin/withdrawals/:id`, `PUT /api/admin/settings` |

Dashboards are server-rendered pages: `/dashboard` (overview), `/inventory`, `/orders`, `/analytics`, `/finance`, `/import`, `/listings/new|:id/edit`; admin under `/admin/*`.

## 3. Key code
* **PricingEngine** — `src/pricing.js` (`priceOrder`, `labelCharge`, `recommendPrice`). Core:
  ```js
  platformFeeCents    = round(subtotal * feeBps / 10000)                 // 10% standard, 6% pro
  processingFeeCents  = round(total * 2.9%) + 30                          // pass-through to seller
  sellerPayoutCents   = subtotal + shipping - platformFee - processingFee // tax is held, not paid out
  platformRevenue     = platformFee + shippingMargin (label resale markup)
  ```
* **Order state machine** — `src/orderMachine.js`: a transition table + `transition()` doing `UPDATE … WHERE id=? AND status=<current>` so concurrent actors can't both win, and writing an audit row.
* **Escrow release** — `src/escrow.js#releaseToSeller`: transition to `released` + ledger credit in one transaction; `autoReleaseDue()` runs every minute.
* **Race-safe reservation** — `src/checkout.js#createCheckout` (BEGIN IMMEDIATE + conditional UPDATE, rowcount checked).
* **Idempotent webhooks** — `src/payments.js#handlePaymentEvent` (event-id insert + state change in one transaction; amount cross-checked; late success after expiry → `needs_refund`).

## 4. Stack rationale
| Choice | Why (for this product) | What changes at scale |
|---|---|---|
| **Node 22 + Express** | One language across server and templates; tiny dependency surface (1 runtime dep); easy to audit money paths. | Stateless, so run N instances behind a load balancer. |
| **SQLite (WAL) via `node:sqlite`** | Zero-ops, ACID, `BEGIN IMMEDIATE` gives simple, provable serialization of the "one buyer per unique item" race. Fine for a single node and thousands of concurrent *readers*. | SQLite has a single writer. For many app nodes / very high checkout volume move to **PostgreSQL**: keep the same schema; the reservation becomes `UPDATE … WHERE status='active' RETURNING id` (row-level lock), webhook idempotency stays a unique key, `ledger` unique index unchanged; add read replicas for browse. |
| **Server-rendered HTML + small vanilla JS** | Fast first paint on mobile, SEO-friendly shareable product URLs, no build step. | Put a CDN in front of public pages; fingerprint static assets. |
| **Provider interface for payments/shipping** | Stripe Connect (separate charges & transfers) or another multi-party provider can be slotted in without touching order logic. | Add Connect transfers on `released`; move webhook processing to a queue. |
| **Not included but recommended for scale** | — | Object storage + image resizing for uploads, Redis for shared rate limits, a job queue for auto-release/notifications, full-text search (Postgres `tsvector` / Meilisearch) instead of `LIKE`. |


## Direct checkout (private beta)

`orders.payment_mode` is `platform` (legacy, default for pre-existing rows) or `external` (beta). Existing rows were migrated in place (migration 3 is additive) and are untouched.

**Order states for `external` orders** (same state machine, narrower use):
```
pending_payment ──seller confirms──▶ paid ──seller ships──▶ shipped ──buyer/seller──▶ delivered
      │                                │  └────────────── seller records refund ──▶ refunded   (also from shipped/delivered)
      └─ cancelled (buyer cancel · seller rejects · reservation expired)
```
* `pending_payment` = **not paid**: the buyer started the seller's checkout; the listing is `reserved`. Nothing the buyer does can leave this state except cancelling. `paid` is only reachable through `sellerConfirmPayment` (seller session, own order, listing still reserved by this checkout).
* `released` / `disputed` and the ledger are never used for external orders; `escrow.js` (`assertPlatformOrder`) refuses to touch them, `autoReleaseDue` ignores them, provider webhooks for external checkouts are ignored, and the dispute endpoints return 409.
* **Reservation rules:** hold = 60 min (`external_hold_minutes`); buyer's “I've completed payment” extends to 72 h (`external_claim_hold_hours`) — a claim, never proof; the existing sweeper (`expireStaleCheckouts`, every minute and before each purchase) cancels expired orders and re-lists the item; max 3 unpaid reservations per buyer; one buyer wins a race via `BEGIN IMMEDIATE` + conditional `UPDATE … WHERE status='active'`; repeating the request returns the same order.
* **Immutable snapshot:** `orders.snapshot_json` (listing details, photos, terms, shipping payer/fee, seller, payment-link host) is written once; triggers forbid updating it, the order's money/party columns, `order_items` price/title, deleting orders, and updating/deleting `ledger` rows.
* **Payment links** (`src/paymentLinks.js`): HTTPS only, exact hostname allowlist (`PAYMENT_LINK_HOSTS`, default `buy.stripe.com`), no credentials/odd ports/homepages; stored per listing (`listings.payment_url`) or as the seller default (`users.checkout_url`, usable only with `checkout_url_any_amount=1`). The buyer redirect (`GET /orders/:id/pay`) reads the link from the DB, re-validates it, appends `client_reference_id=PP-<order id>`, and answers with `Cache-Control: no-store`.
* **Shipping:** `listings.shipping_payer` = `buyer` (flat `shipping_cents`) or `seller` (free; `shipping_cents` forced to 0). Carrier from a fixed list, tracking number validated, tracking URL built only for known carriers.
* **Data minimisation:** the buyer's address is stored on the checkout but shown to the seller only after they confirm payment.
* **Stats:** direct sales are reported separately (`stats.directOverview`): item sales, shipping collected, cost-based margin — no fees, payouts, escrow or balance are claimed for them.

Schema additions (migration 3): `users.checkout_url[_any_amount]`, `listings.payment_url/shipping_payer`, `checkouts.mode`, `orders.payment_mode/shipping_payer/snapshot_json/pay_clicked_at/buyer_claimed_paid_at/payment_confirmed_at/payment_reference`, plus the triggers above.
