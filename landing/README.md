# Argus — Landing Page

Product marketing site for Argus. Runs independently from the main Argus QA harness.

## Tech Stack

| Layer | Library |
|---|---|
| Framework | React 19 |
| Build tool | Vite 8 |
| Styling | Tailwind CSS + inline styles |
| Animations | Framer Motion 12 |
| Forms backend | Supabase Postgres (REST via `@supabase/supabase-js`) |

## Local Development

```bash
cd landing
npm install
cp .env.example .env.local   # fill in your Supabase credentials
npm run dev                  # http://localhost:5173
```

## Environment Variables

Copy `.env.example` to `.env.local` (gitignored) and fill in:

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co   # bare project URL — no /rest/v1 suffix
VITE_SUPABASE_ANON_KEY=eyJ...                         # anon public key from Supabase dashboard
```

If either variable is missing the app still renders, but form submissions are silently dropped (a warning is logged to the console).

## Supabase Setup

1. Create a new Supabase project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run:

```sql
-- Waitlist signups
CREATE TABLE IF NOT EXISTS waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz DEFAULT now(),
  source text
);
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public insert" ON waitlist FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON waitlist TO anon;

-- Enterprise contact requests
CREATE TABLE IF NOT EXISTS enterprise_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL,
  team_size text,
  region text,
  use_case text,
  workflow text,
  message text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE enterprise_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public insert" ON enterprise_contacts FOR INSERT TO anon WITH CHECK (true);
GRANT INSERT ON enterprise_contacts TO anon;
```

> **Note**: If you created the project with "Automatically expose new tables" disabled, you must run the `GRANT INSERT` statements even if the RLS policies already exist. PostgREST requires schema-level permission (`GRANT`) in addition to row-level permission (RLS policy).

3. Copy your **Project URL** and **anon public key** from Project Settings → API into `.env.local`.

## Build

```bash
npm run build    # outputs to landing/dist/
npm run preview  # serve the production build locally
```

`landing/dist/` is gitignored. **Live deployment**: [argus-qa.com](https://argus-qa.com) via Cloudflare Pages (project: `argus-qa`). Background video served from Cloudflare R2 (`pub-4a48bc28d90e4425a6fb87b164225d13.r2.dev`).

To redeploy:

```bash
cd landing
npm run build
npx wrangler pages deploy dist --project-name argus-qa
```

## Component Structure

All UI lives in `src/App.jsx` as a single-file app. Hero section is built inline inside `App()`:

| Component | Purpose |
|---|---|
| `Logo` | SVG icon — purple ring + dot |
| `BetaBadge` | "BETA" pill badge |
| `SectionLabel` | Reusable section label chip |
| `FeaturesSection` | Feature grid (12 cards with icons) |
| `DetectionSection` | Detection category accordion |
| `SetupSection` | Setup / code snippet tabs |
| `ComparisonTable` | Pricing comparison table (3-column) |
| `PricingSection` | Pricing cards + comparison table |
| `DocsSection` | Collapsible docs accordion |
| `Footer` | Nav links + copyright |
| `WaitlistModal` | Email + plan selector → inserts into `waitlist` table |
| `EnterpriseModal` | name, email, company, team_size, region, use_case, workflow, message → inserts into `enterprise_contacts` table |

`src/supabase.js` exports the singleton Supabase client (or `null` if env vars are absent).

## Mobile & SEO Status (2026-05-26)

| Issue | Status | Notes |
|---|---|---|
| Comparison table scroll | ✅ Already handled | `overflowX: 'auto'` was already on the inner wrapper |
| Touch targets < 44px | ✅ Fixed | All 4 interactive buttons raised to 44×44px |
| Video poster fallback | ✅ Fixed | `Argus_bg.png` → `landing/public/argus-poster.png`; `poster="/argus-poster.png"` on `<video>` tag |
| Modal soft keyboard (iOS) | ✅ Fixed | Both modal wrappers now have `maxHeight: 100dvh` + `overflowY: auto` |
| `prefers-reduced-motion` | ✅ Fixed | `<MotionConfig reducedMotion="user">` wraps the entire app |
| `@media` edge cases | ✅ Fixed | `100dvh` via `@supports` in `index.css`; stat row / detection grid / nav handle narrow viewports natively |
| SEO — OG / Twitter / JSON-LD | ✅ Added | `index.html` has full OG tags, Twitter card, canonical, JSON-LD schema |
| `robots.txt` + `sitemap.xml` | ✅ Added | Both in `landing/public/` |
| OG social card | ✅ Done | `og-image-v3.jpg` — 1200×630 JPEG, branded overlay, purple stat numbers (67 / 166 / 961); refreshed for v9.8.0 — the two changed numbers are re-rendered onto the original art via real-pixel background reconstruction (block-copy of the clean gradient + cap-height-matched native digits); `og-image.jpg` gitignored |
| Mobile stats layout | ✅ Fixed | Stats row stacks vertically on mobile (`flex-col sm:flex-row`); slide widget reduced from 8 → 6 slides; `clamp()`-based fluid typography |
| Deployment | ✅ Live | `npx wrangler pages deploy dist --project-name argus-qa`; custom domain `argus-qa.com` active |

## Stats Update (2026-05-31)

Hero stats and docs section updated to reflect gap-close completion (blocks [94]–[126]):

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `93` | `126` |
| `stats[2].num` (ASSERTIONS RUN) | `394` | `528` |
| Docs § "Test Coverage" tagline | `93 blocks, 394 hard assertions` | `126 blocks, 528 hard assertions` |
| Docs § "Breakdown" | Ended at Blocks 79–93 | Added Blocks 94–126 bullet |
| Docs § "Running" code | `394 hard assertions`, `391/394` | `528 hard assertions`, `525/528` |
| "How we built it" caption | `84 test blocks` | `126 test blocks` |

## Stats Update (2026-06-02 — Milestone 2 v9.5.3)

Hero stats and docs section updated to reflect Milestone 2 (block [128] — D9 Design Fidelity):

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `127` | `128` |
| `stats[2].num` (ASSERTIONS RUN) | `535` | `544` |
| Docs § "Test Coverage" tagline | `127 blocks, 535 hard assertions` | `128 blocks, 544 hard assertions` |
| Docs § "Running" code | `535 hard assertions`, `532/535` | `544 hard assertions`, `541/544` |
| "How we built it" caption | `127 test blocks` | `128 test blocks` |

## Stats Update (2026-06-04 — Milestone 2 maximum potential)

Block [128] expanded from 9 → 24 assertions. D9 now has 12 finding types. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[2].num` (ASSERTIONS RUN) | `544` | `559` |
| Docs § "Test Coverage" tagline | `128 blocks, 544 hard assertions` | `128 blocks, 559 hard assertions` |
| Docs § "Running" code | `544 hard assertions`, `541/544` | `559 hard assertions`, `556/559` |

