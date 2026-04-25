# Argus — AI-Powered Dev Testing Tool

> *Argus Panoptes — the all-seeing giant of Greek mythology with a hundred eyes who never slept.*

Automated browser testing pipeline that catches bugs, compares environments, and sends rich reports to Slack — powered by Chrome DevTools MCP and Claude Code.

<div align="center">

[![](https://skillicons.dev/icons?i=nodejs,js,expressjs,react,css,sass,github,githubactions,vscode)](https://skillicons.dev)

</div>

---

## What Argus Catches

Argus runs eighteen analysis engines per run and detects **96 distinct issue types** — fourteen fire on every page crawl (JavaScript runtime, network, CSS, performance, accessibility, SEO, security, content quality, responsive layout, memory, and runtime anti-patterns), plus flakiness detection, historical baselines, user flow assertions, and environment comparison as cross-cutting layers. Every finding is classified by severity and routed to the right Slack channel automatically.

### JavaScript Runtime

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Uncaught exceptions — `TypeError`, `ReferenceError`, etc. | `window.onerror` listener injected before page load |
| 🔴 Critical | Unhandled Promise rejections | `unhandledrejection` event listener injected into the page |
| 🟡 Warning | `console.error` calls (on non-critical routes) | Chrome DevTools `list_console_messages` |
| 🔴 Critical | `console.error` calls (on critical routes) | Chrome DevTools `list_console_messages` |
| 🔵 Info | `console.warn` deprecation notices and warnings | Chrome DevTools `list_console_messages` |

### Network & API

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | HTTP 5xx server errors on any request | `list_network_requests` → status ≥ 500 |
| 🔴 Critical | 401 / 403 auth failures — user is being kicked out | `list_network_requests` → status 401 or 403 |
| 🔴 Critical | API endpoint called 5+ times in one page load — likely an infinite loop | Network frequency grouping by normalized URL + method |
| 🟡 Warning | HTTP 4xx client errors (404, 422, 429, etc.) | `list_network_requests` → status 400–499 (non-auth) |
| 🟡 Warning | API endpoint called 3–4 times — likely a double-fetch bug | Frequency grouping → 3 ≤ count ≤ 4 (check `useEffect` deps) |
| 🔵 Info | API endpoint called twice — may be intentional prefetch | Frequency grouping → count = 2 |
| 🔵 Info | API call summary per page load (total calls, unique endpoints, duplicates) | Aggregated network analysis |
| 🟡 Warning | Redirect chain longer than 2 hops — extra round-trips inflate load time | Navigation Timing `redirectCount` read after page settle |
| 🟡 Warning | Broken internal link — `<a href>` target returns HTTP 404 | `<a>` elements harvested via `evaluate_script`, each verified against `list_network_requests` |

### Page Health

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Blank or near-empty page — less than 50 characters of body text | `document.body.innerText` length check after navigation |
| 🟡 Warning | Expected element never appeared — page may have crashed mid-load | `waitFor` selector timeout after 10 seconds |

### CSS & Styling

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | `!important` cascade conflict — forced override fighting another rule | CSS rule walk: property declared with `!important` on same element |
| 🟡 Warning | Component style leak — BEM selector found in the wrong stylesheet | `.block__element` selector in a file whose name doesn't match `block` |
| 🟡 Warning | React inline style overriding a stylesheet declaration on the same element | `style=""` attribute vs. matching CSS rule, `__reactFiber` presence confirmed |
| 🔵 Info | CSS property declared by multiple rules on the same element (cascade override) | Computed style walk across all matched rules per key element |
| 🔵 Info | Unused CSS rules — selectors matching no element on the page (> 10 flagged) | `querySelectorAll(selector).length === 0` for every rule |
| 🔵 Info | CSS Modules detected — hashed class names found on DOM elements | Pattern `_ComponentName_class_hash` matched on live DOM |
| 🔵 Info | SCSS source map found — compiled CSS traced back to `.scss` origin file | `sourceMappingURL` comment in `<style>` tags |

### Performance

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | LCP > 2500ms — largest element took too long to paint | Chrome performance trace → `performance_analyze_insight` |
| 🟡 Warning | CLS > 0.1 — layout shifted significantly after initial render | Chrome performance trace |
| 🟡 Warning | FID / TBT > 100ms — main thread was blocked during interaction | Chrome performance trace |
| 🟡 Warning | TTFB > 800ms — server took too long to send the first byte | Chrome performance trace |

### Accessibility

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Lighthouse accessibility score below 50 / 100 | Lighthouse audit via `lighthouse_audit` |
| 🟡 Warning | Lighthouse accessibility score 50–89 / 100 | Lighthouse audit |
| 🟡 Warning | Missing alt text on images | Individual Lighthouse audit check |
| 🟡 Warning | Insufficient color contrast ratio | Individual Lighthouse audit check |
| 🟡 Warning | Missing ARIA labels on interactive elements | Individual Lighthouse audit check |
| 🟡 Warning | Keyboard navigation broken or unreachable elements | Individual Lighthouse audit check |

### SEO

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | Missing `<meta name="description">` | DOM inspection via `evaluate_script` |
| 🟡 Warning | Missing Open Graph tags (`og:title`, `og:description`, `og:image`) | DOM inspection via `evaluate_script` |
| 🟡 Warning | Multiple `<h1>` tags on one page | DOM inspection — `querySelectorAll('h1').length > 1` |
| 🟡 Warning | Zero `<h1>` tags — page has no primary heading | DOM inspection — `querySelectorAll('h1').length === 0` |
| 🟡 Warning | Generic page title (less than 10 characters, or default placeholder) | DOM inspection + length check |
| 🟡 Warning | Missing `<link rel="canonical">` | DOM inspection via `evaluate_script` |
| 🟡 Warning | Missing `<meta name="viewport">` | DOM inspection via `evaluate_script` |

### Security

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Auth token found in `localStorage` or `sessionStorage` | `evaluate_script` walks storage keys for token patterns |
| 🔴 Critical | Sensitive token in the page URL (query param or hash) | URL pattern match against current `window.location.href` |
| 🔴 Critical | `eval()` call detected in page scripts | `evaluate_script` AST-style text scan of inline `<script>` tags |
| 🟡 Warning | Sensitive data (`password`, `token`, `secret`) logged to the console | `list_console_messages` + keyword match |
| 🟡 Warning | Missing `Content-Security-Policy` response header | `fetch(location.href)` inside the page → response headers check |
| 🟡 Warning | Missing `X-Frame-Options` response header | Same headers fetch |
| 🔵 Info | Cookie present without `HttpOnly` flag (limited detection — JS-visible cookies only) | `document.cookie` inspection |

### Content Quality

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | `null` or `undefined` rendered as visible text | DOM text scan for literal "null" / "undefined" strings |
| 🟡 Warning | Lorem ipsum / placeholder copy still in production | DOM text scan for "lorem ipsum" and common placeholder strings |
| 🟡 Warning | Broken image (404 or failed to load) | `evaluate_script` checks `img.naturalWidth === 0` on all images |
| 🔵 Info | Empty data list — `<ul>`, `<ol>`, or `<select>` with no children | DOM structure check |

### Responsive / Mobile

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Horizontal overflow at mobile / tablet viewport (≤ 768px) | `emulate` at 375px and 768px → `document.documentElement.scrollWidth > clientWidth` |
| 🟡 Warning | Touch target smaller than 44×44 px at mobile or tablet viewport | CSS computed size check on interactive elements at 375px and 768px |
| 🔵 Info | Responsive screenshot grid — snapshots at 375 / 768 / 1024 / 1440px | `emulate` at 4 breakpoints, screenshots dispatched to Slack |

### Network Performance

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | API response time > 3000ms | `PerformanceObserver` entries for `fetch` / XHR calls |
| 🟡 Warning | API response time > 1000ms | Same observer, lower threshold |
| 🔴 Critical | API response payload > 2 MB | `list_network_requests` → response body size |
| 🟡 Warning | API response payload > 500 KB | Same, lower threshold |

### Lighthouse Suite

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Lighthouse accessibility score < 50 / 100 | `lighthouse_audit` (accessibility category) |
| 🟡 Warning | Lighthouse accessibility score 50–89 / 100 | `lighthouse_audit` |
| 🟡 Warning | Lighthouse performance score < 90 / 100 | `lighthouse_audit` (performance category) |
| 🟡 Warning | Lighthouse SEO score < 90 / 100 | `lighthouse_audit` (seo category) |
| 🟡 Warning | Lighthouse best-practices score < 90 / 100 | `lighthouse_audit` (best-practices category) |
| 🟡 Warning | Individual failing Lighthouse audit items | Surfaced per-audit from the full Lighthouse report |

### Memory Leaks

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | > 100 detached DOM nodes in V8 heap — severe leak | `take_memory_snapshot` → parse flat nodes array for "Detached Xxx" names |
| 🟡 Warning | > 10 detached DOM nodes in V8 heap — probable leak | Same snapshot parse, lower threshold |
| 🟡 Warning | Heap grew > 2 MB after navigate-away + navigate-back — probable per-load leak | `performance.memory.usedJSHeapSize` delta across round-trip (soft — GC-dependent) |

### Runtime Anti-Patterns

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🟡 Warning | Synchronous `XMLHttpRequest` — blocks the main thread until the server responds | `XMLHttpRequest.open` patched via `addScriptToEvaluateOnNewDocument`; `async === false` calls recorded |
| 🟡 Warning | `document.write` / `document.writeln` called — can erase the page or block parsing | `document.write` and `document.writeln` patched before page load; calls recorded with method + content |
| 🟡 Warning | Long task > 50ms on the main thread — blocks user interaction | `PerformanceObserver` with `entryTypes: ['longtask']` injected before page load |
| 🔴 Critical | CORS policy violation — cross-origin fetch blocked by the browser | `list_console_messages` + pattern match for `"has been blocked by CORS policy"` |
| 🟡 Warning | Service worker registration failure — SW script returns 4xx or is invalid | `navigator.serviceWorker.register` patched before page load; `.catch()` records failing script URL |
| 🔵 Info | Same-origin static asset (`.js`, `.css`, `.png`, `.woff2`, etc.) served without `Cache-Control` or `ETag` — browsers cannot cache it efficiently | `evaluate_script` reads `performance.getEntriesByType('resource')`, HEAD-fetches each unique same-origin asset, checks response headers |

### Historical Baselines & Trends

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | New critical finding not present in the saved baseline — regression introduced since last run | `applyBaseline` compares finding keys (`type::message[:100]::status`) against `reports/baselines/<branch>.json` (D7.2 per-branch) |
| 🟡 Warning | New warning finding not present in the baseline | Same key comparison, warning severity |
| 🔵 Info | Pre-existing finding still present — no change since last run | Suppressed from real-time alerts; included in info digest only |
| 🔵 Info | Run trend summary — new vs resolved counts, saved per run | Appended to `reports/baselines/<branch>-trends.json`; surfaced as a trend line in Slack digest |

### Flakiness Detection

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| original | Confirmed finding — present in both crawl runs | `mergeRunResults` finds the key in both run1 and run2 (`type::message[:100]::status` scheme); original severity kept |
| 🔵 Info | Flaky finding — appeared in only one of two crawl runs | Present in run1 or run2 but not both; downgraded to `severity: 'info'`, labelled `:zap: _flaky_` in Slack digest |

### User Flow Assertions

| Severity | Bug / Issue | Detection Method |
|---|---|---|
| 🔴 Critical | Flow step failed — navigate/fill/click/waitFor threw mid-flow (page state unknown) | `flow-runner.js` wraps every step; any throw emits `flow_step_failed` and halts the flow |
| 🔴 Critical | `element_visible` assert — expected selector absent within timeout | Polled via `evaluate_script` + `document.querySelector` (MCP `wait_for` doesn't reliably throw on timeout) |
| 🟡 Warning | `no_console_errors` assert — console errors recorded *during* this flow (baseline-sliced, not session-wide) | Baseline snapshot of `list_console_messages` at flow start; only messages after that offset count |
| 🟡 Warning | `no_network_errors` assert — 4xx/5xx request during this flow (baseline-sliced) | Baseline snapshot of `list_network_requests` at flow start; status ≥ 400 after offset |
| 🟡 Warning | `url_contains` assert — URL does not include expected substring after flow completes | `evaluate_script` reads `window.location.href` |
| 🟡 Warning | `element_not_visible` assert — selector unexpectedly present in DOM | `evaluate_script` → `!document.querySelector(...)` |
| 🔴 Critical | `no_js_errors` assert — uncaught exceptions captured in `window.__argusErrors` during flow | Script parses the injected error buffer |

### Environment Regressions *(dev vs staging)*

| Severity | Bug / Issue | Detection Method |
|---|---|---|
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
|---|---|
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
| **Historical Baselines** | Saves finding keys after each run; subsequent runs only alert on *new* issues; trend summary in Slack digest |
| **Flakiness Detection** | Crawls each route twice per run; findings in both runs are confirmed (original severity); findings in only one run are marked flaky (`severity: info`, `:zap: _flaky_` label) |
| **User Flow Assertions** | Named multi-step flows (`navigate/fill/click/press_key/waitFor/sleep/handle_dialog/assert`) with baseline-sliced `no_console_errors`, `no_network_errors`, `element_visible`, `url_contains`, `no_js_errors` asserts — runs end-to-end user journeys without writing Playwright specs |
| **API Contract Validation** | Define `apiContracts[]` in `targets.js` with inline `schema` or `schemaFile`; validates captured response bodies against JSON Schema (type, required, properties, items) — emits `api_contract_violation` warnings when shapes diverge from spec |
| **Severity Policy Overrides** | Define `severityOverrides` in `targets.js` (`{ finding_type: 'info' \| 'warning' \| 'critical' \| 'suppress' }`); applied before Slack routing — remap or silence specific detections without touching analyzer code |
| **Auth Token Refresh** | `refreshSession()` is called before each route; re-runs the login flow when the saved session has less than `sessionRefreshWindowMs` (default 5 min) remaining — prevents long crawls from failing mid-run when the auth cookie expires |
| **Slack-optional mode** | When `SLACK_BOT_TOKEN` is not configured, Argus skips Slack entirely and auto-generates a local `report.html` (all findings + inline screenshots) and opens it in the default browser — zero setup required to start using Argus |
| **Full Lighthouse Suite** | All 4 Lighthouse categories (performance, SEO, best-practices, accessibility) with per-audit items |
| **Performance Budgets** | Enforces LCP < 2500ms, CLS < 0.1, FID < 100ms, TTFB < 800ms per route |
| **Slack Notifications** | Rich Block Kit reports with inline screenshots routed to `#bugs-critical`, `#bugs-warnings`, `#bugs-digest` |
| **Slash Command** | `/argus-retest <url>` triggers an on-demand test from any Slack channel |
| **CI Integration** | GitHub Actions workflow runs daily at 6 AM UTC and on every push to `main` |

Works with **React + SCSS**, CSS Modules, CSS-in-JS (styled-components / emotion), and plain HTML/CSS apps.

---

## How It Works

Three components run against the same Chrome instance:

```
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
|---|---|---|
| Node.js | v20.19+ | Required by Chrome DevTools MCP |
| Chrome | Stable (current) | Must be installed |
| Claude Code | Latest | `npm install -g @anthropic-ai/claude-code` |
| Slack workspace | — | Admin access or permission to install apps |

---

## One-Time Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd argus
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
# Your app URLs (required)
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.yourapp.com   # leave blank → CSS-only analysis mode

# Slack — OPTIONAL. Omit to get a local report.html instead of Slack messages.
# Get from: api.slack.com/apps → BugBot → OAuth & Permissions
# SLACK_BOT_TOKEN=xoxb-...
# SLACK_SIGNING_SECRET=...

# Channel IDs — only needed when SLACK_BOT_TOKEN is set
# SLACK_CHANNEL_CRITICAL=C0000000000
# SLACK_CHANNEL_WARNINGS=C0000000001
# SLACK_CHANNEL_DIGEST=C0000000002
```

### 3. Configure your routes

Edit [src/config/targets.js](src/config/targets.js) — add every key page of your app:

```js
export const routes = [
  { path: '/',          name: 'Home',      critical: true,  waitFor: 'main' },
  { path: '/login',     name: 'Login',     critical: true,  waitFor: 'form' },
  { path: '/dashboard', name: 'Dashboard', critical: true,  waitFor: '[data-testid="dashboard"]' },
  { path: '/settings',  name: 'Settings',  critical: false, waitFor: null },
];
```

- `critical: true` — any error on this route goes to `#bugs-critical`
- `waitFor` — CSS selector Argus waits for before capturing (signals the page is ready)

### 4. Connect Chrome DevTools MCP to Claude Code

```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
```

Verify it's working — in Claude Code, ask:
> "List all open Chrome pages"

You should see a list of tabs. If you do, the MCP connection is live.

### 5. Set up the Slack App (BugBot)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch → name it **BugBot**
2. **OAuth & Permissions** → Bot Token Scopes: add `chat:write`, `files:write`, `files:read`
3. Click **Install to Workspace** → Authorize
4. Copy the **Bot User OAuth Token** (`xoxb-...`) into `.env` as `SLACK_BOT_TOKEN`
5. **Basic Information** → copy **Signing Secret** into `.env` as `SLACK_SIGNING_SECRET`
6. Create channels: `#bugs-critical`, `#bugs-warnings`, `#bugs-digest`
7. In each channel: `/invite @BugBot`

---

## Running Argus

### Option A: From Claude Code (interactive — recommended)

Open Claude Code in this project directory. With Chrome DevTools MCP connected, ask:

```
Run the Argus error detection crawl on localhost:3000
```

Claude calls `runCrawl(mcp)` with live MCP tools — navigates pages, captures errors, posts to Slack.

```
Run the Argus environment comparison between localhost:3000 and staging
```

Claude calls `runComparison(mcp)` — screenshots both, diffs them, posts results.

### Option B: From the terminal (CI / headless)

```bash
# Error detection crawl
npm run crawl

# Generate a self-contained HTML report from the latest JSON (offline-friendly)
npm run report:html

# Environment comparison (or CSS analysis if no staging URL)
npm run compare

# Start the Slack interaction server
npm run server
```

Reports are saved to `reports/` as JSON files. Screenshots saved alongside. Run `npm run report:html` after any crawl to get a portable `reports/report.html` with all screenshots inlined — useful for sharing with designers, PMs, or reviewing offline.

### Option C: From Slack (on-demand)

```
/argus-retest https://staging.yourapp.com/checkout
```

BugBot responds immediately, runs the test, and posts results back to the channel. Detailed bug reports go to `#bugs-critical`.

---

## CSS Analysis Mode

When `TARGET_STAGING_URL` is not set in `.env`, `npm run compare` automatically switches to **CSS analysis mode** instead of comparing two environments.

**What it analyzes on your dev environment:**

| Check | What it catches |
|---|---|
| **Cascade overrides** | Same CSS property declared multiple times on an element; `!important` flagged as warning |
| **Component style leaks** | BEM selector (`.card__title`) found in a stylesheet that doesn't belong to that component |
| **Unused rules** | CSS selectors that match no element on the current page |
| **CSS Modules** | Detects hashed class names; extracts readable component names (`Button`, `Card`, etc.) |
| **React inline style conflicts** | `style=""` attribute overriding a stylesheet declaration on the same element |
| **SCSS source maps** | Traces compiled CSS back to original `.scss` files where source maps are available |

**API frequency analysis** also runs automatically:

| Call count | Severity | Likely cause |
|---|---|---|
| 2 calls | info | Possible prefetch + actual — verify intentional |
| 3–4 calls | warning | Double-fetch — check `useEffect` deps or component re-mounts |
| 5+ calls | critical | Runaway loop — missing cleanup, infinite re-render |

---

## Performance Budgets

Argus enforces these thresholds on every crawl:

| Metric | Threshold | Severity |
|---|---|---|
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
|---|---|---|
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

```
/argus-retest http://localhost:3000
```

BugBot should reply within 3 seconds with a "running" acknowledgement, then post results.

---

## GitHub Actions CI Setup

### Add secrets to your repository

Go to GitHub repo → **Settings** → **Secrets and variables** → **Actions** → add:

| Secret name | Value |
|---|---|
| `SLACK_BOT_TOKEN` | Your `xoxb-...` token |
| `SLACK_SIGNING_SECRET` | From Slack App → Basic Information |
| `SLACK_CHANNEL_CRITICAL` | Channel ID |
| `SLACK_CHANNEL_WARNINGS` | Channel ID |
| `SLACK_CHANNEL_DIGEST` | Channel ID |
| `TARGET_STAGING_URL` | Your staging base URL |

The workflow at [.github/workflows/argus.yml](.github/workflows/argus.yml) runs:
- On every push to `main` / `master`
- Daily at 6 AM UTC (before the team starts work)
- Manually via **Actions** → **Run workflow** (with optional URL override)

If critical issues are found, the pipeline **fails** — preventing silent regressions from being missed.

---

## Project Structure

```
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
├── src/
│   ├── config/
│   │   └── targets.js                # Routes to test, thresholds, config
│   ├── orchestration/
│   │   ├── crawl-and-report.js       # Error detection pipeline (calls all analysis engines)
│   │   ├── env-comparison.js         # Dev vs staging diff + CSS analysis mode
│   │   └── slack-notifier.js         # Slack Block Kit dispatcher
│   ├── server/
│   │   ├── index.js                  # Express server (port 3001)
│   │   ├── slash-command-handler.js  # /argus-retest handler
│   │   └── interaction-handler.js    # Acknowledge + Retest button handler
│   └── utils/
│       ├── css-analyzer.js           # CSS analysis script injected into the browser
│       ├── seo-analyzer.js           # SEO checks: meta, OG tags, h1, canonical, viewport
│       ├── security-analyzer.js      # Security: localStorage tokens, eval(), headers, cookies
│       ├── content-analyzer.js       # Content quality: null text, placeholders, broken images
│       ├── responsive-analyzer.js    # Responsive: overflow + touch targets at 4 breakpoints
│       ├── memory-analyzer.js        # Memory leaks: V8 heap snapshot + heap growth
│       ├── session-manager.js        # Auth: saveSession, restoreSession, runLoginFlow, refreshSession (D7.6)
│       ├── baseline-manager.js       # Baselines: loadBaseline, saveBaseline, applyBaseline, appendTrend
│       ├── flakiness-detector.js     # Flakiness: mergeRunResults — confirmed vs flaky per double-crawl
│       ├── flow-runner.js            # User flow assertions: runFlow / runAllFlows — assert DSL
│       ├── html-reporter.js          # HTML dashboard: generateHtmlReport() + npm run report:html (D7.1 / D7.7)
│       ├── parallel-crawler.js       # chunkArray sharding utility (ARGUS_CONCURRENCY=N parallel crawl)
│       ├── contract-validator.js     # API contract validation: validateSchema, matchesContract (D7.4)
│       ├── severity-overrides.js     # Severity policy overrides: applyOverrides (D7.5)
│       ├── slack-guard.js            # Slack-optional guard: isSlackConfigured() (D7.7)
│       ├── diff.js                   # pixelmatch screenshot + DOM/network diff utilities
│       └── mcp-client.js             # Headless JSON-RPC MCP client for CI mode
├── test-harness/                     # Fixture server + test runner (45 blocks, 192 hard assertions, 31 categories)
│   ├── README.md
│   ├── server.js                     # Express fixture server (ports 3100 dev / 3101 staging)
│   ├── harness-config.js             # Route definitions + expected findings
│   ├── validate.js                   # Test runner — 45 numbered blocks
│   ├── pages/                        # 39 fixture pages (one per detection category)
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
|---|---|---|
| Screenshot comparison | pixelmatch + AI classification | pixelmatch is fast and deterministic; Claude removes false positives from anti-aliasing and dynamic content |
| Slack API | Bot API, not Incoming Webhooks | Bot API supports file uploads, message updates, interactive buttons, and threads |
| File uploads | `files.getUploadURLExternal` + PUT + `files.completeUploadExternal` | `files.upload` is deprecated; pre-signed URL requires PUT — POST silently produces broken files |
| CSS analysis | Script injected via `evaluate_script` | Runs in page context so it sees the live computed styles, CSS Modules hashes, and React fiber properties |
| Responsive viewport | `emulate` (not `resize_page`) | `resize_page` only resizes the browser window and does not update CSS viewport width — `emulate` is the correct API |
| Viewport width measurement | `document.documentElement.clientWidth` | After `emulate` with mobile flag, `window.innerWidth` returns the legacy layout viewport (~952px), not the device width |
| V8 heap snapshot | `take_memory_snapshot({ filePath })` → read from disk | The MCP tool writes JSON to disk (not inline); parse with `JSON.parse(fs.readFileSync(filePath))` then delete the temp file |
| Detached DOM detection | Walk flat `nodes` array for "Detached " prefix in strings table | Chrome serializes detached elements as "Detached HTMLDivElement" etc.; secondary check on `detachedness === 2` (Chrome 90+) |
| Baseline finding key | `type::message[:100]::status` | Excludes timestamps and dynamic URL path IDs; message truncated to 100 chars to handle slight wording variations; `::status` suffix only added when non-null |
| Baseline alert filter | `isNew !== false` (not `=== true`) | Findings without `isNew` set (e.g. if baseline-manager not used) are still included in alerts — backwards-compatible |
| Flakiness routing | `severity: 'info'` for flaky findings | Downgrading severity means existing `dispatchToSlack` routing sends them to the info digest with zero routing changes — only the `:zap: _flaky_` label needed |
| Private `findingKey` per module | Each of `baseline-manager.js` and `flakiness-detector.js` has its own copy | Avoids coupling two independently-useful modules via a shared export for a trivial 3-line function |
| Runtime anti-pattern injection | `addScriptToEvaluateOnNewDocument` via MCP | Scripts registered this way run in the new page context before any page script — intercepts `XMLHttpRequest.open`, `document.write`, and `navigator.serviceWorker.register` before the page can call them |
| CORS error detection | `list_console_messages` + text match, not in-page intercept | CORS errors are generated by the browser itself, not by page JS — `console.error` patcher misses them; the MCP console log captures them |
| Long task detection | `PerformanceObserver({ entryTypes: ['longtask'] })` injected before load | Only the duration is included in the finding message (not `startTime`) — ensures identical tasks on two crawl runs produce the same dedup key |
| CI MCP client | JSON-RPC over stdio | In CI there's no Claude Code agent — the headless client replaces it with the same API surface |
| Node.js | v20.19+ | Minimum required by Chrome DevTools MCP |

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
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

---

## Troubleshooting

**Chrome DevTools MCP not connecting**
```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
# Then restart Claude Code
```

**Slack messages not posting**
- Confirm `SLACK_BOT_TOKEN` starts with `xoxb-` (not `xoxp-`, `xoxe-`, or `xapp-`)
- Verify BugBot is invited to each channel: `/invite @BugBot`
- Check token scopes: `chat:write`, `files:write`, `files:read`

**Screenshots not appearing in Slack messages**
- The upload uses a pre-signed URL that requires `PUT`, not `POST` — if you see a broken image, check that the Slack token has `files:write` scope and the channel is correct

**Slash command returns "dispatch_failed"**
- Your tunnel URL has changed (Cloudflare Tunnel / localhost.run URLs change on restart)
- Update the Request URL in Slack App → Slash Commands and reinstall

**CSS analysis returns empty results**
- Page may be behind auth — make sure you're logged in on the Chrome instance Argus is controlling
- Cross-origin stylesheets (CDN fonts, third-party widgets) can't be read due to browser security restrictions — this is expected

**Screenshots are blank**
- Page hasn't finished loading — increase `pageSettleMs` in `src/config/targets.js`
- Add a `waitFor` selector for that route

**CI pipeline fails immediately**
- Chrome may not be starting fast enough — increase the `sleep 3` after Chrome launch to `sleep 5` in `.github/workflows/argus.yml`

---

## How Argus Differs From Playwright / Cypress

Argus is not a replacement for unit or E2E tests. It's a complementary layer:

| | Playwright / Cypress | Argus |
|---|---|---|
| **Tests** | Your logic and API contracts | What the user actually sees |
| **Catches** | Regression in behaviour | CSS drift, visual regressions, API redundancy, console noise, perf budgets |
| **Runs** | In your test suite | Continuously, on the live running app |
| **Setup** | Write test files | Configure routes in `targets.js` |
| **Output** | Pass / fail | Structured Slack reports with screenshots and action buttons |

They complement each other — Argus catches what test suites miss.
