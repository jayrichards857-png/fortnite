'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

// Money is always stored as integer cents (never floats).
// Migrations are append-only; `PRAGMA user_version` records how many have run.
const MIGRATIONS = [
`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_seller INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard','pro')),
  handle TEXT UNIQUE COLLATE NOCASE,
  store_name TEXT, bio TEXT,
  country TEXT, region TEXT, city TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE uploads (
  file TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE listings (
  id INTEGER PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  brand TEXT, size TEXT,
  condition TEXT CHECK (condition IN ('new_with_tags','like_new','good','fair')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 100),
  cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  sku TEXT,
  weight_oz REAL, length_in REAL, width_in REAL, height_in REAL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','reserved','sold','archived')),
  reserved_until INTEGER,
  reserved_checkout_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX idx_listings_status_created ON listings(status, published_at DESC);
CREATE INDEX idx_listings_category ON listings(category, status);
CREATE INDEX idx_listings_price ON listings(price_cents);
CREATE INDEX idx_listings_seller ON listings(seller_id, status);
CREATE UNIQUE INDEX idx_listings_seller_sku ON listings(seller_id, sku) WHERE sku IS NOT NULL AND sku <> '';

CREATE TABLE listing_images (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_listing_images ON listing_images(listing_id, position);

CREATE TABLE favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);
CREATE TABLE cart_items (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE checkouts (
  id INTEGER PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')),
  idempotency_key TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  ship_name TEXT, ship_line1 TEXT, ship_line2 TEXT, ship_city TEXT, ship_region TEXT, ship_postal TEXT, ship_country TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (buyer_id, idempotency_key)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  checkout_id INTEGER NOT NULL REFERENCES checkouts(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','paid','shipped','delivered','released','disputed','refunded','cancelled')),
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  fee_bps INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  processing_fee_cents INTEGER NOT NULL,
  seller_payout_cents INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  carrier TEXT, tracking_number TEXT, label_ref TEXT,
  paid_at INTEGER, shipped_at INTEGER, delivered_at INTEGER, released_at INTEGER, auto_release_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_orders_seller ON orders(seller_id, status, created_at DESC);
CREATE INDEX idx_orders_buyer ON orders(buyer_id, created_at DESC);
CREATE INDEX idx_orders_checkout ON orders(checkout_id);
CREATE INDEX idx_orders_autorelease ON orders(auto_release_at) WHERE status = 'delivered';
CREATE UNIQUE INDEX idx_orders_tracking ON orders(carrier, tracking_number) WHERE tracking_number IS NOT NULL;

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  cost_cents INTEGER,
  image TEXT
);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_listing ON order_items(listing_id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_order_events ON order_events(order_id);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  checkout_id INTEGER NOT NULL REFERENCES checkouts(id),
  provider TEXT NOT NULL,
  provider_ref TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refunded','needs_refund')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_checkout ON payments(checkout_id);
CREATE TABLE payment_events (  -- webhook idempotency ledger
  event_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  provider_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_refund_once ON refunds(order_id);

-- Seller wallet. One row per money movement; UNIQUE(order_id, kind) makes escrow release idempotent.
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_id INTEGER REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('sale_release','withdrawal','adjustment')),
  amount_cents INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ledger_once ON ledger(order_id, kind) WHERE order_id IS NOT NULL;
CREATE INDEX idx_ledger_user ON ledger(user_id, created_at DESC);
CREATE TABLE withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE disputes (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  opened_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_refund','resolved_release')),
  resolution_note TEXT,
  resolved_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE dispute_evidence (
  id INTEGER PRIMARY KEY,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  party TEXT NOT NULL CHECK (party IN ('buyer','seller')),
  note TEXT,
  image TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence ON dispute_evidence(dispute_id);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_seller ON reviews(seller_id);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT, link TEXT,
  dedupe_key TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
// 2: private buyer<->seller chat
`
-- One private conversation per buyer/seller pair. listing_id is only the most recent listing the buyer asked about (context).
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (buyer_id <> seller_id),
  UNIQUE (buyer_id, seller_id)
);
CREATE INDEX idx_conv_seller ON conversations(seller_id, last_message_at DESC);
CREATE INDEX idx_conv_buyer ON conversations(buyer_id, last_message_at DESC);

