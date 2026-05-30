# Argus — Technical Solution Document

> **Status**: All phases complete through v9.4.1 (2026-05-30, Session 40). v9.4.1 patch: `handleAudit` now returns `{ findings, summary }` as documented (API contract fix); CI Chrome startup uses 15-attempt retry loop. v9 Sprint 10 (Session 39): `argus_audit` caching (`cache:true`, `auditCache` Map); multi-tab watch mode (`tabId` on `argus_watch_snapshot` + `argus_get_context`, `open_tabs` in context response, `listPages()`/`selectPage()` on `CdpBrowserAdapter`); GitHub Actions harness CI gate (`.github/workflows/harness-ci.yml`, exits 0 on known permanent failures); `glama.json` expanded with name + description + 6 tools; harness block [84] (7 assertions, `cli/init.js` smoke test); permanent-failure exit logic in `validate.js`. Published as `argusqa-os@9.4.1`. v9 Sprint 9 (Session 38, 2026-05-29): fix loop (`snapshot_id` diff); watch dashboard port 3002; block [83]; 357/360. Sprint 8: `argus_watch_snapshot` + `argus_get_context`; watch interval 1 s; `argusqa-os@9.3.0`. Landing page built + Supabase integration (Session 35, 2026-05-25). Sprint 0 mobile + SEO complete; deployed to argus-qa.com (Session 36, 2026-05-26). Published `argusqa-os@9.2.0` (Session 37, 2026-05-27). v7 final production hardening (Session 24, 2026-05-05). v9 Sprints 1–7 (Sessions 27–34, 2026-05-17 to 2026-05-24) — CdpBrowserAdapter, plugin registry, god object split, Zod config, session split, Pino logging, withRetry, Vitest unit tests, OTel.
> **Harness**: 84 blocks · 367 hard assertions · 54 fixture pages · 54 detection categories

---

## 1. What Argus Is

Argus is an AI-driven automated QA harness that audits web applications using the Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP server. It drives a real Chromium browser, executes multi-step user flows, performs static codebase analysis, and emits structured JSON findings with severity ratings.

**Key capabilities**:

- Crawls every configured route and detects 53+ classes of bugs
- Executes DSL-defined multi-step user flows with assertions
- Compares dev vs staging environments and diffs findings
- Tracks baselines across runs — only alerts on *new* issues
- Posts structured findings to Slack (optional, non-blocking)
- Posts PR comments and sets commit status checks in GitHub (optional)
- Audits static source code for missing env vars and dead routes
- Auto-discovers routes from sitemap.xml, Next.js file structure, and React Router config
- Guides first-time setup via interactive `npm run init` wizard

---

## 2. Architecture

```text
┌─────────────────────────────────────────────────────────┐
│  Entry Points                                           │
│  src/argus.js              — single-page CLI audit      │
│  src/batch-runner.js       — multi-page batch audit     │
│  src/mcp-server.js         — AI-callable MCP server     │
│  src/orchestration/        — full crawl pipeline        │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Orchestration Layer (src/orchestration/)               │
│  orchestrator.js      — crawl loop + runCrawl()         │
│  report-processor.js  — dedup → baseline → JSON write   │
│  dispatcher.js        — Slack / GitHub / HTML dispatch  │
│  crawl-and-report.js  — re-export shell (backward compat│
│  env-comparison.js    — dev vs staging diff             │
│  registry.js          — analyzer plugin registry        │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Analyzers (src/utils/)                                 │
│  seo-analyzer.js          — A3: meta tags, OG, sitemap  │
│  security-analyzer.js     — A4: headers, mixed content  │
│  content-analyzer.js      — A5: broken links, images    │
│  responsive-analyzer.js   — A6: viewport overflow       │
│  memory-analyzer.js       — B1: heap leak detection     │
│  session-manager.js       — B2: auth cookie/storage     │
│  baseline-manager.js      — B3: historical baselines    │
│  flakiness-detector.js    — B4: double-crawl confirm    │
│  hover-analyzer.js        — D8.1: hover-state bugs      │
│  snapshot-analyzer.js     — D8.2: a11y tree analysis    │
│  codebase-analyzer.js     — C1: static source analysis  │
│  github-reporter.js       — C2: PR comment + CI status  │
│  route-discoverer.js      — C3: sitemap + Next.js + RR  │
│  flow-runner.js           — D8+ flow DSL executor       │
│  (cli/init.js)            — C4: argus init wizard       │
│  contract-validator.js    — D7.4: API schema checks     │
│  severity-overrides.js    — D7.5: post-process policy   │
│  parallel-crawler.js      — D7.3: parallel route crawl  │
│  html-reporter.js         — D7.1: HTML dashboard        │
│  slack-guard.js           — D7.7: Slack optional mode   │
│  telemetry.js             — OTel tracing + metrics      │
└─────────────────────────────────────────────────────────┘
```

---

## 3. File Structure

```text
src/
  argus.js                       — single-page audit entry point
  batch-runner.js                — multi-page batch audit
  mcp-server.js                  — AI-callable MCP server; argus_audit / argus_audit_full / argus_compare / argus_last_report
  adapters/
    browser.js                   — CdpBrowserAdapter: facade over all chrome-devtools-mcp calls
  domain/
    finding.js                   — createFinding() factory: canonical finding shape
  registry.js                    — analyzer plugin registry (registerExpensive/getCheap/getExpensive)
  orchestration/
    crawl-and-report.js          — backward-compat re-export shell → orchestrator + report-processor + dispatcher
    orchestrator.js              — crawl loop, crawlRouteCheap/Expensive, runCrawl()
    report-processor.js          — dedup → severity overrides → baseline → JSON write
    dispatcher.js                — Slack / GitHub / HTML dispatch
    slack-notifier.js            — Slack Block Kit message builder
    env-comparison.js            — dev vs staging diff
    watch-mode.js                — passive browser monitoring (WatchSession + runWatchMode)
  server/
    index.js                     — Express server (port 3001)
    slash-command-handler.js     — /argus-retest slash command handler
    interaction-handler.js       — Acknowledge + Retest button handler
  utils/
    logger.js                    — Pino structured logger; childLogger(module)
    retry.js                     — withRetry() exponential backoff
    telemetry.js                 — OTel tracing + metrics; startSpan() / recordFinding() / recordFlaky() / recordNewFindings(); no-op default
    flow-runner.js               — DSL step executor (runFlow / runAllFlows)
    seo-analyzer.js              — A3: SEO checks
    security-analyzer.js         — A4: security headers, mixed content
    content-analyzer.js          — A5: broken links, image alt, link text
    responsive-analyzer.js       — A6: viewport emulation + overflow detection
    memory-analyzer.js           — B1: heap snapshot + detached DOM nodes
    session-manager.js           — B2: re-export barrel
    session-persistence.js       — B2: saveSession / restoreSession / hasSession / clearSession
    login-orchestrator.js        — B2: runLoginFlow / refreshSession + lock file
    baseline-manager.js          — B3: baseline tracking + trend data
    flakiness-detector.js        — B4: double-crawl flakiness confirmation
    hover-analyzer.js            — D8.1: hover-state bug detection
    snapshot-analyzer.js         — D8.2: accessibility tree snapshot analysis
    issues-analyzer.js           — Chrome DevTools Issues panel (CSP/CORS/deprecated)
    network-timing-analyzer.js   — HAR timing analysis for slow third-party detection
    keyboard-analyzer.js         — keyboard Tab-walk focus analysis
    codebase-analyzer.js         — C1: static codebase cross-reference
    github-reporter.js           — C2: GitHub PR comment + commit status
    route-discoverer.js          — C3: sitemap + Next.js + React Router discovery
    contract-validator.js        — D7.4: API response schema validation
    severity-overrides.js        — D7.5: post-process severity policy
    parallel-crawler.js          — D7.3: parallel route crawling
    html-reporter.js             — D7.1: HTML dashboard bundler
    slack-guard.js               — D7.7: Slack-optional guard
    diff.js                      — finding diff utilities
    slug.js                      — URL slug helpers
    api-frequency.js             — request frequency tracking
    css-analyzer.js              — CSS rule analysis
    lighthouse-checker.js        — Lighthouse soft assertions
    mcp-parsers.js               — text-format parsers for list_console_messages + list_network_requests
    mcp-client.js                — headless JSON-RPC MCP client wrapper
  cli/
    init.js                      — C4: argus init interactive setup wizard
  config/
    targets.js                   — routes, flows, API contracts, auth config, thresholds
    schema.js                    — Zod validation schema; validateConfig() called inside runCrawl()
test-harness/
  validate.js                    — 84-block correctness harness (367 hard assertions)
  harness-config.js              — fixture page routing table (54 pages)
  server.js                      — fixture HTTP server (port 3100)
  pages/                         — 54 fixture HTML pages (one per detection category)
  nextjs-fixture/                — Next.js app structure for C3 discovery tests (10 files)
  source-fixture/                — JS source + .env fixture for C1 codebase analysis tests
test/
  unit/                          — 6 Vitest unit test files (61 tests, no Chrome required)
    baseline-manager.test.js
    config-schema.test.js
    finding.test.js
    flakiness-detector.test.js
    flow-runner.test.js
    report-processor.test.js
scripts/
  dispatch-report.js             — standalone script to re-dispatch an existing report to Slack
reports/
  baselines/                     — baseline.json + trends.json (gitignored)
landing/
  src/
    App.jsx                      — React SPA: hero, features, comparison, modals; mobile-stacked stats, 6-slide widget, clamp() typography
    supabase.js                  — Supabase client factory (returns null if env missing)
  public/
    favicon.svg                  — SVG favicon (#5E0ED7 ring + dot)
    argus-poster.png             — video poster fallback (1918×1078; source for OG card)
    og-image-v2.jpg              — branded OG social card (1200×630, cover-mode, black-outlined stat numbers)
    robots.txt                   — allows all crawlers; Sitemap reference
    sitemap.xml                  — canonical URL for argus-qa.com/
  index.html                     — Vite entry; OG/Twitter/JSON-LD SEO tags; canonical; favicon
  package.json                   — React 18 + Vite + Tailwind + Framer Motion + @supabase/supabase-js
  .env.example                   — committed template
  .env.local                     — gitignored real credentials
  README.md                      — landing page setup guide, Supabase SQL, env vars, deployment
```

