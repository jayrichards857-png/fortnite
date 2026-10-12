'use strict';
const config = require('./config');
const { esc, money, date } = require('./util');
const { q } = require('./db');

const ICONS = {
  search: '<path d="M11 19a8 8 0 1 1 5.3-14A8 8 0 0 1 11 19zm10 2-4.3-4.3"/>',
  heart: '<path d="M12 20s-7-4.4-9-9.2C1.6 7.2 4 4 7.2 4c1.9 0 3.4 1 4.8 2.8C13.4 5 14.900 4 16.800 4 20 4 22.400 7.200 21 10.800 19 15.600 12 20 12 20z"/>',
  cart: '<path d="M3 4h2l2.500 11h11L21 7H6"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  bell: '<path d="M6 17V11a6 6 0 1 1 12 0v6l2 2H4zM10 21h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  truck: '<path d="M2 6h11v10H2zM13 10h4l4 3v3h-8"/><circle cx="7" cy="17" r="1.500"/><circle cx="17" cy="17" r="1.500"/>',
};
/** The official contact address as a mailto: link. One place, used by every page. */
const contactLink = (text) => `<a href="mailto:${esc(config.supportEmail)}">${esc(text || config.supportEmail)}</a>`;
const SUBJECT = 'PairPlug Support';
/** mailto: draft in the visitor's default email app, and Gmail's web composer for visitors who use Gmail in a browser. Both only OPEN a draft; nothing is sent until the visitor sends it. */
const mailtoHref = (subject = SUBJECT) => `mailto:${config.supportEmail}?subject=${encodeURIComponent(subject)}`;
const gmailHref = (subject = SUBJECT) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(config.supportEmail)}&su=${encodeURIComponent(subject)}`;
/** The Contact page link used by every "Contact" button/link (header, footer, sign-in, sign-up, help, policies). */
const contactPageLink = (text = 'Contact') => `<a href="/contact">${esc(text)}</a>`;
const icon = (n, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

const IMG_DIMS = { thumb: [44, 55], 'avatar-img': [92, 92], 'banner-img': [1200, 300], 'logo-img': [180, 44] };      // intrinsic size hints (reserve space before the photo loads); CSS still controls the rendered size
const img = (file, cls = '', alt = '') => { const [w, h] = IMG_DIMS[String(cls).split(' ')[0]] || [400, 500]; return file ? `<img class="${cls}" src="/uploads/${esc(file)}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async">` : `<div class="${cls} noimg" role="img" aria-label="No photo"></div>`; };

/** "Selling available <date>" — the date comes from PUBLIC_RELEASE_DATE; without one we say "very soon" rather than invent a date. */
function releaseText() {
  if (!config.releaseDate) return 'very soon';
  const [y, m, d] = config.releaseDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
/** kind 'sell': the Sell page for everyone who is not an approved seller. kind 'signup': buyer sign-up switched off (SIGNUPS=closed). */
function comingSoon(kind = 'sell') {
  const when = config.releaseDate ? `<p class="lead">Selling available <strong>${esc(releaseText())}</strong>.</p>` : '<p class="lead">Selling opens very soon.</p>';
  if (kind === 'signup') return `<div class="soon-card"><span class="pill s-pending_payment">Private beta</span><h1>Coming Soon!</h1>${when}
    <p class="muted">PairPlug is opening step by step. Sign-ups are paused for now. Have an invitation? Open the link you were sent.</p>
    <p class="soon-actions"><a class="btn" href="/shop">Browse the shop</a> <a class="btn ghost" href="/login">Log in</a></p></div>`;
  return `<div class="soon-card"><span class="pill s-pending_payment">Private beta</span><h1>Coming Soon!</h1>${when}
    <p class="muted">Seller onboarding is currently limited while PairPlug prepares its private beta. A small group of invited sellers is getting set up first, and everyone else can shop in the meantime.</p>
    <p class="soon-actions"><a class="btn" href="/shop">Back to shopping</a> <a class="btn ghost" href="/login">Log in</a>${config.signups === 'open' ? ' <a class="btn ghost" href="/register">Sign up to buy</a>' : ''}</p>
    <p class="small muted">Already approved as a beta seller? Log in and your seller dashboard opens automatically.</p></div>`;
}
function header(user, path, counts, wide) {
  const cats = config.categories.map(([s, n]) => `<a href="/shop?category=${s}">${esc(n)}</a>`).join('');
  const link = (href, label, match) => `<a href="${href}"${path === match || (match !== '/' && path.startsWith(match)) ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="site-header">
  <div class="wrap${wide ? ' wide' : ''} bar">
    <a class="wordmark" href="/" aria-label="PairPlug home">PairPlug</a>
    <nav class="nav" aria-label="Main">
      ${link('/', 'Home', '/')}${link('/shop', 'Shop', '/shop')}${link('/sellers', 'Sellers', '/sellers')}${link('/contact', 'Contact', '/contact')}
      <details class="dd"><summary>Categories</summary><div class="dd-menu">${cats}</div></details>
      ${link(user && user.is_seller ? '/dashboard' : '/sell', 'Sell', user && user.is_seller ? '/dashboard' : '/sell')}
      ${user ? link('/orders', 'Orders', '/orders') : ''}
    </nav>
    <form class="hsearch" action="/shop" role="search"><label class="sr" for="hq">Search</label>
      <input id="hq" name="q" type="search" placeholder="Search brand, item, size…" autocomplete="off">
      <button aria-label="Search">${icon('search')}</button></form>
    <div class="actions">
      ${user ? `<a class="iconlink" href="/messages" aria-label="Messages">${icon('chat')}<b class="badge" id="hdr-msg-badge"${counts.messages ? '' : ' hidden'}>${counts.messages || ''}</b></a>
      <a class="iconlink hide-m" href="/favorites" aria-label="Favorites">${icon('heart')}</a>
      <a class="iconlink" href="/notifications" aria-label="Notifications">${icon('bell')}${counts.notifications ? `<b class="badge">${counts.notifications}</b>` : ''}</a>
      <details class="dd right hide-m"><summary class="iconlink" aria-label="Account">${icon('user')}</summary><div class="dd-menu">
        <span class="dd-title">${esc(user.display_name)}</span>
        <a href="/account">Account</a>${user.is_seller ? '<a href="/dashboard">Seller dashboard</a>' : ''}${user.is_admin ? '<a href="/admin">Admin</a>' : ''}
        <a href="/messages">Messages</a><a href="/following">Following</a><a href="/orders">My orders</a><button type="button" data-logout>Log out</button></div></details>`
      : `<a class="btn small ghost hide-m" href="/login">Log in</a>${config.signups === 'open' ? '<a class="btn small" href="/register">Sign up</a>' : '<a class="btn small ghost soon-pill hide-m" href="/register">Coming soon</a>'}`}
      ${config.checkoutMode === 'platform' ? `<a class="iconlink" href="/cart" aria-label="Cart">${icon('cart')}${counts.cart ? `<b class="badge">${counts.cart}</b>` : ''}</a>` : ''}
      <details class="dd right mobile-only"><summary class="iconlink" aria-label="Menu">${icon('menu')}</summary><div class="dd-menu">
        <a href="/">Home</a><a href="/shop">Shop</a><a href="/sellers">Sellers</a><a href="/contact">Contact</a>${user && user.is_seller ? '<a href="/dashboard">Sell</a>' : '<a href="/sell">Sell</a>'}${user ? '<a href="/orders">My orders</a>' : ''}
        ${user ? `<span class="dd-title">${esc(user.display_name)}</span><a href="/account">Account</a><a href="/favorites">Favorites</a><a href="/following">Following</a>${user.is_seller ? '<a href="/dashboard">Seller dashboard</a>' : ''}${user.is_admin ? '<a href="/admin">Admin</a>' : ''}<button type="button" data-logout>Log out</button>` : `<a href="/login">Log in</a>${config.signups === 'open' ? '<a href="/register">Sign up</a>' : ''}`}
        <span class="dd-title">Categories</span>${cats}</div></details>
    </div>
  </div>
</header>
<form class="msearch mobile-only" action="/shop" role="search"><label class="sr" for="hq-m">Search</label>
  <input id="hq-m" name="q" type="search" placeholder="Search brand, item, size…" autocomplete="off" enterkeyhint="search"><button aria-label="Search">${icon('search')}</button></form>`;
}

async function layout({ title, body, user, path = '/', description = '', wide = false, scripts = '', head = '' }) {
  const counts = user ? {
    cart: (await q.get('SELECT COUNT(*) n FROM cart_items WHERE user_id = ?', user.id)).n,
    notifications: (await q.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id)).n,
    messages: await require('./chat/service').unreadTotal(user.id),
  } : {};
  const sandbox = config.paymentsMode === 'sandbox' && !config.stripe.secretKey && config.checkoutMode === 'platform'
    ? '<div class="banner">Sandbox mode — payments are simulated and no money moves.</div>' : '';
  const testData = config.sandbox ? '<div class="banner warn-banner" role="status"><strong>SHIPPING SANDBOX — TEST DATA ONLY.</strong> Nothing here is a real customer, payment or order. Labels are Shippo test labels and are not valid postage.</div>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><meta name="theme-color" content="#faf9f6"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%277%27 fill=%27%231f4d36%27/%3E%3Ctext x=%2716%27 y=%2722.5%27 font-family=%27Arial,sans-serif%27 font-size=%2719%27 font-weight=%27700%27 fill=%27white%27 text-anchor=%27middle%27%3EP%3C/text%3E%3C/svg%3E">
<title>${esc(title)} · PairPlug</title><meta name="description" content="${esc(description || 'PairPlug — The Clothing Marketplace. Discover independent sellers, find your next favorite piece, and follow the stores bringing fresh drops.')}">
<link rel="stylesheet" href="/app.css">${head}</head><body>
<a class="skip" href="#main">Skip to content</a>${sandbox}${testData}${user && user.selling_restricted_at ? `<div class="banner warn-banner" role="alert"><strong>Selling is paused on your account</strong>${user.selling_restricted_until ? ` until ${new Date(user.selling_restricted_until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' while PairPlug reviews a report'}. You can still log in, reply to PairPlug and handle existing orders. <a href="/dashboard/appeal">Appeal this decision</a> · <a href="/support">Help &amp; reporting</a></div>` : ''}${user && user.is_seller && !user.email_verified_at ? '<div class="banner warn-banner">Verify your email to publish listings and receive orders. <a href="/account">Verify now</a></div>' : ''}${header(user, path, counts, wide)}
<main id="main" class="wrap${wide ? ' wide' : ''}">${body}</main>
<footer class="site-footer"><div class="wrap"><span>PairPlug · The Clothing Marketplace</span>
<span><a href="/shop">Shop</a> · <a href="/sell">Sell</a> · <a href="/shop?sort=newest">New arrivals</a> · <a href="/support">Help</a> · ${contactPageLink('Contact')}</span>
<nav class="legal-links" aria-label="Legal"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/payments">Payments &amp; refunds</a> · <a href="/rules">Seller rules</a></nav></div></footer>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script src="/app.js" defer></script>${scripts}</body></html>`;
}

