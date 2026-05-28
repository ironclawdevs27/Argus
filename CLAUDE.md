# Argus — Project Context for Claude Code

## What This Project Is

Argus is an AI-driven automated QA harness that audits web pages using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP server. It catches bugs, compares dev vs staging environments, and reports to Slack with screenshots.

## Skill Reference

**CRITICAL**: Read `SKILL.md` before starting any Argus task. It is the canonical reference for:

- All MCP tool signatures and parameters
- Flow Runner DSL step actions
- Assertion patterns for `test-harness/validate.js`
- Common failure modes and fixes
- Harness statistics (83 blocks, 360 hard assertions, 54 detection categories)

## Project Structure

```text
src/
  argus.js                    — single-page audit entry point
  batch-runner.js             — multi-page batch audit
  mcp-server.js               — Argus MCP server; exposes argus_audit / argus_audit_full / argus_compare / argus_last_report / argus_watch_snapshot / argus_get_context
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
    slack-notifier.js         — Slack Block Kit message builder
    env-comparison.js         — dev vs staging diff
    watch-mode.js             — passive browser monitoring (npm run watch)
  server/
    index.js                  — Express server (port 3001) for Slack slash commands + interactions
    slash-command-handler.js  — /argus-retest slash command handler
    interaction-handler.js    — Acknowledge + Retest button handler
  cli/
    init.js                   — C4: argus init interactive setup wizard
  utils/
    logger.js                 — Pino structured logger; childLogger(module)
    retry.js                  — withRetry() exponential-backoff wrapper
    telemetry.js              — OTel tracing + metrics; startSpan() / recordFinding() / recordFlaky() / recordNewFindings(); no-op default
    flow-runner.js            — DSL step executor (D8 flow steps)
    mcp-parsers.js            — text-format parsers for list_console_messages / list_network_requests
    mcp-client.js             — headless JSON-RPC MCP client
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
    keyboard-analyzer.js      — keyboard Tab-walk focus analysis
    issues-analyzer.js        — Chrome DevTools Issues panel (CSP/CORS/deprecated)
    network-timing-analyzer.js — HAR timing analysis for slow third-party detection
    lighthouse-checker.js     — Lighthouse soft assertions
    codebase-analyzer.js      — C1: static source analysis
    github-reporter.js        — C2: PR comment + commit status
    route-discoverer.js       — C3: sitemap + Next.js + React Router discovery
    contract-validator.js     — D7.4: API response schema validation
    parallel-crawler.js       — D7.3: parallel route crawling
    html-reporter.js          — D7.1: HTML dashboard bundler
    severity-overrides.js     — D7.5: post-process severity policy
    slack-guard.js            — D7.7: Slack-optional guard
    api-frequency.js          — request frequency tracking
    css-analyzer.js           — CSS rule analysis
    diff.js                   — finding diff utilities
    slug.js                   — URL slug helpers
  config/
    targets.js                — URL targets + auth steps + centralized thresholds
    schema.js                 — Zod validation schema for targets.js; validateConfig() called inside runCrawl()
.mcp.json                     — MCP server registration — npx argusqa-os entry; argus server for Claude / MCP clients
landing/
  src/
    App.jsx                   — single-page React app (hero, features, comparison, waitlist modal, enterprise modal)
    supabase.js               — Supabase client factory; exports null if VITE_SUPABASE_* env vars missing
  public/
    favicon.svg               — SVG favicon replicating Logo() component (#5E0ED7 ring + dot)
    argus-poster.png          — video poster fallback (1918×1078; source for OG card)
    og-image-v2.jpg           — branded OG social card (1200×630, cover-mode scaled, black-outlined stat numbers)
    robots.txt                — allows all crawlers; Sitemap reference
    sitemap.xml               — canonical URL for argus-qa.com/
  index.html                  — Vite entry; OG/Twitter/JSON-LD SEO tags; canonical; favicon link
  package.json                — React 18, Vite, Tailwind, Framer Motion, @supabase/supabase-js
  .env.example                — committed template: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
  .env.local                  — gitignored — real Supabase credentials (copy from .env.example)
test-harness/
  validate.js                 — 82-block correctness harness (blocks [80] MCP server, [81] createFinding, [82] withRetry)
  harness-config.js           — fixture page routing table
  pages/                      — 54 fixture HTML pages
  server.js                   — fixture HTTP server
  nextjs-fixture/             — Next.js pages/+app/ structure for C3 route discovery tests
  source-fixture/             — JS source + .env fixture for C1 codebase analysis tests
test/
  unit/                       — 6 Vitest unit test files (61 tests); run with npm run test:unit
scripts/
  dispatch-report.js          — standalone Slack re-dispatch for an existing JSON report
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
# Slack (all optional — omit to use HTML report mode)
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_CRITICAL=            # channel ID for critical bug reports
SLACK_CHANNEL_WARNINGS=            # channel ID for warnings
SLACK_CHANNEL_DIGEST=              # channel ID for daily digest
PORT=3001                          # Slack slash-command server port

# Target URLs
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=

# OTel (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=       # ship spans/metrics to Jaeger/Grafana Tempo
ARGUS_OTEL_CONSOLE=                # set to 1 for dev-mode span printing to stdout

# Logging + retry (optional)
ARGUS_LOG_LEVEL=                   # info (default), debug, warn, error
ARGUS_LOG_PRETTY=                  # 1 = force pino-pretty, 0 = force JSON, unset = auto TTY
ARGUS_RETRY_ATTEMPTS=              # max retries on navigate/fill (default: 3; set 1 to disable in CI)

# Runtime (optional)
ARGUS_CONCURRENCY=                 # parallel MCP clients (default: 1)
ARGUS_WATCH_INTERVAL_MS=           # watch mode poll interval ms (default: 1000)
ARGUS_WATCH_UI_PORT=               # watch mode web dashboard port (default: 3002)
SCREENSHOT_DIFF_THRESHOLD=0.5      # pixel diff % threshold for env comparison
REPORT_OUTPUT_DIR=./reports

# C1: Codebase analysis (optional)
ARGUS_SOURCE_DIR=                  # path to app source directory
ARGUS_ENV_FILE=                    # path to app .env file for env var audit

# C2: GitHub PR integration (optional)
GITHUB_TOKEN=
GITHUB_REPOSITORY=                 # owner/repo
GITHUB_PR_NUMBER=                  # set in CI: ${{ github.event.pull_request.number }}
ARGUS_REPORT_URL=                  # URL linked from commit status check
```