---

## 3b. Landing Page

The `landing/` directory is a standalone Vite app (not part of the Argus src/ tree) serving as the product marketing site.

### Stack

- **React 18** — single `App.jsx` SPA, no router
- **Vite** — build tool; env vars exposed via `VITE_` prefix
- **Tailwind CSS** + inline styles — responsive layout
- **Framer Motion** — `whileInView` animations, `AnimatePresence` for modals; `<MotionConfig reducedMotion="user">` wraps the app to respect OS `prefers-reduced-motion`
- **Supabase JS** (`@supabase/supabase-js`) — `createClient(url, key).from().insert()`

### Sprint 0 — Mobile & SEO Fixes (2026-05-26)

Applied before Product Hunt launch:

| Fix | Detail |
|---|---|
| Touch targets | All 4 buttons (hamburger, mobile close, both modal close buttons) raised to 44×44px — Apple HIG / WCAG 2.5.5 |
| Modal iOS keyboard | Both modal outer wrappers: `maxHeight: 100dvh` + `overflowY: auto` + `WebkitOverflowScrolling: touch` |
| `prefers-reduced-motion` | `MotionConfig reducedMotion="user"` wraps entire App return — covers all 30+ animation blocks in one change |
| `100dvh` hero | `@supports (height: 100dvh)` in `index.css` overrides Tailwind `.h-screen` so the hero fills the true visible viewport on iOS Safari |
| CSS reduced motion fallback | `@media (prefers-reduced-motion: reduce)` in `index.css` sets `transition-duration: 0.01ms` for any non-Framer CSS animations |
| SEO | `index.html`: full OG tags, `summary_large_image` Twitter card, canonical URL, JSON-LD `SoftwareApplication` schema |
| Crawlability | `landing/public/robots.txt` + `landing/public/sitemap.xml` |
| Video poster | `Argus_bg.png` → `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag |
| OG social card | `landing/public/og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png` (no black borders), branded gradient overlay, black-outlined purple stat numbers (54 / 84 / 367), CTA pill, watermark; `og-image.jpg` gitignored |
| Mobile stats layout | Hero stats row stacks vertically on mobile (`flex-col sm:flex-row`) — prevents overlap with slide card at 390px |
| Slides reduction | Slide widget reduced from 8 → 6 entries (removed slides 3 and 8); `clamp()`-based fluid typography on stats and slide text |
| Deployment | `npx wrangler pages deploy dist --project-name argus-qa` → `argus-qa.com`; video served from Cloudflare R2 |

**Deployed to**: `argus-qa.com` via Cloudflare Pages (`npx wrangler pages deploy dist --project-name argus-qa`); video served from Cloudflare R2.

### Forms Integration

Two Supabase tables:

| Table | Columns | Trigger |
|---|---|---|
| `waitlist` | email (UNIQUE), plan, created_at, source | WaitlistModal submit |
| `enterprise_contacts` | name, email, company, team_size, region, use_case, workflow, message, created_at | EnterpriseModal submit |

Both tables have RLS enabled. The `anon` role requires both a RLS INSERT policy AND a schema-level `GRANT INSERT ON ... TO anon` — without the GRANT, PostgREST returns 401 even when the policy exists.

Duplicate waitlist email (`error.code === '23505'`) is silently treated as success — the user is already on the list.

### Key Decisions

- `supabase.js` exports `null` when env vars are absent so the app renders without crashing in environments without Supabase configured
- `.env.local` is gitignored; `.env.example` is committed with placeholder values
- `VITE_SUPABASE_URL` must be the bare project URL (`https://<ref>.supabase.co`) — do not append `/rest/v1`; the JS client appends this path itself

---

## 4. Complete Phase List

### Phase A — Core Audit (browser-based)

| Phase | Name | Description |
| --- | --- | --- |
| A1 | Console error detection | JavaScript errors, warnings, unhandled rejections |
| A2 | Network error detection | 4xx/5xx responses, failed requests, CORS errors |
| A3 | SEO analyzer | Missing/duplicate title, meta description, OG tags, sitemap |
| A4 | Security analyzer | CSP, HSTS, X-Frame-Options, mixed content, clickjacking |
| A5 | Content analyzer | Broken images, missing alt text, empty links, broken anchors |
| A6 | Responsive analyzer | Overflow at 375px/768px/1280px, unclickable touch targets |

### Phase B — Advanced Analysis

| Phase | Name | Description |
| --- | --- | --- |
| B1 | Memory analyzer | Heap snapshot, detached DOM nodes, memory growth across navigations |
| B2 | Session manager | Auth cookie + localStorage save/restore; D7.6 mid-run refresh |
| B3 | Baseline manager | Per-run baselines; `isNew` annotation; trend tracking over time |
| B4 | Flakiness detector | Double-crawl each route; confirm vs flaky classification |
| B5 | Flow runner | Multi-step DSL user flows with assertions |

### Phase C — Integrations

| Phase | Name | Description |
| --- | --- | --- |
| C1 | Codebase cross-reference | Static analysis: missing env vars, feature flag leakage, dead routes |
| C2 | GitHub PR integration | PR comment with findings table; commit status (blocks merge on criticals) |
| C3 | Auto route discovery | Parse sitemap.xml, Next.js pages/app dir, react-router config; dynamic routes skipped |
| C4 | `argus init` CLI | Interactive setup wizard; detect framework, discover routes, prompt Slack/GitHub, write .env + targets.js |

### Phase D — Extended Detections

