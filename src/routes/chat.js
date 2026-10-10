'use strict';
const express = require('express');
const { esc, money, date, HttpError, wrap } = require('../util');
const V = require('../views');
const auth = require('../auth');
const service = require('../chat/service');
const { getHub } = require('../chat/hub');

const r = express.Router();
const LONG_POLL_MS = 20000;

// ---------- Pages ----------
const shell = (req, res) => {
  const convId = req.params.id ? Number(req.params.id) : null;
  let active = null;
  if (convId) { try { active = service.getConversation(req.user, convId); } catch { return res.status(404).send(V.layout({ user: req.user, title: 'Not found', body: V.empty('Conversation not found', 'It may not exist, or it belongs to someone else.', ['/messages', 'Back to messages']) })); } }
  const boot = { me: { id: req.user.id, name: req.user.display_name }, conversations: service.listConversations(req.user), cursor: service.cursorFor(req.user.id), active: convId, forcedTransport: ['polling', 'ws'].includes(req.query.transport) ? req.query.transport : null };
  const body = `<div class="chat${convId ? ' has-active' : ''}" id="chat">
    <aside class="chat-list" aria-label="Conversations"><div class="chat-list-head"><h1>Messages</h1><span class="conn conn-list" data-state="connecting"><i></i><span>Connecting…</span></span></div><div id="conv-list" role="list"></div></aside>
    <section class="chat-thread" aria-label="Conversation">
      <div class="chat-bar"><a class="chat-back" href="/messages" aria-label="Back to conversations">←</a><div class="chat-title" id="chat-title">${active ? esc(active.otherName) : 'Select a conversation'}</div>
        <span class="conn" id="conn" role="status" aria-live="polite" data-state="connecting"><i></i><span>Connecting…</span></span></div>
      <div id="chat-listing"></div>
      <div class="chat-msgs" id="msgs" tabindex="0" aria-live="polite" aria-label="Messages"></div>
      <div class="typing" id="typing" aria-live="polite"></div>
      <form class="composer" id="composer" ${convId ? '' : 'hidden'}><label class="sr" for="compose">Message</label>
        <textarea id="compose" rows="1" maxlength="${service.MAX_BODY}" placeholder="Write a message…" autocomplete="off"></textarea><button class="btn" type="submit">Send</button></form>
      <div class="chat-empty" id="chat-empty" ${convId ? 'hidden' : ''}>${V.empty('Pick a conversation', 'Message a seller from any listing to start one.', ['/shop', 'Browse the shop'])}</div>
    </section></div>
    <script id="chat-boot" type="application/json">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>`;
  res.send(V.layout({ user: req.user, path: '/messages', title: active ? `Chat with ${active.otherName}` : 'Messages', body, wide: true, scripts: '<script src="/chat.js" defer></script>' }));
};
r.get('/messages', auth.requireUser, shell);
r.get('/messages/:id(\\d+)', auth.requireUser, shell);

// ---------- HTTP API (same service the WebSocket uses) ----------
r.post('/api/chat/conversations', auth.requireUser, (req, res) => res.json({ id: service.startConversation(req.user, { listingId: req.body.listingId, sellerHandle: req.body.sellerHandle }) }));
r.post('/api/chat/command', auth.requireUser, (req, res) => res.json({ ok: true, data: service.runCommand(req.user, req.body) }));

/**
 * Long-polling fallback. GET /api/chat/sync?after=<cursor>&wait=<seconds>
 * Returns immediately if anything is newer than the cursor; otherwise holds the request until the hub says something
 * happened for this user (or ~20s), then answers. This is HTTP polling, not a WebSocket, and the client labels it as such.
 */
r.get('/api/chat/sync', auth.requireUser, wrap(async (req, res) => {
  const after = Number(req.query.after) || 0, wait = Math.min(Number(req.query.wait) || 0, 25) * 1000 || 0;
  const ephemeral = []; let wake;
  const woke = new Promise((resolve) => { wake = resolve; });
  // subscribe BEFORE reading the DB so an event arriving between the read and the wait can't be lost
  const unsub = getHub().subscribe(req.user.id, (ev) => { if (ev.t === 'typing') ephemeral.push(ev); wake(); });
  let gone = false; req.on('close', () => { gone = true; wake(); });
  try {
    let out = service.sync(req.user, after);
    if (wait && !out.messages.length && !ephemeral.length) {
      await Promise.race([woke, new Promise((resolve) => setTimeout(resolve, Math.min(wait, LONG_POLL_MS)))]);
      if (gone) return;
      // the session may have ended (logout/ban) while the request was held: re-validate before answering
      if (!auth.userFromRequest(req)) return res.status(401).json({ error: 'Please log in' });
      out = service.sync(req.user, after);
    }
    res.json({ ...out, typing: ephemeral });
  } finally { unsub(); }
}));

module.exports = { router: r };
