'use strict';
// Escrow: funds are held by the platform from `paid` until the buyer confirms receipt or
// auto-release fires N days after delivery. Only releaseToSeller() writes the seller's wallet,
// and the ledger's UNIQUE(order_id,'sale_release') makes a double release impossible even
// if two code paths race.
const { q, tx, now, getSettings } = require('./db');
const { transition } = require('./orderMachine');
const { notify } = require('./notify');
const { getProviderByName } = require('./payments');

/** Move shipped -> delivered (carrier sync or buyer confirmation) and start the auto-release clock. */
function markDelivered(orderId, actor) {
  return tx(() => {
    const days = getSettings().auto_release_days;
    const t = now();
    transition(orderId, 'delivered', { actor, set: { delivered_at: t, auto_release_at: t + days * 86400 } });
    const o = q.get('SELECT * FROM orders WHERE id = ?', orderId);
    notify(o.buyer_id, `order:${o.id}:delivered`, 'Order delivered', `Confirm receipt on order #${o.id} or funds release to the seller in ${days} days.`, `/orders/${o.id}`);
    notify(o.seller_id, `order:${o.id}:delivered-seller`, 'Order delivered', `Order #${o.id} was delivered. Funds release after buyer confirmation or ${days} days.`, '/dashboard/orders');
  });
}

/** delivered|disputed -> released, crediting the seller's wallet exactly once. */
function releaseToSeller(orderId, actor) {
  return tx(() => {
    transition(orderId, 'released', { actor, set: { released_at: now(), auto_release_at: null } });
    const o = q.get('SELECT * FROM orders WHERE id = ?', orderId);
    q.run("INSERT INTO ledger(user_id, order_id, kind, amount_cents, note, created_at) VALUES(?,?,'sale_release',?,?,?)",
      o.seller_id, o.id, o.seller_payout_cents, `Order #${o.id}`, now());
    notify(o.seller_id, `order:${o.id}:released`, 'Funds released', `Order #${o.id}: ${(o.seller_payout_cents / 100).toFixed(2)} added to your balance.`, '/dashboard/finance');
    return o;
  });
}

/** Buyer confirms receipt. From `shipped` we record the delivery first so the audit trail stays complete. */
function buyerConfirm(orderId, userId) {
  const o = q.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', orderId, userId);
  if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
  // Disputed orders are resolved by an admin only; the buyer's confirm button must not bypass that.
  if (!['shipped', 'delivered'].includes(o.status)) throw Object.assign(new Error(`Order can't be confirmed while ${o.status.replace('_', ' ')}.`), { status: 409 });
  if (o.status === 'shipped') markDelivered(orderId, `buyer:${userId}`);
  return releaseToSeller(orderId, `buyer:${userId}`);
}

/** Cron-style job: release every delivered order whose hold window has elapsed. */
function autoReleaseDue() {
  const due = q.all("SELECT id FROM orders WHERE status = 'delivered' AND auto_release_at IS NOT NULL AND auto_release_at <= ?", now());
  let n = 0;
  for (const { id } of due) { try { releaseToSeller(id, 'system:auto-release'); n++; } catch (e) { if (e.status !== 409) throw e; } }
  return n;
}

/**
 * Refund the buyer (cancel after payment, or dispute resolved for the buyer).
 * The refund row is created inside the same transaction as the status change (UNIQUE per order, so no
 * double refunds); the provider call happens afterwards and its outcome is recorded on that row.
 */
async function refundOrder(orderId, { actor, reason, relist = false }) {
  const order = tx(() => {
    transition(orderId, 'refunded', { actor, note: reason, set: { refunded_cents: q.get('SELECT total_cents t FROM orders WHERE id = ?', orderId).t } });
    const o = q.get('SELECT * FROM orders WHERE id = ?', orderId);
    q.run("INSERT INTO refunds(order_id, amount_cents, reason, status, created_at) VALUES(?,?,?, 'pending', ?)", o.id, o.total_cents, reason || null, now());
    q.run(`UPDATE listings SET status = ?, reserved_until = NULL WHERE id IN (SELECT listing_id FROM order_items WHERE order_id = ?)`, relist ? 'active' : 'archived', o.id);
    notify(o.buyer_id, `order:${o.id}:refunded`, 'Order refunded', `Order #${o.id} was refunded.`, `/orders/${o.id}`);
    notify(o.seller_id, `order:${o.id}:refunded-seller`, 'Order refunded', `Order #${o.id} was refunded to the buyer.`, '/dashboard/orders');
    return o;
  });
  const payment = q.get("SELECT * FROM payments WHERE checkout_id = ? AND status IN ('succeeded','refunded') ORDER BY id DESC LIMIT 1", order.checkout_id);
  const provider = payment && getProviderByName(payment.provider);
  try {
    if (!provider) throw new Error('payment provider not configured');
    const r = await provider.refund(payment, order.total_cents);
    q.run("UPDATE refunds SET status = 'succeeded', provider_ref = ? WHERE order_id = ?", r.providerRef, order.id);
  } catch (e) {
    // The order is already marked refunded; the refund row stays 'failed' for an admin to retry in the provider dashboard.
    q.run("UPDATE refunds SET status = 'failed' WHERE order_id = ?", order.id);
  }
  return q.get('SELECT * FROM orders WHERE id = ?', orderId);
}

module.exports = { markDelivered, releaseToSeller, buyerConfirm, autoReleaseDue, refundOrder };
