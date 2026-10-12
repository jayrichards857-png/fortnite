'use strict';
// The beta rules for payment links and the matching buyer warning, worded in ONE place (listing form, listing page, buy page, order page, help, policies).
// Honest limits: PairPlug checks the link's ADDRESS (an approved Stripe host and a single Payment Link id). It cannot see or verify the amount Stripe will charge.
// The seller's confirmation is the seller's statement, not independent verification.
const config = require('./config');
const { esc, money } = require('./util');

const VERSION = '2026-10-13';
const HOSTS_TEXT = 'buy.stripe.com';

const SELLER_TITLE = 'Stripe checkout links only';
const SELLER_NOTICE = 'For the PairPlug beta, listings must use an eligible Stripe-hosted checkout link. The amount charged must match the listing price plus the disclosed shipping cost. Incorrect, misleading, or unrelated payment links may result in listing removal, selling restrictions, or suspension for up to 5 days, depending on the circumstances.';
const SELLER_ACK = 'I confirm that this Stripe link charges exactly the item price plus the shipping shown here. I understand this is my own statement: PairPlug does not verify the amount charged at Stripe.';
const SELLER_ACK_FOOT = 'PairPlug checks that the address is an approved Stripe link, but it cannot see what Stripe will charge, and a Stripe-hosted link is not automatically correct or safe. Changing the price, shipping or link cancels this confirmation until you confirm again.';

const BUYER_TITLE = 'Before you pay';
const BUYER_TEXT = 'Please check that the seller is charging the correct amount for this item, including shipping. The total shown on PairPlug should match the amount shown at Stripe checkout before you pay. If the amounts differ, do not complete the payment. Return to PairPlug and contact support.';
const BUYER_FOOT = 'PairPlug has not verified the amount shown at Stripe checkout and cannot see it.';

const maxSuspensionDays = () => config.enforcement.maxSuspensionDays;
/** Seller-facing notice with the configured suspension ceiling spelled out (the default text says 5). */
const sellerNotice = () => SELLER_NOTICE.replace('up to 5 days', `up to ${maxSuspensionDays()} day${maxSuspensionDays() === 1 ? '' : 's'}`);

/** Visible "Before you pay" box with the expected total. `t` = X.terms(listing) or an order's figures {itemCents, shippingCents, totalCents}. */
function buyerWarning(t, { reportHref = '/support#payment-mismatch', id = 'byp' } = {}) {
  return `<section class="byp" role="note" aria-labelledby="${id}-h"><h3 id="${id}-h">${esc(BUYER_TITLE)}</h3>
    <p style="margin:0 0 8px">${esc(BUYER_TEXT)}</p>
    <dl class="byp-total" aria-label="Expected total"><div><dt>Item price</dt><dd>${money(t.itemCents)}</dd></div><div><dt>Shipping</dt><dd>${t.shippingCents ? money(t.shippingCents) : 'Free'}</dd></div><div class="tot"><dt>Expected total</dt><dd>${money(t.totalCents)}</dd></div></dl>
    <p class="small muted" style="margin:6px 0 0">${esc(BUYER_FOOT)} <a href="${esc(reportHref)}">Report a payment mismatch</a></p></section>`;
}
module.exports = { VERSION, HOSTS_TEXT, SELLER_TITLE, SELLER_NOTICE, SELLER_ACK, SELLER_ACK_FOOT, BUYER_TITLE, BUYER_TEXT, BUYER_FOOT, sellerNotice, buyerWarning, maxSuspensionDays };
