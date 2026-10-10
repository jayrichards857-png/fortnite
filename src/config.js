'use strict';
// All runtime configuration comes from environment variables (see .env.example / README).
const path = require('node:path');
const env = process.env;
const root = path.resolve(__dirname, '..');

module.exports = {
  root,
  port: Number(env.PORT || 3000),
  isProd: env.NODE_ENV === 'production',
  dbFile: env.PAIRPLUG_DB || path.join(root, 'data', 'pairplug.db'),
  uploadDir: env.PAIRPLUG_UPLOADS || path.join(root, 'data', 'uploads'),
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`,
  // Platform defaults. Admins can override fees at runtime (settings table).
  defaults: {
    fee_bps_standard: 1000, // 10% transaction fee
    fee_bps_pro: 600, // 6% for Pro sellers
    processing_bps: 290, // 2.9% estimated card processing, passed through to seller
    processing_fixed_cents: 30, // + $0.30
    shipping_margin_bps: 0, // markup on integrated labels (applies once a label provider is connected)
    auto_release_days: 3, // days after delivery before escrow auto-releases
    reservation_minutes: 15, // how long an item is held during checkout
    pro_monthly_cents: 1500,
    external_hold_minutes: 60, // direct-checkout: how long an item is held while the buyer pays at the seller's checkout
    external_claim_hold_hours: 72, // extended hold once the buyer says they've paid, so the seller can verify
  },
  // --- Private-beta model ---------------------------------------------------------------------------------
  // 'external': the seller is paid directly through THEIR OWN payment link (Stripe Payment Link). PairPlug never holds or
  //             moves buyer money: no escrow, wallet credit, fees or provider refunds for new orders.
  // 'platform': the original cart + PairPlug-held escrow flow (kept for history/tests; needs a payment provider).
  checkoutMode: env.CHECKOUT_MODE === 'platform' ? 'platform' : 'external',
  // Only HTTPS links on these exact hostnames may be saved as a seller checkout link. Extend deliberately, one host at a time.
  paymentLinkHosts: String(env.PAYMENT_LINK_HOSTS || 'buy.stripe.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  // 'open' = anyone can open a store; 'invite' = only emails in SELLER_ALLOWED_EMAILS (private beta).
  sellerOnboarding: env.SELLER_ONBOARDING === 'invite' ? 'invite' : 'open',
  sellerAllowedEmails: String(env.SELLER_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  trustProxy: /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY) : (env.TRUST_PROXY || 'loopback'),
  taxRateBps: Number(env.TAX_RATE_BPS || 0), // flat sales-tax estimate; 0 = not charged
  // Payments: 'stripe' when STRIPE_SECRET_KEY is set, 'sandbox' when PAYMENTS_MODE=sandbox, otherwise disabled.
  paymentsMode: env.PAYMENTS_MODE || '',
  stripe: { secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '' },
  sandboxSecret: env.SANDBOX_WEBHOOK_SECRET || 'pairplug-sandbox-only-secret',
  // Shipping: label purchase is enabled only when a provider key is present.
  shippo: { apiKey: env.SHIPPO_API_KEY || '' },
  carrierWebhookSecret: env.CARRIER_WEBHOOK_SECRET || '',
  rateLimitScale: Number(env.RATE_LIMIT_SCALE || 1), // tests raise this; production keeps 1
  naCountries: ['US', 'CA', 'MX'], // North America
  conditions: { new_with_tags: 'New with tags', like_new: 'Like new', good: 'Good', fair: 'Fair' },
  categories: [
    ['clothing', 'Clothing'], ['outerwear', 'Outerwear'], ['denim', 'Denim'],
    ['sneakers', 'Sneakers'], ['shoes', 'Shoes'], ['accessories', 'Accessories'],
    ['bags', 'Bags'], ['other', 'Other'],
  ],
  carriers: ['USPS', 'UPS', 'FedEx', 'Canada Post', 'DHL', 'Other'],
  limits: { imageBytes: 5 * 1024 * 1024, maxImages: 8, csvRows: 1000 },
};
