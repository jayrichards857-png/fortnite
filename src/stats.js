'use strict';
// Seller metrics. Every number is an aggregate over real orders / order_items / listings.
//
// Definitions (shown in the UI as well):
//   "counted" orders  = paid, shipped, delivered, released or disputed (money has been captured, not refunded)
//   Gross sales       = item subtotals of counted orders              (sales volume, before any fee)
//   Fees              = platform fee + estimated processing fee
//   Net proceeds      = seller payout of counted orders               (revenue to the seller after fees)
//   Profit (estimate) = net proceeds - acquisition cost, ONLY over orders where every item has a recorded cost
const { q } = require('./db');
const COUNTED = "('paid','shipped','delivered','released','disputed')";

async function overview(sellerId) {
  const o = await q.get(`SELECT COUNT(*) FILTER (WHERE status IN ${COUNTED}) AS orders,
      COUNT(*) FILTER (WHERE status = 'released') AS completed,
      COALESCE(SUM(subtotal_cents) FILTER (WHERE status IN ${COUNTED}), 0) AS gross,
      COALESCE(SUM(shipping_cents) FILTER (WHERE status IN ${COUNTED}), 0) AS shipping,
      COALESCE(SUM(platform_fee_cents) FILTER (WHERE status IN ${COUNTED}), 0) AS platform_fees,
      COALESCE(SUM(processing_fee_cents) FILTER (WHERE status IN ${COUNTED}), 0) AS processing_fees,
      COALESCE(SUM(seller_payout_cents) FILTER (WHERE status IN ${COUNTED}), 0) AS net,
      COALESCE(SUM(refunded_cents) FILTER (WHERE status = 'refunded'), 0) AS refunds,
      COUNT(*) FILTER (WHERE status = 'refunded') AS refund_count
    FROM orders WHERE seller_id = ? AND payment_mode = 'platform'`, sellerId);
  const l = await q.get(`SELECT COUNT(*) FILTER (WHERE status='active') active, COUNT(*) FILTER (WHERE status='draft') drafts, COUNT(*) FILTER (WHERE status='sold') sold FROM listings WHERE seller_id = ?`, sellerId);
  const profit = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(o.seller_payout_cents - c.cost), 0) profit FROM orders o
      JOIN (SELECT order_id, SUM(cost_cents) cost, COUNT(*) items, COUNT(cost_cents) costed FROM order_items GROUP BY order_id) c ON c.order_id = o.id
      WHERE o.seller_id = ? AND o.payment_mode = 'platform' AND o.status IN ${COUNTED} AND c.items = c.costed`, sellerId);
  const balance = await wallet(sellerId);
  return { ...o, listings: l, profit: { orders: profit.n, cents: profit.profit, eligibleOf: o.orders }, balance, direct: await directOverview(sellerId) };
}

/**
 * Direct-checkout sales. Money went straight to the seller's own payment account, so Grailedside knows only what the seller
 * confirmed: item price, shipping charged and the seller's recorded cost. No fees, payouts or "net" are claimed here
 * (the seller's payment provider bills its own processing fees).
 */
async function directOverview(sellerId) {
  const d = await q.get(`SELECT COUNT(*) FILTER (WHERE status = 'pending_payment') awaiting,
      COUNT(*) FILTER (WHERE status IN ('paid','shipped','delivered')) confirmed,
      COUNT(*) FILTER (WHERE status = 'paid') to_ship,
      COUNT(*) FILTER (WHERE status = 'delivered') delivered,
      COUNT(*) FILTER (WHERE status = 'refunded') refunded,
      COALESCE(SUM(subtotal_cents) FILTER (WHERE status IN ('paid','shipped','delivered')), 0) gross,
      COALESCE(SUM(shipping_cents) FILTER (WHERE status IN ('paid','shipped','delivered') AND shipping_payer = 'buyer'), 0) shipping_collected,
      COALESCE(SUM(refunded_cents) FILTER (WHERE status = 'refunded'), 0) refunded_cents
    FROM orders WHERE seller_id = ? AND payment_mode = 'external'`, sellerId);
  const m = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(oi.price_cents - oi.cost_cents), 0) margin FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.seller_id = ? AND o.payment_mode = 'external' AND o.status IN ('paid','shipped','delivered') AND oi.cost_cents IS NOT NULL`, sellerId);
  return { ...d, margin: m };
}

async function wallet(userId) {
  const available = (await q.get("SELECT COALESCE(SUM(amount_cents),0) n FROM ledger WHERE user_id = ?", userId)).n;
  const pending = (await q.get(`SELECT COALESCE(SUM(seller_payout_cents),0) n FROM orders WHERE seller_id = ? AND payment_mode = 'platform' AND status IN ('paid','shipped','delivered','disputed')`, userId)).n;
  return { availableCents: available, escrowCents: pending };
}

async function salesByDay(sellerId, days = 30) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await q.all(`SELECT to_char(to_timestamp(paid_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') d, COUNT(*) orders, SUM(subtotal_cents) gross FROM orders
    WHERE seller_id = ? AND paid_at >= ? AND status IN ${COUNTED} GROUP BY d ORDER BY d`, sellerId, since);
  const map = Object.fromEntries(rows.map((r) => [r.d, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, orders: map[d]?.orders || 0, gross: map[d]?.gross || 0 });
  }
  return out;
}

async function analytics(sellerId) {
  const ov = await overview(sellerId);
  const items = (await q.get(`SELECT COUNT(*) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.seller_id = ? AND o.status IN ${COUNTED}`, sellerId)).n;
  const all = await q.get(`SELECT COUNT(*) n, COALESCE(SUM(subtotal_cents), 0) gross FROM orders WHERE seller_id = ? AND status IN ${COUNTED}`, sellerId);
  const aging = await q.get(`SELECT
      COUNT(*) FILTER (WHERE age < 7) d7, COUNT(*) FILTER (WHERE age >= 7 AND age < 30) d30,
      COUNT(*) FILTER (WHERE age >= 30 AND age < 90) d90, COUNT(*) FILTER (WHERE age >= 90) d90p,
      COALESCE(SUM(price_cents),0) value
    FROM (SELECT price_cents, (CAST(EXTRACT(EPOCH FROM now()) AS BIGINT) - published_at) / 86400 AS age FROM listings WHERE seller_id = ? AND status = 'active' AND published_at IS NOT NULL)`, sellerId);
  const itemProfit = await q.all(`SELECT oi.listing_id, oi.title, oi.price_cents, oi.cost_cents, o.id order_id, o.paid_at
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.seller_id = ? AND o.status IN ${COUNTED} AND oi.cost_cents IS NOT NULL
      ORDER BY o.paid_at DESC NULLS LAST LIMIT 25`, sellerId);
  return { overview: ov, days: await salesByDay(sellerId), itemsSold: items, orders: all.n, gross: all.gross, aov: all.n ? Math.round(all.gross / all.n) : 0, aging, itemProfit };
}

async function monthlyTax(sellerId) {
  return await q.all(`SELECT to_char(to_timestamp(released_at) AT TIME ZONE 'UTC', 'YYYY-MM') AS month, COUNT(*) orders,
      SUM(subtotal_cents) gross, SUM(shipping_cents) shipping, SUM(tax_cents) tax,
      SUM(platform_fee_cents + processing_fee_cents) fees, SUM(seller_payout_cents) net
    FROM orders WHERE seller_id = ? AND status = 'released' GROUP BY month ORDER BY month DESC`, sellerId);
}

module.exports = { overview, directOverview, wallet, analytics, salesByDay, monthlyTax, COUNTED };
