# Argus — Session Resumption File

> Update this file at the END of every session. The next session starts by reading this file.

---

## Last Session: 2026-05-30 (Session 40)

### What Was Accomplished

**v9.4.1 — Post-Sprint-10 gap-audit patch. All 3 identified gaps fixed and published.**

| Change | Detail |
|--------|--------|
| **handleAudit API contract fix** | `crawlRouteCheap` raw output (`{ route, url, errors, ... }`) was being returned as-is; now transformed to documented `{ findings, summary: { critical, warning, info }, url, pageTitle, screenshot }` shape. Cache stores and returns the shaped result. |
| **CI Chrome retry loop** | `.github/workflows/harness-ci.yml` `sleep 3 + single curl` replaced with a 15-attempt retry loop (1 s each); exits 1 if Chrome never starts — eliminates CI timing-variance failures. |
| **Version bump** | 9.4.0 → 9.4.1 across `package.json`, `server.json`, `src/mcp-server.js` |
| **Roadmap stats fixed** | `argus-vX1-roadmap.md` (gitignored): version table `82/4 tools/9.2.0` → `84/6 tools/v9.4.1`; Sprint 2 Figma block `[83]` → `[85]`; harness impact table `82/348/4` → `84/367/6`; OG card stats `54/82/348` → `54/84/367` |
| **Published** | `argusqa-os@9.4.1` → npm + MCP Registry (`io.github.ironclawdevs27/argus@9.4.1`) |

#### Files Changed

| File | Change |
|------|--------|
| `src/mcp-server.js` | `handleAudit`: transform `crawlRouteCheap` output to `{ findings, summary }`; version → 9.4.1 |
| `.github/workflows/harness-ci.yml` | Chrome startup: 15-attempt retry loop replaces fragile `sleep 3 + curl` |
| `package.json` | Version → 9.4.1 |
| `server.json` | Version → 9.4.1 |
| `CLAUDE.md` | validate.js description 82→84 block; harness run comment 345/348→364/367; version 9.4.0→9.4.1 |
| `solution.md` | Status header → v9.4.1; validate.js description 82→84; OG stats 54/82/348→54/84/367; harness comments 345/348→364/367; assertions 348→367 |
| `SKILL.md` | npm publication 9.4.0→9.4.1 |
| `test-harness/README.md` | Sprint history: 9.4.1 patch note added |
| `session.md` | Session 40 added |

#### Next Steps

1. vX1 Sprint 1: Dark Mode & Theme Testing (`theme-analyzer.js`)

---

## Last Session: 2026-05-30 (Session 39)

### What Was Accomplished

**v9.4.0 — Multi-tab watch mode, audit caching, CI harness gate, glama.json, block [84].**

| Change | Detail |
|--------|--------|
| **Multi-tab watch mode** | `tabId` param on `argus_watch_snapshot` + `argus_get_context`; `CdpBrowserAdapter.listPages()` + `.selectPage(tabId)`; `open_tabs` array in `argus_get_context` response — lists all open Chrome tabs with id/url/title |
| **Audit caching** | `cache: true` on `argus_audit`; `auditCache` Map (max 20, LRU); cached result includes `_cached: true` + `_cachedAt` ISO timestamp |
| **CI harness gate** | `.github/workflows/harness-ci.yml` — runs `npm run test:harness` + `npm run test:unit` on every PR; exits 0 when only the 3 known permanent failures remain |
| **glama.json expanded** | Added `name`, `description`, `tools` (all 6) for Glama listing |
| **Block [84]** | 7 assertions covering `cli/init.js` — `detectFramework`, `generateTargetsJs`, `generateEnvFile` file-read + pure-function tests |
| **Permanent-failure exit logic** | `validate.js` now exits 0 when only `[49b]`, `[67b]`, `[68b]` fail; unexpected failures still exit 1 |
| **Version** | 9.3.1 → 9.4.0 across `package.json`, `server.json`, `src/mcp-server.js` |
| **Stats** | 83 → 84 blocks; 360 → 367 assertions; 357/360 → 364/367 passing |

#### Files Changed

| File | Change |
|------|--------|
| `.github/workflows/harness-ci.yml` | New: PR gate running harness + unit tests |
| `glama.json` | Added name, description, tools array (6 tools) |
| `src/adapters/browser.js` | Added `listPages()` + `selectPage(tabId)` |
| `src/mcp-server.js` | `auditCache` + `cacheAudit()`; `cache` param on `argus_audit`; `tabId` on watch tools; `open_tabs` in `argus_get_context` response; `open_tabs` list via `browser.listPages()`; version 9.4.0 |
| `test-harness/validate.js` | Block [84] (7 assertions); permanent-failure exit logic (exit 0 for known [49b]/[67b]/[68b]) |
| `package.json` | Version → 9.4.0 |
| `server.json` | Version → 9.4.0 |
| `README.md` | Stats 83→84 blocks, 360→367 assertions, 357/360→364/367 |
| `CLAUDE.md` | Phases Complete updated; harness 84/367; new features documented |
| `SKILL.md` | Harness stats 84/367; phases complete row updated; expected output 364/367 |
| `solution.md` | Status header → v9.4.0 / 84 blocks / 367 assertions |
| `test-harness/README.md` | Stats 83→84, 360→367, 357/360→364/367; block [84] added to table; Sprint 10 in history |
| `landing/src/App.jsx` | Stats 83→84, 360→367; block [84] mention; harness code snippet updated |
| `landing/README.md` | OG card stats updated |

#### Next Steps

1. Commit + push all changes
2. Publish `argusqa-os@9.4.0` to npm
3. Update MCP Registry: `mcp-publisher login github` → `mcp-publisher publish`
4. vX1 Sprint 1: Dark Mode & Theme Testing (`theme-analyzer.js`)

---

## Last Session: 2026-05-29 (Session 38)

### What Was Accomplished

**Sprint 8 + Sprint 9 both completed in this session. Published as `argusqa-os@9.3.1`.**

---

#### Sprint 8 — Two new MCP tools + watch interval + README restructure (`argusqa-os@9.3.0`)

| Tool | Description |
|------|-------------|
| `argus_watch_snapshot` | One-shot `WatchSession.poll()` — returns raw `{ findings, newConsole, newNetwork }` from current Chrome tab **without navigating**. Use for post-interaction, authenticated, or mid-flow state inspection. |
| `argus_get_context` | Same mechanism but LLM-optimized output with plain-English `summary`. Initial implementation (expanded in Sprint 9). |

`ARGUS_WATCH_INTERVAL_MS` default: `3000` → `1000` ms.

README restructured: One-Time Setup → 3 options (MCP / npm / clone); Running Argus → 4 options with tool tables + tutorials. Landing page setup section updated to match.

---

#### Sprint 9 — Fix loop, watch dashboard, harness [80]+[83] (`argusqa-os@9.3.1`)

**`argus_get_context` fix loop:**
- Returns `snapshot_id` on every call (base-36 timestamp + random suffix, stored in `snapshotStore` Map, max 20 entries LRU)
- Pass `snapshot_id` back → response includes `resolved`, `new_issues`, `persisting` diff arrays
- Context-aware `summary` for all 4 states: all-clear, partial-fix, no-change, clean-no-prev
- Workflow: call `argus_get_context` → Claude suggests fix → apply → call again with `snapshot_id` → verify `resolved` is non-empty

**Watch mode web dashboard:**
- `startDashboard()` in `watch-mode.js` starts HTTP server on port 3002 (`ARGUS_WATCH_UI_PORT`)
- `GET /data` → `{ target, lastPoll, findings }` JSON; `GET /` → `DASHBOARD_HTML` inline template
- Dashboard: dark theme, pulsing dot, severity pills, findings table sorted critical-first, auto-polls every 2 s
- Printed at startup: `[ARGUS WATCH] Dashboard → http://localhost:3002`

**Harness extended:** 82 blocks / 348 assertions → **83 blocks / 360 assertions**
- Block [80] extended: [80g]–[80l] — coverage for `argus_watch_snapshot`, `argus_get_context`, `snapshot_id`, `snapshotStore`, diff fields
- New block [83]: watch dashboard contracts — `DASHBOARD_HTML`, `startDashboard`, `/data` endpoint, `ARGUS_WATCH_UI_PORT`, exports still intact

---

#### Files Changed This Session

| File | Change |
|------|--------|
| `src/mcp-server.js` | Sprint 8: `argus_watch_snapshot` + `argus_get_context`; Sprint 9: `snapshotStore`, fix loop, `snapshot_id`, diff fields; version → 9.3.1 |
| `src/orchestration/watch-mode.js` | Sprint 8: interval 1 s; Sprint 9: `DASHBOARD_HTML`, `startDashboard()`, `ARGUS_WATCH_UI_PORT`, dashboard server in `runWatchMode()` |
| `test-harness/validate.js` | Block [80] extended [80g]–[80l]; new block [83] (6 assertions) |
| `package.json` | Version → 9.3.1 |
| `server.json` | Version → 9.3.1 |
| `README.md` | Stats 82→83 blocks, 348→360 assertions; Watch Mode row + dashboard; harness note updated; landing page setup fixed |
| `landing/src/App.jsx` | MCP setup restructured (both MCPs in step 01, Slack optional step 04); CLI commands table |
| `CLAUDE.md` | Phases Complete updated; harness 360; `ARGUS_WATCH_UI_PORT` env var added |
| `SKILL.md` | Sprint 8 + Sprint 9 sections; harness stats 83/360 |
| `solution.md` | Status header → Sprint 9 / v9.3.1 / 360 assertions |
| `session.md` | This entry |

#### Next Steps

1. Commit + push current changes
2. Publish `argusqa-os@9.3.1` to npm
3. Update MCP Registry: `mcp-publisher login github` → `mcp-publisher publish`
4. Distribution — Show HN, Twitter/X thread, ProductHunt
5. GitHub repo polish — README hero screenshot/GIF, badges

---

## Last Session: 2026-05-27 (Session 37)

### What Was Accomplished

**MCP server published to npm as `argusqa-os@9.2.0`. Package prepared for MCP directory submission (glama.ai/mcp/servers, mcp.so).**

#### MCP Gap Analysis + Fixes Applied

| Gap | File | Fix |
|-----|------|-----|
| Missing shebang | `src/mcp-server.js` | Added `#!/usr/bin/env node` — required for npm `bin` entries to be executable |
| `REPORTS_DIR` breaks for global install | `src/mcp-server.js` | `path.resolve(__dirname, '../reports')` → `path.resolve(process.cwd(), 'reports')` — reports land in user's project dir regardless of install method |
| No `files` field | `package.json` | `["src/", ".mcp.json"]` — excludes test-harness, landing/, scripts/, session docs from publish |
| Version mismatch (`1.0.0` vs `9.2.0`) | `package.json` | Synced to `9.2.0` (aligned with Server constructor) |
| Sparse tool descriptions | `src/mcp-server.js` | `argus_audit_full`: lists all analyzers + output format; `argus_compare`: explains env var config, removes internal `.env / targets.js` reference |
| Missing npm metadata | `package.json` | Added keywords, author, license, homepage, repository |
| Wrong/missing bin entries | `package.json` | Added `argus-mcp` + `argusqa-os` both pointing to `src/mcp-server.js` |
| `.mcp.json` local-only path | `.mcp.json` | Updated to `npx -y argusqa-os` — works for all users post-publish |
| Unused `fileURLToPath` import | `src/mcp-server.js` | Removed after `__dirname` was replaced with `process.cwd()` |

