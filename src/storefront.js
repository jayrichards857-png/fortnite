'use strict';
// Seller storefront customisation.
//
// Design rule: sellers pick from CURATED, enumerated options (themes, accent palette, layouts) and supply plain text, links and
// their own images. They never supply CSS, HTML or script. Everything is validated here, stored as JSON in `storefronts`
// (private draft + published copy) and rendered by the server with escaped text and class names chosen from fixed lists.
const { q, tx, now } = require('./db');
const { HttpError, clean, cleanLine } = require('./util');
const { ownedUploads, storedDimensions, removeIfUnreferenced } = require('./images');

const THEMES = { light: 'Light', warm: 'Warm paper', dark: 'Dark' };
const ACCENTS = { forest: 'Forest', ocean: 'Ocean', plum: 'Plum', clay: 'Clay', slate: 'Slate', gold: 'Gold' };
const LAYOUTS = { grid: 'Grid', large: 'Large photos', list: 'List' };
const SORTS = { newest: 'Newest first', price_asc: 'Price: low to high', price_desc: 'Price: high to low' };
const LINK_KINDS = {
  instagram: ['instagram.com', 'www.instagram.com'], tiktok: ['tiktok.com', 'www.tiktok.com'], depop: ['depop.com', 'www.depop.com'],
  poshmark: ['poshmark.com', 'www.poshmark.com'], ebay: ['ebay.com', 'www.ebay.com'], etsy: ['etsy.com', 'www.etsy.com'],
  youtube: ['youtube.com', 'www.youtube.com'], x: ['x.com', 'twitter.com', 'www.x.com'],
};
// Colour tokens. This object is the single source of truth: /storefront.css is generated from it and the tests check WCAG contrast on it.
const PALETTE = {
  themes: {
    light: { bg: '#faf9f6', card: '#ffffff', text: '#161614', muted: '#5f5e59', line: '#e6e4de', ink: '#ffffff' },
    warm: { bg: '#f4ecdf', card: '#fffaf1', text: '#2a2118', muted: '#6a5c4b', line: '#dccbb0', ink: '#ffffff' },
    dark: { bg: '#14161a', card: '#1d2026', text: '#f1f0ec', muted: '#a9acb3', line: '#2f333b', ink: '#101215' },
  },
  accents: {   // [on light/warm backgrounds, on the dark theme]
    forest: ['#1f4d36', '#86c9a3'], ocean: ['#1d4f7c', '#8fc3f2'], plum: ['#6b2f58', '#d9a1c9'],
    clay: ['#9a4a2c', '#eba487'], slate: ['#3c4b5c', '#b4c4d6'], gold: ['#7a5a0e', '#e6c36a'],
  },
};
function themeCss() {
  const out = [];
  for (const [t, v] of Object.entries(PALETTE.themes)) out.push(`.store.theme-${t}{--bg:${v.bg};--card:${v.card};--text:${v.text};--muted:${v.muted};--line:${v.line};--ink:${v.ink}}`);
  for (const [a, [lightHex, darkHex]] of Object.entries(PALETTE.accents)) {
    out.push(`.store.acc-${a}{--accent:${lightHex}}`, `.store.theme-dark.acc-${a}{--accent:${darkHex}}`);
    out.push(`.sw-${a}{background:${lightHex}}`);
  }
  return out.join('\n') + '\n';
}

const LIMITS = { headline: 80, announcement: 240, about: 1200, featured: 6, links: 4 };
// A storefront must not imitate Grailedside itself or promise protections Grailedside doesn't provide.
const FORBIDDEN = /\b(escrow|(?:pairplug|grailedside)\s+(guarantee|guaranteed|verified|certified|official|protection|protected|admin|staff|team|support)|(guaranteed|verified|certified|protected|endorsed)\s+by\s+(?:pairplug|grailedside)|official\s+(?:pairplug|grailedside)|buyer\s+protection|money[- ]back\s+guarantee)\b/i;

const defaults = () => ({ theme: 'light', accent: 'forest', layout: 'grid', sort: 'newest', headline: '', announcement: '', about: '', avatar: null, logo: null, banner: null, featured: [], links: [], showLocation: true });
const pick = (map, v, field, errors) => { if (v == null || v === '') return Object.keys(map)[0]; if (!Object.hasOwn(map, v)) { errors[field] = 'Choose one of the available options.'; return Object.keys(map)[0]; } return v; };

