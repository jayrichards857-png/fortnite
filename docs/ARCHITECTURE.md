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


## Access control, invitations and the seller cap
* `config.signups` (`open|closed`; default **open**, buyer accounts only) and `SELLER_ONBOARDING` (`open|invite`; default **invite**; `open` is honoured only outside production and the production start-up guard refuses it). `/sell` is the “Coming Soon!” page for everyone except approved sellers (admins get a pointer to invitations); `/api/sell/onboard` returns 403 unless the dev/test opt-out is on. `SIGNUPS=closed` additionally shows “Coming soon” on `/register` and 403s `/api/register`.
* **Administrators** are created only by `scripts/create-admin.js` (`status|setup|reset|promote`): random one-time temporary password, `users.must_change_password` forces a change before anything else works (middleware in `server.js`), resets sign out all sessions, actions are audit-logged, passwords are scrypt hashes and never recoverable. Role changes on Admin → Users require the acting admin's password, can't target yourself or remove the last admin. “Approve seller access” issues a normal invitation (cap + slot reservation apply).
* **Dev email preview** (`/dev/emails`) exists only when `NODE_ENV!=production` and no provider is configured; there is no environment switch for it.
* **Invitations** (`src/invitations.js`): token `pp_inv_…` shown once, only its SHA-256 stored; single-use, 7-day expiry, bound to an email; accepting is one transaction (create/upgrade user + take slot + consume token); every failure returns the same generic error. Unique live invitation per (email, kind).
* **Seller cap** (`settings.seller_cap`, default 3) is enforced by SQLite triggers `sellers_cap_insert/update`, so application bugs and concurrent requests cannot exceed it. Every `is_seller=1` account (including suspended) occupies a slot; live seller invitations reserve one at creation; only an audited admin `releaseSellerSlot` frees one. Buyers never use slots. If a database already holds more sellers than the cap, nothing is removed and only new sellers are blocked.
* **Email** (`src/email.js`): `email_outbox` records every message; no provider ⇒ status `not_configured` (nothing is claimed sent). Verification / email-change / reset tokens (`email_tokens`) are hashed, single-use and throttled. Seller verification gates publishing and new orders.
* **Audit** (`audit_log`, append-only by trigger): invitations, slot release, bans/suspensions, listing removals, settings, case notes/decisions, refund resolutions, outbox views, reported-conversation views.

## Storefronts
`storefronts(seller_id, draft_json, published_json)`. Only curated enums (themes, accents, layouts, sort orders, link kinds) and bounded text are accepted; there is no user CSS/JS/HTML. `/storefront.css` is generated from one palette (contrast-tested). Images must be uploads owned by the seller; dimension and size limits apply; unreferenced uploads are cleaned up hourly (`isReferenced` checks listings, orders, evidence, case events, storefronts).

## Cases and refunds (founder-managed)
* `cases` (`order_issue | seller_issue | message_report`) + append-only `case_events` (report/response/evidence/status/decision/action; `internal=1` events are admin-only by trigger and never rendered to users). Non-members get **404**, not 403. Seller sees only order issues about them.
* `refund_requests` record who *said* what: `requested → seller_reported_refunded → buyer_confirmed_refund`, or `buyer_disputes_refund` (escalates to a case), `seller_declined`, `admin_verified_refund`, `admin_closed`. The order moves to `refunded` **only** on buyer confirmation or admin verification — never on the seller's say-so. PairPlug cannot verify Stripe.
* Admins read a conversation only through a case that references it (`cases.adminConversation`), each view audited.

## Threat assumptions
Single trusted founder-admin; 1–3 vetted sellers; hostile or careless buyers/visitors; no PCI scope (card data never touches PairPlug); Stripe-link validity is format/host only (ownership and amount are **not** verifiable); the VM, reverse proxy and email provider are outside this repo's tests. Known limitations: CSP allows inline scripts; in-memory rate limits and chat hub (single process); user enumeration is limited to the invitation flow (generic errors) but the open-sign-up mode used in development reveals registered emails.

### Order visibility and payment confirmation (schema v7)
* Every direct order is a durable row created inside the reservation transaction (`startPurchase`); the response is built only after commit and reads the row back. It returns `orderId`, `reference` (`PP-<id>`) and the order link.
* Seller **Orders** and buyer **My orders** list direct orders of **every** status (awaiting confirmation, paid, shipped/delivered, disputed, cancelled/released, refunded), newest first, grouped by stage for the seller. Previously cancelled/expired direct orders were filtered out of both lists, so an unpaid order silently vanished when its reservation expired or was released. A genuine empty state is shown only when the query returns no rows; a failing query is a 500 error page.
* `orders.payment_confirmed_by` (+ existing `payment_confirmed_at`) records which seller confirmed. Confirm and release are idempotent for repeats; only the seller's explicit action moves an order to `paid` (never checkout start, the pay link, or the buyer's “I paid” claim). `releaseListing` only re-opens an item still reserved by *that* checkout, so a late release never disturbs another reservation or a sale.

### External sales (schema v8)
Inventory's old “Mark sold” changed only `listings.status`; it never created an order (by design), so such items were Sold but absent from Orders. Now **Record external sale** (`/dashboard/listings/<id>/external-sale`, `src/externalSales.js`) writes the seller's own record in `external_sales` (listing, seller, sold date, optional price/where/reference/note) and marks an active listing Sold in one transaction. It is **not an order**: no buyer, checkout or payment status is created, PairPlug has not verified the sale (the UI says so), one record per listing (unique index), append-only (triggers). Items that have a PairPlug order (anything but cancelled) are refused, reserved items are refused, and genuine orders still become paid only through the seller's payment confirmation. The Orders page lists external sales in a separate, labelled section and lists Sold listings with neither an order nor a record under “Sold items with no sales record” — **nothing is converted automatically**; the seller records each one deliberately.

