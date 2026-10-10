'use strict';
// Chat domain logic. Transport-agnostic: HTTP routes and WebSocket frames both end up here, and every
// function takes the *authenticated user object from the server session* — never an id from the client.
const config = require('../config');
const { q, tx, now } = require('../db');
const { HttpError, clean } = require('../util');
const { rateLimit } = require('../auth');
const { getHub } = require('./hub');

const MAX_BODY = 2000, PAGE = 50, SYNC_LIMIT = 200;
const other = (c, userId) => (c.buyer_id === userId ? c.seller_id : c.buyer_id);

/** Membership gate: the ONLY way a conversation is looked up for a user. Non-members get 404 (existence isn't leaked). */
function memberConversation(user, conversationId) {
  const id = Number(conversationId);
  const c = Number.isInteger(id) ? q.get('SELECT * FROM conversations WHERE id = ? AND (buyer_id = ? OR seller_id = ?)', id, user.id, user.id) : null;
  if (!c) throw new HttpError(404, 'Conversation not found');
  return c;
}

function presentOther(c, userId) { return other(c, userId); }
function present(m) {
  return { id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, body: m.body, clientId: m.client_id, listingId: m.listing_id, createdAt: m.created_at };
}

/**
 * Start (or reopen) the single conversation between the signed-in user and a seller. The seller is ALWAYS derived on the server:
 * from the listing, or from the storefront handle. The client never supplies a user id. `arg` is a listing id or
 * { listingId } | { sellerHandle } (contacting a seller needs no listing and no payment link).
 */
function startConversation(user, arg) {
  rateLimit(`chat-start:${user.id}`, 30, 3600);
  const input = arg && typeof arg === 'object' ? arg : { listingId: arg };
  let sellerId, listingId = null;
  if (input.listingId) {
    const l = q.get(`SELECT l.id, l.seller_id, l.status, u.banned, u.is_seller FROM listings l JOIN users u ON u.id = l.seller_id WHERE l.id = ?`, Number(input.listingId));
    if (!l || !['active', 'reserved', 'sold'].includes(l.status) || l.banned || !l.is_seller) throw new HttpError(404, 'Listing not found');
    sellerId = l.seller_id; listingId = l.id;
  } else if (input.sellerHandle) {
    const sel = q.get('SELECT id, banned, is_seller FROM users WHERE handle = ? COLLATE NOCASE', String(input.sellerHandle).slice(0, 40));
    if (!sel || !sel.is_seller || sel.banned) throw new HttpError(404, 'Seller not found');
    sellerId = sel.id;
  } else throw new HttpError(400, 'Choose a listing or a seller to contact.');
  if (sellerId === user.id) throw new HttpError(403, "You can't message yourself.");
  return tx(() => {
    q.run('INSERT OR IGNORE INTO conversations(buyer_id, seller_id, listing_id, created_at) VALUES(?,?,?,?)', user.id, sellerId, listingId, now());
    // an existing conversation keeps its history; a listing-based contact just moves the listing context
    if (listingId) q.run('UPDATE conversations SET listing_id = ? WHERE buyer_id = ? AND seller_id = ?', listingId, user.id, sellerId);
    return q.get('SELECT * FROM conversations WHERE buyer_id = ? AND seller_id = ?', user.id, sellerId).id;
  });
}

function validateBody(raw) {
  // keep newlines, drop other control chars, normalise CRLF; messages are rendered with textContent (never as HTML)
  const body = clean(String(raw ?? '').replace(/\r\n?/g, '\n'), MAX_BODY + 1).replace(/\n{4,}/g, '\n\n\n');
  if (!body) throw new HttpError(422, 'Write a message first.');
  if (body.length > MAX_BODY) throw new HttpError(422, `Messages are limited to ${MAX_BODY} characters.`);
  return body;
}

/**
 * Persist a message, then publish. The caller only gets a result (the "ack") after COMMIT, so an acknowledged
 * message is always in the database. Retrying with the same clientId returns the original row (duplicate:true):
 * enforced by UNIQUE(conversation_id, sender_id, client_id), not just by an application-level check.
 */
