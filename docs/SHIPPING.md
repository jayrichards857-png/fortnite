# Shipping labels (Shippo) — test mode only

**Status:** implemented and tested against a *fake* Shippo transport. **Not yet exercised against Shippo's servers** (this build environment could not reach `docs.goshippo.com`/`api.goshippo.com`, and no key was used). **Real postage purchasing is disabled** and cannot be switched on by configuration; see “Who pays for postage”.

## What it does
On a seller's order page (`/dashboard/orders/<id>`, orders that are *paid* and not yet shipped) a **Shipping label** panel lets the seller:
1. save their **ship-from address** (never invented; asked for once; US/CA/MX validation),
2. see the buyer's **delivery address** (from checkout; shown only after payment is confirmed) and enter/confirm the **package weight and dimensions** (listing values prefill when the listing has them),
3. **Get shipping rates** (carrier, service, price, estimated days; cheapest first),
4. **Buy shipping label** after an explicit confirmation dialog that shows carrier, service and price. The server re-checks the exact price, that the quote is < 24 h old and that addresses/package are unchanged.
5. Print/download the label (`/dashboard/orders/<id>/label`, authenticated redirect) and see tracking. Stored per purchase in `shipments`: label URL, tracking number, carrier, service, price (cents), currency, provider transaction id, status, test flag.

**Test labels are separated from real ones:** `shipments.test = 1` rows are shown with a TEST MODE banner, are *not valid postage*, are never copied into `orders.carrier/tracking_number`, never prefill the ship form and are never shown to buyers. Only real (`test = 0`) labels do those things, and no code path can create one in this release. Buyers see tracking/carrier status on their order page exactly as before (seller enters tracking; the optional `/webhooks/tracking` updates `shipments.tracking_status` for real labels).

Marking the order **shipped** stays a separate, explicit seller action (a label is not proof the parcel was handed over). The checkout model is unchanged: no escrow, no PairPlug fee or markup on postage, no change to payment processing, onboarding stays invitation-only.

## Safety properties (all covered by `test/shipping.test.js`)
* Every endpoint requires a seller session and is scoped by `seller_id`; other sellers get **404**, buyers 403 (HTML: redirect), anonymous 401. The API key and label/provider ids never appear in browser-visible data.
* Inputs validated (addresses, postal formats, weight 1–2400 oz, dimensions 0.5–108 in); incomplete data is requested, not guessed. Per-seller rate limits (quotes 20/h, purchases 10/h, status checks 30/h).
* **Exactly-once purchase:** a unique partial index `(order_id, test) WHERE status IN ('purchasing','success')` plus a claim-before-call transaction. Double clicks / concurrent requests make **one** provider call; a retry after success returns the existing label.
* Failure handling: provider **ERROR/rejection → `failed`** (retry with fresh rates); **timeout/5xx → stays `purchasing`** (outcome unknown — never auto-retried; seller uses *Check status*, or *Release* after 2 minutes only if no transaction id exists and they confirmed in their Shippo dashboard); **QUEUED/WAITING → `purchasing`** until *Check status* sees SUCCESS. Error text shown to users is sanitised.
* Purchased labels are immutable and undeletable (DB triggers).
* Config guards: `SHIPPO_API_KEY` must be `shippo_test_…`; a `shippo_live_…` key is recognised and **refused**; **the server refuses to start in production if the variable is set**; any non-test API response is rejected.

## Setup (local, test mode)
1. Create a free Shippo account and copy the **Test** API token from the API section (do not use the Live token). Never paste it into chat, commit it, or put it in a browser-visible place.
2. Set it in *your own* environment only:
   * PowerShell: `$env:SHIPPO_API_KEY="shippo_test_xxxxxxxx"; $env:HOST="0.0.0.0"; npm start`
   * bash: `SHIPPO_API_KEY=shippo_test_xxxxxxxx npm start` (or a git-ignored `.env`/shell profile; see `.env.example`).
