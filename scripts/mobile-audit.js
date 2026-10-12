'use strict';
// Responsive / mobile audit. Seeds a throwaway marketplace (scripts/mobile/seed.js) on a disposable PostgreSQL database, then visits every
// page as each role in real Chromium at phone/tablet/desktop sizes and MEASURES the layout: horizontal overflow, elements poking outside the
// viewport, undersized touch targets, text too small, inputs that make iOS Safari zoom, controls without accessible names, images that can
// shift the layout, missing focus styles, low contrast. It writes artifacts/mobile/report.json (+ screenshots with --shots).
//   node scripts/mobile-audit.js [--viewports 320,375] [--roles anon,buyer] [--shots] [--mode platform] [--only /shop,/orders]
// Real iOS Safari / Android devices are NOT available in this environment: this uses Chromium with mobile emulation (viewport, touch,
// device pixel ratio, mobile UA). It cannot reproduce Safari-specific rendering or the on-screen keyboard.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; }, flag = (n) => args.includes(n);
process.env.CHECKOUT_MODE = opt('--mode', 'external'); process.env.PAYMENTS_MODE = process.env.PAYMENTS_MODE || 'sandbox'; process.env.SELLER_ONBOARDING = 'open';
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts', 'mobile');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const VIEWPORTS = {
  320: { width: 320, height: 568, dsf: 2, mobile: true }, 360: { width: 360, height: 800, dsf: 3, mobile: true }, 375: { width: 375, height: 667, dsf: 2, mobile: true },
  390: { width: 390, height: 844, dsf: 3, mobile: true }, 430: { width: 430, height: 932, dsf: 3, mobile: true }, 768: { width: 768, height: 1024, dsf: 2, mobile: true },
  1024: { width: 1024, height: 768, dsf: 2, mobile: false }, 1280: { width: 1280, height: 800, dsf: 1, mobile: false },
};
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Runs INSIDE the page. Returns plain data only. */
function measure(deviceWidth) {
  // the CONFIGURED device width, not window.innerWidth: on a mobile viewport Chrome widens innerWidth to fit overflowing content, which would hide the very bug we look for
  const vw = deviceWidth;
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const label = (el) => (el.getAttribute('aria-label') || el.value || el.textContent || el.getAttribute('title') || el.getAttribute('name') || '').toString().trim().replace(/\s+/g, ' ').slice(0, 36);
  const clipAnc = (el) => { for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p !== document.body) return p; } return null; };
  // content of a CLOSED <details> (menus, filters) is not on screen: ignore it (its <summary> still counts)
  const hiddenByDetails = (el) => { const d = el.parentElement && el.parentElement.closest('details:not([open])'); return Boolean(d) && !(el === d.querySelector(':scope > summary') || d.querySelector(':scope > summary').contains(el)); };
  const all = [...document.querySelectorAll('body *')].filter((el) => !el.closest('.sr,.skip') && vis(el) && !hiddenByDetails(el));
  const r = { vw, docOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw, title: document.title, lang: document.documentElement.lang, h1: document.querySelectorAll('h1').length,
    viewportMeta: (document.querySelector('meta[name=viewport]') || {}).content || null };
  // elements whose box leaves the viewport and that are not clipped/scrolled by an ancestor
  r.offenders = all.filter((el) => { const b = el.getBoundingClientRect(); return (b.right > vw + 1 || b.left < -1) && !clipAnc(el) && getComputedStyle(el).position !== 'fixed'; }).slice(0, 6).map((el) => ({ sel: sel(el), right: Math.round(el.getBoundingClientRect().right), text: label(el) }));
  // touch targets
  const tgt = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=menuitem]')].filter((el) => (vis(el) || (el.type && /checkbox|radio/.test(el.type))) && !hiddenByDetails(el));
  r.targets = { total: 0, small: [], inlineLinks: 0 };
  for (const el of tgt) {
    if (el.closest('.sr,.skip')) continue;
    let node = el;
    if (el.tagName === 'INPUT' && /checkbox|radio/.test(el.type)) { const l = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)); if (l) node = l; }
    if (!vis(node)) continue;
    const cs = getComputedStyle(node), b = node.getBoundingClientRect(); r.targets.total++;
    const inline = node.tagName === 'A' && cs.display === 'inline' && node.closest('p,li,dd,dt,td,th,small,div,span,h1,h2,h3,label,summary') && node.parentElement && /[A-Za-z0-9]/.test((node.parentElement.textContent || '').replace(node.textContent, '').trim());
    if (inline) { r.targets.inlineLinks++; continue; }
    // a link that merely repeats a bigger target to the same place (a product title next to its photo) is not a separate tap target
    if (node.tagName === 'A' && [...document.querySelectorAll('a[href]')].some((o) => o !== node && o.getAttribute('href') === node.getAttribute('href') && vis(o) && o.getBoundingClientRect().width >= 44 && o.getBoundingClientRect().height >= 44)) { r.targets.inlineLinks++; continue; }
    if (Math.min(b.width, b.height) < 43.5) r.targets.small.push({ sel: sel(node), w: Math.round(b.width), h: Math.round(b.height), text: label(node) });
  }
  // crushed text: a block of real text squeezed into a sliver (a flex/grid sibling took the room), one or two letters per line.
  // It never overflows, so the overflow checks cannot see it.
  r.crushed = [];
  // (its own element walk: a fully crushed box is 0px wide, which the visibility filter above treats as hidden)
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr,.skip') || hiddenByDetails(el)) continue;
    let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent; own = own.replace(/\s+/g, ' ').trim(); if (own.length < 14) continue;
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || (/^inline/.test(cs.display) && cs.display !== 'inline-block' && cs.display !== 'inline-flex')) continue;
    if (el.closest('[hidden]') || !el.getClientRects().length) continue;
    const b = el.getBoundingClientRect(), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    if (b.width < 64 && b.height > lh * 3.5) r.crushed.push({ sel: sel(el), w: Math.round(b.width), text: own.slice(0, 24) });
  }
  // text size
  r.fonts = { tiny: [], small: 0, nodes: 0 };
  for (const el of all) {
    let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent; if (!/\S/.test(own)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize); r.fonts.nodes++;
    if (fs < 12) r.fonts.tiny.push({ sel: sel(el), px: fs, text: own.trim().slice(0, 24) }); else if (fs < 14) r.fonts.small++;
  }
  // inputs: iOS zoom, names, autocomplete
  r.inputs = { zoom: [], noName: [], noAuto: [], total: 0 };
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]),select,textarea')) {
    if (!vis(el)) continue; r.inputs.total++;
    if (parseFloat(getComputedStyle(el).fontSize) < 16) r.inputs.zoom.push({ sel: sel(el), name: el.name || el.id, px: parseFloat(getComputedStyle(el).fontSize) });
    const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.labels && el.labels.length) || el.getAttribute('title');
    if (!named) r.inputs.noName.push({ sel: sel(el), name: el.name || el.id, placeholder: el.placeholder || '' });
    const n = (el.name || el.id || '').toLowerCase();
    const want = /email/.test(n) ? ['email'] : /(phone|tel)/.test(n) ? ['tel'] : /(zip|postal)/.test(n) ? ['postal-code'] : /password/.test(n) ? [] : null;
    if (want && want.length && el.tagName === 'INPUT' && !(want.includes(el.type) || want.includes(el.getAttribute('autocomplete')) || el.getAttribute('inputmode'))) r.inputs.noAuto.push({ sel: sel(el), name: n, type: el.type });
  }
  for (const el of document.querySelectorAll('button,a[href],summary,[role=button]')) {
    if (!vis(el) || el.closest('.sr,.skip')) continue;
    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim() || (el.querySelector('img[alt]') || {}).alt;
    if (!name) r.inputs.noName.push({ sel: sel(el), name: el.getAttribute('href') || '', placeholder: '(control without text or aria-label)' });
  }
  // controls a user can reach inside <main> (visible, or inside a closed <details> they can open). Compared against the desktop render
  // of the same page to catch actions that a phone rule hides by accident. The chat list/thread swap is a deliberate master/detail view.
  r.controls = [...document.querySelectorAll('main a[href],main button,main input:not([type=hidden]),main select,main textarea')]
    .filter((el) => !el.closest('.sr,.skip,.chat-list,.chat-thread') && (vis(el) || (el.type && /checkbox|radio/.test(el.type) && vis(el.parentElement)) || (hiddenByDetails(el) && vis(el.closest('details')))))
    .map((el) => [el.tagName.toLowerCase(), el.getAttribute('href') || el.getAttribute('data-post') || el.name || el.id || '', label(el)].join('|'));
  // images: layout-shift risk and lazy loading
  r.images = { total: 0, noDims: [], lazy: 0, noAlt: 0 };
  for (const im of document.querySelectorAll('img')) {
    if (!vis(im)) continue; r.images.total++;
    if (im.loading === 'lazy') r.images.lazy++; if (!im.hasAttribute('alt')) r.images.noAlt++;
    const ar = (e) => getComputedStyle(e).aspectRatio !== 'auto';
    if (!(im.hasAttribute('width') && im.hasAttribute('height')) && !ar(im) && !(im.parentElement && ar(im.parentElement)) && !(im.parentElement && ar(im.parentElement.parentElement || im.parentElement))) {
      const pb = im.parentElement.getBoundingClientRect(); if (!/(auto|scroll)/.test(getComputedStyle(im.parentElement).overflowY) || pb.height === 0) r.images.noDims.push({ sel: sel(im), w: Math.round(im.getBoundingClientRect().width), h: Math.round(im.getBoundingClientRect().height) });
    }
  }
  // focus visibility (sample)
  r.focus = { checked: 0, none: [] };
  for (const el of tgt.slice(0, 40)) { if (!vis(el)) continue; el.focus({ preventScroll: true }); const cs = getComputedStyle(el); r.focus.checked++; if (document.activeElement === el && cs.outlineStyle === 'none' && cs.boxShadow === 'none' && !/focus-within/.test('')) { const fv = el.matches(':focus-visible'); if (!fv) continue; r.focus.none.push({ sel: sel(el) }); } }
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  // contrast of text against the nearest opaque background (gradients/images skipped)
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r: R, g: G, b: B }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(R) + 0.7152 * f(G) + 0.0722 * f(B); };
  const bgOf = (el) => { let a = []; for (let p = el; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c.a > 0) { a.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255 }; for (const c of a.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; return base; };
  r.contrast = []; const seen = new Set(); let examined = 0;
  for (const el of all) {
    if (examined > 500) break; let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent; if (!/\S/.test(own)) continue; examined++;
    const cs = getComputedStyle(el), fg = parse(cs.color), bg = bgOf(el); if (!fg || !bg) continue;
    const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700, large = px >= 24 || (px >= 18.66 && bold);
    if (ratio < (large ? 3 : 4.5)) { const key = cs.color + '|' + `${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}` + '|' + px; if (!seen.has(key)) { seen.add(key); r.contrast.push({ sel: sel(el), ratio: Math.round(ratio * 100) / 100, color: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, px, text: own.trim().slice(0, 24) }); } }
  }
  return r;
}

