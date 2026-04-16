/**
 * ARGUS Test Harness Server
 *
 * Serves deliberately broken fixture pages so the Argus crawl pipeline has
 * something real to detect.  Start on port 3100 (dev) or 3101 (staging).
 *
 *   node test-harness/server.js              # dev  → http://localhost:3100
 *   PORT=3101 node test-harness/server.js    # staging → http://localhost:3101
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3100', 10);
const IS_STAGING = PORT === 3101;

const app = express();
app.use(express.json());

// ── API routes (must come before static middleware) ────────────────────────────

// Always returns 500 — used to test HTTP 5xx detection
app.get('/api/always-500', (_req, res) => {
  res.status(500).json({ error: 'Internal Server Error', type: 'deliberate_500' });
});

// Always returns 401 — used to test auth-failure detection
app.get('/api/protected', (_req, res) => {
  res.status(401).json({ error: 'Unauthorized', type: 'auth_failure' });
});

// Always returns 403 — used to test 403 auth-failure detection (gap fix)
app.get('/api/forbidden', (_req, res) => {
  res.status(403).json({ error: 'Forbidden', type: 'forbidden' });
});

// Always returns 404 — used to test 4xx detection
app.get('/api/missing', (_req, res) => {
  res.status(404).json({ error: 'Not Found', type: 'missing_endpoint' });
});

// Normal endpoint — background noise for frequency tests
app.get('/api/data', (_req, res) => {
  res.json({ data: [1, 2, 3], env: IS_STAGING ? 'staging' : 'dev' });
});

// ── Feature flags — dev only (not called from staging-home.html) ──────────────
// Used to test "request present in dev but missing on staging" env-comparison detection.
app.get('/api/feature-flags', (_req, res) => {
  res.json({ flags: { darkMode: true, betaSignup: false, newNav: true } });
});

// ── Slow image (3 000 ms delay) — used for LCP test ───────────────────────────
// perf-lcp.html references this as the hero image.  Chrome records LCP when
// the image finally renders, which will be 3 000 ms+ after navigation.
app.get('/api/slow-image', (_req, res) => {
  setTimeout(() => {
    // Minimal valid 1×1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  }, 3000);
});

// ── API frequency test endpoints ───────────────────────────────────────────────
// api-frequency.html calls each of these N times to trigger the frequency ladder.

app.get('/api/data-loop', (_req, res) => {
  res.json({ result: 'loop' });
});

app.get('/api/data-batch', (_req, res) => {
  res.json({ result: 'batch' });
});

app.get('/api/data-pair', (_req, res) => {
  res.json({ result: 'pair' });
});

// ── Environment comparison endpoints ──────────────────────────────────────────
// These behave differently on dev vs staging so env-comparison.js catches them.

app.get('/api/checkout', (_req, res) => {
  if (IS_STAGING) {
    res.status(500).json({ error: 'Checkout service unavailable on staging' });
  } else {
    res.json({ status: 'ok', total: 99.99 });
  }
});

app.get('/api/analytics', (_req, res) => {
  if (IS_STAGING) {
    res.status(404).json({ error: 'Analytics not configured on staging' });
  } else {
    res.json({ events: [], sessionId: 'abc123' });
  }
});

// Exists on both envs but returns different shapes — new endpoint in staging
app.get('/api/tracking', (_req, res) => {
  res.json({ tracking: true, env: IS_STAGING ? 'staging' : 'dev' });
});

// ── Network performance test endpoints (v3 Phase A2) ─────────────────────────
// api-performance.html fetches all four of these in parallel.

// Slow response — warning tier (1 500 ms > 1 000 ms threshold)
app.get('/api/slow-warning', (_req, res) => {
  setTimeout(() => res.json({ status: 'ok', delay: 1500, tier: 'warning' }), 1500);
});

// Slow response — critical tier (3 200 ms > 3 000 ms threshold)
app.get('/api/slow-critical', (_req, res) => {
  setTimeout(() => res.json({ status: 'ok', delay: 3200, tier: 'critical' }), 3200);
});

// Large payload — warning tier (~600 KB decodedBodySize > 500 KB threshold)
// 600 items × ~1 014 chars each ≈ 610 KB uncompressed JSON
app.get('/api/large-warning', (_req, res) => {
  const items = Array.from({ length: 600 }, (_, i) => ({ id: i, v: 'x'.repeat(1000) }));
  res.json({ items });
});

// Large payload — critical tier (~2.2 MB decodedBodySize > 2 MB threshold)
// 2 200 items × ~1 014 chars each ≈ 2.23 MB uncompressed JSON
app.get('/api/large-critical', (_req, res) => {
  const items = Array.from({ length: 2200 }, (_, i) => ({ id: i, v: 'x'.repeat(1000) }));
  res.json({ items });
});

// ── Performance test route (deliberate TTFB delay) ─────────────────────────────
// Delays the response by 1 200 ms so TTFB exceeds the 800 ms budget.

app.get('/perf-issues.html', (_req, res) => {
  setTimeout(() => {
    res.sendFile(path.join(__dirname, 'pages', 'perf-issues.html'));
  }, 1200);
});

// ── Dynamic home route for env-comparison tests ────────────────────────────────
// Both the dev and staging servers expose `/` but serve different HTML so the
// comparison engine can detect visual + DOM differences.

app.get('/', (_req, res) => {
  const file = IS_STAGING ? 'staging-home.html' : 'dev-home.html';
  res.sendFile(path.join(__dirname, 'pages', file));
});

// ── Static assets ──────────────────────────────────────────────────────────────
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use('/', express.static(path.join(__dirname, 'pages')));

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[ARGUS Harness] Server running on http://localhost:${PORT} (${IS_STAGING ? 'staging' : 'dev'})`);
  console.log(`[ARGUS Harness] Fixture pages: http://localhost:${PORT}/clean.html`);
});
