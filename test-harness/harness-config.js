/**
 * ARGUS Test Harness Configuration
 *
 * Route definitions for each fixture page.  Mirror the format of
 * src/config/targets.js so the same crawlRoute() signature works.
 */

export const HARNESS_DEV_PORT     = 3100;
export const HARNESS_STAGING_PORT = 3101;
export const HARNESS_DEV_URL      = `http://localhost:${HARNESS_DEV_PORT}`;
export const HARNESS_STAGING_URL  = `http://localhost:${HARNESS_STAGING_PORT}`;

/**
 * Routes passed to the crawl validator.
 *
 * expected — what validate.js asserts; does NOT affect crawlRoute behaviour,
 *            only used for reporting which test each route exercises.
 */
export const harnessRoutes = [
  {
    path: '/clean.html',
    name: 'Clean',
    critical: false,
    waitFor: null,
    expected: 'no warnings or criticals',
  },
  {
    path: '/js-errors.html',
    name: 'JS Errors',
    critical: false,    // console errors → severity "warning" (not escalated)
    waitFor: null,
    expected: 'console error + console warning',
  },
  {
    path: '/js-errors-noncritical.html',
    name: 'JS Errors (non-critical)',
    critical: false,
    waitFor: null,
    expected: 'console error at warning severity',
  },
  {
    path: '/network-errors.html',
    name: 'Network Errors',
    critical: false,
    waitFor: null,
    expected: 'HTTP 500 (critical), 401 (critical), 404 (info)',
  },
  {
    path: '/api-frequency.html',
    name: 'API Frequency',
    critical: false,
    waitFor: null,
    expected: 'data-loop ×6 (critical), data-batch ×3 (warning), data-pair ×2 (info)',
  },
  {
    path: '/blank-page.html',
    name: 'Blank Page',
    critical: true,
    waitFor: null,
    expected: 'blank_page critical',
  },
  {
    path: '/waitfor-page.html',
    name: 'WaitFor',
    critical: false,
    waitFor: '#late-content',
    expected: 'selector found within timeout — no load_failure',
  },
  {
    path: '/css-issues.html',
    name: 'CSS Issues',
    critical: false,
    waitFor: null,
    expected: 'css_override (important), css_unused_rules, css_component_leak, css_modules_detected, react_inline_style_conflict',
  },
  {
    path: '/perf-issues.html',
    name: 'Perf TTFB',
    critical: false,
    waitFor: null,
    expected: 'performance_budget TTFB > 800 ms (soft)',
  },
  {
    path: '/perf-lcp.html',
    name: 'Perf LCP',
    critical: false,
    waitFor: null,
    expected: 'performance_budget LCP > 2500 ms (soft)',
  },
  {
    path: '/perf-cls.html',
    name: 'Perf CLS',
    critical: false,
    waitFor: null,
    expected: 'performance_budget CLS > 0.1 (soft)',
  },
  {
    path: '/perf-fid.html',
    name: 'Perf FID',
    critical: false,
    waitFor: null,
    expected: 'performance_budget FID/TBT > 100 ms (soft)',
  },
  {
    path: '/js-errors-critical.html',
    name: 'JS Errors (Critical Route)',
    critical: true,    // console errors → escalated to "critical"
    waitFor: null,
    expected: 'console errors at severity critical (not warning)',
  },
  {
    path: '/waitfor-timeout.html',
    name: 'WaitFor Timeout',
    critical: false,
    waitFor: '#never-appears',
    expected: 'load_failure warning — selector never found',
  },
  {
    path: '/a11y-critical.html',
    name: 'A11y Critical',
    critical: false,
    waitFor: null,
    expected: 'lighthouse accessibility score < 50 (soft)',
  },
  {
    path: '/a11y-warning.html',
    name: 'A11y Warning',
    critical: false,
    waitFor: null,
    expected: 'lighthouse accessibility score 50–89 (soft)',
  },
  // v3 Phase A1/A3 — SEO issues fixture
  {
    path: '/seo-issues.html',
    name: 'SEO Issues',
    critical: false,
    waitFor: null,
    expected: 'missing meta description, og tags, canonical; multiple h1s; generic title (v3 Phase A3)',
  },
  // v3 Phase A2 — slow API + oversized payload fixture
  {
    path: '/api-performance.html',
    name: 'API Performance',
    critical: false,
    waitFor: '#all-fetches-done',
    expected: 'slow_api warning (>1000ms), slow_api critical (>3000ms), large_payload warning (>500KB), large_payload critical (>2MB)',
  },
  // v3 Phase A5 — content quality checks fixture
  {
    path: '/content-issues.html',
    name: 'Content Issues',
    critical: false,
    waitFor: '#content-checks-done[data-ready]',
    expected: 'content_null_rendered, content_placeholder_text, content_broken_image, content_empty_list',
  },
  // v3 Phase A4 — security checks fixture
  {
    path: '/security-issues.html',
    name: 'Security Issues',
    critical: false,
    waitFor: '#security-checks-done[data-ready]',
    expected: 'security_token_in_storage, security_token_in_url, security_eval_usage, security_sensitive_console, security_missing_csp, security_missing_xframe, security_cookie_no_httponly',
  },
];

/** Routes used for env-comparison tests (same path served by both servers). */
export const harnessComparisonRoutes = [
  { path: '/', name: 'Home' },
];
