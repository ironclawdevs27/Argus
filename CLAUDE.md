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

```
src/
  argus.js                    — single-page audit entry point
  batch-runner.js             — multi-page batch audit
  mcp-server.js               — Argus MCP server; exposes argus_audit / argus_audit_full / argus_compare / argus_last_report (v9 Sprint 6)
  adapters/
    browser.js                — CdpBrowserAdapter (v9.1.1 + v9.1.9 retry) — wraps all mcp.* calls
  domain/
    finding.js                — createFinding() factory (v9.1.4)
  registry.js                 — analyzer plugin registry (registerExpensive/getCheap/getExpensive) (v9 Sprint 2)
  orchestration/
    crawl-and-report.js       — backward-compat re-export shell (v9 Sprint 2)
    orchestrator.js           — crawl loop + runCrawl (v9 Sprint 2)
    report-processor.js       — dedup → baseline → JSON write (v9 Sprint 2)
    dispatcher.js             — Slack / GitHub / HTML dispatch (v9 Sprint 2)
    env-comparison.js         — dev vs staging diff
    watch-mode.js             — passive browser monitoring (npm run watch)
  utils/
    logger.js                 — Pino structured logger; childLogger(module) (v9 Sprint 4)
    retry.js                  — withRetry() exponential-backoff wrapper (v9 Sprint 4)
    flow-runner.js            — DSL step executor (D8 flow steps)
    mcp-parsers.js            — text-format parsers for list_console_messages / list_network_requests
    seo-analyzer.js           — A3: SEO checks
    security-analyzer.js      — A4: security checks
    content-analyzer.js       — A5: content quality
    responsive-analyzer.js    — A6: viewport emulation + overflow
    memory-analyzer.js        — B1: heap snapshot + detached DOM
    session-manager.js        — B2: backward-compat re-export barrel (v9 Sprint 4)
    session-persistence.js    — B2: saveSession / restoreSession / hasSession / clearSession (v9 Sprint 4)
    login-orchestrator.js     — B2: runLoginFlow / refreshSession + lock file (v9 Sprint 4)
    baseline-manager.js       — B3: historical baselines + trend tracking
    flakiness-detector.js     — B4: double-crawl, confirm vs flaky
    hover-analyzer.js         — D8.1: hover-state bug detection
    snapshot-analyzer.js      — D8.2: accessibility tree analysis
    mcp-client.js             — headless JSON-RPC MCP client
  config/
    targets.js                — URL targets + auth steps + centralized thresholds (v9 Sprint 3)
    schema.js                 — Zod validation schema for targets.js; validateConfig() called inside runCrawl() (v9.1.6)
.mcp.json                     — MCP server registration — argus server entry for Claude / MCP clients (v9 Sprint 6)
test-harness/
  validate.js                 — 82-block correctness harness (block [80] = MCP server, Sprint 6)
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

```
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=
SLACK_ALERT_CHANNEL_ID=
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=
```

`TARGET_DEV_URL` and `TARGET_STAGING_URL` are also read by `argus_compare` when running via `npm run mcp-server` — they are the only configuration inputs for comparison targets (cannot be overridden per-call).

## Phases Complete

D1–D8.5 (all code phases complete). Watch mode (passive browser monitoring — `npm run watch`). **v9 Sprint 1 complete** — `CdpBrowserAdapter` (`src/adapters/browser.js`), `createFinding()` factory (`src/domain/finding.js`), `mcp-parsers.js`, and all 13 analyzer/orchestration/harness files migrated from `mcp.*` to `browser.*`. **v9 Sprint 2 complete** — plugin registry (`src/registry.js`), god object split (`orchestrator.js` + `report-processor.js` + `dispatcher.js`), `crawl-and-report.js` reduced to 20-line re-export shell, 6 analyzers self-register. **v9 Sprint 3 complete** — all magic-number thresholds centralized in `src/config/targets.js`; `src/config/schema.js` (Zod) validates targets.js at startup. **v9 Sprint 4 complete** — `session-manager.js` split into `session-persistence.js` + `login-orchestrator.js` (v9.1.7); Pino structured logging across all `src/` files via `logger.js` (v9.1.8); `withRetry()` exponential backoff on `navigate` and `fill` in `CdpBrowserAdapter` — `click` is intentionally excluded (not idempotent) (v9.1.9). **v9 Sprint 5 complete** — Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (createFinding) + [82] (withRetry) added. Harness: 339/342. **v9 Sprint 6 complete** — Argus MCP server (`src/mcp-server.js`): `argus_audit`, `argus_audit_full`, `argus_compare`, `argus_last_report` tools; `.mcp.json` registration; `@modelcontextprotocol/sdk` dependency; harness block [80] (6 assertions). Harness: 345/348 (82 blocks). See `SKILL.md` §14 for the full feature list.
