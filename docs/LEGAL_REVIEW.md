# Legal pages: what they claim, what's missing, what needs a lawyer

The pages live in `src/legal.js` (`/terms`, `/privacy`, `/payments`, `/rules`, index `/legal`). They were written from the code as it exists (private beta, `CHECKOUT_MODE=external`, direct-to-seller payments). They are **not legal advice** and have **not** been reviewed by a lawyer.

## Business details still missing (owner input)
* Legal entity name and mailing address → set `LEGAL_ENTITY` / `LEGAL_ADDRESS` (shown only when set).
* A public support/privacy email → set `SUPPORT_EMAIL`. Until then the pages point to the in-app Help & reporting forms.
* Governing law, venue, and any dispute-resolution/arbitration terms: deliberately left out ("not set for this beta").
* Response times for support, privacy requests and reports: none promised.
* Retention schedule for accounts, messages, orders, notifications and the audit log: none exists yet (the policy says so).
* Minimum age: the terms say users must be old enough to contract and the service is not for children; no age check exists.

## Product gaps the policy discloses rather than hides
* No self-service account deletion or data export (handled by hand on request).
* Uploaded photos keep embedded metadata (e.g. GPS EXIF); `src/images.js` validates but does not re-encode or strip.
* No per-listing "report" button (reports go through seller/message reports); no automatic prohibited-item screening.
* Messages, orders, addresses and notifications have no automatic expiry.
* The operator/hosting provider can technically read the database (no application-level encryption).
* Pages describe direct mode. If `CHECKOUT_MODE=platform` (legacy escrow, not used in the beta) were ever enabled, the Payments page would be wrong and must be rewritten first.

## Statements a qualified lawyer should review before public launch
1. Terms §2, §10 (disclaimers/limitation, "as is") and the sentence preserving non-waivable consumer rights.
2. Terms §7 licence to content and §8 suspension rights.
3. Payments page §2–§5: the "not a payment institution / not escrow / we do not hold funds" characterisation and the claim that PairPlug takes no commission (money-transmission and marketplace-facilitator tax questions depend on facts and jurisdiction).
4. Privacy: lawful-basis/consent language and rights by jurisdiction (US states, Canada's PIPEDA/Quebec, Mexico); breach-notification duties; whether a cookie notice is required (only one strictly-necessary session cookie is set).
5. Privacy §4: disclosure of Resend/Stripe/hosting as processors, and sellers receiving buyers' addresses and optional buyer emails.
6. Rules §1: the prohibited-items list is a starting point, not a legal determination.
7. Whether the terms-acceptance flow (checkbox + version + timestamp at sign-up/invitation; optional later acceptance in Account) is sufficient, and how to roll out future versions (currently: existing users are never auto-accepted and nothing is blocked).
8. Seller-side obligations (taxes, consumer-protection, data-protection duties for buyer details they receive).