| Phase | Name | Description |
| --- | --- | --- |
| D1 | Redirect chain | 3xx chains > 2 hops flagged as warning |
| D2 | Broken internal links | Crawl all internal `<a href>`, check 200 response |
| D3 | Console warning patterns | Custom regex matching on console output |
| D4 | Cookie analysis | Secure/HttpOnly/SameSite flags; expiry; third-party cookies |
| D5 | Form validation | HTML5 constraint validation; error message quality |
| D6.1 | Font loading | FOUT, FOIT, missing webfonts |
| D6.2 | Third-party scripts | Slow/blocking external scripts |
| D6.3 | Service worker | SW registration, caching strategy, update flow |
| D6.4 | Core Web Vitals | LCP, FID, CLS via Performance API |
| D6.5 | Resource hints | Preload/prefetch/preconnect analysis |
| D6.6 | Cache headers | Missing cache-control on static assets |
| D6.7 | Debugger statements | `debugger` keyword in shipped JavaScript |
| D6.8 | Duplicate IDs | Multiple elements sharing the same `id` attribute |
| D6.9 | Mixed content | HTTPS page loading HTTP subresources (hard blocks, not just warnings) |
| D7.1 | HTML dashboard | Bundled HTML report with chart + finding tables |
| D7.2 | Per-branch baselines | Branch-scoped baseline files; CI safe on feature branches |
| D7.3 | Parallel route crawl | Concurrent crawling with page-per-route isolation |
| D7.4 | API contract validation | JSON Schema validation of captured API responses |
| D7.5 | Severity policy overrides | `targets.js` `severityOverrides` map; suppress/remap per type |
| D7.6 | Auth token refresh | Mid-run session refresh when token nears expiry |
| D7.7 | Slack-optional mode | Guard so Slack failures don't block audit; fully optional |
| D8.1 | Hover-state bugs | CSS transition failures, tooltip content, color/cursor on hover |
| D8.2 | Accessibility tree analysis | Snapshot-based a11y audit; role/name/state checks |
| D8.3 | Keystroke validation bugs | Input constraint enforcement, character limits, pattern matching |
| D8.4 | Drag-and-drop bugs | DnD API events, drop zone acceptance, post-drop DOM state |
| D8.5 | File upload flow bugs | File picker, type/size rejection, upload progress, error states |

### Phase v6 — Detection Expansion

| Phase | Name | Description |
| --- | --- | --- |
| v6.1 | Chrome DevTools Issues panel | `list_console_messages({ types: ['issue'] })` — surfaces CSP violations, deprecated API use, cookie issues; new `issues-analyzer.js` |
| v6.2 | HAR network timing analysis | Reads `timing.wait` from `list_network_requests` HAR data; emits `slow_third_party_blocking` for cross-origin TTFB > 2000ms |
| v6.3 | Mobile CPU throttle | Applies CPU throttle during ≤768px breakpoints in `responsive-analyzer.js` |
| v6.4 | Heading hierarchy validation | Detects h1→h3 level skips (`heading_level_skip`) in `snapshot-analyzer.js` |
| v6.5 | Keyboard focus analysis | Tab-walks up to 20 steps; detects `focus_visible_missing` (outline:0, no box-shadow); new `keyboard-analyzer.js` |
| v6.6 | ARIA state checks | Detects `aria_expanded_no_controls` (aria-expanded button with missing/broken aria-controls reference) in `snapshot-analyzer.js` |
| v6.7 | `select_option` flow step | Adds `select_option` action to flow-runner DSL switch block; resolves uid from selector if uid not provided |
| v6.8 | Origin tagging | Adds `origin: 'first-party' \| 'third-party'` field to all network findings in `crawl-and-report.js` |
| v6.9 | HTTPS enforcement | Emits `security_no_https` warning when page URL is `http://` and not localhost |
| v6.10 | Iframe sandbox detection | Detects cross-origin `<iframe src>` without `sandbox` attribute; emits `security_iframe_no_sandbox` |

### Phase v7 — Final Production Hardening (2026-05-05, Session 24)

50+ fixes across 17 source files. Zero known security, correctness, or robustness gaps remaining.

| File | Key Fixes |
| --- | --- |
| `src/utils/flow-runner.js` | Windows /tmp/ path (os.tmpdir), exported resolveUidForSelector, press_key null guard |
| `src/utils/hover-analyzer.js` | **Critical**: hover now uses `{ uid }` not `{ selector }` — MCP requires uid; resolves via resolveUidForSelector |
| `src/utils/seo-analyzer.js` | Protocol-relative URL detection for og:image |
| `src/utils/memory-analyzer.js` | TOCTOU race: existsSync+readFileSync → async try/catch with ENOENT check |
| `src/utils/baseline-manager.js` | Atomic writes (.tmp → rename), trend cap (500), stale lock (60s), null guards on findings arrays |
| `src/utils/flakiness-detector.js` | O(n²) findIndex → O(1) Map-based lookup |
| `src/utils/issues-analyzer.js` | Baseline isolation for priorRaw; catch-all classifier for unclassified types |
| `src/utils/network-timing-analyzer.js` | Status 0 filter (aborted); getWaitMs returns only true TTFB (not total duration) |
| `src/utils/keyboard-analyzer.js` | Focus reset before Tab-walk; stable dedup key; per-step focus_lost findings |
| `src/utils/slug.js` | Non-string/null safety |
| `src/utils/css-analyzer.js` | Double-JSON-encoding detection in parseCssAnalysisResult |
| `src/utils/codebase-analyzer.js` | symlink cycle guard; file size guard (>1MB skip); url field on all findings |
| `src/utils/contract-validator.js` | Path traversal prevention for schemaFile; array items validate first 5 with dedup |
| `src/utils/route-discoverer.js` | symlink guard in walkDir; XML 5MB cap; URL cap (500); child sitemap SSRF same-origin check |
| `src/cli/init.js` | **Critical**: code injection fix — JSON.stringify for route path/name/waitFor; tick('Wrote .env') only on actual write; slackDigest always-commented bug |
| `src/server/index.js` | Stream double-consumption fixed via verify callback; error handler added |
| `src/server/slash-command-handler.js` | NaN replay-attack bypass; SSRF validation; Slack mrkdwn sanitization; crawl timeout |
| `src/server/interaction-handler.js` | SSRF validation; crawl timeout; userName sanitization |
| `src/utils/html-reporter.js` | XSS via javascript: href (safeHref); viewport esc; try/catch on JSON parse |
| `src/orchestration/slack-notifier.js` | '429' string check removed; PUT error log corrected; button value length caps; acknowledgeMessage warn on missing msg |
| `src/orchestration/crawl-and-report.js` | list_console_messages .catch(); screenshot try/catch; responsive screenshot try/catch; JSON write try/catch; flowResult.findings null guards; isNew === true (strict, not !== false) |
| `src/orchestration/env-comparison.js` | pixelmatch threshold fixed (0.1 fixed, not SCREENSHOT_THRESHOLD); diffPercent stored as number; per-Slack-post try/catch; routeResult.diffs null guard; CSS dispatch .catch() |

### Phase v8 — Harness Correctness & Snapshot Format Migration (2026-05-10, Session 25)

Harness audit revealed 16 failures (307/323). Root-cause analysis identified 4 categories:

| Category | Count | Root Cause |
| --- | --- | --- |
| Snapshot uid format change | 9 | `resolveUidForSelector` regex designed for old `e5` format; new format is `uid=N_M` preceding the accessible name |
| Timing race | 4 | `sync-xhr.html` 300ms delay too short for CDP round-trip under MCP overhead |
| MCP behavioral limits | 3 | `drag` no HTML5 DnD `drop` event; Issues panel empty via `list_console_messages` (2 assertions) |
| Test code bugs (fixed) | 3 | [48a]: wrong assumption — `mcp.fill` fires one consolidated `input` event (not zero); [48b]: (1) `mcp.click({ selector })` silent no-op; (2) uid-based click still didn't focus in headless; [48d]: `data-count` alone can't distinguish fill from type_text for same-length strings — fixed by reading `data-event-count` (type_text fires 3 per-keystroke events; fill fires 1) |
| select_option value format | 3 | `mcp.fill` on combobox requires display label text, not HTML `value` attribute |

**Fixes applied:**

| File | Fix |
| --- | --- |
| `test-harness/pages/sync-xhr.html` | Increased XHR fire delay from 300ms to 1500ms to outlast CDP round-trip |
| `src/utils/flow-runner.js` | Rewrote `resolveUidForSelector` regex: new snapshot format emits `uid=N_M role "name"` with uid first; extract `N_M` (no prefix) for MCP calls; skip `StaticText` nodes to prefer interactive elements when label and element share accessible name |
| `src/utils/flow-runner.js` | Rewrote `extractFileInputUid`: new format shows file inputs as `button "Choose file:" value="No file chosen"` |
| `src/utils/flow-runner.js` | `select_option` case: resolve option value attribute → display label via `evaluate_script` before calling `mcp.fill` (fill requires label text, not HTML value) |
| `test-harness/validate.js` | [48a]: updated assertion to `countA === String(FILL_VALUE.length)` — `mcp.fill` fires one consolidated `input` event, counter shows `value.length` not 0 |
| `test-harness/validate.js` | [48b]: replaced `mcp.click({ selector })` with `evaluate_script(() => el.focus())` — `mcp.click` dispatches CDP mouse events but does not set `document.activeElement` in headless Chrome outside `runFlow` |
| `test-harness/validate.js` | [48d]: switched to reading `data-event-count` instead of `data-count` — proves `typing:true` routed through `type_text` (3 per-keystroke events) not `mcp.fill` (1 consolidated event) |
| `test-harness/pages/typetext-issues.html` | Added `data-event-count` attribute tracking to both counter spans — increments on each `input` event, enabling fill-vs-type_text distinction |

