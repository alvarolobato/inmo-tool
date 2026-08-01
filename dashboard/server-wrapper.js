/**
 * Wrapper around the Next.js standalone server.
 * Sets keepAliveTimeout to 65 s before Next.js starts its HTTP server.
 * The default Node.js 18+ keepAliveTimeout is 5 s, which drops SSE connections
 * mid-stream when no data flows for > 5 s (e.g. while the LLM is thinking).
 * All active SSE clients then reconnect and receive events as a batch,
 * breaking real-time streaming.
 */
const http = require("http");

const _orig = http.createServer.bind(http);
http.createServer = function (...args) {
  const server = _orig(...args);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
};

require("./server.js");
