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

## Sprint 0 Mobile & SEO Status (2026-05-26)

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
| OG social card | ✅ Done | `og-image-v2.jpg` — 1200×630 JPEG, cover-mode scaled from `argus-poster.png`, branded overlay, black-outlined purple stat numbers (original 54 / 84 / 367 — baked into image asset); `og-image.jpg` gitignored |
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

## Stats Update (2026-06-02 — Sprint 2 v9.5.3)

Hero stats and docs section updated to reflect Sprint 2 (block [128] — D9 Design Fidelity):

| Field | Old | New |
|---|---|---|
| `stats[1].num` (TEST BLOCKS) | `127` | `128` |
| `stats[2].num` (ASSERTIONS RUN) | `535` | `544` |
| Docs § "Test Coverage" tagline | `127 blocks, 535 hard assertions` | `128 blocks, 544 hard assertions` |
| Docs § "Running" code | `535 hard assertions`, `532/535` | `544 hard assertions`, `541/544` |
| "How we built it" caption | `127 test blocks` | `128 test blocks` |

## Stats Update (2026-06-04 — Sprint 2 maximum potential)

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
| Docs § "Test Coverage" tagline | `128 blocks, 559 hard assertions` | `129 blocks, 572 hard assertions` |
| Docs § "Running" code | `559 hard assertions`, `556/559` | `565 hard assertions`, `562/565` |
