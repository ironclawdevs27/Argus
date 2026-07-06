import { useState, useEffect, lazy, Suspense } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import { supabase } from './supabase'
import { useNpmDownloads } from './useNpmDownloads'
import { DownloadBadge } from './DownloadBadge'
import { AuthModal } from './AuthModal'
import {
  ACCENT, SURFACE_TINT, DANGER,
  accent, accentLight, warning, success,
} from './theme'

// Charts pull in Recharts (d3 internals) — lazy-load so the heavy chart bundle stays
// out of the initial payload; the section is below the fold.
const DownloadsSection = lazy(() => import('./DownloadsSection').then(m => ({ default: m.DownloadsSection })))
// Security & Compliance (Aegis) — animated SVG diagrams; lazy-loaded, below the fold.
const SecuritySection = lazy(() => import('./SecuritySection').then(m => ({ default: m.SecuritySection })))
import {
  ArrowUpRight, X, ChevronDown, ChevronRight, CheckCircle,
  Code2, Sparkles, Globe,
  Terminal, Wifi, Search, Shield, Zap, Eye, Database, Layers,
  Bell, GitBranch, BarChart3, Activity, Frame,
} from 'lucide-react'

// GitHub brand mark — lucide v1 removed brand icons (Github/Figma), so inline the
// exact octocat SVG here. Keeps the logo identical and decouples us from lucide's
// brand-icon churn. (Figma icon was imported but unused — dropped.)
function Github({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.27-.01-1.16-.02-2.1-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.53 11.53 0 0 0 23.5 12.02C23.5 5.74 18.27.5 12 .5z" />
    </svg>
  )
}

const VIDEO_URL = 'https://pub-4a48bc28d90e4425a6fb87b164225d13.r2.dev/argus-video.mp4'
const GITHUB_URL = 'https://github.com/ironclawdevs27/Argus'
const SLIDE_INTERVAL = 5000
const SCROLL_SHOW_DELAY = 1500
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const navLinks = ['Growth', 'Features', 'How It Works', 'Security', 'Setup', 'Pricing', 'Docs']

const navHrefs = {
  Growth: '#growth',
  Features: '#features',
  'How It Works': '#detection',
  Security: '#security',
  Setup: '#setup',
  Pricing: '#pricing',
  Docs: '#docs',
}

const stats = [
  { num: '67', label: 'DETECTION\nTYPES' },
  { num: '168', label: 'TEST\nBLOCKS' },
  { num: '978', label: 'ASSERTIONS\nRUN' },
]

const headingWords = ['Every', 'Bug', 'Caught']

const GLAMA_BADGE_URL = 'https://glama.ai/mcp/servers/ironclawdevs27/Argus/badges/card.svg'
const GLAMA_URL = 'https://glama.ai/mcp/servers/ironclawdevs27/Argus'

const slides = [
  'AI-Powered QA Engine Built Around Chrome DevTools Protocol And Real Browser Automation',
  'Catching Bugs Before\nThey Hit Your\nProduction',
  'Zero Test Scripts — Add One Block\nTo Your Claude Config.\nQA Runs Automatically',
  'Open Source Forever — MCP Server,\nCLI, Slack & GitHub Alerts,\nAll Included At No Cost',
  { type: 'badge', src: GLAMA_BADGE_URL, href: GLAMA_URL, alt: 'Argus on Glama MCP' },
  'Watch Mode — Passive Bug Detection\nWhile You Browse\nYour Own App',
  'Dev vs Staging Diff —\nCatch Environment-Only\nRegressions Automatically',
  'Figma Design Fidelity —\nCompare Live DOM Against Design Specs.\n13 Properties Checked Automatically',
  'Visual Regression —\nPixel-Level Screenshot Baseline.\nAuto-Detects Every UI Change',
  'Deep Accessibility —\naxe-core 80+ WCAG Rules +\nColor-Blind CVD Simulation',
  'HAR Network Baseline —\nTrack Every Request Across Runs.\nCatch Silent API Regressions',
]

const fadeDown = {
  initial: { opacity: 0, y: -20 },
  animate: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  }),
}

const fadeUp = {
  initial: { opacity: 0, y: 32 },
  animate: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.12, duration: 0.6, ease: [0.22, 1, 0.36, 1] },
  }),
}

// ── Features data ──────────────────────────────────────────────────────────────
const features = [
  {
    icon: Code2,
    title: 'Zero Test Scripts',
    desc: 'No test files, no selectors, no fragile CSS paths to maintain. Point Argus at a URL and it works.',
    tag: 'ZERO SETUP',
  },
  {
    icon: Sparkles,
    title: 'AI-Native by Design',
    desc: 'Claude drives every audit via MCP. Ask naturally, get systematic bug reports — the first QA tool built to think like a developer.',
    tag: 'MCP POWERED',
  },
  {
    icon: Globe,
    title: 'Real Browser, Real Bugs',
    desc: 'Every audit runs in live Chrome via CDP. Not a simulation — including timing, layout, and race conditions.',
    tag: 'CDP ENGINE',
  },
  {
    icon: Database,
    title: 'Baseline Tracking',
    desc: 'Every run is compared to the previous. Known issues are silenced — only new regressions alert your team.',
    tag: 'SMART DIFF',
  },
  {
    icon: GitBranch,
    title: 'Baseline-Aware PR Gating',
    desc: 'Maps a PR diff to the routes it actually touches, audits only those, and blocks merges only on regressions the PR introduces. Posts an idempotent findings comment plus a GitHub Check Run.',
    tag: 'CI / CD',
  },
  {
    icon: Bell,
    title: 'Slack Alerts',
    desc: 'Structured Block Kit messages sent to your channel. Fully optional — never blocks a run if Slack is unavailable.',
    tag: 'NOTIFICATIONS',
  },
  {
    icon: Terminal,
    title: 'Flow Runner DSL',
    desc: 'Define multi-step user flows in config: login, fill forms, assert URL changes, handle dialogs. All run before analysis.',
    tag: 'USER FLOWS',
  },
  {
    icon: Search,
    title: 'Auto Route Discovery',
    desc: 'Parses sitemap.xml, Next.js pages/app directory, and React Router config. No manual route list required.',
    tag: 'DISCOVERY',
  },
  {
    icon: Layers,
    title: 'Dev vs Staging Compare',
    desc: 'Parallel audits on dev and staging. Diff the findings set to surface environment-specific regressions.',
    tag: 'ENV COMPARE',
  },
  {
    icon: Activity,
    title: 'Watch Mode',
    desc: 'Attach to a running Chrome tab and monitor console errors and network failures passively as you develop.',
    tag: 'LIVE MONITOR',
  },
  {
    icon: Wifi,
    title: 'MCP Server Mode',
    desc: 'Runs as an MCP server. Ask Claude to audit any URL directly in a conversation — no CLI, no config needed.',
    tag: 'MCP SERVER',
  },
  {
    icon: Frame,
    title: 'Figma Design Fidelity',
    desc: 'Compare live DOM against Figma frames automatically. 13 visual properties checked: color, typography, spacing, shadows, position drift, and more.',
    tag: 'DESIGN QA',
  },
  {
    icon: CheckCircle,
    title: 'Zero-Config Init',
    desc: '`argus init` detects your framework, discovers routes via sitemap + Next.js + React Router, and writes a populated .env and targets.js in one pass.',
    tag: 'SETUP WIZARD',
  },
  {
    icon: BarChart3,
    title: 'HTML Dashboard',
    desc: 'Every audit generates a self-contained HTML report with charts, screenshots per route, and full finding tables — exportable to PDF.',
    tag: 'REPORTS',
  },
]

// ── Detection data ─────────────────────────────────────────────────────────────
const detections = [
  {
    icon: Terminal,
    title: 'Console & Errors',
    desc: 'Unhandled exceptions, JS errors, warning storms',
    count: 9,
    details: [
      'Unhandled promise rejections',
      'JavaScript TypeError / ReferenceError',
      'Custom warning pattern matching via regex',
      'Debugger statements in production builds',
      'Console error storm detection',
      'Error source file and line linking',
      'Chrome DevTools Issues (CSP, deprecated APIs)',
      'Duplicate element ID detection',
      'Mixed content hard blocks',
    ],
  },
  {
    icon: Wifi,
    title: 'Network & APIs',
    desc: 'Failed requests, slow responses, CORS failures',
    count: 8,
    details: [
      'HTTP 4xx / 5xx response detection',
      'CORS failure detection',
      'Redirect chain depth > 2 hops',
      'Slow third-party blocking (TTFB > 2s)',
      'Broken internal link crawling',
      'API response schema validation',
      'First-party vs third-party origin tagging',
      'HTTPS enforcement check (non-localhost)',
    ],
  },
  {
    icon: Search,
    title: 'SEO',
    desc: 'Missing tags, broken structured data, crawl blocks',
    count: 7,
    details: [
      'Missing or duplicate page title',
      'Missing meta description',
      'Missing or invalid Open Graph tags',
      'Relative og:image URL (must be absolute)',
      'Sitemap.xml accessibility and validity',
      'Heading hierarchy validation (h1 → h3 skips)',
      'Missing canonical tag',
    ],
  },
  {
    icon: Shield,
    title: 'Security',
    desc: 'Missing headers, exposed tokens, insecure cookies, vulnerable dependencies',
    count: 10,
    details: [
      'Missing Content-Security-Policy header',
      'Missing HSTS and X-Frame-Options',
      'Insecure cookie flags (Secure, HttpOnly, SameSite)',
      'Mixed content (HTTP resources on HTTPS pages)',
      'Cross-origin iframe without sandbox attribute',
      'Exposed environment variables in client bundles',
      'SRI validation — external scripts and stylesheets missing integrity attribute',
      'Source map exposure — .js.map / .css.map files accessible in production',
      'Open redirect detection — URL parameter heuristic (?redirect=, ?return=, etc.)',
      'npm audit — known CVEs in production dependencies',
    ],
  },
  {
    icon: Zap,
    title: 'Performance',
    desc: 'LCP regressions, CLS shifts, long blocking tasks',
    count: 7,
    details: [
      'Core Web Vitals: LCP, CLS, FCP, TTFB, TTI via Performance API (headless-compatible)',
      'Bundle size regression: JS ≥ 500 KB / ≥ 2 MB, CSS ≥ 150 KB',
      'Slow or blocking third-party scripts',
      'Font loading issues (FOUT, FOIT)',
      'Missing resource hints (preload, prefetch, preconnect)',
      'Missing cache-control headers on static assets',
      'Mobile CPU throttle audit at 375px and 768px',
    ],
  },
  {
    icon: Eye,
    title: 'Accessibility',
    desc: 'Missing ARIA, contrast failures, keyboard traps',
    count: 5,
    details: [
      'Missing form labels (WCAG §3.3.2)',
      'aria-expanded with missing aria-controls reference',
      'Keyboard Tab-walk focus visibility (outline:0)',
      'Accessibility tree role / name / state analysis',
      'Heading level hierarchy validation',
    ],
  },
  {
    icon: Database,
    title: 'Memory & Leaks',
    desc: 'Detached DOM nodes, heap growth, listener leaks',
    count: 5,
    details: [
      'Heap snapshot delta before and after navigation',
      'Detached DOM node detection',
      'Memory growth across multiple navigations',
      'Service worker registration and update flow issues',
      'Event listener accumulation indicators',
    ],
  },
  {
    icon: Layers,
    title: 'Responsive UI',
    desc: 'Overflow clipping, viewport breaks, flex failures',
    count: 5,
    details: [
      'Horizontal overflow at 375px (mobile)',
      'Horizontal overflow at 768px (tablet)',
      'Horizontal overflow at 1280px (desktop)',
      'Unclickable touch targets below 44px',
      'Visual screenshot diff between breakpoints',
    ],
  },
  {
    icon: Frame,
    title: 'Design Fidelity',
    desc: 'Figma spec vs live DOM — closes the design-implementation gap automatically',
    count: 13,
    details: [
      'Fill and text color accuracy (RGB distance, ≤5% tolerance per channel)',
      'Typography — font-size, weight, line-height, family, and letter-spacing',
      'Auto Layout padding and gap (column-gap / row-gap by layout direction)',
      'Border-radius — per-corner comparison (topLeft, topRight, bottomRight, bottomLeft)',
      'Box-shadow — offset, blur, spread, and shadow color all compared',
      'Border stroke — color and weight deviation',
      'Absolute position drift (scroll-corrected x/y vs Figma frame bounds, 20px threshold)',
      'Bounding-box overflow — element must not exceed Figma spec dimensions',
      'Opacity comparison (when Figma specifies < 100%)',
      'DOM text content vs Figma characters string (exact match)',
      'CSS custom property vs Figma design token value',
      'Missing component — Figma-specified selector absent from DOM',
      'Selector fallback: [data-testid] → [aria-label] → #id → .class per node',
    ],
  },
]

