/**
 * ARGUS Server
 *
 * Express server that receives:
 *   POST /slack/commands     — slash command (/argus-retest <url>)
 *   POST /slack/interactions — Block Kit button interactions (Acknowledge, Retest)
 *   GET  /health             — health check
 *
 * Run: node src/server/index.js
 *
 * For production, expose this server via a public URL and configure it in
 * your Slack App settings (Slash Commands + Interactivity & Shortcuts).
 * For local development: cloudflared tunnel --url http://localhost:3001
 */

import express from 'express';
import 'dotenv/config';

import { handleSlashCommand } from './slash-command-handler.js';
import { handleInteraction } from './interaction-handler.js';

const app = express();
const PORT = process.env.PORT ?? 3001;

// ── Raw body capture (needed for Slack signature verification) ─────────────────
// Uses Express body-parser verify callbacks so req.rawBody is populated without
// consuming the stream separately (separate stream consumer would leave body parsers
// with an already-exhausted stream and produce empty req.body on every request).
// 512 KB limit matches Slack's max payload size.
const BODY_LIMIT = '512kb';

function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString('utf8');
}

// Parse URL-encoded bodies (Slack slash commands + interactions)
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT, verify: captureRawBody }));
// Parse JSON bodies
app.use(express.json({ limit: BODY_LIMIT, verify: captureRawBody }));

// ── Request error handler ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.on('error', err => {
    console.error('[ARGUS] Request stream error:', err.message);
    if (!res.headersSent) res.status(400).send('Bad request');
  });
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'argus', ts: new Date().toISOString() });
});

// Slack slash commands
app.post('/slack/commands', handleSlashCommand);

// Slack Block Kit interactions (button clicks)
app.post('/slack/interactions', handleInteraction);

// ── Start ──────────────────────────────────────────────────────────────────────

// Capture server instance so we can attach an error listener.
const server = app.listen(PORT, () => {
  console.log(`[ARGUS] Server running on port ${PORT}`);
  console.log(`[ARGUS] Slash commands:  POST http://localhost:${PORT}/slack/commands`);
  console.log(`[ARGUS] Interactions:    POST http://localhost:${PORT}/slack/interactions`);
  console.log(`[ARGUS] Health:          GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('[ARGUS] For local testing, expose with: cloudflared tunnel --url http://localhost:' + PORT);
});

// requestTimeout is assigned synchronously here — before the Node.js event loop
// processes any incoming connection — so every request inherits the 10 s limit.
// Must remain after app.listen() (the server object doesn't exist before that call)
// but must remain synchronous (not inside the listen callback) to close the startup race.
server.requestTimeout = 10_000;

// Without this, a port conflict emits an unhandled 'error' event and terminates
// the process with a cryptic EADDRINUSE message and no guidance.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ARGUS] Port ${PORT} is already in use — try PORT=3002 node src/server/index.js`);
  } else {
    console.error('[ARGUS] Server error:', err.message);
  }
  process.exit(1);
});

export default app;
