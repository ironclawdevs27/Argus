# Argus Test Harness

Validates that every Argus detection category fires correctly by running the full crawl pipeline against deliberately broken fixture pages hosted on a local Express server.

> **v4 Quality Audit complete** — all 30 gaps resolved. **v5 Correctness Hardening complete** (20 gaps). **v6 Detection Expansion complete** (10 new detection categories). **v7 Final Production Hardening complete** (2026-05-05) — 50+ security and robustness fixes across 17 source files. **v8 Harness Correctness** (2026-05-10) — uid regex rewrite, sync-xhr timing fix, select_option label resolution. **Watch Mode** (2026-05-17) — passive browser monitoring; block [78] added. **v9 Sprint 1** (2026-05-17) — CdpBrowserAdapter migration complete; all 13 files migrated from `mcp.*` → `browser.*`; 327/330. **v9 Sprint 2** (2026-05-18) — Plugin registry + god object split; `crawl-and-report.js` reduced to 20-line re-export shell; 6 analyzers self-register; harness gate: 327/330. **v9 Sprint 3** (2026-05-18) — Threshold centralization + Zod config validation; block [79] added; harness gate: 331/334. **v9 Sprint 4** (2026-05-18) — Session split (`session-persistence.js` + `login-orchestrator.js`), Pino structured logging across all src/ files, `withRetry()` on navigate and fill (`click` excluded — not idempotent); 6 gap fixes across two audit passes (pino-pretty load fallback, retry debug labels, clearSession `.tmp` log, doc corrections for click exclusion, NaN guard in `withRetry()`, `mkdirSync` in `saveSession()`); harness gate: 331/334 (no new assertions). **v9 Sprint 5** (2026-05-23) — Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (`createFinding()` — 4 assertions) + [82] (`withRetry()` — 4 assertions); harness gate: 339/342. **v9 Sprint 6** (2026-05-23) — Argus MCP server (`src/mcp-server.js`): `argus_audit`, `argus_audit_full`, `argus_compare`, `argus_last_report`; `.mcp.json` registration; `@modelcontextprotocol/sdk`; harness block [80] (6 file-read assertions); harness gate: 345/348.

<br/>