// ── Setup methods ──────────────────────────────────────────────────────────────
const setupMethods = [
  {
    id: 'mcp',
    label: 'MCP Server',
    badge: 'Open Source',
    tagline: 'For Claude Code users. Ask Claude to run QA directly in any conversation.',
    prereqs: [
      { label: 'Node.js 20+', detail: 'ES modules and modern async/await support' },
      { label: 'Google Chrome', detail: 'Desktop version, driven via remote debugging' },
      { label: 'Claude (any tier)', detail: 'Argus registers as an MCP server Claude connects to' },
    ],
    steps: [
      {
        num: '01',
        title: 'Register Both MCP Servers',
        desc: 'Add both Argus and Chrome DevTools to your .mcp.json. No local install — npx auto-downloads both when Claude starts.',
        code: `# Add to .mcp.json in your project root:
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

# Or via Claude Code CLI:
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
claude mcp add argus -- npx -y argusqa-os`,
      },
      {
        num: '02',
        title: 'Set Environment Variables',
        desc: 'Create a .env file in your project root with your target URLs.',
        code: `# .env
TARGET_DEV_URL=http://localhost:3000
TARGET_STAGING_URL=https://staging.yourapp.com   # optional — enables argus_compare`,
      },
      {
        num: '03',
        title: 'Start Chrome',
        desc: 'Launch Chrome with remote debugging on port 9222. Use argus-chrome for cross-platform auto-detection, or launch manually.',
        code: `# Cross-platform — auto-detects Chrome binary (Windows / macOS / Linux):
npx argus-chrome

# Or launch manually:
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new

# Windows (PowerShell)
& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\\chrome-argus"

# Linux / CI
google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox`,
      },
      {
        num: '04',
        title: 'Slack Notifications (Optional)',
        desc: 'Skip this step to use local report.html mode — Argus auto-generates a self-contained HTML report when Slack is not configured.',
        code: `# api.slack.com/apps → Create New App → name it BugBot
# OAuth & Permissions → Bot Token Scopes: chat:write, files:write, files:read
# Install to workspace → copy Bot User OAuth Token

# .env (add to existing):
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_CRITICAL=C0000000000   # #bugs-critical
SLACK_CHANNEL_WARNINGS=C0000000001   # #bugs-warnings
SLACK_CHANNEL_DIGEST=C0000000002     # #bugs-digest`,
      },
      {
        num: '05',
        title: 'Audit via Claude',
        desc: 'Ask Claude directly. Nine tools available — from fast audits to PR diff analysis, visual regression, and Figma design fidelity.',
        code: `# Fast audit — JS errors, network, a11y, SEO, security, CSS, content:
"Run argus_audit on http://localhost:3000/checkout"

# Deep audit — adds Lighthouse, responsive layout, memory leak detection:
"Run argus_audit_full on http://localhost:3000/dashboard"

# Compare dev vs staging environments:
"Run argus_compare"

# Retrieve last saved report without re-running:
"Run argus_last_report"

# Snapshot current tab without navigating (post-auth, mid-flow):
"Run argus_watch_snapshot"

# App broken? Capture full context for Claude to diagnose and fix:
"Run argus_get_context"

# Design fidelity — compare live page against Figma frame (requires FIGMA_API_TOKEN):
"Run argus_design_audit on http://localhost:3000 with figmaFrameUrl: https://figma.com/file/..."

# Visual regression — pixel-level screenshot diff against saved baseline:
"Run argus_visual_diff on http://localhost:3000"
# Pass updateBaseline: true after intentional UI changes to reset the baseline

# PR diff → auto-detect affected routes → targeted audit → block on new criticals:
"Run argus_pr_validate with prUrl: https://github.com/owner/repo/pull/123"`,
      },
    ],
  },
  {
    id: 'cli',
    label: 'CLI & CI/CD',
    badge: 'Open Source',
    tagline: 'For pipelines and automation. Run headless audits in GitHub Actions or any CI system.',
    prereqs: [
      { label: 'Node.js 20+', detail: 'Required for argusqa-os and the crawl scripts' },
      { label: 'Google Chrome', detail: 'Pre-installed on most CI runners (ubuntu-latest)' },
    ],
    steps: [
      {
        num: '01',
        title: 'Install & Initialize',
        desc: 'Install argusqa-os, then run the interactive setup wizard to generate .env and targets.js — detects your framework, discovers routes, optionally collects Slack and GitHub credentials.',
        code: `npm install --save-dev argusqa-os
npx argus   # wizard: URLs, framework detection, route discovery, Slack/GitHub config
# Writes: .env  +  src/config/targets.js`,
      },
      {
        num: '02',
        title: 'Start Chrome',
        desc: 'Launch Chrome in headless mode. Use argus-chrome for cross-platform auto-detection, or use the runner pre-installed binary in CI.',
        code: `# Cross-platform local (auto-detects Chrome binary):
npx argus-chrome

# Or manually (macOS / Linux):
google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox &

# GitHub Actions (Chrome is pre-installed on ubuntu-latest):
- name: Start Chrome
  run: google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu &`,
      },
      {
        num: '03',
        title: 'Run Argus',
        desc: 'All commands available via npx or npm scripts. Results saved as JSON in reports/.',
        code: `# Pre-flight check (Chrome reachable, .mcp.json valid, .env has TARGET_DEV_URL):
npx argus-doctor

# Full audit of all configured routes:
node node_modules/argusqa-os/src/orchestration/crawl-and-report.js

# Dev vs staging diff (or CSS analysis if no TARGET_STAGING_URL):
node node_modules/argusqa-os/src/orchestration/env-comparison.js

# Passive watch — polls open Chrome tab every 1s, no navigation:
node node_modules/argusqa-os/src/orchestration/watch-mode.js

# Export HTML report to A4 PDF (requires: npm install puppeteer):
node node_modules/argusqa-os/src/cli/pdf-exporter.js

# Generate HTML report from last audit:
node node_modules/argusqa-os/src/utils/html-reporter.js`,
      },
      {
        num: '04',
        title: 'GitHub Actions Workflow',
        desc: 'Add to your workflow to run QA on every pull request. New criticals fail the status check and block merge.',
        code: `# .github/workflows/argus.yml
name: Argus QA
on:
  push: { branches: [main, master] }
  pull_request:
  schedule: [{ cron: '0 6 * * *' }]   # daily 6 AM UTC
  workflow_dispatch:
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Start Chrome
        run: google-chrome --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu &
      - name: Run Argus
        run: node node_modules/argusqa-os/src/orchestration/crawl-and-report.js
        env:
          TARGET_STAGING_URL: \${{ secrets.TARGET_STAGING_URL }}
          SLACK_BOT_TOKEN: \${{ secrets.SLACK_BOT_TOKEN }}
          SLACK_CHANNEL_CRITICAL: \${{ secrets.SLACK_CHANNEL_CRITICAL }}
          SLACK_CHANNEL_WARNINGS: \${{ secrets.SLACK_CHANNEL_WARNINGS }}
          SLACK_CHANNEL_DIGEST: \${{ secrets.SLACK_CHANNEL_DIGEST }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          GITHUB_PR_NUMBER: \${{ github.event.pull_request.number }}`,
      },
    ],
  },
  {
    id: 'hosted',
    label: 'Hosted SaaS',
    badge: 'Pro / Team',
    comingSoon: true,
    tagline: 'No npm, no Chrome, no infrastructure. Connect your URL and Argus handles everything.',
    prereqs: [],
    steps: [],
  },
]

// Stripe Payment Links — set in landing/.env.local (build-time, VITE_*) then rebuild + redeploy.
// Empty string → the CTA falls back to the waitlist, so the site is byte-identical to today until
// a link is configured. Create the link in the Stripe dashboard → Payment Links (no keys in code).
const STRIPE_LINKS = {
  pro: import.meta.env.VITE_STRIPE_PRO_LINK || '',
}

// ── Pricing plans ──────────────────────────────────────────────────────────────
const pricingPlans = [
  {
    id: 'opensource',
    name: 'Open Source',
    price: '$0',
    period: 'forever',
    tag: 'SELF-HOSTED',
    dark: false,
    description: 'The complete QA harness, self-hosted. Full source on GitHub. No restrictions.',
    benefits: [
      'All 67 detection categories',
      'MCP server — callable from Claude',
      'CLI for CI/CD pipelines',
      'Slack & GitHub PR integration',
      'HTML report dashboard',
      'Baseline tracking & trend history',
      'Per-branch baselines in CI',
      'Community support',
    ],
    cta: 'Get Started Free',
    ctaHref: '#setup',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$29',
    period: '/month',
    tag: 'MOST POPULAR',
    popular: true,
    dark: false,
    comingSoon: true,
    // Founding-member pre-sale — rendered ONLY when STRIPE_LINKS.pro is set. All copy/price
    // in one place; adjust freely. Honest framing: early access, not a finished dashboard.
    founding: {
      tag: 'FOUNDING MEMBER',
      price: '$19', origPrice: '$29', period: '/month',
      cta: 'Become a Founding Member',
      note: 'Price locked forever · first access to the hosted dashboard the moment it ships · direct founder support.',
    },
    description: 'Hosted QA with zero infrastructure. No Chrome, no npm, no config.',
    benefits: [
      'Everything in Open Source',
      'Fully hosted — no Chrome or npm needed',
      'Up to 10 projects',
      'Scheduled audits (on PR, nightly, continuous)',
      'Cloud report storage & history',
      'Web dashboard',
      'Invite teammates & shared baselines',
      'Trend charts & regression alerts',
      'Slack & email alerts included',
    ],
    cta: 'Join Waitlist',
    ctaAction: 'waitlist',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    tag: 'ENTERPRISE',
    dark: true,
    description: 'For large organisations with compliance, security, and custom requirements.',
    benefits: [
      'Everything in Pro',
      'Unlimited projects & team members',
      'SSO via SAML 2.0 or OIDC',
      'On-premises deployment option',
      'Custom detection rules & policies',
      'Uptime SLA guarantee',
      'Dedicated support engineer',
      'Compliance & audit log reports',
      'Custom contract & billing terms',
    ],
    cta: 'Contact Us',
    ctaAction: 'enterprise',
  },
]

// ── Pricing comparison rows ────────────────────────────────────────────────────
const COMPARISON_ROWS = [
  { feature: 'All 67 detection categories',         open: true,  pro: true,  team: true,  enterprise: true  },
  { feature: 'MCP server & CLI tools',              open: true,  pro: true,  team: true,  enterprise: true  },
  { feature: 'Slack & GitHub PR integration',       open: true,  pro: true,  team: true,  enterprise: true  },
  { feature: 'Baseline & trend tracking',           open: true,  pro: true,  team: true,  enterprise: true  },
  { feature: 'HTML report dashboard',               open: true,  pro: true,  team: true,  enterprise: true  },
  { feature: 'Hosted — no Chrome or npm needed',    open: false, pro: true,  team: true,  enterprise: true  },
  { feature: 'Scheduled audits (PR / nightly)',     open: false, pro: true,  team: true,  enterprise: true  },
  { feature: 'Cloud report storage & history',      open: false, pro: true,  team: true,  enterprise: true  },
  { feature: 'Up to 10 hosted projects',            open: false, pro: true,  team: true,  enterprise: true  },
  { feature: 'Team members & shared baselines',     open: false, pro: true,  team: true,  enterprise: true  },
  { feature: 'Unlimited projects & team members',   open: false, pro: false, team: true,  enterprise: true  },
  { feature: 'Trend charts & regression alerts',    open: false, pro: true,  team: true,  enterprise: true  },
  { feature: 'Priority support (< 4hr response)',   open: false, pro: false, team: true,  enterprise: true  },
  { feature: 'SSO — SAML 2.0 or OIDC',             open: false, pro: false, team: false, enterprise: true  },
  { feature: 'On-premises deployment',              open: false, pro: false, team: false, enterprise: true  },
  { feature: 'Custom detection rules & policies',   open: false, pro: false, team: false, enterprise: true  },
  { feature: 'Uptime SLA guarantee',                open: false, pro: false, team: false, enterprise: true  },
  { feature: 'Compliance & audit log reports',      open: false, pro: false, team: false, enterprise: true  },
]

