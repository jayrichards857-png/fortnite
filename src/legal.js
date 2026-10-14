'use strict';
// Legal and policy pages. These describe PairPlug AS IT WORKS TODAY (private beta, direct-to-seller payments). If behaviour changes, change the text and bump VERSION:
// the version is what gets recorded when someone accepts the terms at sign-up. Nothing here is legal advice; see docs/LEGAL_REVIEW.md for what needs a lawyer.
const config = require('./config');
const { esc } = require('./util');

const VERSION = '2026-10-12';
const UPDATED = 'October 12, 2026';
const PAGES = [
  { path: '/terms', key: 'terms', title: 'Terms of Service', blurb: 'The rules for using PairPlug, and what PairPlug does and does not do.' },
  { path: '/privacy', key: 'privacy', title: 'Privacy Policy', blurb: 'What we collect, why, who can see it, how long we keep it, and how to ask for help.' },
  { path: '/payments', key: 'payments', title: 'Payments, Refunds & Disputes', blurb: 'How buyers pay sellers directly, who handles refunds and chargebacks, and what we can do if something goes wrong.' },
  { path: '/rules', key: 'rules', title: 'Prohibited Items & Seller Rules', blurb: 'What may not be listed, and what every seller agrees to do.' },
];
const link = (key, text) => { const p = PAGES.find((x) => x.key === key); return `<a href="${p.path}">${esc(text || p.title)}</a>`; };

/** How to reach PairPlug. Only values the operator has configured are shown; nothing is invented. */
function contactBlock() {
  const V = require('./views');
  return `<p><strong>Email ${V.contactLink()}</strong> for scam and fraud reports, buyer and seller concerns, account issues and appeals, marketplace safety, privacy requests and general questions. See also the <a href="/contact">Contact page</a> and the <a href="/support">Help &amp; reporting page</a> (log in to send an in-app report with photos, which creates a tracked case).</p>
<p class="small muted">Emails are read by the operator. They do not create a case or ticket automatically, and there is no guaranteed response time. For a scam report, the in-app report form is the way to attach evidence to your order. Say "privacy request" in the subject for privacy-related help.</p>`;
}
function operatorBlock() {
  const name = config.legalEntity, addr = config.legalAddress;
  return name || addr
    ? `<p>PairPlug is operated by ${name ? `<strong>${esc(name)}</strong>` : 'its founder'}${addr ? `, ${esc(addr)}` : ''}.</p>${name && addr ? '' : '<p class="muted small">Some business details have not been published yet.</p>'}`
    : '<p>PairPlug is a private beta run by its founder. A registered business name and mailing address have not been published yet; until they are, use the contact details below.</p>';
}

