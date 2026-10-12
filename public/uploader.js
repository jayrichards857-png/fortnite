// Photo uploader: uploads each file immediately to /api/uploads (raw body), keeps filenames in a hidden JSON field.
(() => {
  document.querySelectorAll('[data-uploader]').forEach((box) => {
    const name = box.dataset.uploader, max = Number(box.dataset.max || 8), url = box.dataset.url || '/api/uploads', src = box.dataset.src || '/uploads/';
    const hidden = document.querySelector(`[data-uploader-value="${name}"]`);
    const add = box.querySelector('.up-add'), input = box.querySelector('input[type=file]');
    const files = [];
    const sync = () => { hidden.value = JSON.stringify(files); add.style.display = files.length >= max ? 'none' : ''; };
    const render = (f) => {
      const el = document.createElement('div'); el.className = 'up-item'; el.dataset.file = f;
      el.innerHTML = `<img src="${src}${f}" alt="Uploaded photo" width="96" height="120"><button type="button" aria-label="Remove photo">×</button>`;
      el.querySelector('button').onclick = () => { files.splice(files.indexOf(f), 1); el.remove(); sync(); };
      box.insertBefore(el, add);
    };
    box.addEventListener('uploader:set', (e) => { e.detail.forEach((f) => { files.push(f); render(f); }); sync(); });
    input.addEventListener('change', async () => {
      for (const file of [...input.files]) {
        if (files.length >= max) { pp.toast(`You can add at most ${max} photos.`, true); break; }
        if (file.size > 5 * 1024 * 1024) { pp.toast(`${file.name} is larger than 5 MB`, true); continue; }
        add.textContent = 'Uploading…';
        try { const r = await pp.api('POST', url, file, file.type || 'image/jpeg'); files.push(r.file); render(r.file); }
        catch (e) { pp.toast(e.message, true); }
      }
      add.innerHTML = '+ Add photo'; add.appendChild(input); input.value = ''; sync();
    });
    try { for (const f of JSON.parse(box.dataset.initial || '[]')) { files.push(f); render(f); } } catch { /* ignore a bad initial list */ }
    sync();
  });
})();