**Remaining known limitations (MCP-level, not fixable in Argus, 3 assertions):**

- `drag` uses mouse simulation, not the HTML5 DnD API — `drop` event does not fire [49b]
- Chrome DevTools Issues panel not returned via `list_console_messages` — CSP/deprecated-API detection limited [67b, 68b]

> **Note**: `type_text` was originally listed as an MCP limit ([48b]) but was two successive test code bugs: first, `mcp.click({ selector })` does nothing; second, even after switching to `mcp.click({ uid })`, CDP mouse events were dispatched but `document.activeElement` was not set for text inputs in headless Chrome from direct test code. Fix: `evaluate_script(() => el.focus())`. `type_text` DOES fire DOM `input` events when the element is properly focused. Final harness result: **320/323** pass.

### Watch Mode — Passive Browser Monitoring (2026-05-17, Session 26)

New flow: attach to Chrome's currently open tab and poll for issues without navigating. Useful for getting reported on issues in real time while developing.

**Key discovery**: `chrome-devtools-mcp@latest` returns `list_console_messages` and `list_network_requests` as human-readable markdown text, not JSON arrays. `normalizeArray()` returns `[]` for strings — these tools produced zero findings silently in all prior code.

**Fix**: Two regex parsers in `watch-mode.js`:

| Tool | Text format | Parser |
| --- | --- | --- |
| `list_console_messages` | `msgid=N [level] text (N args)` | `parseConsoleMsgResponse(raw)` |
| `list_network_requests` | `reqid=N METHOD URL [STATUS]` | `parseNetworkReqResponse(raw)` |

**Dedup strategy**: Content-based keys (`level::text.slice(0,200)` for console, `method::url::status` for network). ID-based dedup would suppress findings after navigation if msgids/reqids reset per page.

**Exports**: `WatchSession` class (exported for harness), `runWatchMode(baseUrl)` (CLI entry point).

| File | Role |
| --- | --- |
| `src/orchestration/watch-mode.js` | WatchSession + runWatchMode + parsers + classifiers |
| `test-harness/pages/watch-issues.html` | Fixture: console errors/warnings + /api/always-500 + incremental trigger |

**Harness block [78]** — 7 assertions. Final harness result: **327/330** pass.

### v9 Sprint 1 — CdpBrowserAdapter Migration (2026-05-17, Session 27)

All 13 files migrated from calling `mcp.*` directly to using `new CdpBrowserAdapter(mcp)`. Three new files introduced.

**New files:**

| File | Role |
| --- | --- |
| `src/adapters/browser.js` | `CdpBrowserAdapter` class — facade over all `chrome-devtools-mcp` calls |
| `src/domain/finding.js` | `createFinding()` factory — canonical finding shape |
| `src/utils/mcp-parsers.js` | `parseConsoleMsgResponse` + `parseNetworkReqResponse` — text-format parsers |

**Migrated files (13):** hover-analyzer, snapshot-analyzer, keyboard-analyzer, responsive-analyzer, memory-analyzer, issues-analyzer, contract-validator, lighthouse-checker, session-manager, flow-runner, env-comparison, crawl-and-report, validate.js.

**Backward compatibility**: Public orchestration functions (`runCrawl`, `crawlRouteCheap`, `runComparison`) keep `mcp` in their public signature; each creates `new CdpBrowserAdapter(mcp)` internally.

**Bugs fixed during migration:**

| Bug | File | Fix |
| --- | --- | --- |
| `resolveUidForSelector(mcp, ...)` in validate.js block [48] | `test-harness/validate.js` line 2268 | Changed `mcp` → `browser` (last missed call site) |
| `parseNetworkReqResponse` emitted `_reqid` but not `requestId` | `src/utils/mcp-parsers.js` | Added `requestId: Number(reqid)` to parsed objects |
| `networkKey` used unstable `r.requestId` after the fix above | `src/orchestration/watch-mode.js` | Removed `r.requestId ??` prefix — always content-based key |

**Gate**: 327/330 ✅ PASSED 2026-05-17

---

### v9 Sprint 2 — Plugin Registry + God Object Split (2026-05-18, Session 28)

`crawl-and-report.js` (1,615 lines) reduced to a 20-line backward-compat re-export shell. Three new orchestration modules created. 6 expensive analyzers self-register at module load.

**New files:** `src/registry.js`, `src/orchestration/orchestrator.js`, `src/orchestration/report-processor.js`, `src/orchestration/dispatcher.js`.

**Gate**: 327/330 ✅ PASSED 2026-05-18

---

### v9 Sprint 3 — Threshold Centralization + Zod Validation (2026-05-18, Session 30)

All magic-number thresholds moved to `export const thresholds` in `src/config/targets.js`. New `src/config/schema.js` (Zod) validates the full config at `runCrawl()` start. Block [79] added (4 assertions).

**Gate**: 331/334 ✅ PASSED 2026-05-18

---

### v9 Sprint 4 — Session Split, Pino Logging, Retry (2026-05-18, Session 31)

**v9.1.7 — Session split**: `session-manager.js` split into two focused modules. All existing callers continue to import from `session-manager.js` (now a re-export barrel).

| New file | Exports |
| --- | --- |
| `src/utils/session-persistence.js` | `saveSession`, `restoreSession`, `hasSession`, `clearSession` |
| `src/utils/login-orchestrator.js` | `runLoginFlow`, `refreshSession` (with lock file to prevent concurrent redundant logins) |

**v9.1.8 — Pino structured logging**: All `console.log/warn/error` calls across 27 `src/` files replaced with `logger.info/warn/error` via `childLogger(module)`. New `src/utils/logger.js` auto-detects TTY for pino-pretty output; JSON output in CI. One intentional exception: `init.js:312` process-exit error.

**v9.1.9 — Retry logic**: New `src/utils/withRetry()` in `src/utils/retry.js` wraps idempotent CDP operations in `CdpBrowserAdapter`: `navigate` and `fill` only. `click` is intentionally excluded — it is not idempotent (submits forms, toggles state, triggers deletions); retrying after an ambiguous timeout could fire the action twice. Exponential backoff (400ms × 2^i). `ARGUS_RETRY_ATTEMPTS` env var controls max attempts (default: 3).

**New dependencies**: `pino@^10.3.1`, `pino-pretty@^13.1.3`

**New env vars**: `ARGUS_LOG_LEVEL`, `ARGUS_LOG_PRETTY`, `ARGUS_RETRY_ATTEMPTS`

**Gate**: 331/334 ✅ PASSED 2026-05-18 (no new assertions; same 3 permanent MCP-limited failures)

#### v9 Sprint 4 gap fixes

Post-implementation correctness audit (two passes) found six bugs:

| File | Bug | Fix |
| --- | --- | --- |
| `src/utils/logger.js` | App crashes at startup if `pino-pretty` fails to load | `createLogger()` wraps pino-pretty transport in try-catch; falls back to JSON silently |
| `src/utils/retry.js` | `label` param silently ignored — no debug output on retry | Added `childLogger('retry')` + `logger.debug(...)` per retry attempt |
| `src/utils/retry.js` | `ARGUS_RETRY_ATTEMPTS=non-numeric` → `parseInt` → `NaN` → loop never executes → `fn()` never called, returns `undefined` silently | `Number.isFinite()` guard: invalid value falls back to 3 |
| `src/adapters/browser.js` | `withRetry()` calls had no labels; `click` idempotency exclusion undocumented | Added labels to `navigate`/`fill`; added 4-line comment above `click()` |
| `src/utils/session-persistence.js` | `saveSession()` calls `writeFileSync` without ensuring parent directory exists → `ENOENT` crash if session file is in a subdirectory | Added `fs.mkdirSync(path.dirname(sessionFile), { recursive: true })` |
| `src/utils/session-persistence.js` | `clearSession()` left stale `.tmp`; no log when only `.tmp` existed | Added `.tmp` removal + `logger.debug()` |