async function main() {
  const H = require('../test/helpers'); const { seed } = require('./mobile/seed');
  await H.start();
  const data = await seed(H, { mode: process.env.CHECKOUT_MODE });
  const roles = opt('--roles', 'anon,buyer,buyer2,buyer3,seller,seller2,admin,mod').split(','), vps = opt('--viewports', '320,375,390,430,768,1280').split(',');
  const only = opt('--only') ? opt('--only').split(',') : null;
  const clientOf = { anon: data.clients.anon, buyer: data.clients.buyer, buyer2: data.clients.buyer2, buyer3: data.clients.buyer3, seller: data.clients.seller, seller2: data.clients.seller2, admin: data.clients.admin, mod: data.clients.mod };
  fs.mkdirSync(path.join(out, 'shots'), { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const report = { generatedAt: new Date().toISOString(), mode: process.env.CHECKOUT_MODE, viewports: vps, pages: [] };
  for (const vpName of vps) {
    const vp = VIEWPORTS[vpName]; if (!vp) throw new Error('unknown viewport ' + vpName);
    for (const role of roles) {
      const routes = [...(data.routes[role] || []), ...(role === 'buyer' ? data.routes.platformBuyer : [])].filter((r) => !only || only.some((o) => r === o || r.startsWith(o)));
      if (!routes.length) continue;
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile, userAgent: vp.mobile ? UA_MOBILE : undefined });
      const ck = clientOf[role].cookie; if (ck) await ctx.addCookies([{ name: ck.split('=')[0], value: ck.split('=').slice(1).join('='), url: H.base }]);
      const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120))); page.on('response', (r) => { if (r.status() >= 400 && !/nope-this-page/.test(r.url())) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
      for (const route of routes) {
        errors.length = 0;
        try {
          const resp = await page.goto(H.base + route, { waitUntil: 'networkidle', timeout: 20000 });
          await page.waitForTimeout(150);
          const m = await page.evaluate(measure, vp.width);
          report.pages.push({ vp: vpName, role, route, status: resp.status(), errors: [...errors], ...m });
          if (flag('--shots') && ['/', '/shop', `/listing/${data.ids.L1[1]}`, `/s/${data.ids.s1handle}`, '/orders', '/dashboard', '/login', '/messages', '/admin'].includes(route.split('?')[0]) || (flag('--allshots'))) await page.screenshot({ path: path.join(out, 'shots', `${vpName}-${role}-${route.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`), fullPage: true });
        } catch (e) { report.pages.push({ vp: vpName, role, route, status: 0, fatal: String(e.message).slice(0, 160) }); }
      }
      await ctx.close();
    }
  }
  await browser.close(); await H.stop();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  summarize(report);
}