function sendMessage(user, { conversationId, clientId, body }) {
  if (!/^[\w-]{8,64}$/.test(String(clientId || ''))) throw new HttpError(400, 'Missing or invalid clientId');
  const text = validateBody(body);
  const c = memberConversation(user, conversationId);
  const recipientId = other(c, user.id);
  const recipient = q.get('SELECT banned FROM users WHERE id = ?', recipientId);
  if (!recipient || recipient.banned) throw new HttpError(403, 'This user is unavailable.');
  const existing = q.get('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?', c.id, user.id, clientId);
  if (existing) return { message: present(existing), duplicate: true };
  rateLimit(`chat-send:${user.id}`, 40, 60);

  let msg, duplicate = false;
  tx(() => {
    const t = now();
    const r = q.run('INSERT INTO messages(conversation_id, sender_id, body, client_id, listing_id, created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(conversation_id, sender_id, client_id) DO NOTHING',
      c.id, user.id, text, clientId, c.listing_id, t);
    if (r.changes === 0) { duplicate = true; msg = q.get('SELECT * FROM messages WHERE conversation_id = ? AND sender_id = ? AND client_id = ?', c.id, user.id, clientId); return; }
    msg = q.get('SELECT * FROM messages WHERE id = ?', r.lastInsertRowid);
    q.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', t, c.id);
    // sending implies you've read everything up to your own message
    q.run(`INSERT INTO conversation_reads(conversation_id, user_id, last_read_message_id, updated_at) VALUES(?,?,?,?)
           ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), updated_at = excluded.updated_at`, c.id, user.id, msg.id, t);
  });
  const out = present(msg);
  if (!duplicate) {
    // Published only after commit. Delivery is best-effort; the database + sync cursor guarantee eventual delivery.
    getHub().publish(recipientId, { t: 'message', message: out });
    getHub().publish(user.id, { t: 'message', message: out }); // other tabs/devices of the sender
  }
  return { message: out, duplicate };
}

/** Mark everything up to `upTo` as read (clamped to the conversation's newest message; never moves backwards). */
function markRead(user, { conversationId, upTo }) {
  const c = memberConversation(user, conversationId);
  const max = q.get('SELECT COALESCE(MAX(id), 0) m FROM messages WHERE conversation_id = ?', c.id).m;
  const target = Math.min(Math.max(0, Math.floor(Number(upTo) || 0)), max);
  q.run(`INSERT INTO conversation_reads(conversation_id, user_id, last_read_message_id, updated_at) VALUES(?,?,?,?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id), updated_at = excluded.updated_at`, c.id, user.id, target, now());
  const readUpTo = q.get('SELECT last_read_message_id r FROM conversation_reads WHERE conversation_id = ? AND user_id = ?', c.id, user.id).r;
  const ev = { t: 'read', conversationId: c.id, userId: user.id, upTo: readUpTo };
  getHub().publish(other(c, user.id), ev); getHub().publish(user.id, ev);
  return { readUpTo };
}

/** Typing indicators are ephemeral by design: published to the other member only, never stored. */
function typing(user, { conversationId }) {
  const c = memberConversation(user, conversationId);
  rateLimit(`chat-typing:${user.id}`, 60, 60);
  getHub().publish(other(c, user.id), { t: 'typing', conversationId: c.id, userId: user.id, at: Date.now() });
  return {};
}

const CONV_SQL = `SELECT c.*, 
    ub.display_name buyer_name, us.display_name seller_name, us.store_name seller_store, us.handle seller_handle,
    l.title listing_title, l.price_cents listing_price, l.status listing_status,
    (SELECT file FROM listing_images WHERE listing_id = l.id ORDER BY position LIMIT 1) listing_image,
    (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) last_body,
    (SELECT sender_id FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) last_sender,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> ?1
       AND m.id > COALESCE((SELECT last_read_message_id FROM conversation_reads r WHERE r.conversation_id = c.id AND r.user_id = ?1), 0)) unread,
    (SELECT last_read_message_id FROM conversation_reads r WHERE r.conversation_id = c.id AND r.user_id = c.buyer_id + c.seller_id - ?1) other_read
  FROM conversations c JOIN users ub ON ub.id = c.buyer_id JOIN users us ON us.id = c.seller_id LEFT JOIN listings l ON l.id = c.listing_id`;