---

### v9 Sprint 5 — Vitest Unit Tests (2026-05-23, Session 32)

**v9.1.10 — Unit test suite**: 6 Vitest test files covering core logic with zero Chrome dependency (`npm run test:unit`).

| File | Tests | What it covers |
| --- | --- | --- |
| `test/unit/finding.test.js` | 8 | `createFinding()` — all fields, defaults, throws on invalid severity, frozen object, extra fields dropped |
| `test/unit/config-schema.test.js` | 8 | `validateConfig()` valid/invalid, `ConfigSchema.safeParse` |
| `test/unit/report-processor.test.js` | 11 | `deduplicateFindings` + `rebuildSummary` |
| `test/unit/flakiness-detector.test.js` | 13 | `findingKey` normalization + `mergeRunResults` |
| `test/unit/baseline-manager.test.js` | 9 | `loadBaseline`/`saveBaseline`/`applyBaseline` with real tmp dirs |
| `test/unit/flow-runner.test.js` | 11 | `normalizeArray` (pure) + `runFlow` with mock browser |

**New harness blocks**: [81] `createFinding()` (4 assertions) + [82] `withRetry()` (4 assertions). 8 new assertions total.

**New scripts**: `"test:unit": "vitest run test/unit"` + `"test": "npm run test:unit && npm run test:harness"`.

**New devDependency**: `vitest@^4.1.7`

**Gate**: 339/342 ✅ PASSED 2026-05-23

---

### v9 Sprint 6 — Argus MCP Server (2026-05-23, Session 33)

**v9.2.0 — Argus as MCP server**: Exposes Argus as a first-class MCP tool server so Claude (or any MCP client) can run QA audits directly from a conversation.

**New file**: `src/mcp-server.js` — implements four tools using `@modelcontextprotocol/sdk`:

| Tool | Input | What it does |
| --- | --- | --- |
| `argus_audit` | `{ url, critical? }` | Cheap QA pass on one URL; returns findings JSON |
| `argus_audit_full` | `{ url, critical? }` | Full pass (cheap + expensive analyzers); returns full findings |
| `argus_compare` | `{}` | Env comparison using `TARGET_DEV_URL`/`TARGET_STAGING_URL` from `.env` |
| `argus_last_report` | `{}` | Returns most recent JSON report from `reports/` (no Chrome required) |

URL parsing preserves full path (`pathname + search + hash`) — SPA hash routes and query strings are passed through unchanged.

**New file**: `.mcp.json` — registers `"argus": { "command": "node", "args": ["src/mcp-server.js"] }` for Claude and all MCP clients.

**New harness block**: [80] 6 file-read assertions (no Chrome required) — file existence, all 4 tool names present, `.mcp.json` has `"argus"` entry.

**New script**: `"mcp-server": "node src/mcp-server.js"`. **New dependency**: `@modelcontextprotocol/sdk@^1.29.0`.

**Gate**: 345/348 ✅ PASSED 2026-05-23

---

### v9 Sprint 7 — OpenTelemetry Tracing (2026-05-24, Session 34)

**v9.3.0 — OTel tracing + metrics**: Production observability without harness changes. Gate: 345/348.

**New file**: `src/utils/telemetry.js` — central OTel module.

- `startSpan(name, attrs, fn)` — wraps async functions in active spans; no-op when env vars absent
- `recordFinding(type, severity, route)` — increments `argus.findings` counter
- `recordFlaky(count, route)` — increments `argus.flaky_findings` counter
- `recordNewFindings(delta)` — adjusts `argus.new_findings` up/down counter
- SDK lazy-initialized on first `startSpan()` call; skipped entirely in no-op mode

**Spans added:**

| Span | Attributes | File |
| --- | --- | --- |
| `argus.run_crawl` | `baseUrl` | `orchestrator.js` — `runCrawl()` outer wrap |
| `argus.crawl_route` | `url`, `critical`, `pass` | `orchestrator.js` — cheap_1, cheap_2, expensive passes + route wrapper |
| `argus.analyzer` | `name`, `url` | `orchestrator.js` — registry loop per analyzer |
| `argus.dispatch` | `baseUrl`, `channel` | `dispatcher.js` — `dispatchAll()` + slack/github/html sub-spans |
| `argus.flow` | `flow_name`, `url` | `flow-runner.js` — `runFlow()` wrap |
| `argus.flow_step` | `flow_name`, `action`, `selector` | `flow-runner.js` — per-step wrap |

**Metrics added:** `argus.findings` (Counter), `argus.flaky_findings` (Counter), `argus.analyzer.duration` (Histogram), `argus.crawl.duration` (Histogram), `argus.new_findings` (UpDownCounter)

**New env vars**: `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP target), `ARGUS_OTEL_CONSOLE=1` (dev stdout mode)

**New dependencies**: `@opentelemetry/api@^1.9.1`, `@opentelemetry/sdk-node@^0.218.0`

**Gate**: 345/348 ✅ (no new assertions — OTel is transparent infrastructure)

---

### v9 Sprint 6 npm Publication (2026-05-27, Session 37)

**`argusqa-os@9.2.0`** published to [npmjs.com/package/argusqa-os](https://www.npmjs.com/package/argusqa-os). Prepared for MCP directory submission (glama.ai/mcp/servers, mcp.so).

| Gap Fixed | File | Change |
|---|---|---|
| Missing shebang | `src/mcp-server.js` | Added `#!/usr/bin/env node` — required for npm `bin` entries to be executable via npx |
| `REPORTS_DIR` breaks globally | `src/mcp-server.js` | `path.resolve(__dirname, '../reports')` → `path.resolve(process.cwd(), 'reports')` — reports land in user's project dir |
| Unused import | `src/mcp-server.js` | Removed `fileURLToPath` after `__dirname` was replaced |
| No `files` field | `package.json` | Added `["src/", ".mcp.json"]` — excludes test-harness, landing/, scripts/ from publish |
| Version mismatch | `package.json` | `1.0.0` → `9.2.0` (aligned with Server constructor) |
| Sparse tool descriptions | `src/mcp-server.js` | `argus_audit_full`: lists all analyzers + output format; `argus_compare`: explains env var config, removes internal path references |
| Missing npm metadata | `package.json` | Added keywords, author (`ironclawdevs27`), license (MIT), homepage, repository |
| Wrong/missing bin entries | `package.json` | Added `argus-mcp` + `argusqa-os` both pointing to `src/mcp-server.js` |
| `.mcp.json` local-only | `.mcp.json` | Updated to `{ "command": "npx", "args": ["-y", "argusqa-os"] }` |

Users configure the published server via:
```json
{ "mcpServers": { "argus": { "command": "npx", "args": ["-y", "argusqa-os"] } } }
```

Package name: `argusqa-os` (`argus` and `argus-qa` both already taken on npm registry).

---

#### v9 Sprint 6 gap fixes

Post-implementation correctness audit found two bugs:

| File | Bug | Fix |
| --- | --- | --- |
| `src/mcp-server.js` | `handleAudit`/`handleAuditFull` used `parsed.pathname` as `route.path` — query strings (e.g. `?q=test`) silently dropped | Changed to `parsed.pathname + parsed.search` |
| `src/mcp-server.js` | After query string fix, `parsed.hash` still omitted — SPA hash routes (e.g. `#/dashboard`) and anchor links silently dropped | Changed to `parsed.pathname + parsed.search + parsed.hash` (`parsed.hash` is `''` when absent — no-op for plain URLs) |

---

## 5. Report Object Shape

