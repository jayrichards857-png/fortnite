
ALTER TABLE listings ADD COLUMN payment_ack_at BIGINT;
ALTER TABLE listings ADD COLUMN payment_ack_policy TEXT;
ALTER TABLE users ADD COLUMN selling_restricted_until BIGINT;
ALTER TABLE cases ADD COLUMN payment_mismatch BIGINT NOT NULL DEFAULT 0 CHECK (payment_mismatch IN (0,1));
CREATE INDEX idx_cases_mismatch ON cases(payment_mismatch, subject_user_id) WHERE payment_mismatch = 1;
-- Backstop: whatever code path changes the price or shipping, a seller confirmation that no longer equals item + buyer-paid shipping is cleared in the same statement.

-- If price or shipping terms change, a stored seller confirmation of the buyer total no longer applies: clear it atomically with the change.
CREATE FUNCTION pp_ack_follows_total() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- (the whole condition is parenthesised: plpgsql would otherwise end the IF expression at the CASE's own THEN)
  IF (NEW.payment_total_ack_cents IS NOT NULL
      AND NEW.payment_total_ack_cents <> NEW.price_cents + (CASE WHEN NEW.shipping_payer = 'buyer' THEN NEW.shipping_cents ELSE 0 END)) THEN
    NEW.payment_total_ack_cents := NULL; NEW.payment_ack_at := NULL; NEW.payment_ack_policy := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER listings_ack_follows_total BEFORE UPDATE OF price_cents, shipping_cents, shipping_payer ON listings FOR EACH ROW EXECUTE FUNCTION pp_ack_follows_total();