[![Node.js](https://skillicons.dev/icons?i=nodejs)](https://nodejs.org)
[![JavaScript](https://skillicons.dev/icons?i=js)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![HTML](https://skillicons.dev/icons?i=html)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS](https://skillicons.dev/icons?i=css)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![Chrome](https://skillicons.dev/icons?i=chrome)](https://www.google.com/chrome/)
[![GitHub Actions](https://skillicons.dev/icons?i=githubactions)](https://github.com/features/actions)

---

## What It Tests

82 test blocks · 348 hard assertions · 47 verified detection categories · 54 fixture pages

> **Coverage note**: 54 detection categories exist in production code. 47 are positively exercised by the harness. The remaining 7 have no fixture trigger yet — see [argus-v6-strategy.md §10](../argus-v6-strategy.md) for details and planned fixtures.

Hard assertions fail the run (exit code 1). Soft assertions are logged only — they depend on Chrome trace / Lighthouse availability and vary by environment.

| # | Fixture page | Detection exercised | Type |
|---|---|---|---|
| 1 | `clean.html` | No false positives on a healthy page | Hard |
| 2 | `js-errors.html` | `console.error`, `console.warn`, uncaught `TypeError`, unhandled `Promise.reject` | Hard |
| 3 | `js-errors-noncritical.html` | Severity — non-critical route → errors stay at `warning` | Hard |
| 4 | `js-errors-critical.html` | Severity escalation — critical route → console errors become `critical` | Hard |
| 5 | `network-errors.html` | HTTP 500 → `critical`, 401 → `critical` (auth), 403 → `critical`, 404 → `info` | Hard |
| 6 | `api-frequency.html` | API ×6 → `critical`, ×3 → `warning`, ×2 → `info` · `api_call_summary` present | Hard |
| 7 | `blank-page.html` | Body text < 50 chars → `blank_page` critical | Hard |
| 8 | `waitfor-page.html` | `#late-content` injected after 2 s — `waitFor` succeeds, no `load_failure` | Hard |
| 9 | `waitfor-timeout.html` | `#never-appears` never added → `load_failure` warning | Hard |
| 10 | `css-issues.html` | `!important` override · cascade override · unused rules · component leak · CSS Modules · inline conflict · SCSS source map | Hard |
| 11 | `perf-*.html` | TTFB > 800 ms · LCP > 2500 ms · CLS > 0.1 · FID/TBT > 100 ms | Soft |
| 12 | `a11y-critical.html` | Lighthouse accessibility score < 50 | Soft |
| 13 | `a11y-warning.html` | Lighthouse accessibility score 50–89 | Soft |
| 14 | `a11y-critical.html` | Individual failing Lighthouse audit items surfaced | Soft |
| 15 | `dev-home.html` vs `staging-home.html` | Network regression · new endpoint · missing endpoint · status change · new console errors · DOM diff · visual diff | Hard + Soft |
| 16 | `a11y-critical.html` | Full Lighthouse suite — performance · SEO · best-practices scores reported | Soft |
| 17 | `api-performance.html` | `slow_api` warning (>1 000 ms) · `slow_api` critical (>3 000 ms) · `large_payload` warning (>500 KB) · `large_payload` critical (>2 MB) | Hard |
| 18 | `seo-issues.html` | Missing `meta description` · missing OG tags · multiple `<h1>` · generic title · missing canonical · missing viewport | Hard |
| 19 | `security-issues.html` | localStorage token · token in URL · `eval()` · sensitive console · missing CSP · missing X-Frame-Options · cookie no HttpOnly | Hard |
| 20 | `content-issues.html` | `undefined`/`null` in visible text · placeholder text · broken image · empty data list | Hard |
| 21 | `responsive-issues.html` | `responsive_overflow` critical at ≤768 px · `responsive_small_touch_target` warning at 375 px and 768 px | Hard |
| 22 | `seo-no-h1.html` | `seo_missing_h1` warning — zero `<h1>` tags on page | Hard |
| 23 | `memory-leak.html` | `memory_detached_dom_nodes` warning — 50 detached `HTMLDivElement` nodes in heap · `memory_heap_growth` (soft) | Hard + Soft |
| 24 | `auth-login.html` + `auth-protected.html` | Login flow (fill + click + waitFor) · `saveSession` captures cookie + localStorage · `restoreSession` injects state · protected page accessible after restore · auth error without session | Hard |
| 25 | _(pure function — no fixture page)_ | Baseline manager: first-run detection · save+load round-trip · identical run returns 0 new/resolved · new finding → `isNew: true` · `appendTrend` persists resolved count · `getCurrentBranch` returns non-empty filename-safe string (D7.2) | Hard |
| 26 | _(pure function — no fixture page)_ | Flakiness detector: finding in both runs → confirmed (original severity, `flaky: false`) · run1-only → `flaky: true`, severity `info` · run2-only → `flaky: true`, severity `info` · confirmed/flaky counts | Hard |
| 27 | `flow-form.html` | Flow runner: empty flow → pass · fill+click+assert element_visible success · `element_visible` failure → `flow_assert_failed` · `no_console_errors` on clean page → 0 findings · `url_contains` match → 0 findings · `url_contains` no-match → finding detected | Hard |
| 28 | _(server redirect)_ | `redirect_chain` warning after 3-hop chain (start→hop1→hop2→end) · count > 2 · severity warning | Hard |
| 29 | `broken-links.html` | 2 `broken_link` warnings for internal 404 hrefs · valid link excluded · all severity warning · all status 404 | Hard |
| 30 | `a11y-critical.html` | `checkLighthouse` utility: returns array · all violations have required fields | Hard |
| 31 | `clean.html` (after `js-errors.html`) | D5 per-route slicing: prior-route errors visible without slice · 0 errors on clean page with D5 slice | Hard |
| 32 | `sync-xhr.html` | `sync_xhr` warning · method GET · requestUrl contains `/api/data` | Hard |
| 33 | `doc-write.html` | `document_write` warning ×2 · both write and writeln methods detected | Hard |
| 34 | `long-task.html` | `long_task` warning · at least one task ≥ 50ms | Hard |
| 35 | `cors-error.html` | `cors_error` critical · message contains "cors policy" | Hard |
| 36 | `sw-error.html` | `sw_registration_error` warning · scriptURL contains "sw-does-not-exist" | Hard |
| 37 | `cache-headers.html` | `cache_headers_missing` info ×2 · nocache.css and nocache.js both flagged · all severity info | Hard |
| 38 | `debugger-statement.html` | `debugger_statement` critical ×2 · inline script + external debug-script.js · all severity critical | Hard |
| 39 | `duplicate-ids.html` | `duplicate_id` warning ×2 · id="card" ×3 + id="header" ×2 · unique-id not flagged · all severity warning | Hard |
| 40 | `mixed-content.html` | `security_mixed_content` critical (blocked active content) + warning (passive image/audio) · critical message contains "blocked" | Hard |
| 41 | _(pure function — no fixture page)_ | Parallel crawler: chunkArray even split (6→3) · uneven split (5→3, items preserved) · fewer items than chunks (3→5 gives 3) · empty array → [] · n=1 → single chunk · `ARGUS_CONCURRENCY` defaults to 1 (D7.3) | Hard |
| 42 | _(pure function — no fixture page)_ | API contract validator: valid object → 0 violations · missing required field · wrong type · empty schema → passes · nested type mismatch · `matchesContract` path/method match, URL mismatch, method mismatch, no-method wildcard (D7.4) | Hard |
| 43 | _(pure function — no fixture page)_ | Severity overrides: downgrade warning→info + overriddenCount=1 · suppress removes finding + suppressedCount · override on absent type → zero stats · empty overrides → zero stats · flow findings overridden · null overrides → zero stats · unknown override value → finding unchanged (D7.5) | Hard |
| 44 | _(pure function — no fixture page)_ | Auth token refresh: null auth → refreshed:false · missing session file → refreshed:false · fresh session → refreshed:false · empty steps array → refreshed:false · corrupted session file → refreshed:false (D7.6) | Hard |
| 45 | _(pure function — no fixture page)_ | Slack-optional mode: no token → isSlackConfigured()=false · token present → isSlackConfigured()=true · generateHtmlReport writes valid self-contained HTML with embedded findings (D7.7) | Hard |
| 46 | `hover-issues.html` | `hover_dropdown_broken` warning (aria-haspopup with no JS open handler) · `hover_tooltip_missing` warning (tooltip opacity:0!important · severity warning on non-critical route (D8.1) | Hard |
| 47 | `snapshot-issues.html` | `a11y_missing_name` warning (SVG-only button) · `a11y_missing_form_label` warning (bare input) · `a11y_duplicate_landmark` warning (main + role=main) · all severity warning (D8.2) | Hard |
| 48 | `typetext-issues.html` | `mcp.fill` fires one consolidated input event (data-count equals value.length) · `mcp.type_text` fires per-keystroke input events (counter updates) · `typing: true` flow step completes without error · data-event-count=3 after "abc" via type_text (fill would fire 1 event not 3) (D8.3) | Hard |
| 49 | `drag-issues.html` | `drag` step is registered in flow-runner (no flow_step_failed on valid selector) · drag to working drop zone fires `drop` event (`data-dropped="true"`) · drag with missing selector → `flow_step_failed` with `action: "drag"` (D8.4) | Hard |
| 50 | `upload-issues.html` | `upload_file` step is registered in flow-runner (no flow_step_failed on valid input) · file delivered to input via CDP (`files.length > 0`) · missing filePath → `flow_step_failed` with `action: "upload_file"` (D8.5) | Hard |
| 51 | `source-fixture/app.js` + `.env.fixture` | C1.1 env variable audit — `MISSING_VAR` flagged as `env_var_missing` warning · `PRESENT_VAR` declared in `.env` excluded · all severity warning (C1) | Hard |
| 52 | `source-fixture/app.js` + `.env.fixture` | C1.2 feature flag leakage — `FEATURE_DISABLED` flagged (falsy in `.env`) · `FEATURE_ENABLED` truthy and excluded · all severity warning (C1) | Hard |
| 53 | _(pure function — no fixture page)_ | C1.3 error-to-source linking — stack frames extracted from console error message · top frame file resolved to `main.abc123.js` · all findings severity info (C1) | Hard |
| 54 | `dead-routes.html` | C1.4 dead route detection — ≥2 `dead_route` warnings for `/argus-dead-route-alpha` + `/argus-dead-route-beta` hrefs · valid link excluded · all severity warning (C1) | Hard |
| 55 | _(pure function — no fixture page)_ | C2.1 `formatPrComment` — returns non-empty string · contains COMMENT_MARKER sentinel · correct summary table row · New Findings section present on diff run · absent on first run · Codebase Analysis section present (C2) | Hard |
| 56 | _(pure function — no fixture page)_ | C2.2 `buildStatusPayload` — state `"failure"` when new critical findings exist · state `"success"` when no new criticals · context is `"argus-qa"` · description contains `"Argus"` (C2) | Hard |
| 57 | `pages/sitemap.xml` | C3.1 Sitemap discovery — `/about` parsed · off-origin URL excluded · unreachable server returns `[]` (C3) | Hard |
| 58 | `nextjs-fixture/` | C3.2 Next.js discovery — `pages/index.jsx` → `/` · `pages/api/` excluded · `_app.jsx` excluded · `(auth)/login/page.tsx` → `/login` · `[slug].jsx` excluded · empty sourceDir returns `[]` (C3) | Hard |
| 59 | _(temp dir)_ | C3.3 React Router discovery — `/dashboard` from `<Route path>` · `:id` excluded · non-existent sourceDir returns `[]` (C3) | Hard |
| 60 | _(pure function — no fixture page)_ | C3.4 `mergeRoutes` — 2 manual + 2 new = 4 total · manual config preserved · existing route not marked discovered · new route has `discovered: true` (C3) | Hard |
| 61 | `nextjs-fixture/` | C3.5 `discoverRoutes` orchestrator — returns array · adds Next.js routes · manual config preserved · `null` autoDiscover returns manual routes unchanged (C3) | Hard |
| 62 | _(temp dir with package.json)_ | C4.1 `detectFramework` — non-existent dir → `'unknown'` · no package.json → `'unknown'` · `next` dep → `'nextjs'` · `react-router-dom` dep → `'react-router'` (C4) | Hard |
| 63 | _(pure function — no fixture page)_ | C4.2 `generateTargetsJs` — returns non-empty string · contains export statements · route paths included · autoDiscover block reflects framework · empty routes falls back to default home route (C4) | Hard |
| 64 | _(pure function — no fixture page)_ | C4.3 `generateEnvFile` — returns non-empty string · devUrl substituted · Slack token not commented when provided · GitHub values substituted · blanks render as commented-out placeholders (C4) | Hard |
| 65 | `clean.html` | Production crawl pipeline smoke — `crawlRouteCheap()` returns errors array · all issues are info/warning · no criticals on clean fixture (091) | Hard |
| 66 | `clean.html` | Chrome DevTools Issues panel baseline — `analyzeIssues()` returns array · no issue findings on clean page · no `csp_violation` (093) | Hard |
| 67 | `issues-csp.html` | Chrome DevTools Issues panel — `csp_violation` critical detected · finding has type/message/severity/url fields (093) | Hard |
| 68 | `issues-deprecated.html` | Chrome DevTools Issues panel — `deprecated_api_use` info detected · findings are severity `info` (093) | Hard |
| 69 | _(pure function — no fixture page)_ | HAR timing `parseNetworkTiming` unit tests — empty array → 0 findings · cross-origin TTFB > 2000ms → `slow_third_party_blocking` warning · static asset skipped · same-origin skipped · below-threshold skipped (094) | Hard |
| 70 | `heading-issues.html` | `heading_level_skip` warning ×2 — h1→h3 skips h2, h4→h6 skips h5 · severity warning · skips have `from`/`to` fields (096) | Hard |
| 71 | `responsive-issues.html` | CPU throttle (4×) applied during ≤768px breakpoints — `responsive_overflow` critical still fires correctly under throttle (095) | Hard |
| 72 | `keyboard-issues.html` | `focus_visible_missing` warning detected · severity warning · `#no-focus-ring` button id present in findings (097) | Hard |
| 73 | `aria-state-issues.html` | `aria_expanded_no_controls` warning ×2 (toggle-no-controls + toggle-bad-controls) · severity warning · `#toggle-valid` with valid aria-controls NOT flagged (098) | Hard |
| 74 | `select-form.html` | `select_option` flow step — flow passes · no `flow_step_failed` · #form-result text is "US/L" after selecting country=US, size=L (099) | Hard |
| 75 | `clean.html` | Origin tagging — `crawlRouteCheap` returns errors array · all network-type findings carry `origin` field (100) | Hard |
| 76 | `clean.html` (localhost exclusion) | HTTPS enforcement — `security_no_https` NOT emitted for localhost · URL parsing correctly classifies non-localhost as non-local · `http://example.com` protocol = `http:` (101) | Hard |
| 77 | `iframe-sandbox.html` | `security_iframe_no_sandbox` warning ×2 (example.com + w3.org) · severity warning · sandboxed iframe NOT flagged (102) | Hard |
| 78 | `watch-issues.html` | Watch Mode — `WatchSession.poll()` detects console errors/warnings + network 4xx/5xx on first poll · second poll returns 0 (dedup) · third poll after `argusWatchTriggerError()` finds new incremental finding · HTTP 500 classified as `network_server_error` critical · all findings have type/severity/message fields | Hard |
| 79 | _(pure function — no fixture page)_ | Zod config validation — valid config passes · route missing `path` throws · path without leading `/` throws · non-number threshold throws (v9 Sprint 3) | Hard |
| 80 | _(file-read — no fixture page)_ | Argus MCP server registration — `src/mcp-server.js` exists · contains `argus_audit` · contains `argus_compare` · contains `argus_audit_full` · contains `argus_last_report` · `.mcp.json` has `"argus"` entry (v9 Sprint 6) | Hard |
| 81 | _(pure function — no fixture page)_ | `createFinding()` factory — correct field values · throws on missing type · throws on invalid severity · returns frozen object (v9 Sprint 5) | Hard |
| 82 | _(pure function — no fixture page)_ | `withRetry()` exponential backoff — fn called once on success · retries on transient failure · rethrows after all attempts · `ARGUS_RETRY_ATTEMPTS=1` disables retries (v9 Sprint 5) | Hard |

---

## Directory Layout

```
test-harness/
├── README.md               ← you are here
├── server.js               ← Express fixture server (port 3100 dev / 3101 staging)
├── harness-config.js       ← route definitions + expected findings
├── validate.js             ← test runner — starts servers, connects Chrome, asserts
├── pages/
│   ├── clean.html                  test 1  — zero-error baseline
│   ├── js-errors.html              test 2  — console + thrown exceptions
│   ├── js-errors-noncritical.html  test 3  — severity: non-critical route
│   ├── js-errors-critical.html     test 4  — severity: critical route escalation
│   ├── network-errors.html         test 5  — HTTP 500 / 401 / 403 / 404
│   ├── api-frequency.html          test 6  — duplicate API calls + summary entry
│   ├── blank-page.html             test 7  — empty body
│   ├── waitfor-page.html           test 8  — late DOM injection (success)
│   ├── waitfor-timeout.html        test 9  — selector never appears (timeout)
│   ├── css-issues.html             test 10 — CSS quality detections (7 types)
│   ├── perf-issues.html            test 11 — slow TTFB (1200 ms server delay)
│   ├── perf-lcp.html               test 11 — LCP > 2500 ms (3 s image delay)
│   ├── perf-cls.html               test 11 — CLS > 0.1 (layout shift after 200 ms)
│   ├── perf-fid.html               test 11 — FID/TBT > 100 ms (600 ms busy-wait)
│   ├── a11y-critical.html          tests 12, 14, 16 — many a11y violations + full Lighthouse suite
│   ├── a11y-warning.html           test 13 — moderate a11y violations
│   ├── dev-home.html               test 15 — env-comparison dev fixture
│   ├── staging-home.html           test 15 — env-comparison staging (regressions injected)
│   ├── seo-issues.html             test 18 — SEO meta/heading issues
│   ├── api-performance.html        test 17 — slow API + oversized payload
│   ├── security-issues.html        test 19 — security checks
│   ├── content-issues.html         test 20 — content quality checks
│   ├── responsive-issues.html      test 21 — responsive overflow + touch targets
│   ├── seo-no-h1.html              test 22 — missing h1 heading
│   ├── memory-leak.html            test 23 — detached DOM nodes + heap growth
│   ├── auth-login.html             test 24 — login form: fill+click sets cookie + localStorage
│   ├── auth-protected.html         test 24 — protected page: shows content with session, 401 without
│   ├── flow-form.html              test 27 — two-field form with onclick handler: success + validation error
│   ├── redirect-chain-end.html     test 28 — landing page for 3-hop redirect chain
│   ├── broken-links.html           test 29 — 2 dead internal hrefs + 1 valid link + 4 skipped external
│   ├── sync-xhr.html               test 32 — synchronous XMLHttpRequest to /api/data
│   ├── doc-write.html              test 33 — document.write() + document.writeln() in inline script
│   ├── long-task.html              test 34 — 120ms busy-loop triggers long_task
│   ├── cors-error.html             test 35 — fetch to localhost:3101 blocked by CORS
│   ├── sw-error.html              test 36 — register('/sw-does-not-exist.js') fails with 404
│   ├── cache-headers.html         test 37 — /api/nocache.css + /api/nocache.js served without cache headers
│   ├── debugger-statement.html    test 38 — inline + external script with debugger; statement
│   ├── duplicate-ids.html         test 39 — id="card" ×3 + id="header" ×2 duplicate ids
│   ├── mixed-content.html         test 40 — console.error (blocked) + console.warn (passive) mixed content messages
│   ├── hover-issues.html          test 46 — aria-haspopup with no JS open handler + tooltip opacity:0!important
│   ├── snapshot-issues.html       test 47 — SVG-only button + bare input + duplicate <main> landmark
│   ├── typetext-issues.html       test 48 — two inputs with input-event char counters (fill vs type_text)
│   ├── drag-issues.html           test 49 — working drop zone + broken drop zone (no dragover preventDefault)
│   ├── upload-issues.html         test 50 — file input with change-event filename display
│   ├── dead-routes.html           test 54 — 2 dead internal hrefs + 1 valid link + external skip targets
│   ├── issues-csp.html            test 67 — CSP meta (script-src 'self') + inline script → csp_violation
│   ├── issues-deprecated.html     test 68 — document.domain + DOMSubtreeModified → deprecated_api_use
│   ├── heading-issues.html        test 70 — h1→h3 skip + h4→h6 skip → heading_level_skip ×2
│   ├── keyboard-issues.html       test 72 — #no-focus-ring button with outline:none → focus_visible_missing
│   ├── aria-state-issues.html     test 73 — aria-expanded toggle with no/broken aria-controls → aria_expanded_no_controls ×2
│   ├── select-form.html           test 74 — #country + #size selects + submit → select_option flow step
│   ├── iframe-sandbox.html        test 77 — 2 unsandboxed cross-origin iframes + 1 sandboxed → security_iframe_no_sandbox ×2
│   ├── watch-issues.html          test 78 — console.error + console.warn on load; /api/always-500 + /api/missing fetch; window.argusWatchTriggerError()
│   ├── test-upload.txt            test 50 — tiny text file used as the upload payload
│   └── sitemap.xml                test 57 — 4 same-origin <loc> entries + 1 off-origin entry
├── nextjs-fixture/                C3 Next.js file-structure fixture (10 files)
│   ├── pages/
│   │   ├── index.jsx              test 58 — discoverable root route
│   │   ├── about.jsx              test 58 — discoverable /about route
│   │   ├── blog/
│   │   │   └── index.jsx          test 58 — discoverable /blog route
│   │   ├── _app.jsx               test 58 — excluded (underscore file)
│   │   ├── api/
│   │   │   └── health.js          test 58 — excluded (api/ directory)
│   │   └── [slug].jsx             test 58 — excluded (dynamic [param] segment)
│   └── app/
│       ├── page.tsx               test 58 — discoverable root route
│       ├── about/
│       │   └── page.tsx           test 58 — discoverable /about route
│       ├── (auth)/
│       │   └── login/
│       │       └── page.tsx       test 58 — /login (route group stripped)
│       └── api/
│           └── route.ts           test 58 — excluded (api/ + not page.*)
└── static/
    └── button-styles.css       BEM card selectors in a button stylesheet
                                → triggers component style leak detection
```

---

## Prerequisites

| | Requirement | Version | Notes |
|---|---|---|---|
| [![Node.js](https://skillicons.dev/icons?i=nodejs&theme=light)](https://nodejs.org) | Node.js | ≥ 20.19 | Required by `chrome-devtools-mcp` |
| [![Chrome](https://skillicons.dev/icons?i=chrome&theme=light)](https://www.google.com/chrome/) | Google Chrome | any stable | Must be started with remote debugging enabled |
| [![npm](https://skillicons.dev/icons?i=npm&theme=light)](https://npmjs.com) | npm dependencies | — | Run `npm install` in the project root once |

---

## Running the Harness

### Step 1 — Start Chrome with remote debugging

> Chrome only needs to be started once per session. Leave this terminal open.

**Windows (PowerShell)**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new
```

**Windows (Command Prompt)**
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new
```

**Mac**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --headless=new
```

**Linux**
```bash
google-chrome --remote-debugging-port=9222 --headless=new
```

Verify Chrome is ready:
```bash
curl http://127.0.0.1:9222/json/version
# Should return a JSON object with "Browser": "Chrome/..."
```

### Step 2 — Run the validator

```bash
npm run test:harness
```

The validator will:
1. Start the dev fixture server on `http://localhost:3100`
2. Start the staging fixture server on `http://localhost:3101`
3. Connect to Chrome via the DevTools MCP client
4. Navigate to each fixture page and collect detections
5. Print pass / fail for each assertion
6. Shut down both fixture servers and exit

**Expected output (345/348 — 3 permanent MCP-limited failures):**

```
╔══════════════════════════════════════════════════════╗
║     ARGUS Test Harness Validator — full coverage     ║
╚══════════════════════════════════════════════════════╝

▶ Starting dev fixture server on port 3100 ...
▶ Starting staging fixture server on port 3101 ...
▶ Connecting to Chrome DevTools MCP ...
  Connected.

[1] Clean page — expect: zero warnings / criticals
  ✓ No warning/critical on clean page (got 0: none)

[2] JS Errors — console.error, console.warn, thrown TypeError, unhandled rejection
  ✓ console.error detected (found 3)
  ✓ console.warn detected (found 1)
  ✓ console errors → severity "warning" on non-critical route

...

[24] Auth Session — login flow, save, restore, protected route access
  ✓ Protected page shows #auth-error when no session (baseline)
  ✓ Login flow succeeded — #login-success[data-ready] found after fill + click
  ✓ Session saved with localStorage keys (found: authToken, userId, userEmail)
  ✓ restoreSession returned true — session file found and injected
  ✓ Protected page shows #protected-content after session restore (userId: 42)

[15] Env Comparison — 7 detections between dev and staging
  ✓ Checkout returns 200 on dev (got 200)
  ✓ Checkout returns 500 on staging — API regression detected (got 500)
  ✓ New request on staging only: /api/tracking
  ✓ Request present in dev but missing on staging: /api/feature-flags
  ✓ Analytics status changed: 200 dev → 404 staging
  ✓ More console errors on staging (2) than dev (0)
  ✓ DOM diff: .pricing section present on dev, missing on staging

[25] Baseline Manager — applyBaseline, saveBaseline, loadBaseline, appendTrend
  ✓ applyBaseline(null) → isFirstRun: true
  ✓ First run — all findings marked isNew: true
  ✓ loadBaseline returns non-null after saveBaseline
  ✓ Identical run → newCount: 0, resolvedCount: 0 (both 0)
  ✓ New finding detected — newCount: 1 (expected 1)
  ✓ appendTrend round-trip — resolvedCount: 2 (expected 2), trends length: 1

[26] Flakiness Detector — mergeRunResults
  ✓ Confirmed finding — flaky: false, severity: critical (original)
  ✓ Run1-only finding → flaky: true, severity: info (was critical)
  ✓ Run2-only finding → flaky: true, severity: info (was warning)
  ✓ Confirmed count: 1 (expected 1)
  ✓ Flaky count: 2 (expected 2)

────────────────────────────────────────────────────────
Results: 345/348 hard assertions passed, 3 failed

✗ [49b] drag uses mouse simulation — HTML5 drop event never fires (MCP behavioral limit)
✗ [67b] Chrome DevTools Issues panel not returned by list_console_messages (MCP behavioral limit)
✗ [68b] Chrome DevTools Issues panel not returned by list_console_messages (MCP behavioral limit)

⚠ 3 permanent MCP-limited failures — these cannot be fixed in Argus code.
```

---

## Running Fixture Servers Manually

Browse the fixture pages directly without the validator — useful for visual inspection or connecting Argus interactively from Claude Code.

```bash
# Dev server (port 3100)
npm run harness

# Staging server (port 3101) — serves regressions for env-comparison tests
npm run harness:staging
```

| URL | What you'll see |
|---|---|
| `http://localhost:3100/clean.html` | Healthy page — no issues |
| `http://localhost:3100/js-errors.html` | JS errors firing in the console |
| `http://localhost:3100/js-errors-critical.html` | JS errors escalated to critical severity |
| `http://localhost:3100/network-errors.html` | Four failing API calls (500 / 401 / 403 / 404) |
| `http://localhost:3100/api-frequency.html` | 11 fetch calls to three endpoints |
| `http://localhost:3100/blank-page.html` | Empty page body |
| `http://localhost:3100/css-issues.html` | CSS quality issues (open DevTools → Elements) |
| `http://localhost:3100/perf-lcp.html` | Hero image that loads after 3 s |
| `http://localhost:3100/perf-cls.html` | Layout shift 200 ms after load |
| `http://localhost:3100/perf-fid.html` | 600 ms main-thread block after load |
| `http://localhost:3100/` | Dev home — blue hero, pricing section present |
| `http://localhost:3101/` | Staging home — red hero, pricing section missing |

---

## Environment Comparison Regressions

The dev and staging home pages expose intentional regressions for testing `src/orchestration/env-comparison.js`:

| Regression | Dev (`localhost:3100`) | Staging (`localhost:3101`) |
|---|---|---|
| Hero background | Blue `#0070f3` | Red `#d32f2f` — visual diff |
| Pricing section | Present | Missing — DOM diff |
| `/api/checkout` | HTTP 200 | HTTP 500 — network regression |
| `/api/analytics` | HTTP 200 | HTTP 404 — status change |
| `/api/feature-flags` | Called | Not called — missing endpoint |
| `/api/tracking` | Not called | Called — new endpoint |
| Console errors | 0 | 2 — new errors in staging |

To run env-comparison directly against the harness servers:

```bash
TARGET_DEV_URL=http://localhost:3100 TARGET_STAGING_URL=http://localhost:3101 npm run compare
```

---

## How the CSS Component Leak Is Triggered

`static/button-styles.css` is intentionally named after buttons but contains BEM selectors for the `card` component (`.card__title`, `.card__body`, `.card--featured`).

Argus's CSS analyzer checks:

> Does the CSS source filename contain the component name found in the selector?

`button-styles.css` does not contain `card` → **leak detected.**

This validates cross-component style pollution detection — catching cases where a developer accidentally commits card styles into a button stylesheet, causing hard-to-debug style bleed across components.

---

## Adding a New Test Case

1. Create a fixture page in `pages/` with the deliberate issue.
2. Add an API endpoint in `server.js` if the issue requires a server-side response.
3. Add the route to `harnessRoutes` in `harness-config.js` with an `expected` description.
4. Add a numbered test block in `validate.js` with `assert()` calls for each expected detection.

> Keep fixture pages focused — one category of issue per page makes failures easy to diagnose.

---

## Troubleshooting

**`Fatal error: MCP process exited` or `Could not connect to Chrome`**

Chrome is not running or not listening on port 9222. Start Chrome with `--remote-debugging-port=9222` (see Step 1 above) and verify with `curl http://127.0.0.1:9222/json/version`.

**`Fatal error: Harness server did not start within 10 s`**

Port 3100 or 3101 is already in use. Kill the process holding it:

```bash
# Windows
netstat -ano | findstr :3100
taskkill /PID <pid> /F

# Mac / Linux
lsof -ti:3100 | xargs kill
```

**`6/42 pattern` — all detection counts zero, some vacuous assertions pass**

This is the signature of Chrome not being reachable. When the MCP cannot connect to Chrome, `evaluate_script` returns an error string instead of data — `evalToArray()` converts it to `[]`, so all detection lists are empty and count-based assertions fail. Fix: ensure Chrome is running on port 9222.

**CSS component leak not detected (test 10 partial failure)**

Chrome may be blocking the external stylesheet. Check the Network tab — `button-styles.css` should return HTTP 200 from `http://localhost:3100/static/button-styles.css`.

**Soft assertions always show `N/A`**

`performance_start_trace` and `lighthouse_audit` require a non-headless Chrome session or additional flags not present in the default setup. Soft failures are expected and do not indicate a bug in Argus — they're soft by design.
