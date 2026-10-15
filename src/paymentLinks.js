'use strict';
// Seller payment links. Grailedside only ever sends a buyer to a link that (a) was validated when the seller saved it and
// (b) is re-validated against the allowlist at redirect time. Nothing in a request can choose the destination.
const config = require('./config');
const { HttpError } = require('./util');

/** Exact hosts a listing's payment link may use in the beta: Stripe-hosted Payment Links only. PAYMENT_LINK_HOSTS can only NARROW this list (it can never add another host or provider). */
const APPROVED_HOSTS = ['buy.stripe.com'];
const allowedHosts = () => config.paymentLinkHosts.filter((h) => APPROVED_HOSTS.includes(h));

/**
 * Normalise + validate a payment link. Throws HttpError(422) with a user-readable message. Returns the clean URL string.
 * What this CHECKS (technical): the link text is plain ASCII with no spaces, backslashes or "@"; it starts with exactly https://<approved host>/ (no lookalike or
 * deceptive host, no subdomain tricks, no trailing-dot host, no userinfo, no other port); the path is a single Stripe Payment Link id; in production it is not a
 * Stripe TEST-mode link. Query strings and fragments are dropped. What it can NOT check: that the link belongs to the seller, is live, or charges the right amount.
 */
function validatePaymentUrl(raw, hosts = allowedHosts()) {
  hosts = hosts.filter((h) => APPROVED_HOSTS.includes(String(h).toLowerCase()));      // callers can narrow the list but never widen it
  const text = String(raw ?? '').trim();
  const bad = (m) => new HttpError(422, 'Please fix the highlighted fields.', { payment_url: m });
  if (!text) throw bad('Enter a payment link.');
  if (text.length > 300) throw bad('That link is too long.');
  if (/[^\x21-\x7e]/.test(text) || text.includes('\\') || text.includes('@')) throw bad('That link contains spaces or unusual characters. Paste the Payment Link exactly as Stripe shows it.');
  let u; try { u = new URL(text); } catch { throw bad('That is not a valid URL.'); }
  if (u.protocol !== 'https:') throw bad('Payment links must start with https://');
  if (u.username || u.password) throw bad('Payment links must not contain a username or password.');
  if (u.port && u.port !== '443') throw bad('Payment links must use the standard HTTPS port.');
  const host = u.hostname.toLowerCase();
  const shown = APPROVED_HOSTS.join(', ');
  if (!hosts.includes(host)) throw bad(`Only Stripe-hosted checkout links (${shown}) are accepted in the Grailedside beta. Other payment providers and lookalike addresses are not.`);
  // The text itself must start with exactly "https://<host>/": this also rejects https:buy.stripe.com, https:///buy.stripe.com, a trailing-dot host and similar parser quirks.
  if (!new RegExp(`^https://${host.replace(/\./g, '\\.')}(:443)?/`, 'i').test(text)) throw bad('That does not look like a normal Stripe Payment Link address.');
  const seg = u.pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(seg)) throw bad('That looks like a homepage or the wrong kind of page, not a single Payment Link. Paste the full link from your Stripe dashboard (Payment Links).');
  // Stripe test-mode links show sandbox branding and cannot take real money; a live site must never send a buyer to one.
  if (config.isProd && /^test_/i.test(seg)) throw bad('That is a Stripe TEST-mode link. Create the Payment Link in live mode so buyers are charged for real.');
  return `https://${host}/${seg}`;
}

/** The URL a buyer is sent to: the stored link + our reference so the seller can match the payment in their dashboard. */
function buyerUrl(storedUrl, orderId) {
  const clean = validatePaymentUrl(storedUrl);              // re-validate: allowlist may have changed since it was saved
  const u = new URL(clean);
  u.searchParams.set('client_reference_id', `PP-${Number(orderId)}`); // Stripe: alphanumerics, dashes and underscores only
  return u.toString();
}

/** Which link serves this listing? Only the listing's OWN link, which the seller must have confirmed against the current total. The old seller-wide "any amount" default link can no longer start a checkout. */
function resolveLink(listing) {
  return listing.payment_url ? { url: listing.payment_url, source: 'listing' } : null;
}

// Carrier tracking pages. Tracking numbers are validated to [A-Za-z0-9-] before they are stored; we still encode them.
const TRACK = {
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  'Canada Post': (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  DHL: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`,
};
function trackingUrl(carrier, number) {
  const f = TRACK[carrier]; if (!f || !/^[A-Za-z0-9-]{6,40}$/.test(String(number || ''))) return null;
  return f(encodeURIComponent(number));
}
// Where a seller can buy a label themselves. Grailedside does NOT buy labels or integrate with these services.
const LABEL_PROVIDERS = [
  { name: 'Pirate Ship (US)', url: 'https://www.pirateship.com/' },
  { name: 'USPS Click-N-Ship (US)', url: 'https://cns.usps.com/' },
  { name: 'Canada Post (CA)', url: 'https://www.canadapost-postescanada.ca/' },
];

module.exports = { APPROVED_HOSTS, allowedHosts, validatePaymentUrl, buyerUrl, resolveLink, trackingUrl, LABEL_PROVIDERS };