function presentConv(c, userId) {
  const mine = c.buyer_id === userId;
  return { id: c.id, otherName: mine ? (c.seller_store || c.seller_name) : c.buyer_name, otherHandle: mine ? c.seller_handle : null, role: mine ? 'buyer' : 'seller',
    listing: c.listing_id && c.listing_title ? { id: c.listing_id, title: c.listing_title, priceCents: c.listing_price, status: c.listing_status, image: c.listing_image } : null,
    lastBody: c.last_body, lastSender: c.last_sender, lastMessageAt: c.last_message_at || c.created_at, unread: c.unread || 0, otherReadUpTo: c.other_read || 0 };
}

function listConversations(user) {
  // conversations with no messages yet are hidden from the *seller* (they'd be empty noise); buyers see what they just opened
  return q.all(`${CONV_SQL} WHERE (c.buyer_id = ?1 OR (c.seller_id = ?1 AND c.last_message_at IS NOT NULL)) ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC LIMIT 200`, user.id).map((c) => presentConv(c, user.id));
}
function getConversation(user, id) {
  memberConversation(user, id);
  return presentConv(q.get(`${CONV_SQL} WHERE c.id = ?2`, user.id, Number(id)), user.id);
}

/** Message history, newest page first (oldest→newest within the page). `before` = message id for paging back. */
function history(user, { conversationId, before }) {
  const c = memberConversation(user, conversationId);
  const b = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
  const rows = q.all('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?', c.id, b, PAGE + 1);
  const more = rows.length > PAGE; if (more) rows.pop();
  return { messages: rows.reverse().map(present), hasMore: more };
}

/**
 * Catch-up for reconnects/polling: every message in MY conversations with id > `after`, plus a fresh snapshot of
 * unread counts and read receipts. Because ids only increase, a client that remembers the highest id it saw can never
 * miss or double-apply a message, no matter how long it was offline.
 */
function sync(user, after) {
  const cursor = Math.max(0, Math.floor(Number(after) || 0));
  const rows = q.all(`SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
                      WHERE m.id > ? AND (c.buyer_id = ? OR c.seller_id = ?) ORDER BY m.id LIMIT ${SYNC_LIMIT + 1}`, cursor, user.id, user.id);
  const more = rows.length > SYNC_LIMIT; if (more) rows.pop();
  return { messages: rows.map(present), hasMore: more, conversations: listConversations(user), serverTime: Date.now() };
}

/** Highest message id the user can see right now: the starting sync cursor for a freshly loaded page. */
function cursorFor(userId) {
  return q.get('SELECT COALESCE(MAX(m.id), 0) n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.buyer_id = ? OR c.seller_id = ?', userId, userId).n;
}

function unreadTotal(userId) {
  return q.get(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.buyer_id = ?1 OR c.seller_id = ?1) AND m.sender_id <> ?1
      AND m.id > COALESCE((SELECT last_read_message_id FROM conversation_reads r WHERE r.conversation_id = c.id AND r.user_id = ?1), 0)`, userId).n;
}

/** The single entry point used by both transports for client→server commands. */
function runCommand(user, cmd) {
  switch (cmd && cmd.op) {
    case 'send': return sendMessage(user, cmd);
    case 'read': return markRead(user, cmd);
    case 'typing': return typing(user, cmd);
    case 'history': return history(user, cmd);
    case 'sync': return sync(user, cmd.after);
    default: throw new HttpError(400, 'Unknown command');
  }
}

module.exports = { startConversation, sendMessage, markRead, typing, listConversations, getConversation, history, sync, cursorFor, unreadTotal, runCommand, memberConversation, MAX_BODY };