function summarize(report) {
  const by = {}; for (const p of report.pages) (by[p.vp] ||= []).push(p);
  console.log(`\nAudited ${report.pages.length} page loads (${Object.keys(by).join(', ')} px). Report: artifacts/mobile/report.json\n`);
  const agg = (vp, f) => (by[vp] || []).reduce((s, p) => s + (f(p) || 0), 0);
  const desk = new Map(report.pages.filter((p) => p.vp === '1280' && p.controls).map((p) => [p.role + ' ' + p.route, p.controls]));
  const missing = (p) => {
    const d = Number(p.vp) <= 768 && p.controls && desk.get(p.role + ' ' + p.route); if (!d) return [];
    const have = new Map(); for (const k of p.controls) have.set(k, (have.get(k) || 0) + 1);
    const out = []; for (const k of d) { const n = have.get(k) || 0; if (n) have.set(k, n - 1); else out.push({ sel: k.split('|')[0], text: k.split('|')[2] || k.split('|')[1] }); }
    return out;
  };
  console.log('viewport | pages | non-200 | h-overflow pages | offender els | small targets | tiny fonts | iOS-zoom inputs | unnamed controls | noAuto | imgs w/o dims | low contrast | page errors | hidden-on-mobile controls | crushed text');
  for (const vp of Object.keys(by)) {
    const ps = by[vp], ok = ps.filter((p) => p.vw);
    console.log([vp.padStart(8), ps.length, ps.filter((p) => p.status !== 200 && p.route !== '/nope-this-page-does-not-exist').length, ok.filter((p) => p.docOverflow > 1).length, agg(vp, (p) => (p.offenders || []).length), agg(vp, (p) => (p.targets ? p.targets.small.length : 0)), agg(vp, (p) => (p.fonts ? p.fonts.tiny.length : 0)), agg(vp, (p) => (p.inputs ? p.inputs.zoom.length : 0)), agg(vp, (p) => (p.inputs ? p.inputs.noName.length : 0)), agg(vp, (p) => (p.inputs ? p.inputs.noAuto.length : 0)), agg(vp, (p) => (p.images ? p.images.noDims.length : 0)), agg(vp, (p) => (p.contrast ? p.contrast.length : 0)), agg(vp, (p) => (p.errors || []).length), by['1280'] ? agg(vp, (p) => missing(p).length) : 'n/a (needs 1280)', agg(vp, (p) => (p.crushed || []).length)].join(' | '));
  }
  const top = (name, pick, n = 12) => { const m = new Map(); for (const p of report.pages) for (const x of pick(p) || []) { const k = x.sel + (x.text ? ' “' + x.text + '”' : ''); const e = m.get(k) || { n: 0, pages: new Set() }; e.n++; e.pages.add(p.route.split('?')[0]); m.set(k, e); } const rows = [...m].sort((a, b) => b[1].n - a[1].n).slice(0, n); if (rows.length) { console.log(`\n${name}:`); for (const [k, e] of rows) console.log(`  ${String(e.n).padStart(4)}×  ${k}   (${e.pages.size} pages, e.g. ${[...e.pages].slice(0, 2).join(', ')})`); } };
  const fatal = report.pages.filter((p) => p.fatal); if (fatal.length) { console.log('\nFATAL:'); fatal.slice(0, 8).forEach((p) => console.log('  ', p.vp, p.role, p.route, p.fatal)); }
  const mobile = (p) => Number(p.vp) <= 768;
  top('Controls present on desktop but missing on mobile', missing, 20);
  top('Crushed text (a column squeezed to a sliver)', (p) => p.crushed || [], 12);
  top('Horizontal-overflow pages (mobile)', (p) => (mobile(p) && p.docOverflow > 1 ? [{ sel: p.route.split('?')[0], text: `+${p.docOverflow}px @${p.vp}` }] : []));
  top('Elements outside the viewport (mobile)', (p) => (mobile(p) ? p.offenders : []));
  top('Undersized touch targets (<44px, mobile)', (p) => (mobile(p) && p.targets ? p.targets.small : []), 30);
  top('Tiny text (<12px)', (p) => (p.fonts ? p.fonts.tiny : []), 12);
  top('Inputs under 16px (iOS zoom on focus, mobile)', (p) => (mobile(p) && p.inputs ? p.inputs.zoom : []), 12);
  top('Controls without an accessible name', (p) => (p.inputs ? p.inputs.noName : []), 15);
  top('Inputs missing type/autocomplete hints', (p) => (p.inputs ? p.inputs.noAuto : []), 10);
  top('Images that can shift layout (no width/height/aspect-ratio)', (p) => (p.images ? p.images.noDims : []), 10);
  top('Low-contrast text', (p) => (p.contrast ? p.contrast : []).map((c) => ({ sel: c.sel, text: `${c.ratio}:1 ${c.color} on ${c.bg} ${c.px}px` })), 12);
  top('Focus not visible', (p) => (p.focus ? p.focus.none : []), 8);
  top('JavaScript / console errors', (p) => (p.errors || []).map((e) => ({ sel: e, text: '' })), 6);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { measure, VIEWPORTS };