function card(l, { favs = new Set(), user = null } = {}) {
  const fav = favs.has(l.id);
  const meta = [l.size && `Size ${esc(l.size)}`, l.condition && config.conditions[l.condition]].filter(Boolean).join(' · ');
  return `<article class="card">
  <a class="card-img" href="/listing/${l.id}">${img(l.image, '', l.title)}</a>
  <button class="fav${fav ? ' on' : ''}" data-fav="${l.id}" aria-pressed="${fav}" aria-label="${fav ? 'Remove from favorites' : 'Save to favorites'}">${icon('heart')}</button>
  <div class="card-body">
    <div class="price">${money(l.price_cents)}${l.status === 'active' && l.quantity > 1 ? ` <span class="qty-badge">${l.quantity} left</span>` : ''}</div>
    <a class="title" href="/listing/${l.id}">${esc(l.title)}</a>
    <div class="muted small">${l.brand ? esc(l.brand) + (meta ? ' · ' : '') : ''}${meta}</div>
    ${l.seller_handle ? `<a class="muted small seller" href="/s/${esc(l.seller_handle)}">${esc(l.seller_name || l.seller_handle)}</a>` : ''}
  </div></article>`;
}
const grid = (items, ctx) => `<div class="grid">${items.map((l) => card(l, ctx)).join('')}</div>`;

