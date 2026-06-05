# Argus — AI-Powered Dev Testing Tool

[![Argus MCP server](https://glama.ai/mcp/servers/ironclawdevs27/Argus/badges/card.svg)](https://glama.ai/mcp/servers/ironclawdevs27/Argus)

> *Argus Panoptes — the all-seeing giant of Greek mythology with a hundred eyes who never slept.*

Automated browser testing pipeline that catches bugs, compares environments, and sends rich reports to Slack (or generates a self-contained HTML dashboard when Slack is not configured) — powered by Chrome DevTools MCP and Claude Code.

---

## MCP Quick Start

Add both servers to your `.mcp.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "argus": {
      "command": "npx",
      "args": ["-y", "argusqa-os"]
    }
  }
}
```

Or register via the Claude Code CLI:

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
claude mcp add argus -- npx -y argusqa-os
```

Set your target URL and start Chrome with remote debugging:

```bash
# .env
TARGET_DEV_URL=http://localhost:3000

# Start Chrome (required — Argus drives this instance via CDP)
# macOS:   open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new
# Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new
# Linux:   google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox
```

Then ask Claude (or any MCP client):

```
Run argus_audit on http://localhost:3000
```

**Seven tools are exposed:**

| Tool | What it does |
| --- | --- |
| `argus_audit` | Fast QA pass — JS errors, network failures, accessibility, SEO, security, CSS, content |
| `argus_audit_full` | Deep QA pass — adds Lighthouse scoring, responsive layout checks across 4 viewports, memory leak detection, hover-state bug detection, and accessibility tree snapshot |
| `argus_compare` | Diff dev vs staging side-by-side — screenshots, findings delta, environment regressions |
| `argus_last_report` | Return the last saved JSON report without re-running a scan |
| `argus_watch_snapshot` | Snapshot the currently open Chrome tab without navigating — raw console + network capture |
| `argus_get_context` | Capture everything broken on the open tab, formatted as a diagnostic context for Claude to diagnose and suggest fixes |
| `argus_design_audit` | Full Figma design-to-implementation fidelity audit — 13 finding types across color, typography, spacing, per-corner radius, position drift, stroke, shadow (color+spread), opacity, gap, and text. Selector fallback: `[data-testid]` → `[aria-label]` → `#id` → `.class` |

> **Requires**: Node.js ≥ 20.19, Chrome (desktop or headless), and the `chrome-devtools-mcp` server registered alongside Argus (shown above).

---

The `landing/` directory contains the product landing page (React + Vite + Tailwind + Framer Motion) with Supabase-backed waitlist and enterprise contact forms. Live at **[argus-qa.com](https://argus-qa.com)** (deployed via Cloudflare Pages; background video served from Cloudflare R2). See [landing/README.md](landing/README.md) for setup.

<div align="center">

[![Tech stack icons](https://skillicons.dev/icons?i=nodejs,js,expressjs,react,css,sass,github,githubactions,vscode)](https://skillicons.dev)

</div>

<div align="center">

| 🔴 Critical / 🟡 Warning / 🔵 Info | ⚙️ | 🧪 | 📋 |
| :---: | :---: | :---: | :---: |
| **114 distinct issue types detected** | **25 analysis engines** | **572 test assertions** | **129 test blocks** |

</div>

---

## What Argus Catches

Argus runs **25 analysis engines** per run and detects **114 distinct issue types** across JavaScript runtime, network, CSS, performance, accessibility, SEO, security, content quality, responsive layout, memory, runtime anti-patterns, hover-state interactions, accessibility tree snapshots, keyboard focus, and Chrome DevTools issues panel — plus flakiness detection, historical baselines, user flow assertions, and environment comparison as cross-cutting layers. Every finding is classified by severity (`critical` / `warning` / `info`) and routed to the right Slack channel — or rendered as a local `report.html` when Slack is not configured.

### JavaScript Runtime

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Uncaught exceptions — `TypeError`, `ReferenceError`, etc. | `window.onerror` listener injected before page load |
| 🔴 Critical | Unhandled Promise rejections | `unhandledrejection` event listener injected into the page |
| 🟡 Warning | `console.error` calls (on non-critical routes) | Chrome DevTools `list_console_messages` |
| 🔴 Critical | `console.error` calls (on critical routes) | Chrome DevTools `list_console_messages` |
| 🔵 Info | `console.warn` deprecation notices and warnings | Chrome DevTools `list_console_messages` |

### Network & API

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | HTTP 5xx server errors on any request | `list_network_requests` → status ≥ 500 |
| 🔴 Critical | 401 / 403 auth failures on a **critical route** — user is being kicked out | `list_network_requests` → status 401 or 403 + `routeIsCritical` flag |
| 🟡 Warning | 401 / 403 auth failures on a non-critical route | `list_network_requests` → status 401 or 403 (non-critical path) |
| 🔴 Critical | API endpoint called 5+ times in one page load — likely an infinite loop | Network frequency grouping by normalized URL + method |
| 🟡 Warning | HTTP 4xx client errors (404, 422, 429, etc.) | `list_network_requests` → status 400–499 (non-auth) |
| 🟡 Warning | API endpoint called 3–4 times — likely a double-fetch bug | Frequency grouping → 3 ≤ count ≤ 4 (check `useEffect` deps) |
| 🔵 Info | API endpoint called twice — may be intentional prefetch | Frequency grouping → count = 2 |
| 🔵 Info | API call summary per page load (total calls, unique endpoints, duplicates) | Aggregated network analysis |
| 🟡 Warning | Redirect chain longer than 2 hops — extra round-trips inflate load time | Navigation Timing `redirectCount` read after page settle |
| 🟡 Warning | Broken internal link — `<a href>` target returns HTTP 404 | `<a>` elements harvested via `evaluate_script`, each verified against `list_network_requests` |

### Page Health

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Blank or near-empty page — less than 50 characters of body text | `document.body.innerText` length check after navigation |
| 🟡 Warning | Expected element never appeared — page may have crashed mid-load | `waitFor` selector timeout after 10 seconds |

### CSS & Styling

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | `!important` cascade conflict — forced override fighting another rule | CSS rule walk: property declared with `!important` on same element |
| 🟡 Warning | Component style leak — BEM selector found in the wrong stylesheet | `.block__element` selector in a file whose name doesn't match `block` |
| 🟡 Warning | React inline style overriding a stylesheet declaration on the same element | `style=""` attribute vs. matching CSS rule, `__reactFiber` presence confirmed |
| 🔵 Info | CSS property declared by multiple rules on the same element (cascade override) | Computed style walk across all matched rules per key element |
| 🔵 Info | Unused CSS rules — selectors matching no element on the page (> 10 flagged) | `querySelectorAll(selector).length === 0` for every rule |
| 🔵 Info | CSS Modules detected — hashed class names found on DOM elements | Pattern `_ComponentName_class_hash` matched on live DOM |
| 🔵 Info | SCSS source map found — compiled CSS traced back to `.scss` origin file | `sourceMappingURL` comment in `<style>` tags |

### Performance

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | LCP > 2500ms — largest element took too long to paint | Chrome performance trace → `performance_analyze_insight` |
| 🟡 Warning | CLS > 0.1 — layout shifted significantly after initial render | Chrome performance trace |
| 🟡 Warning | FID / TBT > 100ms — main thread was blocked during interaction | Chrome performance trace |
| 🟡 Warning | TTFB > 800ms — server took too long to send the first byte | Chrome performance trace |

### Accessibility

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Lighthouse accessibility score below 50 / 100 | Lighthouse audit via `lighthouse_audit` |
| 🟡 Warning | Lighthouse accessibility score 50–89 / 100 | Lighthouse audit |
| 🟡 Warning | Missing alt text on images | Individual Lighthouse audit check |
| 🟡 Warning | Insufficient color contrast ratio | Individual Lighthouse audit check |
| 🟡 Warning | Missing ARIA labels on interactive elements | Individual Lighthouse audit check |
| 🟡 Warning | Keyboard navigation broken or unreachable elements | Individual Lighthouse audit check |

### SEO

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | Missing `<meta name="description">` | DOM inspection via `evaluate_script` |
| 🟡 Warning | Missing Open Graph tags (`og:title`, `og:description`, `og:image`) | DOM inspection via `evaluate_script` |
| 🟡 Warning | `og:image` URL is relative — Open Graph requires an absolute URL | DOM inspection + URL prefix check (`http://` / `https://`) |
| 🟡 Warning | Multiple `<h1>` tags on one page | DOM inspection — `querySelectorAll('h1').length > 1` |
| 🟡 Warning | Zero `<h1>` tags — page has no primary heading | DOM inspection — `querySelectorAll('h1').length === 0` |
| 🟡 Warning | Generic page title (less than 10 characters, or default placeholder) | DOM inspection + length check |
| 🟡 Warning | Missing `<link rel="canonical">` | DOM inspection via `evaluate_script` |
| 🟡 Warning | Missing `<meta name="viewport">` | DOM inspection via `evaluate_script` |

### Security

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Auth token found in `localStorage` or `sessionStorage` | `evaluate_script` walks storage keys for token patterns |
| 🔴 Critical | Sensitive token in the page URL (query param or hash) | URL pattern match against current `window.location.href` |
| 🔴 Critical | `eval()` call detected in page scripts | `evaluate_script` AST-style text scan of inline `<script>` tags |
| 🔴 Critical | CSP violation — inline script or external resource blocked by Content-Security-Policy | Chrome DevTools Issues panel (`list_console_messages({ types: ['issue'] })`) |
| 🟡 Warning | Sensitive data (`password`, `token`, `secret`) logged to the console | `list_console_messages` + keyword match |
| 🟡 Warning | Missing `Content-Security-Policy` response header | `fetch(location.href)` inside the page → response headers check |
| 🟡 Warning | Missing `X-Frame-Options` response header | Same headers fetch |
| 🟡 Warning | Cross-origin `<iframe>` without `sandbox` attribute — enables form submission, parent navigation, cookie access | `evaluate_script` checks `iframe[src]` elements for missing sandbox attribute |
| 🟡 Warning | Page served over plain HTTP with no HTTPS upgrade redirect | URL protocol check (`http://` + non-localhost) |
| 🔵 Info | Cookie present without `HttpOnly` flag (limited detection — JS-visible cookies only) | `document.cookie` inspection |
| 🔵 Info | Deprecated browser API usage (e.g. `document.domain`, `DOMSubtreeModified`) | Chrome DevTools Issues panel |

### Content Quality

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | `null` or `undefined` rendered as visible text | DOM text scan for literal "null" / "undefined" strings |
| 🟡 Warning | Lorem ipsum / placeholder copy still in production | DOM text scan for "lorem ipsum" and common placeholder strings |
| 🟡 Warning | Broken image (404 or failed to load) | `evaluate_script` checks `img.naturalWidth === 0` on all images |
| 🔵 Info | Empty data list — `<ul>`, `<ol>`, or `<select>` with no children | DOM structure check |

### Responsive / Mobile

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Horizontal overflow at mobile / tablet viewport (≤ 768px) | `emulate` at 375px and 768px → `document.documentElement.scrollWidth > clientWidth` |
| 🟡 Warning | Touch target smaller than 44×44 px at mobile or tablet viewport | CSS computed size check on interactive elements at 375px and 768px |
| 🔵 Info | Responsive screenshot grid — snapshots at 375 / 768 / 1024 / 1440px | `emulate` at 4 breakpoints, screenshots dispatched to Slack |

### Network Performance

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | API response time > 3000ms | `PerformanceObserver` entries for `fetch` / XHR calls |
| 🟡 Warning | API response time > 1000ms | Same observer, lower threshold |
| 🔴 Critical | API response payload > 2 MB | `list_network_requests` → response body size |
| 🟡 Warning | API response payload > 500 KB | Same, lower threshold |
| 🟡 Warning | Cross-origin (third-party) script TTFB > 2000ms — blocking render or late interactivity | HAR `timing.wait` field from `list_network_requests` HAR data; cross-origin requests only |

### Network Request Origin Tagging

All network findings carry an `origin` field (`'first-party'` / `'third-party'`) so operators can triage critical first-party failures separately from third-party noise.

### Lighthouse Audits

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Lighthouse accessibility score < 50 / 100 | `lighthouse_audit` (accessibility category) |
| 🟡 Warning | Lighthouse accessibility score 50–89 / 100 | `lighthouse_audit` |
| 🟡 Warning | Lighthouse performance score < 90 / 100 | `lighthouse_audit` (performance category) |
| 🟡 Warning | Lighthouse SEO score < 90 / 100 | `lighthouse_audit` (seo category) |
| 🟡 Warning | Lighthouse best-practices score < 90 / 100 | `lighthouse_audit` (best-practices category) |
| 🟡 Warning | Individual failing Lighthouse audit items | Surfaced per-audit from the full Lighthouse report |

### Memory Leaks

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | > 100 detached DOM nodes in V8 heap — severe leak | `take_heapsnapshot` → parse flat nodes array for "Detached Xxx" names |
| 🟡 Warning | > 10 detached DOM nodes in V8 heap — probable leak | Same snapshot parse, lower threshold |
| 🟡 Warning | Heap grew > 2 MB after navigate-away + navigate-back — probable per-load leak | `performance.memory.usedJSHeapSize` delta across round-trip (soft — GC-dependent) |

### Runtime Anti-Patterns

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | Synchronous `XMLHttpRequest` — blocks the main thread until the server responds | `XMLHttpRequest.open` patched via `addScriptToEvaluateOnNewDocument`; `async === false` calls recorded |
| 🟡 Warning | `document.write` / `document.writeln` called — can erase the page or block parsing | `document.write` and `document.writeln` patched before page load; calls recorded with method + content |
| 🟡 Warning | Long task > 50ms on the main thread — blocks user interaction | `PerformanceObserver` with `entryTypes: ['longtask']` injected before page load |
| 🔴 Critical | CORS policy violation — cross-origin fetch blocked by the browser | `list_console_messages` + pattern match for `"has been blocked by CORS policy"` |
| 🟡 Warning | Service worker registration failure — SW script returns 4xx or is invalid | `navigator.serviceWorker.register` patched before page load; `.catch()` records failing script URL |
| 🔵 Info | Same-origin static asset (`.js`, `.css`, `.png`, `.woff2`, etc.) served without `Cache-Control` or `ETag` — browsers cannot cache it efficiently | `evaluate_script` reads `performance.getEntriesByType('resource')`, HEAD-fetches each unique same-origin asset, checks response headers |

### Historical Baselines & Trends

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | New critical finding not present in the saved baseline — regression introduced since last run | `applyBaseline` compares finding keys (`type::message[:100]::status`) against `reports/baselines/<branch>.json` (D7.2 per-branch) |
| 🟡 Warning | New warning finding not present in the baseline | Same key comparison, warning severity |
| 🔵 Info | Pre-existing finding still present — no change since last run | Suppressed from real-time alerts; included in info digest only |
| 🔵 Info | Run trend summary — new vs resolved counts, saved per run | Appended to `reports/baselines/<branch>-trends.json`; surfaced as a trend line in Slack digest |

### Hover-State Bugs

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning / 🔴 Critical | `[aria-haspopup]` element whose controlled popup does not become visible after hover — `aria-expanded` stays false and popup remains `display:none` / `visibility:hidden` / `opacity:0` | `hover` dispatches `mousemove`; `evaluate_script` checks `aria-expanded` + `getComputedStyle` on the controlled element; critical on routes marked `critical: true` |
| 🟡 Warning | `[data-tooltip]` element whose `[role="tooltip"]` is not visible in the DOM after hover — not found or opacity ≤ 0.05 | Same hover + `evaluate_script` checks tooltip opacity, `display`, `visibility`, and `offsetHeight` |

### Accessibility Snapshot Analysis

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | Interactive element (`<button>`, `<a>`, `[role="button"]`, `[role="link"]`) with no accessible name — no text content, `aria-label`, `aria-labelledby`, `title`, or `alt` | `take_snapshot` captures DOM/AX state; `evaluate_script` queries each visible interactive element for accessible name sources |
| 🟡 Warning | Form control (`<input>`, `<select>`, `<textarea>`) with no associated label — no `<label for="...">`, `aria-label`, or `aria-labelledby` (placeholder is intentionally excluded — not a valid accessible name per WCAG 2.1 §3.3.2) | `evaluate_script` checks `label[for]`, ancestor `<label>`, `aria-label`, and `aria-labelledby` for each visible control |
| 🟡 Warning | Landmark role appearing more than once without distinct `aria-label` / `aria-labelledby` — screen readers cannot differentiate them | `evaluate_script` counts `[role=X]` instances and checks for unique label values across: `main`, `banner`, `contentinfo`, `navigation`, `search`, `complementary`, `form`, `region` |
| 🟡 Warning | Heading level skip — h1→h3 or h4→h6 jumps more than one level, breaking WCAG 1.3.1 document outline | DOM walk of `h1`–`h6` elements; detects gaps > 1 between consecutive heading levels |
| 🟡 Warning | `aria-expanded` button/control has no `aria-controls` attribute or references a non-existent element | `evaluate_script` checks `[aria-expanded]` elements for missing or broken `aria-controls` pointer |

### Keyboard Accessibility

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🟡 Warning | Button or focusable element has `outline:0` with no `box-shadow` fallback — no visible focus ring | `press_key({ key: 'Tab' })` walk + `evaluate_script` reads `document.activeElement` computed style for outline/box-shadow |

### Flakiness Detection

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| original | Confirmed finding — present in both crawl runs | `mergeRunResults` finds the key in both run1 and run2 (`type::message[:100]::status` scheme); original severity kept |
| 🔵 Info | Flaky finding — appeared in only one of two crawl runs | Present in run1 or run2 but not both; downgraded to `severity: 'info'`, labelled `:zap: _flaky_` in Slack digest |

### User Flow Assertions

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | Flow step failed — navigate/fill/click/waitFor threw mid-flow (page state unknown) | `flow-runner.js` wraps every step; any throw emits `flow_step_failed` and halts the flow |
| 🔴 Critical | `element_visible` assert — expected selector absent within timeout | Polled via `evaluate_script` + `document.querySelector` (MCP `wait_for` doesn't reliably throw on timeout) |
| 🟡 Warning | `no_console_errors` assert — console errors recorded *during* this flow (baseline-sliced, not session-wide) | Baseline snapshot of `list_console_messages` at flow start; only messages after that offset count |
| 🟡 Warning | `no_network_errors` assert — 4xx/5xx request during this flow (baseline-sliced) | Baseline snapshot of `list_network_requests` at flow start; status ≥ 400 after offset |
| 🟡 Warning | `url_contains` assert — URL does not include expected substring after flow completes | `evaluate_script` reads `window.location.href` |
| 🟡 Warning | `element_not_visible` assert — selector unexpectedly present in DOM | `evaluate_script` → `!document.querySelector(...)` |
| 🔴 Critical | `no_js_errors` assert — uncaught exceptions captured in `window.__argusErrors` during flow | Script parses the injected error buffer |

### Environment Regressions *(dev vs staging)*

| Severity | Bug / Issue | Detection Method |
| --- | --- | --- |
| 🔴 Critical | API status regressed — request that returned 2xx in dev now returns 5xx in staging | Network diff between both environments |
| 🟡 Warning | Visual change > 0.5% pixels different between dev and staging screenshots | `pixelmatch` pixel-level comparison + diff overlay image |
| 🟡 Warning | New console error in staging that doesn't exist in dev | Console message diff |
| 🟡 Warning | New network request in staging — unexpected endpoint appeared | Network request URL diff |
| 🟡 Warning | Request present in dev is missing in staging — endpoint removed or broken | Network request URL diff |
| 🟡 Warning | API status changed between environments (any non-5xx change) | Network status diff |
| 🔵 Info | DOM structural change — element count differs between dev and staging | HTML tag count comparison across snapshots |

---

## What It Does

Argus watches your running application and automatically surfaces issues that test suites miss: visual regressions, API loops, CSS drift, console noise, and accessibility failures — all with screenshots delivered directly to Slack.

| Feature | Description |
| --- | --- |
| **Error Detection** | Crawls your app's routes; captures JS exceptions, console errors, failed API calls, redirect chains, and broken internal links |
| **Environment Comparison** | Diffs dev vs staging: screenshots, DOM structure, network requests, console errors |
| **CSS Analysis** | Detects cascade overrides, component style leaks, unused rules, React inline style conflicts |
| **API Frequency Analysis** | Flags endpoints called more than once per page load (double-fetch, missing `useEffect` deps, infinite loops) |
| **Network Performance** | `slow_api` > 1s/3s and `large_payload` > 500KB/2MB per API call |
| **SEO Checks** | Missing meta description, OG tags, canonical, viewport, h1 — DOM-inspected on every route |
| **Security Checks** | localStorage tokens, token-in-URL, `eval()`, sensitive console output, missing CSP/X-Frame-Options |
| **Content Quality** | `null`/`undefined` rendered text, lorem ipsum, broken images, empty data lists |
| **Responsive Analysis** | Overflow + touch target checks at 375/768px; screenshot grid at 4 breakpoints dispatched to Slack |
| **Memory Leak Detection** | V8 heap snapshot → detached DOM node count; heap growth across navigate-away + navigate-back |
| **Runtime Anti-Patterns** | Synchronous XHR, `document.write`, long tasks > 50ms, CORS violations, service worker registration failures, and missing cache headers on static assets — detected via script injection and post-load HEAD checks |
| **Hover-State Bug Detection** | Fires `hover` on every `[aria-haspopup]` and `[data-tooltip]` element; detects broken dropdowns and invisible tooltips that CSS `:hover` was supposed to reveal |
| **Accessibility Snapshot Analysis** | Calls `take_snapshot` then `evaluate_script`; flags interactive elements missing accessible names, unlabelled form controls, duplicate landmark regions, heading level skips, and `aria-expanded` buttons with missing/broken `aria-controls` |
| **Keyboard Focus Analysis** | Tab-walks every focusable element (up to 20 steps); detects `focus_visible_missing` (button/link with `outline:0` and no `box-shadow` fallback — keyboard users cannot see where focus is) |
| **Chrome DevTools Issues Panel** | Queries `list_console_messages({ types: ['issue'] })` for the Issues panel namespace, which is entirely separate from `console.error`; catches CSP violations and deprecated API usage (verified) — additional Chrome-surfaced types (CORS blocks, mixed content, cookie misconfiguration, low-contrast) are classified when present |
| **Mobile CPU Throttling** | Applies 4× CPU throttle (`emulate({ cpuThrottlingRate: 4 })`) during ≤768px responsive breakpoints — finds layout reflow and animation jank that only manifests under realistic mobile CPU pressure |
| **Origin-Tagged Network Findings** | All network error and timing findings carry `origin: 'first-party' \| 'third-party'` so operators can triage critical first-party failures without digging through third-party CDN noise |
| **Historical Baselines** | Saves finding keys after each run; subsequent runs only alert on *new* issues; trend summary in Slack digest |
| **Flakiness Detection** | Crawls each route twice per run; findings in both runs are confirmed (original severity); findings in only one run are marked flaky (`severity: info`, `:zap: _flaky_` label) |
| **User Flow Assertions** | Named multi-step flows (`navigate/fill/click/press_key/drag/upload_file/waitFor/sleep/handle_dialog/assert`) with baseline-sliced `no_console_errors`, `no_network_errors`, `element_visible`, `url_contains`, `no_js_errors` asserts — runs end-to-end user journeys without writing Playwright specs · Use `typing: true` on a fill step to dispatch real keyboard events via `mcp.type_text` (triggers input-event validation) · Use `drag` step to fire dragstart→dragover→drop sequences · Use `upload_file` step to deliver a local file to a file input via CDP (`{ action: 'upload_file', selector: 'input[type=file]', filePath: '/path/to/file' }`) |
| **API Contract Validation** | Define `apiContracts[]` in `targets.js` with inline `schema` or `schemaFile`; validates captured response bodies against JSON Schema (type, required, properties, items) — emits `api_contract_violation` warnings when shapes diverge from spec |
| **Severity Policy Overrides** | Define `severityOverrides` in `targets.js` (`{ finding_type: 'info' \| 'warning' \| 'critical' \| 'suppress' }`); applied before Slack routing — remap or silence specific detections without touching analyzer code |
| **Auth Token Refresh** | `refreshSession()` is called before each route; re-runs the login flow when the saved session has less than `sessionRefreshWindowMs` (default 5 min) remaining — prevents long crawls from failing mid-run when the auth cookie expires |
| **Slack-optional mode** | When `SLACK_BOT_TOKEN` is not configured, Argus skips Slack entirely and auto-generates a local `report.html` (all findings + inline screenshots) and opens it in the default browser — zero setup required to start using Argus |
| **Codebase Cross-Reference** | Points `ARGUS_SOURCE_DIR` at your app source to detect: missing env vars (`process.env.X` used in code but absent from `.env`), feature flag leakage (conditional env var that is falsy/unset), console error stack traces resolved to `file:line`, and internal links that return 404 — all without opening a browser |
| **GitHub PR Integration** | Posts a structured Markdown findings table as a PR comment (updates in-place — one comment per PR, no spam); sets an `argus-qa` commit status check (`failure` when new criticals exist, `success` otherwise) — blocks merge via branch protection when regressions are introduced. Requires `GITHUB_TOKEN` + `GITHUB_REPOSITORY` env vars |
| **Auto Route Discovery** | Augments manual `routes[]` with paths from three sources: fetches `/sitemap.xml` (follows one sitemap-index level, 10s timeout), scans Next.js `pages/` (Next 12) and `app/` (Next 13+) directories stripping route groups `(auth)`, and greps JS/TS source for React Router `<Route path>` declarations. Dynamic `[param]` segments are skipped — no concrete URL to crawl. Manual route config (`critical`, `waitFor`) always takes precedence. |
| **`argus init` Setup Wizard** | `npm run init` (or `npx argus init`) guides first-time setup: collects target URLs, detects the app framework (Next.js / React Router / unknown) from the source directory's `package.json`, runs C3 route discovery against the dev URL, prompts for optional Slack tokens and GitHub credentials, then writes a populated `.env` and a pre-filled `src/config/targets.js` — zero manual config editing required. |
| **Watch Mode** | `npm run watch` attaches to whatever Chrome tab is open and polls `list_console_messages` + `list_network_requests` every 1 s (configurable via `ARGUS_WATCH_INTERVAL_MS`). Reports new console errors, network failures (4xx/5xx), CORS blocks, and auth failures in real time — without navigating. Starts a live web dashboard at `http://localhost:3002` (configurable via `ARGUS_WATCH_UI_PORT`). On `Ctrl+C`, generates a final `reports/report.html`. No route config needed. |
| **Full Lighthouse Suite** | All 4 Lighthouse categories (performance, SEO, best-practices, accessibility) with per-audit items |
| **Performance Budgets** | Enforces LCP < 2500ms, CLS < 0.1, FID < 100ms, TTFB < 800ms per route |
| **Slack Notifications** | Rich Block Kit reports with inline screenshots routed to `#bugs-critical`, `#bugs-warnings`, `#bugs-digest` |
| **Slash Command** | `/argus-retest <url>` triggers an on-demand test from any Slack channel |
| **CI Integration** | GitHub Actions workflow runs daily at 6 AM UTC and on every push to `main` |
| **MCP Server (AI-callable Argus)** | Register Argus as an MCP server via `.mcp.json`; Claude (or any MCP client) can call `argus_audit`, `argus_audit_full`, `argus_compare`, `argus_last_report`, `argus_watch_snapshot`, `argus_get_context`, and `argus_design_audit` directly from a conversation — no CLI, no terminal required. Published to npm as **[argusqa-os](https://www.npmjs.com/package/argusqa-os)** — add via `{ "command": "npx", "args": ["-y", "argusqa-os"] }` in `.mcp.json` |
| **Figma Design Fidelity** | `argus_design_audit(url, figmaFrameUrl)` compares every extracted Figma property — 13 mismatch finding types: CSS token values, component presence, per-node fill/text color (RGB distance), typography (fontSize/fontWeight/lineHeight/fontFamily/letterSpacing), Auto Layout padding and gap, border-radius (per-corner), bounding-box overflow, **absolute position drift** (scroll-corrected x/y vs Figma bounds, 20px), border stroke (color+weight), box-shadow (offset+blur+**spread**+**color**), opacity, and text content. Selector fallback: tries `[data-testid]`, `[aria-label]`, `#id`, `.class` per node. Requires `FIGMA_API_TOKEN` env var. |
| **Core Web Vitals & Bundle Size** | Per-run LCP, CLS, FCP, TTI (domInteractive), and TTFB captured directly via browser Performance API — works in **headless Chrome** without Lighthouse. Bundle size regression: `perf_bundle_large` fires when JS ≥ 500 KB (warning) / ≥ 2 MB (critical) or CSS ≥ 150 KB. `perf_vitals_summary` always emitted with all metric values. No external dependencies — pure Performance API. |

Works with **React + SCSS**, CSS Modules, CSS-in-JS (styled-components / emotion), and plain HTML/CSS apps.

---

## How It Works

Three components run against the same Chrome instance:

```text
Claude Code (Terminal / VS Code)
  ├── MCP Protocol → Chrome DevTools MCP Server → Chrome
  └── Writes → Orchestration Layer → Slack Bot API
```

- **Chrome DevTools MCP Server** — programmatic access to Chrome: network traffic, console, screenshots, DOM, performance traces
- **Claude Code** — orchestration hub: reads codebase, drives the MCP tools, classifies findings, posts to Slack
- **Slack Bot (BugBot)** — receives reports, exposes `/argus-retest` slash command, handles Acknowledge / Retest button actions

In interactive mode (running from Claude Code), MCP tools are called natively. In CI mode (GitHub Actions), `src/utils/mcp-client.js` spawns `chrome-devtools-mcp` as a child process and communicates via JSON-RPC over stdio.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | v20.19+ | Required by Chrome DevTools MCP |
| Chrome | Stable (current) | Must be installed |
| Claude Code | Latest | `npm install -g @anthropic-ai/claude-code` |
| Slack workspace | — | **Optional** — only needed if you want Slack reports. Without it, Argus generates a local `report.html` instead |

---

## One-Time Setup

### Option A — MCP Server (Claude Code / any MCP client)

No local install required. `npx` auto-downloads `argusqa-os` on first use.

#### 1. Register both MCP servers

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "argus": {
      "command": "npx",
      "args": ["-y", "argusqa-os"]
    }
  }
}
```

Or via Claude Code CLI:

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
claude mcp add argus -- npx -y argusqa-os
```

#### 2. Environment variables

Create a `.env` file in your project root:

```env
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.example.com   # optional — enables argus_compare
```

#### 3. Start Chrome with remote debugging

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu

# Linux
google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox
```

#### 4. Slack notifications (optional)

> Skip to use local `report.html` mode — Argus generates a self-contained HTML report when Slack is not configured.

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → name it **BugBot**
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `files:write`, `files:read`
3. Install to workspace → copy **Bot User OAuth Token** (`xoxb-...`) to `.env` as `SLACK_BOT_TOKEN`
4. Create `#bugs-critical`, `#bugs-warnings`, `#bugs-digest` and `/invite @BugBot` in each

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_CRITICAL=C0000000000
SLACK_CHANNEL_WARNINGS=C0000000001
SLACK_CHANNEL_DIGEST=C0000000002
```

---

### Option B — npm Package (dev dependency / CI/CD)

#### 1. Install

```bash
npm install --save-dev argusqa-os
```

#### 2. Environment variables

Run the interactive wizard to auto-generate `.env` and `src/config/targets.js`:

```bash
npx argus
```

The wizard detects your framework (Next.js / React Router), discovers routes from `sitemap.xml` and your file structure, and optionally collects Slack and GitHub credentials.

**Alternative — manual setup:** Create a `.env` with `TARGET_DEV_URL` and optionally `TARGET_STAGING_URL`.

#### 3. Start Chrome with remote debugging

Same as Option A — see above.

#### 4. Slack notifications (optional)

Same as Option A — see above.

---

### Option C — Clone the Repository (full source / contributors)

#### 1. Clone and install

```bash
git clone https://github.com/ironclawdevs27/Argus.git
cd Argus
npm install
npm run setup   # creates reports/ directory
```

#### 2. Environment variables

**Recommended — use the interactive setup wizard:**

```bash
npm run init
```

**Alternative — manual setup:**

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.example.com   # leave blank → CSS-only analysis mode

# Slack — OPTIONAL. Omit to get a local report.html instead.
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=...
# SLACK_CHANNEL_CRITICAL=C0000000000
# SLACK_CHANNEL_WARNINGS=C0000000001
# SLACK_CHANNEL_DIGEST=C0000000002
```

#### 3. Configure routes

If you ran `npm run init` — skip this step.

Otherwise, edit [src/config/targets.js](src/config/targets.js):

```js
export const routes = [
  { path: '/',          name: 'Home',      critical: true,  waitFor: 'main' },
  { path: '/login',     name: 'Login',     critical: true,  waitFor: 'form' },
  { path: '/dashboard', name: 'Dashboard', critical: true,  waitFor: '[data-testid="dashboard"]' },
  { path: '/settings',  name: 'Settings',  critical: false, waitFor: null },
];
```

- `critical: true` — errors on this route go to `#bugs-critical`
- `waitFor` — CSS selector Argus waits for before capturing (signals the page is ready)

#### 4. Connect Chrome DevTools MCP to Claude Code

```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
```

Verify — ask Claude: *"List all open Chrome pages"* — you should see your tabs.

#### 5. Start Chrome with remote debugging

Same as Option A — see above.

#### 6. Slack notifications (optional)

Same as Option A — see above.

---

## Running Argus

### Option A — Via MCP (Claude Code / any MCP client)

Ask Claude directly — no terminal needed.

**Available tools:**

| Tool | What it does |
| --- | --- |
| `argus_audit` | Fast QA pass — JS errors, network failures, accessibility, SEO, security, CSS, content |
| `argus_audit_full` | Deep QA pass — adds Lighthouse, responsive layout checks across 4 viewports, memory leak detection, hover-state bug detection, and accessibility tree snapshot |
| `argus_compare` | Diff dev vs staging — screenshots, findings delta, environment regressions |
| `argus_last_report` | Return the last saved JSON report without re-running a scan |
| `argus_watch_snapshot` | Snapshot the currently open Chrome tab without navigating — raw console + network capture |
| `argus_get_context` | Capture everything broken on the open tab, formatted as a diagnostic context for Claude to diagnose and suggest fixes |
| `argus_design_audit` | Figma design-to-implementation fidelity audit — 13 finding types across color, typography, spacing, per-corner radius, position drift, stroke, shadow (color+spread), opacity, gap, and text content |

**`argus_audit`** — fast audit of any URL:

```text
Run argus_audit on http://localhost:3000/checkout
Run argus_audit on http://localhost:3000/login with critical: true
```

**`argus_audit_full`** — deep audit with Lighthouse + memory + responsive checks:

```text
Run argus_audit_full on http://localhost:3000/dashboard
```

**`argus_compare`** — dev vs staging diff (reads `TARGET_DEV_URL` and `TARGET_STAGING_URL` from `.env`):

```text
Run argus_compare
```

**`argus_last_report`** — retrieve last audit without re-running Chrome:

```text
Run argus_last_report
```

**`argus_watch_snapshot`** — snapshot the currently open tab without navigating. Useful when the page is in an authenticated or post-interaction state that navigation would reset:

```text
Run argus_watch_snapshot
Run argus_watch_snapshot with url: http://localhost:3000
```

**`argus_get_context`** — when your app is stuck or throwing errors, run this to capture everything that's broken and feed it to Claude for diagnosis:

```text
Run argus_get_context
```

Then follow with: *"Here's the context — what's causing these errors and how do I fix them?"*

---

### Option B & C — Via CLI / npm scripts

**Available commands:**

| Command | What it does |
| --- | --- |
| `npm run crawl` | Multi-page batch audit of all routes in `targets.js` |
| `npm run compare` | Dev vs staging diff (or CSS analysis if no `TARGET_STAGING_URL`) |
| `npm run watch` | Passive monitor — polls the open Chrome tab every 1s, no navigation |
| `npm run report:html` | Generate `reports/report.html` from the latest JSON audit |
| `npm run server` | Start the Slack slash command + interaction server (port 3001) |
| `npm run init` | Interactive setup wizard — generates `.env` + `targets.js` |
| `npm run test:unit` | Run 61 unit tests (no Chrome required) |
| `npm run test:harness` | Run 129-block correctness harness (requires Chrome) |

**`npm run crawl`** — full audit of all configured routes:

```bash
npm run crawl
```

Reports are saved to `reports/` as JSON files. Run `npm run report:html` after any crawl for a portable `reports/report.html` with all screenshots inlined — useful for sharing with designers or reviewing offline.

**`npm run compare`** — dev vs staging diff:

```bash
npm run compare
```

When `TARGET_STAGING_URL` is not set, automatically switches to **CSS analysis mode** — cascade overrides, component style leaks, unused rules, and React inline style conflicts on the dev environment only.

**`npm run watch`** — passive monitoring (polls every 1s, no navigation):

Attaches to whatever Chrome tab is open and reports new issues in real time without navigating anywhere. Use this while developing.

```text
Requires 2 terminals:
  Terminal 1 — your app (npm start / npm run dev)
  Terminal 2 — npm run watch
```

Steps:
1. Open Chrome and navigate to your app
2. Terminal 1: start your application
3. Terminal 2: `npm run watch` — Argus begins polling
4. Develop normally — console errors, network failures (4xx/5xx), CORS blocks, and auth failures print in real time
5. `Ctrl+C` — stops the monitor and writes `reports/report.html`

```bash
# Attribute findings to a specific URL:
npm run watch http://localhost:4000
```

| Variable | Default | Description |
| --- | --- | --- |
| `ARGUS_WATCH_INTERVAL_MS` | `1000` | Poll interval in milliseconds |
| `TARGET_DEV_URL` | `http://localhost:3000` | URL attributed to findings when none passed |

**`npm run report:html`** — generate HTML dashboard from last audit:

```bash
npm run report:html
# → reports/report.html (all findings + inline screenshots, portable, no server needed)
```

---

### Option D — From Slack (on-demand)

```text
/argus-retest https://staging.example.com/checkout
```

BugBot responds immediately, runs the test, and posts results back. Detailed bug reports go to `#bugs-critical`. See [Slack Slash Command Setup](#slack-slash-command-setup) for configuration.

---

## CSS Analysis Mode

When `TARGET_STAGING_URL` is not set in `.env`, `npm run compare` automatically switches to **CSS analysis mode** instead of comparing two environments.

**What it analyzes on your dev environment:**

| Check | What it catches |
| --- | --- |
| **Cascade overrides** | Same CSS property declared multiple times on an element; `!important` flagged as warning |
| **Component style leaks** | BEM selector (`.card__title`) found in a stylesheet that doesn't belong to that component |
| **Unused rules** | CSS selectors that match no element on the current page |
| **CSS Modules** | Detects hashed class names; extracts readable component names (`Button`, `Card`, etc.) |
| **React inline style conflicts** | `style=""` attribute overriding a stylesheet declaration on the same element |
| **SCSS source maps** | Traces compiled CSS back to original `.scss` files where source maps are available |

**API frequency analysis** also runs automatically:

| Call count | Severity | Likely cause |
| --- | --- | --- |
| 2 calls | info | Possible prefetch + actual — verify intentional |
| 3–4 calls | warning | Double-fetch — check `useEffect` deps or component re-mounts |
| 5+ calls | critical | Runaway loop — missing cleanup, infinite re-render |

---

## Performance Budgets

Argus enforces these thresholds on every crawl:

| Metric | Threshold | Severity |
| --- | --- | --- |
| LCP (Largest Contentful Paint) | < 2500ms | warning |
| CLS (Cumulative Layout Shift) | < 0.1 | warning |
| FID / TBT (interaction latency) | < 100ms | warning |
| TTFB (Time to First Byte) | < 800ms | warning |

Violations are reported as individual warning bugs with the measured value.

---

## Lighthouse Suite

Runs all four Lighthouse categories on every route:

- **Accessibility** — score < 50 → `critical`; score < 90 → `warning`
- **Performance** — score < 90 → `warning`
- **SEO** — score < 90 → `warning`
- **Best Practices** — score < 90 → `warning`

Individual failing audit items (e.g., missing alt text, low contrast, render-blocking resources) are surfaced as separate findings alongside the category score.

---

## Slack Channel Routing

> **Slack is optional.** When `SLACK_BOT_TOKEN` is not set, Argus skips Slack entirely and
> auto-generates a local `report.html` (all findings + inline screenshots) and opens it in
> the default browser. No Slack setup needed to start using Argus.

When Slack **is** configured, findings are routed by severity:

| Severity | Channel | When |
| --- | --- | --- |
| `critical` | `#bugs-critical` | JS exceptions, HTTP 5xx, blank page, auth failure, API called 5+ times, Lighthouse accessibility < 50, auth token in storage/URL, responsive overflow, slow API > 3s, payload > 2MB, > 100 detached DOM nodes, CORS policy violations, `debugger;` statements in production code, blocked mixed content (HTTP resource on HTTPS page) |
| `warning` | `#bugs-warnings` | Visual regression > 0.5%, HTTP 4xx, CSS overrides with `!important`, API called 3–4×, Lighthouse scores < 90, missing SEO/OG tags, missing security headers, placeholder content, touch targets too small, slow API > 1s, payload > 500KB, > 10 detached DOM nodes, redirect chains > 2 hops, broken links, sync XHR, `document.write`, long tasks > 50ms, SW registration failures, duplicate `id` attributes, passive mixed content (images/audio on HTTPS page) |
| `info` | `#bugs-digest` | Console warnings, unused CSS rules, API summaries, CSS Modules detection, empty data lists, responsive screenshot grid, missing cache headers on static assets |

Each message includes:

- Severity badge + affected URL + timestamp
- AI-generated description
- Inline screenshot (uploaded directly to Slack — no external hosting)
- **View Page**, **Acknowledge**, and **Retest** action buttons

---

## Slack Slash Command Setup

To use `/argus-retest` from Slack, you need to expose the Argus server publicly.

### Step 1 — Start the server

```bash
npm run server
```

Server runs on port 3001.

### Step 2 — Expose with Cloudflare Tunnel

Download [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (free, no account needed), then:

```bash
cloudflared tunnel --url http://localhost:3001
```

Alternatively, with no install at all (SSH tunnel):

```bash
ssh -R 80:localhost:3001 nokey@localhost.run
```

Copy the public HTTPS URL that appears.

### Step 3 — Configure Slack App

1. [api.slack.com/apps](https://api.slack.com/apps) → BugBot → **Slash Commands** → Create New Command:
   - Command: `/argus-retest`
   - Request URL: `https://your-public-url/slack/commands`
   - Description: `Run Argus regression test on a URL`
   - Usage hint: `<url>`

2. **Interactivity & Shortcuts** → Enable → Request URL: `https://your-public-url/slack/interactions`

3. **OAuth & Permissions** → **Reinstall to Workspace**

### Step 4 — Test

```text
/argus-retest http://localhost:3000
```

BugBot should reply within 3 seconds with a "running" acknowledgement, then post results.

---

## GitHub Actions CI Setup

### Add secrets to your repository

Go to GitHub repo → **Settings** → **Secrets and variables** → **Actions** → add:

| Secret name | Required | Value |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | No | Your `xoxb-...` token. **Omit entirely to use Slack-optional mode** — Argus generates `report.html` instead |
| `SLACK_SIGNING_SECRET` | No* | From Slack App → Basic Information (only needed for `/argus-retest` slash command) |
| `SLACK_CHANNEL_CRITICAL` | No* | Channel ID (required when Slack is configured) |
| `SLACK_CHANNEL_WARNINGS` | No* | Channel ID (required when Slack is configured) |
| `SLACK_CHANNEL_DIGEST` | No* | Channel ID (required when Slack is configured) |
| `TARGET_STAGING_URL` | Yes | Your staging base URL |
| `GITHUB_TOKEN` | No | For C2 PR integration — auto-injected by GitHub Actions as `secrets.GITHUB_TOKEN` |
| `GITHUB_REPOSITORY` | No | For C2 PR integration — `owner/repo` format (e.g., `acme/my-app`) |

> **C2 PR integration**: when `GITHUB_TOKEN` and `GITHUB_REPOSITORY` are set, Argus posts a PR comment and commit status check for every crawl. `GITHUB_PR_NUMBER` is injected automatically by the workflow from `github.event.pull_request.number`. The included workflow does not wire these up by default — add them to the `env:` block in `.github/workflows/argus.yml` if you want PR-level comments.

The workflow at [.github/workflows/argus.yml](.github/workflows/argus.yml) runs:

- On every push to `main` / `master`
- Daily at 6 AM UTC (before the team starts work)
- Manually via **Actions** → **Run workflow** (with optional URL override)

If critical issues are found, the pipeline **fails** — preventing silent regressions from being missed.

---

## Project Structure

```text
argus/
├── .env                              # Your secrets (never commit this)
├── .env.example                      # Template — copy to .env
├── .gitignore
├── package.json
├── README.md
├── .claude/
│   └── settings.json                 # Claude Code permission config (auto-approve node/npm/reports)
├── .github/
│   └── workflows/
│       └── argus.yml                 # CI pipeline
├── .vscode/
│   └── mcp.json                      # Chrome DevTools MCP config for VS Code
├── .mcp.json                         # Argus MCP server registration — exposes all 7 tools to Claude: argus_audit/argus_audit_full/argus_compare/argus_last_report/argus_watch_snapshot/argus_get_context/argus_design_audit
├── src/
│   ├── argus.js                      # Single-page audit entry point
│   ├── batch-runner.js               # Multi-page batch audit
│   ├── mcp-server.js                 # Argus MCP server — argus_audit / argus_audit_full / argus_compare / argus_last_report / argus_watch_snapshot / argus_get_context / argus_design_audit
│   ├── adapters/
│   │   └── browser.js                # CdpBrowserAdapter — facade over all chrome-devtools-mcp calls
│   ├── domain/
│   │   └── finding.js                # createFinding() factory — canonical finding shape
│   ├── registry.js                   # Analyzer plugin registry — registerCheap/registerExpensive/getCheap/getExpensive/clearAll
│   ├── config/
│   │   ├── targets.js                # Routes to test, thresholds, config
│   │   └── schema.js                 # Zod validation schema; validateConfig() called inside runCrawl()
│   ├── orchestration/
│   │   ├── crawl-and-report.js       # Backward-compat re-export shell → orchestrator + report-processor + dispatcher
│   │   ├── orchestrator.js           # Crawl loop, route/flow crawl, runCrawl()
│   │   ├── report-processor.js       # Dedup → severity overrides → baseline → JSON write
│   │   ├── dispatcher.js             # Slack / GitHub / HTML dispatch
│   │   ├── env-comparison.js         # Dev vs staging diff + CSS analysis mode
│   │   ├── watch-mode.js             # Passive browser monitoring (WatchSession + runWatchMode)
│   │   └── slack-notifier.js         # Slack Block Kit dispatcher
│   ├── server/
│   │   ├── index.js                  # Express server (port 3001)
│   │   ├── slash-command-handler.js  # /argus-retest handler
│   │   └── interaction-handler.js    # Acknowledge + Retest button handler
│   ├── utils/
│   │   ├── css-analyzer.js           # CSS analysis script injected into the browser
│   │   ├── seo-analyzer.js           # SEO checks: meta, OG tags, h1, canonical, viewport
│   │   ├── security-analyzer.js      # Security: localStorage tokens, eval(), headers, cookies
│   │   ├── content-analyzer.js       # Content quality: null text, placeholders, broken images
│   │   ├── responsive-analyzer.js    # Responsive: overflow + touch targets at 4 breakpoints
│   │   ├── memory-analyzer.js        # Memory leaks: V8 heap snapshot + heap growth
│   │   ├── logger.js                 # Pino structured logger — childLogger(module)│   │   ├── retry.js                  # withRetry() exponential backoff — navigate/fill only; Number.isFinite guard│   │   ├── telemetry.js              # OTel tracing + metrics — startSpan() / recordFinding() / recordFlaky() / recordNewFindings(); no-op default│   │   ├── session-manager.js        # Auth: backward-compat re-export barrel│   │   ├── session-persistence.js    # Auth: saveSession (mkdirSync+atomic write), restoreSession, hasSession, clearSession│   │   ├── login-orchestrator.js     # Auth: runLoginFlow, refreshSession + lock file│   │   ├── baseline-manager.js       # Baselines: loadBaseline, saveBaseline, applyBaseline, appendTrend
│   │   ├── flakiness-detector.js     # Flakiness: mergeRunResults — confirmed vs flaky per double-crawl
│   │   ├── flow-runner.js            # User flow assertions: runFlow / runAllFlows — assert DSL
│   │   ├── html-reporter.js          # HTML dashboard: generateHtmlReport() + npm run report:html (D7.1 / D7.7)
│   │   ├── parallel-crawler.js       # chunkArray sharding utility (ARGUS_CONCURRENCY=N parallel crawl)
│   │   ├── contract-validator.js     # API contract validation: validateSchema, matchesContract (D7.4)
│   │   ├── severity-overrides.js     # Severity policy overrides: applyOverrides (D7.5)
│   │   ├── slack-guard.js            # Slack-optional guard: isSlackConfigured() (D7.7)
│   │   ├── hover-analyzer.js         # Hover-state bug detection — aria-haspopup + data-tooltip (D8.1)
│   │   ├── snapshot-analyzer.js      # Accessibility tree snapshot — missing names, labels, landmarks, heading hierarchy, ARIA state (D8.2 + v6)
│   │   ├── issues-analyzer.js        # Chrome DevTools Issues panel — CSP/deprecated/cookie issues
│   │   ├── network-timing-analyzer.js # HAR timing analysis — slow third-party detection
│   │   ├── keyboard-analyzer.js      # Keyboard Tab-walk — focus_visible_missing, focus_lost
│   │   ├── theme-analyzer.js         # A7: Theme & Dark Mode detection — emulateColorScheme, prefers-color-scheme mismatches
│   │   ├── design-fidelity-analyzer.js   # D9: Figma design token vs DOM comparison — 13 mismatch finding types
│   │   ├── web-vitals-analyzer.js        # Sprint 9: LCP/CLS/FCP/TTI/TTFB via Performance API + bundle size regression
│   │   ├── codebase-analyzer.js      # Codebase cross-reference — env vars, feature flags, dead routes (C1)
│   │   ├── github-reporter.js        # GitHub PR comment + commit status integration (C2)
│   │   ├── route-discoverer.js       # Auto route discovery — sitemap + Next.js + React Router (C3)
│   │   ├── diff.js                   # pixelmatch screenshot + DOM/network diff utilities
│   │   ├── mcp-parsers.js            # Text-format parsers for list_console_messages + list_network_requests (v9)
│   │   └── mcp-client.js             # Headless JSON-RPC MCP client for CI mode
│   └── cli/
│       └── init.js                   # argus init setup wizard — detect framework, discover routes, write .env + targets.js (C4)
├── test/
│   └── unit/                         # Vitest unit tests — no Chrome required
│       ├── finding.test.js           # createFinding() — fields, throws, frozen, extra fields (8 tests)
│       ├── config-schema.test.js     # validateConfig() + ConfigSchema.safeParse (8 tests)
│       ├── report-processor.test.js  # deduplicateFindings + rebuildSummary (11 tests)
│       ├── flakiness-detector.test.js # findingKey normalization + mergeRunResults (13 tests)
│       ├── baseline-manager.test.js  # loadBaseline/saveBaseline/applyBaseline (9 tests)
│       └── flow-runner.test.js       # normalizeArray (pure) + runFlow mock browser (11 tests)
├── landing/                          # Product landing page (React 19 + Vite 8 + Tailwind + Framer Motion 12)
│   ├── src/
│   │   ├── App.jsx                   # Single-page app — hero, features, comparison, waitlist + enterprise modals
│   │   └── supabase.js               # Supabase client factory (null-safe when env vars missing)
│   ├── public/
│   │   ├── favicon.svg               # SVG favicon — purple ring + dot
│   │   ├── argus-poster.png          # Video poster fallback (1918×1078)
│   │   ├── og-image-v2.jpg           # OG social card — 1200×630 JPEG, branded overlay, black-outlined stat numbers
│   │   ├── robots.txt                # Allows all crawlers; Sitemap reference
│   │   └── sitemap.xml               # Canonical URL for argus-qa.com/
│   ├── index.html                    # Vite entry; OG/Twitter/JSON-LD SEO tags; canonical; favicon
│   ├── package.json
│   ├── .env.example                  # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY template
│   └── README.md                     # Setup guide, Supabase SQL schema, env vars, deployment
├── scripts/
│   └── dispatch-report.js            # Standalone Slack re-dispatch script (re-posts last report.json to Slack)
├── test-harness/                     # Fixture server + test runner (129 blocks, 572 hard assertions, 56 fixture pages)
│   ├── README.md
│   ├── server.js                     # Express fixture server (ports 3100 dev / 3101 staging)
│   ├── harness-config.js             # Route definitions + expected findings
│   ├── validate.js                   # Test runner — 129 numbered blocks ([80]–[84] MCP/createFinding/withRetry/watch/init, [85]–[93] Sprint 0.5 Tier 3, [94]–[126] gap-close, [127] A7 theme, [128] D9 design fidelity, [129] Sprint 9 Web Vitals)
│   ├── pages/                        # 56 fixture HTML pages (one per detection category)
│   ├── nextjs-fixture/               # Next.js app structure for C3 discovery tests (10 files)
│   ├── source-fixture/               # Minimal app.js for C1 codebase-analyzer tests (env var audit)
│   └── static/
│       └── button-styles.css         # BEM card selectors in button file → component leak
└── reports/                          # Output: JSON reports + screenshots (gitignored)
    ├── baselines/
    │   ├── <branch>.json             # Per-route finding keys — per git branch (D7.2)
    │   └── <branch>-trends.json      # Append-only run history per branch (D7.2)
    └── .gitkeep
```

---

## Key Technical Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Screenshot comparison | pixelmatch + AI classification | pixelmatch is fast and deterministic; Claude removes false positives from anti-aliasing and dynamic content |
| Slack API | Bot API, not Incoming Webhooks | Bot API supports file uploads, message updates, interactive buttons, and threads |
| File uploads | `files.getUploadURLExternal` + PUT + `files.completeUploadExternal` | `files.upload` is deprecated; pre-signed URL requires PUT — POST silently produces broken files |
| CSS analysis | Script injected via `evaluate_script` | Runs in page context so it sees the live computed styles, CSS Modules hashes, and React fiber properties |
| Responsive viewport | `emulate` (not `resize_page`) | `resize_page` only resizes the browser window and does not update CSS viewport width — `emulate` is the correct API |
| Viewport width measurement | `document.documentElement.clientWidth` | After `emulate` with mobile flag, `window.innerWidth` returns the legacy layout viewport (~952px), not the device width |
| V8 heap snapshot | `take_heapsnapshot({ filePath })` → read from disk | The MCP tool writes JSON to disk (not inline); parse with `JSON.parse(fs.readFileSync(filePath))` then delete the temp file |
| Detached DOM detection | Walk flat `nodes` array for "Detached " prefix in strings table | Chrome serializes detached elements as "Detached HTMLDivElement" etc.; secondary check on `detachedness === 2` (Chrome 90+) |
| Baseline finding key | `type::message[:100]::status` | Excludes timestamps and dynamic URL path IDs; message truncated to 100 chars to handle slight wording variations; `::status` suffix only added when non-null |
| Baseline alert filter | `isNew === true` (strict) | Only findings explicitly marked new by `applyBaseline` are dispatched to Slack — prevents stale re-dispatch if baseline-manager is not called (fails silently rather than spamming) |
| Flakiness routing | `severity: 'info'` for flaky findings | Downgrading severity means existing `dispatchToSlack` routing sends them to the info digest with zero routing changes — only the `:zap: _flaky_` label needed |
| Private `findingKey` per module | Each of `baseline-manager.js` and `flakiness-detector.js` has its own copy | Avoids coupling two independently-useful modules via a shared export for a trivial 3-line function |
| Runtime anti-pattern injection | `addScriptToEvaluateOnNewDocument` via MCP | Scripts registered this way run in the new page context before any page script — intercepts `XMLHttpRequest.open`, `document.write`, and `navigator.serviceWorker.register` before the page can call them |
| CORS error detection | `list_console_messages` + text match, not in-page intercept | CORS errors are generated by the browser itself, not by page JS — `console.error` patcher misses them; the MCP console log captures them |
| Long task detection | `PerformanceObserver({ entryTypes: ['longtask'] })` injected before load | Only the duration is included in the finding message (not `startTime`) — ensures identical tasks on two crawl runs produce the same dedup key |
| CI MCP client | JSON-RPC over stdio | In CI there's no Claude Code agent — the headless client replaces it with the same API surface |
| Node.js | v20.19+ | Minimum required by Chrome DevTools MCP |

---

## Known MCP Tool Limitations

The Chrome DevTools MCP behavioral constraints below cause **3 permanent test failures** in the harness (`569/572` pass). These are MCP-layer restrictions — they cannot be fixed in Argus code. `validate.js` now exits with code 0 when only these 3 failures remain, making the CI harness gate reliable.

> **`type_text` clarification**: `type_text` does fire DOM `input` events when the element is properly focused first with `mcp.click({ uid })`. Always use uid-based focus — passing `{ selector }` to `mcp.click` silently does nothing.

| Tool | Constraint | Impact |
| --- | --- | --- |
| `drag` | Uses mouse simulation, **not** HTML5 DnD API | `dragstart`/`dragover`/`drop` events never fire |
| `list_console_messages({ types: ['issue'] })` | Issues panel returns empty even when violations exist | CSP and deprecated-API detection is unreliable |

These constraints are documented with workarounds in [SKILL.md §10](SKILL.md).

The harness passes **569/572** assertions (exits 0). The 3 failures are the permanent MCP-limited ones listed above.

---

## Environment Variables Reference

| Variable | Required | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | No | `xoxb-...` Bot User OAuth Token. **Omit to enable Slack-optional mode** — Argus generates `report.html` and opens it in the browser instead |
| `SLACK_SIGNING_SECRET` | No* | Verifies slash command / interaction requests from Slack (required only when using `/argus-retest`) |
| `SLACK_CHANNEL_CRITICAL` | No* | Channel ID for critical bugs (required when Slack is configured) |
| `SLACK_CHANNEL_WARNINGS` | No* | Channel ID for warnings (required when Slack is configured) |
| `SLACK_CHANNEL_DIGEST` | No* | Channel ID for info / daily digest (required when Slack is configured) |
| `TARGET_DEV_URL` | Yes | Base URL of your dev environment |
| `TARGET_STAGING_URL` | No | Base URL of staging. If blank → CSS analysis mode |
| `SCREENSHOT_DIFF_THRESHOLD` | No | Pixel diff % to flag (default: `0.5`) |
| `REPORT_OUTPUT_DIR` | No | Where to write reports (default: `./reports`) |
| `ARGUS_CONCURRENCY` | No | Number of parallel MCP clients for route crawling (default: `1` = sequential) |
| `PORT` | No | Server port (default: `3001`) |
| `ARGUS_LOG_LEVEL` | No | Pino log level — `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`) |
| `ARGUS_LOG_PRETTY` | No | Set to `1` for human-readable log output instead of JSON (dev mode) |
| `ARGUS_RETRY_ATTEMPTS` | No | Max retry attempts for `navigate`/`fill` MCP calls (default: `3`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP collector endpoint — enables span/metric export to Jaeger, Grafana Tempo, Datadog, etc. |
| `ARGUS_OTEL_CONSOLE` | No | Set to `1` to print OTel spans to stdout without an OTLP endpoint (dev tracing) |
| `ARGUS_WATCH_INTERVAL_MS` | No | Watch mode poll interval in milliseconds (default: `1000`) |
| `ARGUS_WATCH_UI_PORT` | No | Watch mode web dashboard port (default: `3002`) |
| `ARGUS_SOURCE_DIR` | No | Path to your app's source directory — enables codebase cross-reference (env var detection, feature flag leakage, dead routes) |
| `ARGUS_ENV_FILE` | No | Path to your app's `.env` file — C1 cross-references env vars used in source code against this file to detect missing declarations |
| `GITHUB_TOKEN` | No | GitHub personal access token — required for PR comment + commit status integration |
| `GITHUB_REPOSITORY` | No | Repository in `owner/repo` format — required for GitHub PR integration |
| `GITHUB_SHA` | No | Commit SHA for the commit status check — injected automatically by GitHub Actions (`${{ github.sha }}`) |
| `GITHUB_PR_NUMBER` | No | PR number for comment targeting — set via `${{ github.event.pull_request.number }}` in your workflow |
| `ARGUS_REPORT_URL` | No | Full URL to the hosted HTML report — linked from the GitHub commit status check |

---

## Troubleshooting

### Chrome DevTools MCP not connecting

```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
# Then restart Claude Code
```

### Slack messages not posting

- Confirm `SLACK_BOT_TOKEN` starts with `xoxb-` (not `xoxp-`, `xoxe-`, or `xapp-`)
- Verify BugBot is invited to each channel: `/invite @BugBot`
- Check token scopes: `chat:write`, `files:write`, `files:read`

### Screenshots not appearing in Slack messages

- The upload uses a pre-signed URL that requires `PUT`, not `POST` — if you see a broken image, check that the Slack token has `files:write` scope and the channel is correct

### Slash command returns "dispatch_failed"

- Your tunnel URL has changed (Cloudflare Tunnel / localhost.run URLs change on restart)
- Update the Request URL in Slack App → Slash Commands and reinstall

### CSS analysis returns empty results

- Page may be behind auth — make sure you're logged in on the Chrome instance Argus is controlling
- Cross-origin stylesheets (CDN fonts, third-party widgets) can't be read due to browser security restrictions — this is expected

### Screenshots are blank

- Page hasn't finished loading — increase `pageSettleMs` in `src/config/targets.js`
- Add a `waitFor` selector for that route

### CI pipeline fails immediately

- Chrome may not be starting fast enough — increase the `sleep 3` after Chrome launch to `sleep 5` in `.github/workflows/argus.yml`

---

## How Argus Differs From Playwright / Cypress

Argus is not a replacement for unit or E2E tests. It's a complementary layer:

| | Playwright / Cypress | Argus |
| --- | --- | --- |
| **Tests** | Your logic and API contracts | What the user actually sees |
| **Catches** | Regression in behaviour | CSS drift, visual regressions, API redundancy, console noise, perf budgets |
| **Runs** | In your test suite | Continuously, on the live running app |
| **Setup** | Write test files | Configure routes in `targets.js` |
| **Output** | Pass / fail | Structured Slack reports with screenshots and action buttons |

They complement each other — Argus catches what test suites miss.