## Stats Update (2026-06-04 — D9 gap fixes: shadow color+spread, per-corner radius, position drift, selector fallback)

Block [128] expanded to 30 assertions. D9 now has 13 mismatch finding types. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[2].num` (ASSERTIONS RUN) | `559` | `565` |
| Docs § "Test Coverage" tagline | `128 blocks, 559 hard assertions` | `128 blocks, 565 hard assertions` |
| Docs § "Running" code | `559 hard assertions`, `556/559` | `565 hard assertions`, `562/565` |

## Stats Update (2026-06-05 — Milestone 9 v9.5.4)

Web Vitals & Bundle Size: `web-vitals-analyzer.js` (block [129], headless LCP/CLS/FCP/TTI/TTFB + bundle size regression). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `128` | `129` |
| `stats[2].num` (ASSERTIONS RUN) | `565` | `572` |
| Docs § "Test Coverage" tagline | `128 blocks, 565 hard assertions` | `129 blocks, 572 hard assertions` |
| Docs § "Running" code | `565 hard assertions`, `562/565` | `572 hard assertions`, `569/572` |
| "How we built it" caption | `128 test blocks` | `129 test blocks` |

## Stats Update (2026-06-06 — Milestone 3 v9.5.5)

A8 Visual Regression: `visual-diff-analyzer.js` (block [130], pixelmatch baseline comparison). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[0].num` (DETECTION TYPES) | `58` | `58` (unchanged from Milestone 9 recount) |
| `stats[1].num` (TEST BLOCKS) | `129` | `130` |
| `stats[2].num` (ASSERTIONS RUN) | `572` | `581` |
| Docs § "Test Coverage" tagline | `129 blocks, 572 hard assertions` | `130 blocks, 581 hard assertions` |
| Docs § "Running" code | `572 hard assertions`, `569/572` | `581 hard assertions`, `578/581` |
| Feature table `All 56 detection categories` | `56` | `58` |

## Stats Update (2026-06-06 — Milestone 4 v9.5.6)

A12 Deep Accessibility: `a11y-deep-analyzer.js` (block [131], axe-core 4.12 + CVD color blind simulation). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[0].num` (DETECTION TYPES) | `58` | `59` |
| `stats[1].num` (TEST BLOCKS) | `130` | `131` |
| `stats[2].num` (ASSERTIONS RUN) | `581` | `590` |
| Docs § "Test Coverage" tagline | `130 blocks, 581 hard assertions` | `131 blocks, 590 hard assertions` |
| Docs § "Running" code | `581 hard assertions`, `578/581` | `590 hard assertions`, `587/590` |
| Feature table `All 58 detection categories` | `58` | `59` |

## Stats Update (2026-06-06 — Extension v9.5.7)

Extension — argus_visual_diff MCP tool: wired existing visual-diff-analyzer as 8th MCP tool. No new detection categories or fixture pages.

| Field | Old | New |
|---|---|---|
| MCP tools | 7 | **8** (argus_visual_diff added) |
| Hard assertions | 590 | **592** ([80m]+[80n] registration + [117c/d] threshold) |
| Harness gate | 587/590 | **589/592** |
| Version | 9.5.6 | **9.5.7** |

## Stats Update (2026-06-07 — Milestones 5/5b/5c/5d v9.5.8)

N1 HAR Network Baseline, A9 Motion & Animation, A10 Font Loading, A11 Form Validation: `har-recorder.js`, `motion-analyzer.js`, `font-analyzer.js`, `form-analyzer.js` (blocks [132]–[135], 4 new fixture pages). Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[0].num` (DETECTION TYPES) | `59` | `63` |
| `stats[1].num` (TEST BLOCKS) | `131` | `135` |
| `stats[2].num` (ASSERTIONS RUN) | `592` | `616` |
| Docs § "Test Coverage" tagline | `131 blocks, 592 hard assertions` | `135 blocks, 616 hard assertions` |
| Docs § "Running" code | `592 hard assertions`, `589/592` | `616 hard assertions`, `613/616` |
| Feature table detection count | `59` | `63` |
| "How we built it" caption | `131 test blocks` | `135 test blocks` |