-- AUTOINCREMENT: ids are strictly increasing and never reused, so an id is a safe sync cursor.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  client_id TEXT NOT NULL,          -- idempotency key generated by the sender's client
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, sender_id, client_id)
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE conversation_reads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
`,
// 3: private-beta direct checkout (seller-owned payment links). Additive only: historical orders/ledger rows are untouched.
`
ALTER TABLE users ADD COLUMN checkout_url TEXT;                              -- seller's default payment link (validated + allowlisted by the app)
ALTER TABLE users ADD COLUMN checkout_url_any_amount INTEGER NOT NULL DEFAULT 0; -- seller attests the default link lets the buyer enter any amount
ALTER TABLE listings ADD COLUMN payment_url TEXT;                            -- per-listing payment link (takes precedence)
ALTER TABLE listings ADD COLUMN shipping_payer TEXT NOT NULL DEFAULT 'buyer' CHECK (shipping_payer IN ('buyer','seller'));
UPDATE listings SET shipping_payer = 'seller' WHERE shipping_cents = 0;      -- pre-existing "Free" listings = seller pays
ALTER TABLE checkouts ADD COLUMN mode TEXT NOT NULL DEFAULT 'platform' CHECK (mode IN ('platform','external'));
ALTER TABLE orders ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'platform' CHECK (payment_mode IN ('platform','external'));
ALTER TABLE orders ADD COLUMN shipping_payer TEXT;
ALTER TABLE orders ADD COLUMN snapshot_json TEXT;                            -- immutable record of what was offered (see trigger)
ALTER TABLE orders ADD COLUMN pay_clicked_at INTEGER;
ALTER TABLE orders ADD COLUMN buyer_claimed_paid_at INTEGER;                 -- buyer SAYS they paid; never treated as proof
ALTER TABLE orders ADD COLUMN payment_confirmed_at INTEGER;                  -- seller confirmed receipt of payment in their own provider
ALTER TABLE orders ADD COLUMN payment_reference TEXT;                        -- seller's note, e.g. last digits of the Stripe payment id
CREATE INDEX idx_orders_mode ON orders(payment_mode, seller_id, status);

-- Financial/historical records must not be rewritten or removed by application bugs.
CREATE TRIGGER orders_snapshot_immutable BEFORE UPDATE OF snapshot_json ON orders WHEN OLD.snapshot_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'order snapshot is immutable'); END;
CREATE TRIGGER orders_terms_immutable BEFORE UPDATE OF subtotal_cents, shipping_cents, tax_cents, total_cents, buyer_id, seller_id, payment_mode ON orders
  BEGIN SELECT RAISE(ABORT, 'order terms are immutable'); END;
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;
CREATE TRIGGER order_items_immutable BEFORE UPDATE OF listing_id, title, price_cents, cost_cents ON order_items
  BEGIN SELECT RAISE(ABORT, 'order items are immutable'); END;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger rows are append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger rows are append-only'); END;
`,
// 4: beta finalization — invitations, hard seller cap, email verification, storefront customisation, support cases, refund requests, audit log.
// Additive only: no existing row is rewritten (every existing user simply has email_verified_at = NULL until they verify).
`
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE listings ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD'));
ALTER TABLE orders ADD COLUMN ship_note TEXT;

-- Invitations: the raw token is never stored (only its SHA-256), single use, expiring, revocable.
CREATE TABLE invitations (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('buyer','seller')),
  email TEXT NOT NULL COLLATE NOCASE,
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by INTEGER REFERENCES users(id),
  revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_invitations_live ON invitations(email, kind) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Email verification / email change / password reset tokens (hashed, single use, expiring).
CREATE TABLE email_tokens (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','change_email','reset_password')),
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose, created_at DESC);

-- Every outgoing email is recorded. With no provider configured, rows stay 'not_configured' and nothing is claimed as sent.
CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('not_configured','sent','failed')),
  provider TEXT, provider_ref TEXT, error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

-- Storefront customisation: a private draft and the published copy. Only whitelisted, validated values are ever stored.
CREATE TABLE storefronts (
  seller_id INTEGER PRIMARY KEY REFERENCES users(id),
  draft_json TEXT,
  published_json TEXT,
  draft_updated_at INTEGER,
  published_at INTEGER
);