#### npm Publication Details

- Package name: `argusqa-os` (argus + qa + open source; `argus` and `argus-qa` already taken on npm)
- Version: `9.2.0`
- Registry: [npmjs.com/package/argusqa-os](https://www.npmjs.com/package/argusqa-os)
- npm account: `ironclawdevs27`
- Users configure via:
  ```json
  { "mcpServers": { "argus": { "command": "npx", "args": ["-y", "argusqa-os"] } } }
  ```

#### Files Changed This Session

| File | Change |
|------|--------|
| `src/mcp-server.js` | Shebang, `process.cwd()` reports, removed unused import, improved tool descriptions |
| `package.json` | Name → `argusqa-os`, version → `9.2.0`, metadata fields, `files`, bin entries |
| `.mcp.json` | Updated to npx form |
| `CLAUDE.md` | MCP server paragraph updated with npm details |
| `README.md` | MCP Server feature row updated |
| `solution.md` | Header + new Sprint 6 npm publication section |
| `session.md` | This entry |

#### Next Steps

1. Commit current changes
2. Submit to [glama.ai/mcp/servers](https://glama.ai/mcp/servers) → Submit → `argusqa-os`
3. Submit to [mcp.so](https://mcp.so/) → Submit → `argusqa-os`
4. GitHub repo polish — README hero screenshot/GIF, badges, link to argus-qa.com
5. Distribution — Show HN, Twitter/X thread, ProductHunt

---

## Last Session: 2026-05-26 (Session 36)

### What Was Accomplished

**Sprint 0 complete. Landing page fully live at [argus-qa.com](https://argus-qa.com).**

#### Sprint 0 — Mobile & SEO Fixes Applied

| Fix | Detail |
|------|--------|
| Touch targets | All 4 buttons raised to 44×44px (hamburger, mobile close, both modal close buttons) |
| Modal iOS keyboard | Both modal wrappers: `maxHeight: 100dvh` + `overflowY: auto` + `WebkitOverflowScrolling: touch` |
| `prefers-reduced-motion` | `<MotionConfig reducedMotion="user">` wraps entire App — covers all 30+ Framer blocks |
| `@supports (height: 100dvh)` | In `index.css` — iOS Safari hero height fix |
| SEO | `index.html`: full OG tags, `summary_large_image` Twitter card, canonical, JSON-LD, `robots.txt`, `sitemap.xml` |
| Video poster | `Argus_bg.png` → `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` |
| OG social card | `landing/public/og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png`, branded overlay, black-outlined purple stat numbers (54 / 82 / 348), CTA pill; `og-image.jpg` gitignored |
| Mobile stats layout | Stats row stacks on mobile (`flex-col sm:flex-row`) — prevents overlap with slide card at 390px |
| Slides reduction | 8 → 6 slides (removed slides 3 and 8); `clamp()`-based fluid typography on stats and slide text |
| Deployment | `npx wrangler pages deploy dist --project-name argus-qa`; custom domain `argus-qa.com` active |

#### Files Changed This Session

| File | Change |
|------|--------|
| `landing/src/App.jsx` | Mobile stats stacking, slides 8→6, clamp() typography, video poster |
| `landing/index.html` | Full SEO overhaul: OG tags, `summary_large_image` Twitter card, JSON-LD, canonical |
| `landing/public/argus-poster.png` | New — video poster + OG source (1918×1078) |
| `landing/public/og-image-v2.jpg` | New — branded OG social card (1200×630, cover-mode, black-outlined stats) |
| `landing/public/robots.txt` | New |
| `landing/public/sitemap.xml` | New |
| `.gitignore` | Added `Argus_bg.png`, `*.mp4`, `landing/public/og-image.jpg` |
| `CLAUDE.md` | Landing page structure + Phases Complete paragraph updated |
| `landing/README.md` | Sprint 0 table: 3 new rows (OG card, mobile layout, deployment) |
| `README.md` | `landing/public/` listing expanded to all 5 files |
| `argus-vX1-roadmap.md` | Sprint 0 marked complete; OG card, mobile layout, deployment entries added |
| `solution.md` | Header, file structure, Sprint 0 table, deployed-to line updated |
| `session.md` | This entry |

#### OG Image Technical Notes

- Source: `argus-poster.png` (1918×1078 PNG)
- Cover-mode scaling: scale factor = max(1200/1918, 630/1078) = 0.6257; scaled to 1200×674; crop 22px top/bottom
- Stat numbers (54, 82, 348) use `GraphicsPath.AddString` → `DrawPath` (black 3.5px stroke) → `FillPath` (purple) for outline effect
- Generated via PowerShell `System.Drawing` — reproducible

---

## Last Session: 2026-05-25 (Session 35)

### What Was Accomplished

**Landing page built + Supabase integration + business strategy docs.**

#### Landing Page (React/Vite/Tailwind/Framer Motion)

New directory `landing/` — standalone Vite app, **not** part of the Argus src/ tree.

| File | What Changed |
|------|-------------|
| `landing/public/favicon.svg` | Created — SVG replicating Logo() component: #5E0ED7 outer ring + filled dot |
| `landing/index.html` | Added `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` |
| `landing/src/supabase.js` | Created — `createClient()` guard; logs warn if env vars missing; exports `null` if unconfigured |
| `landing/src/App.jsx` | IRONCLAW.png visibility fix (border + box-shadow); WaitlistModal + EnterpriseModal wired to Supabase |
| `landing/.env.local` | Created (gitignored) — real Supabase credentials |
| `landing/.env.example` | Created (committed) — template with placeholder values |
| `landing/package.json` | Added `@supabase/supabase-js` dependency |

#### Supabase Postgres Integration

- Tables: `waitlist` (email, plan, created_at, source), `enterprise_contacts` (name, email, company, message, created_at)
- RLS enabled + `GRANT INSERT ON ... TO anon` (required even with RLS policies — anon role needs schema-level permission)
- Duplicate email: `23505` unique constraint code silently shows success state (user is already on the list)
- Error path: all other errors surface as "Something went wrong. Please try again."
- Button states: "Join Waitlist" → "Saving…" → success/error
- Debugging: fixed double-path bug (`/rest/v1/rest/v1/`) caused by `/rest/v1` suffix in `.env.local`; fixed 401 by running `GRANT INSERT` statements

#### Business & Strategy Docs (gitignored)

- `argus-vX1-roadmap.md` — Sprint 0-18, Sprint 0 documents 6 real mobile bugs with fix code, Sprint 7 is Azure + GitHub PR AI Validator (inserted, others shifted +1), Figma MCP integration details (Sprint 2)
- `business-analysis.md` — 10 sections: Current State, Competitive Pricing, Pricing Strategy, Acquisition Scenarios, Startup Path, MIT GTM, Month-by-Month Roadmap (12 months), Key Metrics, Risk Factors, The Pitch

#### Gitignore Updates

Added: `landing/vite.config.js.timestamp-*.mjs`, `landing/.env.local`, `IRONCLAW.png` (root stray copy), `argus-vX1-roadmap.md`, `business-analysis.md`

---

## Last Session: 2026-05-24 (Session 34)

### What Was Accomplished

**v9 Sprint 7 — OpenTelemetry tracing + metrics. Gate: 345/348.**

New file `src/utils/telemetry.js` — central OTel module. No-op by default (zero overhead when env vars absent); OTLP-exportable for production.

| Span | Attributes | Location |
|------|-----------|----------|
| `argus.run_crawl` | `baseUrl` | `orchestrator.js` `runCrawl()` |
| `argus.crawl_route` | `url`, `critical`, `pass` | `orchestrator.js` cheap_1/cheap_2/expensive passes + route wrap |
| `argus.analyzer` | `name`, `url` | `orchestrator.js` registry loop |
| `argus.dispatch` | `baseUrl`, `channel` | `dispatcher.js` per-channel sub-spans |
| `argus.flow` | `flow_name`, `url` | `flow-runner.js` `runFlow()` |
| `argus.flow_step` | `flow_name`, `action`, `selector` | `flow-runner.js` per step |

Metrics: `argus.findings` (Counter), `argus.flaky_findings` (Counter), `argus.analyzer.duration` (Histogram), `argus.crawl.duration` (Histogram), `argus.new_findings` (UpDownCounter)

New env vars: `OTEL_EXPORTER_OTLP_ENDPOINT`, `ARGUS_OTEL_CONSOLE=1` (dev stdout).

New deps: `@opentelemetry/api@^1.9.1`, `@opentelemetry/sdk-node@^0.218.0`.

Unit tests: 61/61 ✅ (no changes to test suite needed — OTel is transparent).

---

## Where to Resume Next Session

Test harness: **345/348 hard assertions** (82 blocks, 348 assertions, 54 fixture pages).

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
npm run test:unit     # Expected: 61/61 (no Chrome required)
npm run test:harness  # Expected: 345/348 (3 permanent MCP-limited failures: [49b], [67b], [68b])
```

**Landing page — Sprint 0 complete. Site live at [argus-qa.com](https://argus-qa.com).**
**MCP server — published to npm as `argusqa-os@9.2.0`. Ready for MCP directory submission.**

**Next steps (in order):**
1. Submit to [glama.ai/mcp/servers](https://glama.ai/mcp/servers) and [mcp.so](https://mcp.so/) → enter `argusqa-os`
2. GitHub repo polish — README hero screenshot/GIF, badges, link to argus-qa.com
3. Distribution — Show HN post, Twitter/X thread with OG card, ProductHunt
4. Monitor Supabase `waitlist` table for signups as traffic arrives
5. **vX1 Sprint 1** — Dark Mode & Theme Testing (`src/utils/theme-analyzer.js`, detection category A7, see `argus-vX1-roadmap.md`)

---

## Previous Session: 2026-05-23 (Sessions 32–33)

**v9 Sprint 5 + Sprint 6.** Vitest unit tests (6 files, 61 tests, blocks [81]+[82], gate 339/342). Argus MCP server (`src/mcp-server.js`, 4 tools, `.mcp.json`, block [80], gate 345/348). Gap audit: fixed URL parsing (query + hash), SKILL.md §1, CLAUDE.md structure + env vars, README.md tree + feature table, `argus-v9-strategy.md` tool table + harness spec.

---

## Previous Previous Session: 2026-05-18 (Session 31)

### What Was Accomplished

**v9 Sprint 4 — Session split, Pino structured logging, retry logic. Gate: 331/334 (no new assertions, no regressions).**

#### What Was Built

**v9.1.7 — Session split**

`session-manager.js` (original monolith) split into two focused modules:

- `src/utils/session-persistence.js` — `saveSession`, `restoreSession`, `hasSession`, `clearSession`. Atomic tmp→rename write prevents truncated JSON on crash.
- `src/utils/login-orchestrator.js` — `runLoginFlow`, `refreshSession`. Lock file (`sessionFile + '.lock'`) prevents concurrent shards from running redundant login flows.
- `session-manager.js` reduced to 11-line backward-compat re-export barrel (`export * from './session-persistence.js'; export * from './login-orchestrator.js';`). All existing callers unchanged.

**v9.1.8 — Pino structured logging**

- New `src/utils/logger.js` — Pino logger with TTY auto-detection. `ARGUS_LOG_LEVEL` controls level (default: `info`). `ARGUS_LOG_PRETTY=1` forces pino-pretty; `=0` forces JSON; unset = auto-detect TTY. `childLogger(module)` used by each file.
- New dependencies: `pino@^10.3.1`, `pino-pretty@^13.1.3`.
- 27 `src/` files migrated from `console.log/warn/error` → `logger.info/warn/error`. One intentional exception: `src/cli/init.js:312` (`main().catch` → `console.error`) for process-exit visibility.

**v9.1.9 — Retry logic**

- New `src/utils/retry.js` — `withRetry(fn, opts)` exponential backoff. `ARGUS_RETRY_ATTEMPTS` env var (default: 3). Set to 1 to disable retries in CI.
- Applied to `navigate` and `fill` in `CdpBrowserAdapter`. `click` is intentionally excluded — not idempotent (submits forms, toggles state); retrying after an ambiguous timeout could fire the action twice.

#### Files Created

| File | Purpose |
|------|---------|
| `src/utils/logger.js` | Pino structured logger |
| `src/utils/retry.js` | withRetry() exponential backoff |
| `src/utils/session-persistence.js` | Session save/restore (extracted) |
| `src/utils/login-orchestrator.js` | Login flow + refresh (extracted) |

#### Gap Fixes (post-implementation audit — two passes)

Six bugs found and fixed:

| File | Bug | Fix |
|------|-----|-----|
| `src/utils/logger.js` | App crashes at startup if `pino-pretty` fails to load | `createLogger()` wraps transport in try-catch; falls back to JSON silently |
| `src/utils/retry.js` | `label` param silently ignored | Added `childLogger('retry')` + `logger.debug()` per retry attempt |
| `src/utils/retry.js` | `ARGUS_RETRY_ATTEMPTS=non-numeric` → `NaN` → loop never runs → `fn()` never called, returns `undefined` silently | `Number.isFinite()` guard — falls back to 3 |
| `src/adapters/browser.js` | `withRetry()` had no labels; `click` idempotency exclusion undocumented | Added labels to `navigate`/`fill`; added 4-line comment above `click()` |
| `src/utils/session-persistence.js` | `saveSession()` didn't create parent directory → `ENOENT` crash for subdirectory paths | Added `fs.mkdirSync(path.dirname(sessionFile), { recursive: true })` |
| `src/utils/session-persistence.js` | `clearSession()` left stale `.tmp`; no log when only `.tmp` existed | Added `.tmp` removal + `logger.debug()` |

#### Harness: 331/334 (gate passed — no new assertions)

Same 3 permanent MCP-limited failures: [49b] drag DnD, [67b] CSP Issues panel, [68b] deprecated API Issues panel.

---

## Previous Session: 2026-05-18 (Session 30)

### What Was Accomplished

**v9 Sprint 3 — Threshold centralization + Zod config validation. Gate: 331/334 (4 new assertions, no regressions).**

#### What Was Built

**v9.1.5 — Centralize Thresholds**

New `export const thresholds` in `src/config/targets.js` — single source of truth for all magic-number limits across 7 categories:
- `thresholds.perf` — LCP (2500ms), CLS (0.1), FID (100ms), TTFB (800ms)
- `thresholds.network` — slowWarning (1000ms), slowCritical (3000ms), sizeWarning (500KB), sizeCritical (2MB)
- `thresholds.memory` — detachedWarning (10), detachedCritical (100), heapGrowthWarning (2MB), heapGrowthCritical (10MB)
- `thresholds.hover` — waitMs (350), maxDropdowns (8), maxTooltips (5)
- `thresholds.security` — headTimeoutMs (3000)
- `thresholds.apiFrequency` — warningCount (3), criticalCount (5)
- `thresholds.lighthouse` — accessibility/performance/seo/best-practices: { critical: 50, warning: 90 }

Updated 7 files to import and use `thresholds`:
- `src/utils/memory-analyzer.js` — removed `DETACHED_NODE_THRESHOLDS` and `HEAP_GROWTH_THRESHOLDS`
- `src/utils/hover-analyzer.js` — replaced `8`, `5`, `350` in HOVER_CANDIDATE_SCRIPT (template literal interpolation) and `analyzeHover`
- `src/utils/security-analyzer.js` — interpolated `${thresholds.security.headTimeoutMs}` into `SECURITY_ANALYSIS_SCRIPT`
- `src/utils/api-frequency.js` — replaced `count >= 5` / `count >= 3` with threshold refs
- `src/utils/lighthouse-checker.js` — removed `LIGHTHOUSE_THRESHOLDS` export; uses `thresholds.lighthouse.*`
- `src/orchestration/orchestrator.js` — removed `PERF_BUDGETS` and `NETWORK_PERF_THRESHOLDS`; uses `thresholds.perf.*` / `thresholds.network.*`

**v9.1.6 — Zod Config Validation**

New `src/config/schema.js` — `ConfigSchema` (Zod) + `validateConfig(targets)` exported.

`validateConfig` is called at the START of `runCrawl()` in `orchestrator.js` (not in the re-export shells `argus.js`/`batch-runner.js`). This ensures validation fires regardless of which entry point is used and only when a crawl is actually starting. `argus.js` and `batch-runner.js` remain thin re-export shells. Bad config = clear error at crawl start, not a mid-crawl surprise.

**New dependency**: `zod` (added to package.json).

**Harness block [79]** — 4 hard assertions:
- [79a] Real targets.js passes validation without throwing
- [79b] Route missing `path` field → throws
- [79c] Route `path` not starting with `/` → throws
- [79d] `thresholds.perf.LCP` as string → throws

#### Harness: 331/334 (gate passed)

3 permanent MCP failures unchanged: [49b] drag DnD, [67b] CSP Issues panel, [68b] deprecated API Issues panel.

---

## Where to Resume Next Session

Test harness: **331/334 hard assertions** (79 blocks, 334 assertions, 54 fixture pages).

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
npm run test:harness   # Expected: 331/334 (3 MCP-limited failures)
```

**v9 Sprint 4 is next** (see `argus-v9-strategy.md`):
- Session split: `session-persistence.js` + `login-orchestrator.js` (v9.1.7)
- Structured logging with Pino (v9.1.8)
- Retry logic in flow runner (v9.1.9)

---

## Previous Session: 2026-05-18 (Session 29)

### What Was Accomplished

**v9 Sprint 2 gap audit — 3 fixes applied, harness re-confirmed at 327/330. No regressions.**

#### What Was Fixed

**Fix 1 — Responsive screenshot omitted-entry guard (`src/orchestration/orchestrator.js`)**

`analyzeResponsive` stores `{ omitted: true, reason: 'size_cap', bytes: N }` in `screenshots` when a screenshot exceeds 5 MB. The registry loop was calling `Buffer.from(data, 'base64')` on these object values — causing a misleading TypeError warning. Added `if (typeof data !== 'string') continue;` before the `Buffer.from` call.

**Fix 2 — `import { registerExpensive }` moved to top of 6 analyzer files**

The import statement was placed at the bottom of each file in the `// ── Self-registration` section. Moved to the top (with other imports) in all 6 files: `hover-analyzer.js`, `snapshot-analyzer.js`, `keyboard-analyzer.js`, `responsive-analyzer.js`, `memory-analyzer.js`, `lighthouse-checker.js`. The `registerExpensive({ ... })` call remains at the bottom (after function definitions).

**Fix 3 — Orchestrator side-effect import comment updated**

Comment now accurately notes that `lighthouse-checker.js` self-registers via its direct named import (line 31), not just via the side-effect imports below it.

#### Harness: 327/330 (re-confirmed after gap fixes)

3 permanent MCP failures unchanged: [49b] drag DnD, [67b] CSP Issues panel, [68b] deprecated API Issues panel.

---

---

## Previous Session: 2026-05-18 (Session 28)

### What Was Accomplished

**v9 Sprint 2 — God object split + plugin registry. `crawl-and-report.js` (1,615 lines) refactored into 4 focused modules. All 6 expensive analyzers self-register. Harness gate: 327/330 (no regression).**

#### What Was Built

`src/registry.js` — Analyzer plugin registry. `registerCheap(a)` / `registerExpensive(a)` / `getCheap()` / `getExpensive()` / `clearAll()`. Analyzers self-register at module load time; the orchestrator iterates the registry instead of calling 14+ named functions.

`src/orchestration/orchestrator.js` — Extracted crawl loop from old god object. Contains `crawlRouteCheap`, `crawlRouteExpensive`, `crawlAndAnalyzeRoute` (uses `getExpensive()` registry loop), `runCrawl`. Side-effect imports for the 5 expensive analyzers control registration order. CLI entry block included.

`src/orchestration/report-processor.js` — Post-crawl pipeline: `deduplicateFindings`, `rebuildSummary`, `processReport` (applyOverrides → rebuildSummary → baseline load/apply/save → trend → JSON write).

`src/orchestration/dispatcher.js` — `dispatchAll(report, diff, reportPath)` dispatches to Slack (criticals/warnings/responsive/flows/codebase/info digest) or HTML when Slack is not configured, plus GitHub if configured.

`src/orchestration/crawl-and-report.js` — Reduced from 1,615 lines to a ~20-line backward-compat re-export shell. All callers continue to import from this file unchanged.

**Self-registration added to 6 analyzers** (bottom of each file):
`hover-analyzer.js`, `snapshot-analyzer.js`, `keyboard-analyzer.js`, `responsive-analyzer.js`, `memory-analyzer.js`, `lighthouse-checker.js`

**Gap audit fixes (carried over from prior session)**:
- Runtime bug: `issuesBaseline` now uses `normalizeArray()` before `.length` in orchestrator.js
- All stale `@param {object} mcp` JSDoc comments fixed across 7 files
- All stale `mcp.*` method references in module-level comments fixed (flow-runner, hover, snapshot, contract-validator)

#### Files Created/Modified

| File | Change |
|------|--------|
| `src/registry.js` | **New** — plugin registry (18 lines) |
| `src/orchestration/orchestrator.js` | **New** — ~970-line crawl engine extracted from god object |
| `src/orchestration/report-processor.js` | **New** — ~130-line post-crawl pipeline |
| `src/orchestration/dispatcher.js` | **New** — ~260-line dispatch module |
| `src/orchestration/crawl-and-report.js` | Replaced 1,615 lines with 20-line re-export shell |
| `src/utils/hover-analyzer.js` | Added `registerExpensive` block + JSDoc fix |
| `src/utils/snapshot-analyzer.js` | Added `registerExpensive` block + JSDoc fix |
| `src/utils/keyboard-analyzer.js` | Added `registerExpensive` block + JSDoc fix |
| `src/utils/responsive-analyzer.js` | Added `registerExpensive` block + JSDoc fix |
| `src/utils/memory-analyzer.js` | Added `registerExpensive` block + JSDoc fix |
| `src/utils/lighthouse-checker.js` | Added `registerExpensive` block |
| `src/orchestration/env-comparison.js` | JSDoc fix: internal function params |
| `src/utils/flow-runner.js` | JSDoc + module comment fixes |
| `src/utils/contract-validator.js` | `mcp.get_network_request` → `browser.getNetworkRequest` in comment |

#### Architecture (post-Sprint 2)

```
runCrawl(mcp)
  └── new CdpBrowserAdapter(mcp)
  └── crawlRouteCheap(route, baseUrl, mcp)      [cheap analyzers: A1-A5, C1, D1...]
  └── crawlRouteExpensive(route, baseUrl, mcp)  [registry loop: getExpensive()]
        └── for ({ name, analyze } of getExpensive())
              responsive → { findings, screenshots }
              memory / hover / snapshot / keyboard → findings[]
              lighthouse → skipped in loop (runs separately inside crawlRouteExpensive)
  └── processReport(report, { outputDir, severityOverrides })
  └── dispatchAll(report, diff, reportPath)
```

Adding a new expensive analyzer = 1 file only. No orchestrator changes needed.

#### Harness: 327/330 (unchanged — Sprint 2 is architectural only)

3 permanent MCP failures: [49b] drag DnD, [67b] CSP Issues panel, [68b] deprecated API Issues panel.

---

## Where to Resume Next Session

Test harness: **327/330 hard assertions** (78 blocks, 330 assertions, 54 fixture pages).

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
npm run test:harness   # Expected: 327/330 (3 MCP-limited failures)
```

**v9 Sprint 3 is next** (see `argus-v9-strategy.md`):
- CI mode headless runner (`src/utils/mcp-client.js` already exists — wire it into a `--ci` flag on `crawl-and-report.js` shell)
- GitHub Actions workflow update
- Operational: set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` in `.env`; set `ARGUS_SOURCE_DIR` for codebase analysis
- Consider adding `src/registry.js` cheap-analyzer registration for A1–A5 cheap analyzers

---

## Previous Session: 2026-05-17 (Session 27)

### What Was Accomplished

**v9 Sprint 1 — CdpBrowserAdapter migration complete. All 13 files migrated from `mcp.*` → `browser.*`. Three bugs fixed post-migration. Final harness: 327/330.**

#### What Was Built

`src/adapters/browser.js` — `CdpBrowserAdapter` class that wraps all `chrome-devtools-mcp` tool calls behind a clean interface. All analyzers now receive a `browser` adapter instead of calling `mcp.*` directly.

`src/domain/finding.js` — `createFinding()` factory for the canonical finding shape.

`src/utils/mcp-parsers.js` — `parseConsoleMsgResponse` and `parseNetworkReqResponse` moved from watch-mode.js into a shared utility.

#### Files Created/Modified

| File | Change |
|------|--------|
| `src/adapters/browser.js` | **New** — CdpBrowserAdapter (26 methods wrapping all MCP tools) |
| `src/domain/finding.js` | **New** — createFinding() factory |
| `src/utils/mcp-parsers.js` | **New** — text-format parsers (moved from watch-mode.js, made shared) |
| 13 migrated files | hover, snapshot, keyboard, responsive, memory, issues, contract-validator, lighthouse, session-manager, flow-runner, env-comparison, crawl-and-report, validate.js — all migrated to `browser.*` |
| `src/orchestration/watch-mode.js` | networkKey fixed: always content-based (not ID-based) |

#### Bugs Fixed During Migration

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `browser.evaluate is not a function` crash at block [48] | `resolveUidForSelector(mcp, ...)` in validate.js line 2268 was the last call site not migrated | Changed `mcp` → `browser` |
| API contract validation silently producing zero results | `parseNetworkReqResponse` emitted `_reqid` but not `requestId`; contract-validator read `req.requestId` → `undefined` → `getNetworkRequest(undefined)` → silent catch → skip | Added `requestId: Number(reqid)` to parsed network objects in mcp-parsers.js |
| Watch-mode dedup broken by requestId addition | Adding `requestId` made `networkKey`'s `r.requestId ?? content-key` resolve to the numeric reqid, which resets per navigation | Changed `networkKey` to always use content-based key (`method::url::status`) |

#### Architecture (post-Sprint 1)

All analyzers take `CdpBrowserAdapter` as first argument. Public orchestration functions (`runCrawl`, `crawlRouteCheap`, `runComparison`) keep `mcp` in signature for backward compat and construct `new CdpBrowserAdapter(mcp)` internally.

**Critical adapter rules:**
- `browser.listConsole()` / `browser.listNetwork()` return parsed arrays (not raw text)
- `browser.listConsoleRaw(args)` for issues-panel calls needing custom args
- Parsed network objects have `{ requestId, method, url, status }` — use `req.requestId` for `getNetworkRequest()`
- watch-mode `networkKey` is always content-based (`method::url::status`) — `requestId` resets after navigation

#### Documentation Updated

CLAUDE.md, SKILL.md (§14), argus-v9-strategy.md, memory/project_godmode.md, README.md, test-harness/README.md, solution.md, session.md.

---

## Where to Resume Next Session

Test harness: **327/330 hard assertions** (78 blocks, 330 assertions, 54 fixture pages).
3 failing assertions are permanent MCP limitations: [49b], [67b], [68b].

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
npm run test:harness   # Expected: 327/330 (3 MCP-limited failures)
```

**v9 Sprint 2 is next** (see `argus-v9-strategy.md`):
- Plugin registry (`src/registry.js`) — centralized adapter/analyzer registration
- God object split — break `crawl-and-report.js` into orchestrator + report-processor + dispatcher
- Gate: 327/330 (no new assertions for Sprint 2)

---

## Previous Session: 2026-05-17 (Session 26)

### What Was Accomplished

**Watch Mode (passive browser monitoring) — `npm run watch`. All locally fixable harness failures resolved. Final state: 327/330 (78 blocks, 330 assertions, 54 fixture pages).**

#### What Was Built

`src/orchestration/watch-mode.js` — passive browser monitoring that attaches to whatever page Chrome already has open and polls for new issues at a configurable interval without navigating anywhere.

**Key insight**: `chrome-devtools-mcp@latest` returns `list_console_messages` and `list_network_requests` as **human-readable markdown text** (not JSON arrays). `normalizeArray()` from `flow-runner.js` cannot extract arrays from strings — it returns `[]`. All prior attempts to use these tools returned empty arrays silently.

**Fix**: Added regex text-format parsers:
- Console format: `msgid=N [level] text (N args)` → `{ _msgid, level, text, message }`
- Network format: `reqid=N METHOD URL [STATUS]` → `{ _reqid, method, url, status, statusCode }`

**Dedup design**: Content-based keys (not ID-based):
- Console: `` `${level}::${text.slice(0, 200)}` ``
- Network: `requestId ?? \`${method}::${url}::${status}\``

ID-based dedup would suppress new findings after navigation if msgids/reqids reset per page.

#### Files Created/Modified

| File | Change |
|------|--------|
| `src/orchestration/watch-mode.js` | **New** — `WatchSession` class, `runWatchMode()`, text parsers, classifiers |
| `test-harness/pages/watch-issues.html` | **New** — fixture: fires console.error + console.warn on load; fetches /api/always-500 and /api/missing; exposes `window.argusWatchTriggerError(msg)` |
| `test-harness/validate.js` | Block [78] added: 7 assertions for WatchSession poll, dedup, incremental detection |
| `package.json` | Added `"watch": "node src/orchestration/watch-mode.js"` script |
| `SKILL.md` | Stats updated: 78 blocks, 330 assertions, 54 fixture pages |
| `CLAUDE.md` | Stats updated to match |

#### Harness: 327/330 (78 blocks, 330 assertions, 54 fixture pages)

3 permanent MCP failures (unchanged): [49b] drag DnD, [67b] CSP Issues panel, [68b] deprecated API Issues panel.

Block [78] assertions:
- [78a] First poll detects ≥1 console error/warning from fixture
- [78b] First poll detects ≥1 network error from fixture
- [78c] Second poll returns 0 new findings — dedup works
- [78d] getAllFindings() matches cumulative total
- [78e] After `argusWatchTriggerError('probe-delta')`, third poll detects new incremental error
- [78f] HTTP 500 classified as `network_server_error` severity critical
- [78g] All findings have required fields: type, severity, message

#### How to Use Watch Mode

**Flow**: Use when you want passive reporting while your app is running — no route config needed.

**Terminals required: 2**

| Terminal | Command | Purpose |
|----------|---------|---------|
| 1 | `npm start` (or your app's dev command) | Your application running |
| 2 | `npm run watch` | Argus polling the open browser tab |

**Sequential steps:**
1. Open Chrome and navigate to your app's dev URL
2. Terminal 1: Start your application (`npm start` / `npm run dev`)
3. Terminal 2: `npm run watch` (default: monitors whatever page is open)
4. Optionally: `npm run watch http://localhost:4000` to attribute findings to a specific URL
5. Use the app normally — Argus reports new console errors and network failures in real time
6. `Ctrl+C` in Terminal 2 → stops watch and writes a final `reports/report.html`

**Environment variable**: `ARGUS_WATCH_INTERVAL_MS` (default: 3000ms)

---

~~Where to Resume Next Session~~ *(superseded by Session 27)*

---

## Previous Session: 2026-05-10 (Session 25)

### What Was Accomplished

**Argus v8 — Harness correctness audit and snapshot format migration. All locally fixable failures resolved. 3 permanent MCP-limited failures remain (320/323).**

#### Context
Previous run showed 307/323 hard assertions. A root-cause audit identified 16 failures across 4 categories, all addressed this session. Post-audit correction: [48b] was misdiagnosed as an MCP limit — it was a test code bug (fixed).

#### Root Cause Analysis

| Category | Assertions | Root Cause |
|----------|-----------|-----------|
| Snapshot uid format changed | 9 | New format: `uid=N_M role "name"` (uid first, numeric format) instead of old `role name e5` (uid last, alpha-numeric). All `resolveUidForSelector`, `extractFileInputUid` regexes were obsolete. |
| Timing race | 4 | `sync-xhr.html` fired XHR after 300ms; CDP round-trip under MCP overhead exceeds 300ms. |
| MCP behavioral limits | 3 | `drag` no HTML5 DnD `drop` event; Issues panel empty via `list_console_messages` (2 assertions). |
| Test code bug / click/fill use selector | 3 | [48b] `mcp.click({ selector })` silent no-op; `mcp.click` and `mcp.fill` require uid; passing `selector` succeeded silently but clicked nothing. |

#### Fixes Applied

| File | Change |
|------|--------|
| `test-harness/pages/sync-xhr.html` | XHR delay 300ms → 1500ms |
| `src/utils/flow-runner.js` | `resolveUidForSelector`: rewrote regex for new `uid=N_M` format; skip StaticText to prefer interactive elements; return N_M without prefix |
| `src/utils/flow-runner.js` | `extractFileInputUid`: new patterns for `button "Choose file:" value="No file chosen"` format |
| `src/utils/flow-runner.js` | `select_option` case: resolve HTML value → option label text before calling `mcp.fill` |
| `src/utils/flow-runner.js` | `click` case: resolve selector → uid via `resolveUidForSelector` |
| `src/utils/flow-runner.js` | `fill` case: resolve selector → uid; use uid for both `mcp.click` (focus) and `mcp.fill` |

#### Known MCP Limitations (not fixable in Argus, 3 assertions remain failing)
- [49b] `drag` triggers the drag operation but HTML5 `drop` event does not fire (MCP uses mouse simulation, not HTML5 DnD API)
- [67b, 68b] Chrome DevTools Issues panel data not returned by `list_console_messages`

> [48a] failed because `mcp.fill` fires ONE consolidated `input` event (not zero as originally assumed). The counter shows `value.length` (e.g. 11 for "hello world"). Fix: assertion updated to `countA === String(FILL_VALUE.length)`.
>
> [48b] failed due to two successive test code bugs — not an MCP limitation:
> 1. `mcp.click({ selector })` silently does nothing — element was never focused.
> 2. After switching to `mcp.click({ uid })`: CDP mouse event dispatched but `document.activeElement` was not set for text inputs in headless Chrome outside `runFlow` — element clicked but focus not transferred.
>
> Fix: `evaluate_script(() => el.focus())` in direct test code. `type_text` DOES fire DOM `input` events when the element is properly focused. The `fill` step with `typing: true` via `runFlow` uses `mcp.click({ uid })` and works correctly.
> `typing: true` is still needed when per-keystroke `keydown`/`keyup` events are required — `mcp.fill` only fires a single consolidated `input` event, not per-character keyboard events.

#### Documentation Updated
- `README.md` — assertion count updated; MCP limitations section added (320/323 passing, 3 permanent failures)
- `solution.md` — v8 section added; harness stats updated; GAP labels removed from all sections
- `test-harness/README.md` — assertion count and status updated
- `session.md` — this entry
- Codebase-wide: all GAP-NNN labels removed from 28 JS files + 7 HTML fixture pages (preserving explanatory text)

---

## Previous Session: 2026-05-05 (Session 24)

### What Was Accomplished

**Argus v7 Final Production Hardening Audit complete. 50+ fixes across 17 files. Zero known security, correctness, or robustness gaps remaining. Codebase is production/public-release ready.**

This was a comprehensive two-part session:
1. **Part 1 (continued from Session 23 context)**: Applied ~35 fixes covering security vulnerabilities, MCP API correctness, and robustness bugs across hover-analyzer, flow-runner, memory-analyzer, baseline-manager, flakiness-detector, issues-analyzer, network-timing-analyzer, keyboard-analyzer, slug, server/index, server/slash-command-handler, server/interaction-handler, html-reporter, codebase-analyzer, contract-validator.
2. **Part 2 (this session)**: Applied remaining ~15 fixes to cli/init.js, route-discoverer.js, slack-notifier.js, crawl-and-report.js, env-comparison.js, css-analyzer.js. Updated all documentation (README.md, solution.md, session.md).

---

#### Critical Security Fixes

| Fix | File | Type |
|-----|------|------|
| Code injection via route path/name/waitFor in generated JS | `cli/init.js` | Critical |
| `hover({ selector })` instead of `hover({ uid })` — no hovers ever fired | `hover-analyzer.js` | Critical |
| Stream double-consumption — request body lost before Slack sig check | `server/index.js` | Critical |
| NaN bypass in replay-attack timestamp guard (`parseInt` of non-numeric) | `slash-command-handler.js` | Critical |
| SSRF via user-supplied URLs in Slack slash command + interaction | `slash/interaction-handler.js` | Critical |
| Path traversal in schemaFile contract loader | `contract-validator.js` | Critical |
| XSS via `javascript:` href in HTML report | `html-reporter.js` | Critical |

#### Correctness & Robustness Fixes

- `baseline-manager.js`: atomic writes, trend cap, stale lock release, null guards
- `flakiness-detector.js`: O(n²) → O(1) Map-based dedup
- `network-timing-analyzer.js`: status 0 filter; TTFB-only timing (not total duration)
- `keyboard-analyzer.js`: focus reset, stable dedup key, per-step focus_lost
- `issues-analyzer.js`: per-route baseline isolation; catch-all classifier
- `crawl-and-report.js`: 8 null guards + try/catch; `isNew === true` strict filter
- `env-comparison.js`: pixelmatch threshold 0.1 fixed; per-Slack-post error handling
- `route-discoverer.js`: symlink guard; 5MB XML cap; 500 URL cap; child sitemap SSRF
- `slack-notifier.js`: button value length caps; '429' string check removed; PUT error log
- `css-analyzer.js`: double-JSON-encoding detection

---

#### Documentation Updated This Session

- `solution.md` — header status, Phase v7 table (50+ fixes listed)
- `session.md` — this entry
- `README.md` — Key Technical Decisions: `isNew === true` explanation updated

---

## ~~Where to Resume~~ (superseded by Session 25)

---

## Previous Session: 2026-05-03 (Session 23)

### What Was Accomplished

**Argus v6 complete. 10 gaps (GAP-093 through GAP-102) implemented across 4 priority tiers. 13 new harness blocks ([65]–[77]), 43 new hard assertions, 7 new fixture pages. Documentation fully updated. Harness audit completed; gaps documented in `argus-v6-strategy.md` as GAP-103–GAP-110.**

---

#### v6 Commits (already pushed)

| Commit | Content |
|--------|---------|
| `09832a2` | GAP-093 — Chrome DevTools Issues panel (`issues-analyzer.js`) |
| `b60a4ec` | GAP-094 + GAP-096 — HAR timing analyzer + heading hierarchy in snapshot-analyzer |
| `ec54685` | GAP-095 + GAP-097 + GAP-098 — CPU throttle + keyboard-analyzer + ARIA state |
| `aacfbfb` | GAP-099–GAP-102 — select_option + origin tagging + HTTPS check + iframe sandbox |
| `c29d9ce` | SKILL.md §14 statistics update |

---

#### v6 Implementation Summary

**GAP-093 — Chrome DevTools Issues panel** (`src/utils/issues-analyzer.js` new)
- `analyzeIssues(mcp, url, isCritical)` — navigates, uses D5 baseline pattern, returns findings
- `parseIssues(issues, url, isCritical)` — pure function for use in crawl pipeline
- 7-type CLASSIFIERS table: csp_violation (critical), deprecated_api_use (info), cors_violation, mixed_content, cookie_attribute_missing, low_contrast_native, permission_policy_violation
- Fixture: `issues-csp.html` (CSP meta `script-src 'self'` + inline script), `issues-deprecated.html` (document.domain + DOMSubtreeModified)

**GAP-094 — HAR network timing** (`src/utils/network-timing-analyzer.js` new)
- `parseNetworkTiming(reqs, pageUrl)` — pure; cross-origin only, skips static assets/same-origin/failed
- Emits `slow_third_party_blocking` warning for cross-origin TTFB > 2000ms
- Wired into `crawl-and-report.js` step 6d

**GAP-095 — Mobile CPU throttle** (`src/utils/responsive-analyzer.js` modified)
- `emulate_cpu({ throttlingRate: 4 })` before ≤768px breakpoints; reset to 1 before desktop; `finally` block restores

**GAP-096 — Heading hierarchy** (`src/utils/snapshot-analyzer.js` modified)
- `HEADING_HIERARCHY_SCRIPT` walks h1–h6 in document order; detects level jumps > 1
- Emits `heading_level_skip` warning; fixture: `heading-issues.html` (h1→h3 + h4→h6 skips)

**GAP-097 — Keyboard focus analysis** (`src/utils/keyboard-analyzer.js` new)
- `FOCUS_INFO_SCRIPT` reads `document.activeElement` computed style; detects outline:0 with no box-shadow
- `analyzeKeyboard(mcp, url)` — Tab-walks up to 20 steps; deduplicates by element identity key
- Emits `focus_visible_missing`; fixture: `keyboard-issues.html` (#no-focus-ring button)

**GAP-098 — ARIA state checks** (`src/utils/snapshot-analyzer.js` modified)
- `ARIA_STATE_SCRIPT` checks `[aria-expanded]` elements for missing/broken `aria-controls` reference
- Emits `aria_expanded_no_controls` warning; fixture: `aria-state-issues.html` (2 bad toggles + 1 valid)

**GAP-099 — `select_option` flow step** (`src/utils/flow-runner.js` modified)
- Added `case 'select_option':` with uid-from-selector fallback via `resolveUidForSelector`
- Fixture: `select-form.html` (#country + #size selects → "US/L" in #form-result)

**GAP-100 — Origin tagging** (`src/orchestration/crawl-and-report.js` modified)
- `classifyOrigin(reqUrl, pageUrl)` helper — eTLD+1 comparison
- All network findings now carry `origin: 'first-party' | 'third-party'`

**GAP-101 — HTTPS enforcement** (`src/orchestration/crawl-and-report.js` modified)
- Step 9f: emits `security_no_https` warning for `http://` non-localhost pages
- Tested via URL parsing logic (can't trigger in localhost harness)

**GAP-102 — Iframe sandbox** (`src/utils/security-analyzer.js` modified)
- Section 5 of `SECURITY_ANALYSIS_SCRIPT`: iterates `iframe[src]`, records unsandboxed cross-origin ones
- `parseSecurityAnalysisResult` emits `security_iframe_no_sandbox` warning
- Fixture: `iframe-sandbox.html` (2 unsandboxed + 1 sandboxed)

---

#### Harness blocks added

| Block | Fixture | What it tests |
|-------|---------|---------------|
| [65] | clean.html | Production crawl pipeline smoke — `crawlRouteCheap` directly |
| [66] | clean.html | Issues panel baseline — no findings on clean page |
| [67] | issues-csp.html | `csp_violation` critical |
| [68] | issues-deprecated.html | `deprecated_api_use` info |
| [69] | (pure) | `parseNetworkTiming` 7 unit assertions |
| [70] | heading-issues.html | `heading_level_skip` warning ×2 |
| [71] | responsive-issues.html | CPU throttle doesn't suppress `responsive_overflow` |
| [72] | keyboard-issues.html | `focus_visible_missing` warning |
| [73] | aria-state-issues.html | `aria_expanded_no_controls` warning ×2 |
| [74] | select-form.html | `select_option` flow step → "US/L" |
| [75] | clean.html | Network findings carry `origin` field |
| [76] | (URL logic) | localhost excluded from `security_no_https` |
| [77] | iframe-sandbox.html | `security_iframe_no_sandbox` warning ×2 |

---

#### Documentation updated this session

- `solution.md` — header stats (77/319/53/53), file structure (3 new analyzers), phase list (v6 table), harness architecture
- `session.md` — this entry
- `README.md` — stats badge (119 types / 24 engines / 319 assertions / 77 blocks), v6 detection rows (Security, Accessibility, Keyboard, Network Performance, What It Does table, project structure)
- `test-harness/README.md` — stats line, blocks [65]–[77] rows, 7 new fixture pages in directory layout
- `argus-v6-strategy.md` — marked all 10 gaps as complete; added §10 harness audit (GAP-103–GAP-110)

---

## Where to Resume Next Session

### All Phases + v6 Complete

Test harness: **320/323 hard assertions** (77 blocks, 53 categories, 53 fixture pages). 3 permanent MCP failures: [49b], [67b], [68b].

**Operational next steps:**
1. **Verify test harness against live Chrome**:
   ```bash
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
   npm run test:harness   # Expected: 320/323 (3 permanent MCP failures)
   ```
2. **Optional: address harness audit gaps (GAP-103–GAP-110)** in `argus-v6-strategy.md` — these are harness coverage improvements, not production defects
3. **Configure for a real target app**: `npm run init`

---

## Previous Session: 2026-04-28 (Session 22)

### What Was Accomplished

**v4.1 full-codebase audit extension complete. 42 additional gaps identified (GAP-31 to GAP-72) across 15 previously-unaudited files. All findings documented in `argus-v4-strategy.md` with code evidence, severity ratings, and sprint plan for Sprints 5–8. No code fixes applied this session — audit only.**

---

#### Audit Scope — Files Now Covered

15 files audited for the first time across 4 parallel background agents:

| Agent | Files | Gaps Found |
|-------|-------|-----------|
| Agent 1 | `src/server/index.js`, `slash-command-handler.js`, `interaction-handler.js` | 11 (GAP-31 to GAP-41) |
| Agent 2 | `src/utils/responsive-analyzer.js`, `security-analyzer.js`, `content-analyzer.js` | 10 (GAP-42 to GAP-51) |
| Agent 3 | `src/utils/api-frequency.js`, `diff.js`, `flakiness-detector.js`, `parallel-crawler.js`, `severity-overrides.js` | 12 (GAP-52 to GAP-63) |
| Agent 4 | `test-harness/server.js`, `test-harness/harness-config.js` | 9 (GAP-64 to GAP-72) |

**Total gaps now documented: 72** (30 original + 42 extension). **Harness stats unchanged: 276/276 hard assertions.**

---

#### Sprint 5 — Slack Server Hardening (GAP-31 to GAP-41)

**Files affected:** `src/server/index.js`, `src/server/slash-command-handler.js`, `src/server/interaction-handler.js`

Top findings:
1. **GAP-31 (CRITICAL)** — `SLACK_BOT_TOKEN` read at module import time → `undefined` if `.env` not yet loaded
2. **GAP-32 (HIGH)** — `runRetestAsync()` called without `.catch()` → unhandled rejection kills server in Node 15+
3. **GAP-33/34 (HIGH)** — `process.env.TARGET_DEV_URL` mutated by concurrent retests (shared Node.js env) → wrong target URL used under load
4. **GAP-40 (MEDIUM)** — `TARGET_DEV_URL` not restored in `finally` — if `runCrawl` throws, env stays overridden for all future retests
5. **GAP-39 (MEDIUM)** — `handleInteraction` awaits `acknowledgeMessage`/`handleRetestAction` after `res.send()` with no try/catch → unhandled rejections after response is committed

---

#### Sprint 6 — Analyzer Accuracy (GAP-42 to GAP-51)

**Files affected:** `src/utils/responsive-analyzer.js`, `src/utils/security-analyzer.js`, `src/utils/content-analyzer.js`

Top findings:
1. **GAP-43 (HIGH)** — `parseSecurityAnalysisResult` and `parseContentAnalysisResult` cannot unwrap the MCP `{ result: '...' }` wrapper object → `JSON.stringify(wrapper)` then `JSON.parse` produces `{ result: '...' }` not the data → **all security and content findings silently dropped**. `responsive-analyzer.js` handles this correctly via `parseEvalObject`; the other two do not.
2. **GAP-42 (HIGH)** — `parseEvalObject`/`parseEvalArray` swallow parse failures with no log → broken evaluate_script is indistinguishable from a page with no issues
3. **GAP-48 (LOW)** — Hardcoded 3s timeout for security header fetch → false negatives on staging behind VPNs (note: `hasCSP === false` check misses `null` case, so timeout causes silent skip, not false detection)

---

#### Sprint 7 — Utility Correctness (GAP-52 to GAP-63)

**Files affected:** `src/utils/api-frequency.js`, `src/utils/diff.js`, `src/utils/flakiness-detector.js`, `src/utils/parallel-crawler.js`, `src/utils/severity-overrides.js`

Top findings:
1. **GAP-59 (HIGH)** — `applyOverrides` iterates `report.routes` with no null guard; `report.flows` has `?? []` — inconsistent; crashes if routes is undefined
2. **GAP-60 (HIGH)** — `api-frequency.js` and `diff.js` use different URL normalization strategies → same endpoint keyed differently in frequency vs diff analysis
3. **GAP-54 (HIGH)** — `compareScreenshots` has no try/catch around `readFileSync`/`PNG.sync.read` → crashes entire report if screenshot is missing or corrupt
4. **GAP-55 (MEDIUM)** — Division by zero in `diffPercent` if image is 0×0 pixels → `Infinity` in report JSON

---

#### Sprint 8 — Test Harness Hardening (GAP-64 to GAP-72)

**Files affected:** `test-harness/server.js`, `test-harness/harness-config.js`

Top findings:
1. **GAP-65 (HIGH)** — `app.listen()` has no `'error'` event handler → EADDRINUSE crash is undiagnosed in CI
2. **GAP-66 (HIGH)** — `flow-form.html` fixture exists and is tested in `validate.js` but has no entry in `harnessRoutes` — invisible to route coverage tooling
3. **GAP-69 (HIGH)** — `res.sendFile()` on dynamic routes has no error callback → unhandled error event if file is missing
4. **GAP-64 (MEDIUM)** — Security headers middleware uses `.includes('security-issues')` → matches unintended paths; should be `=== '/security-issues.html'`

---

#### Key Decision Made This Session

**GAP-43 is the highest-priority new gap**: `security-analyzer.js` and `content-analyzer.js` parse evaluate_script results with a pattern that can't unwrap the MCP result wrapper, causing both analyzers to silently produce zero findings. This would have gone unnoticed without the audit since the parsers succeed without throwing — they just return empty arrays.

---

## Where to Resume Next Session

### All Code Phases + v4 Quality Audit + v4.1 Audit Extension Complete

**Next action: Fix Sprint 5–8 gaps or run the harness.**

Sprint 5 is highest priority (live Slack bot has security/crash-risk issues). Sprint 6 GAP-43 is highest accuracy impact (security and content analyzers silent).

**Operational next steps:**
1. **Fix Sprint 5 gaps** — server hardening (45–90 min total)
2. **Fix Sprint 6 GAP-43** — security/content parser MCP wrapper fix (15 min)
3. **Run the test harness** against live Chrome to verify 276/276 still pass
4. **Push to GitHub** (all local commits through Session 22)

---

## Previous Session: 2026-04-28 (Session 21)

### What Was Accomplished

**Full v4 codebase quality audit complete. 30 gaps identified, documented in `argus-v4-strategy.md`, and fixed across 4 sprints. Test harness stats unchanged: 276/276 hard assertions (64 blocks, 39 categories, 46 fixture pages). One new detection type added: `seo_og_image_relative_url`.**

---

#### v4 Quality Audit — `argus-v4-strategy.md`

Two parallel background agents audited the full codebase. Results synthesized into a 30-gap strategy document with 4 severity tiers: 6 Critical, 10 High, 8 Medium, 6 Low. All gaps confirmed by direct file reads before fixing.

**Root cause of all D6 detections silently failing (Sprint 1):** `INJECT_*` scripts were IIFEs (`(function(){})()`) and bare expressions — Chrome CDP's `Runtime.callFunctionOn` requires a callable arrow function `() => {...}`. All injections were also running BEFORE `navigate_page`, so the page context they patched was immediately destroyed by navigation. Both root causes fixed in Sprint 1.

---

#### Sprint 1 — Critical (6 fixes)

**Files modified:** `src/orchestration/crawl-and-report.js`, `test-harness/validate.js`, `src/utils/mcp-client.js`, `src/argus.js` (new), `src/batch-runner.js` (new)

1. **GAP-01** — 5 `INJECT_*` IIFEs → callable arrow functions in both `crawl-and-report.js` and `validate.js`; `EXTRACT_ERROR_LISTENER` bare expression → arrow function
2. **GAP-02/03** — `document.title` and `document.body?.innerText` bare expressions → `() =>` arrow functions
3. **GAP-04** — All 5 listener injections moved AFTER `navigate_page` + settle (correct order: navigate → wait → inject)
4. **GAP-05** — `mcp-client.js tool()` now handles `type: 'image'` content — returns `{ data, mimeType }` for screenshots instead of falling through to null
5. **GAP-06** — `src/argus.js` and `src/batch-runner.js` created as proper re-export entry points

---

#### Sprint 2 — Data Integrity (7 fixes)

**Files modified:** `src/orchestration/env-comparison.js`, `src/utils/contract-validator.js`, `src/utils/session-manager.js`, `src/utils/github-reporter.js`, `src/cli/init.js`, `src/utils/flow-runner.js`, `src/orchestration/crawl-and-report.js`

1. **GAP-12** — `env-comparison.js`: `Promise.allSettled([capturePage, capturePage])` → sequential `await` calls (concurrent navigation on shared MCP corrupts both captures)
2. **GAP-09** — `contract-validator.js`: `if (!contract?.url) return false` guard before `.startsWith` crash
3. **GAP-07** — `session-manager.js`: `JSON.parse(readFileSync)` in `restoreSession` wrapped in try/catch
4. **GAP-10** — `github-reporter.js`: `GITHUB_TOKEN` presence check at top of `ghFetch`
5. **GAP-11** — `cli/init.js`: `fs.mkdirSync(path.dirname(targetsPath), { recursive: true })` before `writeFileSync`
6. **GAP-08** — `flow-runner.js`: `INJECT_ERROR_LISTENER` defined and re-injected after every `navigate` action (error listener destroyed by navigation was never restored)
7. **GAP-13** — `crawl-and-report.js`: inline `INTERNAL_LINKS_SCRIPT` removed; imported from `codebase-analyzer.js` (single source of truth)

---

#### Sprint 3 — Accuracy (7 fixes)

**Files modified:** `src/utils/lighthouse-checker.js`, `src/utils/snapshot-analyzer.js`, `src/cli/init.js`, `src/utils/session-manager.js`, `test-harness/validate.js`, `src/orchestration/slack-notifier.js`

1. **GAP-17** — `lighthouse-checker.js`: `audit.score == null || audit.score !== 0` — explicit null guard prevents null-score audits from reaching `violations.push`
2. **GAP-20** — `lighthouse-checker.js`: camelCase fallback added for Lighthouse category key lookup (`bestPractices` alongside `best_practices`)
3. **GAP-18** — `snapshot-analyzer.js`: `placeholder` removed as accepted form label — WCAG 2.1 §3.3.2 compliance; only `<label for>`, `aria-label`, `aria-labelledby`, enclosing `<label>` accepted
4. **GAP-19** — `cli/init.js`: guard before `.env` write — warns and skips if file already exists (prevents overwriting real credentials on re-run)
5. **GAP-16** — `session-manager.js`: lock file (`sessionFile + '.lock'`) with exclusive `'wx'` open in `refreshSession` — concurrent shards skip redundant login flows
6. **GAP-15** — `test-harness/validate.js`: staging server startup wrapped in its own try/catch — failure no longer aborts all 64 test blocks
7. **GAP-23** — `slack-notifier.js`: `slackPostWithBackoff` helper wraps both `chat.postMessage` calls with 3-attempt retry on 429/rate-limited

---

#### Sprint 4 — Hardening (5 fixes, 4 pre-correct)

**Files modified:** `src/utils/flow-runner.js`, `src/utils/hover-analyzer.js`, `src/utils/baseline-manager.js`, `src/utils/seo-analyzer.js`

1. **GAP-25** — `flow-runner.js`: `e.message ?? String(e.reason ?? e)` in `no_js_errors` message — prevents `"undefined; undefined"` for `unhandledrejection`-type errors
2. **GAP-22** — `hover-analyzer.js`: warning comment on `nth-of-type` parent-scoping limitation in `buildSelector`
3. **GAP-24** — `baseline-manager.js`: lock file (`trendsFile + '.lock'`) with exclusive `'wx'` open in `appendTrend` — prevents concurrent shard corruption of `trends.json`
4. **GAP-26** — `baseline-manager.js`: `GITHUB_REF_NAME` / `CI_COMMIT_BRANCH` / `BRANCH_NAME` env var fallbacks added in `getCurrentBranch` between git strategy and hard-coded `'default'`
5. **GAP-30** — `seo-analyzer.js`: `SEO_ANALYSIS_SCRIPT` now captures `ogImageUrl`; `parseSeoAnalysisResult` emits `seo_og_image_relative_url` warning when the value doesn't start with `http://` or `https://`

**Pre-correct gaps (no change needed):**
- GAP-21: `memory-analyzer.js` already had `finally { fs.unlinkSync(filePath) }`
- GAP-27: `css-analyzer.js` `CSS_ANALYSIS_SCRIPT` already an arrow function
- GAP-28: `html-reporter.js` already inlines screenshots as base64 data URIs
- GAP-29: `route-discoverer.js` `discoverFromSitemap` already had `AbortSignal.timeout(10000)`

---

#### Documentation updated this session

- `argus-v4-strategy.md` (new) — 30-gap audit with code evidence, severity tiers, sprint plan
- `README.md` — detection count 105 → 106; added `seo_og_image_relative_url` row; form label note updated (placeholder excluded per WCAG)
- `solution.md` — key implementation rules updated (callable arrow function requirement, injection order, screenshot content type, sequential env-comparison); v4 sprint tables added as §18
- `session.md` — this entry
- `SKILL.md` — not updated this session (no new detection phases added; v4 was bug fixes)

---

## Where to Resume Next Session

### All Phases + v4 Quality Audit Complete

Test harness: **276/276 hard assertions** (64 blocks, 39 detection categories, 46 fixture pages). All code phases and gap fixes complete.

**Operational next steps:**
1. **Verify test harness against live Chrome**:
   ```bash
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
   npm run test:harness   # Expected: 276/276 hard assertions
   ```
2. **Configure for a real target app**:
   ```bash
   npm run init   # Interactive wizard: URL → source dir → Slack → GitHub → writes .env + targets.js
   ```
3. **Push to GitHub** (all local commits through Session 21)
4. **Add GitHub Secrets** (repo → Settings → Secrets → Actions):
   - `TARGET_STAGING_URL` *(required)*
   - `GITHUB_TOKEN` *(optional — for C2 PR comment + commit status)*
   - `SLACK_BOT_TOKEN` *(optional — omit to use HTML report mode in CI)*

---

## Key Decisions Made in v4 (Don't Re-Debate)

- **`evaluate_script` callable requirement** — `function` param must be `'() => expr'` or `'() => { ... }'`. IIFEs and bare expressions silently fail via Chrome CDP `Runtime.callFunctionOn`.
- **Inject AFTER navigate** — all `INJECT_*` listener scripts run AFTER `navigate_page` + settle. Navigation destroys prior page context. `flow-runner.js` re-injects after each `navigate` step.
- **`take_screenshot` returns `type: 'image'`** — not `type: 'text'`; `mcp-client.js tool()` now handles both branches and returns `{ data, mimeType }` for screenshots.
- **Sequential env-comparison** — `capturePage(dev)` then `capturePage(staging)` sequentially. Concurrent `navigate_page` on one shared MCP client interleaves responses.
- **`og:image` absolute URL required** — relative values are valid HTML but invalid Open Graph; flagged as `seo_og_image_relative_url`.
- **`placeholder` is not an accessible name** — removed from `snapshot-analyzer.js` form label check. Only `<label for>`, `aria-label`, `aria-labelledby`, enclosing `<label>` count.
- **Lock files for concurrent shard ops** — `refreshSession` and `appendTrend` both use `fs.openSync(lockFile, 'wx')` (exclusive create) to prevent duplicate login flows and trend file corruption when `ARGUS_CONCURRENCY > 1`.

---

## Previous Session: 2026-04-27 (Sessions 17 + 18 + 19 + 20)

### What Was Accomplished

**All C-phases complete: C1 (codebase cross-reference), C2 (GitHub PR integration), C3 (auto route discovery), and C4 (argus init CLI) shipped and all gaps fixed. Test harness: 276/276 hard assertions (64 blocks, 39 categories, 46 fixture pages). Documentation fully updated.**

---

#### Phase C1 — Codebase Cross-Reference

**Files added/modified:**
- `src/utils/codebase-analyzer.js` (new) — four exports:
  - `auditEnvVariables(sourceDir, envFile)` — scans source for `process.env.X`, cross-checks against `.env` file, emits `env_var_missing` warnings for undeclared vars
  - `detectFeatureFlagLeakage(sourceDir, envFile)` — finds `if (process.env.X)` / `process.env.X === 'true'` patterns where the var is falsy/unset in `.env`; emits `feature_flag_leakage` warnings
  - `enrichErrorsWithSource(findings)` — parses stack frames from console error messages to file:line; emits `error_source_linked` info findings with `stackFrames[]` array
  - `detectDeadRoutes(baseUrl, links, knownPaths)` — HEAD-fetches each unique internal link, flags 404 responses as `dead_route` warnings; skips known/already-tested paths
  - `INTERNAL_LINKS_SCRIPT` — exported `() => [...]` expression for harvesting anchor hrefs in-browser; uses `a.getAttribute('href')` (not `a.href`) to correctly filter `#section` anchors
- `src/orchestration/crawl-and-report.js` — wired in C1: `analyzeCodebase` + `detectDeadRoutes` run after route loop; `report.codebase[]` added to report object; C1 Slack dispatch gated on `isNew !== false`
- `src/utils/severity-overrides.js` — added `report.codebase = processFindings(report.codebase)` so C1 findings respect `severityOverrides` config
- `src/utils/baseline-manager.js` — extended `loadBaseline`, `saveBaseline`, `applyBaseline` to cover `report.codebase[]`; `isNew` annotation applies to all three finding sources
- `test-harness/pages/dead-routes.html` (new) — fixture with 2 dead internal hrefs (`/argus-dead-route-alpha`, `/argus-dead-route-beta`) + 1 valid link + external links to skip
- `test-harness/harness-config.js` — dead-routes.html route added
- `test-harness/source-fixture/app.js` (new) — JS source fixture with `MISSING_VAR`, `FEATURE_DISABLED`, `FEATURE_ENABLED` for blocks [51][52]
- `test-harness/validate.js` — blocks [51][52][53][54] added (env audit, feature flag, error-source, dead routes)
- `src/config/targets.js` — `codebase` export added with `sourceDir`/`envFile` env var hooks

**C1 Audit gaps fixed (6 total):**
1. `INTERNAL_LINKS_SCRIPT` import conflict — SyntaxError from importing AND declaring same const in `crawl-and-report.js`; fixed by removing the import
2. Anchor filter used `a.href` (absolute URL) — `startsWith('#')` always missed hash-only hrefs; fixed to `a.getAttribute('href')`
3. Summary rebuild excluded `codebase[]` — summary.total/critical/warning/info zeroed for C1 findings; fixed by adding third loop
4. `applyOverrides` blindspot — `codebase[]` findings never processed; fixed in `severity-overrides.js`
5. No baseline coverage for `codebase[]` — all three baseline functions extended
6. Test [54] double-parse — `JSON.parse(String(Array))` produces garbled output; fixed with `Array.isArray` guard before parse

---

#### Phase C2 — GitHub PR Integration

**Files added/modified:**
- `src/utils/github-reporter.js` (new) — six exports:
  - `formatPrComment(report, diff)` — pure function; builds Markdown PR comment with findings table; embeds `<!-- argus-qa-report -->` sentinel; suppresses New Findings section on `isFirstRun` (would misleadingly flag everything as new); resolvedCount = route + flow resolved combined; caps tables at 15 rows
  - `buildStatusPayload(report, diff)` — pure function (no env var reads); state `'failure'` when new criticals exist (blocks merge), `'success'` otherwise; context `'argus-qa'`
  - `postPrComment(report, diff)` — GET existing comments, find by COMMENT_MARKER, PATCH if found / POST if not; idempotent (one comment per PR, no spam)
  - `setCommitStatus(report, diff)` — calls `buildStatusPayload`, attaches `ARGUS_REPORT_URL` here (not in pure builder), POST to `/repos/{repo}/statuses/{sha}`
  - `isGitHubConfigured()` — returns `!!(GITHUB_TOKEN && GITHUB_REPOSITORY)`; guards both PR comment and commit status
  - `reportToGitHub(report, diff)` — orchestrates C2.3 + C2.4 in parallel; only runs if respective env vars are set; errors are caught/warned, never blocking
- `src/orchestration/crawl-and-report.js` — `isGitHubConfigured` guard + `reportToGitHub` call added after Slack dispatch
- `src/config/targets.js` — C2 env var documentation block added
- `test-harness/validate.js` — blocks [55][56] added (pure unit tests, no browser needed)

**C2 Audit gaps fixed (7 total):**
1. First-run New Findings table — all findings shown as "new" on first run is misleading; fixed with `&& !isFirst` guard
2. `resolvedCount` missing flow resolved — was `diff?.resolvedCount ?? 0`; fixed to `(diff?.resolvedCount ?? 0) + (diff?.flowResolvedCount ?? 0)`
3. `buildStatusPayload` not truly pure — read `process.env.ARGUS_REPORT_URL`; moved to `setCommitStatus`
4. `Content-Type` on GET — `ghFetch` sent `Content-Type: application/json` on all requests; fixed to only set when `body` truthy
5. Dead import — `isGitHubConfigured` imported in validate.js but unused; removed
6. Weak test [55d] — `comment.includes('1')` trivially true; replaced with exact table row match
7. Missing first-run guard test — added `[55h]` asserting New Findings absent on first run

---

---

#### Phase C3 — Auto Route Discovery

**Files added/modified:**
- `src/utils/route-discoverer.js` (new) — five exports:
  - `discoverFromSitemap(baseUrl)` — fetches `/sitemap.xml`, follows one sitemap-index level, filters same-origin `<loc>` paths; returns `[]` on any error; 10-second abort timeout
  - `discoverFromNextJs(sourceDir)` — scans `pages/` (Next 12) and `app/` (Next 13+); strips route groups `(auth)`, skips `_app`/`_document`/api/; collapses `index` to parent; dynamic `[param]` routes skipped (no crawlable URL)
  - `discoverFromReactRouter(sourceDir)` — greps JS/TS source for `<Route path="...">` and `{ path: "..." }` patterns; only absolute static paths kept; experimental, off by default
  - `mergeRoutes(manualRoutes, discoveredPaths)` — pure dedup merge; manual config (critical, waitFor) always preserved; new routes get `discovered: true`
  - `discoverRoutes(baseUrl, sourceDir, autoDiscover, manualRoutes)` — orchestrator; returns `manualRoutes` immediately if `autoDiscover` is falsy (null guard)
- `src/config/targets.js` — `autoDiscover` export added (`{ sitemap: true, nextjs: true, reactRouter: false }`)
- `src/orchestration/crawl-and-report.js` — `discoverRoutes` wired into `runCrawl`; bypassed when `routeOverrides` is passed (harness uses fixture-specific routes)
- `test-harness/pages/sitemap.xml` (new) — fixture sitemap with 4 same-origin routes + 1 off-origin URL for exclusion test
- `test-harness/nextjs-fixture/` (new directory, 10 files) — pages/ + app/ structure including route group `(auth)/login/`, dynamic `[slug].jsx`, `_app.jsx`, `api/` entries for exclusion tests
- `test-harness/validate.js` — blocks [57]–[61] added (sitemap, Next.js, React Router, mergeRoutes, orchestrator)

**C3 Audit gaps fixed (8 total):**
1. Gap 5 (High) — Dynamic `[param]` routes included and would 404 on crawl; fixed with `urlParts.some(p => p.includes('['))` filter in both pages/ and app/ branches
2. Gap 6 (Medium) — Sitemap-index `<loc>` match `/<loc>(...)<\/loc>/i` could match a `<url><loc>` entry first; fixed to `/<sitemap[^>]*>[\s\S]*?<loc>(...)<\/loc>/i`
3. Gap 1 (Medium) — `discoverRoutes(null autoDiscover)` destructures `{}` and defaults to `true/true/false`, still runs discovery; fixed with `if (!autoDiscover) return manualRoutes` early return
4. Gap 8 (Low) — No test asserting `[param]` routes are excluded; added `[58f]` assertion
5. Gap 3 (Medium) — No test for `sourceDir` with neither `pages/` nor `app/`; added `[58g]` with temp dir
6. Gap 4 (Medium) — No test for non-existent `sourceDir` in `discoverFromReactRouter`; added `[59d]`
7. Gap 2 (Medium) — No end-to-end orchestrator test; added block `[61]` (4 assertions: array, adds routes, preserves config, null guard)
8. Gap 7 (Low) — `re.lastIndex = 0` before `matchAll` is harmless no-op (matchAll always fresh); left as-is (defensive)

---

#### Phase C4 — `argus init` CLI

**Files added/modified:**
- `src/cli/init.js` (new) — four exports + interactive wizard:
  - `detectFramework(projectRoot)` — reads `package.json`; returns `'nextjs'` (next dep), `'react-router'` (react-router-dom/react-router dep), or `'unknown'`; returns `'unknown'` for missing/invalid paths
  - `generateTargetsJs(routes, options)` — renders complete `targets.js` with all routes, `autoDiscover` block tuned to detected framework, `codebase` with env var hooks, blank `auth`/`flows`/`apiContracts`; empty routes falls back to default Home seed
  - `generateEnvFile(options)` — renders `.env` with user values substituted; blanks/missing values rendered as commented-out placeholders
  - `main()` — 4-step interactive wizard (target URLs → source dir → route discovery → Slack/GitHub); guarded by `process.argv[1] === __filename` so import for testing never runs it
- `package.json` — added `"init": "node src/cli/init.js"` script + `"bin": { "argus": "src/cli/init.js" }` for `npx argus init`
- `test-harness/validate.js` — blocks [62]–[64] added (detectFramework, generateTargetsJs, generateEnvFile pure unit tests)

#### Documentation updated this session

- `solution.md` — complete rewrite; covers all phases A1–A6, B1–B5, C1, C2, C3, C4, D1–D8.5; report object shape; flow DSL; phase tables; env vars reference; harness architecture; key implementation rules
- `session.md` — this file
- `README.md` — stats updated (276 assertions / 64 blocks); project structure updated (added route-discoverer.js, cli/init.js); What It Does table updated with C1–C4 features
- `test-harness/README.md` — stats updated (64 blocks / 276 assertions / 39 categories / 46 fixtures); added rows [57]–[64]

---

#### SKILL.md

- §14 stats: 64 blocks / 276 assertions / 39 categories / 46 fixtures
- §14a: Phase C2 reference (env vars table, workflow snippet, design notes)
- §14b: Phase C3 reference (autoDiscover config, merge behavior, Next.js route groups, null guard, dynamic route exclusion)
- §14c: Phase C4 reference (init CLI usage, detectFramework, generateTargetsJs, generateEnvFile)

---

## Where to Resume Next Session

### All Phases Complete (C1–C4) — Operational Deployment Only

Test harness: **276/276 hard assertions** (64 blocks, 39 detection categories, 46 fixture pages). All code phases shipped. No more planned phases.

**No code phases remaining.** Resume means operational work:

**Operational steps:**
1. **Verify test harness against live Chrome**:
   ```bash
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir=%TEMP%\chrome-argus
   npm run test:harness   # Expected: 276/276 hard assertions
   ```
2. **Configure for a real target app** (use the new C4 CLI):
   ```bash
   npm run init   # Interactive wizard: URL → source dir → Slack → GitHub → writes .env + targets.js
   ```
3. **Push to GitHub** (all local commits through Sessions 17–20)
4. **Add GitHub Secrets** (repo → Settings → Secrets → Actions):
   - `TARGET_STAGING_URL` *(required)*
   - `GITHUB_TOKEN` *(optional — for C2 PR comment + commit status)*
   - `SLACK_BOT_TOKEN` *(optional — omit to use HTML report mode in CI)*
5. **Wire up C2 in GitHub Actions workflow** — add `GITHUB_PR_NUMBER: ${{ github.event.pull_request.number }}` to workflow env block

---

## Key Decisions Already Made (Don't Re-Debate)

- **`a.getAttribute('href')` not `a.href`** — DOM property resolves to absolute URL, breaking `startsWith('#')` checks for hash anchors
- **`codebase[]` through the full pipeline** — `applyOverrides` + `applyBaseline` + Slack dispatch + GitHub PR comment all cover codebase findings, same as routes/flows
- **`isNew !== false` filter for Slack** — ensures findings without `isNew` (no baseline yet) still appear in alerts; backwards-compatible
- **Pure function design for C2** — `formatPrComment` and `buildStatusPayload` read no env vars; directly unit-testable without mocking; `ARGUS_REPORT_URL` attached by `setCommitStatus`
- **COMMENT_MARKER `<!-- argus-qa-report -->`** — sentinel embedded in PR comment body for idempotent in-place update; never remove it
- **No New Findings on first run** — all findings would be "new" on first run; showing them is misleading; suppressed with `isFirstRun` guard
- **`resolvedCount` = routes + flows** — `diff.resolvedCount` covers routes; `diff.flowResolvedCount` covers flows; must add both for accurate PR comment
- **`MAX_TABLE_ROWS = 15`** — GitHub PR comment limit is 65536 chars; cap rows to stay safe
- **C2 runs after Slack dispatch** — independent; either can fail without blocking the other
- **`process.argv[1] === __filename` guard in init.js** — pure ESM way to detect "is this the entry point"; importing init.js for test purposes never triggers the interactive wizard
- **`bin` field + `npm run init`** — `"bin": { "argus": "src/cli/init.js" }` enables `npx argus init` after publishing; `npm run init` for local use; no separate CLI framework needed
- **Pure function design for C4** — `detectFramework`, `generateTargetsJs`, `generateEnvFile` take only data params and do no I/O; `main()` is the only function that reads stdin/writes files; directly unit-testable in the harness without mocking
- **Empty routes → seed fallback in generateTargetsJs** — if discovery returns nothing (e.g., unreachable URL), a default `'/'` home route is rendered so the output is always a valid config
- **Dynamic `[param]` routes skipped** — `[slug]`, `[id]` etc. have no concrete URL to crawl; including them would produce 404s; filtered out in both pages/ and app/ branches of `discoverFromNextJs`
- **`discoverRoutes(null)` returns manual routes immediately** — `null autoDiscover` means "disabled"; early `if (!autoDiscover) return manualRoutes` guard prevents unintended discovery when the caller passes null
- **Sitemap-index `<loc>` match scoped to `<sitemap>` element** — prevents picking up a `<url><loc>` entry that appears before `<sitemap><loc>` in a mixed document
- **`routeOverrides` bypasses C3** — when harness passes specific fixture routes, auto-discovery is skipped entirely; prevents fixture server from being hit with sitemap fetches it doesn't serve
- **`reactRouter: false` default** — the `path: "..."` pattern fires on non-router contexts (config objects, etc.); conservative default avoids false positives until users opt in
- **Slack Bot API** (not Incoming Webhooks) — needed for file uploads + interactive buttons
- **`files.getUploadURLExternal` + PUT** — `files.upload` deprecated; pre-signed URL requires PUT not POST
- **`emulate` not `resize_page`** for viewport testing — `resize_page` does not update CSS viewport
- **`document.documentElement.clientWidth`** not `window.innerWidth` after emulate
- **`take_memory_snapshot` requires `{ filePath }`** — always pass `{ filePath: path.join(os.tmpdir(), ...) }`
- **Chrome state cleanup at harness start** — `localStorage.clear()` + cookie deletion prevents auth state from test [24] leaking into test [1]
- **B4 `crawlAndAnalyzeRoute` extraction** — route loop body extracted to named helper; called twice per route then merged

---

## Environment Setup Checklist (For New Machine / First Run)

- [ ] Node.js v20.19+ installed
- [ ] Chrome stable installed
- [ ] `npm install` in project root
- [ ] `.env` created from `.env.example` with real values (only `TARGET_DEV_URL` is required; Slack vars are optional)
- [ ] Chrome DevTools MCP registered: `claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest`
- [ ] To run test harness: Chrome with `--remote-debugging-port=9222`, then `npm run test:harness` (expected: 345/348 — 3 permanent MCP-limited failures: [49b], [67b], [68b])
- [ ] *(Optional — C1)* Set `ARGUS_SOURCE_DIR` + `ARGUS_ENV_FILE` in `.env` for codebase analysis
- [ ] *(Optional — C2)* Set `GITHUB_TOKEN` + `GITHUB_REPOSITORY` in `.env` for PR comment + commit status
- [ ] *(Optional — Slack only)* Slack App (BugBot) created with scopes: `chat:write`, `files:write`, `files:read`
- [ ] *(Optional — Slack only)* Slack channels created: `#bugs-critical`, `#bugs-warnings`, `#bugs-digest`
- [ ] *(Optional — Slack only)* BugBot invited to each channel: `/invite @BugBot`

---

## Previous Session: 2026-04-26 (Session 16)

### What Was Accomplished

**Phase D8.5 (upload_file flow step) shipped. Test harness: 210/210 hard assertions (50 blocks, 35 categories, 44 fixture pages). All D8 phases complete.**

#### Phase D8.5 — `upload_file` flow step

- `src/utils/flow-runner.js` — new `extractFileInputUid(snapResponse)` helper; new `upload_file` case in `runStep`
- `test-harness/pages/upload-issues.html` (new)
- `test-harness/pages/test-upload.txt` (new)
- `test-harness/validate.js` — block [50], 3 hard assertions

---

## Previous Session: 2026-04-25 (Session 15)

**Phases D8.3 (type_text) and D8.4 (drag) shipped. Test harness: 207/207 (49 blocks, 35 categories, 43 fixture pages).**

---

## Previous Session: 2026-04-25 (Session 14)

**Phases D8.1 (hover-state) and D8.2 (accessibility snapshot) shipped. Test harness: 200/200 (47 blocks, 33 categories, 41 fixtures).**

---

## Previous Session: 2026-04-25 (Session 13)

**Phases D7.5, D7.6, D7.7 shipped. Test harness: 192/192 (45 blocks, 31 categories, 39 fixtures).**

---

## Previous Session: 2026-04-21 (Session 12)

**Phases D1, D2.1, D2.3, D2.5, D3, D5, D6.1–D6.5 shipped. Test harness: 140/140 (36 blocks, 26 categories, 35 fixtures).**

---

## Previous Session: 2026-04-20 (Session 11)

**Phase B5 (User Flow Assertions) shipped. Test harness: 97/97 (27 blocks). Phase D documented.**

---

## Previous Session: 2026-04-19 (Sessions 7–10)

**Phases A1–A6 and B1–B4 complete. Test harness at 87/87 (26 blocks, 18 categories).**
