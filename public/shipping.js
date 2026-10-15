// Seller order page: shipping label panel (Shippo TEST MODE). Renders with DOM APIs only (textContent), talks to /api/seller/orders/:id/shipping/*.
(() => {
  const root = document.getElementById('ship-panel'); if (!root) return;
  const id = root.dataset.order, base = `/api/seller/orders/${id}/shipping`;
  const $ = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
  const usd = (c, cur) => (cur && cur !== 'USD' ? `${(c / 100).toFixed(2)} ${cur}` : `$${(c / 100).toFixed(2)}`);
  let S = null, busy = false, err = '';

  async function run(fn) { if (busy) return; busy = true; err = ''; try { S = await fn(); } catch (e) { err = e.message || 'Something went wrong'; await load(false); } busy = false; draw(); }
  async function load(redraw = true) { try { S = await pp.api('GET', base); } catch (e) { err = e.message; } if (redraw) draw(); }

  function field(form, name, label, val, type = 'text', extra = {}) {
    const w = $('div'); const l = $('label', '', label); l.htmlFor = `sp_${form.closest('form').dataset.k}_${name}`;
    const i = $('input'); i.id = l.htmlFor; i.name = name; i.type = type; i.value = val == null ? '' : val; Object.assign(i, extra); w.append(l, i); form.append(w); return i;
  }
  function showFieldErrors(form, e) { form.querySelectorAll('.err').forEach((x) => x.remove()); for (const [k, m] of Object.entries(e.fields || {})) { const el = form.elements[k]; if (el) { const d = $('div', 'err', m); d.setAttribute('role', 'alert'); el.after(d); } } }

  function shipFromForm() {
    const f = $('form', 'ship-form'); f.dataset.k = 'from'; f.noValidate = true;
    const cur = S.shipFrom || { ...S.shipFromPrefill, name: '' };
    f.append($('h4', '', 'Ship-from address'));
    field(f, 'name', 'Name or business', cur.name, 'text', { maxLength: 60, required: true }); field(f, 'line1', 'Street address', cur.line1, 'text', { maxLength: 100 }); field(f, 'line2', 'Apt / suite (optional)', cur.line2, 'text', { maxLength: 100 });
    const row = $('div', 'row'); f.append(row);
    field(row, 'city', 'City', cur.city); field(row, 'region', 'State / province', cur.region); field(row, 'postal', 'ZIP / postal code', cur.postal);
    const cw = $('div'); const cl = $('label', '', 'Country'); cl.htmlFor = 'sp_from_country'; const cs = $('select'); cs.id = 'sp_from_country'; cs.name = 'country';
    for (const c of ['US', 'CA', 'MX']) { const o = $('option', '', c); o.value = c; if (c === cur.country) o.selected = true; cs.append(o); } cw.append(cl, cs); f.append(cw);
    field(f, 'phone', 'Phone (optional)', cur.phone, 'tel');
    const b = $('button', 'btn', 'Save ship-from address'); b.type = 'submit'; f.append(b);
    f.addEventListener('submit', async (ev) => { ev.preventDefault(); if (busy) return; busy = true; const d = Object.fromEntries(new FormData(f)); try { await pp.api('PUT', '/api/seller/ship-from', d); await load(false); err = ''; } catch (e) { showFieldErrors(f, e); err = e.fields ? '' : e.message; } busy = false; draw(); });
    return f;
  }

  function parcelForm() {
    const f = $('form', 'ship-form'); f.dataset.k = 'parcel'; f.noValidate = true; const d = S.parcelDefaults || {}, cur = (S.shipment && S.shipment.parcel) || d;
    f.append($('h4', '', 'Package'));
    const row = $('div', 'row'); f.append(row);
    field(row, 'weight_oz', 'Weight (oz)', cur.weight_oz, 'number', { step: '0.1', min: '1' }); field(row, 'length_in', 'Length (in)', cur.length_in, 'number', { step: '0.1', min: '0.5' });
    field(row, 'width_in', 'Width (in)', cur.width_in, 'number', { step: '0.1', min: '0.5' }); field(row, 'height_in', 'Height (in)', cur.height_in, 'number', { step: '0.1', min: '0.5' });
    f.append($('p', 'small muted', 'Measure the packed parcel. Wrong weight or size can make the carrier charge more later.'));
    const b = $('button', 'btn', 'Get shipping rates'); b.type = 'submit'; f.append(b);
    f.addEventListener('submit', (ev) => { ev.preventDefault(); const body = Object.fromEntries(new FormData(f)); run(async () => { try { return await pp.api('POST', `${base}/rates`, body); } catch (e) { showFieldErrors(f, e); throw e; } }); });
    return f;
  }

  function ratesList(sh) {
    const box = $('div'); box.append($('h4', '', 'Choose a service'));
    if (sh.expired) { box.append($('p', 'form-err', 'These rates have expired. Get fresh rates.')); return box; }
    const list = $('div', 'rates'); let pick = sh.rates[0] && sh.rates[0].id;
    for (const r of sh.rates) {
      const l = $('label', 'rate'); l.style.cssText = 'display:flex;gap:10px;align-items:center;font-weight:400;padding:6px 0';
      const i = $('input'); i.type = 'radio'; i.name = 'rate'; i.value = r.id; i.checked = r.id === pick; i.addEventListener('change', () => { pick = r.id; });
      l.append(i, $('span', '', `${r.carrier} ${r.service}`), $('strong', '', usd(r.amountCents, r.currency)), $('span', 'muted small', r.days ? `~${r.days} day${r.days > 1 ? 's' : ''}` : '')); list.append(l);
    }
    box.append(list, $('p', 'small muted', S.test ? 'TEST MODE: buying a test label charges nothing and produces a label that is not valid for shipping.' : 'Postage is charged to your Shippo account.'));
    const b = $('button', 'btn', 'Buy shipping label'); b.type = 'button';
    b.addEventListener('click', () => {
      const r = sh.rates.find((x) => x.id === pick); if (!r) return;
      if (!confirm(`${S.test ? 'Buy a TEST label' : 'Buy this label'}?\n\n${r.carrier} ${r.service}\nPrice: ${usd(r.amountCents, r.currency)}\n\nThis cannot be undone from Grailedside.`)) return;
      run(() => pp.api('POST', `${base}/buy`, { rateId: r.id, expectedAmountCents: r.amountCents, confirm: true }));
    });
    box.append(b); return box;
  }

  function draw() {
    root.textContent = ''; root.append($('h3', '', 'Shipping label'));
    if (err) { const e = $('div', 'form-err', err); e.setAttribute('role', 'alert'); root.append(e); }
    if (!S) { root.append($('p', 'muted small', 'Loading…')); return; }
    S.test = S.mode === 'test';
    if (!S.enabled) { root.append($('p', 'muted', 'Label purchase isn\'t available right now. Buy a label yourself and enter the carrier and tracking number below.'), $('p', 'small muted', S.disabledReason || '')); return; }
    if (S.test) { const t = $('div', 'panel notice strong', 'TEST MODE: labels bought here are not valid postage and nothing is charged. Do not ship with them.'); t.style.margin = '0 0 12px'; root.append(t); }
    const sh = S.shipment;
    if (sh && (sh.status === 'success')) {
      root.append($('p', '', `${S.test ? 'Test label created' : 'Label purchased'}: ${sh.carrier} ${sh.service} · ${usd(sh.priceCents, sh.currency)}`), $('p', '', `Tracking number: ${sh.trackingNumber}${sh.trackingStatus ? ' · ' + sh.trackingStatus : ''}`));
      if (sh.hasLabel) { const a = $('a', 'btn', 'Print / download label'); a.href = `/dashboard/orders/${id}/label`; a.target = '_blank'; a.rel = 'noopener noreferrer'; root.append(a); }
      root.append($('p', 'small muted', S.test ? 'This is a test label. Use the manual tracking form below with a real label to ship.' : 'Enter this carrier and tracking number below, then mark the order shipped.')); return;
    }
    if (sh && sh.status === 'purchasing') {
      root.append($('p', '', 'Your label purchase is still being processed.'), $('p', 'small muted', sh.error || 'Do not buy again until this finishes.'));
      const b = $('button', 'btn', 'Check status'); b.type = 'button'; b.onclick = () => run(() => pp.api('POST', `${base}/refresh`, {})); root.append(b);
      if (sh.stuck) { const r = $('button', 'btn ghost', 'Release (I checked my Shippo dashboard)'); r.type = 'button'; r.style.marginLeft = '8px'; r.onclick = () => { if (confirm('Only release if you checked your Shippo dashboard and no label was created. Continue?')) run(() => pp.api('POST', `${base}/release`, { confirm: true })); }; root.append(r); }
      return;
    }
    if (!S.eligible) { root.append($('p', 'muted', S.reason || 'Not available for this order.')); return; }
    if (sh && sh.status === 'failed') root.append($('p', 'form-err', `The last attempt failed: ${sh.error || 'unknown error'}. You were not charged. Get new rates to try again.`));
    if (!S.shipFrom) { root.append($('p', 'small', 'Grailedside needs your ship-from address before it can get rates. It is only used for labels.'), shipFromForm()); return; }
    const to = S.shipTo; const addr = $('p', 'small'); addr.textContent = to ? `To: ${to.name}, ${to.line1}${to.line2 ? ' ' + to.line2 : ''}, ${to.city}, ${to.region} ${to.postal} ${to.country}` : 'The delivery address is missing.'; root.append(addr);
    const from = S.shipFrom, fa = $('p', 'small muted'); fa.textContent = `From: ${from.name}, ${from.line1}, ${from.city}, ${from.region} ${from.postal} ${from.country} `; const ed = $('button', 'linklike', 'Edit'); ed.type = 'button'; ed.onclick = () => { S.shipFrom = null; S.shipFromPrefill = from; draw(); }; fa.append(ed); root.append(fa);
    root.append(parcelForm());
    if (sh && sh.status === 'rates_ready') root.append(ratesList(sh));
  }
  load();
})();
