# Future payment-protection architecture (DESIGN ONLY — nothing here is implemented)

**Status:** research and design notes. No code in this repository calls any provider's Connect, transfer, payout or refund API, and no part of the product may claim otherwise until a provider is selected, an account is configured, the legal arrangement is signed, and the flow is built and tested. Provider facts below come from general knowledge of how these products are structured and **must be re-verified against the provider's current documentation, contract and your specific account before any decision** (marked ⚠ verify).

## 0. What Grailedside can do today (no new integration)

| Capability | Today |
| --- | --- |
| Take or hold buyer money | **No.** Buyers pay on the seller's own external checkout (Stripe Payment Link). Grailedside neither holds nor directly controls those funds. |
| Freeze / reverse / refund money in a seller's Stripe or PayPal account | **No.** There is no API access to seller accounts. A Grailedside restriction or ban is not a financial hold. |
| Verify a payment | **No.** "Payment confirmed" is the seller's statement. Orders show it as such. |
| Receive and review complaints | **Yes**: in-app order and seller reports with photos; email to the support address is read by hand and creates no case. |
| Preserve evidence | **Yes**: append-only case events, uploaded photos, immutable order snapshots, and (since schema v15) a frozen order/conversation fingerprint per reported order (`case_records`). |
| Contact buyer and seller | **Yes**: staff replies on the case notify the parties in-app. |
| Restrict a seller | **Yes**: restrict selling (no new orders, listings paused, store hidden, buyers with unpaid orders warned and not redirected to the payment link by Grailedside) or ban the account, with a required reason, recorded in `moderation_actions` + `audit_log`. |
| Report suspected fraud to the payment processor | **Partly, by hand**: staff prepare a factual packet and record that they submitted it through the provider's own channel. No API call; Grailedside cannot see or influence the response. |
| Promise outcomes or times | **No.** |

Everything below would require a new provider integration, new legal arrangements, and a separately approved migration.

## 1. Is Stripe Connect (or another marketplace provider) appropriate?

Grailedside's model would change from "seller's own Stripe" to "marketplace collects the payment, then pays sellers", which is exactly what marketplace products (Stripe Connect, PayPal Commerce Platform / Payouts, Adyen for Platforms, Mangopay, etc.) are designed for.

**Stripe Connect** is the natural candidate because Grailedside already has Stripe-shaped legacy code (`src/payments.js`, `src/escrow.js`, `checkouts`, `payments`, `refunds`, `ledger`, `disputes`, `withdrawals` — the original escrow flow, disabled in the beta via `CHECKOUT_MODE=external`). Options inside Connect:

| Design | Who the customer pays | Typical merchant-of-record / liability ⚠ verify | Fit |
| --- | --- | --- | --- |
| **Direct charges** on a Standard/Express connected account | Seller's account | Seller is the merchant; seller bears refunds/disputes; platform can take an application fee. Platform has little power to hold or reverse funds. | Close to today's model; **does not** give Grailedside refund/hold power. Not recommended for "protection". |
| **Destination charges** | Platform account, funds routed to the seller's connected account at payment time | Platform is the merchant of record for the charge and is generally the party liable for refunds and chargebacks; the transfer to the seller can be reversed while the seller's balance has funds. | Workable; payout timing is controlled mainly by the seller account's payout schedule. |
| **Separate charges and transfers** | Platform account | Platform holds the money in its own balance until it chooses to create the transfer(s), then pays sellers; platform is the merchant and liable for disputes. | **Best fit for "release after delivery"**, subject to Stripe's limits on how long funds may be held and on the countries involved ⚠ verify. |

**Account types:** Express (Stripe-hosted onboarding, lighter integration) or Standard (seller keeps a full Stripe account; less platform control). Custom gives most control and the most compliance burden. For a beta marketplace, Express + separate charges and transfers (or destination charges with delayed payouts) is the usual starting point ⚠ verify against current Stripe terms for marketplaces.