function empty(title, text, cta) {
  return `<div class="empty"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${cta ? `<a class="btn" href="${cta[0]}">${esc(cta[1])}</a>` : ''}</div>`;
}
const EXT_LABEL = { pending_payment: 'Awaiting payment confirmation', paid: 'Payment confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded' };
/** Status pill that never overstates what we know: direct orders are "awaiting payment confirmation" until the seller confirms. */
const orderPill = (o) => `<span class="pill s-${esc(o.status)}">${esc(o.payment_mode === 'external' ? EXT_LABEL[o.status] || o.status : String(o.status).replace('_', ' '))}</span>`;
const statusPill = (s) => `<span class="pill s-${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;

function pager(page, pages, params) {
  if (pages <= 1) return '';
  const href = (p) => { const u = new URLSearchParams(params); u.set('page', p); return '?' + u.toString(); };
  return `<nav class="pager" aria-label="Pagination">${page > 1 ? `<a class="btn ghost small" href="${href(page - 1)}">← Previous</a>` : '<span></span>'}
  <span class="muted small">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn ghost small" href="${href(page + 1)}">Next →</a>` : '<span></span>'}</nav>`;
}

function dashNav(path) {
  const items = [['/dashboard', 'Overview'], ['/dashboard/inventory', 'Inventory'], ['/dashboard/orders', 'Orders'], ['/dashboard/storefront', 'Storefront'], ['/dashboard/analytics', 'Analytics'], ['/dashboard/finance', config.checkoutMode === 'platform' ? 'Earnings & tax' : 'Earnings'], ['/dashboard/import', 'CSV import'], ['/dashboard/settings', 'Settings']];
  return `<nav class="subnav" aria-label="Seller dashboard">${items.map(([h, l]) => `<a href="${h}"${path === h ? ' aria-current="page"' : ''}>${l}</a>`).join('')}
    <a class="btn small push" href="/dashboard/listings/new">${icon('plus')} New listing</a></nav>`;
}

module.exports = { mailtoHref, gmailHref, contactPageLink, contactLink, releaseText, comingSoon, layout, card, grid, empty, icon, img, orderPill, statusPill, pager, dashNav, money, esc, date };
