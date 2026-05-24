# Argus — Landing Page

Product marketing site for Argus. Runs independently from the main Argus QA harness.

## Tech Stack

| Layer | Library |
|---|---|
| Framework | React 18 |
| Build tool | Vite |
| Styling | Tailwind CSS + inline styles |
| Animations | Framer Motion |
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

`landing/dist/` is gitignored — deploy the `dist/` folder to your static host (Netlify, Vercel, Cloudflare Pages, etc.).

## Component Structure

All UI lives in `src/App.jsx` as a single-file app:

| Component | Purpose |
|---|---|
| `Logo` | SVG icon — purple ring + dot |
| `HeroSection` | Headline, subheadline, CTA buttons |
| `FeaturesSection` | Feature grid with icons |
| `ComparisonSection` | Pricing comparison table |
| `WaitlistModal` | Email + plan selector → inserts into `waitlist` table |
| `EnterpriseModal` | Name/email/company/message → inserts into `enterprise_contacts` table |

`src/supabase.js` exports the singleton Supabase client (or `null` if env vars are absent).

## Known Mobile Issues (Sprint 0 — pending)

1. **Comparison table scroll** — `<table style={{ minWidth: 540 }}>` needs `overflowX: 'auto'` wrapper
2. **Touch targets** — CTA buttons need `minHeight: 44` / `minWidth: 44` (Apple HIG / WCAG 2.5.5)
3. **Video poster** — `<video>` needs a `poster` attribute; iOS battery saver can block autoplay
4. **Modal viewport height** — replace `100vh` with `100dvh` + `100vh` fallback for iOS <15.4
5. **Reduced motion** — wrap Framer Motion animations with `useReducedMotion()` hook
6. **Hero font size** — use `clamp(2rem, 5vw, 3.5rem)` for 375px screens