const S = {};
S.terms = () => `
<h2>1. What PairPlug is</h2>
<p>PairPlug is an online marketplace where independent sellers list clothing, streetwear, sneakers and accessories (new and pre-owned), and buyers find, follow and contact them. <strong>PairPlug is not the seller of the items.</strong> Each sale is an agreement between the buyer and the seller. PairPlug provides the website, accounts, messaging, order tracking and reporting tools.</p>
${operatorBlock()}
<h2>2. What PairPlug controls, and what it doesn't</h2>
<ul>
<li><strong>We control</strong> the website and its accounts, who is allowed to sell during the beta, and what we do about reports (for example pausing a listing or suspending an account).</li>
<li><strong>Sellers control</strong> what they list, the price and shipping charge, the item's description and condition, how and when they ship, and their own refund decisions.</li>
<li><strong>We do not</strong> inspect, authenticate or take possession of items. We do not guarantee that an item is genuine, as described, or will arrive. PairPlug does not currently hold or directly control the funds buyers pay through sellers' external checkouts, and cannot freeze, reverse or refund them (see ${link('payments')}).</li>
<li><strong>We do</strong> accept and review reports of suspected scams and can act on PairPlug accounts and listings.</li>
</ul>
<h2>3. Private beta</h2>
<p>PairPlug is in a private beta. Anyone can create a free buyer account while sign-ups are open. Anyone with an account can request seller access; requests are reviewed for safety, with no fee to apply and no limit on the number of sellers. Features may change, be paused or be removed, and the service may have interruptions. Listing on PairPlug is free, and PairPlug charges no listing fees, subscriptions or commission (0%) to buyers or sellers. Payment processors such as Stripe charge sellers their own processing fees. If PairPlug's fees ever change, we will say so before it applies to you.</p>
<h2>4. Your account</h2>
<ul><li>You must be old enough to form a binding contract where you live. PairPlug is intended for people in the United States, Canada and Mexico; we have not built age verification, so you confirm this yourself by signing up.</li>
<li>Give accurate information, keep your password private, and tell us if you think someone else has used your account. You are responsible for activity under your account.</li>
<li>One person, one account. Do not impersonate anyone, claim to be PairPlug staff, or claim that PairPlug guarantees, escrows or endorses a listing or seller.</li></ul>
<h2>5. Buying</h2>
<ul><li>"Continue to seller checkout" reserves the item for a limited time and creates an order record. <strong>Creating an order does not mean you have paid, and it does not mean the seller has been paid.</strong> You pay the seller through the seller's own checkout page.</li>
<li>The order shows as paid only after the seller says they received your payment. PairPlug cannot check that for them. Please keep your own receipt.</li>
<li>Your delivery address is shared with the seller so they can ship. Do not use another person's payment method without permission.</li></ul>
<h2>6. Selling</h2>
<p>If you are invited to sell, you also agree to the ${link('rules')}. In short: list only items you own and may lawfully sell; describe them honestly with real photos; ship what you sell promptly, with tracking where you can; answer buyers; confirm payments only when you actually received the money; and handle your own refunds, taxes and payment-provider obligations. Sellers are independent; they are not employees or agents of PairPlug.</p>
<h2>6a. Reviews</h2>
<p>After a buyer marks a PairPlug order <em>received</em>, they can give that seller a thumbs-up and write an optional review (up to 1,000 characters). Each order can have one review, only from the buyer of that order. Reviews are shown on the seller's store with the buyer's first name and are labelled <strong>order-linked</strong>, not "verified": buyers pay sellers outside PairPlug and PairPlug does not independently verify those payments or that an item arrived as described. Counts shown are simple tallies (thumbs-up, written reviews, reviews), not a rating or ranking. Be honest and relevant: no fake, paid-for or retaliatory reviews, and no ads, personal data or abuse. Anyone logged in can report a review; moderators can hide or restore a review with a recorded reason, but cannot edit what it says. You can edit or remove your own review unless a moderator has hidden it.</p>
<h2>7. Content you post</h2>
<p>You keep ownership of your listings, photos, profile text and messages. You give PairPlug permission to store and display them on the service (for example in search, on your storefront and to the people you message) so that the service can work. Only post what you have the right to post.</p>
<h2>8. Acceptable use</h2>
<p>Do not break the law, post prohibited items (see ${link('rules')}), harass or threaten others, send spam, scrape the site or attack its security, interfere with other people's orders, or try to take transactions off-site to avoid a dispute process. We may remove content, pause listings, restrict selling, limit access or suspend accounts that break these terms or that we reasonably believe put others at risk, including while a report is still being investigated. We may also report suspected fraud to payment providers and, where the law requires or permits, to authorities. We will tell you when we can; we may not tell you when doing so could put others at risk or compromise an investigation.</p>
<h2>9. Reports and disputes</h2>
<p>If something goes wrong, message the seller first. If you think you are being scammed, <strong>report it</strong>: open a case from your order page, or report the seller or a message from the <a href="/support">Help &amp; reporting page</a>, and attach screenshots or photos. PairPlug reviews reports, may contact both sides, and may take action on PairPlug accounts and listings (see ${link('rules')} and ${link('payments')}). <strong>Reporting to PairPlug does not replace contacting your payment provider or card issuer</strong>, and PairPlug cannot promise any particular outcome, such as a refund.</p>
<h2>10. Limits of our responsibility</h2>
<p>PairPlug is provided "as is" during the beta. To the extent the law allows, PairPlug is not responsible for what sellers and buyers do or fail to do, for items that are late, lost, damaged or not as described, or for losses from payments made outside PairPlug. <strong>None of this limits rights you have under consumer-protection law or your agreement with your bank or card issuer that cannot legally be limited.</strong> Where the law does not allow a limit, that limit does not apply to you.</p>
<h2>11. Ending your account</h2>
<p>You can stop using PairPlug at any time. To close your account, contact us (see below); there is no self-service button yet. We may suspend or end accounts that break these terms. Orders, reports and similar records may be kept after an account ends (see the ${link('privacy', 'Privacy Policy')}).</p>
<h2>12. Changes to these terms</h2>
<p>We will update these terms as PairPlug changes. The version date is at the top of the page. When we record that you accepted the terms, we record which version. We will not treat an earlier acceptance as acceptance of a later version without asking you; if a change is significant we will ask you to review it in your account.</p>
<h2>13. Contact</h2>${contactBlock()}
<p class="muted small">Governing law and where disputes are heard have not been set for this beta. This section will be added once the operator's business details are final.</p>`;

