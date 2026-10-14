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
1. Confirm `PUBLIC_RELEASE_DATE` in `/etc/pairplug.env` (leave `SUPPORT_EMAIL` unset to use the official `pairplugservice@gmail.com`; if it is set it overrides the default and the server logs a notice), restart. Create your admin account: `node scripts/create-admin.js setup --email you@example.com` (prints a one-time temporary password; you must change it at first login; lost it? `reset`).
2. **Admin → Invitations**: role *Seller*, their email → copy the link **once** (only a hash is stored) and send it to them yourself. It is single-use, bound to that email, expires in 7 days.
3. The seller opens the link, picks a password, store name, handle, and agrees to the terms → logged in.
4. **Email verification.** *Configure real email delivery first* (DEPLOYMENT.md / `deploy/pairplug.env.example`: Resend account, verified domain, `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_API_KEY`) and test one real send — it has never been verified live. Without a provider nothing is sent (locally you can read recorded messages at `/dev/emails`). Open **Admin → Email outbox**, copy the seller's verification link and give it to them (the page is audited). They open it and press *Confirm email*. Sellers who are not verified can't publish or receive new orders.
5. Seller: **Storefront** → add images/theme/announcement → *Save draft* → *Preview* → *Publish*.
6. Seller: **New listing**. A payment link is optional: without one, buyers can only **Contact seller**. To enable **Buy now**, create a Stripe Payment Link for exactly *item price + shipping* (Payment Links have a fixed price) and paste it. Links are validated for format and host only — **PairPlug cannot tell who owns a link or whether its amount matches**. Check it yourself before announcing; if the seller later changes or deletes the link, existing orders keep the link they were created with (see stale-link note below).
7. **Test contact**: from a second account (buyer invitation) message the seller from the listing and confirm they see it with the “Awaiting your reply” indicator.
8. **Test checkout destination**: as the buyer press *Buy now → Go to seller checkout* and confirm the Stripe page shows the right item and amount. **Do a real, cheap test purchase with a friend** — this has never been run against live Stripe.
9. **Record the order**: seller confirms payment (only after the money is in their Stripe dashboard, reference `PP-<order id>`), ships with tracking.
10. **Support issue drill**: as the buyer open *Report a problem* on the test order; as admin open **Admin → Cases**, reply, add an internal note, close with a decision. Check **Admin → Audit**.

## Daily seller routine
1. **Orders → Awaiting your payment confirmation**: find a payment of the **total** with reference `PP-<order id>` in your payment provider → *Payment received — confirm order* (the listing becomes Sold), otherwise *release item*.
2. **Orders → Paid — ready to ship** → open the order → **Ship this order**: buy postage in your own account, ship to the recipient shown, enter carrier + tracking (+ optional message) → *Mark shipped*. The buyer gets an in-app notification (no email). Typo? *Correct the carrier, tracking or message*.
3. An order is **Delivered** only when the buyer confirms receipt (or a verified carrier report says so); you can't mark it yourself.
4. If an older order shows “delivery address is missing”, press *Ask the buyer to add it*; the buyer adds it on their order page.
5. Reply to messages within 48 hours. Refund requested → refund in your payment provider first, then *Report refund sent* (the order is refunded once the buyer confirms).

## Reservation rules (double-sale protection)
* “Reserve item & continue” holds the item for **60 minutes**; if the buyer presses *I've completed payment* the hold extends to **72 hours** (a claim, never proof).
* No confirmation by the deadline → order cancelled, item re-listed. **If a buyer pays after that, the seller must refund them in Stripe.**
* A buyer can hold at most 3 unpaid reservations.

## Stale link / double payment (manual procedure)
A Payment Link can be paid more than once, or after the listing sold. PairPlug cannot see Stripe. If a seller reports a duplicate or late payment: the seller refunds the extra payment in Stripe, then (optionally) records it as a refund request on the relevant order; the founder can note it in a case. Always search Stripe for the `PP-<id>` reference before confirming.

