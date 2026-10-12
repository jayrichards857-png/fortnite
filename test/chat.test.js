'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const H = require('./helpers');
const { q } = require('../src/db');

test.before(async () => await H.start());
test.after(() => H.stop());

const uid = () => `c-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const count = async (sql, ...p) => (await q.get(sql, ...p)).n;
const cmd = async (c, body) => c.post('/api/chat/command', body);
const send = async (c, conversationId, body, clientId = uid()) => await cmd(c, { op: 'send', conversationId, clientId, body });

/** Minimal WebSocket test client with the same frame protocol the browser uses. */
class Sock {
  constructor(client, { origin } = {}) {
    this.events = []; this.waiters = []; this.pending = new Map(); this.seq = 0;
    this.ws = new WebSocket(H.base.replace('http', 'ws') + '/api/chat/ws', { headers: { cookie: client.cookie, ...(origin ? { origin } : {}) } });
    this.opened = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('unexpected-response', (_, r) => rej(Object.assign(new Error('rejected'), { status: r.statusCode }))); this.ws.on('error', rej); });
    this.closed = new Promise((res) => this.ws.on('close', (code) => res(code)));
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'res') { const p = this.pending.get(f.reqId); this.pending.delete(f.reqId); return p && p(f); }
      this.events.push(f); this.waiters = this.waiters.filter((w) => !w());
    });
  }
  rpc(c) { return new Promise((res) => { const reqId = ++this.seq; this.pending.set(reqId, res); this.ws.send(JSON.stringify({ ...c, reqId })); }); }
  waitFor(pred, ms = 3000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for event; got ' + JSON.stringify(this.events))), ms);
      const check = () => { const e = this.events.find(pred); if (e) { clearTimeout(t); res(e); return true; } return false; };
      if (!check()) this.waiters.push(check);
    });
  }
  close() { this.ws.close(); }
}

async function scene() {
  const seller = await H.newSeller('ChatSeller'), buyer = await H.newUser('ChatBuyer'), stranger = await H.newUser('Stranger');
  const listing = await H.makeListing(seller);
  const conv = (await buyer.post('/api/chat/conversations', { listingId: listing })).json.id;
  return { seller, buyer, stranger, listing, conv };
}

test('authentication: every chat surface requires an active session', async () => {
  const anon = new H.Client();
  assert.equal((await anon.get('/messages')).status, 302);
  assert.equal((await anon.get('/api/chat/sync')).status, 401);
  assert.equal((await anon.post('/api/chat/command', { op: 'sync' })).status, 401);
  assert.equal((await anon.post('/api/chat/conversations', { listingId: 1 })).status, 401);
  await assert.rejects(new Sock(anon).opened, (e) => e.status === 401);
  // a banned user's existing session stops working everywhere, including new sockets
  const { buyer } = await scene();
  assert.equal((await buyer.get('/api/chat/sync')).status, 200);
  await q.run('UPDATE users SET banned = 1 WHERE email = ?', buyer.email);
  assert.equal((await buyer.get('/api/chat/sync')).status, 401);
  await assert.rejects(new Sock(buyer).opened, (e) => e.status === 401);
});

test('websocket: cross-site origins are refused; same-origin is accepted', async () => {
  const { buyer } = await scene();
  await assert.rejects(new Sock(buyer, { origin: 'https://evil.example' }).opened, (e) => e.status === 403);
  const ok = new Sock(buyer, { origin: H.base }); await ok.opened; await ok.waitFor((e) => e.t === 'ready'); ok.close();
});

test('websocket: a revoked session is dropped on the next command', async () => {
  const { buyer } = await scene();
  const s = new Sock(buyer); await s.opened;
  await buyer.post('/api/logout');
  const r = await s.rpc({ op: 'sync', after: 0 });
  assert.equal(r.ok, false); assert.equal(r.status, 401);
  assert.equal(await s.closed, 4401);
});

test('conversations: one per buyer/seller pair, seller derived from the listing, never from the client', async () => {
  const { seller, buyer, listing, conv } = await scene();
  const sellerId = (await q.get('SELECT id FROM users WHERE handle = ?', seller.handle)).id;
  const buyerId = (await q.get('SELECT id FROM users WHERE email = ?', buyer.email)).id;
  const row = await q.get('SELECT * FROM conversations WHERE id = ?', conv);
  assert.equal(row.buyer_id, buyerId); assert.equal(row.seller_id, sellerId); assert.equal(row.listing_id, listing);
  // forged ids in the request body are ignored
  const forged = await buyer.post('/api/chat/conversations', { listingId: listing, sellerId: 1, buyerId: 999 });
  assert.equal(forged.json.id, conv);
  // second listing from the same seller → same conversation, context moves
  const l2 = await H.makeListing(seller, { title: 'Second item' });
  assert.equal((await buyer.post('/api/chat/conversations', { listingId: l2 })).json.id, conv);
  assert.equal((await q.get('SELECT listing_id FROM conversations WHERE id = ?', conv)).listing_id, l2);
  // 8 parallel creates by a new buyer produce exactly one row
  const b2 = await H.newUser();
  const ids = await Promise.all(Array.from({ length: 8 }, () => b2.post('/api/chat/conversations', { listingId: listing })));
  assert.equal(new Set(ids.map((r) => r.json.id)).size, 1);
  assert.equal(await count('SELECT COUNT(*) n FROM conversations WHERE seller_id = ? AND buyer_id = (SELECT id FROM users WHERE email = ?)', sellerId, b2.email), 1);
  // can't message yourself; drafts/unknown listings 404
  assert.equal((await seller.post('/api/chat/conversations', { listingId: listing })).status, 403);
  const draft = await H.makeListing(seller, { status: 'draft' });
  assert.equal((await buyer.post('/api/chat/conversations', { listingId: draft })).status, 404);
  assert.equal((await buyer.post('/api/chat/conversations', { listingId: 99999 })).status, 404);
});

test('privacy: non-members cannot read, send, mark read, type or see the conversation anywhere', async () => {
  const { seller, buyer, stranger, conv } = await scene();
  const sent = await send(buyer, conv, 'my size is M, is it still available?');
  assert.equal(sent.status, 200);
  for (const body of [{ op: 'history', conversationId: conv }, { op: 'read', conversationId: conv, upTo: 999 }, { op: 'typing', conversationId: conv }]) {
    assert.equal((await cmd(stranger, body)).status, 404, body.op);
  }
  assert.equal((await send(stranger, conv, 'hijack')).status, 404);
  assert.equal(await count('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?', conv), 1);
  assert.equal((await stranger.get(`/messages/${conv}`)).status, 404);
  const sync = (await stranger.get('/api/chat/sync?after=0')).json;
  assert.equal(sync.messages.length, 0); assert.equal(sync.conversations.length, 0);
  // the page HTML for the stranger must not contain the message
  assert.doesNotMatch((await stranger.get('/messages')).text, /my size is M/);
  // participants do see it; a forged senderId in the body is ignored
  const forged = await cmd(seller, { op: 'send', conversationId: conv, clientId: uid(), body: 'yes', senderId: (await q.get('SELECT id FROM users WHERE email = ?', buyer.email)).id });
  assert.equal(forged.json.data.message.senderId, (await q.get('SELECT id FROM users WHERE handle = ?', seller.handle)).id);
  const wsStranger = new Sock(stranger); await wsStranger.opened;
  const wr = await wsStranger.rpc({ op: 'history', conversationId: conv }); assert.equal(wr.status, 404);
  wsStranger.close();
});

test('persistence: ack implies the row is committed; history survives a "reload"; validation', async () => {
  const { buyer, seller, conv } = await scene();
  const r = await send(buyer, conv, 'line one\nline two');
  assert.equal(r.status, 200);
  const row = await q.get('SELECT * FROM messages WHERE id = ?', r.json.data.message.id);   // checked immediately after the ack
  assert.ok(row); assert.equal(row.body, 'line one\nline two');
  await send(seller, conv, 'second');
  // brand-new client (as after a page reload) rebuilds the thread in order
  const reloaded = new H.Client(); reloaded.cookie = buyer.cookie;
  const h = (await cmd(reloaded, { op: 'history', conversationId: conv })).json.data;
  assert.deepEqual(h.messages.map((m) => m.body), ['line one\nline two', 'second']);
  assert.match((await reloaded.get(`/messages/${conv}`)).text, /chat-boot/);
  // validation
  assert.equal((await send(buyer, conv, '   ')).status, 422);
  assert.equal((await send(buyer, conv, 'x'.repeat(2001))).status, 422);
  assert.equal((await cmd(buyer, { op: 'send', conversationId: conv, clientId: 'x', body: 'hi' })).status, 400, 'bad idempotency key');
  const ctl = await send(buyer, conv, 'a\u0000b\u0007c');
  assert.equal(ctl.json.data.message.body, 'abc');
  // markup is stored verbatim (the client renders with textContent), never executed or rewritten
  assert.equal((await send(buyer, conv, '<img src=x onerror=alert(1)>')).json.data.message.body, '<img src=x onerror=alert(1)>');
  // paging back
  for (let i = 0; i < 55; i++) await send(buyer, conv, 'bulk ' + i);
  const page1 = (await cmd(buyer, { op: 'history', conversationId: conv })).json.data;
  assert.equal(page1.messages.length, 50); assert.equal(page1.hasMore, true);
  const page2 = (await cmd(buyer, { op: 'history', conversationId: conv, before: page1.messages[0].id })).json.data;
  assert.ok(page2.messages.length > 0 && page2.messages.at(-1).id < page1.messages[0].id);
});

test('duplicates: idempotency key + UNIQUE constraint → exactly one row, even under a race', async () => {
  const { buyer, seller, conv } = await scene();
  const key = uid();
  const first = await send(buyer, conv, 'hello', key), again = await send(buyer, conv, 'hello', key);
  assert.equal(first.json.data.duplicate, false); assert.equal(again.json.data.duplicate, true);
  assert.equal(first.json.data.message.id, again.json.data.message.id);
  const key2 = uid();
  const rs = await Promise.all(Array.from({ length: 10 }, async () => await send(buyer, conv, 'racing', key2)));
  assert.ok(rs.every((r) => r.status === 200)); assert.equal(new Set(rs.map((r) => r.json.data.message.id)).size, 1);
  assert.equal(await count('SELECT COUNT(*) n FROM messages WHERE client_id IN (?, ?)', key, key2), 2);
  // the database itself rejects a duplicate even if application code is bypassed
  await assert.rejects(async () => await q.run('INSERT INTO messages(conversation_id, sender_id, body, client_id, created_at) SELECT conversation_id, sender_id, body, client_id, created_at FROM messages WHERE client_id = ?', key), /unique constraint/i);
  // the same key from the *other* participant is a different message
  const other = await send(seller, conv, 'hello', key); assert.equal(other.json.data.duplicate, false);
  // duplicates must not push a second event to the recipient
  const s = new Sock(seller); await s.opened; await s.waitFor((e) => e.t === 'ready');
  const k3 = uid(); await send(buyer, conv, 'once', k3); await send(buyer, conv, 'once', k3); await send(buyer, conv, 'marker');
  await s.waitFor((e) => e.t === 'message' && e.message.body === 'marker');
  assert.equal(s.events.filter((e) => e.t === 'message' && e.message.body === 'once').length, 1);
  s.close();
});

test('unread counts and read receipts', async () => {
  const { buyer, seller, conv } = await scene();
  const unread = async (c) => (await c.get('/api/chat/sync')).json.conversations.find((x) => x.id === conv)?.unread ?? 0;
  const m1 = (await send(buyer, conv, 'one')).json.data.message, m2 = (await send(buyer, conv, 'two')).json.data.message;
  assert.equal(await unread(seller), 2); assert.equal(await unread(buyer), 0);
  assert.match((await seller.get('/messages')).text, /id="hdr-msg-badge">2</);
  const s = new Sock(buyer); await s.opened; await s.waitFor((e) => e.t === 'ready');
  assert.equal((await cmd(seller, { op: 'read', conversationId: conv, upTo: m1.id })).json.data.readUpTo, m1.id);
  assert.equal(await unread(seller), 1);
  const receipt = await s.waitFor((e) => e.t === 'read' && e.upTo === m1.id);   // buyer gets the read receipt live
  assert.equal(receipt.conversationId, conv);
  assert.equal((await buyer.get('/api/chat/sync')).json.conversations[0].otherReadUpTo, m1.id);
  // never moves backwards, and can't claim to have read messages that don't exist yet
  assert.equal((await cmd(seller, { op: 'read', conversationId: conv, upTo: 1 })).json.data.readUpTo, m1.id);
  assert.equal((await cmd(seller, { op: 'read', conversationId: conv, upTo: 10 ** 9 })).json.data.readUpTo, m2.id);
  assert.equal(await unread(seller), 0);
  s.close();
});

test('real time over WebSocket: message push, typing (ephemeral, only to the other member), ack after commit', async () => {
  const { buyer, seller, conv } = await scene();
  const sb = new Sock(seller); await sb.opened; await sb.waitFor((e) => e.t === 'ready');
  const bb = new Sock(buyer); await bb.opened; await bb.waitFor((e) => e.t === 'ready');
  const ack = await bb.rpc({ op: 'send', conversationId: conv, clientId: uid(), body: 'live hello' });
  assert.equal(ack.ok, true);
  assert.ok(await q.get('SELECT 1 x FROM messages WHERE id = ?', ack.data.message.id), 'row exists by the time the ack is delivered');
  const pushed = await sb.waitFor((e) => e.t === 'message' && e.message.body === 'live hello');
  assert.equal(pushed.message.conversationId, conv);
  await bb.rpc({ op: 'typing', conversationId: conv });
  await sb.waitFor((e) => e.t === 'typing' && e.conversationId === conv);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!bb.events.some((e) => e.t === 'typing'), 'typist does not get their own typing event');
  assert.equal(await count("SELECT COUNT(*) n FROM messages WHERE body LIKE '%typing%'"), 0, 'typing is never stored');
  sb.close(); bb.close();
});

test('long-polling fallback: wakes immediately on a new message, and carries typing events', async () => {
  const { buyer, seller, conv } = await scene();
  const cursor = (await seller.get('/api/chat/sync')).json; assert.equal(cursor.messages.length, 0);
  const t0 = Date.now();
  const poll = seller.get('/api/chat/sync?after=0&wait=10');
  await new Promise((r) => setTimeout(r, 300));
  await send(buyer, conv, 'wake up');
  const res = await poll;
  assert.equal(res.json.messages.at(-1).body, 'wake up'); assert.ok(Date.now() - t0 < 3000, 'did not wait for the full timeout');
  // typing is delivered through the same held request
  const after = res.json.messages.at(-1).id;
  const poll2 = seller.get(`/api/chat/sync?after=${after}&wait=10`);
  await new Promise((r) => setTimeout(r, 200));
  await cmd(buyer, { op: 'typing', conversationId: conv });
  assert.equal((await poll2).json.typing[0].conversationId, conv);
  // an idle poll with nothing new returns the empty set after the wait (short wait here)
  const idle = await seller.get(`/api/chat/sync?after=${after}&wait=1`);
  assert.equal(idle.json.messages.length, 0);
});

test('offline recovery: reconnect with the last cursor returns exactly the missed messages (WebSocket and polling)', async () => {
  const { buyer, seller, conv } = await scene();
  await send(buyer, conv, 'before');
  // seller is online over WebSocket, then goes offline
  let sock = new Sock(seller); await sock.opened; await sock.waitFor((e) => e.t === 'ready');
  const base = (await sock.rpc({ op: 'sync', after: 0 })).data; const cursor = base.messages.at(-1).id;
  sock.close(); await sock.closed;
  for (const t of ['missed 1', 'missed 2', 'missed 3']) await send(buyer, conv, t);
  // reconnect: hello/sync from the remembered cursor
  sock = new Sock(seller); await sock.opened; await sock.waitFor((e) => e.t === 'ready');
  const caught = (await sock.rpc({ op: 'sync', after: cursor })).data;
  assert.deepEqual(caught.messages.map((m) => m.body), ['missed 1', 'missed 2', 'missed 3']);
  assert.equal(caught.conversations[0].unread, 4);
  sock.close();
  // same guarantee for the polling transport
  const viaPoll = (await seller.get(`/api/chat/sync?after=${cursor}`)).json;
  assert.deepEqual(viaPoll.messages.map((m) => m.body), ['missed 1', 'missed 2', 'missed 3']);
  // a sender that was offline retries its queued message with the SAME key after reconnecting: stored once
  const key = uid();
  await send(buyer, conv, 'queued while offline', key);          // first attempt reached the server, but the ack was "lost"
  const retry = await send(buyer, conv, 'queued while offline', key);
  assert.equal(retry.json.data.duplicate, true);
  assert.equal(await count("SELECT COUNT(*) n FROM messages WHERE body = 'queued while offline'"), 1);
  // paging in sync: more than the page limit is reported via hasMore and can be drained
  for (let i = 0; i < 205; i++) await send(buyer, conv, 'flood ' + i);
  const p1 = (await seller.get(`/api/chat/sync?after=${cursor}`)).json; assert.equal(p1.hasMore, true); assert.equal(p1.messages.length, 200);
  const p2 = (await seller.get(`/api/chat/sync?after=${p1.messages.at(-1).id}`)).json; assert.equal(p2.hasMore, false);
  assert.equal(p1.messages.length + p2.messages.length, 3 + 1 + 205);
});

test('rate limiting protects against message floods', async () => {
  const config = require('../src/config');
  const { buyer, conv } = await scene();   // set up before tightening the limiter
  config.rateLimitScale = 1;
  try {
    let last; for (let i = 0; i < 45; i++) last = await send(buyer, conv, 'spam ' + i);
    assert.equal(last.status, 429);
  } finally { config.rateLimitScale = 1000; }
});

test('no seeded data: a fresh account has no conversations', async () => {
  const u = await H.newUser();
  assert.equal((await u.get('/api/chat/sync')).json.conversations.length, 0);
});