// ── Doc chapters ───────────────────────────────────────────────────────────────
const docChapters = [
  {
    num: '01',
    title: 'What Argus Does',
    tagline: 'A QA harness driven by real Chrome sessions, not simulation',
    sections: [
      {
        body: 'Argus connects to Chrome via the Chrome DevTools Protocol and crawls your application like a real user would. It loads each configured route, injects event listeners before page settle, captures console output, intercepts network requests, takes heap snapshots, and executes user flow scripts. Every finding is structured with a type, message, severity, and route — then deduplicated, compared against a historical baseline, and dispatched to configured channels.',
      },
      {
        title: 'Key Capabilities',
        bullets: [
          'Crawls every route and detects 67+ classes of bugs automatically',
          'Executes DSL-defined multi-step user flows with inline assertions',
          'Compares dev vs staging environments and diffs the findings set',
          'Tracks per-run baselines — only new issues trigger alerts',
          'Runs as an MCP server — callable directly from Claude conversations',
          'Auto-discovers routes from sitemap.xml, Next.js, or React Router config',
          'Audits static source code for missing environment variables and dead routes',
          'Generates HTML dashboards, JSON reports, Slack messages, and GitHub PR comments',
          '`argus init` wizard: detects framework, discovers routes, writes .env + targets.js — zero manual config',
        ],
      },
    ],
  },
  {
    num: '02',
    title: 'Architecture',
    tagline: 'From a 1,600-line monolith to a plugin registry and focused orchestration layers',
    sections: [
      {
        body: 'The codebase started as a single orchestration file that grew beyond 1,600 lines as features accumulated. Every new detection phase required editing the same file, and every test required understanding the full execution model. We split it into three focused orchestration modules and introduced an analyzer plugin registry so each analyzer self-registers at import — the orchestrator never needs to know the list.',
      },
      {
        title: 'Three Layers',
        bullets: [
          'Entry Points — single-page audit, batch runner, MCP server',
          'Orchestration Layer — crawl loop, report processing, Slack/GitHub/HTML dispatch, env comparison',
          'Analyzer Plugins — 20+ specialized analyzers, each self-registering via registerExpensive() at module load',
        ],
      },
      {
        title: 'Key Design Patterns',
        bullets: [
          'CdpBrowserAdapter — all Chrome DevTools calls go through one facade; version-isolated and mockable in tests',
          'createFinding() factory — enforces canonical shape at creation, returns a frozen object, throws on invalid severity',
          'Plugin registry — analyzers call registerExpensive() at the bottom of their file; orchestrator calls getExpensive() without knowing the list',
          'Pino structured logging — JSON in CI, pretty in TTY; child loggers per module via childLogger()',
          'withRetry() exponential backoff — applied to navigate and fill only; click is intentionally excluded (not idempotent)',
        ],
      },
    ],
  },
  {
    num: '03',
    title: '67 Detection Categories',
    tagline: 'Every surface a browser exposes — console, network, DOM, accessibility, performance, and design fidelity',
    sections: [
      {
        title: 'Core Browser Audits',
        bullets: [
          'Crawls every route and detects 67+ classes of bugs automatically',
          'Console errors and unhandled rejections',
          'Network failures: 4xx, 5xx, CORS, redirect chains',
          'SEO: title, meta description, Open Graph, sitemap, canonical',
          'Security headers: CSP, HSTS, X-Frame-Options, mixed content',
          'Content quality: broken images, missing alt text, empty links',
          'Responsive overflow at 375px, 768px, and 1280px',
        ],
      },
      {
        title: 'Advanced Analysis',
        bullets: [
          'Memory: heap snapshot delta, detached DOM nodes, growth across navigations',
          'Session: cookie and localStorage save/restore, mid-run auth token refresh',
          'Baselines: per-run and per-branch; isNew annotation; historical trend tracking',
          'Flakiness: double-crawl each route; confirmed vs flaky classification',
          'User flows: multi-step DSL with fill, click, assert, waitFor, handle_dialog',
        ],
      },
      {
        title: 'Integrations',
        bullets: [
          'Codebase cross-reference: missing env vars, feature flag leakage, dead routes',
          'GitHub PR: findings table comment + commit status check + GitHub Check Runs; blocks merge on criticals',
          'Auto route discovery: sitemap.xml, Next.js pages/app directory, React Router grep',
          'argus init CLI: interactive setup wizard; detects framework, writes .env and targets.js',
        ],
      },
      {
        title: 'Extended Detections',
        bullets: [
          'Redirect chains, cookie flags, API contract validation, severity policy overrides',
          'Core Web Vitals (LCP, CLS, FCP, TTI, TTFB) via Performance API — headless-compatible',
          'Bundle size regression: JS ≥ 500 KB / ≥ 2 MB, CSS ≥ 150 KB',
          'Duplicate element IDs, mixed content, HTML dashboard, parallel route crawling',
          'Hover-state CSS bugs, accessibility tree analysis, keystroke constraint enforcement',
          'Chrome DevTools Issues panel, HAR network timing, mobile CPU throttle',
          'Keyboard focus visibility, ARIA state checks, iframe sandbox detection',
          'A7 — Theme & Dark Mode: CSS var comparison under prefers-color-scheme: dark',
          'A8 — Visual Regression: pixel-level screenshot baseline comparison via pixelmatch',
          'A9 — Motion & Animation: prefers-reduced-motion violations, autoplay without controls',
          'A10 — Font Loading: FOIT, FOUT, missing fallbacks, slow loads > 1s, suboptimal formats',
          'A11 — Form Validation: missing required/autocomplete/aria-describedby, unlabelled inputs',
          'A12 — Deep Accessibility: axe-core 4.12 (80+ WCAG rules) + protanopia/deuteranopia CVD simulation',
          'N1 — HAR Network Baseline: new requests, missing requests, status-code regressions vs saved baseline',
          'D9 — Figma Design Fidelity: 13 properties vs Figma REST API (color, typography, spacing, shadow, position drift, and more)',
          'GitHub Check Runs: createCheckRun/completeCheckRun, selector-linked findings, release notes generator',
          'Security Extensions: SRI validation on external resources, source map exposure, open redirect detection, npm vulnerability audit (npm audit --json)',
          'CLI Utilities: argus-chrome cross-platform Chrome launcher, argus-doctor pre-flight checker (Chrome + MCP config + env vars), PDF export via puppeteer, zero-dep screenshot interval recorder',
        ],
      },
    ],
  },
  {
    num: '04',
    title: 'Engineering Challenges',
    tagline: 'The unexpected discoveries that changed how everything works',
    sections: [
      {
        title: 'MCP Tools Return Markdown, Not JSON',
        body: 'list_console_messages and list_network_requests return human-readable markdown text — not JSON arrays. The normalizeArray() helper returned [] for strings, silently producing zero findings for every console and network check. This was invisible because nothing failed — it just quietly missed everything. Fix: two regex parsers extract structured data from the text format. Dedup uses content-based keys (level::text, method::url::status) because message IDs reset after navigation.',
      },
      {
        title: 'Accessibility Snapshot UID Format Changed',
        body: 'The chrome-devtools-mcp snapshot format changed between versions. The accessibility tree now emits uid=N_M role "name" — uid first — rather than the old format where uid was a suffix. The resolveUidForSelector regex matched nothing on the new format. Hover interactions, keyboard tab-walks, and file input lookups all silently returned undefined. Fix: rewrote the regex for the leading uid=N_M pattern. Added a StaticText skip rule to prefer interactive elements when a label and an input share the same accessible name.',
      },
      {
        title: 'click() Is Not Idempotent',
        body: 'CDP navigate_page and fill calls can time out under network or browser latency. Naive retry on all browser operations would cause click to fire twice on buttons that submit forms, toggle state, or trigger deletions. navigate and fill are idempotent — same final state regardless of repetitions. click is not. Fix: withRetry() is applied only to navigate and fill, with an explicit comment on click explaining the exclusion.',
      },
      {
        title: 'Concurrent Environment Comparison Corrupts Responses',
        body: "Capturing dev and staging in parallel via Promise.allSettled caused navigate_page calls to interleave on the shared stdio MCP client, producing corrupted responses. Both environments received each other's CDP events and produced nonsensical findings. Fix: captures are strictly sequential — dev then staging — even though it means two full browser passes.",
      },
      {
        title: 'Config Generation and Code Injection',
        body: 'The argus init wizard generates targets.js from user input. Route paths and names were originally interpolated directly into a template string without sanitization. A malicious route name could write arbitrary JavaScript into the generated config file. Fix: all user inputs pass through JSON.stringify() before interpolation, producing safe JSON-escaped strings.',
      },
    ],
  },
  {
    num: '05',
    title: 'Test Coverage',
    tagline: '168 blocks, 978 hard assertions, fixture-driven with zero ambiguity',
    sections: [
      {
        body: 'Every detection category has a corresponding fixture HTML page that reliably triggers exactly that bug. Fixtures are served via HTTP — never file:// — so CORS, ES modules, and fetch APIs work correctly. Each block has at minimum 3 hard assertions and passes consistently across environments without flakiness.',
      },
      {
        title: 'Breakdown',
        bullets: [
          'Blocks 1–50: browser-based detections (phases A through D8.5)',
          'Blocks 51–64: integration unit tests (pure functions, no Chrome required)',
          'Blocks 65–78: production crawl pipeline, watch mode, extended phases',
          'Blocks 79–93: config validation, MCP server registration, createFinding(), withRetry(), watch dashboard, cli/init.js, and crawlRouteCheap production path coverage',
          'Blocks 94–126: infrastructure contracts — module APIs, MCP stdio transport, unhappy-path crawl paths, 12k-message stress test, and CLI end-to-end file write',
          'Block 127: A7 Theme & Dark Mode — emulateColorScheme, 7 assertions',
          'Block 128: D9 Figma Design Fidelity — 30 assertions [128a–128ad]',
          'Block 129: Web Vitals — LCP/CLS/FCP/TTI/TTFB + bundle size, 7 hard + 2 soft',
          'Block 130: A8 Visual Regression — pixelmatch baseline comparison, 9 assertions',
          'Block 131: A12 Deep Accessibility — axe-core + CVD simulation, 9 assertions',
          'Block 132: N1 HAR Network Baseline — record + diff, 9 assertions',
          'Block 133: A9 Motion & Animation — prefers-reduced-motion, 9 assertions',
          'Block 134: A10 Font Loading — FOIT/FOUT/fallback/slow, 9 assertions',
          'Block 135: A11 Form Validation — required/autocomplete/aria, 9 assertions',
          'Block 136: GitHub Check Runs — createCheckRun/completeCheckRun, 10 assertions',
          'Block 137: PR Diff Analyzer — parsePrUrl / mapFilesToRoutes / argus_pr_validate MCP tool, 8 assertions',
          'Block 138: GitHub Action CLI — buildStepSummary / writeGithubOutputs / pr-validate.js, 10 assertions',
          'Block 139: Chrome launcher + doctor pre-flight + security extensions (SRI, source maps, open redirects, npm audit) + PDF export + screen recorder, 11 assertions',
          'Block 140: Intelligent baseline filtering — cross-run flip-flop noise classifier, 7 assertions',
          'Block 141: Root cause linking — recent git commits mapped to new findings, 8 assertions',
          'Block 142: MCP wire-contract regressions — parseListPagesResponse / extractResponseBody / server hygiene, 9 assertions',
          'Block 143: CdpBrowserAdapter wire-contract conformance — one content assertion per adapter method + prototype coverage ratchet, 28 hard + 5 soft',
          'Block 144: MCP tool error-path matrix — structured errors + server-survives + no masked ReferenceError, across all 9 tools, 16 assertions',
          'Block 145: Multi-tab end-to-end — new_page / open_tabs / selectPage page-switch / close_page, 6 assertions',
          'Block 146: Anti-vacuous lint — the harness reads its own source and forbids new shape-only assertions, 5 assertions',
          'Block 147: Golden response schemas — every MCP tool response is safeParsed against a Zod contract, 14 assertions',
          'Block 148: Upstream canary — chrome-devtools-mcp inputSchema snapshot diff (tool set + required + property names/types) + Chrome-rot deprecation watch, 5 assertions',
          'Block 149: Per-category negative controls — a well-formed page trips no detector; 65-category over-fire sweep driving the real pipeline, 70 assertions',
          'Block 150: Verification-gap closure — positive fixtures for focus_lost, security_no_https, cors_violation and cookie_attribute_missing (the last two fixed a real Chrome-149 Issues-panel classifier bug), 13 assertions',
          'Block 151: PR Validator — idempotent GitHub PR comment, 7 assertions',
          'Block 152: PR Validator — GitHub Check Run conclusion maps to the block decision, 6 assertions',
          'Block 153: PR Validator — the argus_pr_validate MCP tool reports through the same shared helper as the CI Action, 3 assertions',
          'Block 154: PR Validator — baseline-aware blocking; gates on the findings a PR introduces vs a stored per-branch baseline, fail-safe to absolute when none, 7 assertions',
          'Block 155: PR Validator — the PR comment surfaces new/persisting/resolved counts that reconcile with the block decision, 5 assertions',
          'Block 156: PR Validator — framework-aware route mapping; a changed component maps to only the routes whose pages import it (import graph), conservative-fallback on ambiguity, 11 assertions',
          'Block 157: PR Validator — monorepo path awareness; re-bases apps/web/… paths into the package graph, foreign packages never misattributed, 8 assertions',
          'Block 158: PR Validator — stylesheet attribution; a changed non-global CSS module narrows to only its importing routes, global stylesheets stay conservative, 7 assertions',
          'Block 159: PR Validator — bounded-concurrency route auditing; results stay in route order regardless of completion, one Chrome client per lane, 5 assertions',
          'Block 160: PR Validator — selective analyzer depth; file-type-aware expensive-analyzer policy, opt-in, default cheap, drift-guarded registry, 9 assertions',
          'Block 161: PR Validator — deploy-preview URL auto-detection; adopts only a live (success) GitHub-Deployment preview, degrades to the configured target, 5 assertions',
          'Block 162: PR Validator — per-route timeout/retry; a hung audit times out and is recorded as a route error (never a false pass), feeding the all-routes-failed guard, 5 assertions',
          'Block 163: PR Validator — GitHub API resilience; one shared resilient client retries rate-limit/5xx/network with capped backoff and never leaks the token in an error, 5 assertions',
          'Block 164: PR Validator — block-decision + guard matrix; block-on × severity exhaustively pinned plus the all-routes-failed guard, base-unavailable fail-safe, and decision→exit-code mapping, 7 assertions',
          'Block 165: PR Validator — CLI↔MCP block-decision parity; both paths build the summary via one shared tally and delegate to one shared gate, so they reach the identical decision for the same findings, 4 assertions',
          'Block 166: PR Validator — recorded GitHub reporting fixtures; proves Argus parses the documented comment/Check-Run response shape, idempotently updates one marker-tagged comment, and never leaks the token, 4 assertions',
          'Block 167: PR Validator — CLI end-to-end; drives the real CLI as a child process (docs-only PR → exit 0; a critical → exit 1), pinning exit codes, GitHub Action outputs, annotations, and the JSON result, 8 assertions',
          'Block 168: Aegis — confidentiality egress boundary; drives the real pipeline plus a live MCP audit against a secret-bearing fixture, proving the redacted projection leaks no JWT/key/email/card and fails closed, 12 assertions',
          'Block 169: Aegis — egress-sink guards; Slack / GitHub / hosted-HTML / CI-log sinks each redact secrets while keeping benign messages, with opt-out non-vacuity controls, 5 assertions',
          '495 Vitest unit tests covering core logic — zero Chrome dependency',
          'All 978 hard assertions pass — zero permanent failures',
        ],
      },
      {
        title: 'Known Limits',
        bullets: [
          'No known MCP- or Chrome-layer restrictions — every previously documented limit was root-caused and fixed in Argus',
          'Lighthouse runs in headless; remaining soft checks (perf traces, GC-dependent heap-growth) are promoted to hard only in the weekly strict-soft lane',
        ],
      },
      {
        title: 'Running',
        code: `npm run test:unit     # 495 Vitest tests — no Chrome required
npm run test:harness  # 978 hard assertions — Chrome required (headless)
# Expected: 978/978 — no permanent failures
# Weekly strict-soft lane promotes ~23 soft checks to hard via ARGUS_HARNESS_STRICT_SOFT`,
      },
    ],
  },
  {
    num: '06',
    title: 'Production Hardening',
    tagline: '50+ fixes across 17 files — the gap between a prototype and something you trust',
    sections: [
      {
        body: 'After the core detection phases were complete, a correctness audit across every source file found gaps that a prototype can ignore but a production tool cannot. Three categories dominated: security vulnerabilities introduced during code generation, silent correctness failures (wrong answer, no error), and robustness holes (race conditions, unhandled edge cases).',
      },
      {
        title: 'Security Fixes',
        bullets: [
          'Code injection in argus init — user-supplied route paths were interpolated directly into generated JS. Fix: JSON.stringify() wraps all user inputs before interpolation',
          'SSRF in the Slack slash-command handler — retest URLs were not validated, allowing internal network probing. Fix: allowlist validation against configured targets only',
          'XSS in html-reporter — javascript: hrefs could execute in the generated HTML dashboard. Fix: safeHref() strips non-http(s) protocols before rendering',
          'Slack mrkdwn injection — attacker-controlled finding messages could inject Slack formatting. Fix: sanitize() escapes <, >, & before Block Kit encoding',
        ],
      },
      {
        title: 'Silent Correctness Failures',
        bullets: [
          'Concurrent env comparison corrupted MCP responses — dev and staging crawls ran in parallel, interleaving CDP events on a shared stdio transport. Fix: sequential execution (dev then staging)',
          'TOCTOU race in memory analyzer — existsSync + readFileSync is not atomic. Fix: async try/catch with ENOENT check',
          'Flakiness detector had O(n²) lookup — findIndex on every finding across two result sets. Fix: O(1) Map-based dedup keyed by finding fingerprint',
          'isNew annotation used !== false instead of === true — any truthy value (including unexpected strings) would pass the gate. Fix: strict equality',
        ],
      },
      {
        title: 'Key Lesson',
        body: 'A tool that silently produces the wrong answer is more dangerous than one that fails loudly. Every silent failure was addressed before v7 shipped — not by adding more tests, but by auditing the assumptions behind each code path.',
      },
    ],
  },
  {
    num: '07',
    title: 'Argus as an MCP Tool',
    tagline: 'The shift from "developer runs QA" to "Claude runs QA" — and what that required',
    sections: [
      {
        body: 'The MCP server turns Argus into a first-class tool that Claude (or any MCP client) can invoke directly from a conversation. No terminal, no config file editing — Claude calls argus_audit the same way it calls any tool. The audit runs, the findings come back structured, and Claude can summarise, filter, or suggest fixes inline.',
      },
      {
        title: 'Nine Exposed Tools',
        bullets: [
          'argus_audit(url) — cheap QA pass: console errors, network failures, SEO, security headers, content issues',
          'argus_audit_full(url) — all analyzers including memory, responsive, hover-state, accessibility tree, keyboard walk',
          'argus_compare() — parallel dev vs staging diff using TARGET_DEV_URL / TARGET_STAGING_URL from environment',
          'argus_last_report() — returns the most recent JSON report from disk; no Chrome required',
          'argus_watch_snapshot() — snapshots the currently open Chrome tab without navigating; accepts tabId for multi-tab workflows',
          'argus_get_context() — LLM-optimized diagnostic context with fix-loop: pass snapshot_id back to get resolved/new_issues/persisting diff',
          'argus_design_audit(url, figmaFrameUrl) — compares live DOM against Figma frame via REST API; 13 mismatch finding types with selector fallback; requires FIGMA_API_TOKEN',
          'argus_visual_diff(url) — pixel-level screenshot baseline comparison via pixelmatch; first call saves baseline, subsequent calls emit visual_regression findings; pass updateBaseline: true to reset after intentional UI changes',
          'argus_pr_validate(prUrl) — fetches the PR diff, maps changed files to affected routes (framework-aware when ARGUS_SOURCE_DIR is set), audits only those routes, and reports through the same shared helper as the CI Action; returns { findings, affectedRoutes, blocked, blockOn, baseline, reporting }; blocks merge only on regressions the PR introduces vs the per-branch baseline',
        ],
      },
      {
        title: 'The URL Parsing Bug',
        body: 'The first implementation used parsed.pathname as the route path. Query strings (?q=test) and SPA hash routes (#/dashboard) were silently dropped. A URL like https://app.com/search?q=checkout#results became https://app.com/search — a completely different page. Fix: concatenate pathname + search + hash. parsed.hash returns empty string for plain URLs, so this is a safe no-op for the common case.',
      },
      {
        title: 'Why This Distribution Matters',
        body: 'Claude Code users do not need to learn a new CLI, write config, or switch context. They add one block to .mcp.json and QA becomes a natural part of their conversation. This is the only QA tool that Claude can call — every developer already using Claude Code is a potential user with zero onboarding friction.',
      },
    ],
  },
  {
    num: '08',
    title: 'Observability',
    tagline: 'OpenTelemetry spans and metrics — knowing which part is slow before users do',
    sections: [
      {
        body: 'At scale, timing data changes everything. Without spans, a slow audit is a black box: is it the memory analyzer? The Slack dispatch? The flakiness double-crawl? With spans, each phase is a named segment in a trace — latency is attributable, not mysterious.',
      },
      {
        title: 'Spans Added',
        bullets: [
          'argus.run_crawl — top-level span wrapping the full runCrawl() execution; attribute: baseUrl',
          'argus.crawl_route — per-route span for cheap_1, cheap_2, and expensive passes; attributes: url, critical, pass',
          'argus.analyzer — per-analyzer span inside the expensive registry loop; attributes: name, url',
          'argus.dispatch — wraps dispatchAll() and sub-spans for Slack, GitHub, and HTML channels; attributes: baseUrl, channel',
          'argus.flow / argus.flow_step — per-flow and per-step spans in the DSL runner; attributes: flow_name, action, selector',
        ],
      },
      {
        title: 'Metrics',
        bullets: [
          'argus.findings (Counter) — increments per finding emitted, tagged by type and severity',
          'argus.flaky_findings (Counter) — increments per flaky finding classified by the double-crawl detector',
          'argus.new_findings (UpDownCounter) — net new findings versus the baseline on this run',
          'argus.analyzer.duration (Histogram) — ms per analyzer execution; identifies expensive outliers',
          'argus.crawl.duration (Histogram) — ms per route crawl; identifies slow pages',
        ],
      },
      {
        title: 'No-Op Default',
        body: 'If OTEL_EXPORTER_OTLP_ENDPOINT is not set, every startSpan() call is a no-op — the SDK never initialises. Self-hosted users get zero overhead and zero broken installs. Set ARGUS_OTEL_CONSOLE=1 in local development to print spans to stdout without a collector.',
      },
    ],
  },
  {
    num: '09',
    title: 'Figma Design Fidelity',
    tagline: 'Closing the design-implementation gap — automatically, on every run',
    sections: [
      {
        body: 'The gap between what a designer specifies in Figma and what actually ships in the browser is one of the most persistent bugs in product development. A color is one shade off. A font-weight is 400 instead of 600. A shadow has the wrong blur. These are real bugs — they erode brand consistency, accessibility contrast ratios, and user trust — but no existing QA tool caught them automatically. Argus now does.',
      },
      {
        title: 'How It Works',
        bullets: [
          'Fetch the Figma frame via REST API (FIGMA_API_TOKEN) — extracts per-node bounds, fill, stroke, typography, spacing, shadow, opacity, and text content',
          'Navigate to the live page in Chrome — settle, wait for network idle',
          'For each Figma node: try selector candidates in order ([data-testid] → [aria-label] → #id → .class)',
          'Run getComputedStyle() on the matched element — compare every extracted property with configurable thresholds',
          'Emit a structured finding per mismatch — type, severity, selector, expected, actual, delta',
        ],
      },
      {
        title: 'The Selector Fallback Problem',
        body: 'Figma layer names rarely match CSS class names in production code. "Button / Primary" in Figma is .btn-primary or [data-testid="submit"] in the DOM. The naive approach — infer a .class from the layer name — misses most real-world elements. The solution: generate four selector candidates per node and try each. Designers can also type explicit selectors directly in layer names (#hero, .card--featured) and Argus uses them verbatim.',
      },
      {
        title: '13 Properties Compared',
        bullets: [
          'Fill and text color — Euclidean RGB distance, 5% tolerance (~22 units of 441 max)',
          'Typography — font-size (1px), font-weight (exact), line-height (1px), font-family (string), letter-spacing (0.5px)',
          'Auto Layout — paddingTop/Right/Bottom/Left (2px each), gap/column-gap/row-gap by layoutMode (2px)',
          'Border-radius — per corner: topLeft, topRight, bottomRight, bottomLeft (1px each)',
          'Box-shadow — offsetX (1px), offsetY (1px), blur (2px), spread (2px), shadow color (RGB distance)',
          'Border stroke — color (RGB) and weight (0.5px)',
          'Opacity — compared when Figma specifies < 100% (10% tolerance)',
          'Position drift — scroll-corrected absolute x/y vs Figma frame-relative bounds (20px threshold)',
          'Bounds overflow — element must not exceed Figma width/height (5px tolerance)',
          'Text content — DOM textContent vs Figma characters string (exact match)',
          'CSS custom property token — value vs Figma token (case-insensitive)',
          'Component presence — Figma-specified selector exists in DOM',
          'Summary — aggregate counts for all 13 types in every audit',
        ],
      },
    ],
  },
  {
    num: '10',
    title: 'PR Validation & Merge Gating',
    tagline: 'Block only on what the pull request introduces — baseline-aware, framework-aware, fail-safe',
    sections: [
      {
        body: 'The PR Validator turns Argus into a merge gate. On a pull request it fetches the diff, maps the changed files to the routes they actually affect, audits only those routes, diffs the findings against a stored per-branch baseline, and blocks the merge only on the regressions the PR itself introduces. It posts the result back onto the PR — a comment and a Check Run — so a reviewer never has to open the Actions tab. Every step is conservative by construction: when anything is ambiguous it widens scope or blocks, never the reverse.',
      },
      {
        title: 'Two Entry Points, One Decision',
        bullets: [
          'CLI (argus-pr-validate) — the headless CI entry point the GitHub Action wraps; audits a routes-file for CI safety and speed',
          'argus_pr_validate MCP tool — the conversational path; audits your targets.js routes for dev convenience',
          'The route source diverges by design, but the block decision is shared: both build the severity tally and delegate to one decidePrBlock gate, so they reach the identical verdict for the same findings',
          'Both report through one shared helper, so the PR comment and Check Run look identical no matter which path produced them',
        ],
      },
      {
        title: 'Baseline-Aware Blocking',
        bullets: [
          'Diffs the PR-head findings against a per-branch baseline (reports/baselines/<base-branch>.json, restored via the actions/cache pattern)',
          'Gates on NEW criticals/warnings only — a pre-existing issue on an affected route no longer blocks every PR that touches that route',
          'Surfaces NEW / PERSISTING / RESOLVED counts in the comment and step summary, reconciled with the block decision',
          'Fail-safe: with no baseline available it blocks on absolute counts and says so in the summary — it never silently passes a broken app',
        ],
      },
      {
        title: 'Framework-Aware Route Mapping',
        bullets: [
          'Opt-in via ARGUS_SOURCE_DIR — a static ES/CJS import graph maps a changed component to only the routes whose page files import it',
          'Next.js convention + tsconfig path aliases; monorepo-aware (re-bases apps/web/… paths into the right package graph, never misattributes a foreign package)',
          'A changed non-global stylesheet narrows to only its importing routes; a global stylesheet stays conservative (all routes)',
          'Only ever NARROWS, and only when every changed file resolves cleanly — any ambiguity falls back to the slug heuristic, so a regression is never mapped away',
        ],
      },
      {
        title: 'Safety Properties',
        bullets: [
          'All-routes-failed guard — if every audited route errors (app unreachable, or every audit timed out) the run exits 1 and blocks; a hung app can never false-pass',
          'Per-route timeout + retry — a timed-out audit is recorded as a route error, never a silent zero-findings pass (ARGUS_ROUTE_TIMEOUT_MS / ARGUS_ROUTE_RETRIES)',
          'Bounded-concurrency auditing — routes can run in parallel (ARGUS_CONCURRENCY) but results stay in route order, so the decision is identical to a sequential run',
          'Deploy-preview auto-detection adopts only a live (success) GitHub-Deployment preview, degrading to the configured target otherwise',
          'One resilient GitHub client retries rate-limit / 5xx / network with capped backoff and scrubs any token before it can reach a log or annotation',
        ],
      },
      {
        title: 'Reporting on the PR',
        bullets: [
          'One idempotent, marker-tagged comment — re-running updates it in place instead of spamming the thread',
          'A GitHub Check Run whose conclusion maps to the block decision (failure iff blocked)',
          'Inline file:line annotations anchored at real added lines from the diff hunks — never a fabricated location',
        ],
      },
    ],
  },
  {
    num: '11',
    title: 'Intelligent Baselines & Noise Filtering',
    tagline: 'Surface the new regression; silence the known and the flaky — without ever hiding a real bug',
    sections: [
      {
        body: 'A QA tool that cries wolf gets muted. Argus post-processes every run so the signal stays high: known issues are remembered, findings that flip on and off across runs are demoted rather than alerted, and each genuinely new finding is linked back to the commits most likely to have caused it. Every post-processor is fail-safe — wrapped in try/catch so a post-processing error can never drop a finding or break a run.',
      },
      {
        title: 'Per-Run Baselines',
        bullets: [
          'Each run is diffed against the stored baseline; only new findings are flagged isNew and trigger alerts',
          'Resolved findings are tracked too, so trend history shows both regressions and fixes over time',
          'Baselines are path-keyed, so a PR-head deploy on a different host (a Vercel/Netlify preview) still diffs correctly',
        ],
      },
      {
        title: 'Cross-Run Noise Classifier',
        bullets: [
          'Tracks the last 20 runs per branch and computes a presence-flip ratio for each finding',
          'A finding that flips on/off across ≥ 4 runs with a flip ratio ≥ 0.4 is tagged noisy with a noiseScore and downgraded to info',
          'Downgraded — never suppressed: the finding is still in the report, just not raised as a regression',
          'Disable with ARGUS_NOISE_FILTER=0',
        ],
      },
      {
        title: 'Root-Cause Linking',
        bullets: [
          'For each NEW finding, scans the last 10 git commits (git log --name-only) and slug-matches changed files to the finding route',
          'Annotates the finding with rootCause: { files, commits } — the suspect files and commits, no API call required',
          'Pure local heuristic; disable with ARGUS_ROOT_CAUSE=0',
        ],
      },
      {
        title: 'Flakiness Detection',
        body: 'Routes can be double-crawled and the two finding sets compared: a finding present in both passes is confirmed, one present in only one is classified flaky. This separates deterministic bugs from timing-sensitive noise before anything reaches your Slack channel or PR comment.',
      },
    ],
  },
]

