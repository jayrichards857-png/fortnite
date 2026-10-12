(() => {
  const $ = (s) => document.querySelector(s), form = $('#lform'), id = form.dataset.listing;
  const upl = $('[data-uploader="images"]');
  if (window.__EDIT.images.length) upl.dispatchEvent(new CustomEvent('uploader:set', { detail: window.__EDIT.images }));
  const cents = (c) => '$' + (c / 100).toFixed(2);
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  async function save(status) {
    form.querySelectorAll('.err,.form-err').forEach((e) => e.remove());
    const body = Object.fromEntries(new FormData(form)); body.status = status; if (form.elements.payment_amount_ack) body.payment_amount_ack = form.elements.payment_amount_ack.checked;
    body.images = JSON.parse($('[data-uploader-value="images"]').value || '[]'); delete body.images_json;
    form.querySelectorAll('[data-save]').forEach((b) => (b.disabled = true));
    try {
      const r = await pp.api(id ? 'PUT' : 'POST', id ? '/api/seller/listings/' + id : '/api/seller/listings', body);
      // Only claim success using the status the server actually stored.
      pp.toast(r.status === 'active' ? 'Published — your listing is live.' : r.status === 'archived' ? 'Listing archived.' : 'Draft saved.');
      setTimeout(() => (location.href = r.status === 'active' ? '/listing/' + r.id : '/dashboard/inventory'), 700);
    } catch (e) {
      if (e.fields) for (const [k, m] of Object.entries(e.fields)) { const el = form.elements[k] || (k === 'images' ? upl : null); if (el) el.insertAdjacentHTML('afterend', `<div class="err" role="alert">${m}</div>`); }
      form.insertAdjacentHTML('afterbegin', `<div class="form-err" role="alert">${e.message}</div>`); form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      form.querySelectorAll('[data-save]').forEach((b) => (b.disabled = false));
    }
  }
  form.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => save(b.dataset.save)));

  // Profit calculator: server computes everything, so the numbers always match what checkout will use.
  const calc = debounce(async () => {
    const out = $('#pc-out'), use = $('#pc-use');
    const p = new URLSearchParams({ cost: $('#pc-cost').value, label: $('#pc-ship').value, shipping: form.elements.shipping.value, margin: $('#pc-margin').value });
    try {
      const r = await pp.api('GET', '/api/seller/profit-calc?' + p);
      out.innerHTML = `Recommended price: <strong>${cents(r.priceCents)}</strong><br>Fees: ${cents(r.platformFeeCents + r.processingFeeCents)} · Your profit: ${cents(r.profitCents)} (${r.marginPct.toFixed(0)}%)`;
      use.hidden = false; use.onclick = () => { form.elements.price.value = (r.priceCents / 100).toFixed(2); payout(); };
    } catch (e) { out.textContent = e.message; use.hidden = true; }
  });
  const payout = debounce(async () => {
    const out = $('#payout'); if (!form.elements.price.value) { out.textContent = 'Enter a price.'; return; }
    const p = new URLSearchParams({ price: form.elements.price.value, shipping: form.elements.shipping.value, cost: form.elements.cost.value, label: $('#pc-ship').value });
    try {
      const r = await pp.api('GET', '/api/seller/payout-preview?' + p);
      out.innerHTML = `PairPlug fee: ${r.platformFeeCents ? '−' + cents(r.platformFeeCents) : '$0.00 (beta)'}<br>Card processing (est., billed by your payment provider): −${cents(r.processingFeeCents)}<br><strong>You keep about: ${cents(r.sellerPayoutCents)}</strong>` + (r.profitCents != null ? `<br>Profit after cost & label: <strong>${cents(r.profitCents)}</strong>` : '');
    } catch (e) { out.textContent = e.message; }
  });
  ['#pc-cost', '#pc-ship', '#pc-margin'].forEach((s) => $(s).addEventListener('input', calc));
  $('#pc-ship').addEventListener('input', payout);
  ['price', 'shipping', 'cost'].forEach((n) => form.elements[n].addEventListener('input', payout));
  calc(); payout();
})();
