/**
 * ARGUS Target Configuration
 *
 * Define which URLs to test, what flows to check, and per-route settings.
 * Claude Code reads this file when building test runs.
 */

export const config = {
  /** Milliseconds to wait after navigation before capturing state */
  pageSettleMs: 2000,

  /** Screenshot quality (1–100) */
  screenshotQuality: 90,

  /** Pixel diff % above which a visual change is flagged */
  screenshotDiffThreshold: parseFloat(process.env.SCREENSHOT_DIFF_THRESHOLD ?? '0.5'),

  /** Directory to write reports and screenshots */
  outputDir: process.env.REPORT_OUTPUT_DIR ?? './reports',
};

/**
 * Routes to test in crawl-and-report.js (error detection).
 * Add every key page your application serves.
 *
 * Fields:
 *   path        — URL path appended to the base URL
 *   name        — human-readable label for reports
 *   critical    — if true, any error on this route is escalated to 'critical'
 *   waitFor     — optional CSS selector to wait for before capturing (signals page ready)
 */
export const routes = [
  { path: '/', name: 'Home', critical: true, waitFor: 'main' },
  { path: '/login', name: 'Login', critical: true, waitFor: 'form' },
  { path: '/dashboard', name: 'Dashboard', critical: true, waitFor: '[data-testid="dashboard"]' },
  { path: '/settings', name: 'Settings', critical: false, waitFor: null },
  // Add more routes here as your app grows
];

/**
 * Comparison route pairs for env-comparison.js.
 * Each entry maps a dev path to the equivalent staging path (usually the same).
 */
export const comparisonRoutes = [
  { path: '/', name: 'Home' },
  { path: '/login', name: 'Login' },
  { path: '/dashboard', name: 'Dashboard' },
];

/**
 * API endpoints to validate response shapes against.
 * Used by the API contract validation layer (future phase).
 *
 * Fields:
 *   url         — full URL or path pattern
 *   method      — HTTP method
 *   schemaFile  — path to JSON Schema or OpenAPI spec fragment
 */
export const apiContracts = [
  // { url: '/api/user', method: 'GET', schemaFile: './schemas/user.json' },
  // { url: '/api/products', method: 'GET', schemaFile: './schemas/products.json' },
];
