(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const toast = (msg, bad) => { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3500); };
  window.pp = { toast };
  async function api(method, url, body, raw) {
    const headers = { 'X-Requested-With': 'pairplug' };
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = raw;
    const res = await fetch(url, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong'); e.status = res.status; e.fields = data.fields; throw e; }
    return data;
  }
  window.pp.api = api;

  // Generic JSON form: <form data-api="/api/x" data-method="POST" data-redirect="/y">
  document.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-api]'); if (!f) return;
    ev.preventDefault();
    const btn = f.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    $$('.err,.form-err', f).forEach((e) => e.remove());
    const body = {};
    new FormData(f).forEach((v, k) => { body[k] = v; });
    $$('input[type=checkbox]', f).forEach((c) => { body[c.name] = c.checked; });
    try {
      const data = await api(f.dataset.method || 'POST', f.dataset.api, body);
      if (f.dataset.redirect) location.href = f.dataset.redirect.replace('{id}', data.id ?? '');
      else if (f.dataset.reload !== undefined) location.reload();
      else toast(data.message || 'Saved');
    } catch (e) {
      if (e.fields) for (const [k, m] of Object.entries(e.fields)) { const el = f.elements[k]; if (el) el.insertAdjacentHTML('afterend', `<div class="err" role="alert">${m.replace(/</g, '&lt;')}</div>`); }
      f.insertAdjacentHTML('afterbegin', `<div class="form-err" role="alert">${e.message.replace(/</g, '&lt;')}</div>`);
      f.scrollIntoView({ block: 'nearest' });
    } finally { if (btn) btn.disabled = false; }
  });

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    const fav = t.closest('[data-fav]');
    if (fav) {
      ev.preventDefault();
      try {
        const on = fav.getAttribute('aria-pressed') !== 'true';
        await api(on ? 'PUT' : 'DELETE', `/api/favorites/${fav.dataset.fav}`);
        fav.classList.toggle('on', on); fav.setAttribute('aria-pressed', on);
        toast(on ? 'Saved to favorites' : 'Removed from favorites');
      } catch (e) { if (e.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); else toast(e.message, true); }
    }
    const fb = t.closest('[data-follow]');
    if (fb) {                                  // follow / unfollow a seller: optimistic update, rolled back if the server says no
      ev.preventDefault(); if (fb.dataset.busy) return; fb.dataset.busy = '1';
      const handle = fb.dataset.follow, on = fb.getAttribute('aria-pressed') !== 'true';
      const paint = (state) => $$(`[data-follow="${handle}"]`).forEach((b) => { b.classList.toggle('on', state); b.setAttribute('aria-pressed', state ? 'true' : 'false'); b.setAttribute('aria-label', (state ? 'Unfollow' : 'Follow') + ' @' + handle); const l = b.querySelector('.follow-label'); if (l) l.textContent = state ? 'Following' : 'Follow'; });
      paint(on);
      try { await api(on ? 'POST' : 'DELETE', `/api/sellers/${encodeURIComponent(handle)}/follow`); toast(on ? 'Following @' + handle : 'Unfollowed @' + handle); }
      catch (e) { paint(!on); if (e.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); else toast(e.message, true); }
      finally { delete fb.dataset.busy; }
    }
    const add = t.closest('[data-cart-add]');
    if (add) {
      try { await api('POST', '/api/cart', { listingId: Number(add.dataset.cartAdd) }); if (add.dataset.buy !== undefined) location.href = '/cart'; else { toast('Added to cart'); location.reload(); } }
      catch (e) { if (e.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname); else toast(e.message, true); }
    }
    const cs = t.closest('[data-chat-seller]');
    if (cs) {
      try { const d = await api('POST', '/api/chat/conversations', { sellerHandle: cs.dataset.chatSeller }); location.href = '/messages/' + d.id; }
      catch (e) { if (e.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname); else toast(e.message, true); }
    }
    const chat = t.closest('[data-chat-start]');
    if (chat) {
      try { const d = await api('POST', '/api/chat/conversations', { listingId: Number(chat.dataset.chatStart) }); location.href = '/messages/' + d.id; }
      catch (e) { if (e.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname); else toast(e.message, true); }
    }
    const rm = t.closest('[data-cart-remove]');
    if (rm) { try { await api('DELETE', '/api/cart/' + rm.dataset.cartRemove); location.reload(); } catch (e) { toast(e.message, true); } }
    if (t.closest('[data-logout]')) { await api('POST', '/api/logout'); location.href = '/'; }
    const act = t.closest('[data-post]');
    if (act) {
      if (act.dataset.confirm && !confirm(act.dataset.confirm)) return;
      act.disabled = true;
      try { const d = await api(act.dataset.method || 'POST', act.dataset.post, act.dataset.body ? JSON.parse(act.dataset.body) : {}); if (act.dataset.redirect) location.href = act.dataset.redirect.replace('{id}', d.id ?? ''); else location.reload(); }
      catch (e) { toast(e.message, true); act.disabled = false; }
    }
    const th = t.closest('[data-thumb]');
    if (th) { $('#gmain').src = th.dataset.thumb; $$('[data-thumb]').forEach((b) => b.setAttribute('aria-current', b === th)); }
  });

  // Auto-submit sort select on shop page
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));
})();