-- Support cases (order issues, seller issues, reported messages). Events are append-only; internal notes are admin-only.
CREATE TABLE cases (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('order_issue','seller_issue','message_report')),
  order_id INTEGER REFERENCES orders(id),
  conversation_id INTEGER REFERENCES conversations(id),
  message_id INTEGER REFERENCES messages(id),
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  subject_user_id INTEGER REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_seller','under_review','resolved','dismissed')),
  resolution TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_cases_status ON cases(status, created_at DESC);
CREATE INDEX idx_cases_order ON cases(order_id);
CREATE UNIQUE INDEX idx_cases_one_open_order ON cases(order_id, reporter_id) WHERE kind = 'order_issue' AND status IN ('open','awaiting_seller','under_review');
CREATE TABLE case_events (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('buyer','seller','admin')),
  kind TEXT NOT NULL CHECK (kind IN ('report','response','evidence','internal_note','status','decision','action')),
  body TEXT,
  image TEXT,
  internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_case_events ON case_events(case_id, id);

-- Refund / cancellation requests. PairPlug moves no money: each status records who SAID what; only the other party's
-- confirmation (or an admin decision) completes it.
CREATE TABLE refund_requests (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('refund','cancellation')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','seller_reported_refunded','seller_declined','buyer_confirmed_refund','buyer_disputes_refund','admin_verified_refund','admin_closed')),
  seller_note TEXT,
  refund_reference TEXT,
  case_id INTEGER REFERENCES cases(id),
  requested_at INTEGER NOT NULL,
  seller_responded_at INTEGER,
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_refund_order ON refund_requests(order_id);
CREATE UNIQUE INDEX idx_refund_one_open ON refund_requests(order_id) WHERE status IN ('requested','seller_reported_refunded','buyer_disputes_refund');

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER case_events_no_update BEFORE UPDATE ON case_events BEGIN SELECT RAISE(ABORT, 'case events are append-only'); END;
CREATE TRIGGER case_events_no_delete BEFORE DELETE ON case_events BEGIN SELECT RAISE(ABORT, 'case events are append-only'); END;
CREATE TRIGGER case_events_internal_admin_only BEFORE INSERT ON case_events WHEN NEW.internal = 1 AND NEW.actor_role <> 'admin'
  BEGIN SELECT RAISE(ABORT, 'internal notes are admin-only'); END;
CREATE TRIGGER invitations_token_immutable BEFORE UPDATE OF token_hash, email, kind ON invitations BEGIN SELECT RAISE(ABORT, 'invitation identity is immutable'); END;

-- HARD SELLER CAP, enforced by the database so no code path or race can exceed it. The cap lives in settings (default 3).
-- It only blocks NEW sellers; existing rows are never touched, so a database that somehow already has more is preserved.
INSERT OR IGNORE INTO settings(key, value) VALUES ('seller_cap', '3');
CREATE TRIGGER sellers_cap_insert BEFORE INSERT ON users
  WHEN NEW.is_seller = 1 AND (SELECT COUNT(*) FROM users WHERE is_seller = 1) >= COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'seller_cap'), 3)
  BEGIN SELECT RAISE(ABORT, 'seller cap reached'); END;
CREATE TRIGGER sellers_cap_update BEFORE UPDATE OF is_seller ON users
  WHEN NEW.is_seller = 1 AND OLD.is_seller = 0 AND (SELECT COUNT(*) FROM users WHERE is_seller = 1) >= COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'seller_cap'), 3)
  BEGIN SELECT RAISE(ABORT, 'seller cap reached'); END;
