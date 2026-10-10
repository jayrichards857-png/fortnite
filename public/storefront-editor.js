// Storefront editor: collects the form, saves a private draft, previews, publishes. Everything is validated again on the server.
(() => {
  const $ = (s) => document.querySelector(s), form = $('#sfform');
  for (const k of ['avatar', 'logo', 'banner']) { const box = document.querySelector(`[data-uploader="${k}"]`); if (window.__SF[k]) box.dispatchEvent(new CustomEvent('uploader:set', { detail: [window.__SF[k]] })); }
  const val = (n) => { const c = form.querySelector(`input[name="${n}"]:checked`); return c ? c.value : ''; };
  const one = (k) => (JSON.parse(document.querySelector(`[data-uploader-value="${k}"]`).value || '[]')[0] || null);
  function collect() {
    const links = []; form.querySelectorAll('[data-link-kind]').forEach((s) => { const u = form.querySelector(`[data-link-url="${s.dataset.linkKind}"]`).value.trim(); if (s.value || u) links.push({ kind: s.value, url: u }); });
    return { theme: val('theme'), accent: val('accent'), layout: val('layout'), sort: form.elements.sort.value, headline: form.elements.headline.value, announcement: form.elements.announcement.value, about: form.elements.about.value,
      showLocation: form.elements.showLocation.checked, featured: [...form.querySelectorAll('input[name=featured]:checked')].map((c) => Number(c.value)), links, avatar: one('avatar'), logo: one('logo'), banner: one('banner') };
  }
  const clear = () => form.querySelectorAll('.err,.form-err').forEach((e) => e.remove());
  const fail = (e) => {
    const map = { theme: 'theme', accent: 'accent', layout: 'layout', sort: 'sort', headline: 'headline', announcement: 'announcement', about: 'about', featured: 'featured', links: 'lk0', avatar: 'avatar', logo: 'logo', banner: 'banner' };
    if (e.fields) for (const [k, m] of Object.entries(e.fields)) { const el = form.elements[map[k]] || form.querySelector(`#${map[k]}`) || form.querySelector(`[data-uploader="${k}"]`) || form; el.insertAdjacentElement(el === form ? 'afterbegin' : 'afterend', Object.assign(document.createElement('div'), { className: 'err', role: 'alert', textContent: m })); }
    form.insertAdjacentElement('afterbegin', Object.assign(document.createElement('div'), { className: 'form-err', role: 'alert', textContent: e.message })); form.scrollIntoView({ block: 'start' });
  };
  const status = (t) => { $('#sf-status').textContent = t; };
  async function save(quiet) { clear(); try { await pp.api('PUT', '/api/seller/storefront', collect()); status('You have unpublished changes. Preview them, then publish.'); if (!quiet) pp.toast('Draft saved'); return true; } catch (e) { fail(e); return false; } }
  $('#sf-save').onclick = () => save();
  $('#sf-publish').onclick = async () => { if (!(await save(true))) return; try { await pp.api('POST', '/api/seller/storefront/publish'); status('Published. Your changes are live.'); pp.toast('Published — your storefront is live'); } catch (e) { fail(e); } };
  $('#sf-preview').addEventListener('click', async (ev) => { ev.preventDefault(); if (await save(true)) window.open($('#sf-preview').href, '_blank', 'noopener'); });
  $('#sf-discard').onclick = async () => { if (!confirm('Discard your unpublished changes?')) return; try { await pp.api('POST', '/api/seller/storefront/discard'); location.reload(); } catch (e) { fail(e); } };
})();