S.privacy = () => `
<p class="lead">This explains what information PairPlug handles today, who can see it, and what you can ask us to do. It describes how the service actually works; where something doesn't exist yet, it says so.</p>
${operatorBlock()}
<h2>1. What we collect</h2>
<div class="tablewrap"><table><thead><tr><th>Information</th><th>When</th><th>Who can see it</th></tr></thead><tbody>
<tr><td><strong>Account:</strong> name, email, password (stored only as a salted hash), sign-up date, which terms version you accepted and when</td><td>Sign-up or invitation</td><td>You. Administrators can see name, email and role. Moderators (a small team with individual accounts) can see name, handle, role, join date and a <em>masked</em> email (only the first letter and the domain are shown), plus listings and any reports about the account. Your name appears to people you message and to sellers on orders; your first name only appears on reviews you write.</td></tr>
<tr><td><strong>Seller profile:</strong> store name, store URL (handle), bio, ship-from country/region/city, storefront text, images, links</td><td>Seller setup / storefront editor</td><td>Public: store name, handle, bio, storefront text and images, links, and your city/region/"Local ship" badge only if you chose to show it. Never your email.</td></tr>
<tr><td><strong>Listings:</strong> title, description, photos, price, size, brand, condition, shipping charge, your seller checkout link, optional cost and notes</td><td>When a seller lists</td><td>Public once published. Drafts, cost and internal notes are visible only to the seller.</td></tr>
<tr><td><strong>Messages:</strong> text of messages between a buyer and a seller</td><td>When you message</td><td>The two people in the conversation. PairPlug staff can read a conversation <em>only</em> when one of you reports it, and each view is logged.</td></tr>
<tr><td><strong>Orders and shipping:</strong> items, prices, status, payment-confirmation notes, delivery name and address, carrier and tracking number</td><td>When a buyer starts a direct purchase</td><td>The buyer and the seller of that order. The seller sees the delivery address after they confirm payment. Not shown in public profiles, search, analytics or admin summaries.</td></tr>
<tr><td><strong>Recorded sales:</strong> sales a seller records themselves (including optional recipient address and buyer email they typed in)</td><td>When a seller records one</td><td>That seller only. The seller is responsible for having a reason to hold that person's details.</td></tr>
<tr><td><strong>Reviews:</strong> your thumbs-up, optional review text, the order it relates to, edit and removal history, and any reports on it</td><td>When you review an order, or report a review</td><td>Public: your first name, thumbs-up, review text and date appear on the seller's store (not your email, address or the order details). Staff (administrators and moderators) see your full display name and the history; moderators can hide or restore but not edit it.</td></tr>
<tr><td><strong>Follows, favorites, notifications:</strong> which sellers you follow, items you saved, in-app notifications</td><td>When you use them</td><td>You. We do not show how many followers a seller has, and nobody sees who you follow. A seller's follower list is not shown to them. We use follows to send you in-app "new from…" notices; no email is sent for those.</td></tr>
<tr><td><strong>Reports and cases:</strong> reasons, category, evidence photos, replies, decisions, internal notes, any account restriction and any report PairPlug sent to a payment provider</td><td>When you report or open a case, or when we act on one</td><td>You, the other party to an <em>order</em> case (not to a general seller report), and PairPlug staff (administrators and moderators). Internal notes and restriction reasons are staff-only. A seller you report is not told who reported them, though an order case necessarily involves the buyer.</td></tr>
<tr><td><strong>Search terms:</strong> only the words searched, with the time</td><td>When someone searches on /shop</td><td>Staff with database access. Not linked to your account or IP address (see section 3).</td></tr>
<tr><td><strong>Sessions and security:</strong> a login cookie (random token, stored hashed), an audit log of important account/admin actions</td><td>When you log in or something sensitive happens</td><td>Staff.</td></tr>
</tbody></table></div>
<p><strong>Cookies.</strong> PairPlug sets one cookie, <code>pp_session</code>, to keep you logged in (up to 14 days of inactivity). It is needed for the service to work. We do not use advertising or analytics cookies and have no third-party trackers on our pages.</p>
<h2>2. How we use it</h2>
<p>To run accounts, show listings and storefronts, let buyers and sellers message and track orders, send in-app notifications, handle reports, keep the service safe (for example rate-limiting and banning abusive accounts), and fix problems. We do not sell your personal information and we do not use it for advertising.</p>
<h2>3. Search activity</h2>
<p>We keep the words people search for (not who searched), only for ordinary searches, after removing things that look personal (emails, web addresses, long numbers). A search term is shown as a "Popular search" only when at least 3 searches for it were made in the last 14 days. Entries older than 30 days are deleted automatically. To stop one person from inflating the counts, the server briefly compares a scrambled value derived from the connecting address in memory only; it is never written to the database.</p>
<h2>4. Who we share it with</h2>
<ul><li><strong>Other users</strong> as described in the table above. If you buy, the seller receives your delivery name and address so they can ship.</li>
<li><strong>Seller payment providers.</strong> When you pay, you leave PairPlug and go to the seller's own checkout page (often Stripe). That provider collects your payment details under its own privacy policy. PairPlug never sees your card number.</li>
<li><strong>Email service.</strong> If PairPlug is configured to send email (for example verification or password-reset links), the recipient address and message go through the email provider the operator configures (currently Resend is the only supported provider). When no provider is configured, nothing is emailed.</li>
<li><strong>Hosting.</strong> The service runs on infrastructure chosen by the operator, which stores the database and uploaded images. The operator has technical access to that data.</li>
<li><strong>Shipping labels.</strong> PairPlug does not buy labels or send addresses to shipping providers in the live beta; sellers ship by their own means and enter tracking by hand. (A test-only label feature exists in development and uses no real customers.)</li>
<li><strong>Payment providers (fraud reports).</strong> If we suspect payment fraud we may send the seller's payment provider (for example Stripe or PayPal) a report containing the relevant order references, amounts, dates, written statements and photos from the case, and the seller's PairPlug store details. The operator sends it by hand; it excludes internal notes and, unless needed and you agree, your delivery address and email. We cannot see what the provider does with it.</li>
<li><strong>Legal and safety.</strong> We may disclose information if the law requires it or to prevent fraud or serious harm.</li></ul>
<h2>5. Security</h2>
<p>Passwords are hashed with scrypt; login tokens are stored hashed; forms are protected against cross-site requests; uploaded images are checked and stored under random names; messages and addresses are available only to the people listed above. Production traffic is expected to use HTTPS. No system is perfectly secure and we cannot promise it. <strong>Things we have not done yet:</strong> photos keep whatever hidden metadata (such as GPS location) your camera embedded, because we do not strip it, so remove location data before uploading if that matters to you; and we have not encrypted the database at the application level.</p>
<h2>6. How long we keep things</h2>
<ul><li>Login sessions: expire after 14 days without use; expired sessions are deleted.</li>
<li>Search terms: deleted after 30 days.</li>
<li>Email verification and reset links: expire after 48 hours / 1 hour.</li>
<li>Reviews you remove stay in our records (marked removed, not shown); hidden reviews stay with the moderation history.</li>
<li>Accounts, listings, messages, orders, shipping details, reports, notifications and the audit log: <strong>kept until we delete them on request or when we clean up; we have not set an automatic deletion schedule yet.</strong> Order and report records may be kept after an account closes so that the other party's records, dispute handling, fraud prevention and any legal or tax obligations still work.</li></ul>
<h2>7. Your choices and requests</h2>
<ul><li>You can edit your name in your account, unfollow sellers, remove favorites and manage your storefront at any time.</li>
<li>You can ask us for a copy of your information, a correction, or deletion of your account. <strong>There is no self-service download or delete button yet</strong>; contact us and we handle it by hand. We may keep what we need for the reasons in section 6 and will tell you what we kept. We have not yet set a deadline for responding.</li>
<li>Messages and addresses you already sent to another user cannot be un-sent from their records by us, though you can ask us to help.</li></ul>
<p class="muted small">Specific rights under laws such as those in California, Canada or Mexico depend on where you live and on how PairPlug is registered; those details have not been finalised for this beta. We do not claim compliance with any particular regulation.</p>
<h2>8. Children</h2>
<p>PairPlug is not intended for children and we do not knowingly collect information from them.</p>
<h2>9. Contact and privacy requests</h2>${contactBlock()}
<h2>10. Changes</h2><p>If we change this policy we will update the date at the top. Material changes will be flagged in your account.</p>`;

