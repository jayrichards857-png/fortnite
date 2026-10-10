'use strict';
// WebSocket transport (the `ws` package) on /api/chat/ws. Authentication reuses the existing session cookie.
// This file is only a transport: all behaviour lives in ./service.js, so swapping to Socket.IO later means
// replacing this adapter (the frame protocol is tiny) while the service, hub, DB and UI stay unchanged.
const { WebSocketServer } = require('ws');
const { userFromRequest } = require('../auth');
const { getHub } = require('./hub');
const service = require('./service');
const { hostAllowed } = require('../host');

const HEARTBEAT_MS = 25000;

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function attachWebSocket(httpServer, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.split('?')[0].startsWith('/api/chat/ws')) return reject(socket, 404, 'Not Found');
    if (!hostAllowed(req)) return reject(socket, 421, 'Misdirected Request');
    // Cross-site WebSocket hijacking guard: browsers always send Origin; it must be this site.
    const origin = req.headers.origin;
    if (origin) { let host; try { host = new URL(origin).host; } catch { host = ''; } if (host !== req.headers.host) return reject(socket, 403, 'Forbidden'); }
    const user = userFromRequest(req);
    if (!user) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => { ws.user = user; ws.req = req; wss.emit('connection', ws); });
  });

  wss.on('connection', (ws) => {
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const unsubscribe = getHub().subscribe(ws.user.id, send);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const beat = setInterval(() => {
      // detect dead peers, and drop sockets whose session was revoked/expired or whose user was banned
      if (!ws.alive || !userFromRequest(ws.req)) return ws.close(!ws.alive ? 4000 : 4401, !ws.alive ? 'timeout' : 'session ended');
      ws.alive = false; ws.ping();
    }, heartbeatMs);
    send({ t: 'ready', userId: ws.user.id });

    ws.on('message', (raw) => {
      let cmd; try { cmd = JSON.parse(raw.toString()); } catch { return send({ t: 'res', ok: false, status: 400, error: 'Invalid frame' }); }
      const reqId = cmd && cmd.reqId;
      if (cmd && cmd.op === 'ping') return send({ t: 'res', reqId, ok: true, data: {} });
      // Re-check the session on every command so logout / ban takes effect immediately.
      const user = userFromRequest(ws.req);
      if (!user) { send({ t: 'res', reqId, ok: false, status: 401, error: 'Session ended. Please log in again.' }); return ws.close(4401, 'session ended'); }
      try { send({ t: 'res', reqId, ok: true, data: service.runCommand(user, cmd) }); }
      catch (e) { send({ t: 'res', reqId, ok: false, status: e.status || 500, error: e.status ? e.message : 'Something went wrong' }); if (!e.status) console.error(e); }
    });
    ws.on('close', () => { clearInterval(beat); unsubscribe(); });
    ws.on('error', () => ws.terminate());
  });
  return wss;
}
module.exports = { attachWebSocket };
