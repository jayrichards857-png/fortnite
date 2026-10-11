'use strict';
// All runtime configuration comes from environment variables (see .env.example / README).
const path = require('node:path');
const env = process.env;
const root = path.resolve(__dirname, '..');

// ---- Environment parsing is FAIL-CLOSED. systemd EnvironmentFile / docker env files do not support trailing "# comments", so a
// value like `invite   # note` arrives verbatim. We never let a malformed value silently widen access: it is trimmed, unknown
// values fall back to the *restrictive* setting, and every problem is reported (production refuses to start; see server.js).
const envProblems = [];
const val = (k) => String(env[k] ?? '').trim();
for (const k of ['SIGNUPS', 'SUPPORT_EMAIL', 'PUBLIC_RELEASE_DATE', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'NODE_ENV', 'PORT', 'HOST', 'PUBLIC_URL', 'CHECKOUT_MODE', 'TRUST_PROXY', 'SELLER_ONBOARDING', 'SELLER_ALLOWED_EMAILS', 'PAYMENT_LINK_HOSTS', 'SHIPPO_API_KEY', 'PAIRPLUG_DB', 'PAIRPLUG_UPLOADS', 'PAYMENTS_MODE', 'RATE_LIMIT_SCALE'])
  if (/\s#/.test(String(env[k] ?? ''))) envProblems.push(`${k} contains an inline "# comment"; env files don't support those — put comments on their own line`);
if (val('SHIPPO_API_KEY') && !/^shippo_(test|live)_\S+$/.test(val('SHIPPO_API_KEY'))) envProblems.push('SHIPPO_API_KEY must start with shippo_test_ (live keys are refused in this release)');
const isProd = /^production\b/.test(val('NODE_ENV'));   // 'production # note' still counts as production (and is reported above)
const onboardingRaw = val('SELLER_ONBOARDING').toLowerCase();
if (onboardingRaw && !['open', 'invite'].includes(onboardingRaw)) envProblems.push('SELLER_ONBOARDING must be exactly "open" or "invite"');
const signupsRaw = val('SIGNUPS').toLowerCase();
if (signupsRaw && !['open', 'closed'].includes(signupsRaw)) envProblems.push('SIGNUPS must be exactly "open" or "closed"');
const releaseRaw = val('PUBLIC_RELEASE_DATE');
if (releaseRaw && !(/^\d{4}-\d{2}-\d{2}$/.test(releaseRaw) && !Number.isNaN(Date.parse(releaseRaw + 'T00:00:00Z')))) envProblems.push('PUBLIC_RELEASE_DATE must be a valid YYYY-MM-DD date');
const emailProviderRaw = val('EMAIL_PROVIDER').toLowerCase();
if (emailProviderRaw && !['none', 'resend'].includes(emailProviderRaw)) envProblems.push('EMAIL_PROVIDER must be "none" or "resend"');
const modeRaw = val('CHECKOUT_MODE').toLowerCase();
if (modeRaw && !['external', 'platform'].includes(modeRaw)) envProblems.push('CHECKOUT_MODE must be exactly "external" or "platform"');

module.exports = {
  root,
  port: Number(env.PORT || 3000),
  isProd,
  envProblems,
  // Production listens on loopback only (the reverse proxy is the public entry point). Set HOST=0.0.0.0 deliberately if needed.
  host: val('HOST') || (isProd ? '127.0.0.1' : '0.0.0.0'),
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
  checkoutMode: modeRaw === 'platform' ? 'platform' : 'external',
  // Only HTTPS links on these exact hostnames may be saved as a seller checkout link. Extend deliberately, one host at a time.
  paymentLinkHosts: String(env.PAYMENT_LINK_HOSTS || 'buy.stripe.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  // 'open' = anyone can open a store (development only); 'invite' = only through admin-issued invitations (private beta, max seller cap).
  // Invitation-only unless a developer/test explicitly opts out. Production never honours 'open' (the start-up guard refuses it outright).
  sellerOnboarding: onboardingRaw === 'open' && !isProd ? 'open' : 'invite',
  sellerOnboardingRequested: onboardingRaw,
  // Public BUYER account creation (never grants seller/admin). 'closed' hides it and shows "Coming soon"; default is open.
  signups: signupsRaw === 'closed' ? 'closed' : signupsRaw === 'open' || signupsRaw === '' ? 'open' : 'closed',   // buyer sign-up is open by default (creates buyer accounts only); 'closed' hides it
  releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(releaseRaw) ? releaseRaw : '',
  inviteTtlHours: 168,
  supportEmail: /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(val('SUPPORT_EMAIL') || '') ? val('SUPPORT_EMAIL') : '',
  // Transactional email. 'none' (default): messages are recorded in the outbox but NOT sent. 'resend': sent via the Resend HTTP API (unverified live).
  email: { provider: emailProviderRaw === 'resend' ? 'resend' : 'none', apiKey: env.EMAIL_API_KEY || '', from: val('EMAIL_FROM') },
  sellerAllowedEmails: [],   // retired: seller access is now by admin-issued invitation (see src/invitations.js)
  trustProxy: /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY) : (env.TRUST_PROXY || 'loopback'),
  taxRateBps: Number(env.TAX_RATE_BPS || 0), // flat sales-tax estimate; 0 = not charged
  // Payments: 'stripe' when STRIPE_SECRET_KEY is set, 'sandbox' when PAYMENTS_MODE=sandbox, otherwise disabled.
  paymentsMode: env.PAYMENTS_MODE || '',
  stripe: { secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '' },
  sandboxSecret: env.SANDBOX_WEBHOOK_SECRET || 'pairplug-sandbox-only-secret',
  // Shipping labels (Shippo). TEST MODE ONLY in this release: only a `shippo_test_…` token enables the feature. A live token is recognised so we can
  // refuse it loudly; real purchasing stays disabled until who pays for postage has been verified (docs/SHIPPING.md). Never logged, never sent to browsers.
  shippo: { apiKey: val('SHIPPO_API_KEY'), mode: /^shippo_test_\S+$/.test(val('SHIPPO_API_KEY')) ? 'test' : /^shippo_live_\S+$/.test(val('SHIPPO_API_KEY')) ? 'live-blocked' : val('SHIPPO_API_KEY') ? 'invalid' : 'off' },
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
