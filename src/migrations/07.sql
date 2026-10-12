
ALTER TABLE orders ADD COLUMN payment_confirmed_by BIGINT REFERENCES users(id);
UPDATE orders SET payment_confirmed_by = (
  SELECT CAST(substr(e.actor, 8) AS BIGINT) FROM order_events e WHERE e.order_id = orders.id AND e.to_status = 'paid' AND e.actor LIKE 'seller:%' ORDER BY e.id LIMIT 1)
 WHERE payment_mode = 'external' AND payment_confirmed_at IS NOT NULL;