/** Validate untrusted input into a clean settings object. Throws HttpError(422, fields) — nothing partial is ever saved. */
async function validate(user, input = {}) {
  const e = {}, out = defaults();
  out.theme = pick(THEMES, input.theme, 'theme', e); out.accent = pick(ACCENTS, input.accent, 'accent', e);
  out.layout = pick(LAYOUTS, input.layout, 'layout', e); out.sort = pick(SORTS, input.sort, 'sort', e);
  for (const [k, max, one] of [['headline', LIMITS.headline, true], ['announcement', LIMITS.announcement, true], ['about', LIMITS.about, false]]) {
    const text = one ? cleanLine(input[k], max + 1) : clean(input[k], max + 1);
    if (text.length > max) e[k] = `Keep this under ${max} characters.`;
    else if (FORBIDDEN.test(text)) e[k] = 'Storefronts can’t claim Grailedside guarantees, protection, escrow or staff status.';
    else out[k] = text;
  }
  out.showLocation = input.showLocation !== false && input.showLocation !== 'false';
  // images: must be the seller's own uploads, with sensible dimensions (re-read from disk)
  const imgRules = { avatar: { min: 64 }, logo: { min: 64 }, banner: { minW: 600, minH: 150 } };
  for (const k of Object.keys(imgRules)) {
    const f = input[k]; if (!f) continue;
    try {
      await ownedUploads(user.id, [f]); const d = await storedDimensions(f); const r = imgRules[k];
      if (!d) e[k] = 'That image could not be read.';
      else if (r.min && (d.w < r.min || d.h < r.min)) e[k] = `Use an image at least ${r.min}×${r.min}px.`;
      else if (r.minW && (d.w < r.minW || d.h < r.minH)) e[k] = `Use a banner at least ${r.minW}×${r.minH}px.`;
      else out[k] = f;
    } catch (x) { e[k] = x.message; }
  }
  // featured listings: the seller's own, currently-for-sale items only
  const ids = [...new Set((Array.isArray(input.featured) ? input.featured : []).map(Number))];
  if (ids.length > LIMITS.featured) e.featured = `Feature at most ${LIMITS.featured} items.`;
  else for (const id of ids) {
    if (!await q.get("SELECT 1 x FROM listings WHERE id = ? AND seller_id = ? AND status IN ('active','reserved')", id, user.id)) { e.featured = 'You can only feature your own items that are for sale.'; break; }
    out.featured.push(id);
  }
  // links: allowlisted social/marketplace hosts only, https, one per kind
  const links = Array.isArray(input.links) ? input.links.filter((l) => l && (l.url || '').trim()) : [];
  if (links.length > LIMITS.links) e.links = `Add at most ${LIMITS.links} links.`;
  else { const seen = new Set(); for (const l of links) {
    let u; try { u = new URL(String(l.url).trim()); } catch { e.links = 'One of your links is not a valid URL.'; break; }
    const hosts = LINK_KINDS[l.kind];
    if (!hosts) { e.links = 'Choose a link type for each link.'; break; }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !hosts.includes(u.hostname.toLowerCase())) { e.links = `A ${l.kind} link must be an https link on ${hosts[0]}.`; break; }
    if (seen.has(l.kind)) { e.links = 'Use each link type once.'; break; } seen.add(l.kind);
    out.links.push({ kind: l.kind, url: (u.hash = '', u.toString()).slice(0, 300) });
  } }
  if (Object.keys(e).length) throw new HttpError(422, 'Please fix the highlighted fields.', e);
  return out;
}

const parse = (j) => { try { return j ? { ...defaults(), ...JSON.parse(j) } : null; } catch { return null; } };
const row = async (sellerId) => await q.get('SELECT * FROM storefronts WHERE seller_id = ?', sellerId);
const imagesOf = (s) => (s ? [s.avatar, s.logo, s.banner].filter(Boolean) : []);

/** What visitors see (published), or — for the owner previewing — the draft if there is one. Always merged over safe defaults. */
async function effective(sellerId, { preview = false } = {}) {
  const r = await row(sellerId);
  const published = parse(r && r.published_json), draft = parse(r && r.draft_json);
  return { settings: (preview && draft) || published || defaults(), isDraft: Boolean(preview && draft), hasDraft: Boolean(draft), published: Boolean(published) };
}

async function state(sellerId) {
  const r = await row(sellerId); const draft = parse(r && r.draft_json), published = parse(r && r.published_json);
  const working = draft || published || defaults();
  return { working, published, hasUnpublished: Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(published || defaults()), publishedAt: r && r.published_at };
}

async function saveDraft(user, input) {
  const clean_ = await validate(user, input);
  const before = await row(user.id);
  await tx(async () => {
    await q.run(`INSERT INTO storefronts(seller_id, draft_json, draft_updated_at) VALUES(?,?,?)
           ON CONFLICT(seller_id) DO UPDATE SET draft_json = excluded.draft_json, draft_updated_at = excluded.draft_updated_at`, user.id, JSON.stringify(clean_), now());
  });
  for (const f of imagesOf(parse(before && before.draft_json))) if (!imagesOf(clean_).includes(f)) await removeIfUnreferenced(f);   // no-op if still published/used elsewhere
  return clean_;
}

async function publish(user) {
  const r = await row(user.id), draft = parse(r && r.draft_json);
  if (!draft) throw new HttpError(409, 'There are no unpublished changes.');
  const old = parse(r.published_json);
  await q.run('UPDATE storefronts SET published_json = ?, published_at = ? WHERE seller_id = ?', JSON.stringify(draft), now(), user.id);
  for (const f of imagesOf(old)) if (!imagesOf(draft).includes(f)) await removeIfUnreferenced(f);
  return draft;
}

async function discardDraft(user) {
  const r = await row(user.id), draft = parse(r && r.draft_json); if (!draft) return;
  await q.run('UPDATE storefronts SET draft_json = NULL, draft_updated_at = NULL WHERE seller_id = ?', user.id);
  for (const f of imagesOf(draft)) await removeIfUnreferenced(f);
}

module.exports = { PALETTE, themeCss, THEMES, ACCENTS, LAYOUTS, SORTS, LINK_KINDS, LIMITS, defaults, validate, effective, state, saveDraft, publish, discardDraft };
