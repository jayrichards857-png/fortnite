'use strict';
// Order state machine. Every status change in the system goes through `transition()`.
//
//   pending_payment -> paid -> shipped -> delivered -> released          (happy path; funds held in escrow until `released`)
//   paid|shipped|delivered -> disputed -> refunded | released            (dispute path)
//   paid -> refunded                                                     (seller/admin cancels after payment)
//   pending_payment -> cancelled                                         (payment failed / reservation expired)
//
// Why a table instead of scattered if-statements: it is the one place that decides which money
// movements are legal, so a buggy endpoint can never e.g. release funds on an unpaid order.
const { q, now } = require('./db');

const TRANSITIONS = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['shipped', 'refunded', 'disputed'],
  shipped: ['delivered', 'disputed', 'refunded'],   // shipped/delivered -> refunded: only the direct-checkout seller route uses these
  delivered: ['released', 'disputed', 'refunded'],
  disputed: ['refunded', 'released'],
  released: [], refunded: [], cancelled: [],
};
const TERMINAL = new Set(['released', 'refunded', 'cancelled']);
// Statuses in which the buyer has paid and money is (or was) held
const PAID_STATES = ['paid', 'shipped', 'delivered', 'released', 'disputed'];

class TransitionError extends Error {
  constructor(from, to) { super(`Illegal order transition ${from} -> ${to}`); this.status = 409; }
}
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/**
 * Atomically move an order. The order row is locked (FOR UPDATE) and the UPDATE is conditional on the status that was read,
 * so two concurrent actors (e.g. buyer confirm + auto-release job) can't both win. Must be called inside tx().
 */
async function transition(orderId, to, { actor, note = null, set = {} } = {}) {
  // FOR UPDATE: concurrent transitions of one order queue up here and each sees the previous one's committed status.
  const order = await q.get('SELECT status FROM orders WHERE id = ? FOR UPDATE', orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (!canTransition(order.status, to)) throw new TransitionError(order.status, to);
  const cols = Object.keys(set);
  const sql = `UPDATE orders SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND status = ?`;
  const res = await q.run(sql, to, now(), ...cols.map((c) => set[c]), orderId, order.status);
  if (res.changes !== 1) throw new TransitionError(order.status, to);
  await q.run('INSERT INTO order_events(order_id, from_status, to_status, actor, note, created_at) VALUES(?,?,?,?,?,?)',
    orderId, order.status, to, actor || 'system', note, now());
  return order.status;
}

module.exports = { TRANSITIONS, TERMINAL, PAID_STATES, canTransition, transition, TransitionError };
