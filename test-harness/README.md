# Argus Test Harness

Validates that every Argus detection category fires correctly by running the full crawl pipeline against deliberately broken fixture pages hosted on a local Express server.

<br/>

[![Node.js](https://skillicons.dev/icons?i=nodejs)](https://nodejs.org)
[![JavaScript](https://skillicons.dev/icons?i=js)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![HTML](https://skillicons.dev/icons?i=html)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS](https://skillicons.dev/icons?i=css)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![Chrome](https://skillicons.dev/icons?i=chrome)](https://www.google.com/chrome/)
[![GitHub Actions](https://skillicons.dev/icons?i=githubactions)](https://github.com/features/actions)

---

## What It Tests

20 test blocks · 63 hard assertions · 13 detection categories · 20 fixture pages

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
│   ├── seo-issues.html             test 18 — SEO meta/heading issues (v3 Phase A3 fixture)
│   ├── api-performance.html        test 17 — slow API + oversized payload (v3 Phase A2)
│   ├── security-issues.html        test 19 — security checks (v3 Phase A4)
│   └── content-issues.html         test 20 — content quality checks (v3 Phase A5)
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

**Expected output (all passing):**

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

[15] Env Comparison — 7 detections between dev and staging
  ✓ Checkout returns 200 on dev (got 200)
  ✓ Checkout returns 500 on staging — API regression detected (got 500)
  ✓ New request on staging only: /api/tracking
  ✓ Request present in dev but missing on staging: /api/feature-flags
  ✓ Analytics status changed: 200 dev → 404 staging
  ✓ More console errors on staging (2) than dev (0)
  ✓ DOM diff: .pricing section present on dev, missing on staging

────────────────────────────────────────────────────────
Results: 63/63 hard assertions passed, 0 failed

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
