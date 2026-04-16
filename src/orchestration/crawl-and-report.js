/**
 * ARGUS Phase 2: Error Detection Pipeline
 *
 * Uses Chrome DevTools MCP tools (available via Claude Code's MCP integration)
 * to crawl target URLs, capture console errors, failed network requests,
 * and screenshots, then outputs a structured JSON report.
 *
 * Run: node src/orchestration/crawl-and-report.js
 *
 * This script is designed to be called by Claude Code, which has access to the
 * Chrome DevTools MCP tools as native functions. When run standalone, it produces
 * a dry-run report template. When invoked via Claude Code with MCP connected,
 * Claude executes the MCP tool calls and writes real data.
 *
 * MCP Tools Used:
 *   navigate_page, list_console_messages, list_network_requests,
 *   get_network_request, take_screenshot, evaluate_script, wait_for,
 *   performance_start_trace, performance_stop_trace, performance_analyze_insight,
 *   lighthouse_audit (all 4 categories: accessibility, performance, seo, best-practices)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { routes, config } from '../config/targets.js';
import { postBugReport } from './slack-notifier.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../utils/css-analyzer.js';

// ── Performance Budgets ────────────────────────────────────────────────────────
// Hard thresholds — exceeding any of these is a 'warning' severity bug.
// Adjust in src/config/targets.js or via env vars in the future.
const PERF_BUDGETS = {
  LCP: 2500,   // Largest Contentful Paint — ms
  CLS: 0.1,    // Cumulative Layout Shift — score
  FID: 100,    // First Input Delay — ms (approximated via TBT in traces)
  TTFB: 800,   // Time to First Byte — ms
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
const OUTPUT_DIR = path.resolve(__dirname, '../../', config.outputDir);

// ── Severity Classification ────────────────────────────────────────────────────

/**
 * Classify a console message by severity.
 * @param {object} msg - Console message object from list_console_messages
 * @param {boolean} routeIsCritical - Whether the route is marked critical
 * @returns {'critical'|'warning'|'info'}
 */
function classifyConsoleMessage(msg, routeIsCritical) {
  const level = (msg.level ?? '').toLowerCase();
  if (level === 'error') return routeIsCritical ? 'critical' : 'warning';
  if (level === 'warning') return 'info';
  return 'info';
}

/**
 * Classify a network request by severity.
 * @param {object} req - Network request object from list_network_requests
 * @param {boolean} routeIsCritical
 * @returns {'critical'|'warning'|'info'|null} null = not a failure
 */
function classifyNetworkRequest(req, routeIsCritical) {
  const status = req.status ?? 0;
  if (status >= 500) return 'critical';
  if (status === 401 || status === 403) return 'critical'; // auth failure
  if (status >= 400) return routeIsCritical ? 'warning' : 'info';
  return null; // not a failure
}

// ── Error Deduplication ────────────────────────────────────────────────────────

/**
 * Deduplicate errors: same message + URL + type = one entry.
 * @param {object[]} errors
 * @returns {object[]}
 */
