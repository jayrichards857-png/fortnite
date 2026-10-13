'use strict';
// Vercel entry point: exports the Express app itself (src/server.js exports an object, which Vercel cannot call as a handler).
// vercel.json routes every request here. No WebSocket server and no background timers exist in this mode (see docs/DEPLOYMENT.md).
module.exports = require('../src/server').app;