`,
// 5: administrator setup/reset — a CLI-issued temporary password must be changed at first login. Additive; existing users are unaffected (0).
`
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
`,
// 6: shipping labels (Shippo, TEST MODE ONLY in this release). Additive: no existing row is touched.
//   seller_ship_from  the seller's own sender address (we never invent one; sellers enter it)
//   shipments         one row per quote/purchase attempt. test=1 rows used a Shippo TEST token: they are NOT valid postage and are never copied into orders.
`
CREATE TABLE seller_ship_from (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  name TEXT NOT NULL, line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, region TEXT NOT NULL, postal TEXT NOT NULL,
  country TEXT NOT NULL CHECK (country IN ('US','CA','MX')), phone TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE shipments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'shippo',
  test INTEGER NOT NULL CHECK (test IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('rates_ready','purchasing','success','failed','superseded')),
  weight_oz REAL NOT NULL, length_in REAL NOT NULL, width_in REAL NOT NULL, height_in REAL NOT NULL,
  address_hash TEXT NOT NULL,
  provider_shipment_id TEXT, rates_json TEXT, rates_fetched_at INTEGER,
  selected_rate_id TEXT, carrier TEXT, service TEXT, price_cents INTEGER, currency TEXT,
  provider_transaction_id TEXT, label_url TEXT, tracking_number TEXT, tracking_url TEXT, tracking_status TEXT,
  error_message TEXT, confirmed_at INTEGER, purchased_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_shipments_order ON shipments(order_id, id);
-- At most one in-flight or completed purchase per order and mode: this is what makes double clicks and retries safe.
CREATE UNIQUE INDEX idx_shipments_one_purchase ON shipments(order_id, test) WHERE status IN ('purchasing','success');
CREATE TRIGGER shipments_no_delete BEFORE DELETE ON shipments BEGIN SELECT RAISE(ABORT, 'shipments cannot be deleted'); END;
CREATE TRIGGER shipments_label_immutable BEFORE UPDATE OF order_id, seller_id, test, price_cents, currency, carrier, service, label_url, tracking_number, provider_transaction_id ON shipments
  WHEN OLD.status = 'success' BEGIN SELECT RAISE(ABORT, 'a purchased label cannot be changed'); END;
`,
// 7: record WHICH seller confirmed payment (the timestamp already exists as payment_confirmed_at). Additive; existing paid direct orders are
// backfilled from their immutable order_events history (actor 'seller:<id>'). No money columns are touched.
`
ALTER TABLE orders ADD COLUMN payment_confirmed_by INTEGER REFERENCES users(id);
UPDATE orders SET payment_confirmed_by = (
  SELECT CAST(substr(e.actor, 8) AS INTEGER) FROM order_events e WHERE e.order_id = orders.id AND e.to_status = 'paid' AND e.actor LIKE 'seller:%' ORDER BY e.id LIMIT 1)
 WHERE payment_mode = 'external' AND payment_confirmed_at IS NOT NULL;
`,
// 8: external sales — items the seller sold OUTSIDE a PairPlug checkout (in person, another marketplace, ...). This is the seller's own record: it is not a
// PairPlug order, has no buyer or payment status, and PairPlug has not verified it. One record per listing; append-only. Additive: no existing row is touched.
`
CREATE TABLE external_sales (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  sold_on TEXT NOT NULL CHECK (sold_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  price_cents INTEGER CHECK (price_cents IS NULL OR (price_cents >= 0 AND price_cents <= 100000000)),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  channel TEXT, reference TEXT, note TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_external_sales_listing ON external_sales(listing_id);
CREATE INDEX idx_external_sales_seller ON external_sales(seller_id, sold_on DESC, id DESC);
CREATE TRIGGER external_sales_no_delete BEFORE DELETE ON external_sales BEGIN SELECT RAISE(ABORT, 'external sale records cannot be deleted'); END;
CREATE TRIGGER external_sales_no_update BEFORE UPDATE ON external_sales BEGIN SELECT RAISE(ABORT, 'external sale records cannot be changed'); END;
`,
// 9: unified sale recording. The table keeps its name; existing rows are untouched: their new columns stay NULL (origin NULL = "earlier record, origin not captured"),
// so their historical meaning is never relabelled. New rows carry the sale origin, the seller's payment attestation (never "verified"), fulfilment (ship / pickup),
// the recipient address, shipment details, an optional buyer email (reference only; never emailed) and void fields. Corrections and voids are logged in sale_events.
`
ALTER TABLE external_sales ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('pairplug','in_person','other_marketplace','social','other'));
ALTER TABLE external_sales ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (payment_status IN ('unconfirmed','confirmed_by_seller'));
ALTER TABLE external_sales ADD COLUMN payment_confirmed_at INTEGER;
ALTER TABLE external_sales ADD COLUMN fulfillment TEXT CHECK (fulfillment IS NULL OR fulfillment IN ('ship','pickup'));
ALTER TABLE external_sales ADD COLUMN shipment_status TEXT CHECK (shipment_status IS NULL OR shipment_status IN ('not_shipped','shipped','not_applicable'));
ALTER TABLE external_sales ADD COLUMN recipient_name TEXT;
ALTER TABLE external_sales ADD COLUMN recipient_line1 TEXT;
ALTER TABLE external_sales ADD COLUMN recipient_line2 TEXT;
ALTER TABLE external_sales ADD COLUMN recipient_city TEXT;
ALTER TABLE external_sales ADD COLUMN recipient_region TEXT;
ALTER TABLE external_sales ADD COLUMN recipient_postal TEXT;
ALTER TABLE external_sales ADD COLUMN recipient_country TEXT;
ALTER TABLE external_sales ADD COLUMN carrier TEXT;
ALTER TABLE external_sales ADD COLUMN tracking_number TEXT;
ALTER TABLE external_sales ADD COLUMN ship_note TEXT;
ALTER TABLE external_sales ADD COLUMN shipped_at INTEGER;
ALTER TABLE external_sales ADD COLUMN buyer_email TEXT;
ALTER TABLE external_sales ADD COLUMN voided_at INTEGER;
ALTER TABLE external_sales ADD COLUMN void_reason TEXT;
ALTER TABLE external_sales ADD COLUMN voided_by INTEGER REFERENCES users(id);
ALTER TABLE external_sales ADD COLUMN updated_at INTEGER;
DROP INDEX idx_external_sales_listing;
CREATE UNIQUE INDEX idx_external_sales_listing_active ON external_sales(listing_id) WHERE voided_at IS NULL;
CREATE UNIQUE INDEX idx_external_sales_tracking ON external_sales(carrier, tracking_number) WHERE tracking_number IS NOT NULL AND voided_at IS NULL;
DROP TRIGGER external_sales_no_update;
CREATE TRIGGER external_sales_identity_immutable BEFORE UPDATE OF listing_id, seller_id, recorded_at, origin ON external_sales
  BEGIN SELECT RAISE(ABORT, 'a sale record''s listing, seller, origin and creation time cannot be changed'); END;
CREATE TRIGGER external_sales_void_final BEFORE UPDATE ON external_sales WHEN OLD.voided_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'voided sale records cannot be changed'); END;
CREATE TABLE sale_events (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES external_sales(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sale_events ON sale_events(sale_id, id);
CREATE TRIGGER sale_events_no_update BEFORE UPDATE ON sale_events BEGIN SELECT RAISE(ABORT, 'sale history is append-only'); END;
CREATE TRIGGER sale_events_no_delete BEFORE DELETE ON sale_events BEGIN SELECT RAISE(ABORT, 'sale history is append-only'); END;
`,
// 10: seller discovery. Additive and backward compatible; nothing existing is rewritten except a backfill that marks ALREADY-published listings as announced
// (so existing listings never produce new-drop notifications).
//   seller_follows  who follows which public seller (private to the follower; no counts are shown)
//   search_log      normalised search terms ONLY (no user id, no IP, no timestamps beyond the minute-level created_at), purged after 30 days; used for "Popular searches"
//   listings.drop_notified_at  set exactly once when a listing's first publication has been announced to followers (retry-safe)
//   notifications.image        optional thumbnail for in-app notifications
`
CREATE TABLE seller_follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, seller_id),
  CHECK (follower_id <> seller_id)
);
CREATE INDEX idx_seller_follows_seller ON seller_follows(seller_id, created_at);
CREATE TABLE search_log (
  id INTEGER PRIMARY KEY,
  term TEXT NOT NULL CHECK (length(term) BETWEEN 2 AND 60),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_search_log_recent ON search_log(created_at, term);
ALTER TABLE listings ADD COLUMN drop_notified_at INTEGER;
UPDATE listings SET drop_notified_at = published_at WHERE published_at IS NOT NULL;
ALTER TABLE notifications ADD COLUMN image TEXT;
CREATE INDEX idx_listings_seller_active ON listings(seller_id, status, published_at DESC);
`,
// 11: recorded acceptance of the legal pages. Additive and nullable. Existing users are deliberately LEFT NULL: nobody is marked as having accepted terms they never saw.
//   users.terms_version      the version of the policy set (src/legal.js VERSION) the user explicitly accepted
//   users.terms_accepted_at  when they accepted it
`
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
`,
// 12: scam-report workflow. Additive. PairPlug moves no money; nothing here touches orders or payment state.
//   users.selling_restricted_*   a reversible PairPlug-side restriction on selling (set/lifted only by an admin from a case; reason is internal)
//   cases.category               what kind of problem the reporter says it is (a claim, not a finding)
//   processor_reports            the operator's packet for a payment provider + a record of WHEN/HOW the operator submitted it by hand. No provider API is called.
`
ALTER TABLE users ADD COLUMN selling_restricted_at INTEGER;
ALTER TABLE users ADD COLUMN selling_restricted_reason TEXT;
ALTER TABLE users ADD COLUMN selling_restricted_case INTEGER;
ALTER TABLE cases ADD COLUMN category TEXT CHECK (category IS NULL OR category IN ('non_delivery','payment_not_confirmed','not_as_described','counterfeit','fake_payment_or_tracking','suspected_scam','other'));
CREATE INDEX idx_cases_subject ON cases(subject_user_id, status);
CREATE TABLE processor_reports (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal','other')),
  provider_host TEXT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted')),
  packet TEXT NOT NULL,
  events_through INTEGER NOT NULL,
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  prepared_at INTEGER NOT NULL,
  submitted_by INTEGER REFERENCES users(id),
  submitted_at INTEGER,
  channel TEXT, reference TEXT, note TEXT
);
CREATE UNIQUE INDEX idx_processor_reports_pending ON processor_reports(case_id, provider) WHERE status = 'prepared';
CREATE TRIGGER processor_reports_no_delete BEFORE DELETE ON processor_reports BEGIN SELECT RAISE(ABORT, 'processor reports are append-only'); END;
CREATE TRIGGER processor_reports_frozen BEFORE UPDATE ON processor_reports WHEN OLD.status = 'submitted' OR NEW.case_id <> OLD.case_id OR NEW.packet <> OLD.packet OR NEW.provider <> OLD.provider OR NEW.prepared_at <> OLD.prepared_at
  BEGIN SELECT RAISE(ABORT, 'a submitted processor report cannot be changed'); END;
`,
// 13: moderators (a role between ordinary users and administrators), exactly five slots, individual single-use setup links, and an append-only moderation log.
//   users.is_moderator            0/1; capped by triggers (settings.moderator_cap = 5), counted together with live setup links so concurrent setups cannot exceed it
//   users.banned_at/by/reason     who banned the account and why (staff-only; history lives in moderation_actions); NULL for older bans
//   moderator_invites             only SHA-256(token) is stored; single use, expiring, bound to one email; identity columns immutable; never deleted
//   moderation_actions            append-only: actor, target, action, reason, optional case, time
`
ALTER TABLE users ADD COLUMN is_moderator INTEGER NOT NULL DEFAULT 0 CHECK (is_moderator IN (0,1));
ALTER TABLE users ADD COLUMN banned_at INTEGER;
ALTER TABLE users ADD COLUMN banned_by INTEGER;
ALTER TABLE users ADD COLUMN banned_reason TEXT;
INSERT OR IGNORE INTO settings(key, value) VALUES ('moderator_cap', '5');
CREATE TRIGGER moderators_cap_insert BEFORE INSERT ON users
  WHEN NEW.is_moderator = 1 AND (SELECT COUNT(*) FROM users WHERE is_moderator = 1) >= COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'moderator_cap'), 5)
  BEGIN SELECT RAISE(ABORT, 'moderator cap reached'); END;