function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter(e => {
    const key = `${e.type}::${e.message}::${e.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Uncaught Exception Injection Script ───────────────────────────────────────

/**
 * JavaScript injected into the page via evaluate_script.
 * Sets up window.onerror and unhandledrejection listeners that store
 * structured error objects on window.__argusErrors for later extraction.
 */
const INJECT_ERROR_LISTENER = `
(function() {
  window.__argusErrors = window.__argusErrors || [];
  window.onerror = function(message, source, lineno, colno, error) {
    window.__argusErrors.push({
      type: 'uncaught_exception',
      message: message,
      source: source,
      line: lineno,
      col: colno,
      stack: error ? error.stack : null,
      ts: Date.now()
    });
    return false; // don't suppress default handling
  };
  window.addEventListener('unhandledrejection', function(event) {
    window.__argusErrors.push({
      type: 'unhandled_rejection',
      message: String(event.reason),
      stack: event.reason && event.reason.stack ? event.reason.stack : null,
      ts: Date.now()
    });
  });
})();
`;

/** Extracts the injected errors from the page after settle time. */
const EXTRACT_ERROR_LISTENER = `JSON.stringify(window.__argusErrors || [])`;

// ── Performance Budget Enforcement ────────────────────────────────────────────

/**
 * Run a performance trace on the current page and check against budgets.
 * Returns an array of budget violation error objects.
 *
 * @param {object} mcp - MCP tool interface
 * @param {string} url - URL being tested (for error reporting)
 * @returns {object[]} Budget violation errors
 */
async function checkPerformanceBudgets(mcp, url) {
  const violations = [];

  try {
    await mcp.performance_start_trace();
    // Let the page render for 3 seconds to capture paint/layout metrics
    await new Promise(r => setTimeout(r, 3000));
    const trace = await mcp.performance_stop_trace();
    const insights = await mcp.performance_analyze_insight({ trace });

    // Extract metrics — structure varies by chrome-devtools-mcp version
    const metrics = insights?.metrics ?? insights?.performanceMetrics ?? {};

    const checks = [
      { key: 'LCP', value: metrics.largestContentfulPaint ?? metrics.LCP, budget: PERF_BUDGETS.LCP, unit: 'ms' },
      { key: 'CLS', value: metrics.cumulativeLayoutShift ?? metrics.CLS, budget: PERF_BUDGETS.CLS, unit: '' },
      { key: 'FID', value: metrics.totalBlockingTime ?? metrics.TBT ?? metrics.FID, budget: PERF_BUDGETS.FID, unit: 'ms' },
      { key: 'TTFB', value: metrics.timeToFirstByte ?? metrics.TTFB, budget: PERF_BUDGETS.TTFB, unit: 'ms' },
    ];

    for (const { key, value, budget, unit } of checks) {
      if (value == null) continue; // metric not available in this trace
      if (value > budget) {
        violations.push({
          type: 'performance_budget',
          metric: key,
          value: `${value}${unit}`,
          budget: `${budget}${unit}`,
          message: `Performance budget exceeded: ${key} = ${value}${unit} (budget: ${budget}${unit})`,
          severity: 'warning',
          url,
        });
      }
    }
  } catch (err) {
    // Performance trace not always available — degrade gracefully
    console.warn(`[ARGUS] Performance trace skipped for ${url}: ${err.message}`);
  }

  return violations;
}

// ── Lighthouse Full Suite (v3 — Phase A1) ─────────────────────────────────────

/**
 * Score thresholds per Lighthouse category.
 * score is 0–1 from Lighthouse; we multiply by 100 for display.
 */
const LIGHTHOUSE_THRESHOLDS = {
  accessibility:    { critical: 50, warning: 90 },
  performance:      { critical: 50, warning: 90 },
  seo:              { critical: 50, warning: 90 },
  'best-practices': { critical: 50, warning: 90 },
};

/**
 * Human-readable category labels for messages.
 */
const LIGHTHOUSE_LABELS = {
  accessibility:    'Accessibility',
  performance:      'Performance',
  seo:              'SEO',
  'best-practices': 'Best Practices',
};

/**
 * Run a full Lighthouse audit on the current page across all four categories:
 * accessibility, performance, SEO, and best-practices.
 *
 * Each category is scored independently:
 *   score < threshold.critical → 'critical'
 *   score < threshold.warning  → 'warning'
 *
 * Individual failing audit items are surfaced for every category so the
 * report pinpoints exactly which rules failed.
 *
 * @param {object} mcp - MCP tool interface
 * @param {string} url - URL being tested
 * @returns {Promise<object[]>} Lighthouse violation errors
 */
async function checkLighthouse(mcp, url) {
  const violations = [];

  try {
    const result = await mcp.lighthouse_audit({
      categories: ['accessibility', 'performance', 'seo', 'best-practices'],
      url,
    });

    const categories = result?.categories ?? {};
    const audits     = result?.audits     ?? {};

    // ── Per-category score check ───────────────────────────────────────────
    for (const [catKey, thresholds] of Object.entries(LIGHTHOUSE_THRESHOLDS)) {
      // Lighthouse returns categories keyed by the category ID
      const catData = categories[catKey] ?? categories[catKey.replace('-', '_')];
      const score   = catData?.score ?? result?.[catKey]?.score ?? null;
      if (score == null) continue;

      const pct   = Math.round(score * 100);
      const label = LIGHTHOUSE_LABELS[catKey];

      if (pct < thresholds.critical) {
        violations.push({
          type:     'lighthouse_score',
          category: catKey,
          score:    pct,
          threshold: thresholds.critical,
          message:  `Lighthouse ${label} score ${pct}/100 — critical (threshold: ${thresholds.critical})`,
          severity: 'critical',
          url,
        });
      } else if (pct < thresholds.warning) {
        violations.push({
          type:     'lighthouse_score',
          category: catKey,
          score:    pct,
          threshold: thresholds.warning,
          message:  `Lighthouse ${label} score ${pct}/100 — needs improvement (threshold: ${thresholds.warning})`,
          severity: 'warning',
          url,
        });
      }
    }

    // ── Individual failing audit items ─────────────────────────────────────
    // Surface every audit that scored 0 (hard failure) across all categories.
    // Manual audits (type === 'manual') are skipped — they require human review.
    for (const [auditId, audit] of Object.entries(audits)) {
      if (audit.score !== 0) continue;
      if (audit.details?.type === 'manual') continue;

      // Determine which category this audit belongs to
      const auditCategory = Object.entries(categories).find(([, cat]) =>
        cat?.auditRefs?.some?.(ref => ref.id === auditId)
      )?.[0] ?? 'unknown';

      const label = LIGHTHOUSE_LABELS[auditCategory] ?? auditCategory;

      violations.push({
        type:         'lighthouse_audit',
        category:     auditCategory,
        auditId,
        title:        audit.title,
        message:      `[${label}] ${audit.title}${audit.description ? ' — ' + audit.description.slice(0, 120) : ''}`,
        severity:     'warning',
        url,
      });
    }

  } catch (err) {
    console.warn(`[ARGUS] Lighthouse audit skipped for ${url}: ${err.message}`);
  }

  return violations;
}

// ── API Frequency Analysis ─────────────────────────────────────────────────────

/**
 * Detect API endpoints called more than once in a single page load.
 * Groups by normalized URL + method. Flags duplicates with severity based
 * on call count and whether it looks like an accidental double-fetch.
 *
 * @param {object[]} networkReqs - All network requests from list_network_requests
 * @param {string} pageUrl - Page URL (for error reporting)
 * @returns {object[]} Bug entries for duplicate/excessive API calls
 */
function analyzeApiFrequency(networkReqs, pageUrl) {
  const bugs = [];

  // Only examine XHR/fetch calls — filter out static assets
  const staticExtensions = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|webp|avif)(\?|$)/i;
  const apiCalls = networkReqs.filter(req => {
    const u = req.url ?? '';
    if (staticExtensions.test(u)) return false;
    // Include if it has /api/, /graphql, /v1/, /v2/, or is XHR/fetch type
    return (
      /\/(api|graphql|rest|v\d+|_next\/data|trpc)\//i.test(u) ||
      req.resourceType === 'XHR' ||
      req.resourceType === 'Fetch' ||
      req.initiatorType === 'xmlhttprequest' ||
      req.initiatorType === 'fetch'
    );
  });

  // Group by method + normalized URL (strip query string for grouping key,
  // but keep it in the report so you can see the exact calls made)
  const groups = {};
  for (const req of apiCalls) {
    const method = (req.method ?? 'GET').toUpperCase();
    const normalized = normalizeApiUrl(req.url);
    const key = `${method}::${normalized}`;
    if (!groups[key]) {
      groups[key] = { method, normalizedUrl: normalized, calls: [], key };
    }
    groups[key].calls.push({
      url: req.url,
      status: req.status,
      duration: req.duration ?? req.time ?? null,
      initiator: req.initiator ?? null,
    });
  }

  // Report groups with more than one call
  for (const group of Object.values(groups)) {
    const count = group.calls.length;
    if (count <= 1) continue;

    // Determine severity:
    //   2 calls  → info (might be intentional: prefetch + actual)
    //   3–4 calls → warning (likely a bug: double render, missing dependency array)
    //   5+ calls  → critical (runaway loop, missing cleanup)
    let severity = 'info';
    if (count >= 5) severity = 'critical';
    else if (count >= 3) severity = 'warning';

    const durations = group.calls
      .map(c => c.duration)
      .filter(Boolean)
      .map(d => `${Math.round(d)}ms`);

    bugs.push({
      type: 'api_duplicate_call',
      method: group.method,
      endpoint: group.normalizedUrl,
      callCount: count,
      calls: group.calls,
      durations,
      message: `API called ${count}x in one page load: ${group.method} ${group.normalizedUrl}${count >= 5 ? ' — possible infinite loop or missing cleanup' : count >= 3 ? ' — likely double-fetch bug (check useEffect deps or component re-mounts)' : ' — called twice (verify this is intentional)'}`,
      severity,
      url: pageUrl,
    });
  }

  // Also report total unique API calls as an info summary
  const uniqueCount = Object.keys(groups).length;
  const totalCount = apiCalls.length;
  if (totalCount > 0) {
    bugs.push({
      type: 'api_call_summary',
      uniqueEndpoints: uniqueCount,
      totalCalls: totalCount,
      duplicateEndpoints: Object.values(groups).filter(g => g.calls.length > 1).length,
      message: `API summary: ${totalCount} calls to ${uniqueCount} unique endpoints${Object.values(groups).filter(g => g.calls.length > 1).length > 0 ? ` (${Object.values(groups).filter(g => g.calls.length > 1).length} called more than once)` : ''}`,
      severity: 'info',
      url: pageUrl,
    });
  }

  return bugs;
}

/**
 * Normalize an API URL for grouping: strip query params, collapse IDs.
 * e.g. /api/users/123/posts?page=2 → /api/users/{id}/posts
 */
function normalizeApiUrl(url) {
  try {
    const u = new URL(url);
    // Collapse numeric segments and UUIDs to {id}
    const pathname = u.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
      .replace(/\/\d+/g, '/{id}');
    return `${u.hostname}${pathname}`;
  } catch {
    return url.replace(/[?#].*/, '').replace(/\/\d+/g, '/{id}');
  }
}

// ── Per-Route Crawl ────────────────────────────────────────────────────────────

/**
 * Crawl a single route using Chrome DevTools MCP tools.
 *
 * NOTE: In Claude Code with MCP connected, Claude will call these MCP tools
 * directly. This function documents the expected call sequence and data shapes.
 * The MCP tool responses are passed in as parameters when Claude orchestrates
 * this flow.
 *
 * @param {object} route - Route definition from targets.js
 * @param {string} baseUrl - Base URL to prepend to route.path
 * @param {object} mcp - MCP tool callables (injected by Claude Code orchestration)
 * @returns {object} Route result object
 */
export async function crawlRoute(route, baseUrl, mcp) {
  const url = `${baseUrl}${route.path}`;
  const result = {
    route: route.name,
    url,
    crawledAt: new Date().toISOString(),
    errors: [],
    screenshot: null,
    pageTitle: null,
    isBlankPage: false,
  };

  // 1. Inject error listener before navigation (or immediately after)
  await mcp.evaluate_script({ function:INJECT_ERROR_LISTENER });

  // 2. Navigate to the URL
  await mcp.navigate_page({ url });

  // 3. Wait for page settle (either selector or fixed delay)
  if (route.waitFor) {
    await mcp.wait_for({ selector: route.waitFor, timeout: 10000 }).catch(() => {
      // selector didn't appear — page may have failed to load
      result.errors.push({
        type: 'load_failure',
        message: `Selector "${route.waitFor}" not found after 10s — page may not have loaded`,
        severity: route.critical ? 'critical' : 'warning',
        url,
      });
    });
  } else {
    await new Promise(r => setTimeout(r, config.pageSettleMs));
  }

  // 4. Check for blank/error page
  const titleResult = await mcp.evaluate_script({ function:'document.title' });
  result.pageTitle = titleResult?.result ?? '';
  const bodyText = await mcp.evaluate_script({ function:'document.body?.innerText?.trim() ?? ""' });
  result.isBlankPage = !bodyText?.result || bodyText.result.length < 50;

  if (result.isBlankPage) {
    result.errors.push({
      type: 'blank_page',
      message: `Page appears blank or nearly empty (body text length < 50 chars)`,
      severity: 'critical',
      url,
    });
  }

  // 5. Capture console messages
  const consoleMsgs = await mcp.list_console_messages();
  for (const msg of consoleMsgs ?? []) {
    const severity = classifyConsoleMessage(msg, route.critical);
    if (severity !== null && msg.level !== 'log') {
      result.errors.push({
        type: 'console',
        level: msg.level,
        message: msg.text ?? msg.message ?? String(msg),
        source: msg.source ?? null,
        line: msg.lineNumber ?? null,
        severity,
        url,
      });
    }
  }

  // 6. Capture network requests — filter for failures + frequency analysis
  const networkReqs = await mcp.list_network_requests();
  for (const req of networkReqs ?? []) {
    const severity = classifyNetworkRequest(req, route.critical);
    if (severity !== null) {
      result.errors.push({
        type: 'network',
        method: req.method ?? 'GET',
        requestUrl: req.url,
        status: req.status,
        statusText: req.statusText ?? null,
        message: `HTTP ${req.status}${req.statusText ? ` ${req.statusText}` : ''} — ${req.method ?? 'GET'} ${req.url}`,
        severity,
        url,
      });
    }
  }

  // 6b. API frequency analysis — detect endpoints called multiple times
  const apiFrequencyBugs = analyzeApiFrequency(networkReqs ?? [], url);
  result.errors.push(...apiFrequencyBugs);

  // 7. Extract injected uncaught exceptions
  const injectedErrors = await mcp.evaluate_script({ function:EXTRACT_ERROR_LISTENER });
  try {
    const parsed = JSON.parse(injectedErrors?.result ?? '[]');
    for (const err of parsed) {
      result.errors.push({
        type: err.type,
        message: err.message,
        stack: err.stack,
        source: err.source ?? null,
        line: err.line ?? null,
        severity: route.critical ? 'critical' : 'warning',
        url,
      });
    }
  } catch {
    // parse failure — injected listener may not have run
  }

  // 8. Performance budget check
  const perfViolations = await checkPerformanceBudgets(mcp, url);
  result.errors.push(...perfViolations);

  // 9. Full Lighthouse audit (v3: accessibility + performance + SEO + best-practices)
  const lighthouseViolations = await checkLighthouse(mcp, url);
  result.errors.push(...lighthouseViolations);

  // 10. CSS analysis (always runs — provides style health data)
  try {
    const cssRaw = await mcp.evaluate_script({ function:CSS_ANALYSIS_SCRIPT });
    const cssResult = typeof cssRaw === 'object' ? (cssRaw?.result ?? cssRaw) : cssRaw;
    const cssBugs = parseCssAnalysisResult(cssResult, url);
    result.errors.push(...cssBugs);
  } catch (err) {
    console.warn(`[ARGUS] CSS analysis skipped for ${url}: ${err.message}`);
  }

  // 11. Deduplicate
  result.errors = deduplicateErrors(result.errors);

  // 11. Take screenshot
  const screenshotPath = path.join(OUTPUT_DIR, `screenshot-${slugify(route.name)}-${Date.now()}.png`);
  const screenshotData = await mcp.take_screenshot({ format: 'png' });
  if (screenshotData?.data) {
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));
    result.screenshot = screenshotPath;
  }

  return result;
}

// ── Main Orchestration ─────────────────────────────────────────────────────────

/**
 * Main entry point. Run all routes, collect results, write JSON report.
 * In production Claude Code orchestration, `mcp` is provided by the agent.
 * When called directly via `node`, a mock mcp object is used for structure validation.
 *
 * @param {object} mcp - Chrome DevTools MCP tool interface
 */
export async function runCrawl(mcp, routeOverrides = null, baseUrlOverride = null) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const targetRoutes = routeOverrides ?? routes;
  const targetBaseUrl = baseUrlOverride ?? BASE_URL;

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: targetBaseUrl,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    routes: [],
  };

  for (const route of targetRoutes) {
    console.log(`[ARGUS] Crawling: ${route.name} → ${targetBaseUrl}${route.path}`);
    const result = await crawlRoute(route, targetBaseUrl, mcp);
    report.routes.push(result);

    for (const err of result.errors) {
      report.summary.total++;
      report.summary[err.severity] = (report.summary[err.severity] ?? 0) + 1;
    }
  }

  // Write JSON report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(OUTPUT_DIR, `error-report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[ARGUS] Report written: ${reportPath}`);

  // Dispatch to Slack
  await dispatchToSlack(report);

  return report;
}

/**
 * Safely extract the display message from any error object.
 * Handles network errors (use message field), console errors, CSS findings, etc.
 */
function errorText(e) {
  return e.message
    ?? e.description
    ?? (e.requestUrl ? `HTTP ${e.status ?? '?'} — ${e.method ?? 'GET'} ${e.requestUrl}` : null)
    ?? `${e.type ?? 'unknown error'}`;
}

/**
 * Send Slack notifications for bugs found in the report.
 *
 * Criticals  → one message per route with screenshot attached
 * Warnings   → one message per route (grouped), first route's screenshot attached
 * Info       → single digest message summarising all routes (no screenshot)
 */
async function dispatchToSlack(report) {
  const { summary } = report;

  // ── Criticals: one Slack message per affected route ──────────────────────
  for (const routeResult of report.routes) {
    const criticals = routeResult.errors.filter(e => e.severity === 'critical');
    if (criticals.length === 0) continue;

    const description = criticals
      .map(e => `• *[${e.type}]* ${errorText(e)}`)
      .join('\n');

    await postBugReport({
      severity: 'critical',
      title: `${criticals.length} critical issue(s) on ${routeResult.route}`,
      description,
      url: routeResult.url,
      screenshotPath: routeResult.screenshot,
      details: { route: routeResult.route, errors: criticals },
    });
  }

  // ── Warnings: one Slack message per affected route ────────────────────────
  for (const routeResult of report.routes) {
    const warnings = routeResult.errors.filter(e => e.severity === 'warning');
    if (warnings.length === 0) continue;

    const description = warnings
      .map(e => `• *[${e.type}]* ${errorText(e)}`)
      .join('\n');

    await postBugReport({
      severity: 'warning',
      title: `${warnings.length} warning(s) on ${routeResult.route}`,
      description,
      url: routeResult.url,
      screenshotPath: routeResult.screenshot,
      details: { route: routeResult.route, errors: warnings },
    });
  }

  // ── Info digest: one summary message across all routes ────────────────────
  const allInfos = report.routes.flatMap(r =>
    r.errors.filter(e => e.severity === 'info').map(e => ({ ...e, routeName: r.route }))
  );

  // Skip pure noise: don't post digest if only api_call_summary / css_summary with no issues
  const meaningfulInfos = allInfos.filter(e =>
    !['api_call_summary', 'css_summary', 'css_modules_detected'].includes(e.type)
  );
  const summaryInfos = allInfos.filter(e =>
    ['css_summary'].includes(e.type)
  );

  // Build route-grouped digest body
  const digestLines = [];
  for (const routeResult of report.routes) {
    const routeInfos = allInfos.filter(e => e.routeName === routeResult.route);
    if (routeInfos.length === 0) continue;
    digestLines.push(`*${routeResult.route}* (${routeResult.url})`);
    for (const e of routeInfos) {
      digestLines.push(`  • [${e.type}] ${errorText(e)}`);
    }
  }

  if (allInfos.length > 0) {
    const runDate = new Date(report.generatedAt).toLocaleString();
    await postBugReport({
      severity: 'info',
      title: `Argus crawl digest — ${report.baseUrl} (${runDate})`,
      description:
        `Summary: ${summary.total} findings across ${report.routes.length} routes\n` +
        `:red_circle: ${summary.critical} critical  :large_yellow_circle: ${summary.warning} warnings  :large_blue_circle: ${summary.info} info\n\n` +
        (digestLines.length > 0 ? digestLines.join('\n') : '_No info-level findings._'),
      url: report.baseUrl,
      screenshotPath: null,
      details: { summary, infos: allInfos },
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── CLI Entry ──────────────────────────────────────────────────────────────────

// When Claude Code orchestrates this, it calls runCrawl(mcp) with real MCP tools.
// This block shows how a direct CLI invocation would work with a stub.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('[ARGUS] crawl-and-report.js loaded. Invoke runCrawl(mcp) from Claude Code with MCP tools connected.');
  console.log('[ARGUS] Target base URL:', BASE_URL);
  console.log('[ARGUS] Routes to crawl:', routes.map(r => r.path).join(', '));
}