### Landing Page (`landing/.env.local`)

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co    # bare project URL — no /rest/v1 suffix
VITE_SUPABASE_ANON_KEY=eyJ...                          # anon public key from Supabase dashboard
```

Tables required in Supabase (RLS on, plus `GRANT INSERT ON <table> TO anon`):
- `waitlist (id, email, plan, created_at, source)`
- `enterprise_contacts (id, name, email, company, team_size, region, use_case, workflow, message, created_at)`

`TARGET_DEV_URL` and `TARGET_STAGING_URL` are also read by `argus_compare` when running via `npm run mcp-server` — they are the only configuration inputs for comparison targets (cannot be overridden per-call).

## Phases Complete

D1–D8.5 (all code phases complete). Watch mode (passive browser monitoring — `npm run watch`; polls every 1 s by default; live web dashboard at `http://localhost:3002`, configurable via `ARGUS_WATCH_UI_PORT`). Adapter layer: `CdpBrowserAdapter` (`src/adapters/browser.js`), `createFinding()` factory (`src/domain/finding.js`), `mcp-parsers.js`, all analyzer/orchestration/harness files use `browser.*`. Plugin registry (`src/registry.js`), god object split (`orchestrator.js` + `report-processor.js` + `dispatcher.js`), `crawl-and-report.js` reduced to 20-line re-export shell, 6 analyzers self-register. Threshold centralization in `src/config/targets.js`; `src/config/schema.js` (Zod) validates config at startup. Session split into `session-persistence.js` + `login-orchestrator.js`; Pino structured logging via `logger.js`; `withRetry()` exponential backoff on `navigate` and `fill` — `click` intentionally excluded (not idempotent). Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (createFinding) + [82] (withRetry). Argus MCP server (`src/mcp-server.js`): 6 tools — `argus_audit`, `argus_audit_full`, `argus_compare`, `argus_last_report`, `argus_watch_snapshot` (raw findings snapshot of current tab without navigating), `argus_get_context` (LLM-optimized context + fix loop: returns `snapshot_id` each call; pass it back to get `resolved / new_issues / persisting` diff arrays — closes the detect → fix → verify loop); `snapshotStore` Map (max 20 entries, LRU eviction); published to npm as `argusqa-os@9.3.1` — users run via `npx -y argusqa-os`; shebang + `process.cwd()` reports path + `files: ["src/", ".mcp.json"]` scope + improved tool descriptions; `.mcp.json` updated to npx form; harness block [80] (12 assertions). New harness block [83] (6 assertions) covers watch dashboard contracts. OpenTelemetry tracing + metrics (`src/utils/telemetry.js`); spans in `runCrawl`, per-route/analyzer, `dispatchAll`, `runFlow`/steps; 5 metrics; no-op default. Harness: 357/360 (83 blocks). See `SKILL.md` §14 for the full feature list.

**Landing page** (`landing/`): React 18 + Vite + Tailwind + Framer Motion SPA with Supabase-backed waitlist and enterprise contact forms. Deployed to `argus-qa.com` via Cloudflare Pages (`npx wrangler pages deploy dist --project-name argus-qa`); video served from Cloudflare R2. Sprint 0 complete (2026-05-26): 44px touch targets, `MotionConfig reducedMotion="user"`, modal `100dvh` keyboard fix, `@supports (height: 100dvh)` CSS. Hero stats row stacks on mobile (`flex-col sm:flex-row`); slide widget reduced to 6 slides; `clamp()`-based fluid typography throughout. SEO: full OG tags, `summary_large_image` Twitter card, canonical, JSON-LD `SoftwareApplication`, `robots.txt`, `sitemap.xml`. OG social card: `landing/public/og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png`, branded overlay with black-outlined purple stat numbers. Video poster: `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag. `landing/public/og-image.jpg` gitignored.
