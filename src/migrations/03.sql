-- Shared by every append-only / immutability trigger: raises with the message passed as the first trigger argument,
-- so application code sees the same error text it saw from SQLite's RAISE(ABORT, ...).
CREATE FUNCTION pp_abort() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'P0001'; END
$fn$;


ALTER TABLE users ADD COLUMN checkout_url TEXT;                              -- seller's default payment link (validated + allowlisted by the app)
ALTER TABLE users ADD COLUMN checkout_url_any_amount BIGINT NOT NULL DEFAULT 0; -- seller attests the default link lets the buyer enter any amount
ALTER TABLE listings ADD COLUMN payment_url TEXT;                            -- per-listing payment link (takes precedence)
ALTER TABLE listings ADD COLUMN shipping_payer TEXT NOT NULL DEFAULT 'buyer' CHECK (shipping_payer IN ('buyer','seller'));
UPDATE listings SET shipping_payer = 'seller' WHERE shipping_cents = 0;      -- pre-existing "Free" listings = seller pays
ALTER TABLE checkouts ADD COLUMN mode TEXT NOT NULL DEFAULT 'platform' CHECK (mode IN ('platform','external'));
ALTER TABLE orders ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'platform' CHECK (payment_mode IN ('platform','external'));
ALTER TABLE orders ADD COLUMN shipping_payer TEXT;
ALTER TABLE orders ADD COLUMN snapshot_json TEXT;                            -- immutable record of what was offered (see trigger)
ALTER TABLE orders ADD COLUMN pay_clicked_at BIGINT;
ALTER TABLE orders ADD COLUMN buyer_claimed_paid_at BIGINT;                 -- buyer SAYS they paid; never treated as proof
ALTER TABLE orders ADD COLUMN payment_confirmed_at BIGINT;                  -- seller confirmed receipt of payment in their own provider
ALTER TABLE orders ADD COLUMN payment_reference TEXT;                        -- seller's note, e.g. last digits of the Stripe payment id
CREATE INDEX idx_orders_mode ON orders(payment_mode, seller_id, status);

-- Financial/historical records must not be rewritten or removed by application bugs.

-- triggers (ported from SQLite RAISE(ABORT) triggers; same messages, same firing rules)
CREATE TRIGGER orders_snapshot_immutable BEFORE UPDATE OF snapshot_json ON orders FOR EACH ROW
  WHEN (OLD.snapshot_json IS NOT NULL)
  EXECUTE FUNCTION pp_abort('order snapshot is immutable');
CREATE TRIGGER orders_terms_immutable BEFORE UPDATE OF subtotal_cents, shipping_cents, tax_cents, total_cents, buyer_id, seller_id, payment_mode ON orders FOR EACH ROW
  EXECUTE FUNCTION pp_abort('order terms are immutable');
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders FOR EACH ROW
  EXECUTE FUNCTION pp_abort('orders cannot be deleted');
CREATE TRIGGER order_items_immutable BEFORE UPDATE OF listing_id, title, price_cents, cost_cents ON order_items FOR EACH ROW
  EXECUTE FUNCTION pp_abort('order items are immutable');
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger FOR EACH ROW
  EXECUTE FUNCTION pp_abort('ledger rows are append-only');
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger FOR EACH ROW
  EXECUTE FUNCTION pp_abort('ledger rows are append-only');