---

## Stats Update (2026-06-07 — Milestone 6 v9.5.9)

GitHub Check Runs: `github-reporter.js` extended with `createCheckRun`/`completeCheckRun` (GitHub Checks API), `generateReleaseNotes()`, `ARGUS_CRITICAL_THRESHOLD` gate, `ARGUS_DIFF_IMAGE_URL`, `GITHUB_CHECK_NAME`; block [136] (10 assertions). No new detection categories or fixture pages. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `135` | `136` |
| `stats[2].num` (ASSERTIONS RUN) | `616` | `626` |
| Docs § "Test Coverage" tagline | `135 blocks, 616 hard assertions` | `136 blocks, 626 hard assertions` |
| Docs § "Running" code | `616 hard assertions`, `613/616` | `626 hard assertions`, `623/626` |
| "How we built it" caption | `135 test blocks` | `136 test blocks` |

---

## Stats Update (2026-06-08 — Milestone 7 v9.6.0)

PR Diff Analyzer: `pr-diff-analyzer.js` + `argus_pr_validate` 9th MCP tool + `action.yml` GitHub Action wrapper (block [137], 8 assertions). No new detection categories or fixture pages. Hero and docs updated:

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `136` | `137` |
| `stats[2].num` (ASSERTIONS RUN) | `626` | `634` |
| MCP tools | 8 | **9** (`argus_pr_validate` added) |
| Docs § "Test Coverage" tagline | `136 blocks, 626 hard assertions` | `137 blocks, 634 hard assertions` |
| Docs § "Running" code | `626 hard assertions`, `623/626` | `634 hard assertions`, `631/634` |
| "How we built it" caption | `136 test blocks` | `137 test blocks` |
| Block [137] bullet | — | Added to Breakdown section |

---

## Stats Update (2026-06-08 — Milestone 7 v9.6.1)

`src/cli/pr-validate.js` headless CI entry point + `action.yml` rewrite + block [138] (10 assertions, CLI helper unit tests — no Chrome required). No new detection categories or fixture pages.

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `137` | `138` |
| `stats[2].num` (ASSERTIONS RUN) | `634` | `644` |
| Docs § "Test Coverage" tagline | `137 blocks, 634 hard assertions` | `138 blocks, 644 hard assertions` |
| Docs § "Running" code | `634 hard assertions`, `631/634` | `644 hard assertions`, `641/644` |
| "How we built it" caption | `137 test blocks` | `138 test blocks` |
| Block [138] bullet | — | Added to Breakdown section |

---

## Stats Update (2026-06-09 — Milestone 7 hardening v9.6.6)

PR Validator hardening: `checkTargetReachable()`, `normalizeRoutePaths()`, all-routes-failed guard, `EXCLUDED_PATTERNS`; blocks [137i–k]+[138k–p] (9 new assertions to existing blocks). No new detection categories or fixture pages.

| Field | Old | New |
|---|---|---|
| `stats[2].num` (ASSERTIONS RUN) | `644` | `653` |
| Docs § "Test Coverage" tagline | `138 blocks, 644 hard assertions` | `138 blocks, 653 hard assertions` |
| Docs § "Running" code | `644 hard assertions`, `641/644` | `653 hard assertions`, `650/653` |

---

## Stats Update (2026-06-10 — Milestone 8 v9.7.0)

Chrome launcher + doctor pre-flight + advanced security (SRI, source maps, open redirects, npm audit) + PDF export + screen recorder; block [139] (11 assertions); 4 new detection categories.

| Field | Old | New |
|---|---|---|
| `stats[0].num` (ISSUE TYPES) | `63` | `67` |
| `stats[1].num` (TEST BLOCKS) | `138` | `139` |
| `stats[2].num` (ASSERTIONS RUN) | `653` | `664` |
| Docs § "Test Coverage" tagline | `138 blocks, 653 hard assertions` | `139 blocks, 664 hard assertions` |
| Docs § "Running" code | `653 hard assertions`, `650/653` | `664 hard assertions`, `661/664` |
| "How we built it" caption | `138 test blocks` | `139 test blocks` |
| Block [139] bullet | — | Added to Breakdown section |

---

## Stats Update (2026-06-11 — v9.7.1)

[49b] drag/drop root-cause fix: `resolveUidForSelector()` exact-accessible-name-first matching in `flow-runner.js` — the failure was an Argus uid-resolution bug, not a Chrome/MCP limit. [49b] removed from `KNOWN_PERMANENT`. No new blocks, assertions, or detection categories.

| Field | Old | New |
|---|---|---|
| Docs § "Running" code gate | `661/664` | `662/664` |
| Permanent failures | 3 ([49b]/[67b]/[68b]) | 2 ([67b]/[68b]) |

---

## Stats Update (2026-06-11 — v9.7.2)

[67b]/[68b] Issues panel root-cause fix: MCP returns issues as markdown text but `normalizeArray()` discarded strings — `parseConsoleMsgResponse()` now used; deprecated fixture switched to `unload` listener. `KNOWN_PERMANENT` is empty. No new blocks, assertions, or detection categories.

| Field | Old | New |
|---|---|---|
| Docs § "Running" code gate | `662/664` | `664/664` |
| Docs § "Test Coverage" permanent-failure bullet | `2 assertions permanently fail` | `All 664 hard assertions pass` |
| Known Limits section | Issues panel constraint | No known MCP/Chrome restrictions |
| Permanent failures | 2 ([67b]/[68b]) | **0** |

