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
// Must come before any body parser so req.rawBody is available in handlers.
// GAP-35: Enforce a 512 KB size limit — Slack payloads are small; oversized bodies
// indicate abuse or misconfiguration and should be rejected early.
const MAX_RAW_BODY = 512_000;
app.use((req, res, next) => {
  // GAP-82: Accumulate as Buffer chunks — string concat with += coerces each Buffer to
  // UTF-8 per-chunk and creates GC pressure; Buffer.concat defers encoding to 'end'.
  // Avoids silent corruption of multi-byte sequences split across chunk boundaries.
  const chunks = [];
  let totalLength = 0;
  req.on('data', chunk => {
    totalLength += chunk.length;
    if (totalLength > MAX_RAW_BODY) {
      // GAP-97: Destroy after 'finish' so the 413 response is fully flushed first.
      res.status(413).send('Payload Too Large');
      res.on('finish', () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  });
});

// Parse URL-encoded bodies (Slack slash commands + interactions)
app.use(express.urlencoded({ extended: true }));
// Parse JSON bodies
app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'argus', ts: new Date().toISOString() });
});

// Slack slash commands
app.post('/slack/commands', handleSlashCommand);

// Slack Block Kit interactions (button clicks)
app.post('/slack/interactions', handleInteraction);

// ── Start ──────────────────────────────────────────────────────────────────────

// GAP-41: Capture server instance so we can attach an error listener.
const server = app.listen(PORT, () => {
  console.log(`[ARGUS] Server running on port ${PORT}`);
  console.log(`[ARGUS] Slash commands:  POST http://localhost:${PORT}/slack/commands`);
  console.log(`[ARGUS] Interactions:    POST http://localhost:${PORT}/slack/interactions`);
  console.log(`[ARGUS] Health:          GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('[ARGUS] For local testing, expose with: cloudflared tunnel --url http://localhost:' + PORT);
});

// GAP-83: requestTimeout is assigned synchronously here — before the Node.js event loop
// processes any incoming connection — so every request inherits the 10 s limit.
// Must remain after app.listen() (the server object doesn't exist before that call)
// but must remain synchronous (not inside the listen callback) to close the startup race.
server.requestTimeout = 10_000;

// GAP-41: Without this, a port conflict emits an unhandled 'error' event and terminates
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
