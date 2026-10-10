'use strict';
// Pub/sub boundary for chat delivery. The chat service publishes to `user:<id>` topics; transports
// (WebSocket sockets, long-poll requests) subscribe. This in-process implementation is enough for ONE
// server process. To scale out, implement the same two methods on Redis (PUBLISH/SUBSCRIBE or a Socket.IO
// Redis adapter) and pass it to setHub() — nothing else in the chat code changes, because the database
// (not the hub) is the source of truth and the hub only says "something happened".
const { EventEmitter } = require('node:events');

class LocalHub {
  constructor() { this.ee = new EventEmitter(); this.ee.setMaxListeners(0); }
  /** @returns {() => void} unsubscribe */
  subscribe(userId, fn) { const k = `user:${userId}`; this.ee.on(k, fn); return () => this.ee.off(k, fn); }
  publish(userId, event) { this.ee.emit(`user:${userId}`, event); }
}

let hub = new LocalHub();
module.exports = { LocalHub, getHub: () => hub, setHub: (h) => { hub = h; } };
