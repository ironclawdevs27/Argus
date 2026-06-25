# Argus Test Harness

Validates that every Argus detection category fires correctly by running the full crawl pipeline against deliberately broken fixture pages hosted on a local Express server.

> **v4 Quality Audit complete** — all 30 gaps resolved. **v5 Correctness Hardening complete** (20 gaps). **v6 Detection Expansion complete** (10 new detection categories). **v7 Final Production Hardening complete** (2026-05-05) — 50+ security and robustness fixes across 17 source files. **v8 Harness Correctness** (2026-05-10) — uid regex rewrite, sync-xhr timing fix, select_option label resolution. **Watch Mode** (2026-05-17) — passive browser monitoring; block [78] added. **v9 Milestone 1** (2026-05-17) — CdpBrowserAdapter migration complete; all 13 files migrated from `mcp.*` → `browser.*`; 327/330. **v9 Milestone 2** (2026-05-18) — Plugin registry + god object split; `crawl-and-report.js` reduced to 16-line re-export shell; 6 analyzers self-register; harness gate: 327/330. **v9 Milestone 3** (2026-05-18) — Threshold centralization + Zod config validation; block [79] added; harness gate: 331/334. **v9 Milestone 4** (2026-05-18) — Session split (`session-persistence.js` + `login-orchestrator.js`), Pino structured logging across all src/ files, `withRetry()` on navigate and fill (`click` excluded — not idempotent); 6 gap fixes across two audit passes (pino-pretty load fallback, retry debug labels, clearSession `.tmp` log, doc corrections for click exclusion, NaN guard in `withRetry()`, `mkdirSync` in `saveSession()`); harness gate: 331/334 (no new assertions). **v9 Milestone 5** (2026-05-23) — Vitest unit test suite: 6 files, 61 tests, zero Chrome dependency (`npm run test:unit`); harness blocks [81] (`createFinding()` — 4 assertions) + [82] (`withRetry()` — 4 assertions); harness gate: 339/342. **v9 Milestone 6** (2026-05-23) — Argus MCP server (`src/mcp-server.js`): `argus_audit`, `argus_audit_full`, `argus_compare`, `argus_last_report`; `.mcp.json` registration; `@modelcontextprotocol/sdk`; harness block [80] (6 file-read assertions); harness gate: 345/348. Published to npm as **`argusqa-os@9.2.0`** (2026-05-27) — add via `{ "command": "npx", "args": ["-y", "argusqa-os"] }` in `.mcp.json`. **v9 Milestone 7** (2026-05-24) — OpenTelemetry tracing + metrics (`src/utils/telemetry.js`); spans in `runCrawl`, per-route/analyzer, `dispatchAll`, `runFlow`/steps; 5 metrics; no-op default; no new assertions; harness gate unchanged: 345/348. **v9 Milestone 8** (2026-05-29) — `argus_watch_snapshot` + `argus_get_context` MCP tools; watch interval 3000→1000ms; block [80] extended with [80g–80l] (12 new assertions); harness gate: 357/360. Published to npm as **`argusqa-os@9.3.0`**. **v9 Milestone 9** (2026-05-29) — Fix loop (snapshot diff via `snapshot_id`, `snapshotStore` Map, `resolved`/`new_issues`/`persisting` diff arrays); watch mode web dashboard (Node `http` server port 3002, `/data` endpoint, inline `DASHBOARD_HTML`); harness block [83] (6 assertions for watch-mode dashboard contracts); version bumped to **`argusqa-os@9.3.1`**; harness gate: 357/360. **v9 Milestone 10** (2026-05-30) — `argus_audit` caching (`cache:true`, `auditCache` Map); multi-tab watch mode (`tabId` on both watch tools, `open_tabs` in `argus_get_context`, `listPages()`/`selectPage()` on `CdpBrowserAdapter`); GitHub Actions harness CI gate (`harness-ci.yml`); `glama.json` expanded; harness block [84] (7 assertions, `cli/init.js` smoke test); permanent-failure exit logic (exits 0 when only [49b]/[67b]/[68b] fail); harness gate: 364/367. Published as **`argusqa-os@9.4.0`**. **v9.4.1 patch** (2026-05-30) — `handleAudit` API contract fix (`{ findings, summary }` shape now matches tool description); CI Chrome startup uses 15-attempt retry loop. Published as **`argusqa-os@9.4.1`**. **Tier 1** (v9.4.2, 2026-05-30) — `browser.heapSnapshot` → `take_heapsnapshot`; `browser.emulateCpu` → `emulate({ cpuThrottlingRate })`; stale `emulate_cpu` removed from `mcp-client.js`; all docs updated. **v9.4.3** — all 10 Dependabot PRs applied; phantom `chrome@0.1.0` dep (5 CVEs) removed; unused `sharp` removed; wrong GitHub URL in `github-reporter.js` fixed. **v9.4.4** — MCP Registry description updated (100-char limit). **v9.4.5** — Socket.dev URL fixes: `y.com`/`yourapp.com` → `example.com` throughout; OTel `service.version` corrected to current. **Tier 2** (v9.4.6, 2026-05-30) — GAP-002: `contract-validator` path traversal hardened (`path.relative()` + `..` reject); GAP-003: `withMcp()` explicit error logging before re-throw; GAP-008: Slack `WebClient` lazy-init (no crash when `SLACK_BOT_TOKEN` absent); GAP-009: 401/403 severity gated on `routeIsCritical` (was always `critical`); GAP-010: broken-link `Promise.all` wrapped in 15 s outer timeout; GAP-001: late/unexpected JSON-RPC responses logged at debug level; GAP-006: `harness-ci.yml` KNOWN_PERMANENT block IDs documented. Harness gate: **364/367** (unchanged — no new assertions in Tier 2). **Tier 3** (v9.5.0, 2026-05-30) — 9 new blocks [85]–[93]: production-code-path regression tests for GAP-009 (401/403 severity), GAP-022–GAP-030; `diffNetworkRequests`/`diffConsoleMessages` utility unit tests; `checkLighthouse` contract (soft). 27 new hard assertions. Harness gate: **391/394** (3 permanent MCP-limited failures unchanged). **Gap-close Sections 1–6** (2026-05-31) — 33 new blocks [94]–[126]: zero-coverage module contracts (mcp-parsers, registry, report-processor, config/targets, slug, telemetry, logger, argus.js, batch-runner, mcp-client), server/slash-command, server/interaction, slack-notifier, session-persistence, baseline-manager, schema Zod errors, github-reporter cap, html-reporter scale, diff URL normalization, mcp-server LRU, flow-runner press_key, watch dashboard /data, MCP stdio transport, argus_last_report/argus_get_context/argus_watch_snapshot tool contracts, Express /health, html-reporter CLI write, three unhappy-path crawl paths, 12k-message overflow stress, cli/init.js E2E file write. 137 new hard assertions. Harness gate: **541/544** (3 permanent MCP-limited failures unchanged). **Tier 4** (v9.5.1, 2026-05-31) — 14 code-quality gaps resolved, no harness block changes: GAP-014 `snapshot(opts)` forwarding; GAP-016 stale version strings removed; GAP-017 shell-metachar check removed from `mcp-client.js`; GAP-018 `LIGHTHOUSE_TIMEOUT_MS` applied; GAP-019 click no-retry comment; GAP-020 `saveSession` try/catch; GAP-021 `.env.example` updated; GAP-033 `createFinding` JSDoc; GAP-034 CSS analysis moves to `registerExpensive` plugin; GAP-036 retry error type; GAP-037 Slack jitter; GAP-038 `mcp.close()` debug log; GAP-039 route path in logs; GAP-040 `restoreSession` timeout. Harness gate: **541/544** (unchanged). **Milestone 1** (v9.5.2, 2026-06-01) — A7 Theme & Dark Mode: `theme-analyzer.js` self-registers as `registerExpensive`; `emulateColorScheme(scheme)` on `CdpBrowserAdapter`; fixture `theme-issues.html`; harness block [127] (7 assertions); blocks [90]/[91] updated to call CSS analyzer directly (GAP-034 harness fix). Harness gate: **541/544** (3 permanent failures unchanged). **D9 Design Fidelity initial** (v9.5.3, 2026-06-02) — `src/adapters/figma.js` REST adapter (`getFigmaFrame`, `parseFigmaUrl`); `design-fidelity-analyzer.js` registerExpensive plugin comparing CSS custom properties against Figma tokens; orchestrator pre-fetches figmaData for routes with `figmaFrameUrl`; `argus_design_audit` tool (7th); fixture `design-fidelity.html`; block [128] (9 assertions). Harness gate: **541/544**. **D9 maximum potential** (2026-06-04) — `figma.js`: `inferSelectors()` generates 4 selector candidates per node (`[data-testid="slug"]`, `[aria-label="name"]`, `#slug`, `.slug`; explicit selectors honoured verbatim); per-corner radii as `{topLeft,topRight,bottomRight,bottomLeft}` object; shadow includes spread+color; `characters` for text content. `design-fidelity-analyzer.js`: `findElementWithSelector()` tries candidates in order; 13 mismatch finding types — all 12 from initial expansion plus new `design_position_drift` (scroll-corrected absolute x/y vs Figma bounds, 20px threshold); shadow comparison extended to include spread (2px) + color (RGB Euclidean); radius comparison handles per-corner object with `borderTopLeftRadius` etc.; 12 threshold constants; `design_fidelity_summary` aggregates all 13 counts + positionDrifts. Fixture has 11 elements (7 original + shadow-color-box, corner-box, data-testid test-card, drift-box). Block [128] expanded 24 → 30 assertions ([128a]–[128ad]). Harness gate: **569/572** (3 permanent failures unchanged). **Web Vitals & Bundle Size** (v9.5.4, 2026-06-05) — `web-vitals-analyzer.js` registerExpensive plugin: LCP, CLS, FCP, TTI, TTFB via PerformanceObserver + NavigationTiming API (headless-compatible — no Lighthouse required); `perf_bundle_large` (JS ≥500KB warning / ≥2MB critical; CSS ≥150KB); `perf_vitals_summary` always emitted; fixture `perf-vitals.html` loads 600KB JS; `/api/large.js` server endpoint; block [129] — 7 hard + 2 soft assertions; LCP=168ms + TTI=143ms captured in headless. Harness gate: **569/572** (unchanged — Milestone 9 adds [129], no permanent failures change). **A8 Visual Regression** (v9.5.5, 2026-06-06) — `visual-diff-analyzer.js` registerExpensive plugin: pixelmatch screenshot baseline comparison; `visual_baseline_created` (info, first run), `visual_regression` (warning ≥0.1% / critical ≥5%), `visual_diff_summary` (always emitted); BFcache fix; fixture `visual-regression.html`; block [130] (9 assertions); 58 detection categories. Harness gate: **578/581**. **A12 Deep Accessibility** (v9.5.6, 2026-06-06) — `a11y-deep-analyzer.js` registerExpensive: axe-core 4.12 injection (80+ WCAG rules, impact→severity mapping) + protanopia/deuteranopia CVD color blind simulation; `a11y_axe_violation`, `a11y_colorblind_risk`, `a11y_deep_summary`; fixture `a11y-deep-issues.html`; block [131] (9 assertions); 59 detection categories; 58 fixture pages. Harness gate: **587/590**. **Extension** (v9.5.7, 2026-06-06) — `argus_visual_diff` wired as 8th MCP tool; [80m]+[80n] registration assertions + [117c/d] threshold assertions (2 new hard assertions); 592 total assertions. Harness gate: **589/592**. **Milestones 5 / 5b / 5c / 5d** (v9.5.8, 2026-06-07) — `har-recorder.js` (N1: HAR Network Baseline — record + diff per route), `motion-analyzer.js` (A9: prefers-reduced-motion + autoplay detection), `font-analyzer.js` (A10: FOIT/FOUT/fallback/slow/format), `form-analyzer.js` (A11: required/autocomplete/aria/validation gaps); `emulateReducedMotion` on `CdpBrowserAdapter`; 4 fixture pages; blocks [132]–[135]; 63 detection categories; 62 fixture pages; 616 total assertions. Harness gate: **613/616**. **GitHub Check Runs** (v9.5.9, 2026-06-07) — `github-reporter.js` extended: `createCheckRun`/`completeCheckRun` (GitHub Checks API), selector-linked findings column, visual regression section + `ARGUS_DIFF_IMAGE_URL` embed, `generateReleaseNotes()` pure function, `ARGUS_CRITICAL_THRESHOLD` configurable gate, `GITHUB_CHECK_NAME` env var; block [136] (10 assertions). Harness gate: **623/626** (3 permanent MCP-limited failures unchanged). **PR Diff Analyzer** (v9.6.0, 2026-06-08) — `pr-diff-analyzer.js` (MIT): `parsePrUrl`, `fetchPrFiles`, `mapFilesToRoutes` (INFRA_PATTERNS + slug heuristic + conservative fallback); `argus_pr_validate` 9th MCP tool; `action.yml` composite GitHub Action; `ARGUS_BLOCK_ON` env var; block [137] (8 assertions: [137a]–[137h]). Harness gate: **631/634** (3 permanent MCP-limited failures unchanged). **GitHub Action CLI** (v9.6.1, 2026-06-08) — `src/cli/pr-validate.js`: full headless CI entry point; `buildStepSummary` + `writeGithubOutputs` + `writeStepSummary` exported for testing; `::error::`/`::warning::` inline annotations; `GITHUB_STEP_SUMMARY` markdown table; `action.yml` fully fixed (Chrome binary detection, env-var injection safety, `routes-file` + `node-version` inputs, `setup-node@v4`, separate "Fail on blocked" step removed — CLI exits 1 directly); block [138] (10 assertions: [138a]–[138j]). Harness gate: **641/644** (3 permanent MCP-limited failures unchanged). **PR Validator hardening** (v9.6.6, 2026-06-09) — `checkTargetReachable()` preflight (network-error-only, HTTP 4xx returns `ok:true`), `normalizeRoutePaths()` (prepends `/` to bare route paths), all-routes-failed guard (throws when every route errors, prevents false-pass `blocked=false`), `EXCLUDED_PATTERNS` in `mapFilesToRoutes` (`.github/`/`docs/`/`*.md`/LICENSE PR → returns `[]` to skip audit entirely), `notifications/initialized` MCP handshake after `initialize`, `baseUrl = targetUrl.replace(/\/$/, '')` path-prefix preservation (not `.origin`, which strips path — fixes GitHub Pages `/project/` deploys), block-on=warning annotation fix; `action.yml` description ≤125 chars, `argusqa-os@9.6.6` + `chrome-devtools-mcp@1.1.1` version-pinned; [137i–k] EXCLUDED_PATTERNS coverage (3 assertions) + [138k–p] preflight/normalize/guard coverage (6 assertions); 9 new assertions. Harness gate: **650/653** (3 permanent MCP-limited failures unchanged). **Milestone 8** (v9.7.0, 2026-06-10) — `src/cli/chrome-launcher.js` (`findChrome` cross-platform binary detection, `launchChrome` one-command runner); `src/cli/doctor.js` (`checkChrome` CDP ping, `checkMcpConfig` server config check, `checkEnvKeys` env validation); `src/utils/security-analyzer.js` extended: SRI validation (external scripts/stylesheets without `integrity`), source map exposure (`.js.map`/`.css.map` in network requests), open redirect detection (`?redirect=`/`?return=`/etc. in URLs), `auditNpmDependencies` (`npm audit --json` subprocess, `{ shell: true }` for Windows); `src/utils/pdf-exporter.js` (`exportReportToPdf` + `exportPageToPdf` via optional puppeteer peer dep); `src/utils/screen-recorder.js` (`PollingRecorder` zero-dep screenshots, `CdpScreenRecorder` CDP `Page.startScreencast` with optional `ws` peer dep); `package.json`: `npm run chrome`, `npm run doctor`, `npm run report:pdf`; `argus-chrome` + `argus-doctor` bin entries; block [139] (11 assertions [139a–139k]: chrome-launcher exports, doctor exports, checkSourceMapExposure shape, checkOpenRedirects shape, SRI finding types, `findChrome()` returns string|null without throwing). Harness gate: **661/664** (3 permanent MCP-limited failures: [49b] drag drop, [67b]/[68b] DevTools Issues panel). **[49b] root-cause fix** (v9.7.1, 2026-06-11) — [49b] was never a Chrome/MCP limit: `resolveUidForSelector()` substring matching resolved `#drag-source` to the fixture's explanatory paragraph StaticText (which mentions "#drag-source" literally) instead of the draggable div, so the drag ran between two paragraph text nodes and no DnD events fired. Fixed with exact-accessible-name-first matching (two-pass) in `flow-runner.js`; [49b] removed from `KNOWN_PERMANENT`; upstream chrome-devtools-mcp #2182 closure confirmed correct. Harness gate: **662/664** (2 permanent MCP-limited failures: [67b]/[68b] DevTools Issues panel). **[67b]/[68b] root-cause fix** (v9.7.2, 2026-06-11) — also Argus bugs, not MCP limits: the MCP returns issues as markdown text (`msgid=N [issue] text`) but `normalizeArray()` returns `[]` for strings, so every issue was silently discarded (production Issues detection was dead, not just the harness blocks). Fixed with `parseConsoleMsgResponse()` in `issues-analyzer.js` + `orchestrator.js`; `issues-deprecated.html` fixture switched to an `unload` listener (Mutation Events were removed in Chrome 127 and emit nothing; same-value `document.domain` is a no-op). `KNOWN_PERMANENT` is now empty. Harness gate: **664/664 — no permanent failures**. **MIT items** (v9.7.3, 2026-06-11) — `noise-filter.js` (intelligent baseline filtering: cross-run flip-flop classifier over `<branch>-history.json`, downgrade-to-info never suppress) + `root-cause-linker.js` (git log → slug-matched suspect files/commits on new findings); both wired into `report-processor.js` behind `ARGUS_NOISE_FILTER` / `ARGUS_ROOT_CAUSE` env gates; blocks [140] (7 assertions) + [141] (8 assertions). Harness gate: 679/679. **Pre-E2E audit** (v9.7.4, 2026-06-12) — three more wire-contract bugs fixed (get_network_request `reqid` param, list_pages markdown parsing for `open_tabs`, select_page numeric pageId coercion) plus mcp-server logger/version fixes; block [142] (9 assertions [142a]–[142i]). Harness gate: **688/688**. **Harness Max Phase 1 — contract armor** (2026-06-13; test-harness + `browser.js`/`mcp-client.js` only, released in v9.7.6) — block [143] CdpBrowserAdapter wire-contract conformance (28 hard + 5 soft + meta [143zz]; found+fixed 4 dead wire features: `handle_dialog` `{action}`, `wait_for` `text:[]` + `#waitForNetworkIdle`, mcp-client `take_screenshot` image-item scan, `emulateReducedMotion` throws-on-unsupported); block [144] MCP tool error-path matrix (16 [144a]–[144p]: structured `{error}` + `isError` + server-survives + no masked `"is not defined"`; pins the `navigate()` throw-on-failure + the v9.7.4 logger-import regressions); block [145] multi-tab end-to-end (6 [145a]–[145f]). +50 hard assertions. Harness gate: **738/738**. **Post-Phase-1 cleanup** (2026-06-13) — removed dead+redundant `checkPerformanceBudgets` (orchestrator.js) plus the superseded perf-budget harness block [11] + `measurePerf` + 3 fixtures (`perf-issues`/`perf-lcp`/`perf-fid.html`) + 2 dead server endpoints; Core Web Vitals are covered by the web-vitals analyzer (block [129]), `perf-cls.html` retained for block [92], block id [11] retired ([10]→[12] gap). No hard assertions changed. **Harness Max Phase 2 — assertion quality** (2026-06-13/14; test-harness + contracts only, released in v9.7.6) — 2.1 vacuous-assertion sweep (upgraded [119c] `open_tabs` in place); block [146] anti-vacuous self-lint (5: the harness reads its own source and forbids new bare `Array.isArray` / `typeof x==='object'` / `.length>=0` assertions, gated against reviewed allowlists with positive controls); block [147] golden response schemas for all 9 MCP tools (`test-harness/contracts/mcp-tool-schemas.js`; 14: live safeParse ×8 + `argus_pr_validate` source cross-check + coverage ratchet + 3 negative controls + completion guard) — shook out + fixed the `argus_compare` two-mode contract via a discriminated union; +19 hard. **Harness Max Phase 3.1 — upstream canary** (2026-06-14; test-harness + contracts only, released in v9.7.6) — block [148] (5 [148a]–[148e]): a freshly spawned chrome-devtools-mcp@1.1.1 `tools/list` is diffed (tool set + required params + property names/types) against the golden snapshot `contracts/chrome-devtools-mcp@1.1.1.json`, catching the next `reqid→requestId`-class param rename at a version bump; pin↔snapshot-filename lockstep; plus a Chrome-rot watch that `issues-deprecated.html` still emits a DeprecationIssue in the live Chrome; +5 hard. **block [149] per-category negative controls (70 hard — real pipeline vs `negative-controls.html`, zero over-fire across 65 categories) + block [150] verification-gap closure (13 hard — positive fixtures for the previously-untriggered `focus_lost` / `security_no_https` / `cors_violation` / `cookie_attribute_missing`; the last two fixed a real `issues-analyzer.js` classifier gap where Chrome 149's CORS/cookie Issue titles fell through to `unclassified_devtools_issue`). 149 blocks · 63 fixtures · 845/845.** **Harness Max Phase 4.1 — coverage gate** (2026-06-15; test/CI/config only, no harness-block change) — `scripts/coverage-gate.mjs` merges the unit half (Vitest v8) + the harness half (c8 over `npm run test:harness`, in-process src/) and gates `--min-lines 60` (observed merged 75.0% lines) + an `--allow-uncovered` zero-coverage-module guard; the 2 audit-flagged untested modules (`screen-recorder`, `pdf-exporter`) are now unit-tested (unit suite **61→72 tests, 6→8 files**); `harness-ci.yml` runs the harness once under c8 + unit-under-coverage + a `coverage:gate` step. **Harness Max Phase 4.2 — parser fuzzing** (2026-06-15; test/unit only) — `test/unit/parser-fuzz.test.js` (fast-check, Chrome-free; 22 property tests over the wire/parser fns, each encoding the function's real source contract) takes the unit suite to **94 tests / 9 files**. **Harness Max Phase 4.3 — headful soft-assertion lane** (test-harness + CI only, no src change) — `ARGUS_HARNESS_STRICT_SOFT` in `validate.js` promotes every `soft()` to a counted hard assertion (the ~23 Lighthouse / perf-trace / heap-growth checks that return null or skip in headless); the default per-PR run leaves `soft()` un-promoted so the **845-gate is unchanged**. New weekly workflow `.github/workflows/harness-strict.yml` runs the harness **headless** with the flag so those soft checks move (initially designed with Xvfb + non-headless Chrome, but that broke rendering on the runner; the lighthouse_audit fix made Lighthouse work headless, so the lane is headless) from "never verified" to "verified weekly". Wiring proof (headless): flag on → 868 (845 + 23 promoted), flag off → 845. **Lighthouse audit fix** (4.3 follow-up — `browser.js` + `lighthouse-checker.js` + harness, released in v9.7.6): `lighthouse_audit` was being called with an unsupported `url`/`categories` arg (rejected by chrome-devtools-mcp@1.1.1), so **Lighthouse had never run in Argus** (production `checkLighthouse` always caught + skipped). Fixed (navigate-first, drop url/categories, new `parseLighthouseReport()` reads the response's report.json); Lighthouse now returns real scores in headless (a11y-critical 23, a11y-warning 86, SEO 73, best-practices 100). A previously-dead field-shape assertion now fires → **gate 845 → 846**; strict-soft lane now **869/869** (846 + 23 promoted, all green). **PR Validator Phase A** (2026-06-18, pending release — `github-reporter.js` wired into the PR-validate path via one shared helper `reportPrValidation`: idempotent marker-tagged PR comment (block [151], 7), GitHub Check Run whose conclusion maps to the block decision (block [152], 6), file:line GitHub-Actions annotations from diff hunks (`firstAddedLine`/`resolveAnnotationTarget`, [137p–r], 3), `argus_pr_validate` reports through the SAME helper + returns a `reporting` field (block [153], 3), and `fetchPrFiles` surfaces `{filename,status,patch}` (E1, [137l–o], 4) — all GitHub I/O best-effort + token-never-leaked, mutation-pinned; unit suite 94→140). Harness gate: **869/869**. **PR Validator Phase B** (2026-06-18, pending release) — baseline-aware blocking: `src/utils/pr-baseline.js` `decidePrBlock` (the shared, safety-critical merge-block decision both PR-validate paths call) gates on findings the PR INTRODUCES vs a stored per-branch baseline (`reports/baselines/<GITHUB_BASE_REF>.json`, restored via actions/cache), via `diffRoutesAgainstBaseline` (new/persisting/resolved over `findingKey`, path-keyed); fail-safe to absolute blocking + a stated note when no baseline (block [154], 7 [154a–g]); `tagFindingNovelty` tags each finding `isNew` and the PR comment + step summary surface NEW/PERSISTING/RESOLVED counts that reconcile with the decision (block [155], 5 [155a–e]); mutation-pinned both directions; unit suite 140→162 (new `pr-baseline.test.js`). Harness gate: **881/881**. **PR Validator Phase C** (2026-06-19, pending release) — route-mapping accuracy, opt-in via `ARGUS_SOURCE_DIR`, conservative-fallback on every ambiguity (never miss a regression, mutation-pinned): **C1** NEW `src/utils/import-graph.js` (static ES/CJS import graph) + `route-discoverer.js` `discoverNextJsRouteFiles` + `pr-diff-analyzer.js` `mapFilesToRoutesDeep` — a changed component maps to only the routes whose pages import it (block [156], 11 [156a–k]); **C2** `packageRelativePath`/`stripWorkspacePrefix` re-base monorepo `apps/web/…` paths into the package graph, foreign packages never misattributed (block [157], 8 [157a–h]); **C3** `import-graph.js` tracks CSS/SCSS/Sass/Less as leaf nodes so a changed non-global stylesheet narrows to only its importing routes while a global stylesheet keeps the conservative all-routes classification (block [158], 7 [158a–g]); new fixtures `import-graph-fixture/` (C1/C3) + `import-graph-monorepo-fixture/` (C2); unit suite 162→207 (new `import-graph.test.js`). Harness gate: **907/907**. **PR Validator Phase D** (2026-06-20/21, pending release) — depth & performance, every item opt-in + default byte-identical, none touching the block-decision direction: **D1** NEW `parallel-crawler.js` `mapWithConcurrency` (INPUT-order results regardless of completion — the safety property) + `auditRoutesConcurrently` (one Chrome client per lane), both PR-validate loops gated by `ARGUS_CONCURRENCY` (clamped 1–10, default 1) — block [159] (5 [159a–e]); **D2** NEW `src/utils/audit-depth.js` (`resolveAuditDepth` fail-safe→cheap / `selectAnalyzers` file-type-aware / drift-guarded `ALL_EXPENSIVE_ANALYZERS` / `runDepthAnalyzers`) + `crawlRouteWithDepth`, opt-in `ARGUS_PR_AUDIT_DEPTH` — block [160] (9 [160a–i]); **D3** NEW `src/utils/deploy-preview.js` `resolveTargetUrl` (explicit → env preview → opt-in `ARGUS_PREVIEW_DETECT` GitHub-Deployments probe adopting only the most-recent SUCCESS `environment_url` → `TARGET_DEV_URL`) — block [161] (5 [161a–e]); **D4** `parallel-crawler.js` `withTimeout`/`auditRouteWithRetry`/`routeResilienceFromEnv` bound each route audit (`ARGUS_ROUTE_TIMEOUT_MS` default 120000, `ARGUS_ROUTE_RETRIES` default 0) — a timed-out audit REJECTS → route error → exported `allRoutesFailed` guard (never a false-PASS, mutation-pinned both directions) — block [162] (5 [162a–e]); `action.yml` gains `route-timeout`/`route-retries` inputs; unit suite 207→297 (new `parallel-crawler.test.js` + `audit-depth.test.js` + `deploy-preview.test.js` + `route-timeout.test.js`). Harness gate: **931/931**. **PR Validator Phase E** (2026-06-21/22, pending release) — robustness / contract armor: **E2** NEW `src/utils/github-api.js` — ONE resilient `githubFetch` both GitHub throw-path callers (`fetchPrFiles` + `ghFetch`) route through (rate-limit 403-primary/secondary + 429 + transient 5xx + network retried with capped backoff; 401/404/422/plain-403 terminal; `scrubSecrets` redacts any token before it reaches a `::error::` annotation) — block [163] (5 [163a–e]); **E3** the merge gate exhaustively pinned — block-on (none/warning/critical) × {0,info,warning,critical} + all-routes-failed guard + base-unavailable fail-safe + decision→exit-code via NEW exported `prExitCode` — block [164] (7 [164a–g]); **E4** CLI↔MCP block-decision parity — the route-source divergence stays intentional + documented in both files, but the block decision is SHARED (both build the `decidePrBlock` `summary` via the shared `severityTally` and delegate the gate to `decidePrBlock`, neither re-implements the matrix), so the two paths reach the IDENTICAL decision for the same findings — block [165] (4 [165a–d]); unit suite 297→340 (new `github-api.test.js`). Harness gate: **947/947**. **PR Validator Phase F** (2026-06-24/25, pending release — test maximization, hermetic + network-free): **F1** new fixture `contracts/github-reporting-samples.js` (faithful documented-schema responses for all six reporting endpoints + `makeReportingFetchStub`) — block [166] (4 [166a–d]) proves Argus PARSES the documented reporting *response* shape (idempotent marker-discriminated comment update, Check Run create→complete, zero token leak); **F2** the FIRST block to drive the real CLI `src/cli/pr-validate.js` AS A CHILD PROCESS end-to-end against the live fixture server + an injected PR file list — block [167] (8 [167a–h]: docs-only PR → exit 0 hermetic; `blank_page`-critical PR → exit 1; pins exit codes / `$GITHUB_OUTPUT` / step-summary banners / both `::error` streams / printed JSON, all tokenless; one small src seam — `fetchPrFiles` honours `GITHUB_API_URL`, default byte-identical, GHES-useful); **F3** unit + mutation coverage — direct Chrome-free unit tests for the nine PR-Validator fns that were harness-only (CLI helpers + github-reporter I/O) + re-verified B1/E3/D4 by mutation (unit suite 340→366, 18 files, no harness change); **F4** `argus_pr_validate` golden schema — the A4 `reporting` + B1/B2 `baseline` rider fields are now EXPLICITLY pinned `.optional()` shapes in `contracts/mcp-tool-schemas.js` ([147i] filters optional keys; non-vacuous negative controls [147o]/[147p]). +14 hard (F1 +4, F2 +8, F4 +2). Harness gate: **961/961** — Phase F + PR_VALIDATOR_MAX_PLAN complete. **Released v9.8.0** — the full PR Validator src batch (Phases A–E + F2's `GITHUB_API_URL` seam) and the HTML-report brand restyle shipped in **v9.8.0**: `package.json` / `package-lock.json` / `server.json` bumped 9.7.6 → 9.8.0, published to npm (`argusqa-os@9.8.0`), and the `action.yml` pin updated to 9.8.0.

<br/>

[![Node.js](https://skillicons.dev/icons?i=nodejs)](https://nodejs.org)
[![JavaScript](https://skillicons.dev/icons?i=js)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![HTML](https://skillicons.dev/icons?i=html)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS](https://skillicons.dev/icons?i=css)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![Chrome](https://skillicons.dev/icons?i=chrome)](https://www.google.com/chrome/)
[![GitHub Actions](https://skillicons.dev/icons?i=githubactions)](https://github.com/features/actions)

---

## What It Tests

166 test blocks · 961 hard assertions · 67 detection categories (3 environment-limited, negative-control-only) · 63 fixture pages

> **Coverage note**: 67 detection categories exist in production code. Every category is positively exercised by a firing fixture (blocks [1]–[93] + [127]–[139] + [150]) **except 3 environment-limited Chrome-Issues detectors** (`mixed_content` needs HTTPS, `low_contrast_native` is DevTools-audit-only, `permission_policy_violation` needs a secure context), which can't be triggered in headless localhost http and are covered only as [149] negative controls. Blocks [94]–[126] cover infrastructure contracts (module APIs, MCP transport, unhappy paths, CLI E2E). Block [127] A7 Theme & Dark Mode; block [128] D9 Design Fidelity (30 assertions [128a]–[128ad], 13 mismatch finding types); block [129] Web Vitals (LCP/CLS/FCP/TTI/TTFB + bundle size); block [130] A8 Visual Regression (pixelmatch baseline comparison); block [131] A12 Deep Accessibility (axe-core 4.12 + CVD color blind simulation); block [132] N1 HAR Network Baseline; block [133] A9 Motion & Animation; block [134] A10 Font Loading; block [135] A11 Form Validation; block [136] GitHub Check Runs (createCheckRun/completeCheckRun + generateReleaseNotes); block [137] PR Diff Analyzer (parsePrUrl / mapFilesToRoutes / argus_pr_validate); block [138] GitHub Action CLI (buildStepSummary / writeGithubOutputs / pr-validate.js); block [139] Chrome launcher / doctor / advanced security (findChrome / checkChrome / checkMcpConfig / checkEnvKeys / checkSourceMapExposure / checkOpenRedirects); block [140] noise filter; block [141] root cause linker; block [142] MCP wire-contract regressions (parseListPagesResponse / extractResponseBody / mcp-server hygiene); block [143] CdpBrowserAdapter wire-contract conformance (content assertion per adapter method + `prototype` coverage ratchet); block [144] MCP tool error-path matrix (structured `{error}` + `isError` + server-survives + no masked ReferenceError, all 9 tools); block [145] multi-tab end-to-end (`new_page` / `argus_get_context.open_tabs` / `selectPage` page-switch / `close_page`); block [146] anti-vacuous self-lint (the harness reads its own source and forbids new bare shape-only assertions outside reviewed allowlists); block [147] golden response schemas (every MCP tool response `safeParse`d against a Zod contract in `contracts/mcp-tool-schemas.js`, plus a tool→schema coverage ratchet and anti-vacuous negative controls); block [148] upstream canary (a freshly spawned chrome-devtools-mcp@1.1.1 `tools/list` diffed — tool set + required params + property names/types — against the golden `contracts/chrome-devtools-mcp@1.1.1.json` snapshot, plus a Chrome-rot watch that `issues-deprecated.html` still emits a DeprecationIssue in the live Chrome); block [149] per-category negative controls (the real production pipeline run against `negative-controls.html` asserts zero over-fire across 65 detection categories); block [150] verification-gap closure (positive firing fixtures for `focus_lost`, `security_no_https`, `cors_violation` and `cookie_attribute_missing` — the last two fixing a real Chrome-149 Issue-title classifier gap in `issues-analyzer.js`); block [151] PR-validate idempotent PR comment, block [152] PR-validate GitHub Check Run conclusion, block [153] PR-validate MCP reporting parity (the `argus_pr_validate` MCP tool reports through the same shared helper as the CLI); block [154] PR-validate baseline-aware blocking (blocks on the findings a PR *introduces* vs a stored per-branch baseline, fail-safe to absolute blocking when none); block [155] PR-validate new/persisting/resolved comment (the PR comment + step summary surface the baseline diff counts, reconciling with the block decision); block [156] PR-validate framework-aware route mapping (C1 — `mapFilesToRoutesDeep` + `import-graph.js`: a changed component maps to only the routes whose pages import it, opt-in via `ARGUS_SOURCE_DIR`, conservative-fallback on any ambiguity); block [157] PR-validate monorepo path awareness (C2 — `packageRelativePath`/`stripWorkspacePrefix` re-base `apps/web/…` paths into the package graph; foreign packages never misattributed); block [158] PR-validate stylesheet attribution (C3 — `import-graph.js` tracks CSS/SCSS/Sass/Less leaves so a changed non-global stylesheet narrows to only its importing routes, while a global stylesheet keeps the conservative all-routes classification); block [159] PR-validate bounded-concurrency route auditing (D1 — `mapWithConcurrency` returns results in INPUT order regardless of completion + `auditRoutesConcurrently` gives each lane its own Chrome client, gated by `ARGUS_CONCURRENCY`, default 1 = sequential); block [160] PR-validate selective analyzer depth (D2 — `resolveAuditDepth`/`selectAnalyzers` file-type-aware depth policy + drift-guarded registry catalog, opt-in `ARGUS_PR_AUDIT_DEPTH`, default cheap); block [161] PR-validate deploy-preview URL auto-detection (D3 — `resolveTargetUrl` adopts only a most-recent SUCCESS GitHub-Deployment preview, degrading gracefully to `TARGET_DEV_URL`); block [162] PR-validate per-route timeout/retry (D4 — `withTimeout` rejects a hung audit, `auditRouteWithRetry` retries then fails loud, and the exported `allRoutesFailed` guard blocks when every route errored — a timed-out audit can never false-PASS). The 3 remaining environment-limited Issues sub-types and other historical notes are tracked in [argus-v6-strategy.md §10](../argus-v6-strategy.md).

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
| 79 | _(pure function — no fixture page)_ | Zod config validation — valid config passes · route missing `path` throws · path without leading `/` throws · non-number threshold throws (v9 Milestone 3) | Hard |
| 80 | _(file-read — no fixture page)_ | Argus MCP server registration — `src/mcp-server.js` exists · contains `argus_audit` · contains `argus_compare` · contains `argus_audit_full` · contains `argus_last_report` · contains `argus_watch_snapshot` · contains `argus_get_context` · `.mcp.json` has `"argus"` entry (v9 Milestone 6 + Milestone 9/10) | Hard |
| 81 | _(pure function — no fixture page)_ | `createFinding()` factory — correct field values · throws on missing type · throws on invalid severity · returns frozen object (v9 Milestone 5) | Hard |
| 82 | _(pure function — no fixture page)_ | `withRetry()` exponential backoff — fn called once on success · retries on transient failure · rethrows after all attempts · `ARGUS_RETRY_ATTEMPTS=1` disables retries (v9 Milestone 5) | Hard |
| 83 | _(file-read — no fixture page)_ | Watch mode dashboard — `src/orchestration/watch-mode.js` exists · `DASHBOARD_HTML` constant present · `startDashboard` exported · `/data` endpoint string present · `ARGUS_WATCH_UI_PORT` env var referenced · `WatchSession` and `runWatchMode` still exported (v9 Milestone 9) | Hard |
| 84 | _(pure function — no fixture page)_ | `cli/init.js` smoke test — `src/cli/init.js` exists · `detectFramework` exported · `generateTargetsJs` exported · `generateEnvFile` exported · `detectFramework('/nonexistent')` → `'unknown'` · `generateTargetsJs` returns non-empty string with route path · `generateEnvFile` returns non-empty string with supplied `devUrl` (v9 Milestone 10) | Hard |
| 85 | `network-errors.html` (×2) | Production 401/403 severity (GAP-022 / GAP-009) — `crawlRouteCheap` with `critical:true` → 401 + 403 are `critical`; `critical:false` → 401 + 403 are `warning` (Tier 3) | Hard |
| 86 | `js-errors-critical.html` + `js-errors.html` | Production console.error severity (GAP-023) — `crawlRouteCheap` with `critical:true` → errors are `critical`; `critical:false` → errors are `warning` (Tier 3) | Hard |
| 87 | `waitfor-timeout.html` | Production load_failure (GAP-024) — `crawlRouteCheap` with `waitFor:'#never-appears'` → `load_failure` warning emitted; message names missing selector (Tier 3) | Hard |
| 88 | `api-frequency.html` | Production api_call_summary (GAP-025) — `crawlRouteCheap` → `api_call_summary` present · `data-loop` duplicate call is `critical` · `uniqueEndpoints` is a number (Tier 3) | Hard |
| 89 | `seo-issues.html` | Production seo_missing_description (GAP-028) — `crawlRouteCheap` → `seo_missing_description` warning with non-empty message (Tier 3) | Hard |
| 90 | `css-issues.html` | Production SCSS sourceMappingURL (GAP-027) — `crawlRouteCheap` → `css_summary.scssSourceFiles` is a non-empty array (Tier 3) | Hard |
| 91 | `css-issues.html` | Production CSS cascade (non-`!important`) (GAP-026) — `crawlRouteCheap` → `css_override` with `hasImportant:false` → `info` severity · has `property` field (Tier 3) | Hard |
| 92 | `perf-cls.html` | Lighthouse contract via `checkLighthouse` (GAP-029) — always returns array · violations have `type`/`severity`/`message`/`url` shape · soft (headless N/A expected in CI) (Tier 3) | Soft |
| 93 | _(pure function — no fixture page)_ | diff.js utilities (GAP-030) — `diffNetworkRequests` detects added/removed/changed endpoints · `diffConsoleMessages` detects new errors in staging vs dev (Tier 3) | Hard |
| 94 | _(pure function — no fixture page)_ | `mcp-parsers.js` contracts — `parseConsoleMsgResponse` null/empty guard · msgid/level/text parsing · `[warn]`→`"warning"` normalisation · `parseNetworkReqResponse` null guard · requestId/method/url/status fields | Hard |
| 95 | _(pure function — no fixture page)_ | `registry.js` — `clearAll()` resets state · `registerExpensive` adds analyzer · `getExpensive()` returns registered analyzer · `getCheap()` returns empty (cheap analyzers are hard-wired, not registry-driven) | Hard |
| 96 | _(pure function — no fixture page)_ | `report-processor.js` — `deduplicateFindings` collapses identical keys · `rebuildSummary` counts by severity · both return correct shape | Hard |
| 97 | _(pure function — no fixture page)_ | `config/targets.js` — `thresholds` export present · `slowApiWarningMs`/`slowApiCriticalMs`/`largePayloadWarningBytes`/`largePayloadCriticalBytes` are positive numbers | Hard |
| 98 | _(pure function — no fixture page)_ | `slug.js` — `slugify` handles empty string · spaces → hyphens · special chars stripped · lowercase enforced | Hard |
| 99 | _(pure function — no fixture page)_ | `telemetry.js` — `startSpan` returns a context object · `recordFinding`/`recordFlaky`/`recordNewFindings` are callable without error · no-op when no OTEL endpoint set | Hard |
| 100 | _(pure function — no fixture page)_ | `logger.js` — `childLogger(module)` returns a Pino child logger · exposes `info`/`warn`/`error`/`debug` methods | Hard |
| 101 | _(file-read — no fixture page)_ | `argus.js` + `batch-runner.js` barrel validation — both files exist · `argus.js` re-exports `runSinglePageAudit` · `batch-runner.js` re-exports `runBatchAudit` | Hard |
| 102 | _(pure function — no fixture page)_ | `mcp-client.js` `unwrapEval` — text/content array shape · `type: 'text'` extraction · `type: 'image'` extraction · null/missing response guard | Hard |
| 103 | _(pure function — no fixture page)_ | `server/slash-command-handler.js` `verifySlackSignature` — valid HMAC passes · wrong signature fails · missing timestamp fails · replay attack (stale timestamp) fails | Hard |
| 104 | _(pure function — no fixture page)_ | `server/interaction-handler.js` `handleInteraction` — unknown type returns 400 · retest action triggers audit and replies · acknowledge action replies with 200 | Hard |
| 105 | _(pure function — no fixture page)_ | `slack-notifier.js` exports — `buildBlocks` returns an array · `buildDigest` returns non-empty string · both callable without a valid Slack token | Hard |
| 106 | _(file I/O — temp dir)_ | `report-processor.js` `processReport` integration — writes `report.json` to disk · JSON is parseable · `summary` and `findings` keys present · baseline file created on first run | Hard |
| 107 | _(pure function — no fixture page)_ | `dispatcher.js` `dispatchAll` — HTML report generated when no Slack token · `report.html` written to output dir · no throw on missing Slack config | Hard |
| 108 | _(pure function — no fixture page)_ | `session-persistence.js` error paths — `restoreSession` returns `false` on missing file · `hasSession` returns `false` on expired/stale session · `clearSession` is idempotent on missing file | Hard |
| 109 | _(pure function — no fixture page)_ | `baseline-manager.js` `getCurrentBranch` — returns non-empty string · uses `ARGUS_BRANCH` env var override when set · `loadBaseline(null)` returns null without throwing | Hard |
| 110 | _(pure function — no fixture page)_ | `schema.js` Zod error messages — missing `path` field error mentions "path" · non-number threshold error mentions "Expected number" · invalid route shape reports field name | Hard |
| 111 | _(pure function — no fixture page)_ | `github-reporter.js` — `isGitHubConfigured()` false without env vars · `formatPrComment` caps table at `MAX_TABLE_ROWS` when finding list is large · truncation note present in output | Hard |
| 112 | _(pure function — no fixture page)_ | `html-reporter.js` scale test — `generateHtmlReport` handles 1000+ findings without throwing · output contains `<!DOCTYPE html>` · findings count present in output | Hard |
| 113 | _(pure function — no fixture page)_ | `diff.js` URL normalisation — query strings stripped before comparison · same endpoint with different query params treated as same URL · protocol differences handled | Hard |
| 114 | _(file-read — no fixture page)_ | `mcp-server.js` LRU cache — `MAX_CACHE_ENTRIES` constant (20) present in source · `auditCache` Map defined · LRU eviction logic present · `snapshotStore` Map defined | Hard |
| 115 | _(pure function — no fixture page)_ | `flow-runner.js` `press_key` step — `press_key` action registered (no `flow_step_failed`) · `resolveUidForSelector` returns a uid string when given a valid CSS selector | Hard |
| 116 | _(file-read — no fixture page)_ | Watch mode `/data` endpoint — `startDashboard` exported · HTTP `/data` endpoint string present in `watch-mode.js` · `ARGUS_WATCH_UI_PORT` env var referenced | Hard |
| 117 | _(MCP stdio transport)_ | MCP stdio initialize handshake — `mcp-client.js` JSON-RPC `initialize` → `result.protocolVersion` present · `tools/list` → `result.tools` is an array with at least 6 entries | Hard |
| 118 | _(MCP tool invocation)_ | `argus_last_report` no-report graceful error — calling when `./reports` is absent returns `{ error: ... }` JSON without throwing · error message is non-empty string | Hard |
| 119 | _(MCP tool invocation)_ | `argus_get_context` fix-loop protocol — response contains `snapshot_id` field · `new_issues`/`resolved`/`persisting` diff arrays present · `open_tabs` field is an array | Hard |
| 120 | _(MCP tool invocation)_ | `argus_watch_snapshot` contract — response contains `findings` array · `newConsole` and `newNetwork` fields present · each finding has `type`/`severity`/`message` | Hard |
| 121 | _(runtime — no fixture page)_ | `server/index.js` Express startup — server starts on `PORT` env var · `/health` endpoint returns HTTP 200 · response body contains `"ok"` | Hard |
| 122 | _(file I/O — temp dir)_ | `html-reporter.js` CLI `report:html` path — `generateHtmlReport` writes file to specified output path · file exists after write · HTML contains `<!DOCTYPE html>` | Hard |
| 123 | _(unhappy path — no fixture page)_ | `crawlRouteCheap` navigate error propagation — when `navigate_page` throws, `crawlRouteCheap` propagates the error (Chrome-down / page-crash scenario) | Hard |
| 124 | _(unhappy path — no fixture page)_ | `crawlRouteCheap` screenshot failure resilience — when `take_screenshot` throws, crawl continues to completion · `result.screenshot` is null · `result.errors` is still a valid array · `result.crawledAt` is present | Hard |
| 125 | _(unhappy path — no fixture page)_ | `parseConsoleMsgResponse` 12,000-message overflow stress test — does not throw · returns all 12,000 messages · completes in < 5 s | Hard |
| 126 | _(E2E file write — temp dir)_ | `cli/init.js` end-to-end file write — `generateTargetsJs` + `generateEnvFile` write to temp disk · `targets.js` exists and contains route path `/home` · `.env` exists and contains `TARGET_DEV_URL` · `targets.js` contains `export const routes` | Hard |
| 127 | `theme-issues.html` | A7 Theme & Dark Mode — `analyzeTheme` returns array · `theme_no_dark_mode` info finding present · severity is info · message is non-empty string · `theme_summary` finding present · `hasDarkMode` is false · `rootVarCount` > 0 | Hard |
| 129 | `perf-vitals.html` | Web Vitals — `analyzeWebVitals` returns array · `perf_vitals_summary` present · summary has lcp/cls/fcp/tti/ttfb fields · severity info · `perf_bundle_large` detected (~600KB JS) · severity warning/critical · sizeKb > 500 · (soft) LCP as number · (soft) TTI positive | Hard+Soft |
| 128 | `design-fidelity.html` | D9 Design Fidelity (30 assertions [128a]–[128ad]) — token/component/parseFigmaUrl · color/typography/spacing/radius/shadow/stroke/opacity/gap/text mismatches · shadow includes spread+colorDelta fields · per-corner radius with corner field · selector fallback via data-testid · position drift detected (drift-box margin-left:80px vs Figma x:0) · summary includes all 13 mismatch-type counts | Hard |

---

## Directory Layout

```
test-harness/
├── README.md               ← you are here
├── server.js               ← Express fixture server (port 3100 dev / 3101 staging)
├── harness-config.js       ← route definitions + expected findings
├── validate.js             ← test runner — starts servers, connects Chrome, asserts
├── .env.harness            ← ARGUS_LOG_LEVEL=warn — auto-loaded by npm run test:harness to suppress INFO flood
├── run-with-log.mjs        ← tee wrapper used by npm run test:harness:log — streams live + saves to harness-results.txt
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
│   ├── perf-cls.html               test 92 — checkLighthouse soft-contract fixture
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
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"
```

**Windows (Command Prompt)**
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
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

INFO-level Pino logs are automatically suppressed via `test-harness/.env.harness` (`ARGUS_LOG_LEVEL=warn`) to prevent terminal scrollback overflow. To save the full output to `harness-results.txt` at the repo root, use the tee wrapper instead:

```bash
npm run test:harness:log
```

The validator will:
1. Start the dev fixture server on `http://localhost:3100`
2. Start the staging fixture server on `http://localhost:3101`
3. Connect to Chrome via the DevTools MCP client
4. Navigate to each fixture page and collect detections
5. Print pass / fail for each assertion
6. Shut down both fixture servers and exit

**Expected output (961/961 — no permanent failures, exit code 0):**

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
Results: 961/961 hard assertions passed, 0 failed

✅ All hard assertions passed.
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
| `http://localhost:3100/perf-cls.html` | Layout shift 200 ms after load (block [92] Lighthouse fixture) |
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

`lighthouse_audit` now runs in headless (after the argument fix — navigate-first, no `url`). `performance_start_trace` and GC-dependent heap-growth can still be environment-sensitive. These checks are soft in the default run and promoted to hard in the weekly strict-soft lane (`harness-strict.yml`); soft skips do not indicate a bug in Argus.
