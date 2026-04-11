# Argus — AI-Powered Dev Testing Tool

> *Argus Panoptes — the all-seeing giant of Greek mythology with a hundred eyes who never slept.*

Automated browser testing pipeline that catches bugs, compares environments, and sends rich reports to Slack — powered by Chrome DevTools MCP and Claude Code.

<div align="center">

[![](https://skillicons.dev/icons?i=nodejs,js,expressjs,react,css,sass,github,githubactions,vscode)](https://skillicons.dev)

</div>

---

## What Argus Catches

Argus runs seven independent analysis engines on every page crawl. Every finding is classified by severity and routed to the right Slack channel automatically.

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
| **Error Detection** | Crawls your app's routes; captures JS exceptions, console errors, and failed API calls |
| **Environment Comparison** | Diffs dev vs staging: screenshots, DOM structure, network requests, console errors |
| **CSS Analysis** | Detects cascade overrides, component style leaks, unused rules, React inline style conflicts |
| **API Frequency Analysis** | Flags endpoints called more than once per page load (double-fetch, missing `useEffect` deps, infinite loops) |
| **Performance Budgets** | Enforces LCP < 2500ms, CLS < 0.1, FID < 100ms, TTFB < 800ms per route |
| **Accessibility Gate** | Lighthouse audit per route; score < 90 = warning, score < 50 = critical |
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
# Slack — get from api.slack.com/apps → BugBot → OAuth & Permissions
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Channel IDs (right-click channel in Slack → Copy link → last segment is the ID)
SLACK_CHANNEL_CRITICAL=C0000000000
SLACK_CHANNEL_WARNINGS=C0000000001
SLACK_CHANNEL_DIGEST=C0000000002

# Your app URLs
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.yourapp.com   # leave blank → CSS-only analysis mode
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

# Environment comparison (or CSS analysis if no staging URL)
npm run compare

# Start the Slack interaction server
npm run server
```

Reports are saved to `reports/` as JSON files. Screenshots saved alongside.

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

## Accessibility Gate

Runs a Lighthouse accessibility audit on every route:

- Score **< 90** → posted as `warning` to `#bugs-warnings`
- Score **< 50** → posted as `critical` to `#bugs-critical`
- Individual failing audits (e.g., missing alt text, low contrast) surfaced as separate findings

---

## Slack Channel Routing

| Severity | Channel | When |
|---|---|---|
| `critical` | `#bugs-critical` | JS exceptions, HTTP 5xx, blank page, auth failure, API called 5+ times, Lighthouse < 50 |
| `warning` | `#bugs-warnings` | Visual regression > 0.5%, HTTP 4xx, CSS overrides with `!important`, API called 3–4×, Lighthouse 50–89 |
| `info` | `#bugs-digest` | Console warnings, unused CSS rules, API summaries, CSS Modules detection |

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
│   │   ├── crawl-and-report.js       # Error detection pipeline
│   │   ├── env-comparison.js         # Dev vs staging diff + CSS analysis mode
│   │   └── slack-notifier.js         # Slack Block Kit dispatcher
│   ├── server/
│   │   ├── index.js                  # Express server (port 3001)
│   │   ├── slash-command-handler.js  # /argus-retest handler
│   │   └── interaction-handler.js    # Acknowledge + Retest button handler
│   └── utils/
│       ├── css-analyzer.js           # CSS analysis script injected into the browser
│       ├── diff.js                   # pixelmatch screenshot + DOM/network diff utilities
│       └── mcp-client.js             # Headless JSON-RPC MCP client for CI mode
└── reports/                          # Output: JSON reports + screenshots (gitignored)
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
| CI MCP client | JSON-RPC over stdio | In CI there's no Claude Code agent — the headless client replaces it with the same API surface |
| Node.js | v20.19+ | Minimum required by Chrome DevTools MCP |

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | `xoxb-...` Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Yes | Verifies slash command / interaction requests from Slack |
| `SLACK_CHANNEL_CRITICAL` | Yes | Channel ID for critical bugs |
| `SLACK_CHANNEL_WARNINGS` | Yes | Channel ID for warnings |
| `SLACK_CHANNEL_DIGEST` | Yes | Channel ID for info / daily digest |
| `TARGET_DEV_URL` | Yes | Base URL of your dev environment |
| `TARGET_STAGING_URL` | No | Base URL of staging. If blank → CSS analysis mode |
| `SCREENSHOT_DIFF_THRESHOLD` | No | Pixel diff % to flag (default: `0.5`) |
| `REPORT_OUTPUT_DIR` | No | Where to write reports (default: `./reports`) |
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