### Fulfilment of direct orders (no schema change)
Seller order page → **Ship this order** (paid orders): recipient (from the checkout address, shown only after payment is confirmed), carrier (USPS/UPS/FedEx/Canada Post/DHL/Other), tracking, optional message, **Mark shipped** (`X.sellerShip`): validates carrier, tracking and the recipient address, requires a confirmed payment, is idempotent for the same carrier+tracking, writes the shipment to the order and a `paid → shipped` row in `order_events`, and sends an **in-app** notification (there is no email mechanism; the response says `notified:false` if it could not be written). `X.sellerCorrectTracking` fixes typos while `shipped` and logs old → new in `order_events`. Delivered is set only by the **buyer** or an authenticated carrier webhook (`actor: carrier`); a seller's own claim is refused (403). Orders without a usable address (older orders) show a clear “address missing” notice, block shipping, let the seller send an in-app request (`request-address`) and let the **buyer** add the address once (`buyerSetAddress`); addresses are never invented or silently replaced. The “Sold outside PairPlug” feature (schema v8) stays as a collapsed, secondary section: it is not part of the purchase path.

### Unified “Record sale” (schema v9)
`external_sales` (kept under its original name) is now the seller's **recorded-sale** table. Migration 9 only adds columns: `origin` (pairplug / in_person / other_marketplace / social / other; **NULL on every pre-existing row = “earlier record”, never relabelled and immutable by trigger**), `payment_status` (`unconfirmed` | `confirmed_by_seller` — an attestation, never “verified”), `fulfillment` (ship | pickup), recipient columns, `carrier`/`tracking_number`/`ship_note`/`shipment_status`/`shipped_at`, optional `buyer_email` (reference only; nothing is ever emailed), and `voided_*`. One **active** record per listing (partial unique index; the old unconditional index was replaced so a voided record can be superseded). Corrections, payment attestations, fulfilment saves, shipping and voids are logged in the append-only `sale_events` (addresses are not copied into the log). A listing with a genuine PairPlug order (anything but cancelled) cannot be recorded (the order is the record); a void pauses the listing (never reopens it) and is refused once shipped. Recorded sales have no PairPlug buyer account, so no notification is created or claimed. Recipient/buyer details are visible only to the owning seller.

### Seller discovery, following and search activity (schema v10)
* **Sellers shown** are public (`is_seller`, not banned). Discovery lists require ≥1 available listing and rank by newest available listing, then number of available listings (stated on the page). Seller search requires every term to match the seller's name/handle/bio/published storefront headline-about **or** one of their available listings; score = name match (exact 100 / prefix 60 / contains 40) + storefront text 15 + 5 per matching available listing (cap 10) then recency. No fabricated counts: follower counts are not shown at all.
* **Follows** (`seller_follows`, PK (follower, seller), CHECK follower<>seller, index on seller): POST/PUT/DELETE `/api/sellers/:handle/follow`, login required, idempotent; following exposes nothing private. The heart updates optimistically in `public/app.js` and rolls back on error.
* **New-drop notifications:** `discovery.announceDrop` runs after commit on every publish path (save, bulk status, resume). It claims `listings.drop_notified_at` once, then does one set-based `INSERT OR IGNORE … SELECT` into `notifications` (UNIQUE(user, dedupe_key `drop:<id>`)), skipping the seller and banned followers; drafts/paused/sold listings never qualify; migration 10 marks all already-published listings as announced. In-app only (existing notifications page and unread badge), with an optional thumbnail (`notifications.image`).
* **Search activity** (`search_log(term, created_at)`): terms are normalised (case, whitespace, symbols), noise/emails/URLs/long digit runs rejected, first result page only, rapid repeats and per-source floods dropped using an in-memory hash that is never stored; no user id or IP is stored; rows older than 30 days are purged hourly. “Popular searches” = terms searched ≥3 times in the last 14 days that share a word with the current query (cached 60 s); otherwise the section is omitted.

### Sellers with no listings (no schema change)
`discoverSellers` now lists every public seller (`is_seller = 1`, not banned) with a plain `COUNT(*)` for pagination; stores with available items rank first (newest listing, then item count), then newer stores. `searchSellers` already matched profile text (name, handle, bio, published storefront headline/about) OR active listings, so empty stores are found by profile text and ranked below stores whose inventory matches (score +5 per matching listing). Empty cards/storefronts say "No listings yet — check back for their next drop." The Follow heart works regardless of inventory, and `announceDrop` fires on a listing's first publication whether or not the seller had earlier listings.

### Legal pages and recorded acceptance (schema v11)
* `src/legal.js` holds the four policy pages as code (`/terms`, `/privacy`, `/payments`, `/rules`, index `/legal`; `/refunds` and `/prohibited` redirect) and `VERSION`. **Change the text and bump `VERSION` together**; the version is what is recorded when someone accepts. Operator identity is never invented: `LEGAL_ENTITY` and `LEGAL_ADDRESS` (optional env) and `SUPPORT_EMAIL` appear only when set; otherwise the pages say those details are not published yet.
* Migration 11 adds nullable `users.terms_version` and `users.terms_accepted_at`. Existing users stay NULL (never back-filled). New accounts must tick the terms box at sign-up (`/api/register`) or invitation (`/api/invitations/accept` for new accounts, or existing users without the current version); the server refuses without `terms === true` and records version + time. Existing users can accept from Account → Terms & privacy (`POST /api/account/terms`, audited). Nothing is blocked while a user hasn't accepted, and checkout has no extra consent box (its existing "paying the seller directly" acknowledgement is unchanged).
* Footer links on every page; contextual links on sign-up, invitation, listing editor, and the buy page.
