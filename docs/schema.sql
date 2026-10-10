-- PairPlug schema (generated from src/db.js MIGRATIONS; SQLite). Money is integer cents.

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
