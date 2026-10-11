# PairPlug private beta — operating guide

## Who does what (read this before launch)
| | Who |
|---|---|
| Takes the buyer's payment | **The seller**, through the seller's own Stripe Payment Link. PairPlug never sees card details and never holds funds. |
| Confirms the payment arrived | **The seller**, on PairPlug (`/dashboard/orders/<id>`). PairPlug can't verify it. Until then the order reads *Awaiting payment confirmation*. |
| Refunds, returns, chargebacks, payment disputes, sales tax, Stripe fees | **The seller and their payment provider.** PairPlug does not refund or guarantee payments. It records the request, what each side *says*, and the founder can review evidence and act on listings/accounts. |
| Buys the shipping label / pays postage | **The seller**, in their own Shippo, Pirate Ship or USPS account. **PairPlug never buys labels or pays postage.** Buyer-paid shipping is money the buyer paid the seller directly, not a prepaid label. The seller enters carrier + tracking (+ optional note) and presses *Mark shipped*: this records the tracking in PairPlug; it does not buy postage or guarantee delivery. |
| Account creation | **Buyers** sign up themselves (buyer rights only). **Sellers** exist only by the founder's invitation (max 3); everyone else sees “Coming Soon!” on the Sell page. |
| Escrow / “payment protection” | **Not provided.** |

## Response expectation (policy)
Sellers are *expected* to reply to buyer messages within **48 hours**. This is shown to buyers and sellers as an expectation, **not a guarantee**. Conversations whose last message is from a buyer and older than 48h appear on **Admin → Response times** (seller and elapsed time only, no message text). Use it to check in with a seller. Nothing is penalised automatically.

## Onboarding the first seller (step by step)
1. Confirm `PUBLIC_RELEASE_DATE` and `SUPPORT_EMAIL` in `/etc/pairplug.env`, restart. Create your admin account: `node scripts/create-admin.js setup --email you@example.com` (prints a one-time temporary password; you must change it at first login; lost it? `reset`).
2. **Admin → Invitations**: role *Seller*, their email → copy the link **once** (only a hash is stored) and send it to them yourself. It is single-use, bound to that email, expires in 7 days, and reserves one of the 3 seller slots.
3. The seller opens the link, picks a password, store name, handle, and agrees to the terms → logged in.
4. **Email verification.** *Configure real email delivery first* (DEPLOYMENT.md / `deploy/pairplug.env.example`: Resend account, verified domain, `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_API_KEY`) and test one real send — it has never been verified live. Without a provider nothing is sent (locally you can read recorded messages at `/dev/emails`). Open **Admin → Email outbox**, copy the seller's verification link and give it to them (the page is audited). They open it and press *Confirm email*. Sellers who are not verified can't publish or receive new orders.
5. Seller: **Storefront** → add images/theme/announcement → *Save draft* → *Preview* → *Publish*.
6. Seller: **New listing**. A payment link is optional: without one, buyers can only **Contact seller**. To enable **Buy now**, create a Stripe Payment Link for exactly *item price + shipping* (Payment Links have a fixed price) and paste it. Links are validated for format and host only — **PairPlug cannot tell who owns a link or whether its amount matches**. Check it yourself before announcing; if the seller later changes or deletes the link, existing orders keep the link they were created with (see stale-link note below).
7. **Test contact**: from a second account (buyer invitation) message the seller from the listing and confirm they see it with the “Awaiting your reply” indicator.
8. **Test checkout destination**: as the buyer press *Buy now → Go to seller checkout* and confirm the Stripe page shows the right item and amount. **Do a real, cheap test purchase with a friend** — this has never been run against live Stripe.
9. **Record the order**: seller confirms payment (only after the money is in their Stripe dashboard, reference `PP-<order id>`), ships with tracking.
10. **Support issue drill**: as the buyer open *Report a problem* on the test order; as admin open **Admin → Cases**, reply, add an internal note, close with a decision. Check **Admin → Audit**.

## Daily seller routine
1. Dashboard → awaiting your payment check: find a payment of the **total** with reference `PP-<order id>` in Stripe → *Payment received — confirm order*, otherwise *release item*.
2. Buy postage in your own shipping account, then enter carrier + tracking → *Mark shipped* (the order page lists these steps).
3. Reply to messages within 48 hours.
4. Refund requested → refund in **Stripe first**, then *Report refund sent*. The order shows *refunded* only after the buyer confirms receipt (or the founder verifies).

## Reservation rules (double-sale protection)
* “Reserve item & continue” holds the item for **60 minutes**; if the buyer presses *I've completed payment* the hold extends to **72 hours** (a claim, never proof).
* No confirmation by the deadline → order cancelled, item re-listed. **If a buyer pays after that, the seller must refund them in Stripe.**
* A buyer can hold at most 3 unpaid reservations.

## Stale link / double payment (manual procedure)
A Payment Link can be paid more than once, or after the listing sold. PairPlug cannot see Stripe. If a seller reports a duplicate or late payment: the seller refunds the extra payment in Stripe, then (optionally) records it as a refund request on the relevant order; the founder can note it in a case. Always search Stripe for the `PP-<id>` reference before confirming.

## Items sold outside PairPlug
Use **Inventory → Record external sale** (not a PairPlug order). It marks the item Sold and logs the date, optional price and where it sold in **Orders & sales → External sales you recorded**, labelled as the seller's own, unverified record. Items already marked Sold by hand appear under **Sold items with no sales record** until you record them (nothing is converted automatically). Items sold through a PairPlug checkout are tracked as orders and can't be recorded this way. Records can't be edited or deleted.

## Admin tasks
* **Invitations / Sellers**: slots used (suspended sellers still occupy a slot), revoke invitations, suspend/reactivate, *release slot* (audited; refused while the seller has open orders; archives their listings).
* **Cases**: reply, internal note, status, *Pause listing*, *Suspend seller*, *Decide and close*; **View reported conversation** (only for reported messages, audited).
* **Orders**: overview of direct orders (no addresses). **Response times**, **Audit**, **Email outbox**.
* If more than 3 seller accounts ever exist (e.g. a restored older database), nothing is deleted; the admin sees a warning and new seller onboarding stays blocked. `npm run inventory:sellers` prints the situation (read-only).
* Legacy dispute/withdrawal/fee pages remain for historical PairPlug-processed orders only.
