'use strict';
// All runtime configuration comes from environment variables (see .env.example / README).
const path = require('node:path');
const os = require('node:os');
const env = process.env;
const root = path.resolve(__dirname, '..');

// ---- Environment parsing is FAIL-CLOSED. systemd EnvironmentFile / docker env files do not support trailing "# comments", so a
// value like `invite   # note` arrives verbatim. We never let a malformed value silently widen access: it is trimmed, unknown
// values fall back to the *restrictive* setting, and every problem is reported (production refuses to start; see server.js).
const envProblems = [];
const val = (k) => String(env[k] ?? '').trim();
for (const k of ['SIGNUPS', 'SUPPORT_EMAIL', 'LEGAL_ENTITY', 'LEGAL_ADDRESS', 'PUBLIC_RELEASE_DATE', 'EMAIL_PROVIDER', 'EMAIL_FROM', 'NODE_ENV', 'PORT', 'HOST', 'PUBLIC_URL', 'CHECKOUT_MODE', 'TRUST_PROXY', 'SELLER_ONBOARDING', 'SELLER_ALLOWED_EMAILS', 'PAYMENT_LINK_HOSTS', 'MAX_SUSPENSION_DAYS', 'SHIPPO_API_KEY', 'PAIRPLUG_DB', 'PAIRPLUG_UPLOADS', 'PAYMENTS_MODE', 'RATE_LIMIT_SCALE'])
  if (/\s#/.test(String(env[k] ?? ''))) envProblems.push(`${k} contains an inline "# comment"; env files don't support those — put comments on their own line`);
if (val('SHIPPO_API_KEY') && !/^shippo_(test|live)_\S+$/.test(val('SHIPPO_API_KEY'))) envProblems.push('SHIPPO_API_KEY must start with shippo_test_ (live keys are refused in this release)');
const onVercel = Boolean(env.VERCEL);
const isProd = /^production\b/.test(val('NODE_ENV'));   // 'production # note' still counts as production (and is reported above)
const onboardingRaw = val('SELLER_ONBOARDING').toLowerCase();
if (onboardingRaw && !['open', 'invite'].includes(onboardingRaw)) envProblems.push('SELLER_ONBOARDING must be exactly "open" or "invite"');
const signupsRaw = val('SIGNUPS').toLowerCase();
if (signupsRaw && !['open', 'closed'].includes(signupsRaw)) envProblems.push('SIGNUPS must be exactly "open" or "closed"');
const OFFICIAL_SUPPORT_EMAIL = 'grailedside@gmail.com';
const SUPPORT_EMAIL_OK = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(val('SUPPORT_EMAIL') || '');
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
  // PostgreSQL (the application database). DATABASE_URL is required; there is no file fallback any more.
  db: {
    url: val('DATABASE_URL'),
    // Serverless: each instance keeps only a few connections (use the provider's pooled connection string; see docs/VERCEL.md).
    poolMax: Number(env.PGPOOL_MAX || (onVercel ? 3 : 10)),
    // Direct (non-pooled) connection used ONLY by `npm run migrate`: session-level locks do not survive transaction poolers.
    urlDirect: val('DATABASE_URL_UNPOOLED'),
    // On Vercel the schema is never changed by a web request: run `npm run migrate` as a deliberate step; the app then only verifies the version.
    autoMigrate: !onVercel || val('MIGRATE_ON_START') === '1',
    connectTimeoutMs: Number(env.PG_CONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMs: Number(env.PG_IDLE_TIMEOUT_MS || (onVercel ? 10000 : 30000)),
    statementTimeoutMs: Number(env.PG_STATEMENT_TIMEOUT_MS || 20000),
    // DATABASE_SSL=1 turns on TLS with certificate verification (managed databases); DATABASE_SSL_CA=/path/ca.pem pins a CA.
    ssl: ['1', 'true', 'require'].includes(val('DATABASE_SSL').toLowerCase())
      ? { rejectUnauthorized: true, ...(val('DATABASE_SSL_CA') ? { ca: require('node:fs').readFileSync(val('DATABASE_SSL_CA'), 'utf8') } : {}) }
      : undefined,
  },
  // LEGACY: the old SQLite file. Only the one-off importer (scripts/sqlite-to-pg.js) reads it, never the running app.
  dbFile: env.PAIRPLUG_DB || path.join(root, 'data', 'pairplug.db'),
  // Vercel's /var/task is read-only and its other storage is ephemeral per instance: product/avatar/banner uploads CANNOT be stored durably
  // there. They are disabled (see images.saveUpload) until durable object storage is wired in; this path is then only a never-created placeholder
  // so nothing tries to mkdir under /var/task. Customer review photos are unaffected: they live in PostgreSQL.
  onVercel,
  // Vercel Web Analytics (cookie-less page-view counts). Only rendered on Vercel deployments; WEB_ANALYTICS=off is a kill switch.
  webAnalytics: onVercel && String(env.WEB_ANALYTICS || '').trim().toLowerCase() !== 'off',
  // Chat transport. A serverless function cannot hold a WebSocket or an in-memory subscription, so on Vercel the client polls the database-backed
  // sync endpoint every pollMs (messages appear within a few seconds). Elsewhere: WebSocket with long-polling fallback, exactly as before.
  chat: { pollMs: Number(env.CHAT_POLL_MS || (onVercel ? 3000 : 0)) },
  cronSecret: val('CRON_SECRET'),                       // bearer token Vercel Cron (or any scheduler) must send to /api/cron/*
  vercelEnv: val('VERCEL_ENV'),                         // 'production' | 'preview' | 'development' (set by Vercel)
  // Object storage for uploaded images (S3-compatible, private bucket, server-side credentials). All five must be set to enable it.
  storage: { s3: ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].every((k) => val(k))
    ? { endpoint: val('S3_ENDPOINT'), bucket: val('S3_BUCKET'), region: val('S3_REGION') || 'auto', accessKeyId: val('S3_ACCESS_KEY_ID'), secretAccessKey: val('S3_SECRET_ACCESS_KEY'), prefix: val('S3_KEY_PREFIX') } : null },
  uploadDir: env.PAIRPLUG_UPLOADS || (onVercel ? path.join(os.tmpdir(), 'pairplug-uploads-disabled') : path.join(root, 'data', 'uploads')),
  publicUrl: env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`,
  // Platform defaults. Admins can override fees at runtime (settings table).
  defaults: {
    fee_bps_standard: 0, // Grailedside takes 0% commission (listing is free). Enforced in getSettings(); the fee engine stays so historic orders still read correctly.
    fee_bps_pro: 0,
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
  // 'external': the seller is paid directly through THEIR OWN payment link (Stripe Payment Link). Grailedside never holds or
  //             moves buyer money: no escrow, wallet credit, fees or provider refunds for new orders.
  // 'platform': the original cart + Grailedside-held escrow flow (kept for history/tests; needs a payment provider).
  checkoutMode: modeRaw === 'platform' ? 'platform' : 'external',
  // Only HTTPS links on these exact hostnames may be saved as a seller checkout link. Extend deliberately, one host at a time.
  paymentLinkHosts: String(env.PAYMENT_LINK_HOSTS || 'buy.stripe.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  // 'open' = anyone can open a store (development only); 'invite' = only through admin-issued invitations (sellers come from approved requests, invitations or admin-created accounts; no seller limit).
  // Invitation-only unless a developer/test explicitly opts out. Production never honours 'open' (the start-up guard refuses it outright).
  sellerOnboarding: onboardingRaw === 'open' && !isProd ? 'open' : 'invite',
  sellerOnboardingRequested: onboardingRaw,
  // Public BUYER account creation (never grants seller/admin). 'closed' hides it and shows "Coming soon"; default is open.
  signups: signupsRaw === 'closed' ? 'closed' : signupsRaw === 'open' || signupsRaw === '' ? 'open' : 'closed',   // buyer sign-up is open by default (creates buyer accounts only); 'closed' hides it
  // Optional business identity shown on the legal pages. Never invented: empty means the pages say these details are not published yet.
  legalEntity: val('LEGAL_ENTITY').slice(0, 120), legalAddress: val('LEGAL_ADDRESS').slice(0, 240),
  releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(releaseRaw) ? releaseRaw : '',
  inviteTtlHours: 168,
  // Official contact address for reports, appeals and support. SUPPORT_EMAIL may override it; an override is flagged at startup. It is a mailto: link only:
  // email does not create cases or tickets, and no response time is promised.
  supportEmail: SUPPORT_EMAIL_OK ? val('SUPPORT_EMAIL') : OFFICIAL_SUPPORT_EMAIL,
  supportEmailOverridden: SUPPORT_EMAIL_OK && val('SUPPORT_EMAIL').toLowerCase() !== OFFICIAL_SUPPORT_EMAIL,
  officialSupportEmail: OFFICIAL_SUPPORT_EMAIL,
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
  // Set ONLY by scripts/shipping-sandbox.js (isolated throwaway database full of clearly-marked test data). Ignored in production.
  sandbox: env.PAIRPLUG_SANDBOX === '1' && !isProd,
  // Enforcement for payment-link violations. Documented in docs/PAYMENT_LINK_POLICY.md. A temporary selling suspension can never exceed this many days (default 5, hard ceiling 30);
  // longer measures are the existing restrict/ban actions. Nothing is ever applied automatically.
  enforcement: { maxSuspensionDays: /^\d+$/.test(val('MAX_SUSPENSION_DAYS')) ? Math.min(30, Math.max(1, Number(val('MAX_SUSPENSION_DAYS')))) : 5 },
  carrierWebhookSecret: env.CARRIER_WEBHOOK_SECRET || '',
  sharedRateLimit: onVercel || val('RATE_LIMIT_STORE').toLowerCase() === 'db',   // counters in PostgreSQL shared by all instances (see auth.rateLimit)
  rateLimitScale: Number(env.RATE_LIMIT_SCALE || 1), // tests raise this; production keeps 1
  naCountries: ['US', 'CA', 'MX'], // North America
  conditions: { new_with_tags: 'New with tags', like_new: 'Like new', good: 'Good', fair: 'Fair' },
  categories: [
    ['clothing', 'Clothing'], ['outerwear', 'Outerwear'], ['denim', 'Denim'],
    ['sneakers', 'Sneakers'], ['shoes', 'Shoes'], ['accessories', 'Accessories'],
    ['bags', 'Bags'], ['other', 'Other'],
  ],
  carriers: ['USPS', 'UPS', 'FedEx', 'Canada Post', 'DHL', 'Other'],
  limits: { imageBytes: (onVercel ? 4 : 5) * 1024 * 1024,   // Vercel rejects request bodies over 4.5 MB before our code runs
     maxImages: 8, csvRows: 1000 },
};
