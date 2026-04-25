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
  // v3 Phase A3 — missing h1 fixture (zero h1s → seo_missing_h1)
  {
    path: '/seo-no-h1.html',
    name: 'SEO No H1',
    critical: false,
    waitFor: null,
    expected: 'seo_missing_h1 warning (zero h1 tags on page)',
  },
  // v3 Phase B1 — memory leak fixture (analysed via analyzeMemory, not crawlFixture)
  {
    path: '/memory-leak.html',
    name: 'Memory Leak',
    critical: false,
    waitFor: null,
    expected: 'memory_detached_dom_nodes warning (50 detached HTMLDivElement nodes in heap)',
  },
  // v3 Phase B2 — auth session login fixture
  {
    path: '/auth-login.html',
    name: 'Auth Login',
    critical: false,
    waitFor: null,
    expected: 'login form submits, sets argus-session cookie + localStorage authToken, shows #login-success[data-ready]',
  },
  // v3 Phase B2 — auth session protected fixture
  {
    path: '/auth-protected.html',
    name: 'Auth Protected',
    critical: false,
    waitFor: null,
    expected: 'shows #protected-content when session present, #auth-error when no session',
  },
  // v3 Phase A6 — responsive layout fixture (analysed via analyzeResponsive, not crawlFixture)
  {
    path: '/responsive-issues.html',
    name: 'Responsive Issues',
    critical: false,
    waitFor: null,
    expected: 'responsive_overflow critical at ≤768px, responsive_small_touch_target warning at 375px',
  },
  // D2.1 — redirect chain detection (3 hops: start→hop1→hop2→end)
  {
    path: '/redirect-chain-start',
    name: 'Redirect Chain',
    critical: false,
    waitFor: null,
    expected: 'redirect_chain warning (redirectCount: 3, threshold: > 2)',
  },
  // D2.3 — broken internal link detection (2 broken, 1 valid, 4 skipped)
  {
    path: '/broken-links.html',
    name: 'Broken Links',
    critical: false,
    waitFor: null,
    expected: '2 broken_link warnings for nonexistent internal paths',
  },
  // D6.1 — synchronous XHR blocks main thread
  {
    path: '/sync-xhr.html',
    name: 'Sync XHR',
    critical: false,
    waitFor: null,
    expected: 'sync_xhr warning (synchronous GET /api/data blocks main thread)',
  },
  // D6.2 — document.write / document.writeln usage
  {
    path: '/doc-write.html',
    name: 'Document Write',
    critical: false,
    waitFor: null,
    expected: 'document_write warning ×2 (document.write + document.writeln)',
  },
  // D6.3 — long task > 50ms on main thread
  {
    path: '/long-task.html',
    name: 'Long Task',
    critical: false,
    waitFor: null,
    expected: 'long_task warning (120ms busy-loop > 50ms threshold)',
  },
  // D6.4 — CORS error (cross-origin fetch blocked by CORS policy)
  {
    path: '/cors-error.html',
    name: 'CORS Error',
    critical: false,
    waitFor: null,
    expected: 'cors_error critical (fetch from localhost:3101 blocked by CORS policy)',
  },
  // D6.5 — service worker registration failure (non-existent SW script)
  {
    path: '/sw-error.html',
    name: 'SW Registration Error',
    critical: false,
    waitFor: null,
    expected: 'sw_registration_error warning (register /sw-does-not-exist.js → 404)',
  },
  // D6.6 — static assets served without Cache-Control or ETag response headers
  {
    path: '/cache-headers.html',
    name: 'Cache Headers',
    critical: false,
    waitFor: null,
    expected: 'cache_headers_missing info ×2 for /api/nocache.css and /api/nocache.js',
  },
  // D6.7 — debugger; statement in inline and external scripts
  {
    path: '/debugger-statement.html',
    name: 'Debugger Statement',
    critical: false,
    waitFor: null,
    expected: 'debugger_statement critical ×2 (one inline, one in debug-script.js)',
  },
  // D6.8 — duplicate id="" attributes on the same page
  {
    path: '/duplicate-ids.html',
    name: 'Duplicate IDs',
    critical: false,
    waitFor: null,
    expected: 'duplicate_id warning ×2 (id="card" ×3, id="header" ×2); unique id not flagged',
  },
  // D6.9 — mixed content: blocked (critical) vs passive warning (warning)
  {
    path: '/mixed-content.html',
    name: 'Mixed Content',
    critical: false,
    waitFor: null,
    expected: 'security_mixed_content critical (blocked) + security_mixed_content warning (passive)',
  },
  // D8.1 — hover-state bug detection (broken dropdown + missing tooltip)
  {
    path: '/hover-issues.html',
    name: 'Hover Issues',
    critical: false,
    waitFor: null,
    expected: 'hover_dropdown_broken warning (aria-haspopup with no JS open handler), hover_tooltip_missing warning (opacity:0!important tooltip)',
  },
  // D8.2 — accessibility snapshot analysis (missing name, missing label, duplicate landmark)
  {
    path: '/snapshot-issues.html',
    name: 'Snapshot Issues',
    critical: false,
    waitFor: null,
    expected: 'a11y_missing_name warning (SVG-only button), a11y_missing_form_label warning (bare input), a11y_duplicate_landmark warning (main + role=main)',
  },
  // D8.3 — type_text step action: fill bypasses input events; type_text fires them
  {
    path: '/typetext-issues.html',
    name: 'Type-Text Issues',
    critical: false,
    waitFor: null,
    expected: 'fill does not update char counter (no input event); type_text updates counter; typing: true flow step completes',
  },
  // D8.4 — drag step action: drag to working drop zone fires drop event; broken zone does not
  {
    path: '/drag-issues.html',
    name: 'Drag Issues',
    critical: false,
    waitFor: null,
    expected: 'drag step wired in flow-runner; drag to working zone sets data-dropped="true"; bad selector → flow_step_failed',
  },
];

/** Routes used for env-comparison tests (same path served by both servers). */
export const harnessComparisonRoutes = [
  { path: '/', name: 'Home' },
];