## Recording a sale that didn't use PairPlug's “Buy now”
Buyers who use **Buy now** get a normal PairPlug order (confirm payment, then ship from the order). For any other sale of a listed item — a buyer who paid your Stripe/PayPal link without ordering, a sale from another marketplace, in person, social media/DM — use **Inventory → Record sale**. Choose **where the sale originated** (PairPlug, In person, Another marketplace, Social media or direct message, Other: *where* it came from, not how it was paid), the date, price (leave blank only if unknown), an optional reference, whether the payment is **confirmed by you** (your own check; PairPlug never verifies payments) and whether it needs **shipping** (recipient address now or later) or is **local pickup**. The item becomes Sold immediately. Open the sale from **Orders & sales → Recorded sales** to add the recipient, ship it (carrier + tracking), correct details (logged), confirm payment later, or **void** an accidental record with a reason (the item is paused, not re-listed). PairPlug sends no notification or email for recorded sales. An item that already has a PairPlug order can't also be recorded (no duplicates). Items marked Sold by hand earlier appear under **Sold items with no sales record** until you record them; older “external sale” records are kept as they were (shown as “Earlier record”).

## Admin tasks
* **Invitations / Sellers**: seller count, revoke invitations, suspend/reactivate, *remove seller access* (audited; refused while the seller has open orders; archives their listings).
* **Cases**: reply, internal note, status, *Pause listing*, *Suspend seller*, *Decide and close*; **View reported conversation** (only for reported messages, audited).
* **Orders**: overview of direct orders (no addresses). **Response times**, **Audit**, **Email outbox**.
* If more than 3 seller accounts ever exist (e.g. a restored older database), nothing is deleted; the admin sees a warning and new seller onboarding stays blocked. `npm run inventory:sellers` prints the situation (read-only).
* Legacy dispute/withdrawal/fee pages remain for historical PairPlug-processed orders only.

## Moderators (five slots)
Moderators are dedicated accounts with their own passwords and personal, single-use setup links. Capacity is **five in total** (active moderators + unused links); the database refuses a sixth.
1. Make sure you have an administrator (`node scripts/create-admin.js setup`) and `PUBLIC_URL` is the real https address.
2. For each person (a **new** email address, not an existing account), either run on the server `node scripts/moderator.js invite --email person@example.com`, or log in as the administrator and open **Admin → Moderators → Create setup link**.
3. Copy the link it prints/shows **once** and send it to that person privately yourself (PairPlug does not email it; only a hash is stored). It expires in 72 hours and works once.
4. They open it, choose their name and a 12+ character password, accept the terms, and land on `/moderation`. Check `node scripts/moderator.js status` to see slots.
5. Lost or leaked link: `node scripts/moderator.js revoke --id <n>` (or Revoke on the Moderators page), then create a new one. To remove a moderator, use Deactivate (frees the slot, ends their sessions).
Moderators can ban/unban/restrict with a reason, and work cases; only administrators can create/deactivate moderators, change roles, send provider packets, resolve refunds, or lift bans an administrator placed.

## Account management, quantity and payment-link confirmation (new)
* **Create seller / moderator accounts yourself:** log in as the owner/admin → **Admin → Accounts**. Choose the role, enter the person's email (and an optional suggested display name), press *Review & create*, confirm. A single-use setup link is shown once; copy it and send it to that person privately. PairPlug does not email it. They choose their own password. Cancel an unused link from the same page. Sellers use seller slots (cap 3), moderators use moderator slots (cap 5). Nothing is generated for you: no fake accounts, listings, orders or reviews exist.
* **Quantity:** sellers set "Quantity" in the listing editor. Each order takes one unit; unpaid reservations give it back after the hold time.
* **Payment links:** every listing with its own link needs the seller to tick *"I confirm this link charges exactly item price + shipping"* when saving. Listings created before this release must be re-saved once, or online checkout stays paused for them. Test-mode Stripe links are refused in production.
* **Reviews:** buyers can review after marking an order received; moderators handle reports at **Moderation → Reviews**.

## Payment-link policy (Stripe-only)
* Sellers must put a Stripe Payment Link (`buy.stripe.com`) on each listing and tick the confirmation. Changing the price, shipping or link clears it; buyers cannot check out until it is confirmed again. Test-mode links are refused in production.
* Buyers see a "Before you pay" warning with the expected total and a *Report a payment mismatch* link (opens a flagged case; look at **Moderation → Payment links**).
* Timed suspensions (1 to `MAX_SUSPENSION_DAYS`, default 5): open the seller from **Moderation → Find users** (or the case page), link the case, write a reason (20+ characters), confirm. Never automatic. Sellers can appeal at `/dashboard/appeal`.
