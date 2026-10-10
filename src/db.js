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
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','seller_reported_refunded','seller_declined','buyer_confirmed_refund','buyer_disputes_refund','admin_closed')),
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
