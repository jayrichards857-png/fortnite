# PairPlug private beta — operating guide

## Who does what (read this before launch)
| | Who |
|---|---|
| Takes the buyer's payment | **The seller**, through the seller's own Stripe Payment Link. PairPlug never sees card details and never holds funds. |
| Confirms the payment arrived | **The seller**, on PairPlug (`/dashboard/orders/<id>`). PairPlug can't verify it. Until then the order reads *Awaiting payment confirmation*. |
| Refunds, returns, chargebacks, payment disputes, sales tax, Stripe fees | **The seller and their payment provider.** PairPlug does not refund, mediate or guarantee payments. Buyers are told this on the listing, purchase page and order page. |
| Buys the shipping label | **The seller**, outside PairPlug (PairPlug links to services but integrates with none). Seller enters carrier + tracking. |
| Photos, listings, messaging, order records | PairPlug (records are append-only/immutable where noted in ARCHITECTURE.md). |
| Escrow / “payment protection” | **Not provided.** (The old escrow code is disabled for new orders.) |

## One-time seller setup (founding reseller)
1. Admin: put the seller's email in `SELLER_ALLOWED_EMAILS` and restart. The seller registers at `/register`, then `/sell` → store name, handle, ships-from.
2. In **Stripe**: create a **Payment Link per listing** for exactly *item price + shipping fee* (Payment Links have a fixed price). For free-shipping items the link is the item price only.
3. In PairPlug **Settings** (optional): a default link is only used for listings without their own link **and only** if you tick “lets the buyer enter any amount”.
4. **Listings → New listing**: photos (real ones), title, size, condition, price, shipping terms (*buyer pays a flat fee* **or** *free shipping, I cover the label*), and paste the item's Payment Link. Publishing is refused without a usable link.
5. **Do a real test purchase** of a cheap item with a friend before announcing. Stripe link behavior with PairPlug's `client_reference_id` parameter has **not** been tested live.

## Daily seller routine
1. Dashboard → *awaiting your payment check*. For each order open your Stripe dashboard, find a payment of the **total** with reference `PP-<order id>`.
2. Money is there → **Payment received — confirm order** (item becomes Sold; address is shown). Not there → **No payment received — release item**.
3. Buy a label yourself → enter carrier + tracking → **Mark shipped**. The buyer sees a tracking link.
4. Refund needed → refund in **Stripe first**, then **Refund or cancel this order → Record refund** (this only records it).

## Reservation rules (what protects against double sales)
* “Reserve item & continue” holds the item for **60 minutes** (one buyer wins a race; others see *Reserved*).
* If the buyer clicks **I've completed payment**, the hold extends to **72 hours** so the seller can verify. This is a claim, never proof.
* No confirmation by the deadline → the order is cancelled and the item re-listed automatically. If a buyer pays *after* that, the seller must refund them in Stripe (the order can't be revived).
* A buyer can hold at most 3 unpaid reservations.

## Admin tasks
`/admin` (users, listings removal, ban). Legacy dispute/withdrawal/fee pages still exist for historical PairPlug-processed orders only.
