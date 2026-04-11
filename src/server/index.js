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
// Must come before any body parser so req.rawBody is available in handlers
app.use((req, res, next) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    req.rawBody = raw;
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

app.listen(PORT, () => {
  console.log(`[ARGUS] Server running on port ${PORT}`);
  console.log(`[ARGUS] Slash commands:  POST http://localhost:${PORT}/slack/commands`);
  console.log(`[ARGUS] Interactions:    POST http://localhost:${PORT}/slack/interactions`);
  console.log(`[ARGUS] Health:          GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('[ARGUS] For local testing, expose with: cloudflared tunnel --url http://localhost:' + PORT);
});

export default app;
