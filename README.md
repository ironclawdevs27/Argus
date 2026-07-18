<div align="center">

# Argus — The QA Layer for AI-Assisted Development

### Your AI agent writes the code. **Argus checks what it actually built.**

[![MCP Server](https://glama.ai/mcp/servers/ironclawdevs27/Argus/badges/card.svg)](https://glama.ai/mcp/servers/ironclawdevs27/Argus)

[![npm](https://img.shields.io/npm/v/argusqa-os?color=7C3AED)](https://www.npmjs.com/package/argusqa-os)
[![Harness](https://img.shields.io/badge/harness-998%2F998-4ADE80)](test-harness/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

One line in your MCP config gives Claude (or any MCP agent) a real Chrome audit engine —
**67 audit categories · 149 finding types · zero test files to write or maintain.**
And with **Aegis**, what it finds **never leaks your secrets to the LLM**.

<!-- TODO(GTM): record the 30-second "Argus catches a real bug" GIF and embed it here.
     This is the single highest-leverage asset in the repo. Until then the landing link stands in. -->
**[▶ See it in action → argus-qa.com](https://argus-qa.com)**

[Quick Start](#quick-start) · [The Fix Loop](#the-fix-loop) · [What It Catches](#what-argus-catches) · [Your Stack](#works-with-your-stack) · [MCP Tools](#mcp-tools) · [Full Setup](#full-setup) · [Reference](REFERENCE.md)

</div>

---

## Why Argus Exists

AI agents now write most of the code — and they judge their own work by whether it *compiles and looks done*, not by what actually happens in the browser. The uncaught exception on the third click. The form that posts credentials over HTTP. The 4-second LCP. The button that vanished in dark mode. The API endpoint hammered in an infinite loop.

**Argus closes that gap.** It drives a real Chrome (via the Chrome DevTools Protocol) against your locally-running app and hands the agent — or you — a structured, severity-ranked bug report. The agent fixes; Argus re-checks; the loop closes *before* the code leaves your machine.

|  |  |
|---|---|
| 🧪 **No test files, ever** | Argus audits the *rendered app* — DOM, console, network, pixels — not your source. Nothing to write, nothing to maintain when the agent refactors |
| 🤖 **Built for the agent loop** | The only QA engine Claude can call natively over MCP. Audit → fix → re-audit without leaving the conversation |
| 🔒 **Safe for agents by default** | **Aegis**: findings are redacted at every egress boundary — secrets, PII, and exploit detail never reach the LLM's context window (OWASP LLM02, default-ON, fail-closed) |
| 🧰 **Also a normal QA tool** | CLI batch audits, a GitHub Action PR gate, Slack reports with screenshots, dev-vs-staging diffs, watch mode — with or without an agent |

---

## Quick Start

> **No install.** `npx` fetches Argus on first run.

**1 — Add two lines to `.mcp.json`** in your project root:

```json
{
  "mcpServers": {
    "chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] },
    "argus":           { "command": "npx", "args": ["-y", "argusqa-os"] }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
claude mcp add argus -- npx -y argusqa-os
```

**2 — Launch Chrome** (auto-detects your Chrome, sets the right flags):

```bash
npx -y -p argusqa-os argus-chrome
```

<details>
<summary>Prefer launching Chrome manually? (macOS / Windows / Linux commands)</summary>

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"

# Linux
google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox
```

</details>

**3 — Ask your agent:**

```
Run argus_audit on http://localhost:3000
```

That's it. Findings come back structured and severity-ranked — into the conversation, to Slack, or as a local `report.html`. Something off? `npx -y -p argusqa-os argus-doctor` diagnoses your setup in one command.

---

## The Fix Loop

This is what Argus looks like inside an agentic coding session:

```
You:    Build me a checkout page with a card form.
Agent:  [writes the code, dev server renders it]

You:    Run argus_audit on http://localhost:3000/checkout
Argus:  ● 2 critical · 3 warnings
        ● uncaught TypeError in checkout.js (visible on submit)
        ● form posts over HTTP — security_no_https
        ▲ card inputs missing labels + autocomplete (a11y/WCAG)
        ▲ LCP 4.1s — hero image unoptimized
        ▲ duplicate POST /api/cart ×7 — likely render loop

Agent:  [fixes all five]

You:    Run argus_get_context
Argus:  ✓ resolved: 5 · persisting: 0 · new: 0
```

`argus_get_context` diffs against the previous snapshot, so the agent knows exactly what it fixed, what it broke, and what remains — no re-reading walls of output.

**"But my agent can already drive a browser…"** — it can. Driving isn't judging. A raw browser MCP (Playwright MCP, bare chrome-devtools-mcp) gives the agent hands and eyes; the agent must then *re-derive what to check* every session, burning context on console-log spelunking. Argus is the judgment layer on top: 149 codified finding types with thresholds, severity policy, cross-run baselines, flakiness filtering, dedup, root-cause hints — returned in one call, redacted by default.

---

## What Argus Catches

32 analysis engines, 149 distinct issue types, zero test-file maintenance:

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
| **Theme** | Dark-mode gaps — static CSS vars, missing `prefers-color-scheme` handling |
| **Network baseline** | New requests, missing requests, status-code regressions vs saved HAR baseline |
| **Environment diff** | Dev vs staging — screenshot diff, DOM changes, console/network regressions |

And every finding is post-processed with:

| Post-processor | What it adds |
|---|---|
| **Intelligent baseline filtering** | Findings that flip-flop across runs are tagged `noisy` and downgraded to info — pure cross-run heuristics, no API calls (`ARGUS_NOISE_FILTER=0` to disable) |
| **Root cause linking** | New findings are annotated with the recent git commits and files most likely to have caused them (`ARGUS_ROOT_CAUSE=0` to disable) |

> All findings are classified as `critical` / `warning` / `info` and routed to the right Slack channel — or surfaced in the local HTML report. For per-finding severity tables and detection methods, see [REFERENCE.md](REFERENCE.md).

---

## Works With Your Stack

Argus audits the **rendered output**, not your source — so it is framework-agnostic by construction. **If it runs in Chrome, Argus can audit it:**

| | |
|---|---|
| **SPA frameworks** | React, Vue, Angular, Svelte/SvelteKit, Solid, Preact, Astro… |
| **Meta-frameworks** | Next.js, Nuxt, Remix, Gatsby — plus **framework-aware extras**: Next.js & React Router route discovery, import-graph PR mapping ("this component changed → audit only the routes that render it"), monorepo path awareness |
| **Server-rendered** | Rails, Django, Laravel, Flask, Spring, PHP — anything that serves HTML to a browser |
| **Static / no framework** | Plain HTML/CSS/JS, docs sites, landing pages |
| **APIs (via the page)** | Response schema validation, status/timing checks on every request the page makes |

**Honest limits:** Chrome/Chromium rendering only (no Safari/Firefox engine differences), web only (no native mobile/desktop apps), and backend services are checked through the traffic the page generates — not as standalone API test suites.

---

## Confidentiality — Aegis Egress Boundary

> **Default ON.** Argus audits your app for *secrets and vulnerabilities* — so its findings are exactly the data you least want leaving your machine. **Aegis** redacts them at every external boundary before they cross. For teams adopting AI agents, this is the difference between "we use an AI QA tool" and "we can tell our security lead exactly why it's safe."

A finding sent to an external sink — an **MCP tool response** (which lands in the calling agent's context window and transits to that agent's model provider), a **Slack** message, a **GitHub** PR comment + its `::error` annotations, the **hosted/CI HTML report**, or **CI logs** — is reduced to a need-to-know projection: a **sensitive** finding crosses as its `type` + `route` + `severity` + a `🔒` marker, and **never** its raw payload (`message`, `evidence`, request/response bodies, headers, cookies, stack). URLs are projected with the query string stripped (tokens hide there). A **benign** finding keeps its message — but that message is still scrubbed for any accidentally-embedded secret or PII.

| Principle | Behavior |
|---|---|
| **Local fidelity preserved** | The on-disk JSON report and the locally-opened HTML keep **100%** detail — redaction only removes detail on the way *out* |
| **Fail-closed** | On any classifier error or unknown finding shape, Aegis redacts *more*, never less |
| **Deny-by-default** | Only an explicit allowlist of safe fields ever crosses; a new field leaks nothing until deliberately allowlisted |
| **5-layer detection** | Category rules ∪ 13 secret regexes ∪ statistical rarity (entropy / token-efficiency) ∪ 7 Luhn-validated PII rules ∪ context boosting |
| **Opt-out** | `ARGUS_REDACT_SENSITIVE=0` → output is byte-identical to pre-Aegis |

This implements the **OWASP LLM02:2025 — Sensitive Information Disclosure** mitigations (data minimization, redaction, deny-by-default egress filtering) at Argus's own boundaries. An optional, local-only re-hydration vault (`ARGUS_REDACT_VAULT=1`) can mint reversible, information-free tokens for diff-stable artifacts — re-inflate locally with `npm run report:rehydrate`. Full behavior change is documented in [CHANGELOG.md](CHANGELOG.md).

---

## MCP Tools

Ask Claude (or any MCP client) — no terminal required:

| Tool | Description |
|---|---|
| `argus_audit` | Fast pass — JS, network, accessibility, SEO, security, CSS, content |
| `argus_audit_full` | Deep pass — adds Lighthouse, responsive checks, memory leak detection, hover-state bugs |
| `argus_compare` | Diff dev vs staging — screenshots, findings delta, environment regressions |
| `argus_get_context` | Capture everything broken on the open tab — with `resolved / new / persisting` diff vs the last snapshot (the fix loop) |
| `argus_watch_snapshot` | Snapshot the open tab without navigating (preserves auth/form state) |
| `argus_last_report` | Return last JSON report without re-running |
| `argus_design_audit` | Figma URL → 13 design-token finding types (color, spacing, typography, shadows, etc.) |
| `argus_visual_diff` | Screenshot baseline comparison. Pass `updateBaseline: true` to reset. |
| `argus_pr_validate` | Fetch GitHub PR diff → map changed files to affected routes → targeted audit → baseline-aware block decision (blocks on findings the PR *introduces*) + idempotent PR comment + Check Run → `{ blocked, findings, baseline, reporting }` |

> Every tool response is projected through the [Aegis egress boundary](#confidentiality--aegis-egress-boundary) before it reaches the agent, and carries an optional `redaction` rider (`{ redacted, total }`) when sensitive detail was withheld.

**Example prompts:**

```
Run argus_audit on http://localhost:3000/checkout
Run argus_audit_full on http://localhost:3000/dashboard
Run argus_compare
Run argus_get_context
```

---

## Battle-Tested, Not Vibe-Tested

Argus's own correctness is enforced the way it audits yours:

- **998/998 hard assertions** across a 171-block integration harness driving real Chrome against 64 fixture pages — including per-category negative controls (zero over-fire), golden response schemas for all 9 MCP tools, and an upstream-drift canary that catches chrome-devtools-mcp API changes at version-bump time
- **562 Chrome-free unit tests** (Vitest) + property-based parser fuzzing
- **`npm audit`: 0 vulnerabilities** · CodeQL + Dependabot on every PR · [Socket.dev](https://socket.dev/npm/package/argusqa-os): 100/100/100 on vulnerability/quality/license
- Session files and captured tokens written `0600`, owner-only

---

## Full Setup

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | v20.19+ |
| Chrome | Stable (desktop or headless) |
| Claude Code | Latest (`npm install -g @anthropic-ai/claude-code`) — or any MCP client |
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
npm run test:unit          # 562 unit tests — no Chrome required
npm run test:harness       # 171-block correctness harness — requires Chrome
npm run test:harness:log   # same, but tees full output to harness-results.txt
npm run test:coverage      # merged unit + harness coverage gate (requires Chrome)
```

**Watch mode** — live monitoring as you (or your agent) develop:

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

## GitHub Actions CI — PR Gate

Argus ships as a composite GitHub Action: on every PR it maps the diff to affected routes, audits them, and blocks the merge **only on findings the PR introduces** (baseline-aware) — with an idempotent PR comment and a Check Run.

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
| `ARGUS_REDACT_SENSITIVE` | `ON` | **Aegis** egress redaction. `0` disables (byte-identical pre-Aegis output) |
| `ARGUS_REDACT_MODE` | `mask` | Matched-span style: `mask` / `label` / `hash` / `token` / `drop` |
| `ARGUS_REDACT_HTML` | off local / ON in CI | `1` redacts the hosted HTML report too |
| `ARGUS_REDACT_VAULT` | `OFF` | `1` (with `ARGUS_REDACT_MODE=token`) mints reversible `AEGIS_<hmac16>` tokens into a local `0600` vault; re-inflate with `npm run report:rehydrate` |

</details>

---

## Troubleshooting

> First stop for anything broken: `npx -y -p argusqa-os argus-doctor` — it checks Chrome reachability, MCP config validity, and required env keys, and prints the exact fix for each failure.

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

| | Playwright / Cypress | Raw browser MCP (Playwright MCP, chrome-devtools-mcp) | Argus |
|---|---|---|---|
| **Purpose** | Test your logic and API contracts | Give an agent browser hands & eyes | Give the agent (and you) **judgment** about what's broken |
| **What you get** | Pass / fail on scripts you wrote | Raw DOM/console/network access | 149 codified finding types, severities, baselines, noise filtering, root-cause hints |
| **Maintenance** | Test files, forever | Re-prompt the checks every session | Zero — audits the rendered app |
| **When it runs** | In your test suite | When the agent thinks to look | On demand, in CI as a PR gate, or continuously (watch mode) |
| **Output** | Pass / fail | Whatever the agent noticed | Structured reports with screenshots — Slack, HTML, PR comments — secrets redacted |

---

## Known Limitations

All 998 harness assertions pass (`998/998`) — there are currently no known MCP- or Chrome-layer restrictions. Lighthouse runs headless (after the `lighthouse_audit` argument fix); the remaining soft assertions (perf traces, GC-dependent heap-growth) are promoted to counted hard assertions only in the weekly strict-soft lane (`harness-strict.yml`) via `ARGUS_HARNESS_STRICT_SOFT`. Scope limits: Chrome/Chromium only, web apps only — see [Works With Your Stack](#works-with-your-stack).

---

## Hosted Argus — Founding Members

Want audits without running Chrome or npm — with history, trends, schedules, and a team dashboard? **Argus Cloud** is in founding-member early access: **$19/month, locked forever** (regular $29).

**[Become a founding member → argus-qa.com](https://argus-qa.com#pricing)**

The open-source engine on this page stays MIT and fully-featured, always — the hosted tier sells convenience and memory, never detections.

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
test-harness/           — 171-block correctness harness, 998 hard assertions, 64 fixture pages
test/unit/              — 562 Vitest unit tests (no Chrome required)
landing/                — Product landing page (React 19 + Vite + Tailwind)
```

Full source map → [CLAUDE.md](CLAUDE.md) · MCP/DSL reference → [SKILL.md](SKILL.md)

---

## Contributing

Contributions are welcome — fixture pages, new detection categories, framework route-discovery, docs. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

1. Fork the repo and create a branch
2. `npm run test:unit` — verify without Chrome (562 tests)
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
