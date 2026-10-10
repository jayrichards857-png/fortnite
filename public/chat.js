// PairPlug chat client.
//   UI + state  ←→  Transport (interface)  ←→  server
// A transport implements: start(), stop(), rpc(cmd) -> Promise<data>, and reports via handlers
//   { state(name), event(ev), cursor() }.
// WebSocketTransport and PollingTransport are interchangeable; a Socket.IO transport can be added later by
// implementing the same four members. Connection states are reported honestly: the label always names the
// transport actually in use ("WebSocket" vs "long-polling").
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const boot = JSON.parse($('#chat-boot').textContent);
  const me = boot.me;
  const HDRS = { 'X-Requested-With': 'pairplug', 'Content-Type': 'application/json' };
  const money = (c) => '$' + (c / 100).toFixed(2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36));

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  // ---------- plain HTTP command (also the path for sends when no socket is open) ----------
  async function httpCommand(cmd) {
    const res = await fetch('/api/chat/command', { method: 'POST', headers: HDRS, body: JSON.stringify(cmd), credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, data.error || 'Request failed');
    return data.data;
  }

  // ---------- Transport: WebSocket ----------
  class WebSocketTransport {
    constructor(h) { this.h = h; this.name = 'websocket'; this.pending = new Map(); this.seq = 0; this.fails = 0; this.stopped = false; this.opened = false; }
    start() { this.stopped = false; this.open(); }
    stop() { this.stopped = true; clearTimeout(this.retry); if (this.ws) this.ws.close(); }
    open() {
      this.h.state(this.opened ? 'reconnecting' : 'connecting');
      let ws; try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/chat/ws'); } catch { return this.failed(false); }
      this.ws = ws; let ready = false;
      ws.onmessage = async (m) => {
        let f; try { f = JSON.parse(m.data); } catch { return; }
        if (f.t === 'ready' && !ready) {
          ready = true; this.fails = 0;
          try {
            const data = await this.rpc({ op: 'sync', after: this.h.cursor() }); this.opened = true; this.h.event({ t: 'sync', ...data }); this.h.state('connected-ws');
            // Heartbeat + safety net: a periodic catch-up sync. It repairs any lost push, and if it fails the link is dead
            // (half-open sockets don't raise onclose for a long time), so we drop the socket and reconnect instead of claiming "Live".
            clearInterval(this.safety);
            this.safety = setInterval(() => this.rpc({ op: 'sync', after: this.h.cursor() }).then((d) => this.h.event({ t: 'sync', ...d })).catch((e) => { if (!e.status || e.status === 0) this.drop(); }), 20000);
          }
          catch { ws.close(); }
        } else if (f.t === 'res') {
          const p = this.pending.get(f.reqId); if (!p) return; this.pending.delete(f.reqId); clearTimeout(p.timer);
          f.ok ? p.resolve(f.data) : p.reject(new HttpError(f.status, f.error));
        } else this.h.event(f);
      };
      ws.onclose = (e) => {
        clearInterval(this.safety);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(0, 'Connection lost')); } this.pending.clear();
        if (this.stopped) return;
        if (e.code === 4401) return this.h.state('auth-error');
        this.failed(ready);
      };
    }
    drop() { // abandon a dead socket right away and go through the normal reconnect path
      clearInterval(this.safety); const ws = this.ws; if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* already closed */ } }
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(0, 'Connection lost')); } this.pending.clear();
      this.ws = null; this.failed(true);
    }
    async failed(wasOpen) {
      if (this.stopped) return;
      this.fails++;
      // Handshake refused/never opened: find out whether we're signed out, else tell the owner WebSockets don't work here.
      if (!wasOpen && !this.opened) {
        try { const r = await fetch('/api/chat/sync?after=' + this.h.cursor(), { credentials: 'same-origin' }); if (r.status === 401) return this.h.state('auth-error'); } catch { /* network down */ }
        if (this.fails >= 2 && navigator.onLine !== false) return this.h.unsupported();
      }
      this.h.state(navigator.onLine === false ? 'offline' : 'reconnecting');
      this.retry = setTimeout(() => this.open(), Math.min(15000, 1000 * 2 ** Math.min(this.fails, 4)) * (0.7 + Math.random() * 0.6));
    }
    rpc(cmd) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== 1) return reject(new HttpError(0, 'Not connected'));
        const reqId = ++this.seq, timer = setTimeout(() => { this.pending.delete(reqId); reject(new HttpError(0, 'Timed out')); }, 8000);
        this.pending.set(reqId, { resolve, reject, timer }); this.ws.send(JSON.stringify({ ...cmd, reqId }));
      });
    }
    get connected() { return this.ws && this.ws.readyState === 1 && this.opened; }
  }

  // ---------- Transport: long-polling ----------
  class PollingTransport {
    constructor(h) { this.h = h; this.name = 'polling'; this.stopped = false; this.up = false; this.fails = 0; }
    start() { this.stopped = false; this.up = false; this.loop(); }
    stop() { this.stopped = true; if (this.ctl) this.ctl.abort(); }
    async loop() {
      this.h.state('connecting');
      let first = true;
      while (!this.stopped) {
        this.ctl = new AbortController();
        try {
          // First request returns immediately (wait=0) so "connected" is truthful right away; later ones are held open ≤20s.
          const res = await fetch(`/api/chat/sync?after=${this.h.cursor()}&wait=${first ? 0 : 20}`, { credentials: 'same-origin', signal: this.ctl.signal, headers: { Accept: 'application/json' } });
          if (res.status === 401) return this.h.state('auth-error');
          if (!res.ok) throw new Error('bad status');
          const data = await res.json(); this.fails = 0; first = false;
          if (!this.up) { this.up = true; this.h.state('connected-polling'); }
          this.h.event({ t: 'sync', ...data });
          for (const ev of data.typing || []) this.h.event(ev);
          if (!data.messages.length && !(data.typing || []).length) await sleep(250); // guard against a hot loop if the server answers instantly
        } catch (e) {
          if (this.stopped) return;
          this.up = false; this.fails++;
          this.h.state(navigator.onLine === false ? 'offline' : 'reconnecting');
          await sleep(Math.min(15000, 1000 * 2 ** Math.min(this.fails, 4)) * (0.7 + Math.random() * 0.6));
        }
      }
    }
    rpc(cmd) { return httpCommand(cmd); }
    get connected() { return this.up; }
  }

  // ---------- State ----------
  const S = { convs: new Map(boot.conversations.map((c) => [c.id, c])), msgs: new Map(), hasMore: new Map(), active: boot.active, cursor: boot.cursor || 0, myRead: new Map(), typingUntil: 0, conn: 'connecting', transport: null, forcedPolling: false };
  const outboxKey = `pp-outbox:${me.id}`;
  const loadOutbox = () => { try { return JSON.parse(localStorage.getItem(outboxKey) || '[]'); } catch { return []; } };
  const saveOutbox = (o) => { try { localStorage.setItem(outboxKey, JSON.stringify(o)); } catch { /* storage unavailable: queue is memory-only */ } };
  let outbox = loadOutbox();       // [{conversationId, clientId, body}] — unsent messages survive a reload
  const failed = new Map();        // clientId -> error text for messages the server rejected

  const list = (id) => { if (!S.msgs.has(id)) S.msgs.set(id, []); return S.msgs.get(id); };
  function mergeMessage(m) {
    const arr = list(m.conversationId);
    if (arr.some((x) => x.id === m.id)) return false;
    arr.push(m); arr.sort((a, b) => a.id - b.id);
    // NOTE: the sync cursor is deliberately NOT advanced here. Acks and pushed events can arrive ahead of older messages in
    // other conversations; only a sync batch (which is contiguous for this user) may move the cursor, so nothing is ever skipped.
    outbox = outbox.filter((o) => o.clientId !== m.clientId); saveOutbox(outbox); failed.delete(m.clientId);
    return true;
  }

  // ---------- Handlers from the transport ----------
  const handlers = {
    cursor: () => S.cursor,
    state(name) { S.conn = name; renderConn(); if (name.startsWith('connected')) flushOutbox(); },
    unsupported() { // WebSockets can't be established from here (proxy/firewall/etc.) → use long-polling and say so
      S.transport.stop(); S.forcedPolling = true; S.transport = new PollingTransport(handlers); S.transport.start();
    },
    event(ev) {
      if (ev.t === 'sync') {
        for (const m of ev.messages) applyIncoming(m);
        if (ev.messages.length) S.cursor = Math.max(S.cursor, ev.messages[ev.messages.length - 1].id);
        if (ev.conversations) for (const c of ev.conversations) { const prev = S.convs.get(c.id); S.convs.set(c.id, { ...c, unread: S.active === c.id && visible() ? 0 : c.unread, otherReadUpTo: Math.max(c.otherReadUpTo, prev ? prev.otherReadUpTo : 0) }); }
        if (ev.hasMore && S.transport.name === 'websocket') S.transport.rpc({ op: 'sync', after: S.cursor }).then((d) => handlers.event({ t: 'sync', ...d })).catch(() => {});
        renderAll(); maybeMarkRead();
      } else if (ev.t === 'message') { applyIncoming(ev.message); renderAll(); maybeMarkRead(); }
      else if (ev.t === 'read') {
        const c = S.convs.get(ev.conversationId); if (!c) return;
        if (ev.userId === me.id) c.unread = 0; else c.otherReadUpTo = Math.max(c.otherReadUpTo, ev.upTo);
        if (ev.userId === me.id && S.myRead) S.myRead.set(ev.conversationId, Math.max(S.myRead.get(ev.conversationId) || 0, ev.upTo));
        renderAll();
      } else if (ev.t === 'typing' && ev.conversationId === S.active && ev.userId !== me.id) { S.typingUntil = Date.now() + 4500; renderTyping(); setTimeout(renderTyping, 4600); }
    },
  };

  function applyIncoming(m) {
    const isNew = mergeMessage(m);
    const c = S.convs.get(m.conversationId);
    if (!c) { refreshConversations(); return; }
    if (isNew) { if (!c.lastMessageAt || m.createdAt >= c.lastMessageAt) { c.lastBody = m.body; c.lastSender = m.senderId; c.lastMessageAt = m.createdAt; } }
    if (isNew && m.senderId !== me.id && !(S.active === m.conversationId && visible())) c.unread = (c.unread || 0) + 1;
  }
  async function refreshConversations() { try { const d = await httpCommand({ op: 'sync', after: S.cursor }); for (const c of d.conversations) if (!S.convs.has(c.id)) S.convs.set(c.id, c); renderAll(); } catch { /* next sync will retry */ } }

  const visible = () => document.visibilityState === 'visible';
  const rpc = (cmd) => (S.transport && S.transport.connected ? S.transport.rpc(cmd) : httpCommand(cmd));

  // ---------- Sending (idempotent, offline-tolerant) ----------
  let flushing = false;
  async function flushOutbox() {
    if (flushing) return; flushing = true;
    try {
      for (const item of [...outbox]) {
        if (failed.has(item.clientId)) continue;
        try { const r = await rpc({ op: 'send', conversationId: item.conversationId, clientId: item.clientId, body: item.body }); mergeMessage(r.message); const c = S.convs.get(item.conversationId); if (c) { c.lastBody = r.message.body; c.lastSender = me.id; c.lastMessageAt = r.message.createdAt; } }
        catch (e) { if (e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) { failed.set(item.clientId, e.message); } else break; /* network/5xx/429/401: keep queued, retry later */ }
        renderAll();
      }
    } finally { flushing = false; renderAll(); }
  }
  function send(text) {
    const body = text.replace(/\s+$/, ''); if (!body || !S.active) return;
    outbox.push({ conversationId: S.active, clientId: uuid(), body, at: Math.floor(Date.now() / 1000) }); saveOutbox(outbox);
    renderAll(); flushOutbox();
  }

  // ---------- Read receipts ----------
  let readTimer;
  function maybeMarkRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(async () => {
      if (!S.active || !visible()) return;
      const arr = list(S.active), lastOther = [...arr].reverse().find((m) => m.senderId !== me.id);
      const c = S.convs.get(S.active);
      if (!lastOther || (S.myRead.get(S.active) || 0) >= lastOther.id) { if (c && c.unread) { c.unread = 0; renderAll(); } return; }
      S.myRead.set(S.active, lastOther.id); if (c) c.unread = 0; renderAll();
      try { await rpc({ op: 'read', conversationId: S.active, upTo: lastOther.id }); } catch { S.myRead.set(S.active, 0); }
    }, 250);
  }
  document.addEventListener('visibilitychange', maybeMarkRead);
  window.addEventListener('focus', maybeMarkRead);

  // ---------- Rendering (textContent only: message bodies are never interpreted as HTML) ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const hhmm = (s) => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayKey = (s) => new Date(s * 1000).toDateString();
  const ago = (s) => { const d = Math.floor(Date.now() / 1000) - s; return d < 60 ? 'now' : d < 3600 ? Math.floor(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h' : new Date(s * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }); };

  const LABELS = {
    connecting: ['Connecting…', 'connecting'],
    'connected-ws': ['Live · WebSocket', 'ok'],
    'connected-polling': [null, 'ok'],
    reconnecting: ['Reconnecting… unsent messages are kept', 'warn'],
    offline: ['Offline — will reconnect automatically', 'warn'],
    'auth-error': [null, 'bad'],
  };
  function renderConn() {
    const [label, kind] = LABELS[S.conn] || ['', ''];
    for (const box of document.querySelectorAll('.conn')) { // thread bar + (mobile) inbox header show the same state
      box.dataset.state = S.conn; box.dataset.kind = kind; box.dataset.transport = S.transport ? S.transport.name : '';
      const span = box.querySelector('span'); span.textContent = '';
      if (S.conn === 'auth-error') { span.append('Signed out. ', Object.assign(el('a', null, 'Log in again'), { href: '/login?next=' + encodeURIComponent(location.pathname) })); }
      else if (S.conn === 'connected-polling') span.textContent = S.forcedPolling ? 'Live · long-polling (WebSocket unavailable)' : 'Live · long-polling';
      else span.textContent = label;
    }
    $('#composer button').disabled = S.conn === 'auth-error';
  }

  function renderList() {
    const box = $('#conv-list'); box.textContent = '';
    const convs = [...S.convs.values()].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0) || b.id - a.id);
    if (!convs.length) { const n = el('div', 'chat-none'); n.append(el('p', 'muted small', 'No conversations yet. Use “Message seller” on a listing to start one.')); box.append(n); }
    for (const c of convs) {
      const a = el('a', 'conv' + (c.id === S.active ? ' on' : '') + (c.unread ? ' unread' : '')); a.href = '/messages/' + c.id; a.dataset.id = c.id; a.setAttribute('role', 'listitem');
      const top = el('div', 'conv-top'); top.append(el('strong', null, c.otherName), el('span', 'muted small', c.lastMessageAt ? ago(c.lastMessageAt) : ''));
      const wl = waitingHours(c);
      const prev = el('div', 'conv-prev muted small', (wl >= 0 ? `Awaiting your reply · ${wl}h · ` : '') + (c.lastBody ? (c.lastSender === me.id ? 'You: ' : '') + c.lastBody : (c.listing ? 'About: ' + c.listing.title : 'No messages yet')));
      a.append(top, prev); if (c.unread) a.append(el('b', 'badge-inline', String(c.unread)));
      box.append(a);
    }
    const total = [...S.convs.values()].reduce((n, c) => n + (c.unread || 0), 0), hb = $('#hdr-msg-badge');
    if (hb) { hb.textContent = total || ''; hb.hidden = !total; }
    document.title = (total ? `(${total}) ` : '') + document.title.replace(/^\(\d+\) /, '');
  }

  async function reportMessage(c, m) {
    const reason = window.prompt('Why are you reporting this message? PairPlug support will be able to read this conversation. (10+ characters)');
    if (!reason) return;
    try { const r = await fetch('/api/chat/report', { method: 'POST', headers: HDRS, body: JSON.stringify({ conversationId: c.id, messageId: m.id, reason }), credentials: 'same-origin' }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not send the report'); window.alert('Thanks. PairPlug support will review it (case #' + d.id + ').'); }
    catch (e) { window.alert(e.message); }
  }
  const waitingHours = (c) => (c.role === 'seller' && c.lastSender && c.lastSender !== me.id && c.lastMessageAt ? Math.floor((Date.now() / 1000 - c.lastMessageAt) / 3600) : -1);

  function renderThread() {
    const c = S.convs.get(S.active), box = $('#msgs');
    $('#chat').classList.toggle('has-active', !!c); $('#composer').hidden = !c; $('#chat-empty').hidden = !!c; box.hidden = !c;
    $('#chat-title').textContent = c ? c.otherName : 'Select a conversation';
    const wh = c ? waitingHours(c) : -1;
    let ex = $('#expect'); if (!ex) { ex = el('div', 'muted small'); ex.id = 'expect'; ex.style.padding = '6px 12px'; $('#msgs').before(ex); }
    ex.textContent = !c ? '' : c.role === 'seller' ? (wh >= 0 ? `Awaiting your reply · ${wh < 1 ? 'less than an hour' : wh + 'h'} ago. Buyers expect a reply within 48 hours.` : 'Buyers expect a reply within 48 hours (an expectation, not a guarantee).') : 'Sellers are expected to reply within 48 hours. That is an expectation, not a guarantee.';
    const lb = $('#chat-listing'); lb.textContent = '';
    if (c && c.listing) { const a = el('a', 'listing-ctx'); a.href = '/listing/' + c.listing.id;
      if (c.listing.image) { const i = el('img'); i.src = '/uploads/' + c.listing.image; i.alt = ''; a.append(i); }
      const t = el('div'); t.append(el('strong', null, c.listing.title), el('div', 'muted small', money(c.listing.priceCents) + (c.listing.status !== 'active' ? ' · ' + c.listing.status : ''))); a.append(t); lb.append(a); }
    if (!c) { box.textContent = ''; return; }
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120, firstPaint = !box.dataset.painted; box.dataset.painted = c.id;
    const prevConv = box.dataset.conv; box.dataset.conv = c.id;
    box.textContent = '';
    if (S.hasMore.get(c.id)) { const b = el('button', 'btn ghost small load-more', 'Load earlier messages'); b.type = 'button'; b.onclick = loadEarlier; box.append(b); }
    const arr = list(c.id), mine = arr.filter((m) => m.senderId === me.id), lastMine = mine.length ? mine[mine.length - 1].id : 0;
    let day = '';
    for (const m of arr) {
      if (dayKey(m.createdAt) !== day) { day = dayKey(m.createdAt); box.append(el('div', 'daysep', new Date(m.createdAt * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))); }
      const row = el('div', 'msg ' + (m.senderId === me.id ? 'mine' : 'theirs')); const bub = el('div', 'bubble'); bub.append(el('span', 'body', m.body), el('time', 'when', hhmm(m.createdAt))); row.append(bub);
      if (m.id === lastMine && c.otherReadUpTo >= m.id) row.append(el('div', 'receipt', 'Seen'));
      if (m.senderId !== me.id) { const rp = el('button', 'linklike small report', 'Report'); rp.type = 'button'; rp.setAttribute('aria-label', 'Report this message'); rp.onclick = () => reportMessage(c, m); row.append(rp); }
      box.append(row);
    }
    for (const o of outbox.filter((x) => x.conversationId === c.id)) {
      const row = el('div', 'msg mine pending'); const bub = el('div', 'bubble'); bub.append(el('span', 'body', o.body)); row.append(bub);
      if (failed.has(o.clientId)) {
        const f = el('div', 'receipt err', 'Not sent: ' + failed.get(o.clientId) + ' '); const r = el('button', 'linklike', 'Retry'); r.type = 'button'; r.onclick = () => { failed.delete(o.clientId); flushOutbox(); };
        const d = el('button', 'linklike', 'Discard'); d.type = 'button'; d.onclick = () => { outbox = outbox.filter((x) => x.clientId !== o.clientId); saveOutbox(outbox); failed.delete(o.clientId); renderAll(); }; f.append(r, ' · ', d); row.append(f);
      } else row.append(el('div', 'receipt', S.conn.startsWith('connected') ? 'Sending…' : 'Waiting for connection — will send automatically'));
      box.append(row);
    }
    if (near || firstPaint || prevConv !== String(c.id)) box.scrollTop = box.scrollHeight;
    renderTyping();
  }
  function renderTyping() { const c = S.convs.get(S.active); $('#typing').textContent = c && Date.now() < S.typingUntil ? c.otherName + ' is typing…' : ''; }
  function renderAll() { renderList(); renderThread(); renderConn(); }

  // ---------- Conversation loading / navigation ----------
  async function loadHistory(id) {
    try { const h = await httpCommand({ op: 'history', conversationId: id }); const arr = list(id); for (const m of h.messages) if (!arr.some((x) => x.id === m.id)) arr.push(m); arr.sort((a, b) => a.id - b.id); S.hasMore.set(id, h.hasMore); }
    catch (e) { if (e.status === 401) S.conn = 'auth-error'; else pp.toast(e.status === 404 ? 'Conversation not found' : 'Could not load messages — retrying when reconnected', true); }
  }
  async function loadEarlier() { const arr = list(S.active), first = arr[0]; if (!first) return; const h = await httpCommand({ op: 'history', conversationId: S.active, before: first.id }); for (const m of h.messages) if (!arr.some((x) => x.id === m.id)) arr.push(m); arr.sort((a, b) => a.id - b.id); S.hasMore.set(S.active, h.hasMore); const box = $('#msgs'), before = box.scrollHeight; renderThread(); box.scrollTop = box.scrollHeight - before; }
  async function openConv(id, push) {
    S.active = id; S.typingUntil = 0; if (push) history.pushState({ id }, '', id ? '/messages/' + id : '/messages');
    renderAll(); if (id) { await loadHistory(id); renderAll(); maybeMarkRead(); $('#compose').focus({ preventScroll: true }); }
  }
  document.addEventListener('click', (e) => { const a = e.target.closest('a.conv'); if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); openConv(Number(a.dataset.id), true); } const back = e.target.closest('.chat-back'); if (back) { e.preventDefault(); openConv(null, true); } });
  window.addEventListener('popstate', () => { const m = location.pathname.match(/\/messages\/(\d+)/); openConv(m ? Number(m[1]) : null, false); });

  // ---------- Composer ----------
  const ta = $('#compose'); let lastTyping = 0;
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); ta.value = ''; autosize(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
  ta.addEventListener('input', () => { autosize(); if (S.active && Date.now() - lastTyping > 2500 && ta.value && S.transport && S.transport.connected) { lastTyping = Date.now(); rpc({ op: 'typing', conversationId: S.active }).catch(() => {}); } });
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }
  // The browser knows when the network is gone before any socket/fetch fails: reflect it immediately and stop claiming "Live".
  window.addEventListener('offline', () => { if (S.transport) { S.transport.stop(); S.conn = 'offline'; renderAll(); } });
  window.addEventListener('online', () => { if (S.transport) { S.transport.stop(); S.transport.start(); } });

  // ---------- Start ----------
  S.transport = boot.forcedTransport === 'polling' || typeof WebSocket === 'undefined' ? new PollingTransport(handlers) : new WebSocketTransport(handlers);
  S.forcedPolling = S.transport.name === 'polling' && boot.forcedTransport !== 'polling';
  window.__chat = { state: S, get transport() { return S.transport; } }; // handy for debugging/tests
  renderAll();
  if (S.active) loadHistory(S.active).then(() => { renderAll(); maybeMarkRead(); });
  S.transport.start();
})();
