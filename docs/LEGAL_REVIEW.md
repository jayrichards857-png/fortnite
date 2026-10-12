# Legal pages: what they claim, what's missing, what needs a lawyer

The pages live in `src/legal.js` (`/terms`, `/privacy`, `/payments`, `/rules`, index `/legal`). They were written from the code as it exists (private beta, `CHECKOUT_MODE=external`, direct-to-seller payments). They are **not legal advice** and have **not** been reviewed by a lawyer.

## Business details still missing (owner input)
* Legal entity name and mailing address → set `LEGAL_ENTITY` / `LEGAL_ADDRESS` (shown only when set).
* Support/privacy email: the official address `pairplugservice@gmail.com` is the built-in default (`SUPPORT_EMAIL` can override it; an override is logged at startup). Confirm you own and monitor that inbox. It is a mailto link only: no ticketing, no auto-created cases, no response time promised.
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

## Scam reporting: intended policy vs. what the code does (schema v12)
Intended: PairPlug accepts and investigates scam reports, restricts accounts/listings, reports suspected payment fraud to the payment provider, and never claims control over external funds.

| Intended | In code today | Gap / decision |
| --- | --- | --- |
| Buyers can report suspected scams with evidence | Order reports (`/api/cases/order`) now allowed once the buyer opened the seller's link, said they paid, or the seller confirmed (previously blocked while "awaiting payment confirmation"); seller reports (`/api/cases/seller`) take category, up to 4 photos and an optional own order. Evidence photos are stored as append-only `case_events`. | Evidence is images + text only; no file/PDF upload. No per-listing report button. |
| Duplicate protection | One open report per buyer per order (existing index) and per buyer per seller (new, checked in a transaction). Operator actions refuse duplicates (409). | No fuzzy duplicate detection across buyers by design; repeat reporters are surfaced at `/admin/risk`. |
| Auditable | `cases`, append-only `case_events`, `audit_log` (open, restrict, lift, packet prepared/downloaded/submitted), `processor_reports` (append-only; submitted rows immutable). | Audit rows have no retention schedule. |
| Stop a suspected scammer while investigating | Admin "Restrict selling": listings paused, publishing/resume/bulk blocked, new orders refused, store and discovery hidden, followers cannot be added, buyers with unpaid orders warned, buyers are no longer redirected to the seller's payment link from PairPlug. Reversible. "Suspend" (ban) also warns unpaid buyers. | **Cannot stop the seller's own payment link from working outside PairPlug**, and cannot stop buyers who already hold the link. No automatic restriction (deliberate; operator decides). |
| Notify the payment processor | The operator can **prepare** a factual text packet (labelled statements, no internal notes, no buyer address/email) and **record** that they submitted it by hand, with channel + reference. Provider is inferred from the payment link host actually used. | **There is no Stripe/PayPal integration, and no automatic or verified reporting.** PairPlug cannot see the provider's response. Which official channel to use, and what data the provider needs, must be decided by the owner. Default `PAYMENT_LINK_HOSTS` accepts only `buy.stripe.com`; PayPal links need `PAYMENT_LINK_HOSTS` extended (and the host's link format reviewed) before sellers can use them. |
| Never treat external payment as verified | Unchanged: only the seller can confirm payment; the field is a seller statement; admin pages and packets label it "the seller says"; no admin path marks an external payment verified. | Admins can still mark a *refund* verified in records (existing), which records but does not cause a refund. |

### Owner decisions / legal review for this feature
* Sharing case data with a payment provider (packet contents, lawful basis, notice to the buyer and seller, whether to ask the buyer's consent before including their email/address). The privacy page says the operator sends it by hand and excludes address/email unless needed and agreed.
* Restricting a seller *before* a finding (terms §8 says we may). Whether sellers get a right to respond or appeal; currently they are notified of a restriction, not of a seller report, and can still reply to PairPlug via `/support`.
* Whether to publish response-time targets (none promised) and any refund/"buyer protection" commitments (none made, none implied).
* Retention of reports, evidence photos and packets (no automatic deletion exists).
* Wording that "PairPlug may report suspected fraud to authorities when the law requires or permits".

## Reviews, quantity and checkout amounts (schema v14)
* **Reviews policy questions for counsel/owner:** whether "order-linked" wording is sufficient (we never say "verified purchase"); consumer-review laws (e.g. rules on fake/incentivised reviews, suppression of negative reviews) in your jurisdictions; retention of removed/hidden reviews; whether sellers should get a right of reply; whether moderators hiding reviews at their discretion needs a published standard. Moderators can only hide/restore with a reason, never edit.
* **Delivery** is the buyer's own "received" click (or a carrier webhook if enabled); tracking alone never makes an order reviewable.
* **Checkout amount:** PairPlug cannot verify what a seller's payment page charges. The only controls are the seller's confirmation, the buyer-facing "check before you pay" notice, and refusing Stripe test links in production. A seller who ticks the box falsely can still mismatch; that is covered by reports/restrictions, not prevented. **Launch note:** existing listings have no confirmation and cannot be bought online until their seller re-saves with the box ticked.
* **Quantity:** a unit is held for a reservation (default 30 minutes) and given back if unpaid; the legal pages do not promise stock.
* **Owner accounts:** invitations are not emailed (no provider configured); the owner delivers links by hand. Decide whether to configure an email provider before launch.

## Buyer payment disclosure and dispute handling (schema v15)
* **Wording** lives in one file, `src/disclosure.js` (checkout checkbox, listing/order short form, "what PairPlug can and cannot do" list). Counsel should review: "does not currently hold or directly control those funds"; "may review the order, contact the seller, and report the problem to the payment processor"; and the explicit "cannot promise a refund or recovery". The checkbox is still required server-side before an order is reserved.
* **What exists vs. what is said:** reports, evidence, both-sides contact, restriction/ban, recorded reasons and a frozen order/conversation fingerprint (`case_records`) exist. Reporting to the processor is manual (staff prepare and submit a packet); there is no API, no way to see the outcome, and no promise it will help.
* **Unresolved:** whether a "may report to the payment processor" statement needs buyer consent for sharing their details; response-time targets (none promised); retention of `case_records`; the future marketplace-payments model is only a design (`docs/PAYMENT_PROTECTION_DESIGN.md`) and needs provider confirmation of hold/reversal behaviour, merchant-of-record and licensing analysis before any build.

## Stripe-only link policy and timed suspensions (schema v16)
* **What is verified vs. warned:** the link *address* is verified (exact approved Stripe host, single Payment Link id, no test links in production). The *amount* is not: the seller's tick-box is their own statement and the buyer warning asks the buyer to compare totals. PairPlug cannot confirm any seller's actual Stripe checkout amount.
* **Counsel questions:** notice/response before a suspension; whether "up to 5 days" suspensions plus appeals meet your terms (owner decision: `MAX_SUSPENSION_DAYS`); Stripe's own rules for sellers using Payment Links to sell on a third-party marketplace (verify with Stripe); wording of the buyer warning and seller notice; audit/appeal record retention.
* **Behaviour change to announce to sellers:** the seller-wide "default / any amount" link no longer starts checkouts; each listing needs its own Stripe link and confirmation.