---

## Stats Update (2026-06-11 — v9.7.3)

MIT items: `noise-filter.js` (intelligent baseline filtering) + `root-cause-linker.js` (git-diff root cause linking); blocks [140] (7) + [141] (8). No new detection categories.

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `139` | `141` |
| `stats[2].num` (ASSERTIONS RUN) | `664` | `679` |
| Docs § "Test Coverage" tagline | `139 blocks, 664 hard assertions` | `141 blocks, 679 hard assertions` |
| Docs § "Running" code | `664 hard assertions`, `664/664` | `679 hard assertions`, `679/679` |
| Docs § Breakdown | — | Block [140] + [141] bullets added |
| "How we built it" caption | `139 test blocks` | `141 test blocks` |

## Stats Update (2026-06-13 — v9.7.4 + HARNESS_MAX_PLAN Phase 1 + perf-vestige cleanup)

Consolidated landing-page stat sync (the changelog skipped v9.7.4). v9.7.4 pre-E2E audit: block [142] (9), 142 blocks / 688. Phase 1 contract armor: block [143] CdpBrowserAdapter wire-contract conformance (28 hard + 5 soft + meta), [144] MCP tool error-path matrix (16), [145] multi-tab end-to-end (6) → 145 blocks / 738. Post-Phase-1 cleanup: removed dead+redundant `checkPerformanceBudgets` (orchestrator) + the superseded perf-budget harness block [11] + 3 perf fixtures (Core Web Vitals are covered by the web-vitals analyzer, block [129]; `perf-cls.html` kept for block [92]); block id [11] retired ([10]→[12] gap). No new detection categories (still 67 / 64 verified). **Net: 141 → 144 blocks, 679 → 738 hard assertions, 738/738 gate, 60 fixture pages.**

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `141` | `144` |
| `stats[2].num` (ASSERTIONS RUN) | `679` | `738` |
| Docs § "Test Coverage" tagline | `141 blocks, 679 hard assertions` | `144 blocks, 738 hard assertions` |
| Docs § "Running" code | `679 hard assertions`, `679/679` | `738 hard assertions`, `738/738` |
| Docs § Breakdown | — | Blocks [142]–[145] bullets added |
| "How we built it" caption | `141 test blocks` | `144 test blocks` |

## Stats Update (2026-06-14 — HARNESS_MAX_PLAN Phase 2: assertion quality)

Phase 2 (test-harness + `test-harness/contracts/` only — released in v9.7.6): 2.1 vacuous-assertion sweep (upgraded [119c] `open_tabs` in place); block [146] anti-vacuous self-lint (5 — the harness reads its own source and forbids new shape-only assertions); block [147] golden response schemas for all 9 MCP tools (14 — live `safeParse` ×8 + `argus_pr_validate` source cross-check + coverage ratchet + negative controls), which shook out + fixed the `argus_compare` two-mode contract via a discriminated union. No new detection categories (still 67 / 64 verified). **Net: 144 → 146 blocks, 738 → 757 hard assertions, 757/757 gate, 60 fixture pages.**

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `144` | `146` |
| `stats[2].num` (ASSERTIONS RUN) | `738` | `757` |
| Docs § "Test Coverage" tagline | `144 blocks, 738 hard assertions` | `146 blocks, 757 hard assertions` |
| Docs § "Running" code | `738 hard assertions`, `738/738` | `757 hard assertions`, `757/757` |
| Docs § Breakdown | — | Blocks [146]–[147] bullets added |

## Stats Update (2026-06-14 — HARNESS_MAX_PLAN Phase 3.1: upstream canary)

Phase 3.1 + 3.4 (test-harness + `test-harness/contracts/` only — released in v9.7.6): block [148] upstream canary — a freshly spawned `chrome-devtools-mcp@1.1.1` `tools/list` is diffed (tool set + required params + property names/types) against the new golden snapshot `contracts/chrome-devtools-mcp@1.1.1.json`, catching the next `reqid→requestId`-class param rename at a version bump; `mcp-client.js` pin ↔ snapshot-filename lockstep; plus a Chrome-rot watch that `issues-deprecated.html` still emits a DeprecationIssue in the live Chrome. No new detection categories (still 67 / 64 verified). **Net: 146 → 147 blocks, 757 → 762 hard assertions, 762/762 gate, 60 fixture pages.**

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `146` | `147` |
| `stats[2].num` (ASSERTIONS RUN) | `757` | `762` |
| Docs § "Test Coverage" tagline | `146 blocks, 757 hard assertions` | `147 blocks, 762 hard assertions` |
| Docs § "Running" code | `757 hard assertions`, `757/757` | `762 hard assertions`, `762/762` |
| Docs § Breakdown | — | Block [148] bullet added |

## Stats Update (2026-06-14 — HARNESS_MAX_PLAN Phase 3.2: per-category negative controls)

