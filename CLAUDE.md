# Argus — Project Context for Claude Code

## What This Project Is

Argus is an AI-driven automated QA harness that audits web pages using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP server. It catches bugs, compares dev vs staging environments, and reports to Slack with screenshots.

## Skill Reference

**CRITICAL**: Read `SKILL.md` before starting any Argus task. It is the canonical reference for:

- All MCP tool signatures and parameters
- Flow Runner DSL step actions
- Assertion patterns for `test-harness/validate.js`
- Common failure modes and fixes
- Harness statistics (82 blocks, 348 hard assertions, 54 detection categories)

## Project Structure

```text
src/
  argus.js                    — single-page audit entry point
  batch-runner.js             — multi-page batch audit
  mcp-server.js               — Argus MCP server; exposes argus_audit / argus_audit_full / argus_compare / argus_last_report
  adapters/
    browser.js                — CdpBrowserAdapter — wraps all mcp.* calls
  domain/
    finding.js                — createFinding() factory
  registry.js                 — analyzer plugin registry (registerExpensive/getCheap/getExpensive)
  orchestration/
    crawl-and-report.js       — backward-compat re-export shell
    orchestrator.js           — crawl loop + runCrawl
    report-processor.js       — dedup → baseline → JSON write
    dispatcher.js             — Slack / GitHub / HTML dispatch
    env-comparison.js         — dev vs staging diff
    watch-mode.js             — passive browser monitoring (npm run watch)
  utils/
    logger.js                 — Pino structured logger; childLogger(module)
    retry.js                  — withRetry() exponential-backoff wrapper
    telemetry.js              — OTel tracing + metrics; startSpan() / recordFinding() / recordFlaky() / recordNewFindings(); no-op default
    flow-runner.js            — DSL step executor (D8 flow steps)
    mcp-parsers.js            — text-format parsers for list_console_messages / list_network_requests
    seo-analyzer.js           — A3: SEO checks
    security-analyzer.js      — A4: security checks
    content-analyzer.js       — A5: content quality
    responsive-analyzer.js    — A6: viewport emulation + overflow
    memory-analyzer.js        — B1: heap snapshot + detached DOM
    session-manager.js        — B2: backward-compat re-export barrel
    session-persistence.js    — B2: saveSession / restoreSession / hasSession / clearSession
    login-orchestrator.js     — B2: runLoginFlow / refreshSession + lock file
    baseline-manager.js       — B3: historical baselines + trend tracking
    flakiness-detector.js     — B4: double-crawl, confirm vs flaky
    hover-analyzer.js         — D8.1: hover-state bug detection
    snapshot-analyzer.js      — D8.2: accessibility tree analysis
    mcp-client.js             — headless JSON-RPC MCP client
  config/
    targets.js                — URL targets + auth steps + centralized thresholds
    schema.js                 — Zod validation schema for targets.js; validateConfig() called inside runCrawl()
.mcp.json                     — MCP server registration — argus server entry for Claude / MCP clients
test-harness/
  validate.js                 — 82-block correctness harness (blocks [80] MCP server, [81] createFinding, [82] withRetry)
  harness-config.js           — fixture page routing table
  pages/                      — 54 fixture HTML pages
  server.js                   — fixture HTTP server
reports/
  baselines/                  — baseline.json + trends.json (gitignored)
```

## Running the Test Harness

Chrome must be running with remote debugging before starting the harness:

```bash
# Windows — start Chrome first:
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus

# Then run the harness:
npm run test:unit     # 61 Vitest unit tests — no Chrome required
npm run test:harness  # Expected: 345/348 (3 permanent MCP-limited failures)
```

Soft assertions (Lighthouse, perf traces) require non-headless Chrome — they are expected to be skipped in headless CI.

## Key Rules

- **Never use `window.innerWidth`** for overflow checks after `emulate` — use `document.documentElement.clientWidth`.
- **`evaluate_script` parameter is `function`**, not `script`. Value must be `'() => expr'`.
- MCP tool responses are markdown-wrapped — extract via regex in `mcp-client.js tool()`.
- **Fixture pages must be served via HTTP** (`npm run harness`), never via `file://`.
- Security headers middleware: apply permissive CSP/XFrame to ALL fixture pages EXCEPT `security-issues.html`.
- `clean.html` must have `og:image` — all three OG tags are `severity: warning`.
- **All analyzers use `browser.*` (not `mcp.*` directly)** — every analyzer takes a `CdpBrowserAdapter` as its first argument. Import from `src/adapters/browser.js`. Public orchestration functions keep `mcp` in their signature and construct `new CdpBrowserAdapter(mcp)` internally.
- **`list_network_requests` text format includes `requestId`** — `parseNetworkReqResponse` emits `{ requestId, method, url, status }`. Use `req.requestId` for `browser.getNetworkRequest()` lookups. Watch-mode dedup uses content-based keys (`method::url::status`), never `requestId` (resets after navigation).

## Adding a New Detection Phase

Follow the pattern in SKILL.md §9. Quick checklist:

1. `src/utils/<name>-analyzer.js` — returns `findings[]` array; call `registerExpensive({ name, analyze })` at the bottom
2. Import the analyzer as a side-effect in `src/orchestration/orchestrator.js` (controls registration order)
3. Add fixture page to `test-harness/pages/`
4. Register in `test-harness/harness-config.js`
5. Add test block to `test-harness/validate.js` (next sequential number, ≥3 hard assertions)
6. Update §14 (Harness Statistics) in `SKILL.md`

## Environment Variables (.env)

```bash
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=
SLACK_ALERT_CHANNEL_ID=
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=
OTEL_EXPORTER_OTLP_ENDPOINT=       # optional — ship spans/metrics to Jaeger/Grafana Tempo
ARGUS_OTEL_CONSOLE=                # set to 1 for dev-mode span printing to stdout
```

`TARGET_DEV_URL` and `TARGET_STAGING_URL` are also read by `argus_compare` when running via `npm run mcp-server` — they are the only configuration inputs for comparison targets (cannot be overridden per-call).

## Phases Complete

D1–D8.5 (all code phases complete). Watch mode (passive browser monitoring — `npm run watch`). Adapter layer: `CdpBrowserAdapter` (`src/adapters/browser.js`), `createFinding()` factory (`src/domain/finding.js`), `mcp-parsers.js`, all analyzer/orchestration/harness files use `browser.*`. Plugin registry (`src/registry.js`), god object split (`orchestrator.js` + `report-processor.js` + `dispatcher.js`), `crawl-and-report.js` reduced to 20-line re-export shell, 6 analyzers self-register. Threshold centralization in `src/config/targets.js`; `src/config/schema.js` (Zod) validates config at startup. Session split into `session-persistence.js` + `login-orchestrator.js`; Pino structured logging via `logger.js`; `withRetry()` exponential backoff on `navigate` and `fill` — `click` intentionally excluded (not idempotent). Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (createFinding) + [82] (withRetry). Argus MCP server (`src/mcp-server.js`): `argus_audit`, `argus_audit_full`, `argus_compare`, `argus_last_report`; `.mcp.json` registration; harness block [80]. OpenTelemetry tracing + metrics (`src/utils/telemetry.js`); spans in `runCrawl`, per-route/analyzer, `dispatchAll`, `runFlow`/steps; 5 metrics; no-op default. Harness: 345/348 (82 blocks). See `SKILL.md` §14 for the full feature list.
