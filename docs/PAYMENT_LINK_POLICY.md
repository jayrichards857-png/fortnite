# Beta payment-link policy and enforcement

Grailedside is **not** integrating Stripe Connect yet. In the beta each seller's listing carries their own Stripe-hosted Payment Link; the buyer pays the seller there. This document says exactly what Grailedside checks, what it only warns about, and how enforcement works.

## What is technically checked (server-side, `src/paymentLinks.js`)
A link is accepted only if **all** of these hold, on every save (listing form, API, CSV import) and again immediately before a buyer is redirected:
1. The text is printable ASCII with no spaces, backslash or `@` (no look-alike characters, no userinfo tricks).
2. It starts with exactly `https://buy.stripe.com/` (HTTPS only; host compared exactly after parsing and again as raw text; port 443 only; no trailing-dot host, no `https:buy…`, no subdomain/lookalike hosts such as `buy.stripe.com.evil.com`, `buy-stripe.com`, `xbuy.stripe.com`, Unicode homographs).
3. The path is a single Payment Link id (`[A-Za-z0-9_-]{6,100}`), not a homepage or deeper path.
4. In **production**, Stripe test-mode links (`/test_…`) are rejected, and a test link already stored on an order is never followed.
5. The query string and fragment are dropped; Grailedside appends only its own `client_reference_id=PP-<order>`.
`PAYMENT_LINK_HOSTS` may only **narrow** the approved list (`APPROVED_HOSTS`); it cannot add another host or another payment provider. Other providers (PayPal, Cash App, etc.) are rejected.

## What is NOT verified (warnings and seller statements only)
* Grailedside **cannot see or confirm the amount Stripe will charge**, whether the link is live, or whether it belongs to the seller. No integration with Stripe reads the link.
* The seller's tick-box ("this link charges exactly item price + shipping") is the **seller's own statement**. It is stored with a timestamp and the policy version the seller saw (`listings.payment_ack_at`, `payment_ack_policy`) and audited, but it is not independent verification.
* A Stripe-hosted address is not proof the link is safe or correctly priced.
* The buyer-facing "Before you pay" warning tells the buyer to compare the totals themselves.

## Checkout is gated server-side
`externalCheckout.purchasable()` refuses to start a checkout unless the listing has its **own** valid link **and** `payment_total_ack_cents` equals the current item + buyer-paid shipping total. (The old seller-wide "default / any amount" link can no longer start a checkout.) The acknowledgement is cleared when price, shipping or payer, or the link changes (`saveListing`, CSV update, and the `listings_ack_follows_total` DB trigger), and re-confirming after a change requires proof of the exact total and link (`payment_ack_total_cents`, `payment_ack_url`). Orders are never marked paid because a buyer says so; only the seller can confirm payment, and Grailedside does not verify it.

## Audit trail
`audit_log` entries (append-only): `listing_payment_link_changed` (from/to), `listing_payment_total_acknowledged` (total, link, policy version, "seller statement"), `listing_payment_ack_cleared` (reason), plus all moderation actions below.

## Enforcement (configurable, never automatic)
| Measure | Who | Needs | Effect |
| --- | --- | --- | --- |
| Remove / pause a listing | staff (moderator or admin) | case | listing archived |
| Restrict selling (no end date) | staff | reason ≥5 chars | listings paused, no new orders, store hidden, until lifted |
| **Temporary selling suspension, 1–N days** | staff | a **case about that seller**, reason ≥20 chars, explicit confirmation | same as restrict, ends by itself; seller notified and can appeal |
| Ban | staff (moderators cannot ban staff; admin-placed bans are lifted by admins) | reason | account blocked |

`N` is `MAX_SUSPENSION_DAYS` (default **5**, ceiling 30). Nothing in the code suspends anyone from a URL pattern, a failed validation, or a single complaint; the staff screens show how many different buyers have reported the seller and warn when it is only one. None of these measures freezes, holds or refunds money in a seller's Stripe account.

## Review and appeals
* Buyers: **Report a payment mismatch** (`/support#payment-mismatch`) opens an order case flagged `payment_mismatch`; the seller is notified; nothing changes the order's payment state.
* Sellers: **Appeal** (`/dashboard/appeal`) opens a case where the seller is the reporter; staff reply, decide, or lift a restriction.
* Staff: **Moderation → Payment links** lists mismatch reports, repeat violations, open appeals, active listings whose link is unconfirmed, and recent link changes/confirmations.

## Legal / provider questions still open
Whether "up to 5 days" suspensions need a notice-and-response step; whether sellers must be allowed to respond before a suspension; Stripe's rules about sellers using Payment Links for third-party marketplace sales (⚠ verify with Stripe terms); consumer-law wording for the buyer warning; record retention for audit entries.