S.payments = () => `
<p class="lead">Short version: during the private beta <strong>you pay the seller through their external checkout, not PairPlug</strong>. PairPlug does not currently hold or directly control those funds, and does not refund or insure them. <strong>If an issue arises you can contact PairPlug:</strong> we may review the order, contact the seller, and report the problem to the payment processor with the evidence we have. We cannot promise a refund or recovery.</p>
<h2>1. How buying works</h2>
<ol><li>You open a listing and choose "Continue to seller checkout". You confirm that you understand you are paying the seller directly and enter your delivery address. The item is reserved for you for a limited time.</li>
<li>You are sent to <strong>the seller's own checkout page</strong> (a third-party payment page the seller controls, such as a Stripe Payment Link). You pay there.</li>
<li>The seller checks their own payment account, then marks the order <em>payment confirmed</em> on PairPlug and ships. Until then the order says "awaiting payment confirmation".</li>
<li>The seller adds a carrier and tracking number when they ship. You mark the order received when it arrives.</li></ol>
<p><strong>If you paid and the seller does not confirm, never ships, or you think it is a scam,</strong> you can report it from the order page even before the seller confirms payment (once you have opened the seller's payment link or said you paid). Keep your receipt and screenshots.</p>
<h2>1a. Does the amount match? Please check.</h2>
<p>PairPlug shows the item price and shipping before you reserve an item, and records them on your order. But <strong>the seller's payment page is a separate service that PairPlug cannot set, read or verify</strong>: a payment link has its own fixed price. To reduce mismatches, sellers may only use Stripe-hosted Payment Links, must confirm that their link charges exactly item price plus shipping, and online checkout is paused for a listing until they do (and again whenever they change the price, shipping or link). That confirmation is the seller's statement; PairPlug checks only the link's address and does not verify the amount. <strong>Before you pay, make sure the seller's page shows the same total as your order.</strong> If it shows a different amount, a different item, or a "test mode" or "sandbox" notice, do not pay: cancel the purchase and use <a href="/support#payment-mismatch">Report a payment mismatch</a>. If you already paid a wrong amount, contact the seller and your payment provider; PairPlug cannot correct or refund it.</p>
<h2>2. What PairPlug does not do</h2>
<ul><li><strong>PairPlug does not currently hold, process or directly control the payment</strong> and is not an escrow, bank or payment institution. PairPlug takes no commission (0%); the seller's payment provider, such as Stripe, may charge the seller its own processing fees.</li>
<li><strong>An order on PairPlug is not proof of payment.</strong> Creating an order, clicking "pay", or telling us you paid does not make it paid. PairPlug cannot see the seller's payment account.</li>
<li><strong>A seller's "payment confirmed" is the seller's statement, not a check by PairPlug.</strong> Sellers can also record sales made elsewhere; those records are the seller's statements too.</li>
<li>We do not guarantee delivery, authenticity or condition, and we do not offer a buyer-protection programme.</li>
<li>Reviews on a seller's store are opinions from buyers who marked an order received. They are not verified payments or guarantees.</li></ul>
<h2>3. Refunds</h2>
<ul><li><strong>The seller decides and issues refunds</strong>, using their own payment provider. PairPlug cannot send or reverse a payment.</li>
<li>After the seller has confirmed your payment you can ask for a refund or (before shipping) a cancellation from your order page. The seller is notified and can respond. When the seller says they refunded you, PairPlug records that statement and asks you to confirm; PairPlug does not verify the money moved.</li>
<li>If a refund is disputed, PairPlug support can mark it verified in our records when the evidence supports it. That records what happened; it does not make a refund happen.</li>
<li>Sellers set their own return and refund practices in their listings and messages. Please read the listing and ask before you buy.</li></ul>
<h2>4. Chargebacks and card disputes</h2>
<p>You may have rights through your bank or card issuer and the payment provider, which handle chargebacks and fraud claims under their own rules. <strong>PairPlug is not a party to those claims and cannot start, win or reverse them.</strong> Sellers are responsible for responding to chargebacks and for any fees. If you open a card dispute, tell us so we can note it on any open case. Nothing here limits your right to dispute a charge with your bank or card issuer.</p>
<h2>5. Reporting a scam, and what PairPlug does about it</h2>
<ul><li><strong>PairPlug accepts and investigates reports</strong> of suspected scams: open a case from your order page, or report a seller (with an optional related order) from the <a href="/support">Help &amp; reporting page</a>. You can attach photos and screenshots; messages, order records and tracking entered by the seller are available to support. Both sides can add explanations on an order case; the seller is not told about a general seller report.</li>
<li>When a report comes in we keep the order record, tracking details entered by the seller, the messages between you and the seller, and any photos or screenshots as the case record. PairPlug support reviews the evidence, contacts you and the seller to ask questions, and records an outcome (resolved or dismissed) with a written note. The case, evidence and actions are kept as a record.</li>
<li><strong>What we can do on PairPlug:</strong> pause listings, <strong>restrict a seller's ability to sell</strong> (listings paused, no new orders, store hidden, and buyers with unpaid orders warned not to pay), suspend accounts, limit access, and read a reported conversation (each view is logged). We may do these while a report is still being investigated, and may undo them if the report is not borne out.</li>
<li><strong>Reports to payment providers:</strong> where we suspect payment fraud we may send the relevant payment provider a factual report with the evidence we hold (order references, amounts, dates, written statements and photos relevant to the report). The operator prepares and sends this by hand through the provider's own reporting channel; it is not automatic, we cannot see or control what the provider does with it, and we make no promise that a provider will act. We do not send your delivery address or email unless it is needed and we have asked you.</li>
<li><strong>What we cannot do:</strong> PairPlug has no access to sellers' Stripe, PayPal or other payment accounts. We <strong>cannot freeze, hold, reverse or refund money</strong> there, force a seller to refund, recover funds, or promise an outcome. A restriction or suspension on PairPlug is not a financial hold: it does not stop a seller's payment link from working outside PairPlug.</li>
<li><strong>What you may need to do yourself:</strong> contact the seller, and contact your payment provider or card issuer about disputes, chargebacks or refunds. Do that promptly, because providers have time limits that PairPlug cannot extend. There is no guaranteed response time from PairPlug, and no buyer-protection programme or insurance.</li>
<li>A restricted or suspended seller's "payment confirmed" statements remain their own statements; PairPlug has not verified them.</li></ul>
<h2>6. Shipping and tracking</h2>
<p>Sellers ship by their own means and enter the carrier and tracking number. Tracking shows what a carrier reports; it is not proof of delivery or of what is inside the package. The buyer, not the seller, marks an order delivered. Shipping costs are set by the seller in the listing and shown before you check out.</p>
<h2>7. Taxes</h2>
<p>Sellers are responsible for any sales tax or income tax they owe. PairPlug does not collect or remit tax on direct sales.</p>
<h2>8. Protect yourself</h2>
<ul><li>Pay only through the checkout link PairPlug sends you to from the order page. Be cautious if anyone asks you to pay somewhere else.</li>
<li>Keep your payment receipt and order number.</li>
<li>Message the seller first; most problems are solved there. Sellers aim to reply within 48 hours, which is an expectation, not a guarantee.</li></ul>
<h2>9. Contact</h2>${contactBlock()}`;

