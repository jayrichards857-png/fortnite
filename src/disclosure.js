'use strict';
// The one place where the buyer-facing payment disclosure is worded, so checkout, listing, order, help and policy pages cannot drift apart.
// Truth it must keep: money moves through the SELLER's external checkout; Grailedside does not currently hold or directly control it; Grailedside does review reports,
// can contact both sides, restrict the seller's Grailedside account, and report to the payment processor by hand; Grailedside CANNOT freeze, reverse or refund external funds
// and cannot promise any outcome. Change the wording here (and docs/LEGAL_REVIEW.md) if the payment model ever changes.
const { esc } = require('./util');

/** Checkbox label at "Buy now" -> reserve. */
const ACK = "I understand that payment is processed through the seller's external checkout. Grailedside does not currently hold or directly control those funds. If an issue arises, I can contact Grailedside for assistance: Grailedside may review the order, contact the seller, and report the problem to the payment processor with the evidence it has, to try to help get it resolved. Grailedside cannot promise a refund or recovery.";
/** One or two sentences for listing pages and cards. */
const SHORT = "You pay the seller through their external checkout. Grailedside does not currently hold or directly control those funds. If something goes wrong you can contact Grailedside: we may review the order, contact the seller and report the problem to the payment processor, but we cannot promise a refund or recovery.";

const CAN = [
  'review your report, the order record, tracking details, messages and any photos or screenshots you send',
  'contact you and the seller to gather information, and record the decision and the reasons',
  "restrict a seller's Grailedside account, stop them taking new orders, pause their listings, or suspend them",
  'report suspected payment fraud to the seller\'s payment processor, with the evidence we hold (prepared and sent by hand by Grailedside staff)',
];
const CANNOT = [
  "freeze, hold, reverse or refund money in the seller's Stripe, PayPal or other payment account (restricting a seller on Grailedside is not a financial hold)",
  'force a seller to refund you, or promise that a refund, recovery or any particular outcome will happen',
  'promise a response time, or replace your right to contact your payment provider or card issuer',
];
/** "What Grailedside can and cannot do" as HTML. `compact` drops the heading and the closing advice. */
function canCannot({ compact = false } = {}) {
  const li = (a) => a.map((t) => `<li>${esc(t)}</li>`).join('');
  return `<div class="can-cannot">${compact ? '' : '<h3>What Grailedside can and cannot do</h3>'}<p class="small" style="margin:0 0 4px"><strong>If something goes wrong, Grailedside can:</strong></p><ul class="plain small">${li(CAN)}</ul>
    <p class="small" style="margin:6px 0 4px"><strong>Grailedside cannot:</strong></p><ul class="plain small">${li(CANNOT)}</ul>
    ${compact ? '' : '<p class="small muted" style="margin:6px 0 0">You may also need to contact the seller and your payment provider or card issuer yourself about refunds, disputes or chargebacks, and keep your receipt. Start with <a href="/support">Help &amp; reporting</a>.</p>'}</div>`;
}
module.exports = { ACK, SHORT, CAN, CANNOT, canCannot };