3. Migration: automatic on start (schema v6, additive: `seller_ship_from`, `shipments`). Back up first (`npm run backup`); no existing rows are modified. Rollback = restore the backup (older code must not open a v6 database).
4. Log in as an approved seller with a paid order → Order page → *Shipping label*.
5. Verify against Shippo's test mode yourself: the first real call to `api.goshippo.com` happens here; the field mapping (`/shipments/`, `/transactions/`, `servicelevel.name`, `estimated_days`, `label_url`, `tracking_number`) follows Shippo's public docs but has **not** been run against the live API by me.

## Try the whole workflow locally: the shipping sandbox (development only)
There are no orders on a fresh install, and you should not fabricate payments on your real database. The sandbox builds a **separate throwaway database** (`data/shipping-sandbox.db`) with clearly-marked **TEST DATA**: a test seller, a test buyer, one **paid, unshipped** order (ready for a label) and one **unpaid** order (labels must be refused). Your real `data/pairplug.db` is never opened.

```powershell
cd C:\Users\dietr\fortnite
# Option A: real Shippo TEST mode (your own test token, this terminal only; never paste it anywhere)
$env:SHIPPO_API_KEY="shippo_test_xxxxxxxx"
npm run sandbox:shipping
# Option B: no Shippo at all, an in-process FAKE (UI and flow only; its label link is not a real file)
npm run sandbox:shipping -- --fake-shippo
# start over from scratch (deletes ONLY the sandbox files)
npm run sandbox:shipping -- --reset
```
It prints the login URL (`http://localhost:3100/login`), the two test accounts (`seller@sandbox.invalid`, `buyer@sandbox.invalid`) with **fresh one-time passwords generated for that run**, and the order pages. It listens on `127.0.0.1` only and shows a **SHIPPING SANDBOX — TEST DATA ONLY** banner on every page. Stop it with Ctrl+C, then start your normal app as usual (`npm start`).

**Exercise it (as the test seller):**
1. Open the *paid* order page. In *Shipping label* enter a ship-from address (sample: `TEST Seller`, `965 Mission St`, `San Francisco`, `CA`, `94103`, `US`). Try a bad ZIP (`BAD`) to see validation.
2. Check the package (prefilled 20 oz, 12×9×4 in). Try weight `0` or height `500` to see validation, then **Get shipping rates** (prices, carrier, days).
3. **Buy shipping label** → read the confirmation dialog → confirm. You get *Test label created*, a tracking number and **Print / download label** (the order itself is *not* marked shipped).
4. Press Buy again or reload: no second purchase. Open the *unpaid* order: labels are refused until payment is confirmed.
5. As the test buyer, the order page never shows test tracking.
6. Failure handling is unit-tested (provider error, timeout, queued, duplicate); to see one live, temporarily run with an invalid token and observe the safe error message.

**Safety rules the sandbox enforces** (tested in `test/sandbox.test.js`): refuses `NODE_ENV=production`; accepts only `shippo_test_` tokens and refuses `shippo_live_` ones (without echoing them); refuses any database holding non-sandbox accounts or orders, and refuses `data/pairplug.db`; `config.sandbox` is ignored in production; no app route is changed or bypassed — the orders are created with the normal checkout functions, so seller ownership and the paid/unshipped rules apply exactly as for real orders; nothing prints tokens, provider ids or addresses (it prints only URLs and the test passwords).