Phase 3.2 (test-harness + one new fixture only — released in v9.7.6): block [149] per-category negative controls — drives the REAL production pipeline (cheap crawl + `getExpensive` analyzer loop + DevTools Issues panel) against a new comprehensively well-formed fixture `negative-controls.html` (full SEO metadata, landmark structure, accessible form, ≥44×44px touch targets, data-URI favicon) and asserts ZERO warning/critical findings across 65 detection categories — the over-fire / false-positive guard the 2026-06-12 audit lacked. Positive controls ([149a–c]) prove the analyzers actually ran, so the per-category zero-findings checks are non-vacuous. +70 hard (5 structural + 65 per-category); +1 fixture page. No new detection categories (still 67 / 64 verified). **Net: 147 → 148 blocks, 762 → 832 hard assertions, 832/832 gate, 60 → 61 fixture pages.**

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `147` | `148` |
| `stats[2].num` (ASSERTIONS RUN) | `762` | `832` |
| Docs § "Test Coverage" tagline | `147 blocks, 762 hard assertions` | `148 blocks, 832 hard assertions` |
| Docs § "Running" code | `762 hard assertions`, `762/762` | `832 hard assertions`, `832/832` |
| Docs § Breakdown | — | Block [149] bullet added |
| "How we built it" caption | `147 test blocks` | `148 test blocks` |

## Stats Update (2026-06-14 — HARNESS_MAX_PLAN Phase 3.3: verification-gap closure)

Phase 3.3 (test-harness + a small `issues-analyzer.js`/`orchestrator.js` src fix — released in v9.7.6): block [150] verification-gap closure — positive firing fixtures for the three detection categories that previously had no triggering fixture: `focus_lost` (new `keyboard-focus-lost.html`), `security_no_https` (exported `checkHttpsRequired()` rule in `orchestrator.js`), and the Chrome DevTools Issues-panel residual `cors_violation` + `cookie_attribute_missing` (new `issues-cookie.html` + reused `cors-error.html`). Probing live Chrome 149 shook out a **real production bug**: Chrome's CORS/cookie Issue titles ("Ensure CORS response header values are valid" / "Mark cross-site cookies as Secure…") matched none of the `issues-analyzer.js` classifier patterns, so every real CORS/cookie Issue fell through to `unclassified_devtools_issue` — fixed and mutation-pinned. `mixed_content` (HTTPS), `low_contrast_native` (DevTools-audit) and `permission_policy_violation` (secure-context) stay environment-limited, covered as [149] negative controls. Detection categories: every category is now positively verified by a firing fixture except the 3 named environment-limited Issues detectors (`mixed_content` / `low_contrast_native` / `permission_policy_violation`), which can't trigger in headless localhost http and stay covered as [149] negative controls. +13 hard ([150a–m]); +2 fixture pages. **Net: 148 → 149 blocks, 832 → 845 hard assertions, 845/845 gate, 61 → 63 fixture pages.**

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `148` | `149` |
| `stats[2].num` (ASSERTIONS RUN) | `832` | `845` |
| Docs § "Test Coverage" tagline | `148 blocks, 832 hard assertions` | `149 blocks, 845 hard assertions` |
| Docs § "Running" code | `832 hard assertions`, `832/832` | `845 hard assertions`, `845/845` |
| Docs § Breakdown | — | Block [150] bullet added |
| "How we built it" caption | `148 test blocks` | `149 test blocks` |

## Stats Update (2026-06-15 — HARNESS_MAX_PLAN Phase 4.1: coverage gate)

**No landing-page stat change.** Phase 4.1 is test/CI/config-only infrastructure (a merged unit+harness coverage gate via `scripts/coverage-gate.mjs`; two audit-flagged modules now unit-tested; CI step in `harness-ci.yml`). It adds **no harness blocks or assertions** — the landing hero stats stay at **149 test blocks / 845 assertions** and `App.jsx` is intentionally left untouched. The only test-suite count that moved is the unit suite (61 → 72 tests, 6 → 8 files), which the landing page does not surface. Recorded here so the build-changelog stays a complete log. **Phase 4.2** (parser fuzzing — `test/unit/parser-fuzz.test.js`, fast-check) further moved the unit suite to **94 tests / 9 files**, and **Phase 4.3** (strict-soft lane — `harness-strict.yml` + the `ARGUS_HARNESS_STRICT_SOFT` soft→hard flag) adds a weekly headless strict lane only; both are likewise test/CI-only with **no landing-page stat change** (hero stays **149 / 845**). (The lane was first built with Xvfb + non-headless Chrome but that broke rendering on the runner; it was revised to headless after the Lighthouse fix — see below.)

## Stats Update (2026-06-16 — Lighthouse audit fix, post-4.3)