// ── Shared components ──────────────────────────────────────────────────────────
function Logo() {
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center"
      style={{ border: `2px solid ${ACCENT}` }}
    >
      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: ACCENT }} />
    </div>
  )
}

function BetaBadge() {
  return (
    <span
      style={{
        background: ACCENT,
        color: '#fff',
        fontSize: '0.52rem',
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '0.22rem 0.55rem',
        borderRadius: '2rem',
        lineHeight: 1,
        flexShrink: 0,
        verticalAlign: 'middle',
      }}
    >
      BETA
    </span>
  )
}

function SectionLabel({ children, light }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.3rem 0.875rem',
        borderRadius: '2rem',
        border: light ? '1px solid rgba(94,14,215,0.2)' : '1px solid rgba(255,255,255,0.12)',
        background: light ? 'rgba(94,14,215,0.06)' : 'rgba(255,255,255,0.05)',
        marginBottom: '1.5rem',
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: ACCENT, flexShrink: 0 }} />
      <span
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: light ? ACCENT : 'rgba(255,255,255,0.7)',
        }}
      >
        {children}
      </span>
    </div>
  )
}

// ── Sections ───────────────────────────────────────────────────────────────────

function FeaturesSection() {
  return (
    <section
      id="features"
      style={{ background: '#080808', padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)' }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: 'clamp(3rem, 6vw, 5rem)' }}
        >
          <SectionLabel>Built Different</SectionLabel>
          <h2
            style={{
              fontSize: 'clamp(2rem, 5vw, 4rem)',
              fontWeight: 600,
              color: '#fff',
              lineHeight: 1.08,
              letterSpacing: '-0.02em',
              whiteSpace: 'pre-line',
              margin: 0,
            }}
          >
            {'QA that thinks\nlike a developer.'}
          </h2>
        </motion.div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
            gap: '1.25rem',
          }}
        >
          {features.map((f, i) => {
            const Icon = f.icon
            return (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 28 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ delay: i * 0.06, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(94,14,215,0.1) 100%)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '1.25rem',
                  padding: 'clamp(1.25rem, 2.5vw, 1.875rem)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div
                    style={{
                      width: 40, height: 40, borderRadius: '0.75rem', background: ACCENT,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}
                  >
                    <Icon size={18} color="#fff" />
                  </div>
                  <span
                    style={{
                      fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.16em',
                      textTransform: 'uppercase', color: '#fff', background: ACCENT,
                      padding: '0.22rem 0.55rem', borderRadius: '2rem',
                    }}
                  >
                    {f.tag}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <h3 style={{ margin: 0, fontSize: 'clamp(0.95rem, 1.3vw, 1.1rem)', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em' }}>
                    {f.title}
                  </h3>
                  <p style={{ margin: 0, fontSize: 'clamp(0.8rem, 1vw, 0.875rem)', color: 'rgba(255,255,255,0.48)', lineHeight: 1.65 }}>
                    {f.desc}
                  </p>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function DetectionSection() {
  const [expandedCard, setExpandedCard] = useState(null)

  return (
    <section
      id="detection"
      style={{ background: SURFACE_TINT, padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)' }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: '2rem', marginBottom: 'clamp(3rem, 6vw, 5rem)',
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            style={{ flex: '1 1 280px' }}
          >
            <SectionLabel light>Detection Engine</SectionLabel>
            <h2
              style={{
                fontSize: 'clamp(2rem, 4.5vw, 3.75rem)', fontWeight: 600, color: '#0a0a0a',
                lineHeight: 1.1, letterSpacing: '-0.02em', whiteSpace: 'pre-line', margin: 0,
              }}
            >
              {'67 types.\nZero blind spots.'}
            </h2>
            <p style={{ margin: '1rem 0 0', fontSize: '0.85rem', color: 'rgba(10,10,10,0.45)', lineHeight: 1.6 }}>
              Click any category to see every detection it covers.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ delay: 0.14, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            style={{ display: 'flex', gap: 'clamp(1.5rem, 4vw, 3rem)', alignItems: 'flex-end', flexShrink: 0 }}
          >
            {stats.map((s) => (
              <div key={s.num} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <div style={{ fontSize: 'clamp(1.75rem, 4vw, 3rem)', fontWeight: 600, lineHeight: 1, color: '#0a0a0a' }}>
                  <span style={{ color: ACCENT, fontSize: '0.5em' }}>+</span>{s.num}
                </div>
                <p style={{ margin: 0, fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(10,10,10,0.45)', whiteSpace: 'pre-line', textAlign: 'right', lineHeight: 1.4 }}>
                  {s.label}
                </p>
              </div>
            ))}
          </motion.div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
            gap: '1rem', alignItems: 'start',
          }}
        >
          {detections.map((d, i) => {
            const Icon = d.icon
            const isExpanded = expandedCard === d.title
            return (
              <motion.div
                key={d.title}
                initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ delay: i * 0.07, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                whileHover={{ y: isExpanded ? 0 : -4 }}
                onClick={() => setExpandedCard(isExpanded ? null : d.title)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedCard(isExpanded ? null : d.title) } }}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-label={`${d.title} — ${d.count} detection types. ${isExpanded ? 'Collapse' : 'Expand'}`}
                style={{
                  background: isExpanded ? 'rgba(94,14,215,0.03)' : '#fff',
                  border: isExpanded ? '1px solid rgba(94,14,215,0.3)' : '1px solid rgba(94,14,215,0.1)',
                  borderRadius: '1.25rem',
                  padding: 'clamp(1.25rem, 2.5vw, 1.75rem)',
                  display: 'flex', flexDirection: 'column', gap: '0.875rem',
                  cursor: 'pointer',
                  transition: 'background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
                  boxShadow: isExpanded ? '0 4px 24px rgba(94,14,215,0.1)' : '0 1px 3px rgba(94,14,215,0.06)',
                  outline: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ width: 40, height: 40, borderRadius: '0.75rem', background: ACCENT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={18} color="#fff" />
                  </div>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', color: ACCENT, background: 'rgba(94,14,215,0.08)', padding: '0.2rem 0.55rem', borderRadius: '2rem' }}>
                    {d.count} types
                  </span>
                </div>
                <div>
                  <h3 style={{ margin: '0 0 0.3rem', fontSize: '0.95rem', fontWeight: 600, color: '#0a0a0a', letterSpacing: '-0.01em' }}>
                    {d.title}
                  </h3>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'rgba(10,10,10,0.5)', lineHeight: 1.55 }}>
                    {d.desc}
                  </p>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.22 }}>
                    <ChevronDown size={14} color={ACCENT} />
                  </motion.div>
                </div>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div style={{ borderTop: '1px solid rgba(94,14,215,0.12)', paddingTop: '0.875rem' }}>
                        <ul style={{ margin: 0, padding: '0 0 0 1rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                          {d.details.map((item, di) => (
                            <li key={di} style={{ fontSize: '0.76rem', color: 'rgba(10,10,10,0.62)', lineHeight: 1.5 }}>
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function SetupSection() {
  const [activeMethod, setActiveMethod] = useState('mcp')
  const method = setupMethods.find(m => m.id === activeMethod)

  return (
    <section
      id="setup"
      style={{ background: '#080808', padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)' }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: 'clamp(2.5rem, 5vw, 4rem)' }}
        >
          <SectionLabel>Quick Start</SectionLabel>
          <h2
            style={{
              fontSize: 'clamp(2rem, 5vw, 4rem)', fontWeight: 600, color: '#fff',
              lineHeight: 1.08, letterSpacing: '-0.02em', margin: 0,
            }}
          >
            Up and running in minutes.
          </h2>
        </motion.div>

        {/* Method tabs */}
        <motion.div
          initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ delay: 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '2.5rem' }}
        >
          {setupMethods.map(m => (
            <button
              key={m.id}
              onClick={() => setActiveMethod(m.id)}
              style={{
                padding: '0.625rem 1.25rem',
                borderRadius: '2rem',
                border: activeMethod === m.id ? 'none' : '1px solid rgba(255,255,255,0.12)',
                background: activeMethod === m.id ? ACCENT : 'transparent',
                color: activeMethod === m.id ? '#fff' : 'rgba(255,255,255,0.5)',
                fontWeight: 600, fontSize: '0.8rem', letterSpacing: '0.08em',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem',
                transition: 'all 0.18s ease',
              }}
            >
              {m.label}
              <span
                style={{
                  fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: '0.15rem 0.45rem', borderRadius: '2rem',
                  background: activeMethod === m.id ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)',
                  color: activeMethod === m.id ? '#fff' : 'rgba(255,255,255,0.4)',
                  ...(m.comingSoon ? { background: warning(0.15), color: warning(0.8) } : {}),
                }}
              >
                {m.comingSoon ? 'SOON' : m.badge}
              </span>
            </button>
          ))}
        </motion.div>

        {/* Method content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeMethod}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {method.comingSoon ? (
              /* Coming Soon card */
              <div
                style={{
                  border: '1px solid rgba(255,255,255,0.08)', borderRadius: '1.5rem',
                  padding: 'clamp(2.5rem, 5vw, 4rem)', textAlign: 'center',
                  background: 'rgba(255,255,255,0.02)',
                }}
              >
                <div
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.3rem 0.875rem', borderRadius: '2rem',
                    background: warning(0.1), border: `1px solid ${warning(0.2)}`,
                    marginBottom: '1.5rem',
                  }}
                >
                  <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: warning(0.8) }}>
                    Coming Soon
                  </span>
                </div>
                <h3 style={{ color: '#fff', fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 1rem' }}>
                  Hosted SaaS — no setup required
                </h3>
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '1rem', lineHeight: 1.7, maxWidth: 520, margin: '0 auto 2rem' }}>
                  {method.tagline} We're building a cloud-hosted version where you connect a URL and Argus handles Chrome, scheduling, report storage, and alerts — nothing to install.
                </p>
                <a
                  href="#pricing"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.875rem 2rem', background: ACCENT, color: '#fff',
                    fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.1em',
                    textTransform: 'uppercase', borderRadius: '0.875rem', textDecoration: 'none',
                    transition: 'opacity 0.18s ease',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  See Pricing &amp; Join Waitlist
                  <ArrowUpRight size={16} />
                </a>
              </div>
            ) : (
              <>
                {/* Tagline */}
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.9rem', lineHeight: 1.65, marginBottom: '2rem' }}>
                  {method.tagline}
                </p>

                {/* Prerequisites */}
                {method.prereqs.length > 0 && (
                  <div style={{ marginBottom: '2rem' }}>
                    <p style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', marginBottom: '0.875rem' }}>
                      Prerequisites
                    </p>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                      {method.prereqs.map(p => (
                        <div key={p.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '0.875rem', padding: '0.75rem 1.125rem' }}>
                          <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>{p.label}</p>
                          <p style={{ margin: '0.2rem 0 0', fontSize: '0.75rem', color: 'rgba(255,255,255,0.38)' }}>{p.detail}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Steps */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: 'clamp(2.5rem, 5vw, 4rem)' }}>
                  {method.steps.map((step, i) => (
                    <motion.div
                      key={step.num}
                      initial={{ opacity: 0, x: -24 }} whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ delay: i * 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                      style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '1.25rem', overflow: 'hidden' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', padding: '1rem 1.5rem', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                        <span style={{ fontFamily: 'monospace', color: ACCENT, fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', flexShrink: 0, paddingTop: '0.1rem' }}>
                          {step.num}
                        </span>
                        <div>
                          <p style={{ margin: '0 0 0.2rem', fontSize: '0.92rem', fontWeight: 600, color: 'rgba(255,255,255,0.9)', letterSpacing: '0.01em' }}>
                            {step.title}
                          </p>
                          <p style={{ margin: 0, fontSize: '0.8rem', color: 'rgba(255,255,255,0.38)', lineHeight: 1.55 }}>
                            {step.desc}
                          </p>
                        </div>
                      </div>
                      <div style={{ background: '#0d0d0d', padding: '1.25rem 1.5rem' }}>
                        <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 'clamp(0.75rem, 1.05vw, 0.88rem)', color: 'rgba(255,255,255,0.78)', lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                          {step.code}
                        </pre>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: 'clamp(2rem, 4vw, 3rem)' }}
        >
          <a
            href="#docs"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.875rem 2rem', background: ACCENT, color: '#fff',
              fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.1em',
              textTransform: 'uppercase', borderRadius: '0.875rem', textDecoration: 'none',
              transition: 'opacity 0.18s ease',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Read the Docs
            <ArrowUpRight size={16} />
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.875rem 2rem', background: 'transparent',
              color: 'rgba(255,255,255,0.78)', fontWeight: 700, fontSize: '0.85rem',
              letterSpacing: '0.1em', textTransform: 'uppercase', borderRadius: '0.875rem',
              textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)',
              transition: 'border-color 0.18s ease, color 0.18s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)'; e.currentTarget.style.color = '#fff' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = 'rgba(255,255,255,0.78)' }}
          >
            <Github size={16} />
            View on GitHub
          </a>
        </motion.div>
      </div>
    </section>
  )
}

// ── Enterprise modal ───────────────────────────────────────────────────────────
function EnterpriseModal({ onClose }) {
  const [form, setForm] = useState({
    name: '', email: '', company: '', teamSize: '', region: '', useCase: '', workflow: '', message: '',
  })
  const [focused, setFocused] = useState(null)
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const update = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async () => {
    if (required || loading) return
    setLoading(true)
    setError(null)
    try {
      if (supabase) {
        const { error: sbError } = await supabase.from('enterprise_contacts').insert({
          name: form.name, email: form.email, company: form.company,
          team_size: form.teamSize, region: form.region,
          use_case: form.useCase, workflow: form.workflow, message: form.message,
        })
        if (sbError) throw sbError
      }
      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = (field) => ({
    width: '100%', padding: '0.75rem 1rem',
    background: 'rgba(255,255,255,0.06)',
    border: focused === field ? `1px solid ${ACCENT}` : '1px solid rgba(255,255,255,0.12)',
    borderRadius: '0.75rem', color: '#fff', fontSize: '0.9rem',
    outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.18s ease',
    fontFamily: 'inherit',
  })

  const labelStyle = {
    fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    display: 'block', marginBottom: '0.4rem',
  }

  const required = !form.name || !form.email || !form.company || !form.teamSize || !form.region

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1.25rem', overflowY: 'auto', maxHeight: '100dvh', WebkitOverflowScrolling: 'touch',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 20 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="enterprise-modal-title"
        style={{
          background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '1.5rem', width: '100%', maxWidth: 580,
          padding: 'clamp(1.75rem, 4vw, 2.75rem)',
          position: 'relative', margin: 'auto',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close dialog"
          style={{
            position: 'absolute', top: '1.25rem', right: '1.25rem',
            width: 44, height: 44, borderRadius: '50%',
            background: 'rgba(255,255,255,0.08)', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <X size={14} color="rgba(255,255,255,0.6)" />
        </button>

        {!submitted ? (
          <>
            {/* Header */}
            <div style={{ marginBottom: '2rem' }}>
              <div
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.25rem 0.75rem', borderRadius: '2rem',
                  background: 'rgba(94,14,215,0.12)', border: `1px solid rgba(94,14,215,0.25)`,
                  marginBottom: '1rem',
                }}
              >
                <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: ACCENT }}>
                  Enterprise
                </span>
              </div>
              <h2 id="enterprise-modal-title" style={{ margin: '0 0 0.5rem', fontSize: 'clamp(1.4rem, 3vw, 1.9rem)', fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' }}>
                Contact our team
              </h2>
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'rgba(255,255,255,0.42)', lineHeight: 1.65 }}>
                Tell us about your organisation and we'll follow up within 2 business days.
              </p>
            </div>

            {/* Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
              {/* Row: Name + Email */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '1rem' }}>
                <div>
                  <label style={labelStyle}>Full Name *</label>
                  <input
                    type="text" value={form.name} onChange={update('name')}
                    placeholder="Jane Smith"
                    style={inputStyle('name')}
                    onFocus={() => setFocused('name')} onBlur={() => setFocused(null)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Work Email *</label>
                  <input
                    type="email" value={form.email} onChange={update('email')}
                    placeholder="jane@company.com"
                    style={inputStyle('email')}
                    onFocus={() => setFocused('email')} onBlur={() => setFocused(null)}
                  />
                </div>
              </div>

              {/* Row: Company + Team Size */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '1rem' }}>
                <div>
                  <label style={labelStyle}>Company Name *</label>
                  <input
                    type="text" value={form.company} onChange={update('company')}
                    placeholder="Acme Corp"
                    style={inputStyle('company')}
                    onFocus={() => setFocused('company')} onBlur={() => setFocused(null)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Team Size *</label>
                  <select
                    value={form.teamSize} onChange={update('teamSize')}
                    style={{ ...inputStyle('teamSize'), appearance: 'none' }}
                    onFocus={() => setFocused('teamSize')} onBlur={() => setFocused(null)}
                  >
                    <option value="" style={{ background: '#1a1a1a' }}>Select size</option>
                    <option value="1-10" style={{ background: '#1a1a1a' }}>1–10 people</option>
                    <option value="11-50" style={{ background: '#1a1a1a' }}>11–50 people</option>
                    <option value="51-200" style={{ background: '#1a1a1a' }}>51–200 people</option>
                    <option value="201-1000" style={{ background: '#1a1a1a' }}>201–1,000 people</option>
                    <option value="1000+" style={{ background: '#1a1a1a' }}>1,000+ people</option>
                  </select>
                </div>
              </div>

              {/* Row: Region + Use Case */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '1rem' }}>
                <div>
                  <label style={labelStyle}>Country / Region *</label>
                  <input
                    type="text" value={form.region} onChange={update('region')}
                    placeholder="United States"
                    style={inputStyle('region')}
                    onFocus={() => setFocused('region')} onBlur={() => setFocused(null)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Primary Use Case</label>
                  <select
                    value={form.useCase} onChange={update('useCase')}
                    style={{ ...inputStyle('useCase'), appearance: 'none' }}
                    onFocus={() => setFocused('useCase')} onBlur={() => setFocused(null)}
                  >
                    <option value="" style={{ background: '#1a1a1a' }}>Select use case</option>
                    <option value="qa-automation" style={{ background: '#1a1a1a' }}>QA automation</option>
                    <option value="ci-cd" style={{ background: '#1a1a1a' }}>CI/CD pipeline</option>
                    <option value="compliance" style={{ background: '#1a1a1a' }}>Compliance & auditing</option>
                    <option value="monitoring" style={{ background: '#1a1a1a' }}>Large-scale monitoring</option>
                    <option value="other" style={{ background: '#1a1a1a' }}>Other</option>
                  </select>
                </div>
              </div>

              {/* Current workflow */}
              <div>
                <label style={labelStyle}>Current QA Workflow</label>
                <textarea
                  value={form.workflow} onChange={update('workflow')}
                  placeholder="Briefly describe what you currently use for QA testing..."
                  rows={3}
                  style={{ ...inputStyle('workflow'), resize: 'vertical', minHeight: 80 }}
                  onFocus={() => setFocused('workflow')} onBlur={() => setFocused(null)}
                />
              </div>

              {/* Message */}
              <div>
                <label style={labelStyle}>Additional Context</label>
                <textarea
                  value={form.message} onChange={update('message')}
                  placeholder="Anything else you'd like us to know — deployment requirements, timeline, integrations..."
                  rows={3}
                  style={{ ...inputStyle('message'), resize: 'vertical', minHeight: 80 }}
                  onFocus={() => setFocused('message')} onBlur={() => setFocused(null)}
                />
              </div>

              {/* Submit */}
              <button
                onClick={handleSubmit}
                disabled={required || loading}
                style={{
                  padding: '0.9rem 2rem', background: required ? 'rgba(94,14,215,0.4)' : ACCENT,
                  color: '#fff', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.1em',
                  textTransform: 'uppercase', borderRadius: '0.875rem', border: 'none',
                  cursor: required || loading ? 'not-allowed' : 'pointer',
                  transition: 'opacity 0.18s ease',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                }}
                onMouseEnter={e => { if (!required && !loading) e.currentTarget.style.opacity = '0.88' }}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                {loading ? 'Sending…' : (<>Send Enquiry <ArrowUpRight size={16} /></>)}
              </button>
              {error && (
                <p style={{ margin: 0, fontSize: '0.78rem', color: DANGER, textAlign: 'center' }}>{error}</p>
              )}
              <p style={{ margin: 0, fontSize: '0.72rem', color: 'rgba(255,255,255,0.28)', textAlign: 'center' }}>
                Fields marked * are required. We'll respond within 2 business days.
              </p>
            </div>
          </>
        ) : (
          /* Success state */
          <div style={{ textAlign: 'center', padding: '2rem 0' }}>
            <div
              style={{
                width: 64, height: 64, borderRadius: '50%',
                background: 'rgba(94,14,215,0.12)', border: `1px solid rgba(94,14,215,0.25)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 1.5rem',
              }}
            >
              <CheckCircle size={28} color={ACCENT} />
            </div>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: 'clamp(1.4rem, 3vw, 1.9rem)', fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' }}>
              Enquiry received
            </h2>
            <p style={{ margin: '0 0 2rem', fontSize: '0.95rem', color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
              Thank you, <strong style={{ color: 'rgba(255,255,255,0.8)' }}>{form.name.split(' ')[0]}</strong>.
              Our team will reach out to <strong style={{ color: 'rgba(255,255,255,0.8)' }}>{form.email}</strong> within 2 business days.
            </p>
            <button
              onClick={onClose}
              style={{
                padding: '0.875rem 2rem', background: ACCENT, color: '#fff',
                fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.1em',
                textTransform: 'uppercase', borderRadius: '0.875rem', border: 'none',
                cursor: 'pointer', transition: 'opacity 0.18s ease',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              Close
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

// ── Waitlist modal ─────────────────────────────────────────────────────────────
function WaitlistModal({ planName, onClose }) {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const isValidEmail = EMAIL_RE.test(email)

  const handleSubmit = async () => {
    if (!isValidEmail || loading) return
    setLoading(true)
    setError(null)
    try {
      if (supabase) {
        const { error: sbError } = await supabase
          .from('waitlist')
          .insert({ email, plan: planName })
        if (sbError) {
          if (sbError.code === '23505') {
            setSubmitted(true)
            return
          }
          throw sbError
        }
      }
      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
        zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.25rem',
        overflowY: 'auto', maxHeight: '100dvh', WebkitOverflowScrolling: 'touch',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 16 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-modal-title"
        style={{
          background: '#fff', borderRadius: '1.5rem', padding: '2.5rem',
          maxWidth: 420, width: '100%', position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close dialog"
          style={{
            position: 'absolute', top: '1.25rem', right: '1.25rem',
            width: 44, height: 44, borderRadius: '50%',
            background: 'rgba(0,0,0,0.06)', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}
        >
          <X size={13} color="rgba(0,0,0,0.5)" />
        </button>

        {!submitted ? (
          <>
            <div style={{ marginBottom: '1.5rem' }}>
              <span
                style={{
                  display: 'inline-block', background: ACCENT, color: '#fff',
                  fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.14em',
                  textTransform: 'uppercase', padding: '0.22rem 0.6rem', borderRadius: '2rem',
                  marginBottom: '1rem',
                }}
              >
                {planName}
              </span>
              <h3 id="waitlist-modal-title" style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#0a0a0a', letterSpacing: '-0.02em' }}>
                Join the waitlist
              </h3>
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'rgba(10,10,10,0.5)', lineHeight: 1.6 }}>
                Be the first to know when {planName} launches. No spam, one email when it's ready.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label
                  htmlFor="waitlist-email"
                  style={{
                    display: 'block', marginBottom: '0.4rem',
                    fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.12em',
                    textTransform: 'uppercase', color: 'rgba(10,10,10,0.45)',
                  }}
                >
                  Email address
                </label>
                <input
                  id="waitlist-email"
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  style={{
                    width: '100%', padding: '0.8rem 1rem',
                    background: 'rgba(0,0,0,0.04)',
                    border: focused ? `1.5px solid ${ACCENT}` : '1.5px solid rgba(0,0,0,0.1)',
                    borderRadius: '0.75rem', color: '#0a0a0a', fontSize: '0.9rem',
                    outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.18s ease',
                    fontFamily: 'inherit',
                  }}
                  onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                />
              </div>
              <button
                onClick={handleSubmit}
                disabled={!isValidEmail || loading}
                style={{
                  padding: '0.85rem 2rem', background: isValidEmail ? ACCENT : 'rgba(94,14,215,0.35)',
                  color: '#fff', fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.1em',
                  textTransform: 'uppercase', borderRadius: '0.75rem', border: 'none',
                  cursor: isValidEmail && !loading ? 'pointer' : 'not-allowed', transition: 'opacity 0.18s ease',
                }}
                onMouseEnter={e => { if (isValidEmail && !loading) e.currentTarget.style.opacity = '0.88' }}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                {loading ? 'Saving…' : 'Notify Me'}
              </button>
              {error && (
                <p style={{ margin: 0, fontSize: '0.78rem', color: DANGER, textAlign: 'center' }}>{error}</p>
              )}
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <CheckCircle size={40} color={ACCENT} style={{ margin: '0 auto 1.25rem', display: 'block' }} />
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#0a0a0a', letterSpacing: '-0.02em' }}>
              You're on the list!
            </h3>
            <p style={{ margin: '0 0 1.75rem', fontSize: '0.875rem', color: 'rgba(10,10,10,0.5)', lineHeight: 1.6 }}>
              We'll email <strong>{email}</strong> when {planName} launches.
            </p>
            <button
              onClick={onClose}
              style={{
                padding: '0.8rem 2rem', background: ACCENT, color: '#fff',
                fontWeight: 700, fontSize: '0.85rem', letterSpacing: '0.1em',
                textTransform: 'uppercase', borderRadius: '0.75rem', border: 'none',
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

// ── Comparison table ───────────────────────────────────────────────────────────
function ComparisonTable() {
  const [expanded, setExpanded] = useState(false)
  const cols = ['Open Source', 'Pro', 'Enterprise']
  const colKeys = ['open', 'pro', 'enterprise']

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ delay: 0.4, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      style={{ marginTop: 'clamp(2.5rem, 5vw, 3.5rem)' }}
    >
      {/* Toggle button */}
      <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.625rem 1.5rem',
            background: 'transparent', border: '1px solid rgba(10,10,10,0.12)',
            borderRadius: '2rem', cursor: 'pointer',
            color: 'rgba(10,10,10,0.55)', fontWeight: 600, fontSize: '0.78rem',
            letterSpacing: '0.1em', textTransform: 'uppercase',
            transition: 'all 0.18s ease', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = ACCENT; e.currentTarget.style.color = ACCENT }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(10,10,10,0.12)'; e.currentTarget.style.color = 'rgba(10,10,10,0.55)' }}
        >
          {expanded ? 'Hide' : 'Compare'} all features
          <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.22 }}>
            <ChevronDown size={14} />
          </motion.div>
        </button>
      </div>

      {/* Expandable table */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div
              style={{
                overflowX: 'auto',
                borderRadius: '1.25rem',
                border: '1px solid rgba(0,0,0,0.08)',
                background: '#fff',
                boxShadow: '0 2px 16px rgba(0,0,0,0.04)',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 540 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
                    <th
                      style={{
                        padding: '1rem 1.5rem', textAlign: 'left',
                        fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.16em',
                        textTransform: 'uppercase', color: 'rgba(10,10,10,0.32)',
                        width: '38%',
                      }}
                    >
                      Feature
                    </th>
                    {cols.map((col) => (
                      <th
                        key={col}
                        style={{
                          padding: '1rem 0.875rem', textAlign: 'center',
                          fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.14em',
                          textTransform: 'uppercase',
                          color: col === 'Pro' ? ACCENT : col === 'Team' ? ACCENT : 'rgba(10,10,10,0.42)',
                          background: col === 'Pro' ? 'rgba(94,14,215,0.04)' : col === 'Enterprise' ? 'rgba(8,8,8,0.025)' : 'transparent',
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON_ROWS.map((row, ri) => (
                    <tr
                      key={row.feature}
                      style={{
                        borderBottom: ri < COMPARISON_ROWS.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
                        background: ri % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.012)',
                      }}
                    >
                      <td
                        style={{
                          padding: '0.875rem 1.5rem',
                          fontSize: '0.84rem', color: 'rgba(10,10,10,0.68)', lineHeight: 1.45,
                        }}
                      >
                        {row.feature}
                      </td>
                      {colKeys.map((key) => (
                        <td
                          key={key}
                          style={{
                            padding: '0.875rem 0.875rem', textAlign: 'center',
                            background: key === 'pro' ? 'rgba(94,14,215,0.025)' : key === 'enterprise' ? 'rgba(8,8,8,0.015)' : 'transparent',
                          }}
                        >
                          {row[key] ? (
                            <CheckCircle
                              size={15}
                              color={
                                key === 'pro' ? ACCENT
                                : key === 'team' ? ACCENT
                                : key === 'enterprise' ? 'rgba(10,10,10,0.5)'
                                : 'rgba(10,10,10,0.35)'
                              }
                              style={{ display: 'inline-block' }}
                            />
                          ) : (
                            <span
                              style={{
                                display: 'inline-block',
                                width: 14, height: 2,
                                background: 'rgba(0,0,0,0.1)',
                                borderRadius: 1, verticalAlign: 'middle',
                              }}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── Pricing section ────────────────────────────────────────────────────────────
// ── Festive / seasonal offer campaigns ───────────────────────────────────────────
// Add a campaign here; the banner auto-shows while "today" is inside [from, to] (inclusive)
// COMPUTED IN THE CAMPAIGN'S HOME TIMEZONE (`tz`) — so Independence Day flips on at exactly
// 00:00 IST on Aug 15 for every visitor worldwide, Canada Day at 00:00 Toronto time, etc.
// The banner only DISPLAYS the code: enforcement is the matching Stripe promotion code,
// which must be created with the same redemption window (see HOSTED_BACKEND.md §8.5).
const FESTIVE_OFFERS = [
  { id: 'canada-day-2026',       emoji: '🍁', name: 'Canada Day',       tz: 'America/Toronto', from: '2026-06-29', to: '2026-07-05', headline: 'Canada Day offer — 25% off Pro',      sub: 'Founding price + an extra 25% off your first 3 months.', code: 'CANADA25' },
  { id: 'good-friday-2026',      emoji: '✝️', name: 'Good Friday',      tz: 'UTC',             from: '2026-04-03', to: '2026-04-06', headline: 'Good Friday sale — 20% off Pro',       sub: 'Limited-time founding discount.',                        code: 'GOODFRIDAY20' },
  { id: 'independence-day-2026', emoji: '🇮🇳', name: 'Independence Day', tz: 'Asia/Kolkata',    from: '2026-08-15', to: '2026-08-17', headline: 'Independence Day — 30% off Pro',       sub: 'Freedom from manual QA — founding discount on your first 3 months.', code: 'INDIA30' },
  { id: 'diwali-2026',           emoji: '🪔', name: 'Diwali Special',   tz: 'Asia/Kolkata',    from: '2026-11-06', to: '2026-11-12', headline: 'Diwali special — 30% off Pro',         sub: 'Light up your QA — festive founding discount.',          code: 'DIWALI30' },
]
// YYYY-MM-DD for "now" in a given IANA timezone ('en-CA' locale formats exactly that way).
function dateInTz(tz, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10) // unknown tz → UTC fallback
  }
}
function activeFestiveOffer(now = new Date()) {
  return FESTIVE_OFFERS.find(o => {
    const d = dateInTz(o.tz || 'UTC', now)
    return d >= o.from && d <= o.to
  }) || null
}
function FestiveBanner() {
  // Re-check once a minute so a tab left open flips the banner at the campaign's midnight
  // (and hides it when the window closes) without a reload.
  const [offer, setOffer] = useState(() => activeFestiveOffer())
  useEffect(() => {
    const t = setInterval(() => {
      setOffer(prev => {
        const next = activeFestiveOffer()
        return next?.id === prev?.id ? prev : next
      })
    }, 60_000)
    return () => clearInterval(t)
  }, [])
  const [dismissed, setDismissed] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(offer.code)
    } catch {
      // http/older-browser fallback
      const ta = document.createElement('textarea')
      ta.value = offer.code
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  if (!offer || dismissed) return null
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      style={{
        position: 'relative', margin: '0 auto clamp(2.25rem, 5vw, 3.5rem)', maxWidth: 940,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.7rem 0.9rem', flexWrap: 'wrap',
        padding: '0.9rem 2.8rem', borderRadius: '1rem', textAlign: 'center',
        background: 'linear-gradient(135deg, #5E0ED7 0%, #3A088A 100%)', color: '#fff',
        boxShadow: `0 14px 44px ${accent(0.35)}`,
      }}
    >
      <span style={{ fontSize: '1.35rem', lineHeight: 1 }}>{offer.emoji}</span>
      <span style={{ fontWeight: 800, fontSize: '0.95rem' }}>{offer.headline}</span>
      <span style={{ opacity: 0.85, fontSize: '0.85rem' }}>{offer.sub}</span>
      {offer.code && (
        <button
          onClick={copyCode}
          title="Click to copy"
          aria-label={copied ? 'Code copied' : `Copy code ${offer.code}`}
          style={{
            padding: '0.18rem 0.6rem', borderRadius: 7, fontWeight: 700, fontSize: '0.8rem', letterSpacing: '0.04em',
            background: copied ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.2)',
            border: '1px dashed rgba(255,255,255,0.45)', color: '#fff', cursor: 'pointer',
            transition: 'background 0.15s', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'rgba(255,255,255,0.28)' }}
          onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'rgba(255,255,255,0.2)' }}
        >
          {copied ? '✓ Copied!' : <>code: {offer.code} ⧉</>}
        </button>
      )}
      <button onClick={() => setDismissed(true)} aria-label="Dismiss offer"
        style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: '1.15rem', lineHeight: 1, padding: 0 }}>
        ×
      </button>
    </motion.div>
  )
}

// ── Pricing section ──────────────────────────────────────────────────────────────
function PricingSection({ onBuy }) {
  const [enterpriseOpen, setEnterpriseOpen] = useState(false)
  const [waitlistPlan, setWaitlistPlan] = useState(null)

  const handleCta = (plan) => {
    const checkoutUrl = STRIPE_LINKS[plan.id]
    if (checkoutUrl) { onBuy(plan, checkoutUrl); return }   // → signup/login popup, then Stripe
    if (plan.ctaAction === 'enterprise') setEnterpriseOpen(true)
    else if (plan.ctaAction === 'waitlist') setWaitlistPlan(plan)
  }

  return (
    <section
      id="pricing"
      style={{ background: '#FAFAFA', padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)' }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <FestiveBanner />
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: 'clamp(3rem, 6vw, 5rem)', textAlign: 'center' }}
        >
          <SectionLabel light>Pricing</SectionLabel>
          <h2
            style={{
              fontSize: 'clamp(2rem, 5vw, 4rem)', fontWeight: 600, color: '#0a0a0a',
              lineHeight: 1.08, letterSpacing: '-0.02em', margin: '0 0 1rem',
            }}
          >
            Simple, transparent pricing.
          </h2>
          <p style={{ margin: 0, fontSize: 'clamp(0.9rem, 1.3vw, 1.05rem)', color: 'rgba(10,10,10,0.45)', lineHeight: 1.7 }}>
            Start free. Scale when you're ready. The core is open source forever.
          </p>
        </motion.div>

        {/* Cards grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
            gap: '1.25rem', alignItems: 'stretch',
          }}
        >
          {pricingPlans.map((plan, i) => {
            const founding = STRIPE_LINKS[plan.id] && plan.founding ? plan.founding : null
            return (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 28 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ delay: i * 0.1, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              style={{
                background: plan.dark ? '#080808' : plan.popular ? `linear-gradient(145deg, ${SURFACE_TINT} 0%, ${accent(0.06)} 100%)` : '#fff',
                border: plan.popular
                  ? `1.5px solid rgba(94,14,215,0.35)`
                  : plan.dark
                    ? '1px solid rgba(255,255,255,0.1)'
                    : '1px solid rgba(0,0,0,0.07)',
                borderRadius: '1.5rem',
                padding: 'clamp(1.5rem, 3vw, 2rem)',
                display: 'flex', flexDirection: 'column', gap: '1.5rem',
                boxShadow: plan.popular ? '0 8px 40px rgba(94,14,215,0.12)' : '0 2px 8px rgba(0,0,0,0.04)',
              }}
            >
              {/* Plan header */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                  <span
                    style={{
                      fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
                      padding: '0.22rem 0.6rem', borderRadius: '2rem',
                      background: plan.id === 'enterprise' ? 'linear-gradient(135deg, #F7D774, #D4A017)' : plan.popular ? ACCENT : plan.dark ? 'rgba(255,255,255,0.1)' : 'rgba(94,14,215,0.08)',
                      color: plan.id === 'enterprise' ? '#000' : plan.popular ? '#fff' : plan.dark ? 'rgba(255,255,255,0.55)' : ACCENT,
                    }}
                  >
                    {plan.tag}
                  </span>
                  {founding ? (
                    <span
                      style={{
                        fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: '#0a7d3c',
                        background: success(0.22), padding: '0.2rem 0.5rem', borderRadius: '2rem',
                      }}
                    >
                      {founding.tag}
                    </span>
                  ) : plan.comingSoon && (
                    <span
                      style={{
                        fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: warning(0.8),
                        background: warning(0.1), padding: '0.2rem 0.5rem', borderRadius: '2rem',
                      }}
                    >
                      Coming Soon
                    </span>
                  )}
                </div>

                <h3
                  style={{
                    margin: '0 0 0.375rem', fontSize: '1.15rem', fontWeight: 600,
                    color: plan.dark ? '#fff' : '#0a0a0a', letterSpacing: '-0.01em',
                  }}
                >
                  {plan.name}
                </h3>
                <p style={{ margin: '0 0 1rem', fontSize: '0.82rem', color: plan.dark ? 'rgba(255,255,255,0.42)' : 'rgba(10,10,10,0.5)', lineHeight: 1.55 }}>
                  {plan.description}
                </p>

                {/* Price */}
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', flexWrap: 'wrap' }}>
                  {founding && (
                    <span style={{ fontSize: '1.15rem', fontWeight: 600, color: 'rgba(10,10,10,0.35)', textDecoration: 'line-through', marginRight: '0.1rem' }}>
                      {founding.origPrice}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: plan.price === 'Custom' ? '1.75rem' : 'clamp(2rem, 5vw, 2.75rem)',
                      fontWeight: 700, color: plan.dark ? '#fff' : '#0a0a0a', lineHeight: 1,
                      letterSpacing: '-0.03em',
                    }}
                  >
                    {founding ? founding.price : plan.price}
                  </span>
                  {(founding ? founding.period : plan.period) && (
                    <span style={{ fontSize: '0.85rem', color: plan.dark ? 'rgba(255,255,255,0.38)' : 'rgba(10,10,10,0.4)', fontWeight: 500 }}>
                      {founding ? founding.period : plan.period}
                    </span>
                  )}
                </div>
                {founding && (
                  <p style={{ margin: '0.7rem 0 0', fontSize: '0.72rem', lineHeight: 1.5, color: '#0a7d3c', fontWeight: 500 }}>
                    {founding.note}
                  </p>
                )}
              </div>

              {/* Benefits */}
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                {plan.benefits.map((b, bi) => (
                  <li key={bi} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem' }}>
                    <CheckCircle
                      size={14}
                      color={plan.popular ? ACCENT : plan.dark ? 'rgba(255,255,255,0.5)' : 'rgba(94,14,215,0.55)'}
                      style={{ flexShrink: 0, marginTop: '0.15rem' }}
                    />
                    <span style={{ fontSize: '0.83rem', color: plan.dark ? 'rgba(255,255,255,0.62)' : 'rgba(10,10,10,0.65)', lineHeight: 1.5 }}>
                      {b}
                    </span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <div style={{ marginTop: 'auto' }}>
                {plan.ctaHref ? (
                  <a
                    href={plan.ctaHref}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                      padding: '0.85rem 1.5rem', borderRadius: '0.875rem', textDecoration: 'none',
                      background: 'transparent', border: `1.5px solid rgba(94,14,215,0.25)`,
                      color: ACCENT, fontWeight: 700, fontSize: '0.82rem', letterSpacing: '0.08em',
                      textTransform: 'uppercase', transition: 'all 0.18s ease',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = ACCENT; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = ACCENT }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = ACCENT; e.currentTarget.style.borderColor = 'rgba(94,14,215,0.25)' }}
                  >
                    {plan.cta} <ArrowUpRight size={14} />
                  </a>
                ) : (
                  <button
                    onClick={() => handleCta(plan)}
                    style={{
                      width: '100%', padding: '0.85rem 1.5rem', borderRadius: '0.875rem',
                      background: plan.popular ? ACCENT : plan.dark ? 'rgba(255,255,255,0.1)' : 'transparent',
                      border: plan.popular ? 'none' : plan.dark ? '1px solid rgba(255,255,255,0.15)' : `1.5px solid rgba(94,14,215,0.25)`,
                      color: plan.popular ? '#fff' : plan.dark ? '#fff' : ACCENT,
                      fontWeight: 700, fontSize: '0.82rem', letterSpacing: '0.08em',
                      textTransform: 'uppercase', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                      transition: 'all 0.18s ease',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = '0.82')}
                    onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                  >
                    {founding ? founding.cta : plan.cta} <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
            </motion.div>
            )
          })}
        </div>

        {/* Referral → team discount (replaces the standalone Team plan) */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{
            marginTop: 'clamp(2rem, 4vw, 3rem)', display: 'flex', flexWrap: 'wrap', gap: '1rem 1.5rem',
            alignItems: 'center', justifyContent: 'space-between',
            padding: 'clamp(1.25rem, 3vw, 1.75rem) clamp(1.5rem, 4vw, 2.25rem)', borderRadius: '1.25rem',
            background: `linear-gradient(135deg, ${accent(0.06)} 0%, ${success(0.12)} 100%)`,
            border: `1px solid ${accent(0.18)}`,
          }}
        >
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: '1.15rem' }}>🎁</span>
              <span style={{ fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: ACCENT }}>Build a team, the smart way</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.95rem', color: 'rgba(10,10,10,0.7)', lineHeight: 1.6 }}>
              No separate Team plan — <strong style={{ color: '#0a0a0a', fontWeight: 700 }}>refer teammates and form a team to unlock group discounts</strong>. Everyone gets Pro’s hosted dashboard, shared baselines, and trend alerts; the more you bring, the more you save.
            </p>
          </div>
          <button
            onClick={() => setWaitlistPlan({ name: 'Referral rewards' })}
            style={{
              flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.8rem 1.6rem', borderRadius: '0.875rem', border: 'none', cursor: 'pointer',
              background: ACCENT, color: '#fff', fontWeight: 700, fontSize: '0.8rem',
              letterSpacing: '0.06em', textTransform: 'uppercase', transition: 'opacity 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            Get referral perks <ArrowUpRight size={14} />
          </button>
        </motion.div>

        {/* Feature comparison table */}
        <ComparisonTable />

        {/* Footer note */}
        <motion.p
          initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ delay: 0.4, duration: 0.5 }}
          style={{ margin: 'clamp(2rem, 4vw, 3rem) auto 0', textAlign: 'center', fontSize: '0.8rem', color: 'rgba(10,10,10,0.35)', maxWidth: 480, lineHeight: 1.65 }}
        >
          The Open Source tier is free forever. Pro pricing is indicative and subject to change before launch.
          Enterprise pricing is fully custom and negotiated directly.
        </motion.p>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {enterpriseOpen && <EnterpriseModal onClose={() => setEnterpriseOpen(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {waitlistPlan && <WaitlistModal planName={waitlistPlan.name} onClose={() => setWaitlistPlan(null)} />}
      </AnimatePresence>
    </section>
  )
}

// ── Docs section ───────────────────────────────────────────────────────────────
function renderDocSection(section, idx) {
  return (
    <div key={idx} style={{ marginTop: idx > 0 ? '1.375rem' : 0 }}>
      {section.title && (
        <p style={{ margin: '0 0 0.625rem', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: ACCENT }}>
          {section.title}
        </p>
      )}
      {section.body && (
        <p style={{ margin: 0, fontSize: '0.9rem', color: 'rgba(255,255,255,0.52)', lineHeight: 1.8 }}>
          {section.body}
        </p>
      )}
      {section.bullets && (
        <ul style={{ margin: 0, padding: '0 0 0 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          {section.bullets.map((bullet, bi) => (
            <li key={bi} style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.52)', lineHeight: 1.65 }}>
              {bullet}
            </li>
          ))}
        </ul>
      )}
      {section.code && (
        <pre style={{ margin: 0, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem', padding: '1rem 1.25rem', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: '0.82rem', color: 'rgba(255,255,255,0.72)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {section.code}
        </pre>
      )}
    </div>
  )
}

function DocsSection() {
  const [openChapter, setOpenChapter] = useState(null)

  return (
    <section
      id="docs"
      style={{ background: '#0D1117', padding: 'clamp(5rem, 10vw, 9rem) clamp(1.25rem, 6vw, 5rem)' }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: 'clamp(3rem, 6vw, 5rem)' }}
        >
          <SectionLabel>Technical Journey</SectionLabel>
          <h2 style={{ fontSize: 'clamp(2rem, 5vw, 4rem)', fontWeight: 600, color: '#fff', lineHeight: 1.08, letterSpacing: '-0.02em', margin: '0 0 1rem' }}>
            How we built it.
          </h2>
          <p style={{ margin: 0, maxWidth: 520, fontSize: 'clamp(0.9rem, 1.3vw, 1.05rem)', color: 'rgba(255,255,255,0.38)', lineHeight: 1.7 }}>
            From a single file to 166 test blocks — the engineering decisions, discoveries, and challenges behind Argus.
          </p>
        </motion.div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {docChapters.map((chapter, i) => {
            const isOpen = openChapter === chapter.num
            return (
              <motion.div
                key={chapter.num}
                initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ delay: i * 0.07, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  border: isOpen ? '1px solid rgba(94,14,215,0.35)' : '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '1.25rem', overflow: 'hidden',
                  background: isOpen ? 'rgba(94,14,215,0.05)' : 'rgba(255,255,255,0.02)',
                  transition: 'background 0.25s ease, border-color 0.25s ease',
                }}
              >
                <button
                  onClick={() => setOpenChapter(isOpen ? null : chapter.num)}
                  style={{
                    width: '100%', padding: 'clamp(1rem, 2.5vw, 1.5rem) clamp(1.25rem, 3vw, 2rem)',
                    display: 'flex', alignItems: 'center', gap: 'clamp(1rem, 2vw, 1.75rem)',
                    background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: ACCENT, fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.1em', flexShrink: 0, opacity: isOpen ? 1 : 0.7 }}>
                    {chapter.num}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ margin: '0 0 0.2rem', fontSize: 'clamp(0.95rem, 1.4vw, 1.15rem)', fontWeight: 600, color: isOpen ? '#fff' : 'rgba(255,255,255,0.82)', letterSpacing: '-0.01em' }}>
                      {chapter.title}
                    </h3>
                    <p style={{ margin: 0, fontSize: 'clamp(0.78rem, 1vw, 0.85rem)', color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>
                      {chapter.tagline}
                    </p>
                  </div>
                  <motion.div animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} style={{ flexShrink: 0 }}>
                    <ChevronRight size={18} color="rgba(255,255,255,0.3)" />
                  </motion.div>
                </button>

                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div style={{ padding: 'clamp(1.25rem, 3vw, 2rem) clamp(1.25rem, 3vw, 2rem) clamp(1.5rem, 3vw, 2.5rem)', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: 0 }}>
                        {chapter.sections.map((section, si) => renderDocSection(section, si))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// ── Ecosystem / Listed-On section ─────────────────────────────────────────────
const ecosystemLinks = [
  {
    name: 'GitHub',
    sub: 'Source Code',
    url: GITHUB_URL,
    tag: 'OPEN SOURCE',
  },
  {
    name: 'Glama MCP',
    sub: 'MCP Registry',
    url: GLAMA_URL,
    tag: 'FEATURED',
  },
  {
    name: 'PR Validator',
    sub: 'GitHub Actions',
    url: 'https://github.com/marketplace/actions/argus-pr-validator',
    tag: 'CI/CD',
  },
  {
    name: 'Pulse MCP',
    sub: 'MCP Directory',
    url: 'https://www.pulsemcp.com/servers/ironclawdevs27-argus',
    tag: 'DIRECTORY',
  },
  {
    name: 'mcp.so',
    sub: 'MCP Directory',
    url: 'https://mcp.so/server/argus-qa/ironclawdevs27',
    tag: 'DIRECTORY',
  },
  {
    name: 'mcpservers.org',
    sub: 'MCP Registry',
    url: 'https://mcpservers.org/servers/ironclawdevs27/argus',
    tag: 'DIRECTORY',
  },
  {
    name: 'MCP Registry',
    sub: 'Official Registry',
    url: 'https://registry.modelcontextprotocol.io/?q=argus',
    tag: 'OFFICIAL',
  },
]

function ListedOnSection() {
  return (
    <section
      id="ecosystem"
      style={{
        background: '#040404',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        padding: 'clamp(3.5rem, 7vw, 6rem) clamp(1.25rem, 6vw, 5rem)',
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ marginBottom: 'clamp(2.5rem, 5vw, 4rem)', textAlign: 'center' }}
        >
          <p style={{
            margin: '0 0 0.75rem',
            fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.2em',
            textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)',
          }}>
            Find Argus On
          </p>
          <h2 style={{
            margin: 0,
            fontSize: 'clamp(1.6rem, 4vw, 2.8rem)', fontWeight: 600,
            color: '#fff', lineHeight: 1.1, letterSpacing: '-0.02em',
          }}>
            The MCP Ecosystem
          </h2>
        </motion.div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 148px), 1fr))',
          gap: '0.875rem',
        }}>
          {ecosystemLinks.map((link, i) => (
            <motion.a
              key={link.name}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: i * 0.07, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                padding: 'clamp(1rem, 2vw, 1.25rem)',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '1rem',
                textDecoration: 'none',
                transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
                cursor: 'pointer',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(94,14,215,0.1)'
                e.currentTarget.style.borderColor = 'rgba(94,14,215,0.35)'
                e.currentTarget.style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <span style={{
                display: 'inline-block',
                fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: ACCENT,
                background: 'rgba(94,14,215,0.12)',
                padding: '0.18rem 0.5rem',
                borderRadius: '2rem',
                alignSelf: 'flex-start',
              }}>
                {link.tag}
              </span>
              <div>
                <p style={{ margin: 0, fontSize: '0.92rem', fontWeight: 600, color: '#fff', letterSpacing: '-0.01em', lineHeight: 1.3 }}>
                  {link.name}
                </p>
                <p style={{ margin: '0.2rem 0 0', fontSize: '0.72rem', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.04em' }}>
                  {link.sub}
                </p>
              </div>
              <ArrowUpRight size={14} color="rgba(255,255,255,0.2)" style={{ alignSelf: 'flex-end', marginTop: 'auto' }} />
            </motion.a>
          ))}
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer
      style={{ background: '#040404', borderTop: '1px solid rgba(255,255,255,0.06)', padding: 'clamp(2.5rem, 5vw, 4rem) clamp(1.25rem, 6vw, 5rem)' }}
    >
      <div
        style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '2rem' }}
      >
        {/* Left — logos + tagline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <Logo />
            <span style={{ fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#fff', fontSize: 15 }}>
              Argus
            </span>
            <BetaBadge />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <img
              src="/IRONCLAW.png"
              alt="Ironclaw"
              style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: '1.5px solid rgba(255,255,255,0.4)', boxShadow: `0 0 8px ${success(0.25)}`, flexShrink: 0 }}
            />
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.32)', letterSpacing: '0.04em' }}>
              Built by{' '}
              <a
                href="https://github.com/ironclawdevs27"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'rgba(255,255,255,0.52)', textDecoration: 'none',
                  borderBottom: '1px solid rgba(255,255,255,0.18)',
                  paddingBottom: '0.05rem', transition: 'color 0.18s ease, border-color 0.18s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.5)' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.52)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)' }}
              >
                ironclawdevs
              </a>
            </p>
          </div>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.04em' }}>
            Every Bug Caught. Open source forever.
          </p>
        </div>

        {/* Center — nav links */}
        <nav style={{ display: 'flex', gap: 'clamp(1rem, 3vw, 2.5rem)', flexWrap: 'wrap' }}>
          {navLinks.map((link) => (
            <a
              key={link}
              href={navHrefs[link]}
              style={{ fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.38)', textDecoration: 'none', transition: 'color 0.18s ease' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.78)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.38)')}
            >
              {link}
            </a>
          ))}
        </nav>

        {/* Right — copyright */}
        <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.24)', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
          © 2026 Argus
        </p>
      </div>
    </footer>
  )
}

// Thank-you toast shown when a Stripe Payment Link redirects back to ?checkout=success.
// (In Stripe, set the Payment Link's "after payment" redirect to https://argus-qa.com/?checkout=success.)
function CheckoutSuccessToast() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') !== 'success') return
    setShow(true)
    const url = new URL(window.location.href)
    url.searchParams.delete('checkout')
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    const t = setTimeout(() => setShow(false), 9000)
    return () => clearTimeout(t)
  }, [])
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          role="status"
          style={{
            position: 'fixed', bottom: 'clamp(16px, 4vw, 32px)', left: '50%', transform: 'translateX(-50%)',
            zIndex: 70, maxWidth: 'calc(100vw - 32px)',
            display: 'flex', alignItems: 'center', gap: '0.75rem',
            padding: '0.9rem 1.1rem', borderRadius: '1rem',
            background: '#0a0a0a', color: '#fff', boxShadow: '0 16px 50px rgba(0,0,0,0.4)',
            border: `1px solid ${accent(0.4)}`,
          }}
        >
          <span style={{ fontSize: '1.1rem' }}>🎉</span>
          <span style={{ fontSize: '0.86rem', fontWeight: 500, lineHeight: 1.45 }}>
            You're a <strong style={{ fontWeight: 700 }}>Founding Member</strong> — welcome aboard. Check your email for next steps.
          </span>
          <button
            onClick={() => setShow(false)}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, padding: 0, flexShrink: 0 }}
          >×</button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── Root ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hoveredLink, setHoveredLink] = useState(null)
  const [slideIndex, setSlideIndex] = useState(0)
  const [showScroll, setShowScroll] = useState(false)
  const [gsHovered, setGsHovered] = useState(false)
  const npm = useNpmDownloads()

  // Auth (Supabase) + the auth-modal context for the signup-first checkout flow.
  const [authUser, setAuthUser] = useState(null)
  const [authCtx, setAuthCtx] = useState(null)   // { mode, intent, checkoutUrl } | null
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setAuthUser(data.session?.user ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setAuthUser(session?.user ?? null))
    return () => sub?.subscription?.unsubscribe()
  }, [])
  const proceedToCheckout = (u, checkoutUrl) => {
    const url = new URL(checkoutUrl)
    url.searchParams.set('client_reference_id', u.id)          // ties the payment → account (no email reconciliation)
    if (u.email) url.searchParams.set('prefilled_email', u.email)
    window.location.assign(url.toString())
  }
  const handleBuy = (plan, checkoutUrl) => {
    const intent = plan.founding ? `${plan.name} — Founding Member` : plan.name
    if (authUser) { proceedToCheckout(authUser, checkoutUrl); return }   // already signed in → straight to Stripe
    setAuthCtx({ mode: 'signup', intent, checkoutUrl })                  // else → signup/login popup first
  }
  const handleAuthed = (u) => {
    const ctx = authCtx
    setAuthCtx(null); setAuthUser(u)
    if (ctx?.checkoutUrl) proceedToCheckout(u, ctx.checkoutUrl)
  }

  useEffect(() => {
    const t = setInterval(() => setSlideIndex(i => (i + 1) % slides.length), SLIDE_INTERVAL)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setShowScroll(true), SCROLL_SHOW_DELAY)
    return () => clearTimeout(timer)
  }, [])

  return (
    <MotionConfig reducedMotion="user">
    <div style={{ fontFamily: "'Inter', sans-serif" }}>
      <CheckoutSuccessToast />
      <AuthModal
        open={!!authCtx}
        initialMode={authCtx?.mode}
        intent={authCtx?.intent}
        onClose={() => setAuthCtx(null)}
        onAuthed={handleAuthed}
      />
      {/* ═══════════════════════════════════════════════════════════════════════
          HERO SECTION
      ═══════════════════════════════════════════════════════════════════════ */}
      <section className="relative h-screen flex flex-col overflow-hidden">

        <video
          className="absolute inset-0 w-full h-full object-cover"
          src={VIDEO_URL}
          poster="/argus-poster.png"
          autoPlay loop muted playsInline
          preload="metadata"
          aria-hidden="true"
        />

        {/* Live npm download badge — centre count-up intro → docks bottom-right */}
        <DownloadBadge total={npm.total} error={npm.error} firstPublish={npm.firstPublish} />

        {/* Mobile menu overlay */}
        {menuOpen && (
          <div className="fixed inset-0 z-50 bg-white flex flex-col px-5 py-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Logo />
                <span className="font-semibold tracking-widest uppercase text-black" style={{ fontSize: 15, letterSpacing: '0.2em' }}>
                  Argus
                </span>
                <BetaBadge />
              </div>
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu" className="w-11 h-11 rounded-full bg-black flex items-center justify-center">
                <X size={16} color="white" />
              </button>
            </div>
            <nav className="mt-16 flex flex-col gap-8">
              {navLinks.map((link) => (
                <a
                  key={link}
                  href={navHrefs[link]}
                  onClick={() => setMenuOpen(false)}
                  className="text-3xl font-semibold tracking-widest uppercase text-black"
                >
                  {link}
                </a>
              ))}
            </nav>
            <div className="mt-auto">
              <a href="#setup" className="flex items-center gap-2 text-xl font-semibold tracking-widest uppercase" style={{ color: ACCENT }}>
                Get Started <ArrowUpRight size={20} />
              </a>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex items-center justify-between px-5 sm:px-8 md:px-12 pt-5 md:pt-6 pb-4 relative z-10">
          <motion.div custom={0} variants={fadeDown} initial="initial" animate="animate" className="flex items-center gap-2.5 flex-1">
            <Logo />
            <span className="font-semibold tracking-widest uppercase text-black" style={{ fontSize: 15, letterSpacing: '0.2em' }}>
              Argus
            </span>
            <BetaBadge />
          </motion.div>

          {/* Nav links — permanent purple glassmorphism */}
          <div
            className="hidden md:flex items-center relative"
            style={{ padding: '0.375rem 0.5rem', borderRadius: '2rem' }}
            onMouseLeave={() => setHoveredLink(null)}
          >
            <div
              style={{
                position: 'absolute', inset: 0,
                background: `linear-gradient(135deg, rgba(255,255,255,0.34) 0%, ${accent(0.34)} 50%, ${accent(0.32)} 100%)`,
                backdropFilter: 'blur(40px) saturate(200%) brightness(1.08)',
                WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.08)',
                border: `1px solid ${accentLight(0.6)}`, borderRadius: '2rem',
                boxShadow: `0 8px 40px ${accent(0.28)}, 0 2px 8px rgba(0,0,0,0.06), inset 0 1.5px 0 rgba(255,255,255,0.85), inset 0 -1px 0 ${accent(0.12)}, inset 1px 0 0 rgba(255,255,255,0.45)`,
                pointerEvents: 'none',
              }}
            />

            {navLinks.map((link, i) => (
              <motion.div
                key={link}
                custom={i + 1} variants={fadeDown} initial="initial" animate="animate"
                className="relative" style={{ padding: '0.5rem 1rem' }}
                onMouseEnter={() => setHoveredLink(link)}
                onMouseLeave={() => setHoveredLink(null)}
              >
                <AnimatePresence>
                  {hoveredLink === link && (
                    <motion.div
                      layoutId="nav-link-pill"
                      initial={{ opacity: 0, scale: 0.88 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.88 }}
                      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                      style={{
                        position: 'absolute', inset: 0,
                        background: 'rgba(255, 255, 255, 0.78)',
                        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                        border: '1px solid rgba(255, 255, 255, 0.9)',
                        borderRadius: '0.875rem', boxShadow: '0 2px 14px rgba(0,0,0,0.07)', zIndex: 0,
                      }}
                    />
                  )}
                </AnimatePresence>

                <motion.a
                  href={navHrefs[link]}
                  className="relative font-semibold tracking-widest uppercase text-black block"
                  animate={{ fontSize: hoveredLink === link ? 15 : 14 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  style={{ zIndex: 1, lineHeight: 1 }}
                >
                  {link}
                </motion.a>

                <div style={{ position: 'absolute', bottom: '0.3rem', left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 1, pointerEvents: 'none' }}>
                  <motion.div
                    initial={false}
                    animate={{ scaleX: hoveredLink === link ? 1 : 0, opacity: hoveredLink === link ? 1 : 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    style={{ width: '1.5rem', height: '2px', background: ACCENT, borderRadius: 2, transformOrigin: 'center' }}
                  />
                </div>
              </motion.div>
            ))}
          </div>

          <div className="flex-1 flex justify-end">
            <motion.button
              custom={5} variants={fadeDown} initial="initial" animate="animate"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              aria-expanded={menuOpen}
              className="w-11 h-11 rounded-full bg-black flex flex-col items-center justify-center gap-1"
            >
              <span className="w-4 h-0.5 bg-white" aria-hidden="true" />
              <span className="w-4 h-0.5 bg-white" aria-hidden="true" />
              <span className="w-4 h-0.5 bg-white" aria-hidden="true" />
            </motion.button>
          </div>
        </nav>

        {/* Stats row */}
        <div className="flex-1 flex flex-col sm:flex-row items-center sm:justify-between px-5 sm:px-8 md:px-12 py-6 sm:py-8 md:py-0 gap-6 sm:gap-0 relative z-10">
          <motion.div
            custom={7} variants={fadeUp} initial="initial" animate="animate"
            className="w-full max-w-[300px] sm:w-[198px] sm:max-w-none md:w-[270px]"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,0.45) 0%, rgba(94,14,215,0.18) 55%, rgba(94,14,215,0.12) 100%)',
              backdropFilter: 'blur(40px) saturate(200%) brightness(1.08)',
              WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.08)',
              border: '1px solid rgba(255,255,255,0.72)', borderRadius: '1.25rem',
              padding: 'clamp(0.85rem, 1.8vw, 1.35rem)',
              boxShadow: '0 8px 40px rgba(94,14,215,0.18), 0 2px 8px rgba(0,0,0,0.06), inset 0 1.5px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(94,14,215,0.08), inset 1px 0 0 rgba(255,255,255,0.55)',
            }}
          >
            <div style={{ position: 'relative', minHeight: 'clamp(6.5rem, 8.1vw, 6.75rem)', overflow: 'hidden' }}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={slideIndex}
                  initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -18 }}
                  transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
                >
                  <div className="mb-3 sm:mb-4" style={{ width: '2rem', height: '2px', background: ACCENT, borderRadius: 2 }} />
                  {typeof slides[slideIndex] === 'string' ? (
                    <p className="font-semibold tracking-widest uppercase text-black leading-relaxed text-left whitespace-pre-line" style={{ fontSize: 'clamp(0.75rem, 1.6vw, 0.85rem)' }}>
                      {slides[slideIndex]}
                    </p>
                  ) : (
                    <a
                      href={slides[slideIndex].href}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: 'block' }}
                      aria-label={slides[slideIndex].alt}
                    >
                      <img
                        src={slides[slideIndex].src}
                        alt={slides[slideIndex].alt}
                        style={{ maxWidth: '100%', height: 'auto', borderRadius: '0.5rem' }}
                      />
                    </a>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>

          <div className="flex gap-8 sm:gap-8 md:gap-10">
            {stats.map((stat, i) => (
              <motion.div key={stat.num} custom={i + 2} variants={fadeUp} initial="initial" animate="animate" className="flex flex-col items-center sm:items-end">
                <div style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', fontWeight: 600, lineHeight: 1 }}>
                  <span style={{ color: ACCENT, fontSize: '0.5em' }}>+</span>
                  <span className="text-black">{stat.num}</span>
                </div>
                <p className="text-[11px] sm:text-xs md:text-sm font-semibold tracking-widest uppercase text-black whitespace-pre-line leading-tight text-center sm:text-right">
                  {stat.label}
                </p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Bottom section */}
        <div className="px-5 sm:px-8 md:px-12 pb-8 md:pb-12 flex flex-col gap-6 md:gap-12 relative z-10">
          <div className="flex items-center justify-end">
            <div
              style={{ position: 'relative', display: 'inline-flex' }}
              onMouseEnter={() => setGsHovered(true)}
              onMouseLeave={() => setGsHovered(false)}
            >
              {/* Glassmorphism bg — visible on hover only */}
              <motion.div
                animate={{ opacity: gsHovered ? 1 : 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(135deg, rgba(255,255,255,0.45) 0%, rgba(94,14,215,0.18) 55%, rgba(94,14,215,0.12) 100%)',
                  backdropFilter: 'blur(40px) saturate(200%) brightness(1.08)',
                  WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.08)',
                  border: '1px solid rgba(255,255,255,0.72)', borderRadius: '2rem',
                  boxShadow: '0 8px 40px rgba(94,14,215,0.18), 0 2px 8px rgba(0,0,0,0.06), inset 0 1.5px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(94,14,215,0.08), inset 1px 0 0 rgba(255,255,255,0.55)',
                  pointerEvents: 'none',
                }}
              />
              <motion.a
                custom={6} variants={fadeUp} initial="initial" animate="animate"
                href="#setup"
                className="relative flex items-center gap-1.5 text-base sm:text-xl md:text-2xl font-semibold tracking-widest uppercase whitespace-nowrap"
                style={{ color: ACCENT, padding: '0.625rem 1.5rem', borderRadius: '2rem', zIndex: 1 }}
              >
                Get Started
                <ArrowUpRight size={18} className="sm:hidden" />
                <ArrowUpRight size={22} className="hidden sm:block" />
              </motion.a>
            </div>
          </div>

          <div className="flex items-end">
            <div className="flex flex-col items-start">
              {headingWords.map((word, i) => (
                <div key={word} className="overflow-hidden">
                  <motion.span
                    initial={{ y: '110%' }} animate={{ y: 0 }}
                    transition={{ delay: 0.4 + i * 0.14, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                    className="block uppercase text-black text-left font-semibold"
                    style={{ fontSize: 'clamp(2rem, 9vw, 9rem)', lineHeight: 0.88, fontWeight: 600 }}
                  >
                    {word}
                  </motion.span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Scroll indicator */}
        <AnimatePresence>
          {showScroll && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              style={{ position: 'absolute', bottom: '2rem', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem', zIndex: 10 }}
            >
              <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}>
                <ChevronDown size={20} color="rgba(0,0,0,0.45)" />
              </motion.div>
              <span style={{ fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.35)' }}>
                SCROLL
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════════
          BELOW-FOLD SECTIONS
      ═══════════════════════════════════════════════════════════════════════ */}
      <Suspense fallback={null}>
        <DownloadsSection daily={npm.daily} total={npm.total} firstPublish={npm.firstPublish} loading={npm.loading} error={npm.error} />
      </Suspense>
      <ListedOnSection />
      <FeaturesSection />
      <DetectionSection />
      <Suspense fallback={null}>
        <SecuritySection />
      </Suspense>
      <SetupSection />
      <PricingSection onBuy={handleBuy} />
      <DocsSection />
      <Footer />
    </div>
    </MotionConfig>
  )
}