S.rules = () => `
<h2>1. Prohibited items</h2>
<p>You may not list, sell or ask for:</p>
<ul><li><strong>Counterfeit, replica or "inspired by" items</strong> that use another brand's name, logo or trade dress to pass as the real thing, and anything you cannot honestly say is authentic.</li>
<li><strong>Stolen goods</strong>, or anything you have reason to think was stolen or obtained by fraud.</li>
<li><strong>Weapons</strong>, ammunition and explosives; drugs, drug paraphernalia and controlled substances; alcohol, tobacco and vapes.</li>
<li><strong>Items that are illegal</strong> to sell or ship where you or the buyer are, recalled items, and items containing hazardous materials.</li>
<li><strong>Personal data or accounts</strong>: gift cards, codes, accounts, or other people's information.</li>
<li><strong>Anything hateful, sexually explicit or that exploits people</strong>, and items that promote violence.</li>
<li><strong>Services, tickets or digital goods.</strong> PairPlug is for physical clothing, shoes, bags and accessories, new or pre-owned.</li>
</ul>
<h2>2. Honest listings</h2>
<ul><li>Use real photos of the actual item; show flaws. Do not use another seller's photos.</li>
<li>State brand, size and condition accurately. Say if there are no tags, repairs or odours.</li>
<li>Do not claim authentication or PairPlug endorsement you do not have. PairPlug does not authenticate items and sellers may not say or imply that it does, or that PairPlug guarantees, escrows or protects a purchase.</li>
<li>Set a fair, honest price and shipping charge. Do not change the price after a buyer has started to buy.</li>
<li><strong>Stripe checkout links only.</strong> During the beta a listing's payment link must be a Stripe-hosted Payment Link (<code>buy.stripe.com</code>) that charges the listing price plus the disclosed shipping. You confirm that when you save a listing, and have to confirm again after changing the price, shipping or link. Your confirmation is your own statement: PairPlug checks the link's address but cannot see what Stripe will charge, and a Stripe link is not automatically correct or safe.</li>
<li><strong>Quantity.</strong> Set the number of units you really have. Each order takes one unit, an unpaid reservation gives it back, and the item shows as sold when none is left.</li></ul>
<h2>3. Seller responsibilities</h2>
<ul><li><strong>Own it, ship it.</strong> Only list items you own and have in hand. Ship within the time you promise (and within a reasonable time if you promise none), packed so it arrives in good shape.</li>
<li><strong>Use tracking</strong> where you can. Enter the real carrier and tracking number on the order. Don't enter a made-up number.</li>
<li><strong>Confirm payment honestly.</strong> Mark an order paid only once the money is in your own account. If you did not receive payment, tell PairPlug so the item is released. You are responsible for checking your own payment dashboard.</li>
<li><strong>Communicate.</strong> Reply to buyer messages, aiming for 48 hours. Tell buyers promptly about delays.</li>
<li><strong>Refunds and chargebacks are yours.</strong> You decide and issue refunds through your payment provider, answer chargebacks and pay any provider fees. If you say you refunded someone, you must have.</li>
<li><strong>Protect buyer information.</strong> Use buyers' names, addresses and emails only to complete that sale. Do not share them, use them for marketing, or keep them longer than you need to for records.</li>
<li><strong>Follow the law</strong> including tax, consumer-protection, import/export and shipping rules in your country.</li>
<li><strong>No off-platform pressure</strong>, fake reviews, or tricks to avoid the dispute process.</li></ul>
<h2>3a. Reviews</h2>
<p>Only review orders you actually placed and received. Do not write, trade or pay for fake or incentivised reviews, do not review your own or a friend's store, and do not use reviews for ads, threats or personal information. Sellers must not pressure buyers for positive reviews. Report a review from the seller's store if it breaks these rules; moderators can hide it and the reason is recorded.</p>
<h2>4. Fraud and abuse</h2>
<p>Do not run scams: taking payment without shipping, fake tracking, fake "payment confirmed" or "refunded" statements, phishing links, asking buyers to pay somewhere other than your approved checkout, or opening multiple accounts to evade a ban. Buyers must not make false claims or false payment statements either.</p>
<h2>4a. Wrong or misleading payment links</h2>
<p>Incorrect, misleading or unrelated payment links, or a link whose amount does not match the listing price plus shipping, may lead to listing removal, selling restrictions, or a selling suspension of up to ${require('./paymentPolicy').maxSuspensionDays()} days, depending on the circumstances. Nothing is applied automatically because of a link address or a single complaint: staff review the case, and a suspension needs a documented reason from authorised staff. Mistakes happen, so you can <a href="/dashboard/appeal">appeal</a> and staff will look again. Suspensions affect your PairPlug account only; they do not touch your Stripe account or any money in it. Serious or repeated fraud can still lead to a ban (see section 6).</p>
<h2>5. Reporting a violation</h2>
<p>If you see a prohibited or misleading listing, a seller you think is committing fraud, or an abusive message, report it: use <strong>Report a seller</strong> or <strong>Report</strong> on a message from the <a href="/support">Help &amp; reporting page</a> (you need to be logged in). You can attach screenshots and name the related order. There is no one-click "report this listing" button yet; name the listing in your report. You can also use the contact details below.</p>
<h2>6. What happens</h2>
<p>PairPlug reviews reports as the founder's time allows (there is no guaranteed response time). We may remove a listing, restrict selling while we investigate, suspend a seller, limit access, or end an account, with or without warning where there is a risk to others. If we suspect payment fraud we may report it to the payment provider with the evidence we hold, and we may share information with law enforcement when the law requires or permits it. These steps affect PairPlug accounts only; they do not freeze or recover money in a seller's payment account. See ${link('payments')}.</p>
<h2>7. Contact</h2>${contactBlock()}`;