```javascript
{
  baseUrl: 'https://my-app.com',
  generatedAt: '2026-04-27T10:00:00.000Z',
  summary: {
    total: 20,
    critical: 3,
    warning: 12,
    info: 5,
  },
  routes: [
    {
      route: '/dashboard',
      screenshot: './reports/dashboard.png',
      errors: [
        {
          type: 'console_error',
          message: 'TypeError: Cannot read property ...',
          severity: 'critical',
          isNew: true,       // annotated by baseline-manager
        },
      ],
    },
  ],
  flows: [
    {
      flowName: 'Login flow',
      findings: [
        { type: 'assertion_failed', message: '...', severity: 'critical', isNew: true },
      ],
    },
  ],
  codebase: [
    { type: 'env_var_missing', message: 'STRIPE_KEY used in code but absent from .env', severity: 'warning', isNew: true },
    { type: 'dead_route',      message: '/api/v1/legacy returns 404', severity: 'warning', isNew: false },
  ],
}
```

---

## 6. Configuration (src/config/targets.js)

```javascript
export const config = {
  pageSettleMs: 2000,           // wait after navigation before capturing
  screenshotQuality: 90,
  screenshotDiffThreshold: 0.5, // % pixel diff before flagging visual change
  outputDir: './reports',
};

export const routes = [
  { path: '/',          name: 'Home',      critical: true,  waitFor: 'main' },
  { path: '/login',     name: 'Login',     critical: true,  waitFor: 'form' },
  { path: '/dashboard', name: 'Dashboard', critical: true,  waitFor: '[data-testid="dashboard"]' },
  { path: '/settings',  name: 'Settings',  critical: false, waitFor: null },
];

export const apiContracts = [
  // { url: '/api/user', method: 'GET', schema: { type: 'object', required: ['id', 'name'], ... } }
];

export const severityOverrides = {
  // seo_missing_description: 'info',
  // cache_headers_missing:   'suppress',
};

export const auth = null; // or { sessionFile, sessionMaxAgeMs, sessionRefreshWindowMs, steps: [...] }

export const flows = [];   // or [{ name, steps: [...] }]

export const codebase = {
  sourceDir: process.env.ARGUS_SOURCE_DIR ?? null,
  envFile:   process.env.ARGUS_ENV_FILE   ?? null,
};
```

---

## 7. Flow Runner DSL

Flows are defined in `targets.js` as named step sequences:

```javascript
{ action: 'navigate',       path: '/login' }
{ action: 'fill',           selector: '#email',    value: 'user@example.com' }
{ action: 'click',          selector: 'button[type="submit"]' }
{ action: 'press_key',      key: 'Tab' }
{ action: 'waitFor',        selector: '[data-testid="dashboard"]', timeout: 15000 }
{ action: 'sleep',          ms: 500 }
{ action: 'handle_dialog',  response: 'accept' }
{ action: 'assert',         type: 'no_console_errors' }
{ action: 'assert',         type: 'no_network_errors' }
{ action: 'assert',         type: 'element_visible',     selector: '.banner' }
{ action: 'assert',         type: 'element_not_visible', selector: '.spinner' }
{ action: 'assert',         type: 'url_contains',        value: '/dashboard' }
{ action: 'assert',         type: 'no_js_errors' }
```

---

## 8. Phase C1 — Codebase Cross-Reference

C1 adds static analysis of your application's source code without opening a browser.

**Detection types:**

| Type | Description | Severity |
| --- | --- | --- |
| `env_var_missing` | `process.env.X` used in source but absent from `.env` file | warning |
| `feature_flag_leakage` | Conditional env var is falsy/unset — feature may be silently off | warning |
| `error_source_linked` | Console error stack trace parsed to `file:line` | info |
| `dead_route` | Internal `<a href>` on a crawled page returns 404 | warning |

**Config** (set in `.env` or environment):

```bash
ARGUS_SOURCE_DIR=/path/to/your/app/src
ARGUS_ENV_FILE=/path/to/your/app/.env
```

**Key implementation detail**: `codebase[]` findings flow through the complete pipeline — `applyOverrides`, `applyBaseline` (with `isNew` annotation), Slack dispatch (gated on `isNew !== false`), and GitHub PR comment.

---

## 9. Phase C2 — GitHub PR Integration

C2 posts a structured findings summary on every PR and sets a commit status check.

### Required env vars

| Variable | Source | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Secret | GitHub PAT or `${{ secrets.GITHUB_TOKEN }}` in Actions |
| `GITHUB_REPOSITORY` | Auto (GHA) | `owner/repo` |
| `GITHUB_SHA` | Auto (GHA) | Commit SHA for status check |
| `GITHUB_PR_NUMBER` | Workflow env | `${{ github.event.pull_request.number }}` |
| `ARGUS_REPORT_URL` | Optional | URL to full HTML report — linked in status check |

### GitHub Actions workflow

```yaml
- name: Run Argus QA
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GITHUB_PR_NUMBER: ${{ github.event.pull_request.number }}
    ARGUS_REPORT_URL: ${{ steps.upload.outputs.artifact-url }}
  run: npm run crawl
```

### Behavior

- **PR comment** (`postPrComment`): Creates a comment on first run; updates in-place on subsequent runs (one comment per PR, no spam). Uses `<!-- argus-qa-report -->` sentinel to find the existing comment.
- **Commit status** (`setCommitStatus`): Sets `argus-qa` status to `failure` when new critical findings exist (blocks merge when branch protection requires it), `success` otherwise.
- **First run**: Summary shows "baseline established" — no "New Findings" table is rendered.
- **Subsequent runs**: New Findings table shows only findings not in the last baseline; resolved count is shown.

### Pure function design

`formatPrComment` and `buildStatusPayload` are pure functions (no env var reads, no I/O). They are directly unit-tested in the harness without mocking. `ARGUS_REPORT_URL` is attached by `setCommitStatus` after calling the pure builder.

---

## 10. Phase C3 — Auto Route Discovery

C3 augments the manual `routes[]` in `targets.js` with paths discovered from three sources.

**Configuration** (`targets.js`):

```javascript
export const autoDiscover = {
  sitemap:     true,   // fetch /sitemap.xml from BASE_URL
  nextjs:      true,   // scan pages/ + app/ under codebase.sourceDir (if set)
  reactRouter: false,  // grep source for React Router paths (experimental, off by default)
};
```

Set `autoDiscover = null` to disable discovery entirely.

**Discovery sources:**

| Source | Method | Notes |
| --- | --- | --- |
| Sitemap | `discoverFromSitemap(baseUrl)` | Fetches `/sitemap.xml`; follows one sitemap-index level; 10s timeout; returns `[]` on any error |
| Next.js | `discoverFromNextJs(sourceDir)` | Scans `pages/` (Next 12) and `app/` (Next 13+); strips route groups `(auth)`; skips `_app`/`_document`/`api/`; collapses `index` to parent |
| React Router | `discoverFromReactRouter(sourceDir)` | Greps JS/TS for `<Route path="">` and `{ path: "" }`; only absolute static paths |

**Key rules:**

- Dynamic segments (`[slug]`, `[id]`) are **skipped** — they have no concrete crawlable URL.
- Manual route config (`critical`, `waitFor`, `name`) is always preserved; discovered routes get `discovered: true`.
- `discoverRoutes(null)` returns `manualRoutes` unchanged (null guard).
- C3 is bypassed entirely when `routeOverrides` is passed to `runCrawl` (preserves harness fixture targeting).

---

## 11. Phase C4 — `argus init` CLI

Run `npm run init` (or `npx argus init` after publishing) for guided first-time setup.

### What it does (4 steps)

1. **Target URLs** — collect dev URL (default `http://localhost:3000`) + optional staging URL
2. **Source code** — optional source dir + env file path (enables C1 + C3 file-system discovery)
3. **Route discovery** — detects framework, runs C3 `discoverRoutes` against the dev URL; falls back to seed routes on network error
4. **Slack & GitHub** — collects tokens/channel IDs; all optional; pressing Enter skips each field

### Output files

| File | Contents |
| --- | --- |
| `.env` | All collected values; blank fields rendered as commented-out placeholders |
| `src/config/targets.js` | Discovered routes; `autoDiscover` tuned to detected framework; `codebase` with env var hooks |

### Pure helper functions

| Function | Purpose |
| --- | --- |
| `detectFramework(projectRoot)` | Reads `package.json`; returns `'nextjs'` / `'react-router'` / `'unknown'` |
| `generateTargetsJs(routes, options)` | Renders a complete targets.js from route array + options |
| `generateEnvFile(options)` | Renders a .env file with values substituted; blanks → commented placeholders |

All three are exported and unit-tested in the harness without mocking. `main()` is guarded by `process.argv[1] === __filename` so importing init.js for tests never runs the wizard.

