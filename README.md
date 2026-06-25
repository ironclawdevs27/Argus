<div align="center">

# Argus — AI-Powered Automated QA

[![npm](https://img.shields.io/npm/v/argusqa-os?color=7C3AED)](https://www.npmjs.com/package/argusqa-os)
[![MCP Server](https://glama.ai/mcp/servers/ironclawdevs27/Argus/badges/card.svg)](https://glama.ai/mcp/servers/ironclawdevs27/Argus)
[![Harness](https://img.shields.io/badge/harness-961%2F961-4ADE80)](test-harness/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Argus catches the bugs your test suite misses — visual regressions, API loops, CSS drift, console noise, accessibility failures, and more — and delivers rich reports to Slack (or a local HTML dashboard).**

[Quick Start](#quick-start) · [Features](#what-argus-catches) · [Setup](#full-setup) · [MCP Tools](#mcp-tools) · [CLI Commands](#cli-commands) · [Troubleshooting](#troubleshooting) · [Full Reference](REFERENCE.md)

</div>

---

## Quick Start

> **No install required.** `npx` auto-downloads Argus on first run.

**Step 1 — Add to `.mcp.json`** in your project root:

```json
{
  "mcpServers": {
    "chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] },
    "argus":           { "command": "npx", "args": ["-y", "argusqa-os"] }
  }
}
```

Or via Claude Code CLI:

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
claude mcp add argus -- npx -y argusqa-os
```

**Step 2 — Start Chrome with remote debugging:**

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"

# Linux
google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox
```

**Step 3 — Run an audit:**

```
Run argus_audit on http://localhost:3000
```

Argus scans your app and either posts findings to Slack or opens a local `report.html`. That's it.

---

## What Argus Catches

32 analysis engines, 140 distinct issue types, zero test-file maintenance:

| Category | What it detects |
|---|---|
| **JavaScript** | Uncaught exceptions, unhandled promise rejections, `console.error` on critical routes |
| **Network & API** | HTTP 5xx, 401/403 auth failures, duplicate API calls (infinite loops), 4xx errors, broken links |
| **Performance** | LCP > 2500ms, CLS > 0.1, TTFB > 800ms, slow APIs > 1s/3s, payloads > 500KB/2MB, JS bundles > 500KB |
| **Accessibility** | axe-core (80+ WCAG rules), color-blind simulation, missing ARIA, keyboard focus, heading hierarchy |
| **SEO** | Missing meta description, OG tags, canonical, viewport, h1 |
| **Security** | Auth tokens in localStorage/URL, `eval()`, missing CSP/X-Frame-Options, CSP violations, missing SRI on external scripts, source map exposure, open redirects, npm CVEs |
| **CSS** | Cascade overrides, component style leaks, unused rules, React inline style conflicts |
| **Content** | `null`/`undefined` as visible text, lorem ipsum, broken images, empty data lists |
| **Responsive** | Horizontal overflow at 375px/768px, touch targets < 44×44px |
| **Memory** | Detached DOM nodes via V8 heap snapshot, heap growth across navigation |
| **Visual** | Pixel-level screenshot regression via pixelmatch (≥0.1% warning, ≥5% critical) |
| **Figma** | Design-to-implementation fidelity — 13 property types (color, spacing, typography, shadows, etc.) |
| **Forms** | Missing `required`, `autocomplete`, `aria-describedby`; unlabelled inputs |
| **Fonts** | FOIT, FOUT, missing fallbacks, slow loads > 1s, suboptimal formats |
| **Motion** | `prefers-reduced-motion` violations, `autoplay` without pause controls |
| **Network baseline** | New requests, missing requests, status-code regressions vs saved HAR baseline |
| **Environment diff** | Dev vs staging — screenshot diff, DOM changes, console/network regressions |

And every finding is post-processed with:

| Post-processor | What it adds |
|---|---|
| **Intelligent baseline filtering** | Findings that flip-flop across runs are tagged `noisy` and downgraded to info — pure cross-run heuristics, no API calls (`ARGUS_NOISE_FILTER=0` to disable) |
| **Root cause linking** | New findings are annotated with the recent git commits and files most likely to have caused them (`ARGUS_ROOT_CAUSE=0` to disable) |

> All findings are classified as `critical` / `warning` / `info` and routed to the right Slack channel — or surfaced in the local HTML report. For per-finding severity tables and detection methods, see [REFERENCE.md](REFERENCE.md).

---

## MCP Tools

Ask Claude (or any MCP client) — no terminal required:

| Tool | Description |
|---|---|
| `argus_audit` | Fast pass — JS, network, accessibility, SEO, security, CSS, content |
| `argus_audit_full` | Deep pass — adds Lighthouse, responsive checks, memory leak detection, hover-state bugs |
| `argus_compare` | Diff dev vs staging — screenshots, findings delta, environment regressions |
| `argus_get_context` | Capture everything broken on the open tab for Claude to diagnose |
| `argus_watch_snapshot` | Snapshot the open tab without navigating (preserves auth/form state) |
| `argus_last_report` | Return last JSON report without re-running |
| `argus_design_audit` | Figma URL → 13 design-token finding types (color, spacing, typography, shadows, etc.) |
| `argus_visual_diff` | Screenshot baseline comparison. Pass `updateBaseline: true` to reset. |
| `argus_pr_validate` | Fetch GitHub PR diff → map changed files to affected routes → targeted audit → baseline-aware block decision (blocks on findings the PR *introduces*) + idempotent PR comment + Check Run → `{ blocked, findings, baseline, reporting }` |

**Example prompts:**

```
Run argus_audit on http://localhost:3000/checkout
Run argus_audit_full on http://localhost:3000/dashboard
Run argus_compare
Run argus_get_context
```

---

## Full Setup

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | v20.19+ |
| Chrome | Stable (desktop or headless) |
| Claude Code | Latest (`npm install -g @anthropic-ai/claude-code`) |
| Slack workspace | **Optional** — omit for local `report.html` mode |

---

### Option A — MCP Server *(recommended for Claude Code users)*

No local install needed. Use the [Quick Start](#quick-start) above, then add your target URL:

```env
# .env in your project root
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.example.com   # optional — enables argus_compare
```

**Optional — Slack notifications:**

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → name it **BugBot**
2. OAuth & Permissions → Bot Token Scopes: `chat:write`, `files:write`, `files:read`
3. Install to workspace → copy the `xoxb-...` token
4. Create channels `#bugs-critical`, `#bugs-warnings`, `#bugs-digest` and run `/invite @BugBot` in each

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_CRITICAL=C0000000000
SLACK_CHANNEL_WARNINGS=C0000000001
SLACK_CHANNEL_DIGEST=C0000000002
```

> Without Slack: Argus auto-generates `reports/report.html` and opens it in your browser — zero extra config.

---

### Option B — npm Package (CI / dev dependency)

```bash
npm install --save-dev argusqa-os
npx argus init   # interactive wizard — detects framework, discovers routes, writes .env
npm run crawl    # run after Chrome is started
```

---

### Option C — Clone the Repository (contributors / full source)

```bash
git clone https://github.com/ironclawdevs27/Argus.git
cd Argus
npm install
npm run init     # interactive setup wizard
```

**Manual setup (skip the wizard):**

```bash
cp .env.example .env
# Fill in TARGET_DEV_URL and optional Slack tokens
```

Then configure your routes in [src/config/targets.js](src/config/targets.js):

```js
export const routes = [
  { path: '/',          name: 'Home',      critical: true,  waitFor: 'main' },
  { path: '/login',     name: 'Login',     critical: true,  waitFor: 'form' },
  { path: '/dashboard', name: 'Dashboard', critical: true,  waitFor: '[data-testid="dashboard"]' },
  { path: '/settings',  name: 'Settings',  critical: false, waitFor: null },
];
```

- `critical: true` — errors on this route go to `#bugs-critical`
- `waitFor` — CSS selector Argus waits for before capturing (signals page-ready)

---

## CLI Commands

```bash
npm run chrome         # Launch Chrome with --remote-debugging-port=9222 (auto-detects binary)
npm run doctor         # Pre-flight check: Chrome reachable, .mcp.json valid, .env has TARGET_DEV_URL
npm run crawl          # Batch audit of all configured routes
npm run compare        # Dev vs staging diff (CSS-only if no staging URL)
npm run watch          # Passive monitor — polls open Chrome tab every 1s
npm run report:html    # Generate reports/report.html from last JSON audit
npm run report:pdf     # Export HTML report to A4 PDF (requires: npm install puppeteer)
npm run server         # Start Slack slash-command server (port 3001)
npm run init           # Interactive setup wizard
npm run test:unit          # 366 unit tests — no Chrome required
npm run test:harness       # 166-block correctness harness — requires Chrome
npm run test:harness:log   # same, but tees full output to harness-results.txt
npm run test:coverage      # merged unit + harness coverage gate (requires Chrome)
```

**Watch mode** — live monitoring as you develop:

```bash
# Terminal 1: start your app
npm run dev

# Terminal 2: start Argus watcher
npm run watch
# Ctrl+C → stops monitor and writes reports/report.html
```

**Slack slash command** (on-demand from any channel):

```
/argus-retest https://staging.example.com/checkout
```

To expose the server via tunnel: `cloudflared tunnel --url http://localhost:3001` (free, no account required). Set the resulting URL as the Request URL in Slack App → Slash Commands.

---

## GitHub Actions CI

Add to your repo's secrets (Settings → Secrets → Actions):

| Secret | Required | Value |
|---|---|---|
| `TARGET_STAGING_URL` | Yes | Your staging base URL |
| `SLACK_BOT_TOKEN` | No | `xoxb-...` token (omit for HTML-only mode) |
| `SLACK_CHANNEL_CRITICAL` | No* | Channel ID (needed when Slack is configured) |
| `SLACK_CHANNEL_WARNINGS` | No* | Channel ID |
| `SLACK_CHANNEL_DIGEST` | No* | Channel ID |
| `GITHUB_TOKEN` | No | Auto-injected by Actions for PR comments + Check Runs |

The included [workflow](.github/workflows/argus.yml) runs on push to `main`, daily at 6 AM UTC, and on manual trigger. If critical issues are found, the pipeline fails.

---

## Environment Variables

<details>
<summary>Full reference (click to expand)</summary>

| Variable | Default | Description |
|---|---|---|
| `TARGET_DEV_URL` | — | **Required.** Base URL of your dev environment |
| `TARGET_STAGING_URL` | — | Staging URL — enables `argus_compare`; omit for CSS-only mode |
| `SLACK_BOT_TOKEN` | — | `xoxb-...` token. Omit for local `report.html` mode |
| `SLACK_SIGNING_SECRET` | — | For `/argus-retest` slash command verification |
| `SLACK_CHANNEL_CRITICAL` | — | Channel ID for critical bugs |
| `SLACK_CHANNEL_WARNINGS` | — | Channel ID for warnings |
| `SLACK_CHANNEL_DIGEST` | — | Channel ID for info / daily digest |
| `PORT` | `3001` | Slack slash-command server port |
| `REPORT_OUTPUT_DIR` | `./reports` | Where to write JSON reports |
| `ARGUS_CONCURRENCY` | `1` | Parallel MCP clients for route crawling |
| `ARGUS_LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `ARGUS_LOG_PRETTY` | — | Set `1` for human-readable logs in dev |
| `ARGUS_RETRY_ATTEMPTS` | `3` | Max retries for `navigate`/`fill` MCP calls |
| `ARGUS_WATCH_INTERVAL_MS` | `1000` | Watch mode poll interval (ms) |
| `ARGUS_WATCH_UI_PORT` | `3002` | Watch mode web dashboard port |
| `ARGUS_SOURCE_DIR` | — | App source path — enables env-var / feature-flag / dead-route analysis **and** framework-aware PR route mapping (import-graph: a changed component/stylesheet → only the routes that render it) |
| `ARGUS_ENV_FILE` | — | Path to app `.env` for codebase cross-reference |
| `SCREENSHOT_DIFF_THRESHOLD` | `0.5` | Pixel diff % threshold for environment comparison |
| `GITHUB_TOKEN` | — | For PR comments + Check Runs |
| `GITHUB_REPOSITORY` | — | `owner/repo` format |
| `GITHUB_PR_NUMBER` | — | Auto-injected by Actions from PR context |
| `ARGUS_CRITICAL_THRESHOLD` | `1` | New criticals before blocking merge (0 = never block) |
| `ARGUS_DIFF_IMAGE_URL` | — | Visual diff image URL to embed in PR comment |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP collector for Jaeger / Grafana Tempo |
| `FIGMA_API_TOKEN` | — | Required for `argus_design_audit` |
| `FONT_SLOW_MS` | `1000` | Slow web font load threshold (ms) |
| `A11Y_CONTRAST_AA` | `4.5` | WCAG AA min contrast ratio for CVD simulation |

</details>

---

## Troubleshooting

**Chrome DevTools MCP not connecting**
```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
# Restart Claude Code after adding
```

**Slack messages not posting**
- Token must start with `xoxb-` (not `xoxp-`, `xoxe-`, or `xapp-`)
- Run `/invite @BugBot` in each channel
- Required scopes: `chat:write`, `files:write`, `files:read`

**Screenshots are blank**
- Page hasn't settled — increase `pageSettleMs` in `src/config/targets.js` or add a `waitFor` selector for the route

**`/argus-retest` returns "dispatch_failed"**
- Tunnel URL changed — update the Request URL in Slack App → Slash Commands and reinstall

**CSS analysis returns empty results**
- Page may be behind auth — ensure you're logged in on the Chrome instance Argus is controlling

**CI pipeline fails immediately**
- Chrome may not start fast enough — increase `sleep 3` to `sleep 5` in [.github/workflows/argus.yml](.github/workflows/argus.yml)

---

## How Argus Differs From Playwright / Cypress

Argus is a **complementary layer**, not a replacement for unit or E2E tests:

| | Playwright / Cypress | Argus |
|---|---|---|
| **Purpose** | Test your logic and API contracts | Catch what the user actually sees |
| **What it catches** | Regressions in behavior | CSS drift, visual regressions, API loops, console noise, perf budgets |
| **When it runs** | In your test suite | Continuously, on the live running app |
| **Setup** | Write test files | Configure routes in `targets.js` |
| **Output** | Pass / fail | Structured Slack reports with screenshots |

---

## Known Limitations

All 961 harness assertions pass (`961/961`) — there are currently no known MCP- or Chrome-layer restrictions. Lighthouse now runs in headless (after the `lighthouse_audit` argument fix); the remaining soft assertions (perf traces, GC-dependent heap-growth) are promoted to counted hard assertions only in the weekly strict-soft lane (`harness-strict.yml`) via `ARGUS_HARNESS_STRICT_SOFT`.

---

## Project Structure

```
src/
  argus.js              — single-page audit entry point
  mcp-server.js         — 9 MCP tools exposed to Claude / any MCP client
  orchestration/        — crawl loop, Slack/GitHub dispatch, env comparison, watch mode
  utils/                — 32 analysis engines (accessibility, security, performance, PDF, recording, etc.)
  adapters/browser.js   — CdpBrowserAdapter — wraps all chrome-devtools-mcp calls
  config/targets.js     — routes, thresholds, auth steps
  cli/
    init.js             — argus init interactive setup wizard
    chrome-launcher.js  — npm run chrome / argus-chrome — launches Chrome with correct flags
    doctor.js           — npm run doctor / argus-doctor — pre-flight checks
    pr-validate.js      — headless CI entry point for GitHub Actions
test-harness/           — 166-block correctness harness, 961 hard assertions, 63 fixture pages
test/unit/              — 366 Vitest unit tests (no Chrome required)
landing/                — Product landing page (React 19 + Vite + Tailwind)
```

Full source map → [CLAUDE.md](CLAUDE.md) · MCP/DSL reference → [SKILL.md](SKILL.md)

---

## Contributing

1. Fork the repo and create a branch
2. `npm run test:unit` — verify without Chrome (366 tests)
3. `npm run test:harness` — full integration coverage (requires Chrome on port 9222)
4. Open a PR — Argus audits itself via the CI workflow

---

## License

MIT © [ironclawdevs27](https://github.com/ironclawdevs27)

---

<div align="center">

*Argus Panoptes — the all-seeing giant of Greek mythology who never slept.*

[argus-qa.com](https://argus-qa.com) · [npm](https://www.npmjs.com/package/argusqa-os) · [MCP Registry](https://glama.ai/mcp/servers/ironclawdevs27/Argus)

</div>