CREATE TRIGGER moderators_cap_update BEFORE UPDATE OF is_moderator ON users
  WHEN NEW.is_moderator = 1 AND OLD.is_moderator = 0 AND (SELECT COUNT(*) FROM users WHERE is_moderator = 1) >= COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'moderator_cap'), 5)
  BEGIN SELECT RAISE(ABORT, 'moderator cap reached'); END;
CREATE TABLE moderator_invites (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_via TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by INTEGER REFERENCES users(id),
  revoked_at INTEGER
);
CREATE INDEX idx_moderator_invites_email ON moderator_invites(email);
CREATE TRIGGER moderator_invites_cap BEFORE INSERT ON moderator_invites
  WHEN (SELECT COUNT(*) FROM users WHERE is_moderator = 1)
     + (SELECT COUNT(*) FROM moderator_invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER))
     >= COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'moderator_cap'), 5)
  BEGIN SELECT RAISE(ABORT, 'moderator slots exhausted'); END;
CREATE TRIGGER moderator_invites_identity_immutable BEFORE UPDATE OF token_hash, email, created_by, created_at ON moderator_invites BEGIN SELECT RAISE(ABORT, 'setup link identity is immutable'); END;
CREATE TRIGGER moderator_invites_no_delete BEFORE DELETE ON moderator_invites BEGIN SELECT RAISE(ABORT, 'setup links are never deleted'); END;
CREATE TABLE moderation_actions (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('moderator','admin')),
  target_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('ban','unban','restrict_selling','lift_restriction')),
  reason TEXT NOT NULL CHECK (length(reason) >= 5),
  case_id INTEGER REFERENCES cases(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_moderation_target ON moderation_actions(target_id, id DESC);
CREATE TRIGGER moderation_actions_no_update BEFORE UPDATE ON moderation_actions BEGIN SELECT RAISE(ABORT, 'moderation log is append-only'); END;
CREATE TRIGGER moderation_actions_no_delete BEFORE DELETE ON moderation_actions BEGIN SELECT RAISE(ABORT, 'moderation log is append-only'); END;
`,
// 14: listing quantity, checkout-amount attestation, order-linked seller reviews, suggested names on invitations. Additive.
//   listings.quantity                units still available to reserve (reserving a unit takes one off; releasing gives it back). Backfill: reserved/sold -> 0, everything else 1.
//   listings.payment_total_ack_cents the total (item + buyer-paid shipping) the SELLER confirmed their payment link charges; NULL = not confirmed (online checkout is paused until they do)
//   seller_reviews                   one per order, tied to the buyer's own delivered order (also enforced by triggers); thumbs-up flag + optional text; moderators can only hide/restore
//   review_reports / review_events   reports on reviews; append-only history of every create/edit/remove/report/hide/restore
`
ALTER TABLE listings ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0 AND quantity <= 999);
UPDATE listings SET quantity = 0 WHERE status IN ('reserved','sold');
ALTER TABLE listings ADD COLUMN payment_total_ack_cents INTEGER;
ALTER TABLE invitations ADD COLUMN suggested_name TEXT;
ALTER TABLE moderator_invites ADD COLUMN suggested_name TEXT;
CREATE TABLE seller_reviews (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  thumbs_up INTEGER NOT NULL CHECK (thumbs_up IN (0,1)),
  body TEXT CHECK (body IS NULL OR length(body) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden','removed')),
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX idx_seller_reviews_seller ON seller_reviews(seller_id, status, created_at DESC);
CREATE TRIGGER seller_reviews_eligible BEFORE INSERT ON seller_reviews
  WHEN NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.buyer_id = NEW.buyer_id AND o.seller_id = NEW.seller_id AND o.status IN ('delivered','released'))
  BEGIN SELECT RAISE(ABORT, 'review requires the buyer''s own completed order'); END;
CREATE TRIGGER seller_reviews_identity_immutable BEFORE UPDATE OF order_id, buyer_id, seller_id, created_at ON seller_reviews BEGIN SELECT RAISE(ABORT, 'review identity is immutable'); END;
CREATE TRIGGER seller_reviews_no_delete BEFORE DELETE ON seller_reviews BEGIN SELECT RAISE(ABORT, 'reviews are never deleted'); END;
CREATE TABLE review_reports (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES seller_reviews(id),
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at INTEGER NOT NULL,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at INTEGER,
  UNIQUE (review_id, reporter_id)
);
CREATE INDEX idx_review_reports_open ON review_reports(status, created_at);
CREATE TABLE review_events (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES seller_reviews(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('buyer','seller','moderator','admin','user')),
  kind TEXT NOT NULL CHECK (kind IN ('created','edited','removed','reinstated','reported','hidden','restored','report_dismissed')),
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_review_events ON review_events(review_id, id);
CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT, 'review history is append-only'); END;
CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT, 'review history is append-only'); END;
`,
];

function migrate() {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
migrate();

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

// BEGIN IMMEDIATE takes SQLite's write lock up-front, so concurrent checkouts serialize and a
// read-then-write race (two buyers seeing the same item "active") cannot happen.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

const now = () => Math.floor(Date.now() / 1000);

function getSettings() {
  const out = { ...config.defaults };
  for (const r of q.all('SELECT key, value FROM settings')) if (r.key in out) out[r.key] = Number(r.value);
  return out;
}
function setSetting(key, value) {
  q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

module.exports = { db, q, tx, now, getSettings, setSetting, MIGRATIONS };
