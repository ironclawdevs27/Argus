# Argus — Project Context for Claude Code

## What This Project Is

Argus is an AI-driven automated QA harness that audits web pages using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP server. It catches bugs, compares dev vs staging environments, and reports to Slack with screenshots.

## Skill Reference

**CRITICAL**: Read `SKILL.md` before starting any Argus task. It is the canonical reference for:

- All MCP tool signatures and parameters
- Flow Runner DSL step actions
- Assertion patterns for `test-harness/validate.js`
- Common failure modes and fixes
- Harness statistics (131 blocks, 590 hard assertions, 59 detection categories)

## Project Structure

```text
src/
  argus.js                    — single-page audit entry point
  batch-runner.js             — multi-page batch audit
  mcp-server.js               — Argus MCP server; exposes argus_audit / argus_audit_full / argus_compare / argus_last_report / argus_watch_snapshot / argus_get_context / argus_design_audit
  adapters/
    browser.js                — CdpBrowserAdapter — wraps all mcp.* calls
    figma.js                  — Figma REST adapter — getFigmaFrame() + parseFigmaUrl()
  domain/
    finding.js                — createFinding() factory
  registry.js                 — analyzer plugin registry (registerCheap/registerExpensive/getCheap/getExpensive/clearAll)
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
    theme-analyzer.js         — A7: Theme & Dark Mode detection
    design-fidelity-analyzer.js — D9: Figma design token vs DOM comparison
    web-vitals-analyzer.js    — Sprint 9: LCP/CLS/FCP/TTI/TTFB via Performance API + bundle size regression
    visual-diff-analyzer.js   — A8: Visual regression — pixelmatch screenshot baseline comparison
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
  package.json                — React 19, Vite 8, Tailwind, Framer Motion 12, @supabase/supabase-js
  .env.example                — committed template: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
  .env.local                  — gitignored — real Supabase credentials (copy from .env.example)
test-harness/
  validate.js                 — 131-block correctness harness (blocks [80]–[84] MCP/createFinding/withRetry/watch/init; [85]–[93] Sprint 0.5 Tier 3; [94]–[126] gap-close; [127] A7 theme; [128] D9 design fidelity; [129] Sprint 9 Web Vitals; [130] A8 Visual Regression; [131] Sprint 4 A12 Axe-core)
  harness-config.js           — fixture page routing table
  pages/                      — 58 fixture HTML pages
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
# Windows (PowerShell) — start Chrome first:
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"

# Then run the harness:
npm run test:unit     # 61 Vitest unit tests — no Chrome required
npm run test:harness  # Expected: 587/590 (3 permanent MCP-limited failures)
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

D1–D8.5 (all code phases complete). Watch mode (passive browser monitoring — `npm run watch`; polls every 1 s by default; live web dashboard at `http://localhost:3002`, configurable via `ARGUS_WATCH_UI_PORT`). Adapter layer: `CdpBrowserAdapter` (`src/adapters/browser.js`), `createFinding()` factory (`src/domain/finding.js`), `mcp-parsers.js`, all analyzer/orchestration/harness files use `browser.*`. Plugin registry (`src/registry.js`), god object split (`orchestrator.js` + `report-processor.js` + `dispatcher.js`), `crawl-and-report.js` reduced to 16-line re-export shell, 6 analyzers self-register. Threshold centralization in `src/config/targets.js`; `src/config/schema.js` (Zod) validates config at startup. Session split into `session-persistence.js` + `login-orchestrator.js`; Pino structured logging via `logger.js`; `withRetry()` exponential backoff on `navigate` and `fill` — `click` intentionally excluded (not idempotent). Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (createFinding) + [82] (withRetry). Argus MCP server (`src/mcp-server.js`): 7 tools — `argus_audit` (+ `cache:true` option, `auditCache` Map), `argus_audit_full`, `argus_compare`, `argus_last_report`, `argus_watch_snapshot` (+ `tabId` for multi-tab), `argus_get_context` (+ `tabId` + `open_tabs` response field; fix loop: `snapshot_id` diff `resolved / new_issues / persisting`), `argus_design_audit` (Figma fidelity audit, 13 finding types + selector fallback chain); `snapshotStore` + `auditCache` Maps (max 20 entries, LRU eviction); `CdpBrowserAdapter` now has `listPages()` + `selectPage(tabId)`; published to npm as `argusqa-os@9.5.5`; CI harness gate via `.github/workflows/harness-ci.yml` (exits 0 on known permanent failures only); `glama.json` expanded with name + description + tools; harness block [84] (7 assertions, `cli/init.js` smoke test); permanent-failure exit logic in `validate.js` (exits 0 when only [49b]/[67b]/[68b] fail). Sprint 0.5 Tier 1 complete: `browser.heapSnapshot` → `take_heapsnapshot`; `browser.emulateCpu` → `emulate({ cpuThrottlingRate })`; stale `emulate_cpu` entry removed from `mcp-client.js`. Sprint 0.5 Tier 2 complete (v9.4.6): GAP-002 path traversal fix (`path.relative()`), GAP-003 `withMcp()` error logging, GAP-008 Slack `WebClient` lazy-init, GAP-009 401/403 gated on `routeIsCritical`, GAP-010 broken-link 15 s outer timeout, GAP-001 late JSON-RPC response logging, GAP-006 CI harness KNOWN_PERMANENT documented. Also: all 10 Dependabot PRs applied (v9.4.3); phantom `chrome` dep + unused `sharp` removed; Socket.dev URL fixes — `y.com`/`yourapp.com` → `example.com` (v9.4.5); OTel `service.version` corrected to current; MCP Registry description updated; published to registry.modelcontextprotocol.io + listed on awesome-mcp-servers (PR #7022). Sprint 0.5 Tier 3 complete (v9.5.0): 9 new harness blocks [85]–[93] — production-code-path regression tests for GAP-009 (401/403 severity via `crawlRouteCheap`), GAP-022–GAP-030; `diffNetworkRequests`/`diffConsoleMessages` utility unit tests; `checkLighthouse` contract (soft); 27 new hard assertions. Harness: 525/528 (126 blocks). Gap-close complete (Sections 1–6 of `test-harness-gaps.md`): 33 new blocks [94]–[126] added across 6 sections, covering zero-coverage modules, partial-coverage edge cases, MCP stdio transport, npm scripts, unhappy paths, and CLI end-to-end file write. Sprint 0.5 Tier 4 complete (2026-05-31): 14 code-quality gaps resolved — `snapshot(opts)` forwarding (GAP-014), stale version comments removed from 4 files (GAP-016), shell metacharacter check removed from `mcp-client.js` (GAP-017), `LIGHTHOUSE_TIMEOUT_MS` promoted to module level and applied to `checkLighthouse()` (GAP-018), click no-retry documented in `flow-runner.js` (GAP-019), `saveSession()` file-write wrapped in try/catch (GAP-020), `ARGUS_WATCH_UI_PORT` added to `.env.example` (GAP-021), `createFinding()` canonical optional fields documented (GAP-033), CSS analysis moved to `registerExpensive` plugin (GAP-034), retry log includes error constructor name (GAP-036), Slack retry adds jitter (GAP-037), `mcp.close()` error logged at debug level (GAP-038), route path added to orchestrator log lines (GAP-039), `restoreSession()` navigate wrapped with 10 s timeout (GAP-040). Sprint 1 complete (v9.5.2, 2026-06-01): `theme-analyzer.js` — A7 Theme & Dark Mode detection; `emulateColorScheme(scheme)` added to `CdpBrowserAdapter`; fixture `theme-issues.html`; harness block [127] (7 assertions). Sprint 2 complete (v9.5.3, 2026-06-04): `src/adapters/figma.js` — `inferSelectors()` generates 4 selector candidates per node (`[data-testid="slug"]`, `[aria-label="name"]`, `#slug`, `.slug`; explicit selectors like `#hero` honoured verbatim); per-corner radii extracted as `{topLeft,topRight,bottomRight,bottomLeft}` object when non-uniform; shadow includes spread + r/g/b/a; text content (`characters`); `design-fidelity-analyzer.js` — `findElementWithSelector()` tries each candidate, reports matched selector in finding; 13 mismatch finding types: `design_token_mismatch`, `design_component_missing`, `design_color_mismatch` (RGB Euclidean, threshold 22), `design_typography_mismatch` (fontSize/fontWeight/lineHeight/fontFamily/letterSpacing), `design_spacing_mismatch` (padding, 2px), `design_radius_mismatch` (per-corner, 1px each), `design_bounds_overflow` (5px), `design_position_drift` (scroll-corrected absolute x/y vs Figma bounds, 20px), `design_stroke_mismatch` (border color+weight), `design_shadow_mismatch` (offsetX/Y 1px + blur 2px + spread 2px + color RGB), `design_opacity_mismatch` (10%, when Figma < 100%), `design_gap_mismatch` (columnGap/rowGap by layoutMode, 2px), `design_text_mismatch` (textContent vs Figma characters); 12 threshold constants; `design_fidelity_summary` aggregates all 13 counts; `argus_design_audit` summary returns all 13 + positionDrifts counts; fixture `design-fidelity.html` has 11 elements; block [128] has 30 assertions [128a]–[128ad]; 56 detection categories; 128 blocks / 565 assertions (pre-Sprint-9). Sprint 9 complete (v9.5.4, 2026-06-05): `web-vitals-analyzer.js` — per-run Core Web Vitals via browser Performance API (headless-compatible): LCP, CLS, FCP, TTI, TTFB; `perf_bundle_large` (JS ≥500KB warning / ≥2MB critical; CSS ≥150KB warning); `perf_vitals_summary` always emitted; fixture `perf-vitals.html`; harness block [129] (7 hard + 2 soft assertions); 57 detection categories; 57 fixture pages; 130 blocks / 581 assertions / 587/590 gate. Sprint 3 complete (v9.5.5, 2026-06-06): `visual-diff-analyzer.js` — A8 Visual Regression via pixelmatch screenshot baseline comparison; `visual_baseline_created` (info, first run), `visual_regression` (warning ≥0.1% / critical ≥5%), `visual_diff_summary` (always emitted); BFcache fix; fixture `visual-regression.html`; block [130] 9 assertions. Sprint 4 complete (v9.5.6, 2026-06-06): `a11y-deep-analyzer.js` — axe-core 4.12 injection (80+ WCAG 2.x rules, impact→severity mapping, dedup with existing analyzers) + protanopia/deuteranopia CVD color blind simulation; `a11y_axe_violation` (critical/warning/info), `a11y_colorblind_risk` (warning), `a11y_deep_summary` (info, always); fixture `a11y-deep-issues.html`; block [131] 9 assertions; 59 detection categories; 58 fixture pages; 131 blocks; 590 assertions; 587/590 gate. See `SKILL.md` §14 for the full feature list. — A8 Visual Regression via pixelmatch screenshot baseline comparison; `visual_baseline_created` (info, first run), `visual_regression` (warning ≥0.1% / critical ≥5%), `visual_diff_summary` (always emitted); BFcache fix: `Cache-Control: no-store` on `perf-vitals.html` + HEAD-request fallback in VITALS_SCRIPT; fixture `visual-regression.html`; harness block [130] 9 assertions; 58 detection categories; 57 fixture pages; 130 blocks; 581 assertions; 587/590 gate. See `SKILL.md` §14 for the full feature list.

**Landing page** (`landing/`): React 19 + Vite 8 + Tailwind + Framer Motion SPA with Supabase-backed waitlist and enterprise contact forms. Deployed to `argus-qa.com` via Cloudflare Pages (`npx wrangler pages deploy dist --project-name argus-qa`); video served from Cloudflare R2. Sprint 0 complete (2026-05-26): 44px touch targets, `MotionConfig reducedMotion="user"`, modal `100dvh` keyboard fix, `@supports (height: 100dvh)` CSS. Hero stats row stacks on mobile (`flex-col sm:flex-row`); slide widget reduced to 6 slides; `clamp()`-based fluid typography throughout. SEO: full OG tags, `summary_large_image` Twitter card, canonical, JSON-LD `SoftwareApplication`, `robots.txt`, `sitemap.xml`. OG social card: `landing/public/og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png`, branded overlay with black-outlined purple stat numbers. Video poster: `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag. `landing/public/og-image.jpg` gitignored.
