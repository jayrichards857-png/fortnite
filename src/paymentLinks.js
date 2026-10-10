'use strict';
// Seller payment links. PairPlug only ever sends a buyer to a link that (a) was validated when the seller saved it and
// (b) is re-validated against the allowlist at redirect time. Nothing in a request can choose the destination.
const config = require('./config');
const { HttpError } = require('./util');

/** Normalise + validate a payment link. Throws HttpError(422) with a user-readable message. Returns the clean URL string. */
function validatePaymentUrl(raw, hosts = config.paymentLinkHosts) {
  const text = String(raw ?? '').trim();
  const bad = (m) => new HttpError(422, 'Please fix the highlighted fields.', { payment_url: m });
  if (!text) throw bad('Enter a payment link.');
  if (text.length > 500) throw bad('That link is too long.');
  let u; try { u = new URL(text); } catch { throw bad('That is not a valid URL.'); }
  if (u.protocol !== 'https:') throw bad('Payment links must start with https://');
  if (u.username || u.password) throw bad('Payment links must not contain a username or password.');
  if (u.port && u.port !== '443') throw bad('Payment links must use the standard HTTPS port.');
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) throw bad(`Only links from ${hosts.join(', ')} are accepted in this beta.`);
  if (u.pathname.length < 3) throw bad('That looks like a homepage, not a payment link. Paste the full link from your Stripe dashboard.');
  u.hash = ''; u.port = '';
  return u.toString();
}

/** The URL a buyer is sent to: the stored link + our reference so the seller can match the payment in their dashboard. */
function buyerUrl(storedUrl, orderId) {
  const clean = validatePaymentUrl(storedUrl);              // re-validate: allowlist may have changed since it was saved
  const u = new URL(clean);
  u.searchParams.set('client_reference_id', `PP-${Number(orderId)}`); // Stripe: alphanumerics, dashes and underscores only
  return u.toString();
}

/** Which link serves this listing? Per-listing link wins; the seller default is only usable if they attested it takes any amount. */
function resolveLink(listing, seller) {
  if (listing.payment_url) return { url: listing.payment_url, source: 'listing' };
  if (seller.checkout_url && seller.checkout_url_any_amount) return { url: seller.checkout_url, source: 'seller_default' };
  return null;
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
// Where a seller can buy a label themselves. PairPlug does NOT buy labels or integrate with these services.
const LABEL_PROVIDERS = [
  { name: 'Pirate Ship (US)', url: 'https://www.pirateship.com/' },
  { name: 'USPS Click-N-Ship (US)', url: 'https://cns.usps.com/' },
  { name: 'Canada Post (CA)', url: 'https://www.canadapost-postescanada.ca/' },
];

module.exports = { validatePaymentUrl, buyerUrl, resolveLink, trackingUrl, LABEL_PROVIDERS };