**Alternatives to evaluate in parallel:** PayPal Commerce Platform (supports delayed disbursement for marketplaces ⚠ verify, buyer-facing PayPal brand, PayPal's own buyer-protection program applies and may override platform decisions), Adyen for Platforms / Mangopay (more enterprise, higher minimums), or a no-custody approach (keep external checkout and rely on process + reporting, as now).

## 2. Merchant of record, refunds, disputes, compliance

Decide explicitly with counsel and the provider; the answer drives the terms of service.

* **If Grailedside is the merchant of record** (destination or separate-charges model): Grailedside appears on the buyer's statement, receives chargeback notices, is the party that wins or loses disputes, issues refunds from its balance (and can claw back from sellers via transfer reversals where funds remain), and carries the card-network relationship. It also carries sales-tax/marketplace-facilitator obligations in many US states and similar rules in Canada/Mexico ⚠ legal. Insurance/reserves and a funding source for lost disputes are needed.
* **If the seller is the merchant** (direct charges): seller handles refunds/disputes; Grailedside cannot promise anything about money. This is today's model with better plumbing.
* **Money-transmission / payment-institution rules:** using Connect means Stripe's regulated entities hold funds; the platform must stay inside the allowed pattern (for example, not holding funds outside Stripe, not delaying payouts longer than allowed) ⚠ legal + provider. Never "hold funds" in a Grailedside bank account.
* **Compliance load:** KYC/KYB for every seller (provider-hosted), sanctions screening, tax information collection (1099-K / T4A-style reporting thresholds depend on country ⚠ legal), PCI scope stays minimal if card data never touches Grailedside (Stripe Elements/Checkout), terms updates, a privacy-policy update naming the provider, and a published dispute/refund policy that matches the real mechanics.

## 3. Do delayed payouts, reserves or reversible transfers actually work?

For the intended "release funds after the buyer receives the item" arrangement, check each in the provider's current docs and in the **specific account configuration**:

1. **Delayed payouts** (per connected account `payouts.schedule.delay_days`, or manual payouts) — available for Express/Custom accounts configured by the platform; Standard accounts control their own ⚠ verify. Maximum delay and any minimum-after-first-payout rules are provider-defined.
2. **Separate charges and transfers** — the platform decides when to transfer. Provider limits on how long the platform may hold funds before transferring, and on which country combinations are allowed (cross-border payouts are restricted; US, Canada and Mexico sellers may not all be supported from one platform account ⚠ verify).
3. **Transfer reversals** — possible only while the seller's connected account still has the funds; after payout the platform can only recover through the negative-balance mechanism (see §6).
4. **Reserves** — some providers let the platform (or the provider) hold a rolling reserve for risky accounts ⚠ verify whether and how for Connect.
5. **Refunds** — platform-initiated refunds of the original charge are supported; funds come out of the platform balance (destination/separate charges) and may be recovered from the seller via reversal.
6. **Disputes (chargebacks)** — the provider's dispute process, evidence submission and deadlines are fixed by the card networks; Grailedside's records (`case_records`, tracking, messages) would be the evidence.

**Do not say Grailedside can freeze funds** until a provider confirms in writing that the chosen account type, charge type and country combination allow it.

## 4. Onboarding, identity, fees, countries

* **Seller onboarding:** provider-hosted flow (identity, address, date of birth, bank account, tax ID); Grailedside stores only the connected account id and status flags (`charges_enabled`, `payouts_enabled`, `requirements`), never identity documents.
* **Fees (⚠ verify current pricing):** card processing fee per transaction; Connect adds per-active-account and/or payout fees; platform may add an application fee; chargeback fees apply; currency conversion if USD/CAD/MXN. Grailedside currently charges none, so a new fee model must be decided and disclosed.
* **Country eligibility:** confirm Connect supports connected accounts and payouts in the US, Canada and Mexico for the platform's own country of incorporation, and which charge types are allowed cross-border ⚠ verify. Buyer shipping already covers US/CA/MX.
* **Grailedside entity:** a registered business with a bank account and the ability to be underwritten is a prerequisite; the legal entity and address are currently unpublished.
* **Currency:** listings are USD only today (CHECK constraint); multi-currency is a separate project.

## 5. Database and UI design (when approved)

Reuse the legacy escrow tables as the starting point instead of inventing new ones, via an additive migration ("schema v16+", needs separate approval):

* `seller_payment_accounts(seller_id, provider, provider_account_id, charges_enabled, payouts_enabled, requirements_json, updated_at)`.
* `payments` (exists): provider payment-intent/charge id, amount, currency, status, `captured_at`.
* `payment_transfers(order_id, provider_transfer_id, amount, status: pending|paid_out|reversed|failed, scheduled_for, released_by)`.
* `refunds` (exists): `initiated_by` (buyer request / seller / staff), amount, provider refund id, status, reason, linked `case_id`.
* `ledger` (exists, append-only): every movement (charge, fee, transfer, reversal, refund, dispute) as signed entries so the books reconcile to the provider's balance.
* `provider_events` (webhook idempotency; `payment_events` exists).
* Order state machine additions: `paid_held` (funds captured, transfer not yet scheduled) → `release_scheduled` → `released`; `refund_pending` → `refunded`; `disputed_by_card_network`. The existing external states stay for sellers who remain on external checkout.

UI: buyer sees "Paid via Grailedside — funds are released to the seller after you confirm delivery or N days"; a "Request refund" action that opens a staff-reviewed case; seller dashboard shows pending/available/reversed balances and payout status; staff case page shows charge, transfer, refund and dispute status with **buttons that call the provider only after a reason is recorded**, each action idempotent, audited, and shown with the provider's own status — never a locally invented "refunded".

Provider webhooks (signature-verified) are the source of truth for payment, refund, transfer and dispute states; the UI shows pending until the provider confirms.

## 6. When funds have already been paid out or are unavailable

* **Transfer already paid out to the seller's bank:** the platform cannot pull it back directly; options are (a) the provider's negative-balance mechanism (the connected account goes negative and the provider attempts to debit their bank, with platform or provider liability depending on configuration ⚠ verify), (b) offset against future sales (rolling reserve / holdback), (c) the platform absorbs the loss from a loss reserve.
* **Seller refuses or disappears:** platform refunds the buyer from its balance (destination/separate-charges model) and pursues recovery; this requires a funded loss reserve and a contract clause (seller agreement) allowing set-off.
* **Funds not yet available (pending balance):** a refund may be delayed or fail; the UI must show "pending provider confirmation" rather than success.
* **Dispute after payout:** network deadlines (often weeks) vs. payout schedule decide who pays; delayed payouts + delivery-confirmation holds reduce exposure but do not remove it.
* **International/currency issues:** refunds in the original currency; FX loss rules to define.
* **Fraudulent sellers:** hold on payouts + reserve + KYC reduce, not eliminate, risk; Grailedside's existing restriction/ban tooling still applies on top.

## 7. Decisions needed before any build

1. Choose the model (stay external with better process, or marketplace flow) and provider; get written confirmation of delayed payout / hold / reversal behaviour for your account and countries.
2. Confirm legal structure: merchant of record, money-transmission analysis, tax/marketplace-facilitator duties, seller agreement (set-off, reserve), buyer terms (refund policy, protection scope, timelines), updated privacy policy.
3. Decide fees and who bears chargeback losses; fund a loss reserve.
4. Define the refund/dispute policy publicly **only after** the mechanics exist; keep today's accurate disclosure until then (`src/disclosure.js`).
5. Plan a staged rollout: sandbox/test mode only → a few invited sellers → wider; keep external checkout as a fallback.

Until those are resolved, Grailedside's buyer-facing language stays: payment is processed through the seller's external checkout; Grailedside does not currently hold or directly control those funds; Grailedside may review, contact the seller, restrict the seller on Grailedside and report to the payment processor, but cannot promise a refund.