The 4.3 headful-lane verification surfaced that `lighthouse_audit` was being called with an unsupported `url`/`categories` argument (rejected by chrome-devtools-mcp@1.1.1), so **Lighthouse had never actually run in Argus** — production `checkLighthouse` always caught + skipped, and the harness Lighthouse soft assertions were perpetually N/A. Fixed across `src/adapters/browser.js`, `src/utils/lighthouse-checker.js` (new `parseLighthouseReport()` reads the response's report.json), and the harness `measureLighthouse`. Lighthouse now returns real scores in headless (a11y-critical 23, a11y-warning 86, SEO 73, best-practices 100; performance is excluded by the tool by design, covered by web-vitals [129]). A previously-dead `checkLighthouse` field-shape assertion now fires (made unconditional → deterministic count) → **gate 845 → 846**; the strict-soft lane is now 869/869. `browser.js` + `lighthouse-checker.js` are src changes → **released in v9.7.6**. **This fix DOES move the hero** (unlike the Phase 4.x infra items), so `App.jsx` was updated — and the stale unit-count (`61` → `94`) the Phase-4 note above had mis-described as un-surfaced is corrected at the same time.

| Field | Old | New |
|---|---|---|
| `stats[2].num` (ASSERTIONS RUN) | `845` | `846` |
| Docs § "Test Coverage" tagline | `149 blocks, 845 hard assertions` | `149 blocks, 846 hard assertions` |
| Docs § "Running" code | `61 Vitest tests`, `845 hard assertions`, `845/845` | `94 Vitest tests`, `846 hard assertions`, `846/846` |
| Docs § Breakdown bullets | `61 Vitest unit tests`, `All 845 hard assertions pass` | `94 Vitest unit tests`, `All 846 hard assertions pass` |
| `index.html` SEO/OG/JSON-LD descriptions (meta, og:, twitter:, schema.org) | `54 detection types, 82 test blocks, 348 assertions` (long-stale — search/social text) | `67 detection types, 149 test blocks, 846 assertions` |

> Heads-up: the OG card has stat numbers baked into the image (it's a static JPEG, not editable as text). Resolved 2026-06-17 — `og-image-v2.jpg` (stale 54/82/348) was regenerated as `og-image-v3.jpg` (67/149/846) via real-pixel background reconstruction + native-rendered numbers, and the orphaned v2 was removed.

## Stats Update (2026-06-18 — PR Validator Phase A: GitHub reporting fidelity)

PR Validator Phase A wired `github-reporter.js` into the GitHub-PR-driven audit path via one shared helper `reportPrValidation`: an idempotent PR comment (block [151]), a GitHub Check Run whose conclusion maps to the block decision (block [152]), file:line GitHub-Actions annotations from diff hunks ([137p–r]), `argus_pr_validate` (the MCP tool) reporting through the SAME helper + returning a `reporting` field (block [153]), and `fetchPrFiles` surfacing `{filename,status,patch}` (E1, [137l–o]). +23 hard assertions; unit suite 94→140. **Net: 149 → 152 blocks, 846 → 869 hard assertions, 869/869 gate** (fixtures unchanged at 63; detection categories unchanged at 67 — the PR Validator is a CI-reporting surface, not a new detector). Pending npm/Action release (src behavior changed in `github-reporter.js` / `mcp-server.js` / `pr-diff-analyzer.js` / `pr-validate.js`).

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `149` | `152` |
| `stats[2].num` (ASSERTIONS RUN) | `846` | `869` |
| Docs § "Test Coverage" tagline | `149 blocks, 846 hard assertions` | `152 blocks, 869 hard assertions` |
| Docs § "Running" code | `94 Vitest tests`, `846 hard assertions`, `846/846` | `140 Vitest tests`, `869 hard assertions`, `869/869` |
| Docs § Breakdown bullets | `94 Vitest unit tests`, `All 846 hard assertions pass` + blocks end at [150] | `140 Vitest unit tests`, `All 869 hard assertions pass` + blocks [151]/[152]/[153] added |
| `index.html` SEO/OG/JSON-LD descriptions | `67 detection types, 149 test blocks, 846 assertions` | `67 detection types, 152 test blocks, 869 assertions` |

> Heads-up: the OG card (`og-image-v3.jpg`) still has the old **67 / 149 / 846** baked into the image (static JPEG). **Deferred** — regenerate to 67 / 154 / 881 when the landing page is next redeployed (mechanical image-reconstruction step, no code dependency).

## Stats Update (2026-06-18 — PR Validator Phase B: baseline-aware blocking)

PR Validator Phase B made the merge-block decision (and the PR comment) baseline-aware: `src/utils/pr-baseline.js` `decidePrBlock` gates on the findings a PR *introduces* vs a stored per-branch baseline (`reports/baselines/<base-branch>.json`, restored via actions/cache), fail-safe to absolute blocking when no baseline (block [154]); `tagFindingNovelty` tags each finding `isNew` and the PR comment + step summary surface NEW/PERSISTING/RESOLVED counts that reconcile with the decision (block [155]). +12 hard assertions; unit suite 140→162 (new `pr-baseline.test.js`). **Net: 152 → 154 blocks, 869 → 881 hard assertions, 881/881 gate** (fixtures unchanged at 63; detection categories unchanged at 67 — Phase B is a CI block-decision/reporting surface, not a new detector). Pending npm/Action release (src behavior changed in `pr-baseline.js` / `github-reporter.js` / `mcp-server.js` / `pr-validate.js`).

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `152` | `154` |
| `stats[2].num` (ASSERTIONS RUN) | `869` | `881` |
| Docs § "Test Coverage" tagline | `152 blocks, 869 hard assertions` | `154 blocks, 881 hard assertions` |
| Docs § "Running" code | `140 Vitest tests`, `869 hard assertions`, `869/869` | `162 Vitest tests`, `881 hard assertions`, `881/881` |
| Docs § Breakdown bullets | `140 Vitest unit tests`, `All 869 hard assertions pass` + blocks end at [153] | `162 Vitest unit tests`, `All 881 hard assertions pass` + blocks [154]/[155] added |
| `index.html` SEO/OG/JSON-LD descriptions | `67 detection types, 152 test blocks, 869 assertions` | `67 detection types, 154 test blocks, 881 assertions` |

> Heads-up: the OG card (`og-image-v3.jpg`) still has the old **67 / 149 / 846** baked into the image (static JPEG). **Deferred** — regenerate to 67 / 154 / 881 when the landing page is next redeployed (mechanical image-reconstruction step, no code dependency).

## Stats Update (2026-06-19 — PR Validator Phase C: route-mapping accuracy)

PR Validator Phase C made the PR→route mapping framework-aware (opt-in via `ARGUS_SOURCE_DIR`, conservative-fallback on every ambiguity so a regression is never missed): **C1** new `src/utils/import-graph.js` (static import graph) + `mapFilesToRoutesDeep` maps a changed component to only the routes whose pages import it (block [156], 11); **C2** `packageRelativePath`/`stripWorkspacePrefix` re-base monorepo `apps/web/…` paths into the package graph (block [157], 8); **C3** `import-graph.js` tracks CSS/SCSS/Sass/Less leaves so a changed non-global stylesheet narrows to only its importing routes, while a global stylesheet stays conservative (block [158], 7). +26 hard assertions; unit suite 162→207 (new `import-graph.test.js`). **Net: 154 → 157 blocks, 881 → 907 hard assertions, 907/907 gate** (fixtures unchanged at 63 HTML pages + new filesystem fixtures `import-graph-fixture/`/`import-graph-monorepo-fixture/`; detection categories unchanged at 67 — Phase C is a CI route-mapping surface, not a new detector). Pending npm/Action release (src behavior changed in `pr-diff-analyzer.js` / new `import-graph.js` / `route-discoverer.js`).

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `154` | `157` |
| `stats[2].num` (ASSERTIONS RUN) | `881` | `907` |
| Docs § "Test Coverage" tagline | `154 blocks, 881 hard assertions` | `157 blocks, 907 hard assertions` |
| Docs § "Running" code | `162 Vitest tests`, `881 hard assertions`, `881/881` | `207 Vitest tests`, `907 hard assertions`, `907/907` |
| Docs § Breakdown bullets | `162 Vitest unit tests`, `All 881 hard assertions pass` + blocks end at [155] | `207 Vitest unit tests`, `All 907 hard assertions pass` + blocks [156]/[157]/[158] added |
| `index.html` SEO/OG/JSON-LD descriptions | `67 detection types, 154 test blocks, 881 assertions` | `67 detection types, 157 test blocks, 907 assertions` |
| "How we built it" caption | `149 test blocks` | `157 test blocks` |

> Heads-up: the OG card (`og-image-v3.jpg`) still has the old **67 / 149 / 846** baked into the image (static JPEG). **Deferred** — regenerate to 67 / 157 / 907 when the landing page is next redeployed (mechanical image-reconstruction step, no code dependency).

## Stats Update (2026-06-21 — PR Validator Phase D: depth & performance)

PR Validator Phase D added depth + performance to the PR-validate path — every item opt-in + default byte-identical, none touching the block-decision direction: **D1** `parallel-crawler.js` `mapWithConcurrency`/`auditRoutesConcurrently` audit routes with bounded concurrency in INPUT order, one Chrome client per lane (`ARGUS_CONCURRENCY`, block [159], 5); **D2** new `src/utils/audit-depth.js` selective analyzer depth (`ARGUS_PR_AUDIT_DEPTH`, default cheap, drift-guarded registry, block [160], 9); **D3** new `src/utils/deploy-preview.js` adopts only a live (SUCCESS) GitHub-Deployment preview, degrading to the configured target (block [161], 5); **D4** `parallel-crawler.js` `withTimeout`/`auditRouteWithRetry` bound each route audit — a hung audit times out and is recorded as a route error (never a false pass) feeding the exported `allRoutesFailed` guard (`ARGUS_ROUTE_TIMEOUT_MS`, block [162], 5). +24 hard assertions; unit suite 207→297 (new `parallel-crawler.test.js`/`audit-depth.test.js`/`deploy-preview.test.js`/`route-timeout.test.js`). **Net: 157 → 161 blocks, 907 → 931 hard assertions, 931/931 gate** (fixtures unchanged at 63 HTML pages — D blocks are Chrome-free; detection categories unchanged at 67 — Phase D is a CI performance/robustness surface, not a new detector). Pending npm/Action release (src behavior changed in `parallel-crawler.js` + new `audit-depth.js`/`deploy-preview.js` + `orchestrator.js`/`cli-pr-validate`/`mcp-server`/`action.yml`).

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `157` | `161` |
| `stats[2].num` (ASSERTIONS RUN) | `907` | `931` |
| Docs § "Test Coverage" tagline | `157 blocks, 907 hard assertions` | `161 blocks, 931 hard assertions` |
| Docs § "Running" code | `207 Vitest tests`, `907 hard assertions`, `907/907` | `297 Vitest tests`, `931 hard assertions`, `931/931` |
| Docs § Breakdown bullets | `207 Vitest unit tests`, `All 907 hard assertions pass` + blocks end at [158] | `297 Vitest unit tests`, `All 931 hard assertions pass` + blocks [159]/[160]/[161]/[162] added |
| `index.html` SEO/OG/JSON-LD descriptions | `67 detection types, 157 test blocks, 907 assertions` | `67 detection types, 161 test blocks, 931 assertions` |
| "How we built it" caption | `157 test blocks` | `161 test blocks` |

> Heads-up: the OG card (`og-image-v3.jpg`) still has the old **67 / 149 / 846** baked into the image (static JPEG). **Deferred** — regenerate to 67 / 161 / 931 when the landing page is next redeployed (mechanical image-reconstruction step, no code dependency).

## Stats Update (2026-06-22 — PR Validator Phase E: robustness / contract armor)

PR Validator Phase E hardened the PR-validate path's GitHub I/O + merge gate and locked CLI↔MCP parity: **E2** new `src/utils/github-api.js` — one shared resilient `githubFetch` both throw-path callers (`fetchPrFiles` + the reporter's `ghFetch`) route through, retrying rate-limit/5xx/network with capped backoff and never leaking the token in an error (block [163], 5); **E3** the merge gate exhaustively pinned — block-on × severity + all-routes-failed guard + base-unavailable fail-safe + decision→exit-code via the new exported `prExitCode` (block [164], 7); **E4** CLI↔MCP block-decision parity — the route-source divergence stays intentional + documented in both files, but the block decision is shared: both build the summary via one shared `severityTally` and delegate the gate to one shared `decidePrBlock`, so they reach the identical decision for the same findings (block [165], 4). +16 hard assertions; unit suite 297→340 (new `github-api.test.js`). **Net: 161 → 164 blocks, 931 → 947 hard assertions, 947/947 gate** (fixtures unchanged at 63 HTML pages — E blocks are Chrome-free; detection categories unchanged at 67 — Phase E is a CI robustness surface, not a new detector). Pending npm/Action release (src behavior changed in new `github-api.js` + `pr-diff-analyzer.js`/`github-reporter.js`/`cli-pr-validate`/`mcp-server`/`pr-baseline`).

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `161` | `164` |
| `stats[2].num` (ASSERTIONS RUN) | `931` | `947` |
| Docs § "Test Coverage" tagline | `161 blocks, 931 hard assertions` | `164 blocks, 947 hard assertions` |
| Docs § "Running" code | `297 Vitest tests`, `931 hard assertions`, `931/931` | `340 Vitest tests`, `947 hard assertions`, `947/947` |
| Docs § Breakdown bullets | `297 Vitest unit tests`, `All 931 hard assertions pass` + blocks end at [162] | `340 Vitest unit tests`, `All 947 hard assertions pass` + blocks [163]/[164]/[165] added |
| `index.html` SEO/OG/JSON-LD descriptions | `67 detection types, 161 test blocks, 931 assertions` | `67 detection types, 164 test blocks, 947 assertions` |
| "How we built it" caption | `161 test blocks` | `164 test blocks` |

> Heads-up: the OG card (`og-image-v3.jpg`) still has the old **67 / 149 / 846** baked into the image (static JPEG). **Deferred** — regenerate to 67 / 164 / 947 when the landing page is next redeployed (mechanical image-reconstruction step, no code dependency).

## Stats Update (2026-06-25 — PR Validator Phase F: test maximization — PR_VALIDATOR_MAX_PLAN complete)

PR Validator Phase F closed out the plan with hermetic, network-free test maximization for the whole PR-validate path: **F1** new fixture `test-harness/contracts/github-reporting-samples.js` (faithful documented-schema responses for all six reporting endpoints) — block [166] (4) proves Argus parses the documented comment/Check-Run *response* shape, idempotently updates one marker-tagged comment, and never leaks the token; **F2** the first block to drive the real CLI `src/cli/pr-validate.js` as a child process end-to-end (docs-only PR → exit 0; a `blank_page` critical → exit 1) — block [167] (8) pins exit codes, GitHub Action outputs, step-summary banners, annotations, and the JSON result, all tokenless; **F3** direct Chrome-free unit tests for the nine PR-Validator fns that were harness-only + re-verified B1/E3/D4 by mutation (unit suite 340→366, no harness block); **F4** the `argus_pr_validate` golden schema now explicitly pins the A4 `reporting` + B1/B2 `baseline` rider fields as `.optional()` shapes (non-vacuous negative controls [147o]/[147p]). +14 hard assertions. **Net: 164 → 166 blocks, 947 → 961 hard assertions, 961/961 gate** (fixtures unchanged at 63 HTML pages; detection categories unchanged at 67 — Phase F is a test surface, not a new detector). F1/F3/F4 are test-only; F2 adds one small `GITHUB_API_URL` seam in `pr-diff-analyzer.js` that joins the still-pending Phase A–E npm/Action release.

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `164` | `166` |
| `stats[2].num` (ASSERTIONS RUN) | `947` | `961` |
| Docs § "Test Coverage" tagline | `164 blocks, 947 hard assertions` | `166 blocks, 961 hard assertions` |
| Docs § "Running" code | `340 Vitest tests`, `947 hard assertions`, `947/947` | `366 Vitest tests`, `961 hard assertions`, `961/961` |
| Docs § Breakdown bullets | `340 Vitest unit tests`, `All 947 hard assertions pass` + blocks end at [165] | `366 Vitest unit tests`, `All 961 hard assertions pass` + blocks [166]/[167] added |
| `index.html` SEO/OG/JSON-LD descriptions | `67 detection types, 164 test blocks, 947 assertions` | `67 detection types, 166 test blocks, 961 assertions` |
| "How we built it" caption | `164 test blocks` | `166 test blocks` |

> OG card: **Resolved 2026-06-25** — `og-image-v3.jpg` regenerated to **67 / 166 / 961** for v9.8.0. Only the two changed numbers (166, 961) were re-rendered onto the original art: a clean slice of the gradient just above the stat row was block-copied down to erase the old digits, then cap-height-matched native digits were drawn in the brand purple (`rgb(101,44,200)`) so they sit flush with the untouched `67`. Still 1200×630, ~103 KB.
