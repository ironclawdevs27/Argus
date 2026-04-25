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
 * API endpoints to validate response shapes against (D7.4).
 * Each entry is checked against captured network requests on every crawled route.
 *
 * Fields:
 *   url        — path (e.g. '/api/user') or full URL for exact match
 *   method     — HTTP method to match (optional — omit to match any method)
 *   schema     — inline JSON Schema object (preferred)
 *   schemaFile — path to a JSON file containing the schema (alternative to schema)
 *
 * Supported schema keywords: type, required, properties, items.
 *
 * Violations are emitted as api_contract_violation warnings in the report.
 *
 * Examples:
 *   { url: '/api/user', method: 'GET', schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' }, name: { type: 'string' } } } }
 *   { url: '/api/products', method: 'GET', schemaFile: './schemas/products.json' }
 */
export const apiContracts = [
  // Uncomment and configure to validate API response shapes:
  // { url: '/api/user',     method: 'GET', schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' }, name: { type: 'string' } } } },
  // { url: '/api/products', method: 'GET', schemaFile: './schemas/products.json' },
];

/**
 * Severity policy overrides (D7.5).
 * Post-processes all findings before Slack routing, letting teams adjust or
 * silence specific detection types without editing analyzer source code.
 *
 * Keys are finding type strings (e.g. 'seo_missing_description').
 * Values are one of: 'critical' | 'warning' | 'info' | 'suppress'
 *   'suppress' removes the finding entirely from the report and Slack alerts.
 *
 * Examples:
 *   seo_missing_description: 'info'     — demote noisy SEO finding to info
 *   cache_headers_missing:   'suppress' — silence entirely on this project
 *   redirect_chain:          'warning'  — keep at warning (already is; no-op)
 */
export const severityOverrides = {
  // seo_missing_description: 'info',
  // cache_headers_missing:   'suppress',
};

/**
 * Auth session persistence (v3 Phase B2).
 *
 * When set, runCrawl() runs the login flow once before crawling, saves the
 * session state (cookies + localStorage), and restores it before each route.
 * This unlocks crawling of authenticated routes without re-logging in per page.
 *
 * Credentials MUST come from environment variables — never hardcode them here.
 * Add ARGUS_AUTH_EMAIL and ARGUS_AUTH_PASSWORD to your .env file.
 *
 * Supported step actions: navigate, fill, click, waitFor, sleep
 *
 * Set to null to disable auth (public crawl only).
 */
export const auth = null;

/**
 * User flow definitions (v3 Phase B5).
 *
 * Each flow is a named sequence of steps executed end-to-end by flow-runner.js.
 * Supported actions: navigate, fill, click, press_key, waitFor, sleep, handle_dialog, assert
 * Assert types: no_console_errors, no_network_errors, element_visible, element_not_visible,
 *               url_contains, no_js_errors
 *
 * Set to [] to disable (default).
 */
export const flows = [];

// Uncomment and configure to test user journeys:
// export const flows = [
//   {
//     name: 'Login flow',
//     steps: [
//       { action: 'navigate',  path: '/login' },
//       { action: 'fill',      selector: '#email',    value: process.env.ARGUS_AUTH_EMAIL    ?? '' },
//       { action: 'fill',      selector: '#password', value: process.env.ARGUS_AUTH_PASSWORD ?? '' },
//       { action: 'click',     selector: 'button[type="submit"]' },
//       { action: 'waitFor',   selector: '[data-testid="dashboard"]', timeout: 15000 },
//       { action: 'assert',    type: 'no_console_errors' },
//       { action: 'assert',    type: 'url_contains', value: '/dashboard' },
//     ],
//   },
//   {
//     name: 'Checkout flow',
//     steps: [
//       { action: 'navigate',  path: '/cart' },
//       { action: 'click',     selector: '[data-testid="checkout-btn"]' },
//       { action: 'waitFor',   selector: '[data-testid="payment-form"]' },
//       { action: 'assert',    type: 'no_network_errors' },
//       { action: 'assert',    type: 'element_visible', selector: '[data-testid="order-summary"]' },
//     ],
//   },
// ];

// Uncomment and configure for authenticated crawls:
// export const auth = {
//   sessionFile:      '.argus-session.json',
//   sessionMaxAgeMs:  60 * 60 * 1000,   // 1 hour — re-login after this
//   steps: [
//     { action: 'navigate', path: '/login' },
//     { action: 'fill',     selector: '#email',    value: process.env.ARGUS_AUTH_EMAIL    ?? '' },
//     { action: 'fill',     selector: '#password', value: process.env.ARGUS_AUTH_PASSWORD ?? '' },
//     { action: 'click',    selector: 'button[type="submit"]' },
//     { action: 'waitFor',  selector: '[data-testid="dashboard"]', timeout: 15000 },
//   ],
// };
