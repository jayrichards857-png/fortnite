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
const icon = (n, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

const img = (file, cls = '', alt = '') => (file ? `<img class="${cls}" src="/uploads/${esc(file)}" alt="${esc(alt)}" loading="lazy">` : `<div class="${cls} noimg" aria-label="No photo"></div>`);

function header(user, path, counts, wide) {
  const cats = config.categories.map(([s, n]) => `<a href="/shop?category=${s}">${esc(n)}</a>`).join('');
  const link = (href, label, match) => `<a href="${href}"${path === match || (match !== '/' && path.startsWith(match)) ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="site-header">
  <div class="wrap${wide ? ' wide' : ''} bar">
    <a class="wordmark" href="/" aria-label="PairPlug home">PairPlug</a>
    <nav class="nav" aria-label="Main">
      ${link('/', 'Home', '/')}${link('/shop', 'Shop', '/shop')}
      <details class="dd"><summary>Categories</summary><div class="dd-menu">${cats}</div></details>
      ${link(user && user.is_seller ? '/dashboard' : '/sell', 'Sell', user && user.is_seller ? '/dashboard' : '/sell')}
      ${user ? link('/orders', 'Orders', '/orders') : ''}
    </nav>
    <form class="hsearch" action="/shop" role="search"><label class="sr" for="hq">Search</label>
      <input id="hq" name="q" type="search" placeholder="Search brand, item, size…" autocomplete="off">
      <button aria-label="Search">${icon('search')}</button></form>
    <div class="actions">
      ${user ? `<a class="iconlink" href="/messages" aria-label="Messages">${icon('chat')}<b class="badge" id="hdr-msg-badge"${counts.messages ? '' : ' hidden'}>${counts.messages || ''}</b></a>
      <a class="iconlink" href="/favorites" aria-label="Favorites">${icon('heart')}</a>
      <a class="iconlink" href="/notifications" aria-label="Notifications">${icon('bell')}${counts.notifications ? `<b class="badge">${counts.notifications}</b>` : ''}</a>
      <details class="dd right"><summary class="iconlink" aria-label="Account">${icon('user')}</summary><div class="dd-menu">
        <span class="dd-title">${esc(user.display_name)}</span>
        <a href="/account">Account</a>${user.is_seller ? '<a href="/dashboard">Seller dashboard</a>' : ''}${user.is_admin ? '<a href="/admin">Admin</a>' : ''}
        <a href="/messages">Messages</a><a href="/orders">My orders</a><button type="button" data-logout>Log out</button></div></details>`
      : `<a class="btn small ghost" href="/login">Log in</a><a class="btn small" href="/register">Sign up</a>`}
      <a class="iconlink" href="/cart" aria-label="Cart">${icon('cart')}${counts.cart ? `<b class="badge">${counts.cart}</b>` : ''}</a>
      <details class="dd right mobile-only"><summary class="iconlink" aria-label="Menu">${icon('menu')}</summary><div class="dd-menu">
        <a href="/">Home</a><a href="/shop">Shop</a>${user && user.is_seller ? '<a href="/dashboard">Sell</a>' : '<a href="/sell">Sell</a>'}${user ? '<a href="/orders">Orders</a>' : ''}
        <span class="dd-title">Categories</span>${cats}</div></details>
    </div>
  </div>
</header>`;
}

function layout({ title, body, user, path = '/', description = '', wide = false, scripts = '' }) {
  const counts = user ? {
    cart: q.get('SELECT COUNT(*) n FROM cart_items WHERE user_id = ?', user.id).n,
    notifications: q.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).n,
    messages: require('./chat/service').unreadTotal(user.id),
  } : {};
  const sandbox = config.paymentsMode === 'sandbox' && !config.stripe.secretKey
    ? '<div class="banner">Sandbox mode — payments are simulated and no money moves.</div>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · PairPlug</title><meta name="description" content="${esc(description || 'Buy and sell secondhand clothing, sneakers and streetwear across North America.')}">
<link rel="stylesheet" href="/app.css"></head><body>
<a class="skip" href="#main">Skip to content</a>${sandbox}${header(user, path, counts, wide)}
<main id="main" class="wrap${wide ? ' wide' : ''}">${body}</main>
<footer class="site-footer"><div class="wrap"><span>PairPlug · North American secondhand marketplace</span>
<span><a href="/shop">Shop</a> · <a href="/sell">Sell</a> · <a href="/shop?sort=newest">New arrivals</a></span></div></footer>
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
    <div class="price">${money(l.price_cents)}</div>
    <a class="title" href="/listing/${l.id}">${esc(l.title)}</a>
    <div class="muted small">${l.brand ? esc(l.brand) + (meta ? ' · ' : '') : ''}${meta}</div>
    ${l.seller_handle ? `<a class="muted small seller" href="/s/${esc(l.seller_handle)}">${esc(l.seller_name || l.seller_handle)}</a>` : ''}
  </div></article>`;
}
const grid = (items, ctx) => `<div class="grid">${items.map((l) => card(l, ctx)).join('')}</div>`;

function empty(title, text, cta) {
  return `<div class="empty"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${cta ? `<a class="btn" href="${cta[0]}">${esc(cta[1])}</a>` : ''}</div>`;
}
const statusPill = (s) => `<span class="pill s-${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;

function pager(page, pages, params) {
  if (pages <= 1) return '';
  const href = (p) => { const u = new URLSearchParams(params); u.set('page', p); return '?' + u.toString(); };
  return `<nav class="pager" aria-label="Pagination">${page > 1 ? `<a class="btn ghost small" href="${href(page - 1)}">← Previous</a>` : '<span></span>'}
  <span class="muted small">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn ghost small" href="${href(page + 1)}">Next →</a>` : '<span></span>'}</nav>`;
}

function dashNav(path) {
  const items = [['/dashboard', 'Overview'], ['/dashboard/inventory', 'Inventory'], ['/dashboard/orders', 'Orders'], ['/dashboard/analytics', 'Analytics'], ['/dashboard/finance', 'Earnings & tax'], ['/dashboard/import', 'CSV import']];
  return `<nav class="subnav" aria-label="Seller dashboard">${items.map(([h, l]) => `<a href="${h}"${path === h ? ' aria-current="page"' : ''}>${l}</a>`).join('')}
    <a class="btn small push" href="/dashboard/listings/new">${icon('plus')} New listing</a></nav>`;
}

module.exports = { layout, card, grid, empty, icon, img, statusPill, pager, dashNav, money, esc, date };
