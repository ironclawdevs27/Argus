# Argus — Full Reference Documentation

This document contains the complete technical reference for Argus: all detection categories with per-finding severity tables, the full project file tree, key architectural decisions, analysis modes, and Slack routing details.

**See also:** [README.md](README.md) (quick start + setup) · [SKILL.md](SKILL.md) (MCP tool signatures + DSL) · [CLAUDE.md](CLAUDE.md) (contributor context)

---

## Table of Contents

1. [Detection Reference](#detection-reference)
   - [JavaScript Runtime](#javascript-runtime)
   - [Network & API](#network--api)
   - [Page Health](#page-health)
   - [CSS & Styling](#css--styling)
   - [Performance](#performance)
   - [Core Web Vitals & Bundle Size](#core-web-vitals--bundle-size)
   - [Accessibility (Basic)](#accessibility-basic)
   - [Deep Accessibility — axe-core (A12)](#deep-accessibility--axe-core-a12)
   - [SEO](#seo)
   - [Security](#security)
   - [Content Quality](#content-quality)
   - [Responsive / Mobile](#responsive--mobile)
   - [Network Performance](#network-performance)
   - [Memory Leaks](#memory-leaks)
   - [Runtime Anti-Patterns](#runtime-anti-patterns)
   - [Hover-State Bugs](#hover-state-bugs)
   - [Accessibility Snapshot Analysis](#accessibility-snapshot-analysis)
   - [Keyboard Accessibility](#keyboard-accessibility)
   - [HAR Network Baseline (N1)](#har-network-baseline-n1)
   - [Visual Regression (A8)](#visual-regression-a8)
   - [Figma Design Fidelity (D9)](#figma-design-fidelity-d9)
   - [Motion & Animation (A9)](#motion--animation-a9)
   - [Font Loading (A10)](#font-loading-a10)
   - [Form Validation (A11)](#form-validation-a11)
   - [Theme & Dark Mode (A7)](#theme--dark-mode-a7)
   - [Chrome DevTools Issues Panel](#chrome-devtools-issues-panel)
   - [Lighthouse Audits](#lighthouse-audits)
   - [Historical Baselines & Trends](#historical-baselines--trends)
   - [Flakiness Detection](#flakiness-detection)
   - [User Flow Assertions](#user-flow-assertions)
   - [Environment Regressions (dev vs staging)](#environment-regressions-dev-vs-staging)
   - [Codebase Cross-Reference (C1)](#codebase-cross-reference-c1)
   - [GitHub PR Integration (C2)](#github-pr-integration-c2)
   - [Network Request Origin Tagging](#network-request-origin-tagging)
2. [Analysis Modes](#analysis-modes)
   - [CSS Analysis Mode](#css-analysis-mode)
   - [Performance Budgets](#performance-budgets)
   - [Lighthouse Suite](#lighthouse-suite)
   - [Watch Mode](#watch-mode)
3. [Slack Channel Routing](#slack-channel-routing)
4. [Slack Slash Command Setup](#slack-slash-command-setup)
5. [Project File Tree](#project-file-tree)
6. [Key Technical Decisions](#key-technical-decisions)
7. [Known MCP Tool Limitations](#known-mcp-tool-limitations)

---

## Detection Reference

Argus runs **32 analysis engines** per run and detects **149 distinct issue types**. Every finding carries a `severity` (`critical` / `warning` / `info`), the affected `url`, and a human-readable `message`.

### JavaScript Runtime

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Uncaught exceptions — `TypeError`, `ReferenceError`, etc. | `window.onerror` listener injected before page load |
| 🔴 Critical | Unhandled Promise rejections | `unhandledrejection` event listener injected into the page |
| 🔴 Critical | `console.error` calls (on critical routes) | Chrome DevTools `list_console_messages` |
| 🟡 Warning | `console.error` calls (on non-critical routes) | Chrome DevTools `list_console_messages` |
| 🔵 Info | `console.warn` deprecation notices and warnings | Chrome DevTools `list_console_messages` |

---

### Network & API

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | HTTP 5xx server errors on any request | `list_network_requests` → status ≥ 500 |
| 🔴 Critical | 401/403 auth failures on a **critical route** | `list_network_requests` → status 401 or 403 + `routeIsCritical` flag |
| 🔴 Critical | API endpoint called 5+ times in one page load — likely an infinite loop | Network frequency grouping by normalised URL + method |
| 🟡 Warning | 401/403 auth failures on a non-critical route | `list_network_requests` → status 401 or 403 (non-critical path) |
| 🟡 Warning | HTTP 4xx client errors (404, 422, 429, etc.) | `list_network_requests` → status 400–499 (non-auth) |
| 🟡 Warning | API endpoint called 3–4 times — likely a double-fetch bug | Frequency grouping → 3 ≤ count ≤ 4 (check `useEffect` deps) |
| 🟡 Warning | Redirect chain longer than 2 hops | Navigation Timing `redirectCount` after page settle |
| 🟡 Warning | Broken internal link — `<a href>` target returns HTTP 404 | `<a>` elements harvested via `evaluate_script`, verified against `list_network_requests` |
| 🔵 Info | API endpoint called twice — may be intentional prefetch | Frequency grouping → count = 2 |
| 🔵 Info | API call summary per page load (total calls, unique endpoints, duplicates) | Aggregated network analysis |

---

### Page Health

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Blank or near-empty page — less than 50 characters of body text | `document.body.innerText` length check after navigation |
| 🟡 Warning | Expected element never appeared — page may have crashed mid-load | `waitFor` selector timeout after 10 seconds |

---

### CSS & Styling

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | `!important` cascade conflict | CSS rule walk: property declared with `!important` on same element |
| 🟡 Warning | Component style leak — BEM selector in the wrong stylesheet | `.block__element` selector in a file whose name doesn't match `block` |
| 🟡 Warning | React inline style overriding a stylesheet declaration on the same element | `style=""` attribute vs. matching CSS rule, `__reactFiber` presence confirmed |
| 🔵 Info | CSS property declared by multiple rules on the same element | Computed style walk across all matched rules per key element |
| 🔵 Info | Unused CSS rules — selectors matching no element on the page (> 10 flagged) | `querySelectorAll(selector).length === 0` for every rule |
| 🔵 Info | CSS Modules detected — hashed class names found on DOM elements | Pattern `_ComponentName_class_hash` matched on live DOM |
| 🔵 Info | SCSS source map found — compiled CSS traced back to `.scss` origin file | `sourceMappingURL` comment in `<style>` tags |

---

### Performance

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | LCP > 2500ms — largest element took too long to paint | Chrome performance trace → `performance_analyze_insight` |
| 🟡 Warning | CLS > 0.1 — layout shifted significantly after initial render | Chrome performance trace |
| 🟡 Warning | FID / TBT > 100ms — main thread blocked during interaction | Chrome performance trace |
| 🟡 Warning | TTFB > 800ms — server took too long to send the first byte | Chrome performance trace |

---

### Core Web Vitals & Bundle Size

Captured directly via the browser **Performance API** — works in headless Chrome without Lighthouse.

| Severity | Finding Type | Threshold |
|---|---|---|
| 🟡 Warning | `perf_bundle_large` (JS) | ≥ 500 KB |
| 🔴 Critical | `perf_bundle_large` (JS) | ≥ 2 MB |
| 🟡 Warning | `perf_bundle_large` (CSS) | ≥ 150 KB |
| 🔵 Info | `perf_vitals_summary` | Always emitted — LCP, CLS, FCP, TTI, TTFB values |

Metrics: **LCP** (Largest Contentful Paint), **CLS** (Cumulative Layout Shift), **FCP** (First Contentful Paint), **TTI** (`domInteractive`), **TTFB** (Time to First Byte).

---

### Accessibility (Basic)

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Lighthouse accessibility score below 50/100 | Lighthouse audit via `lighthouse_audit` |
| 🟡 Warning | Lighthouse accessibility score 50–89/100 | Lighthouse audit |
| 🟡 Warning | Missing alt text on images | Individual Lighthouse audit check |
| 🟡 Warning | Insufficient color contrast ratio | Individual Lighthouse audit check |
| 🟡 Warning | Missing ARIA labels on interactive elements | Individual Lighthouse audit check |
| 🟡 Warning | Keyboard navigation broken or unreachable elements | Individual Lighthouse audit check |

---

### Deep Accessibility — axe-core (A12)

axe-core 4.12 is injected into every audited page — runs 80+ WCAG 2.x A/AA rules not covered by existing analyzers.

| Severity | Finding Type | Description |
|---|---|---|
| 🔴 Critical | `a11y_axe_violation` | axe impact = `critical` |
| 🟡 Warning | `a11y_axe_violation` | axe impact = `serious` or `moderate` |
| 🔵 Info | `a11y_axe_violation` | axe impact = `minor` |
| 🟡 Warning | `a11y_colorblind_risk` | Element safe for full-color vision fails WCAG AA for protanopia or deuteranopia (Machado CVD matrices) |
| 🔵 Info | `a11y_deep_summary` | Always emitted — total violation count + CVD risk count |

Deduplicates with `snapshot-analyzer` to avoid double-reporting the same element.

---

### SEO

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | Missing `<meta name="description">` | DOM inspection via `evaluate_script` |
| 🟡 Warning | Missing Open Graph tags (`og:title`, `og:description`, `og:image`) | DOM inspection |
| 🟡 Warning | `og:image` URL is relative — OG requires an absolute URL | DOM inspection + URL prefix check |
| 🟡 Warning | Multiple `<h1>` tags on one page | `querySelectorAll('h1').length > 1` |
| 🟡 Warning | Zero `<h1>` tags — page has no primary heading | `querySelectorAll('h1').length === 0` |
| 🟡 Warning | Generic page title (< 10 characters or default placeholder) | DOM inspection + length check |
| 🟡 Warning | Missing `<link rel="canonical">` | DOM inspection via `evaluate_script` |
| 🟡 Warning | Missing `<meta name="viewport">` | DOM inspection via `evaluate_script` |

---

### Security

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Auth token found in `localStorage` or `sessionStorage` | `evaluate_script` walks storage keys for token patterns |
| 🔴 Critical | Sensitive token in the page URL (query param or hash) | URL pattern match against `window.location.href` |
| 🔴 Critical | `eval()` call detected in page scripts | `evaluate_script` AST-style text scan of inline `<script>` tags |
| 🔴 Critical | CSP violation — inline script or external resource blocked by CSP | Chrome DevTools Issues panel |
| 🟡 Warning | Sensitive data (`password`, `token`, `secret`) logged to the console | `list_console_messages` + keyword match |
| 🟡 Warning | Missing `Content-Security-Policy` response header | `fetch(location.href)` inside the page → response headers check |
| 🟡 Warning | Missing `X-Frame-Options` response header | Same headers fetch |
| 🟡 Warning | Cross-origin `<iframe>` without `sandbox` attribute | `evaluate_script` checks `iframe[src]` for missing sandbox |
| 🟡 Warning | Page served over plain HTTP with no HTTPS upgrade | URL protocol check (`http://` + non-localhost) |
| 🔵 Info | Cookie without `HttpOnly` flag (JS-visible cookies only) | `document.cookie` inspection |
| 🔵 Info | Deprecated browser API usage | Chrome DevTools Issues panel |
| 🟡 Warning | External `<script>` or `<link rel=stylesheet>` missing `integrity` attribute (SRI) | DOM scan for cross-origin tags without `integrity`; capped at 20 per page |
| 🟡 Warning | Source map exposed in production — `.js.map` / `.css.map` file publicly accessible | Network request URL scan for `*.map` extensions |
| 🟡 Warning | Open redirect parameter in URL — `?redirect=`, `?return=`, `?goto=`, etc. | Network request URL parameter scan (regex: `redirect|return|next|dest|destination|goto|redir|forward`) |
| 🟡 Warning | npm dependency with known CVE (high or critical severity) | `npm audit --json` subprocess; `{ shell: true }` for Windows `npm.cmd` compatibility |

---

### Content Quality

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | `null` or `undefined` rendered as visible text | DOM text scan for literal "null" / "undefined" strings |
| 🟡 Warning | Lorem ipsum / placeholder copy still in production | DOM text scan for "lorem ipsum" and common placeholder strings |
| 🟡 Warning | Broken image (404 or failed to load) | `evaluate_script` checks `img.naturalWidth === 0` on all images |
| 🔵 Info | Empty data list — `<ul>`, `<ol>`, or `<select>` with no children | DOM structure check |

---

### Responsive / Mobile

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Horizontal overflow at mobile / tablet viewport (≤ 768px) | `emulate` at 375px and 768px → `document.documentElement.scrollWidth > clientWidth` |
| 🟡 Warning | Touch target smaller than 44×44px at mobile or tablet viewport | CSS computed size check on interactive elements at 375px and 768px |
| 🔵 Info | Responsive screenshot grid — snapshots at 375/768/1024/1440px | `emulate` at 4 breakpoints, screenshots dispatched to Slack |

> **Note on mobile CPU throttling:** Applies 4× CPU throttle (`emulate({ cpuThrottlingRate: 4 })`) during ≤ 768px breakpoints — finds layout reflow and animation jank that only manifests under realistic mobile CPU pressure.

---

### Network Performance

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | API response time > 3000ms | `PerformanceObserver` entries for `fetch`/XHR calls |
| 🔴 Critical | API response payload > 2 MB | `list_network_requests` → response body size |
| 🟡 Warning | API response time > 1000ms | Same observer, lower threshold |
| 🟡 Warning | API response payload > 500 KB | Same, lower threshold |
| 🟡 Warning | Cross-origin (third-party) script TTFB > 2000ms | HAR `timing.wait` from `list_network_requests`; cross-origin only |

---

### Memory Leaks

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | > 100 detached DOM nodes in V8 heap | `take_heapsnapshot` → parse flat `nodes` array for "Detached Xxx" names |
| 🟡 Warning | > 10 detached DOM nodes in V8 heap | Same snapshot parse, lower threshold |
| 🟡 Warning | Heap grew > 2 MB after navigate-away + navigate-back | `performance.memory.usedJSHeapSize` delta across round-trip (soft — GC-dependent) |

---

### Runtime Anti-Patterns

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | Synchronous `XMLHttpRequest` — blocks main thread | `XMLHttpRequest.open` patched via `addScriptToEvaluateOnNewDocument`; `async === false` calls recorded |
| 🟡 Warning | `document.write` / `document.writeln` called | `document.write` and `document.writeln` patched before page load |
| 🟡 Warning | Long task > 50ms on the main thread | `PerformanceObserver({ entryTypes: ['longtask'] })` injected before page load |
| 🔴 Critical | CORS policy violation | `list_console_messages` + pattern match for `"has been blocked by CORS policy"` |
| 🟡 Warning | Service worker registration failure | `navigator.serviceWorker.register` patched; `.catch()` records failing script URL |
| 🔵 Info | Same-origin static asset served without `Cache-Control` or `ETag` | `performance.getEntriesByType('resource')`, HEAD-fetches each unique same-origin asset |

---

### Hover-State Bugs

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning / 🔴 Critical | `[aria-haspopup]` element whose controlled popup does not become visible after hover | `hover` dispatches `mousemove`; `evaluate_script` checks `aria-expanded` + `getComputedStyle` on controlled element; critical on routes with `critical: true` |
| 🟡 Warning | `[data-tooltip]` element whose `[role="tooltip"]` is not visible after hover | Hover + `evaluate_script` checks tooltip opacity, `display`, `visibility`, `offsetHeight` |

---

### Accessibility Snapshot Analysis

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | Interactive element with no accessible name | `take_snapshot` + `evaluate_script` checks text, `aria-label`, `aria-labelledby`, `title`, `alt` |
| 🟡 Warning | Form control with no associated label | Checks `label[for]`, ancestor `<label>`, `aria-label`, `aria-labelledby` (placeholder excluded per WCAG 2.1 §3.3.2) |
| 🟡 Warning | Landmark role appearing more than once without distinct `aria-label` | Counts `[role=X]` instances across `main`, `banner`, `contentinfo`, `navigation`, `search`, `complementary`, `form`, `region` |
| 🟡 Warning | Heading level skip — h1→h3 or h4→h6 | DOM walk of `h1`–`h6`; detects gaps > 1 between consecutive heading levels |
| 🟡 Warning | `aria-expanded` button has no `aria-controls` or references a non-existent element | `evaluate_script` checks `[aria-expanded]` for missing/broken `aria-controls` pointer |

---

### Keyboard Accessibility

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | Button or focusable element has `outline:0` with no `box-shadow` fallback | `press_key({ key: 'Tab' })` walk + `evaluate_script` reads `document.activeElement` computed style |

---

### HAR Network Baseline (N1)

Records all network requests per route as a HAR-style baseline on first run. Subsequent runs diff current traffic against the baseline.

| Severity | Finding Type | Description |
|---|---|---|
| 🔵 Info | `har_baseline_created` | First run — baseline saved |
| 🟡 Warning | `har_new_request` | Request not present in baseline |
| 🟡 Warning | `har_missing_request` | Baseline request no longer made |
| 🟡 Warning / 🔴 Critical | `har_status_changed` | HTTP status differs from baseline (critical if ≥ 400) |
| 🔵 Info | `har_comparison_summary` | Always emitted — new/missing/changed counts |

URL normalisation strips cache-busters (`v`, `ver`, `_`, `cb`, `ts`, `t` query params) to reduce false positives. Baselines stored in `reports/baselines/har/`.

---

### Visual Regression (A8)

Per-route screenshot baseline comparison using pixelmatch.

| Severity | Finding Type | Threshold |
|---|---|---|
| 🔵 Info | `visual_baseline_created` | First run — baseline PNG saved |
| 🟡 Warning | `visual_regression` | ≥ 0.1% pixels changed |
| 🔴 Critical | `visual_regression` | ≥ 5% pixels changed |
| 🔵 Info | `visual_diff_summary` | Always emitted — exact diff% + pixel counts |

Pass `updateBaseline: true` to `argus_visual_diff` to reset the baseline after intentional UI changes. Baselines stored in `reports/baselines/screenshots/`.

---

### Figma Design Fidelity (D9)

`argus_design_audit(url, figmaFrameUrl)` compares every extracted Figma node against the live DOM. Requires `FIGMA_API_TOKEN`.

**13 finding types:**

| Finding Type | What it compares | Threshold |
|---|---|---|
| `design_token_mismatch` | CSS token values (generic) | — |
| `design_component_missing` | Figma component not found in DOM | — |
| `design_color_mismatch` | Fill color — RGB Euclidean distance | 22 |
| `design_typography_mismatch` | fontSize, fontWeight, lineHeight, fontFamily, letterSpacing | per-property |
| `design_spacing_mismatch` | Padding (Auto Layout) | 2px |
| `design_radius_mismatch` | Border-radius, per-corner | 1px each corner |
| `design_bounds_overflow` | Bounding-box overflow | 5px |
| `design_position_drift` | Absolute x/y vs Figma bounds (scroll-corrected) | 20px |
| `design_stroke_mismatch` | Border color + weight | — |
| `design_shadow_mismatch` | Box-shadow — offsetX/Y, blur, spread, color RGB | offsetX/Y 1px, blur 2px, spread 2px |
| `design_opacity_mismatch` | Opacity (when Figma < 100%) | 10% |
| `design_gap_mismatch` | columnGap / rowGap by layoutMode | 2px |
| `design_text_mismatch` | textContent vs Figma `characters` field | — |
| `design_fidelity_summary` | Aggregates all 13 counts | Always emitted |

**Selector fallback chain** (tried in order per Figma node):
1. `[data-testid="slug"]`
2. `[aria-label="name"]`
3. `#slug`
4. `.slug`

Explicit selectors (e.g., `#hero`) are honoured verbatim without fallback.

---

### Motion & Animation (A9)

Detects pages that animate without respecting `prefers-reduced-motion` — a WCAG 2.1 SC 2.3.3 violation.

| Severity | Finding Type | Description |
|---|---|---|
| 🟡 Warning | `motion_no_reduced_motion_query` | CSS animation/transition without `@media (prefers-reduced-motion)` guard |
| 🟡 Warning | `motion_autoplay_no_controls` | `<video autoplay>` without visible pause controls |
| 🟡 Warning | `motion_interactive_animated` | Animated interactive element (button/a/input) |
| 🟡 Warning | `motion_still_animates` | Element still animates after CDP emulates `prefers-reduced-motion: reduce` |

---

### Font Loading (A10)

Scans `@font-face` rules and `PerformanceResourceTiming` entries.

| Severity | Finding Type | Description |
|---|---|---|
| 🟡 Warning | `font_foit` | `@font-face` missing `font-display` — invisible text while loading |
| 🟡 Warning | `font_fout` | `font-display: swap` or `fallback` — layout shift risk |
| 🟡 Warning | `font_no_fallback` | `font-family` declaration without system font fallbacks |
| 🟡 Warning | `font_slow` | Web font load time > `FONT_SLOW_MS` (default 1000ms) |
| 🟡 Warning | `font_suboptimal_format` | Font in `.ttf` or `.eot` format instead of `.woff2` |
| 🔵 Info | `font_summary` | Always emitted — counts per finding type |

---

### Form Validation (A11)

Audits HTML forms for accessibility and UX gaps.

| Severity | Finding Type | Description |
|---|---|---|
| 🟡 Warning | `form_missing_required` | Input without `required` or `aria-required` |
| 🟡 Warning | `form_missing_autocomplete` | Personal data field (name/email/address/phone/CC) without `autocomplete` (WCAG 1.3.5) |
| 🟡 Warning | `form_error_not_linked` | Error message not linked via `aria-describedby` |
| 🟡 Warning | `form_type_mismatch` | `<input type="text">` labelled as a password field |
| 🟡 Warning | `form_no_validation` | Form with required fields but no HTML5 validation |
| 🔵 Info | `form_summary` | Always emitted — counts per finding type |

---

### Theme & Dark Mode (A7)

| Severity | Finding Type | Description |
|---|---|---|
| 🟡 Warning | `theme_no_dark_mode` | Page has no `@media (prefers-color-scheme: dark)` CSS rules |
| 🟡 Warning | `theme_dark_mode_broken` | Dark mode emulation reveals contrast failures or invisible text |
| 🔵 Info | `theme_summary` | Always emitted |

Uses `browser.emulateColorScheme('dark')` to activate dark mode and captures computed styles.

---

### Chrome DevTools Issues Panel

Queries `list_console_messages({ types: ['issue'] })` — a separate namespace from `console.error`.

| Severity | Finding Type | Description |
|---|---|---|
| 🔴 Critical | `csp_violation` | Inline script or external resource blocked by Content-Security-Policy |
| 🔵 Info | `deprecated_api` | Deprecated browser API used (e.g., `document.domain`, `DOMSubtreeModified`) |

Additional Chrome-surfaced types (CORS blocks, mixed content, cookie misconfiguration, low-contrast) are classified when present.

---

### Lighthouse Audits

Runs all four Lighthouse categories on every `argus_audit_full` run:

| Severity | Category | Threshold |
|---|---|---|
| 🔴 Critical | Accessibility | score < 50/100 |
| 🟡 Warning | Accessibility | score 50–89/100 |
| 🟡 Warning | Performance | score < 90/100 |
| 🟡 Warning | SEO | score < 90/100 |
| 🟡 Warning | Best Practices | score < 90/100 |

Individual failing audit items (e.g., missing alt text, low contrast, render-blocking resources) are surfaced as separate findings alongside the category score.

> **Note:** Lighthouse now runs in headless (after the `lighthouse_audit` argument fix); its score checks stay soft in the per-PR gate and are promoted to hard in the weekly strict-soft lane (`harness-strict.yml`).

---

### Historical Baselines & Trends

| Severity | Finding Type | Description |
|---|---|---|
| 🔴 Critical | `new_finding` (critical) | New critical not in saved baseline — regression since last run |
| 🟡 Warning | `new_finding` (warning) | New warning not in baseline |
| 🔵 Info | Existing finding | Suppressed from real-time alerts; in info digest only |
| 🔵 Info | Trend summary | New vs resolved counts appended to `reports/baselines/<branch>-trends.json` |

Baseline key format: `type::message[:100]::status` — excludes timestamps and dynamic URL path IDs. Baselines are stored per git branch: `reports/baselines/<branch>.json`.

---

### Flakiness Detection

| Severity | Finding Type | Description |
|---|---|---|
| Original severity | Confirmed finding | Present in both crawl runs (`mergeRunResults` key match) |
| 🔵 Info | Flaky finding | Present in only one of two crawl runs — downgraded to `info`, labelled `:zap: _flaky_` in Slack |

Each route is crawled **twice** per run. Only findings confirmed in both passes keep their original severity.

---

### User Flow Assertions

Define multi-step flows in `src/config/targets.js` under `flows[]`. Supported step actions:

`navigate` · `fill` · `click` · `press_key` · `drag` · `upload_file` · `waitFor` · `sleep` · `handle_dialog` · `assert`

**Assert types:**

| Severity | Assert Type | Checks |
|---|---|---|
| 🔴 Critical | `element_visible` | Expected selector absent within timeout |
| 🔴 Critical | `no_js_errors` | Uncaught exceptions in `window.__argusErrors` during flow |
| 🔴 Critical | `flow_step_failed` | Any step threw — page state unknown |
| 🟡 Warning | `no_console_errors` | Console errors after flow start (baseline-sliced) |
| 🟡 Warning | `no_network_errors` | 4xx/5xx requests during flow (baseline-sliced) |
| 🟡 Warning | `url_contains` | URL does not include expected substring after flow |
| 🟡 Warning | `element_not_visible` | Selector unexpectedly present in DOM |

**Special step options:**
- `typing: true` on a `fill` step — dispatches real keyboard events via `mcp.type_text` (triggers input-event validation)
- `drag` — fires `dragstart` → `dragover` → `drop` sequences (limited by MCP DnD constraint — see [Known Limitations](#known-mcp-tool-limitations))
- `upload_file` — delivers a local file to a file input via CDP: `{ action: 'upload_file', selector: 'input[type=file]', filePath: '/path/to/file' }`

---

### Environment Regressions (dev vs staging)

Run via `argus_compare` or `npm run compare`.

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | API status regressed — 2xx in dev, 5xx in staging | Network diff between both environments |
| 🟡 Warning | Visual change > 0.5% pixels different | `pixelmatch` pixel-level comparison + diff overlay image |
| 🟡 Warning | New console error in staging that doesn't exist in dev | Console message diff |
| 🟡 Warning | New network request in staging — unexpected endpoint appeared | Network request URL diff |
| 🟡 Warning | Request present in dev is missing in staging | Network request URL diff |
| 🟡 Warning | API status changed between environments (any non-5xx change) | Network status diff |
| 🔵 Info | DOM structural change — element count differs between environments | HTML tag count comparison across snapshots |

---

### Codebase Cross-Reference (C1)

Static analysis — no MCP, no browser. Activated by setting `ARGUS_SOURCE_DIR`.

| Severity | Finding Type | Description |
|---|---|---|
| 🟡 Warning | `env_var_missing` | `process.env.X` used in source code but absent from all `.env` files |
| 🟡 Warning | `feature_flag_leakage` | Env var used in a conditional but is falsy/unset in `.env` — code branch permanently disabled |
| 🔵 Info | `error_source_linked` | Console error stack trace resolved to `file:line` — enrichment only |
| 🟡 Warning | `dead_route` | Internal navigation link that returns HTTP 404 |

---

### GitHub PR Integration (C2)

Activated by setting `GITHUB_TOKEN` + `GITHUB_REPOSITORY`.

| Feature | Description |
|---|---|
| PR comment | Structured Markdown findings table posted as a PR comment — updates in-place (one comment per PR, no spam) |
| Selector column | Each finding links to its exact DOM element selector |
| Visual regressions section | Diff percentages + embedded diff image (`ARGUS_DIFF_IMAGE_URL`) |
| GitHub Check Run | `createCheckRun` / `completeCheckRun` via Checks API — full findings output visible in the Checks tab |
| Commit status | `argus-qa` status set to `failure` when new criticals ≥ `ARGUS_CRITICAL_THRESHOLD` (default 1; set 0 to never block) |
| Release notes | `generateReleaseNotes(currentReport, prevReport)` — markdown changelog comparing two runs |

---

### Network Request Origin Tagging

All network error and timing findings carry an `origin` field:

- `'first-party'` — same origin as the audited page
- `'third-party'` — cross-origin CDN, analytics, etc.

This lets operators triage critical first-party failures separately from third-party noise without any configuration.

### Finding Type Catalog

Complete index of every finding `type` emitted by Argus, grouped by the module that emits it. Generated from `src/` by `scripts/gen-finding-types.mjs` (run it to refresh — do not hand-edit). Non-finding `type:` keys (MCP/Slack/Zod-schema/flow-assertion) are excluded.

<!-- AUTO-GENERATED by scripts/gen-finding-types.mjs — run it to refresh; do not hand-edit. -->

**149 finding types** emitted across **29 modules** (severities are context-dependent — many types emit critical/warning/info by route or magnitude). `*_summary` types are always-emitted aggregate rows.

| Module | Finding types |
| --- | --- |
| `orchestration/env-comparison.js` | `analysis_error`, `console_regression`, `dom`, `network_added`, `network_removed`, `network_status_changed`, `screenshot`, `screenshot_error` |
| `orchestration/orchestrator.js` | `blank_page`, `broken_link`, `cache_headers_missing`, `console`, `cors_error`, `debugger_statement`, `document_write`, `duplicate_id`, `large_payload`, `load_failure`, `long_task`, `network`, `redirect_chain`, `security_no_https`, `slow_api`, `sw_registration_error`, `sync_xhr`, `uncaught_exception`, `unhandled_rejection` |
| `orchestration/watch-mode.js` | `console`, `console_warning`, `cors_error`, `network_failed`, `network_not_found`, `network_server_error` |
| `utils/a11y-deep-analyzer.js` | `a11y_axe_violation`, `a11y_colorblind_risk`, `a11y_deep_summary` |
| `utils/api-frequency.js` | `api_call_summary`, `api_duplicate_call` |
| `utils/codebase-analyzer.js` | `dead_route`, `env_var_missing`, `error_source_linked`, `feature_flag_leakage` |
| `utils/content-analyzer.js` | `content_broken_image`, `content_empty_list`, `content_null_rendered`, `content_placeholder_text` |
| `utils/contract-validator.js` | `api_contract_violation` |
| `utils/css-analyzer.js` | `css_analysis_error`, `css_component_leak`, `css_modules_detected`, `css_override`, `css_summary`, `css_unused_rules`, `react_inline_style_conflict` |
| `utils/design-fidelity-analyzer.js` | `design_bounds_overflow`, `design_color_mismatch`, `design_component_missing`, `design_fidelity_summary`, `design_gap_mismatch`, `design_opacity_mismatch`, `design_position_drift`, `design_radius_mismatch`, `design_shadow_mismatch`, `design_spacing_mismatch`, `design_stroke_mismatch`, `design_text_mismatch`, `design_token_mismatch`, `design_typography_mismatch` |
| `utils/diff.js` | `element_count_change` |
| `utils/flow-runner.js` | `flow_assert_failed`, `flow_step_failed` |
| `utils/font-analyzer.js` | `font_foit_risk`, `font_fout_risk`, `font_no_fallback`, `font_slow_load`, `font_suboptimal_format`, `font_summary` |
| `utils/form-analyzer.js` | `form_inaccessible_error`, `form_missing_required`, `form_no_autocomplete`, `form_no_validation`, `form_summary`, `form_unmasked_password` |
| `utils/har-recorder.js` | `har_baseline_created`, `har_comparison_summary`, `har_missing_request`, `har_new_request`, `har_status_changed` |
| `utils/hover-analyzer.js` | `hover_dropdown_broken`, `hover_tooltip_missing` |
| `utils/issues-analyzer.js` | `cookie_attribute_missing`, `cors_violation`, `csp_violation`, `deprecated_api_use`, `low_contrast_native`, `mixed_content`, `permission_policy_violation`, `unclassified_devtools_issue` |
| `utils/keyboard-analyzer.js` | `focus_lost`, `focus_visible_missing` |
| `utils/lighthouse-checker.js` | `lighthouse_audit`, `lighthouse_score` |
| `utils/memory-analyzer.js` | `memory_detached_dom_nodes`, `memory_heap_growth` |
| `utils/motion-analyzer.js` | `motion_autoplay_no_pause`, `motion_interactive_animation`, `motion_no_reduced_motion_query`, `motion_reduced_not_honoured`, `motion_summary` |
| `utils/network-timing-analyzer.js` | `slow_third_party_blocking` |
| `utils/responsive-analyzer.js` | `responsive_overflow`, `responsive_small_touch_target` |
| `utils/security-analyzer.js` | `security_cookie_no_httponly`, `security_eval_usage`, `security_iframe_no_sandbox`, `security_missing_csp`, `security_missing_sri`, `security_missing_xframe`, `security_mixed_content`, `security_npm_vulnerability`, `security_open_redirect`, `security_sensitive_console`, `security_sourcemap_exposed`, `security_token_in_storage`, `security_token_in_url`, `security_unsafe_blank_link` |
| `utils/seo-analyzer.js` | `seo_generic_title`, `seo_missing_canonical`, `seo_missing_description`, `seo_missing_h1`, `seo_missing_og`, `seo_missing_viewport`, `seo_multiple_h1`, `seo_og_image_relative_url` |
| `utils/snapshot-analyzer.js` | `a11y_duplicate_landmark`, `a11y_missing_form_label`, `a11y_missing_name`, `aria_expanded_no_controls`, `heading_level_skip` |
| `utils/theme-analyzer.js` | `theme_no_dark_mode`, `theme_static_var`, `theme_summary` |
| `utils/visual-diff-analyzer.js` | `visual_baseline_created`, `visual_diff_summary`, `visual_regression` |
| `utils/web-vitals-analyzer.js` | `perf_bundle_large`, `perf_cls`, `perf_fcp`, `perf_lcp`, `perf_tti`, `perf_vitals_summary` |

---

## Analysis Modes

### CSS Analysis Mode

When `TARGET_STAGING_URL` is not set, `npm run compare` automatically switches to **CSS analysis mode** instead of comparing two environments.

| Check | What it catches |
|---|---|
| **Cascade overrides** | Same CSS property declared multiple times on an element; `!important` flagged as warning |
| **Component style leaks** | BEM selector (`.card__title`) found in a stylesheet that doesn't belong to that component |
| **Unused rules** | CSS selectors that match no element on the current page |
| **CSS Modules** | Detects hashed class names; extracts readable component names (`Button`, `Card`, etc.) |
| **React inline style conflicts** | `style=""` attribute overriding a stylesheet declaration on the same element |
| **SCSS source maps** | Traces compiled CSS back to original `.scss` files |

API frequency analysis also runs automatically:

| Call count | Severity | Likely cause |
|---|---|---|
| 2 calls | info | Possible prefetch + actual — verify intentional |
| 3–4 calls | warning | Double-fetch — check `useEffect` deps or component re-mounts |
| 5+ calls | critical | Runaway loop — missing cleanup, infinite re-render |

---

### Performance Budgets

Enforced on every crawl via the Performance API (headless-compatible):

| Metric | Threshold | Severity |
|---|---|---|
| LCP (Largest Contentful Paint) | < 2500ms | warning |
| CLS (Cumulative Layout Shift) | < 0.1 | warning |
| TTFB (Time to First Byte) | < 800ms | warning |
| API response time | > 1000ms / > 3000ms | warning / critical |
| API payload | > 500KB / > 2MB | warning / critical |
| JS bundle | > 500KB / > 2MB | warning / critical |
| CSS bundle | > 150KB | warning |

---

### Lighthouse Suite

Runs all four Lighthouse categories on every `argus_audit_full` call:

- **Accessibility** — score < 50 → `critical`; score < 90 → `warning`
- **Performance** — score < 90 → `warning`
- **SEO** — score < 90 → `warning`
- **Best Practices** — score < 90 → `warning`

Individual failing audit items are surfaced as separate findings alongside the category score.

> Lighthouse now runs in headless (after the `lighthouse_audit` fix). The remaining soft assertions (perf traces, GC-dependent heap-growth) stay soft in headless CI and do not cause harness failures; the weekly strict-soft lane (`harness-strict.yml`) promotes them to hard.

---

### Watch Mode

`npm run watch` attaches to whatever Chrome tab is open and polls every 1s (configurable via `ARGUS_WATCH_INTERVAL_MS`). Reports new issues **without navigating** — works on authenticated pages and mid-session states.

| Variable | Default | Description |
|---|---|---|
| `ARGUS_WATCH_INTERVAL_MS` | `1000` | Poll interval in milliseconds |
| `ARGUS_WATCH_UI_PORT` | `3002` | Live web dashboard port |
| `TARGET_DEV_URL` | `http://localhost:3000` | URL attributed to findings when none passed |

Watch mode detects: console errors, network failures (4xx/5xx), CORS blocks, auth failures (401/403).

On `Ctrl+C`, generates a final `reports/report.html`. A live web dashboard runs at `http://localhost:3002` during watch.

---

## Slack Channel Routing

> **Slack is optional.** When `SLACK_BOT_TOKEN` is not set, Argus generates a local `report.html` instead.

When Slack **is** configured, findings are routed by severity:

| Severity | Channel | Covers |
|---|---|---|
| `critical` | `#bugs-critical` | JS exceptions, HTTP 5xx, blank page, auth failure, API called 5+ times, Lighthouse accessibility < 50, auth token in storage/URL, responsive overflow, slow API > 3s, payload > 2MB, > 100 detached DOM nodes, CORS violations, `debugger;` statements, blocked mixed content |
| `warning` | `#bugs-warnings` | Visual regression > 0.5%, HTTP 4xx, CSS overrides with `!important`, API called 3–4×, Lighthouse scores < 90, missing SEO/OG tags, missing security headers, placeholder content, touch targets too small, slow API > 1s, payload > 500KB, > 10 detached DOM nodes, redirect chains > 2 hops, broken links, sync XHR, `document.write`, long tasks > 50ms, SW registration failures, duplicate `id` attributes, passive mixed content |
| `info` | `#bugs-digest` | Console warnings, unused CSS rules, API summaries, CSS Modules detection, empty data lists, responsive screenshot grid, missing cache headers |

Each Slack message includes:

- Severity badge + affected URL + timestamp
- AI-generated description
- Inline screenshot (uploaded directly to Slack — no external hosting)
- **View Page**, **Acknowledge**, and **Retest** action buttons

---

## Slack Slash Command Setup

Allows `/argus-retest <url>` from any Slack channel.

### Step 1 — Start the server

```bash
npm run server
# Listens on port 3001 (configurable via PORT env var)
```

### Step 2 — Expose with a tunnel

```bash
# Cloudflare Tunnel (free, no account needed)
cloudflared tunnel --url http://localhost:3001

# Or SSH tunnel (zero install)
ssh -R 80:localhost:3001 nokey@localhost.run
```

Copy the HTTPS URL that appears.

### Step 3 — Configure Slack App

1. [api.slack.com/apps](https://api.slack.com/apps) → BugBot → **Slash Commands** → Create New Command:
   - Command: `/argus-retest`
   - Request URL: `https://your-public-url/slack/commands`
   - Description: `Run Argus regression test on a URL`
   - Usage hint: `<url>`

2. **Interactivity & Shortcuts** → Enable → Request URL: `https://your-public-url/slack/interactions`

3. **OAuth & Permissions** → **Reinstall to Workspace**

### Step 4 — Test

```
/argus-retest http://localhost:3000
```

BugBot replies within 3 seconds with a "running" acknowledgement, then posts results.

---

## Project File Tree

```
argus/
├── .env                              — Your secrets (never commit)
├── .env.example                      — Template — copy to .env
├── .gitignore
├── package.json
├── README.md                         — Quick start + setup
├── REFERENCE.md                      — This file — full technical reference
├── CLAUDE.md                         — Contributor context + source map
├── SKILL.md                          — MCP tool signatures + DSL reference
├── .claude/
│   └── settings.json                 — Claude Code permission config
├── .github/
│   ├── codeql-config.yml             — CodeQL false-positive suppression config
│   └── workflows/
│       ├── argus.yml                 — CI pipeline (push to main + daily 6 AM UTC)
│       └── harness-ci.yml            — Correctness harness gate
├── .mcp.json                         — MCP server registration — 9 tools exposed to Claude
├── action.yml                        — Composite GitHub Action wrapper for argus_pr_validate
├── src/
│   ├── argus.js                      — Single-page audit entry point
│   ├── batch-runner.js               — Multi-page batch audit
│   ├── mcp-server.js                 — 9 MCP tools: argus_audit / argus_audit_full /
│   │                                     argus_compare / argus_last_report /
│   │                                     argus_watch_snapshot / argus_get_context /
│   │                                     argus_design_audit / argus_visual_diff /
│   │                                     argus_pr_validate
│   ├── adapters/
│   │   ├── browser.js                — CdpBrowserAdapter — facade over chrome-devtools-mcp
│   │   └── figma.js                  — Figma REST adapter — getFigmaFrame() + parseFigmaUrl()
│   ├── domain/
│   │   └── finding.js                — createFinding() factory — canonical finding shape
│   ├── registry.js                   — Analyzer plugin registry
│   ├── config/
│   │   ├── targets.js                — Routes, thresholds, auth steps, flow definitions
│   │   └── schema.js                 — Zod validation schema; validateConfig() on startup
│   ├── orchestration/
│   │   ├── crawl-and-report.js       — Backward-compat re-export shell
│   │   ├── orchestrator.js           — Crawl loop, route/flow crawl, runCrawl()
│   │   ├── report-processor.js       — Dedup → severity overrides → baseline → JSON write
│   │   ├── dispatcher.js             — Slack / GitHub / HTML dispatch
│   │   ├── env-comparison.js         — Dev vs staging diff + CSS analysis mode
│   │   ├── watch-mode.js             — Passive browser monitoring
│   │   └── slack-notifier.js         — Slack Block Kit dispatcher
│   ├── server/
│   │   ├── index.js                  — Express server (port 3001)
│   │   ├── slash-command-handler.js  — /argus-retest handler
│   │   └── interaction-handler.js    — Acknowledge + Retest button handler
│   ├── utils/
│   │   ├── css-analyzer.js           — CSS analysis injected into browser
│   │   ├── seo-analyzer.js           — SEO: meta, OG tags, h1, canonical, viewport
│   │   ├── security-analyzer.js      — Security: localStorage tokens, eval(), headers
│   │   ├── content-analyzer.js       — Content quality: null text, placeholders, broken images
│   │   ├── responsive-analyzer.js    — Responsive: overflow + touch targets at 4 breakpoints
│   │   ├── memory-analyzer.js        — Memory: V8 heap snapshot + heap growth
│   │   ├── hover-analyzer.js         — Hover-state bug detection (D8.1)
│   │   ├── snapshot-analyzer.js      — Accessibility tree snapshot (D8.2)
│   │   ├── keyboard-analyzer.js      — Keyboard Tab-walk focus analysis
│   │   ├── issues-analyzer.js        — Chrome DevTools Issues panel
│   │   ├── network-timing-analyzer.js — HAR timing — slow third-party detection
│   │   ├── theme-analyzer.js         — A7: Theme & Dark Mode detection
│   │   ├── design-fidelity-analyzer.js — D9: Figma design token vs DOM (13 finding types)
│   │   ├── web-vitals-analyzer.js    — Web Vitals: LCP/CLS/FCP/TTI/TTFB + bundle size
│   │   ├── visual-diff-analyzer.js   — A8: Visual regression via pixelmatch
│   │   ├── a11y-deep-analyzer.js     — A12: axe-core 4.12 + CVD color blind simulation
│   │   ├── har-recorder.js           — N1: HAR network baseline record + diff
│   │   ├── motion-analyzer.js        — A9: Motion & Animation accessibility
│   │   ├── font-analyzer.js          — A10: Font loading — FOIT/FOUT/fallback/slow
│   │   ├── form-analyzer.js          — A11: Form validation accessibility + UX gaps
│   │   ├── codebase-analyzer.js      — C1: Static source analysis (no browser)
│   │   ├── github-reporter.js        — C2: PR comment + commit status + Check Runs
│   │   ├── pr-diff-analyzer.js       — parsePrUrl / fetchPrFiles / mapFilesToRoutes
│   │   ├── route-discoverer.js       — C3: sitemap + Next.js + React Router discovery
│   │   ├── logger.js                 — Pino structured logger; childLogger(module)
│   │   ├── retry.js                  — withRetry() exponential backoff (navigate/fill only)
│   │   ├── telemetry.js              — OTel tracing + metrics; no-op default
│   │   ├── session-persistence.js    — Auth: saveSession / restoreSession / hasSession
│   │   ├── login-orchestrator.js     — Auth: runLoginFlow / refreshSession + lock file
│   │   ├── baseline-manager.js       — Baselines: load/save/apply/trend
│   │   ├── flakiness-detector.js     — Flakiness: mergeRunResults — confirmed vs flaky
│   │   ├── noise-filter.js           — Cross-run noise classifier: applyNoiseFilter — flip-flopping findings → info
│   │   ├── root-cause-linker.js      — Git diff heuristic: linkRootCauses — suspect files/commits on new findings
│   │   ├── flow-runner.js            — User flow DSL: runFlow / runAllFlows
│   │   ├── html-reporter.js          — HTML dashboard: generateHtmlReport()
│   │   ├── parallel-crawler.js       — Concurrency sharding (chunkArray) + D1 bounded route auditing (mapWithConcurrency/auditRoutesConcurrently, ARGUS_CONCURRENCY) + D4 per-route timeout/retry (withTimeout/auditRouteWithRetry/routeResilienceFromEnv)
│   │   ├── audit-depth.js            — PR-validate selective analyzer depth: resolveAuditDepth/selectAnalyzers/runDepthAnalyzers (ARGUS_PR_AUDIT_DEPTH) (D2)
│   │   ├── deploy-preview.js         — PR-validate deploy-preview URL detection: resolveTargetUrl/previewUrlFromStatuses (ARGUS_PREVIEW_URL/ARGUS_PREVIEW_DETECT) (D3)
│   │   ├── import-graph.js           — Static ES/CJS + stylesheet import graph: buildImportGraph/findDependents (PR-validate route mapping C1/C3)
│   │   ├── pr-baseline.js            — PR-validate baseline-aware blocking: decidePrBlock/diffRoutesAgainstBaseline/tagFindingNovelty (B1/B2)
│   │   ├── contract-validator.js     — API contract validation: validateSchema (D7.4)
│   │   ├── severity-overrides.js     — Severity policy overrides: applyOverrides (D7.5)
│   │   ├── slack-guard.js            — Slack-optional guard: isSlackConfigured()
│   │   ├── api-frequency.js          — Request frequency tracking
│   │   ├── diff.js                   — pixelmatch + DOM/network diff utilities
│   │   ├── mcp-parsers.js            — Text-format parsers for MCP console/network responses
│   │   ├── mcp-client.js             — Headless JSON-RPC MCP client for CI mode
│   │   ├── slug.js                   — URL slug helpers
│   │   ├── pdf-exporter.js           — exportReportToPdf/exportPageToPdf via puppeteer (optional peer dep)
│   │   └── screen-recorder.js        — PollingRecorder (zero-dep screenshots) + CdpScreenRecorder (CDP Page.startScreencast)
│   └── cli/
│       ├── init.js                   — argus init interactive setup wizard (C4)
│       ├── chrome-launcher.js        — findChrome()/launchChrome() cross-platform binary detection; argus-chrome bin
│       ├── doctor.js                 — checkChrome/checkMcpConfig/checkEnvKeys pre-flight checks; argus-doctor bin
│       └── pr-validate.js            — headless CI entry point for GitHub Actions; exports buildStepSummary/writeGithubOutputs
├── test/
│   └── unit/                         — Vitest unit tests, 18 files / 366 tests — no Chrome required
│       ├── finding.test.js           — createFinding() — 8 tests
│       ├── config-schema.test.js     — validateConfig() — 8 tests
│       ├── report-processor.test.js  — deduplicateFindings + rebuildSummary — 11 tests
│       ├── flakiness-detector.test.js — findingKey + mergeRunResults — 13 tests
│       ├── baseline-manager.test.js  — loadBaseline/saveBaseline/applyBaseline — 10 tests
│       ├── flow-runner.test.js       — normalizeArray + runFlow mock browser — 11 tests
│       ├── screen-recorder.test.js   — PollingRecorder (mock browser) + CdpScreenRecorder guard — 8 tests
│       ├── pdf-exporter.test.js      — exportReportToPdf / exportPageToPdf guard paths — 3 tests
│       ├── parser-fuzz.test.js       — fast-check property tests over the wire/parser fns — 22 tests
│       ├── import-graph.test.js      — parseImports/resolveSpecifier/buildImportGraph/findDependents + stylesheet leaves (C1/C3) — 18 tests
│       ├── pr-baseline.test.js       — decidePrBlock/diffRoutesAgainstBaseline/tagFindingNovelty (B1/B2) — 32 tests
│       ├── pr-diff-analyzer.test.js  — fetchPrFiles/mapFilesToRoutes/mapFilesToRoutesDeep (C1–C3)/firstAddedLine/resolveAnnotationTarget — 51 tests
│       ├── pr-validator.test.js      — prResultToReport/reportPrValidation comment+Check Run+MCP wiring (A1–A4) + CLI-helper & github-reporter I/O coverage (F3) — 53 tests
│       ├── parallel-crawler.test.js  — mapWithConcurrency/auditRoutesConcurrently bounded route auditing (D1) — 17 tests
│       ├── audit-depth.test.js       — resolveAuditDepth/selectAnalyzers/runDepthAnalyzers selective depth (D2) — 22 tests
│       ├── deploy-preview.test.js    — resolveTargetUrl/previewUrlFromStatuses deploy-preview detection (D3) — 30 tests
│       ├── route-timeout.test.js     — withTimeout/auditRouteWithRetry/routeResilienceFromEnv/allRoutesFailed (D4) — 25 tests
│       └── github-api.test.js        — githubFetch resilience (rate-limit/5xx/network retry) + scrubSecrets (E2) — 24 tests
├── test-harness/
│   ├── validate.js                   — 166-block correctness harness (961/961 gate)
│   ├── contracts/                    — golden Zod response schemas for the 9 MCP tools (block [147]) + chrome-devtools-mcp inputSchema canary snapshot (block [148])
│   ├── harness-config.js             — Route definitions + expected findings
│   ├── server.js                     — Fixture HTTP server (ports 3100 dev / 3101 staging)
│   ├── .env.harness                  — ARGUS_LOG_LEVEL=warn — suppresses INFO flood during harness runs
│   ├── run-with-log.mjs              — Tee wrapper: streams output live + saves to harness-results.txt
│   ├── pages/                        — 63 fixture HTML pages (one per detection category)
│   ├── nextjs-fixture/               — Next.js pages/+app/ structure for C3 tests
│   ├── source-fixture/               — Minimal app.js for C1 codebase-analyzer tests
│   └── static/
│       └── button-styles.css         — BEM card selectors in button file → component leak
├── landing/                          — Product landing page
│   ├── src/
│   │   ├── App.jsx                   — SPA: hero, features, comparison, waitlist + enterprise modals
│   │   └── supabase.js               — Supabase client factory (null-safe when env vars missing)
│   ├── public/
│   │   ├── favicon.svg
│   │   ├── argus-poster.png          — Video poster fallback (1918×1078)
│   │   ├── og-image-v3.jpg           — OG social card (1200×630; 67/166/961)
│   │   ├── robots.txt
│   │   └── sitemap.xml
│   ├── index.html                    — Vite entry; OG/Twitter/JSON-LD SEO tags
│   ├── package.json                  — React 19, Vite 8, Tailwind 3, Framer Motion 12
│   └── .env.example                  — VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY template
├── scripts/
│   ├── dispatch-report.js            — Standalone Slack re-dispatch for existing JSON report
│   └── coverage-gate.mjs             — Merges unit (vitest-v8) + harness (c8) coverage; gates --min-lines + --allow-uncovered
└── reports/                          — Output: JSON reports + screenshots (gitignored)
    ├── baselines/
    │   ├── <branch>.json             — Per-route finding keys, per git branch
    │   ├── <branch>-trends.json      — Append-only run history per branch
    │   ├── screenshots/              — Visual regression PNG baselines
    │   └── har/                      — HAR network baselines
    └── .gitkeep
```

---

## Key Technical Decisions

| Decision | Choice | Reason |
|---|---|---|
| Screenshot comparison | pixelmatch + AI classification | pixelmatch is fast and deterministic; Claude removes false positives from anti-aliasing and dynamic content |
| Slack API | Bot API, not Incoming Webhooks | Bot API supports file uploads, message updates, interactive buttons, and threads |
| File uploads to Slack | `files.getUploadURLExternal` + PUT + `files.completeUploadExternal` | `files.upload` is deprecated; pre-signed URL requires PUT — POST silently produces broken files |
| CSS analysis | Script injected via `evaluate_script` | Runs in page context — sees live computed styles, CSS Modules hashes, and React fiber properties |
| Responsive viewport | `emulate` (not `resize_page`) | `resize_page` only resizes the browser window and does not update CSS viewport width |
| Viewport width measurement | `document.documentElement.clientWidth` | After `emulate` with mobile flag, `window.innerWidth` returns the legacy layout viewport (~952px), not the device width |
| V8 heap snapshot | `take_heapsnapshot({ filePath })` → read from disk | The MCP tool writes JSON to disk; parse with `JSON.parse(fs.readFileSync(filePath))` then delete the temp file |
| Detached DOM detection | Walk flat `nodes` array for "Detached " prefix | Chrome serializes detached elements as "Detached HTMLDivElement" etc.; secondary check on `detachedness === 2` (Chrome 90+) |
| Baseline finding key | `type::message[:100]::status` | Excludes timestamps and dynamic URL path IDs; message truncated to 100 chars for slight wording variations |
| Baseline alert filter | `isNew === true` (strict) | Only findings explicitly marked new by `applyBaseline` are dispatched — prevents stale re-dispatch if baseline-manager is not called |
| Flakiness routing | `severity: 'info'` for flaky findings | Downgrading severity sends them to the info digest with zero routing changes |
| Private `findingKey` per module | Each of `baseline-manager.js` and `flakiness-detector.js` has its own copy | Avoids coupling two independently-useful modules via a shared export for a trivial 3-line function |
| Runtime anti-pattern injection | `addScriptToEvaluateOnNewDocument` via MCP | Scripts registered this way run before any page script — intercepts `XMLHttpRequest.open`, `document.write`, and `navigator.serviceWorker.register` before the page can call them |
| CORS error detection | `list_console_messages` + text match, not in-page intercept | CORS errors are generated by the browser itself — `console.error` patcher misses them |
| Long task detection | `PerformanceObserver({ entryTypes: ['longtask'] })` | Only duration included in message (not `startTime`) — ensures identical tasks on two crawl runs produce the same dedup key |
| CI MCP client | JSON-RPC over stdio | In CI there's no Claude Code agent — the headless client replaces it with the same API surface |
| TOCTOU-safe file writes | `fs.writeFileSync(path, data, { flag: 'wx' })` | Atomically creates the file and throws `EEXIST` if already present — no separate `existsSync` check needed |
| Pino structured logging | All values JSON-serialised | Makes `js/log-injection` impossible regardless of what's interpolated into log messages |
| Node.js minimum | v20.19+ | Required by Chrome DevTools MCP |
| Auth null-guard pattern | `auth?.steps?.length > 0` outer + optional chaining inside | Avoids both property-access-on-null and trivial-conditional CodeQL alerts |

---

## Known MCP Tool Limitations

**None** — the harness passes `961/961` and `KNOWN_PERMANENT` in `validate.js` is empty (since v9.7.2). All three historical "permanent failures" were Argus bugs:

> **`type_text` clarification:** `type_text` fires DOM `input` events when the element is properly focused first via `mcp.click({ uid })`. Always use uid-based focus — passing `{ selector }` to `mcp.click` silently does nothing.

> **`drag` clarification (v9.7.1):** the MCP `drag` tool works correctly in `--headless=new` Chrome, including attach mode (`--browserUrl`). Harness failure [49b] was an Argus bug — `resolveUidForSelector()` substring matching picked the fixture's explanatory paragraph text instead of the draggable div. Fixed with exact-accessible-name-first matching in `flow-runner.js`.

> **Issues panel clarification (v9.7.2):** `list_console_messages({ types: ['issue'] })` works correctly, including in attach mode — Puppeteer enables the Audits domain by default on both launch and connect. Harness failures [67b]/[68b] were an Argus bug: issues come back as markdown text (`msgid=N [issue] text`) and `normalizeArray()` returns `[]` for strings, so every issue was silently discarded. Fixed with `parseConsoleMsgResponse()` in `issues-analyzer.js` and `orchestrator.js`. The deprecated-API fixture also needed updating (Mutation Events were removed in Chrome 127; it now uses an `unload` listener).

Additional API contract notes are documented in [SKILL.md §10](SKILL.md).