function render(key) {
  const p = PAGES.find((x) => x.key === key);
  return { title: p.title, description: p.blurb, body: `<article class="legal"><h1>${esc(p.title)}</h1>
<p class="muted small">Version ${esc(VERSION)} · Last updated ${esc(UPDATED)} · <a href="/legal">All policies</a></p>
<div class="panel notice" style="margin:12px 0"><strong>PairPlug is in a private beta.</strong> These pages describe how the service works today. In plain words, not legal advice. If anything is unclear, ask us.</div>
${S[key]()}</article>` };
}
function index() {
  return { title: 'Legal & policies', description: 'PairPlug terms, privacy, payments and seller rules.', body: `<article class="legal"><h1>Legal &amp; policies</h1><p class="muted small">Version ${esc(VERSION)} · Last updated ${esc(UPDATED)}</p>
<p>Questions, scam reports and appeals: email ${require('./views').contactLink()}.</p>
<div class="sgrid">${PAGES.map((p) => `<a class="scard" href="${p.path}"><strong>${esc(p.title)}</strong><span class="muted small">${esc(p.blurb)}</span></a>`).join('')}</div></article>` };
}
const accepted = (u) => Boolean(u && u.terms_version === VERSION && u.terms_accepted_at);
/** Record an explicit acceptance of the current policy set. Only ever called from an action the user took. */
async function recordAcceptance(userId) {
  const { q, now } = require('./db');
  await q.run('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?', VERSION, now(), Number(userId));
}
/** Small inline link strip used at sign-up, listing, checkout and in the footer. */
const links = (keys = ['terms', 'privacy', 'payments', 'rules']) => keys.map((k) => link(k)).join(' · ');

module.exports = { accepted, recordAcceptance, VERSION, UPDATED, PAGES, render, index, links, link };
