'use strict';
// PricingEngine: the single source of truth for every money calculation. The browser never
// supplies prices; checkout, dashboards and the profit calculator all call into this module.
// Everything is integer cents; rounding is "half up" and applied once per line so the parts always
// sum to the whole (important for reconciling against the payment provider).

const NA = new Set(['US', 'CA', 'MX']);
const isLocalShip = (country) => NA.has(String(country || '').toUpperCase());
const pct = (cents, bps) => Math.round((cents * bps) / 10000);

class PricingEngine {
  /** @param {object} s settings: fee_bps_standard, fee_bps_pro, processing_bps, processing_fixed_cents, shipping_margin_bps */
  constructor(settings, taxRateBps = 0) { this.s = settings; this.taxRateBps = taxRateBps; }

  feeBpsFor(plan) { return plan === 'pro' ? this.s.fee_bps_pro : this.s.fee_bps_standard; }

  /**
   * Price one seller's order.
   *   buyerTotal       = subtotal + shipping + tax
   *   platformFee      = subtotal * feeBps            (transaction fee, item price only)
   *   processingFee    = buyerTotal * rate + fixed    (estimated card cost, passed through to seller)
   *   sellerPayout     = subtotal + shipping - platformFee - processingFee   (tax is held for remittance, not paid out)
   *   platformRevenue  = platformFee (+ shipping margin when an integrated label is bought; see labelCharge)
   */
  priceOrder({ subtotalCents, shippingCents, sellerPlan }) {
    const feeBps = this.feeBpsFor(sellerPlan);
    const taxCents = pct(subtotalCents + shippingCents, this.taxRateBps);
    const totalCents = subtotalCents + shippingCents + taxCents;
    const platformFeeCents = pct(subtotalCents, feeBps);
    const processingFeeCents = pct(totalCents, this.s.processing_bps) + this.s.processing_fixed_cents;
    const sellerPayoutCents = subtotalCents + shippingCents - platformFeeCents - processingFeeCents;
    return { feeBps, taxCents, totalCents, platformFeeCents, processingFeeCents, sellerPayoutCents,
      platformRevenueCents: platformFeeCents };
  }

  /** Integrated shipping labels are re-sold with a markup; the markup is platform revenue. */
  labelCharge(carrierCostCents) {
    const marginCents = pct(carrierCostCents, this.s.shipping_margin_bps);
    return { chargeCents: carrierCostCents + marginCents, marginCents };
  }

  /**
   * Profit calculator for sellers (used live in the listing editor).
   * Solves  profit = margin * price  for price, where
   *   profit = price - fee*price - processing(price + shippingCharged) - cost - labelCost + shippingCharged
   * Tax is ignored (it is collected on top and not part of seller revenue).
   * Returns null when the margin is unachievable (fees + margin >= 100%).
   */
  recommendPrice({ costCents, labelCostCents = 0, shippingChargedCents = 0, marginPct, plan = 'standard' }) {
    const f = this.feeBpsFor(plan) / 10000, p = this.s.processing_bps / 10000, m = marginPct / 100;
    const denom = 1 - f - p - m;
    if (!(denom > 0.01)) return null;
    const fixed = this.s.processing_fixed_cents;
    const numer = costCents + labelCostCents + fixed + p * shippingChargedCents - shippingChargedCents;
    const price = Math.max(100, Math.ceil(numer / denom / 100) * 100 - 1); // charm price, e.g. $38.99 -> $39 floor -1c
    const o = this.priceOrder({ subtotalCents: price, shippingCents: shippingChargedCents, sellerPlan: plan });
    const profitCents = o.sellerPayoutCents - costCents - labelCostCents;
    return { priceCents: price, platformFeeCents: o.platformFeeCents, processingFeeCents: o.processingFeeCents,
      sellerPayoutCents: o.sellerPayoutCents, profitCents, marginPct: price ? (profitCents / price) * 100 : 0 };
  }
}

/** The one place the "free listing / 0% commission" wording lives. Stripe's processing fee is the seller's own cost and is never described as free. */
const FREE_LISTING = 'Listing on Grailedside is free and Grailedside takes 0% commission. Buyers pay you directly through your own Stripe checkout link; Stripe may charge you its own processing fees.';

module.exports = { PricingEngine, isLocalShip, pct, FREE_LISTING };