---

## 12. Baseline System (B3)

Baselines are stored in `reports/baselines/baseline.json` (gitignored).

**How it works:**

1. First run: all findings get `isNew: true`; baseline saved with all finding keys.
2. Subsequent runs: each finding's key is checked against the saved baseline.
   - Present in baseline → `isNew: false` (known issue, suppress from Slack/GitHub alert)
   - Absent from baseline → `isNew: true` (new issue, alert)
3. `applyBaseline` covers all three finding sources: `routes[]`, `flows[]`, and `codebase[]`.

**Per-branch baselines (D7.2)**: Each git branch gets its own baseline file so feature branches don't pollute or inherit main's baseline.

---

## 13. Slack Integration

Controlled by `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_CRITICAL`, `SLACK_CHANNEL_WARNINGS`, and `SLACK_CHANNEL_DIGEST`.

Slack is fully optional (D7.7) — if tokens are absent, Slack calls are no-ops and the audit continues. Slack is never allowed to block or fail an audit run.

Slack alerts only fire for **new** findings (`isNew !== false`). Known issues are silenced after the first baseline run.

---

## 14. Running Argus

### Prerequisites

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env

# 3. Start Chrome with remote debugging
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9222 \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --user-data-dir=%TEMP%\chrome-argus
```

### Running the test harness

```bash
npm run test:harness
# Expected: 364/367 (3 permanent MCP-limited failures: [49b], [67b], [68b])
```

### Running a crawl

```bash
npm run crawl
```

### Running a single-page audit

```bash
node src/argus.js --url https://your-app.com
```

---

## 15. Environment Variables Reference

```bash
# Slack (all optional — omit to use HTML report mode)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_CRITICAL=C0123456789   # channel for critical bug reports
SLACK_CHANNEL_WARNINGS=C0987654321   # channel for warnings
SLACK_CHANNEL_DIGEST=C0111222333     # channel for daily digest
PORT=3001                             # slash-command server port

# Target URLs
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.your-app.com

# OpenTelemetry (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=         # ship spans/metrics to Jaeger/Grafana Tempo
ARGUS_OTEL_CONSOLE=1                  # print spans to stdout (dev mode)

# Logging + retry (optional)
ARGUS_LOG_LEVEL=info                  # info (default), debug, warn, error
ARGUS_LOG_PRETTY=1                    # 1 = pino-pretty, 0 = JSON, unset = auto TTY
ARGUS_RETRY_ATTEMPTS=3                # max retries on navigate/fill; set 1 to disable in CI

# Runtime (optional)
ARGUS_CONCURRENCY=1                   # parallel MCP clients
ARGUS_WATCH_INTERVAL_MS=3000          # watch mode poll interval ms
SCREENSHOT_DIFF_THRESHOLD=0.5         # pixel diff % for env comparison
REPORT_OUTPUT_DIR=./reports

# C1: Codebase analysis (optional)
ARGUS_SOURCE_DIR=../my-app/src
ARGUS_ENV_FILE=../my-app/.env

# C2: GitHub PR integration (optional)
GITHUB_TOKEN=ghp_...
GITHUB_REPOSITORY=owner/repo
GITHUB_SHA=abc123                     # set automatically in GitHub Actions
GITHUB_PR_NUMBER=42                   # set via ${{ github.event.pull_request.number }}
ARGUS_REPORT_URL=https://...          # link to full HTML report
```

---

## 16. Harness Architecture

**82 test blocks:**

- Blocks 1–50: browser-based detections (A–D8.5)
- Blocks 51–54: C1 codebase cross-reference
- Blocks 55–56: C2 GitHub reporter unit tests (pure)
- Blocks 57–61: C3 route discovery (sitemap, Next.js, React Router, mergeRoutes, orchestrator)
- Blocks 62–64: C4 init CLI unit tests (detectFramework, generateTargetsJs, generateEnvFile)
- Block 65: Production crawl pipeline smoke test (crawlRouteCheap)
- Blocks 66–68: Chrome DevTools Issues panel — clean baseline, CSP violation, deprecated API
- Block 69: HAR network timing unit tests — 7 sub-assertions
- Block 70: Heading hierarchy validation
- Block 71: CPU throttle during mobile responsive analysis
- Block 72: Keyboard focus analysis
- Block 73: ARIA state checks
- Block 74: `select_option` flow step
- Blocks 75–76: Origin tagging + HTTPS enforcement logic
- Block 77: Iframe sandbox detection
- Block 78: Watch Mode — WatchSession poll, dedup, incremental detection
- Block 79: Zod config validation (validateConfig — Sprint 3)
- Block 80: Argus MCP server registration — file exists, 4 tool names, `.mcp.json` entry (Sprint 6)
- Block 81: `createFinding()` unit test — required fields, invalid severity, immutability, url default (Sprint 5)
- Block 82: `withRetry()` unit test — success-on-retry, rethrow, env override (Sprint 5)

**367 hard assertions** across all 84 blocks. Soft assertions (Lighthouse, performance traces) require non-headless Chrome and are skipped in headless CI.

**54 fixture pages** in `test-harness/pages/`, plus `nextjs-fixture/` (10 files) and `sitemap.xml` for C3 tests, plus `source-fixture/app.js` for C1 codebase-analyzer tests. All served via HTTP on port 3100 — never via `file://`.

---

## 17. Key Implementation Rules

1. **Never use `window.innerWidth`** for overflow checks after `emulate` — use `document.documentElement.clientWidth`.
2. **`evaluate_script` parameter is `function`**, not `script`. Value must be a **callable arrow function string** `'() => expr'` — bare expressions and IIFEs (`(function(){})()`) are rejected by Chrome CDP's `Runtime.callFunctionOn`.
3. **Inject listeners AFTER `navigate_page`** — navigation destroys the page context; any script injected before navigate is gone. Correct order: navigate → wait for settle → inject all listeners.
4. MCP tool responses are markdown-wrapped — extract via regex in `mcp-client.js`. `take_screenshot` returns `type: 'image'` with a base64 `data` field (not `type: 'text'`).
5. **Fixture pages must be served via HTTP** — `file://` blocks CORS, ES modules, fetch API.
6. Security headers middleware: apply permissive CSP/XFrame to ALL fixture pages **except** `security-issues.html`.
7. `clean.html` must have `og:image` — all three OG tags are `severity: warning`.
8. For anchor href checks: use `a.getAttribute('href')` not `a.href` — the DOM property resolves to absolute URLs, breaking `startsWith('#')` checks.
9. ES module scope: importing a name and declaring `const` with the same name in scope causes `SyntaxError: Identifier already declared`.
10. **`env-comparison.js` captures dev and staging sequentially** — concurrent `navigate_page` calls on a shared MCP stdio client interleave and corrupt results.
11. **`og:image` must be an absolute URL** — relative values like `/images/og.png` are invalid per the Open Graph spec and flagged as `seo_og_image_relative_url` warning.
12. **`placeholder` is not a valid accessible name** — WCAG 2.1 §3.3.2; only `<label for>`, `aria-label`, `aria-labelledby`, and enclosing `<label>` count.

---

## 18. v4 Quality Audit

A comprehensive 30-gap audit of the full codebase was performed and fixed across 4 sprints (see `argus-v4-strategy.md` for the full gap list).

### Sprint 1 — Critical (6 fixes)

| Gap | File | Fix |
| --- | --- | --- |
| 01 | `crawl-and-report.js` + `validate.js` | 5 `INJECT_*` IIFEs → callable arrow functions; `EXTRACT_*` bare expression → arrow function |
| 02 | `crawl-and-report.js` | `document.title` and `body.innerText` bare expressions → arrow functions |
| 03 | `crawl-and-report.js` | `document.body?.innerText` bare expression → arrow function |
| 04 | `crawl-and-report.js` | All 5 listener injections moved AFTER `navigate_page` + page settle |
| 05 | `mcp-client.js` | Added `type: 'image'` handler in `tool()` — screenshots now return `{ data, mimeType }` |
| 06 | `src/argus.js` + `src/batch-runner.js` | Created missing entry point files (re-export from `crawl-and-report.js`) |

### Sprint 2 — Data Integrity (7 fixes)

