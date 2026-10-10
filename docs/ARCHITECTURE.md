# PairPlug architecture

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
