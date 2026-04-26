# Argus — Project Context for Claude Code

## What This Project Is

Argus is an AI-driven automated QA harness that audits web pages using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP server. It catches bugs, compares dev vs staging environments, and reports to Slack with screenshots.

## Skill Reference

**CRITICAL**: Read `SKILL.md` before starting any Argus task. It is the canonical reference for:
- All MCP tool signatures and parameters
- Flow Runner DSL step actions
- Assertion patterns for `test-harness/validate.js`
- Common failure modes and fixes
- Harness statistics (50 blocks, 210 hard assertions, 35 detection categories)

## Project Structure

```
src/
  argus.js                    — single-page audit entry point
  batch-runner.js             — multi-page batch audit
  orchestration/
    crawl-and-report.js       — full crawl pipeline
    env-comparison.js         — dev vs staging diff
  utils/
    flow-runner.js            — DSL step executor (D8 flow steps)
    seo-analyzer.js           — A3: SEO checks
    security-analyzer.js      — A4: security checks
    content-analyzer.js       — A5: content quality
    responsive-analyzer.js    — A6: viewport emulation + overflow
    memory-analyzer.js        — B1: heap snapshot + detached DOM
    session-manager.js        — B2: auth cookie/localStorage save+restore
    baseline-manager.js       — B3: historical baselines + trend tracking
    flakiness-detector.js     — B4: double-crawl, confirm vs flaky
    hover-analyzer.js         — D8.1: hover-state bug detection
    snapshot-analyzer.js      — D8.2: accessibility tree analysis
    mcp-client.js             — headless JSON-RPC MCP client
  config/
    targets.js                — URL targets + auth steps
test-harness/
  validate.js                 — 50-block correctness harness
  harness-config.js           — fixture page routing table
  pages/                      — 44 fixture HTML pages
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
npm run test:harness
# Expected: 210/210 hard assertions passed
```

Soft assertions (Lighthouse, perf traces) require non-headless Chrome — they are expected to be skipped in headless CI.

## Key Rules

- **Never use `window.innerWidth`** for overflow checks after `emulate` — use `document.documentElement.clientWidth`.
- **`evaluate_script` parameter is `function`**, not `script`. Value must be `'() => expr'`.
- MCP tool responses are markdown-wrapped — extract via regex in `mcp-client.js tool()`.
- **Fixture pages must be served via HTTP** (`npm run harness`), never via `file://`.
- Security headers middleware: apply permissive CSP/XFrame to ALL fixture pages EXCEPT `security-issues.html`.
- `clean.html` must have `og:image` — all three OG tags are `severity: warning`.

## Adding a New Detection Phase

Follow the pattern in SKILL.md §9. Quick checklist:
1. `src/utils/<name>-analyzer.js` — returns `findings[]` array
2. Wire into `src/argus.js` / `flow-runner.js`
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

## Phases Complete

D1–D8.5 (all code phases complete). See `SKILL.md` §14 for the full feature list.