## Pricing assumptions (from Shippo's pages as summarised by search on 2026-10-11; I could not load the pages themselves — confirm before relying on them)
* **API “Starter” (pay as you go):** no monthly fee; **30 labels/month free, then about $0.07 per label** ([goshippo.com/pricing/api](https://goshippo.com/pricing/api)). The web-app Starter plan is also free for up to 30 labels/month; Pro starts around $19/month ([support article](https://support.goshippo.com/hc/en-us/articles/360003855652-Shippo-Subscription-Plan-Overview)).
* **Other per-use API fees listed there:** about **$0.01 per rate generation** (every “Get shipping rates” is a rating call), **$0.02 per tracked shipment**, $0.03 per delivery-date estimate, $0.02 per US address validation (PairPlug uses none of the last two). A **$0.05/label** fee applies to labels bought through *your own carrier account* on Starter (not used here).
* **Postage is separate and always extra**, charged at carrier rates to whichever Shippo account owns the token. Plan/API fees (cents) and postage (dollars) are different things. Third-party sources disagree with the numbers above in places, so treat them as indicative.
* Test mode costs nothing. A test token doesn't call carriers for real rates and uses placeholder rates, so **test mode can't validate real prices**.
* Refunds of unused labels exist (`POST /refunds`, within 90 days, credited to the *next Shippo invoice*, up to 14 business days; USPS labels expire after 30 days). **PairPlug does not implement label refunds yet.**
* For 1–3 sellers at a few dozen labels a month, plan fees are ≈ $0 for the first 30 labels per account and cents beyond that; the real cost is postage, paid by whoever owns the account.

## Who pays for postage — unresolved (blocker for live labels)
PairPlug must not pay for or front postage. Options investigated (from Shippo's [integration paths](https://docs.goshippo.com/docs/Guides_general/integration-paths) and OAuth docs):
| Option | Who is billed | Requirement / blocker |
|---|---|---|
| **A. Shippo OAuth (“connected accounts”)** | **Each seller, directly by Shippo** (their own Shippo account + payment method) | OAuth credentials are issued by **Shippo's sales team** on request (company, callback URL, use case). That is an extra approval/account step outside this repo; plus an OAuth flow and secure per-seller token storage. **Not implemented.** Best long-term fit. |
| **B. Seller pastes their own Shippo API key** | Each seller, by Shippo | Needs per-seller secret storage (encryption at rest, rotation, key never shown again), sellers must each hold a Shippo account, and a live key must be validated safely. Feasible but real security work. **Not implemented.** |
| **C. Platform / white-label managed accounts** | **PairPlug** collects/pays postage and must bill sellers | Violates the beta rule that PairPlug holds no funds and doesn't pay for postage. **Rejected.** |

**Decision:** real purchasing stays disabled. Enabling it requires: choose A or B, verify Shippo account setup and who is invoiced, implement per-seller credentials with security review, test with Shippo's test mode end-to-end, then a small supervised live purchase by one seller on their own account. Until then sellers buy labels in their own Shippo/carrier account and enter the tracking number (existing flow).

## Live readiness audit (2026-10-11): what is real, what is not
**Today no live label can be bought**: `src/shippo.js` only enables `shippo_test_` tokens, refuses live tokens and production, and the server refuses to start in production if `SHIPPO_API_KEY` is set.

**If someone simply removed those guards, who would pay?** The single global `SHIPPO_API_KEY` belongs to *one* Shippo account (the operator's). Shippo charges postage to the account that owns the token, so **every label would be charged to PairPlug's own Shippo account** (and sellers would not pay anything) — exactly what must not happen. The code has **no per-seller credentials** (no OAuth, no stored seller tokens): `seller_ship_from` and `shipments` carry addresses and results only. Buyers pay sellers directly, and nothing in the data model routes postage costs to sellers.

**What works (tested against a fake transport only):** ship-from/parcel/address validation, rate quotes, explicit-confirmation purchase, exactly-once purchase (DB unique index + claim-before-call), failure classification (rejected / unknown / queued), stale-quote checks, seller ownership (404 for others), no secrets or provider ids in browser output, isolated sandbox with test data.

**Unverified against Shippo's real API (test or live):** the request/response field mapping (`/shipments/`, `/transactions/`, `servicelevel.name`, `estimated_days`, `label_url`, `tracking_number`, `status` values, `test` flag semantics); `label_file_type: PDF_4x6`; the label-URL host allowlist (`goshippo.com`/`amazonaws.com`); whether `GET /transactions/<id>` reconciles an interrupted purchase as assumed; error-body shapes; phone-number requirements for CA/MX; rate expiry (< 7 days per Shippo; PairPlug uses 24 h); address validation errors.

**Known gaps before live use**
1. **No seller-paid billing path** (the blocker; see below).
2. **Tracking sync from Shippo is not wired.** The existing `/webhooks/tracking` expects `{carrier, trackingNumber, status}` with an `x-webhook-secret` header; Shippo's `track_updated` webhook has a different payload and no such header. Buyer-facing carrier status therefore would not update automatically. Needs either a proper Shippo webhook handler (with verification) or polling; tracking itself is billed per shipment.
3. **No label refund/void** action: a mistaken label can only be refunded by the seller in the Shippo dashboard.
4. A real label stays unmarked-as-shipped until the seller presses “Mark shipped” (intentional) and is not copied to the order until then; the prefill only reads `test = 0` rows, which no code path creates yet.
5. Purchase has no provider idempotency key (Shippo offers none that I verified); duplicate protection relies on PairPlug's own claim row. The “unknown outcome” path needs a manual Shippo-dashboard check by design.
6. Rate generation is itself a billed call (≈ $0.01) on the token owner's account; PairPlug rate-limits quotes (20/h per seller) but does not cap spend.

## Smallest safe path to live labels without PairPlug fronting postage
* **Step 0 (no engineering, available today):** each seller creates their *own* free Shippo account (own payment method), buys the label there (30 free labels/month on Starter), and enters carrier + tracking in PairPlug's existing “Mark shipped” form. PairPlug pays nothing and holds no credentials. Keep in-app labels in test mode only.
* **Step 1 (smallest in-app option): each seller connects their own Shippo API token** (Settings → Shipping). Postage and API fees are billed by Shippo to that seller. Needs: a per-seller token column encrypted at rest with a server-held key (`SHIPPO_TOKEN_ENCRYPTION_KEY`, not yet implemented), write-only UI (never displayed again), token-type check (`shippo_test_` vs `shippo_live_` stored separately, live only after explicit per-seller opt-in), delete/rotate, audit log, and calling Shippo with the *acting seller's* token only. Not implemented; **I also have not verified that Shippo's terms allow a platform to hold customers' API tokens** — confirm with Shippo support first.
* **Step 2 (cleanest long-term): Shippo OAuth** — each seller authorises PairPlug against their own Shippo account; Shippo bills the seller. Requires OAuth credentials issued by Shippo's sales team; no PairPlug-side fee found, but it is a request/approval step outside this repo.
* **Rejected:** a PairPlug-owned live key (PairPlug pays), and Shippo “white-label managed accounts” (PairPlug becomes the billing party).

## Environment variables and safe procedure (no secrets in this file or in Git)
| Variable | Today | Notes |
|---|---|---|
| `SHIPPO_API_KEY` | **Test token only** (`shippo_test_…`), local development only | Set in your own terminal/environment. Production start-up **refuses** it. A `shippo_live_…` value is refused everywhere. Never commit, log or paste it. |
| `PAIRPLUG_SANDBOX` | set only by `scripts/shipping-sandbox.js` | Ignored in production. Never set by hand. |
| `SHIPPO_TOKEN_ENCRYPTION_KEY` | **not implemented** (proposed for Step 1) | Would be a long random server-side secret held outside Git. |

Safe procedure before any future live launch: (1) back up; (2) test with the sandbox and a Shippo **test** token; (3) get written/visible confirmation of who is billed (the seller's own Shippo account); (4) implement the chosen seller-credential step behind a per-seller opt-in flag, keeping production guards until reviewed; (5) one supervised live label by one seller on their own account, immediately refunded in Shippo if unneeded; (6) only then relax the production guard in a reviewed change. Test and live credentials must never share a variable, a database column or a log line.