| Gap | File | Fix |
| --- | --- | --- |
| 12 | `env-comparison.js` | `Promise.allSettled` concurrent captures → sequential `await` per environment |
| 09 | `contract-validator.js` | `if (!contract?.url) return false` guard before `.startsWith` crash |
| 07 | `session-manager.js` | `JSON.parse(readFileSync)` in `restoreSession` wrapped in try/catch |
| 10 | `github-reporter.js` | `GITHUB_TOKEN` presence check at top of `ghFetch` |
| 11 | `cli/init.js` | `mkdirSync(..., { recursive: true })` before `writeFileSync` for targets path |
| 08 | `flow-runner.js` | `INJECT_ERROR_LISTENER` defined and re-injected after every `navigate` action step |
| 13 | `crawl-and-report.js` | Inline `INTERNAL_LINKS_SCRIPT` removed; imported from `codebase-analyzer.js` |

### Sprint 3 — Accuracy (7 fixes)

| Gap | File | Fix |
| --- | --- | --- |
| 17 | `lighthouse-checker.js` | Explicit `audit.score == null` guard before `!== 0` check |
| 20 | `lighthouse-checker.js` | camelCase fallback (`bestPractices`) added for Lighthouse category key lookup |
| 18 | `snapshot-analyzer.js` | `placeholder` removed as accepted form label (WCAG 2.1 §3.3.2) |
| 19 | `cli/init.js` | Guard before `.env` write — warns and skips if file already exists |
| 16 | `session-manager.js` | Lock file (`sessionFile + '.lock'`) with exclusive `'wx'` open in `refreshSession` |
| 15 | `test-harness/validate.js` | Staging server startup in its own try/catch — failure degrades gracefully |
| 23 | `slack-notifier.js` | `slackPostWithBackoff` helper wraps both `chat.postMessage` calls with 3-attempt 429 retry |

### Sprint 4 — Hardening (5 fixes + 4 already correct)

| Gap | File | Fix |
| --- | --- | --- |
| 25 | `flow-runner.js` | `e.message ?? String(e.reason ?? e)` — no more `"undefined"` for rejection errors |
| 22 | `hover-analyzer.js` | Warning comment on `nth-of-type` parent-scoping limitation |
| 24 | `baseline-manager.js` | Lock file around `appendTrend` read-modify-write |
| 26 | `baseline-manager.js` | `GITHUB_REF_NAME` / `CI_COMMIT_BRANCH` env var fallbacks in `getCurrentBranch` |
| 30 | `seo-analyzer.js` | `ogImageUrl` captured; `seo_og_image_relative_url` warning when not absolute |
| 21 | `memory-analyzer.js` | Already had `finally { fs.unlinkSync }` — no change needed |
| 27 | `css-analyzer.js` | Already an arrow function — no change needed |
| 28 | `html-reporter.js` | Already inlines screenshots as base64 data URIs — no change needed |
| 29 | `route-discoverer.js` | Already had `AbortSignal.timeout(10000)` — no change needed |

### v4.1 Extension — Full Codebase Audit (42 gaps, Sprints 5–8, fixes pending)

Audited 2026-04-28 via 4 parallel agents. 15 previously-unaudited files across `src/server/`, analyzer utilities, general utilities, and `test-harness/`.

### Sprint 5 — Slack Server

| Gap | Severity | File | Issue |
| --- | --- | --- | --- |
| 31 | CRITICAL | `slash-command-handler.js` | `SLACK_BOT_TOKEN` read at module import → undefined before dotenv |
| 32 | HIGH | `slash-command-handler.js` | `runRetestAsync()` fire-and-forget without `.catch()` |
| 33 | HIGH | `slash-command-handler.js` | `TARGET_DEV_URL` mutation race between concurrent retests |
| 34 | HIGH | `interaction-handler.js` | Same `TARGET_DEV_URL` race in interaction handler |
| 35 | MEDIUM | `index.js` | Raw body accumulator has no size limit — OOM risk |
| 36 | MEDIUM | `index.js` | No request timeout — slow-loris vector |
| 37 | MEDIUM | `slash-command-handler.js` | Internal `err.message` leaked to Slack channel |
| 38 | MEDIUM | `slash-command-handler.js` | `SLACK_CHANNEL_CRITICAL` unguarded → posts "#undefined" |
| 39 | MEDIUM | `interaction-handler.js` | Post-response async calls outside try/catch → unhandled rejection |
| 40 | MEDIUM | `slash-command-handler.js` + `interaction-handler.js` | `TARGET_DEV_URL` not restored in finally block |
| 41 | LOW | `index.js` | `app.listen` no EADDRINUSE error handler |

### Sprint 6 — Analyzer Accuracy

| Gap | Severity | File | Issue |
| --- | --- | --- | --- |
| 42 | HIGH | `responsive-analyzer.js` | `parseEvalObject`/`parseEvalArray` silent failure — no log |
| 43 | HIGH | `security-analyzer.js` + `content-analyzer.js` | MCP `{ result: '...' }` wrapper not unwrapped → all findings silently dropped |
| 44 | MEDIUM | `security-analyzer.js` | `clearTimeout` not in finally → timer fires on error path |
| 45 | MEDIUM | `responsive-analyzer.js` | `parseEvalArray` uses `.value` fallback, should be `.result` |
| 46 | MEDIUM | `content-analyzer.js` | `querySelectorAll('li')` counts nested children — should be `:scope > li` |
| 47 | MEDIUM | `security-analyzer.js` + `content-analyzer.js` | `JSON.stringify(circular)` can throw silently in catch path |
| 48 | LOW | `security-analyzer.js` | Hardcoded 3s fetch timeout → false negatives on slow staging |
| 49 | LOW | `responsive-analyzer.js` | Screenshot data not size-capped → potential OOM |
| 50 | LOW | `security-analyzer.js` | `.filter(Boolean)` drops cookie named "0" or "false" |
| 51 | LOW | `security-analyzer.js` | Redundant `String()` coercion on localStorage values |

### Sprint 7 — Utility Correctness

| Gap | Severity | File | Issue |
| --- | --- | --- | --- |
| 52 | MEDIUM | `flakiness-detector.js` | Confirmed findings use run1 data — run2 metadata lost |
| 53 | HIGH | `api-frequency.js` | `req.url` passed as undefined to `normalizeApiUrl` → TypeError |
| 54 | HIGH | `diff.js` | `compareScreenshots` no try/catch — crashes on missing files |
| 55 | MEDIUM | `diff.js` | Division by zero in `diffPercent` if image is 0×0 |
| 56 | MEDIUM | `flakiness-detector.js` | `findingKey` no whitespace normalization → false flakiness |
| 57 | MEDIUM | `parallel-crawler.js` | `chunkArray` no array/integer validation |
| 58 | HIGH | `severity-overrides.js` | `processFindings` iterates `undefined` → TypeError |
| 59 | HIGH | `severity-overrides.js` | `report.routes` iterated without null guard |
| 60 | HIGH | `api-frequency.js` + `diff.js` | Inconsistent URL normalization between modules |
| 61 | MEDIUM | `flakiness-detector.js` | `mergeRunResults` no input validation |
| 62 | LOW | `severity-overrides.js` | Invalid override values fail silently |
| 63 | MEDIUM | `diff.js` | `writeFileSync` for diff image has no error handling |

### Sprint 8 — Test Harness Hardening

| Gap | Severity | File | Issue |
| --- | --- | --- | --- |
| 64 | MEDIUM | `test-harness/server.js` | Security headers `.includes()` matches unintended paths |
| 65 | HIGH | `test-harness/server.js` | `app.listen` no EADDRINUSE handler → CI crash |
| 66 | HIGH | `test-harness/harness-config.js` | `flow-form.html` missing from `harnessRoutes` |
| 67 | MEDIUM | `test-harness/server.js` | `/api/slow-image` no client-disconnect check |
| 68 | LOW | `test-harness/server.js` | JSON error routes missing explicit Content-Type |
| 69 | HIGH | `test-harness/server.js` | `sendFile()` no error callback |
| 70 | MEDIUM | `test-harness/server.js` | Slow API setTimeout no error handling |
| 71 | LOW | `test-harness/server.js` | Nocache routes missing `Cache-Control` header |
| 72 | MEDIUM | `test-harness/harness-config.js` | Expected severity string brittle — encodes Argus-internal policy |
