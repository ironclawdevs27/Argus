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

import { routes, config, auth, flows } from '../config/targets.js';
import { postBugReport } from './slack-notifier.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../utils/css-analyzer.js';
import { SEO_ANALYSIS_SCRIPT, parseSeoAnalysisResult } from '../utils/seo-analyzer.js';
import { SECURITY_ANALYSIS_SCRIPT, parseSecurityAnalysisResult, analyzeSecurityConsole, analyzeSecurityNetwork } from '../utils/security-analyzer.js';
import { CONTENT_ANALYSIS_SCRIPT, parseContentAnalysisResult } from '../utils/content-analyzer.js';
import { analyzeResponsive } from '../utils/responsive-analyzer.js';
import { analyzeMemory } from '../utils/memory-analyzer.js';
import { runLoginFlow, saveSession, restoreSession, hasSession } from '../utils/session-manager.js';
import { loadBaseline, saveBaseline, applyBaseline, appendTrend } from '../utils/baseline-manager.js';
import { mergeRunResults } from '../utils/flakiness-detector.js';
import { runAllFlows, normalizeArray } from '../utils/flow-runner.js';
import { analyzeApiFrequency } from '../utils/api-frequency.js';
import { slugify } from '../utils/slug.js';
import { unwrapEval } from '../utils/mcp-client.js';
import { checkLighthouse } from '../utils/lighthouse-checker.js';

// ── Performance Budgets ────────────────────────────────────────────────────────
// Hard thresholds — exceeding any of these is a 'warning' severity bug.
// Adjust in src/config/targets.js or via env vars in the future.
const PERF_BUDGETS = {
  LCP: 2500,   // Largest Contentful Paint — ms
  CLS: 0.1,    // Cumulative Layout Shift — score
  FID: 100,    // First Input Delay — ms (approximated via TBT in traces)
  TTFB: 800,   // Time to First Byte — ms
};

// ── Network Performance Thresholds (v3 Phase A2) ──────────────────────────────
const NETWORK_PERF_THRESHOLDS = {
  slowWarning:   1000,           // ms  — API response time warning
  slowCritical:  3000,           // ms  — API response time critical
  sizeWarning:   500 * 1024,     // 500 KB — payload size warning
  sizeCritical:  2 * 1024 * 1024, // 2 MB  — payload size critical
};

// PerformanceResourceTiming fields captured for network-perf analysis.
const NETWORK_PERF_SCRIPT = `() => window.performance.getEntriesByType('resource').map(function(e){return{url:e.name,resourceType:e.initiatorType,duration:Math.round(e.duration||0),transferSize:e.transferSize||0,decodedBodySize:e.decodedBodySize||0}})`;

// D6.6 — Same-origin static assets missing both Cache-Control and ETag response headers.
// HEAD-requests each unique same-origin asset URL (capped at 25) after page settle.
const CACHE_HEADER_SCRIPT = `async () => {
  var ASSET_EXT = /\\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)(\\?.*)?$/i;
  var origin = window.location.origin;
  var seen = {};
  var candidates = window.performance.getEntriesByType('resource')
    .map(function(e){ return e.name; })
    .filter(function(u){
      if (!u.startsWith(origin) || !ASSET_EXT.test(u)) return false;
      if (seen[u]) return false;
      seen[u] = true;
      return true;
    })
    .slice(0, 25);
  var missing = [];
  await Promise.all(candidates.map(async function(assetUrl){
    try {
      var r = await fetch(assetUrl, { method: 'HEAD', cache: 'reload', credentials: 'same-origin' });
      if (!r.headers.get('cache-control') && !r.headers.get('etag')) {
        missing.push({ url: assetUrl });
      }
    } catch(e) {}
  }));
  return JSON.stringify(missing);
}`;

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

// ── D6.2 — document.write / document.writeln detection ───────────────────────

/** Patches document.write and document.writeln before navigation to record calls. */
const INJECT_DOC_WRITE_LISTENER = `
(function() {
  if (window.__argusDocWritePatched) return;
  window.__argusDocWritePatched = true;
  window.__argusDocWrites = [];
  var _write   = document.write.bind(document);
  var _writeln = document.writeln.bind(document);
  document.write = function() {
    window.__argusDocWrites.push({ method: 'write', content: String(arguments[0] ?? '').slice(0, 200) });
    return _write.apply(document, arguments);
  };
  document.writeln = function() {
    window.__argusDocWrites.push({ method: 'writeln', content: String(arguments[0] ?? '').slice(0, 200) });
    return _writeln.apply(document, arguments);
  };
})();
`;

/** Extracts the list of document.write calls recorded by the injected listener. */
const EXTRACT_DOC_WRITE_LISTENER = `() => JSON.stringify(window.__argusDocWrites ?? [])`;

// ── D6.5 — Service worker registration failure detection ─────────────────────

/** Patches navigator.serviceWorker.register before navigation to intercept failures. */
const INJECT_SW_LISTENER = `
(function() {
  if (window.__argusSwPatched) return;
  window.__argusSwPatched = true;
  window.__argusSwErrors = [];
  if (!navigator.serviceWorker) return;
  var _register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
  navigator.serviceWorker.register = function(scriptURL, options) {
    var reg = _register(scriptURL, options);
    reg.catch(function(err) {
      window.__argusSwErrors.push({
        scriptURL: String(scriptURL || ''),
        message:   err && err.message ? err.message : String(err),
      });
    });
    return reg;
  };
})();
`;

/** Extracts the list of service worker registration failures recorded by the listener. */
const EXTRACT_SW_LISTENER = `() => JSON.stringify(window.__argusSwErrors ?? [])`;

// ── D6.7 — debugger; statement detection ─────────────────────────────────────

// Runs post-load: scans inline scripts via DOM and fetches same-origin external
// scripts to check for \bdebugger\s*; — always critical (debug code in production).
const DEBUGGER_SCRIPT = `async () => {
  var found = [];
  var inline = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < inline.length; i++) {
    var src = inline[i].textContent || '';
    var lines = src.split('\\n');
    for (var ln = 0; ln < lines.length; ln++) {
      if (/\\bdebugger\\s*;/.test(lines[ln])) {
        found.push({ scriptUrl: '(inline)', line: ln + 1, snippet: lines[ln].trim().slice(0, 120) });
      }
    }
  }
  var origin = window.location.origin;
  var seen = {};
  var extUrls = window.performance.getEntriesByType('resource')
    .filter(function(e){ return e.initiatorType === 'script' && e.name.startsWith(origin); })
    .map(function(e){ return e.name; })
    .filter(function(u){ if (seen[u]) return false; seen[u] = true; return true; })
    .slice(0, 20);
  await Promise.all(extUrls.map(async function(scriptUrl) {
    try {
      var r = await fetch(scriptUrl, { cache: 'force-cache', credentials: 'same-origin' });
      var text = await r.text();
      var lines = text.split('\\n');
      for (var ln = 0; ln < lines.length; ln++) {
        if (/\\bdebugger\\s*;/.test(lines[ln])) {
          var filename = scriptUrl.replace(/^.*\\//, '').split('?')[0];
          found.push({ scriptUrl: filename || scriptUrl, line: ln + 1, snippet: lines[ln].trim().slice(0, 120) });
        }
      }
    } catch(e) {}
  }));
  return JSON.stringify(found);
}`;

// ── D6.3 — Long task (>50 ms) detection ──────────────────────────────────────

/** Registers a PerformanceObserver for 'longtask' entries before navigation. */
const INJECT_LONG_TASK_LISTENER = `
(function() {
  if (window.__argusLongTaskPatched) return;
  window.__argusLongTaskPatched = true;
  window.__argusLongTasks = [];
  try {
    var obs = new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var attr = e.attribution && e.attribution[0];
        window.__argusLongTasks.push({
          duration:  Math.round(e.duration),
          startTime: Math.round(e.startTime),
          attribution: attr ? {
            name:          attr.name          || null,
            containerType: attr.containerType || null,
            containerSrc:  attr.containerSrc  || null,
          } : null,
        });
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch (e) { /* longtask not supported — skip */ }
})();
`;

/** Extracts the list of long-task entries recorded by the PerformanceObserver. */
const EXTRACT_LONG_TASK_LISTENER = `() => JSON.stringify(window.__argusLongTasks ?? [])`;

// ── D6.1 — Synchronous XHR detection ─────────────────────────────────────────

/** Patches XMLHttpRequest.prototype.open before navigation to record sync calls. */
const INJECT_SYNC_XHR_LISTENER = `
(function() {
  if (window.__argusSyncXhrPatched) return;
  window.__argusSyncXhrPatched = true;
  window.__argusSyncXhrs = [];
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async) {
    if (async === false) {
      window.__argusSyncXhrs.push({ method: String(method || 'GET'), url: String(url) });
    }
    return _open.apply(this, arguments);
  };
})();
`;

/** Extracts the list of synchronous XHR calls recorded by the injected listener. */
const EXTRACT_SYNC_XHR_LISTENER = `() => JSON.stringify(window.__argusSyncXhrs ?? [])`;

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

// ── Redirect Chain Detection Script (D2.1) ────────────────────────────────────
// Navigation Timing API — redirectCount is the number of HTTP redirects followed
// before the final document was received. Present in all modern browsers.
const REDIRECT_COUNT_SCRIPT = `() => window.performance.getEntriesByType('navigation')[0]?.redirectCount ?? 0`;

// ── Internal Link Collection Script (D2.3) ────────────────────────────────────
// Returns absolute hrefs for same-origin <a> links, skipping anchors/mailto/tel.
const INTERNAL_LINKS_SCRIPT = `() => {
  try {
    var orig = window.location.origin;
    return Array.from(document.querySelectorAll('a[href]'))
      .map(function(a) { return a.href; })
      .filter(function(h) {
        if (!h || h.indexOf('#') === 0 || h.indexOf('mailto:') === 0 || h.indexOf('tel:') === 0) return false;
        try { return new URL(h).origin === orig; } catch { return false; }
      });
  } catch (e) { return []; }
}`;

// ── Network Performance Analysis (v3 Phase A2) ────────────────────────────────

/**
 * Detect slow API responses and oversized payloads using PerformanceResourceTiming.
 * Only applies to API-like requests (skips static assets such as JS/CSS/images).
 *
 * @param {object[]} perfEntries - Entries from window.performance.getEntriesByType('resource')
 * @param {string} pageUrl - Page URL (for error context)
 * @returns {object[]} Bug entries
 */
function analyzeNetworkPerformance(perfEntries, pageUrl) {
  const bugs = [];
  const staticExt = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;

  for (const entry of perfEntries) {
    const reqUrl = entry.url ?? '';
    if (staticExt.test(reqUrl)) continue;
    if (
      !/\/(api|graphql|rest|v\d+)\//i.test(reqUrl) &&
      !['xmlhttprequest', 'fetch', 'xhr'].includes((entry.resourceType ?? '').toLowerCase())
    ) continue;

    const duration = entry.duration ?? 0;
    // Prefer decodedBodySize (uncompressed) — transferSize is the wire size (may be compressed).
    const payloadBytes = entry.decodedBodySize || entry.transferSize || 0;

    // Slow response check
    if (duration > NETWORK_PERF_THRESHOLDS.slowCritical) {
      bugs.push({
        type:      'slow_api',
        requestUrl: reqUrl,
        duration:  Math.round(duration),
        threshold: NETWORK_PERF_THRESHOLDS.slowCritical,
        message:   `Slow API response ${Math.round(duration)} ms — ${reqUrl} (critical threshold: ${NETWORK_PERF_THRESHOLDS.slowCritical} ms)`,
        severity:  'critical',
        url:       pageUrl,
      });
    } else if (duration > NETWORK_PERF_THRESHOLDS.slowWarning) {
      bugs.push({
        type:      'slow_api',
        requestUrl: reqUrl,
        duration:  Math.round(duration),
        threshold: NETWORK_PERF_THRESHOLDS.slowWarning,
        message:   `Slow API response ${Math.round(duration)} ms — ${reqUrl} (warning threshold: ${NETWORK_PERF_THRESHOLDS.slowWarning} ms)`,
        severity:  'warning',
        url:       pageUrl,
      });
    }

    // Payload size check
    if (payloadBytes > NETWORK_PERF_THRESHOLDS.sizeCritical) {
      bugs.push({
        type:      'large_payload',
        requestUrl: reqUrl,
        bytes:     payloadBytes,
        threshold: NETWORK_PERF_THRESHOLDS.sizeCritical,
        message:   `Oversized API payload ${Math.round(payloadBytes / 1024)} KB — ${reqUrl} (critical threshold: 2 MB)`,
        severity:  'critical',
        url:       pageUrl,
      });
    } else if (payloadBytes > NETWORK_PERF_THRESHOLDS.sizeWarning) {
      bugs.push({
        type:      'large_payload',
        requestUrl: reqUrl,
        bytes:     payloadBytes,
        threshold: NETWORK_PERF_THRESHOLDS.sizeWarning,
        message:   `Oversized API payload ${Math.round(payloadBytes / 1024)} KB — ${reqUrl} (warning threshold: 500 KB)`,
        severity:  'warning',
        url:       pageUrl,
      });
    }
  }

  return bugs;
}

// ── Per-Route Crawl (D3 split: cheap × 2 + expensive × 1) ────────────────────

/**
 * Cheap detections for one route — called TWICE per route for flakiness detection.
 * Runs: console, network, JS errors, blank page, API frequency,
 *       SEO, security, content, CSS, debugger statements, screenshot.
 * Does NOT run: Lighthouse, perf budgets, network perf, redirect chain, broken links, cache headers.
 */
async function crawlRouteCheap(route, baseUrl, mcp) {
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

  // 0. Snapshot session-wide console/network counts BEFORE this route starts (D5).
  const consoleBaseline = normalizeArray(await mcp.list_console_messages().catch(() => [])).length;
  const networkBaseline = normalizeArray(await mcp.list_network_requests().catch(() => [])).length;

  // 1. Inject error listener before navigation
  await mcp.evaluate_script({ function:INJECT_ERROR_LISTENER });
  // 1b. Inject sync XHR listener (D6.1) — patches XMLHttpRequest.prototype.open
  await mcp.evaluate_script({ function:INJECT_SYNC_XHR_LISTENER });
  // 1c. Inject document.write listener (D6.2)
  await mcp.evaluate_script({ function:INJECT_DOC_WRITE_LISTENER });
  // 1d. Inject long-task PerformanceObserver (D6.3)
  await mcp.evaluate_script({ function:INJECT_LONG_TASK_LISTENER });
  // 1e. Inject service worker registration listener (D6.5)
  await mcp.evaluate_script({ function:INJECT_SW_LISTENER });

  // 2. Navigate to the URL
  await mcp.navigate_page({ url });

  // 3. Wait for page settle
  if (route.waitFor) {
    await mcp.wait_for({ selector: route.waitFor, timeout: 10000 }).catch(() => {
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

  // 4. Blank/error page check
  const titleResult = await mcp.evaluate_script({ function:'document.title' });
  result.pageTitle = String(unwrapEval(titleResult) ?? '');
  const bodyText = await mcp.evaluate_script({ function:'document.body?.innerText?.trim() ?? ""' });
  const bodyTextVal = String(unwrapEval(bodyText) ?? '');
  result.isBlankPage = !bodyTextVal || bodyTextVal.length < 50;
  if (result.isBlankPage) {
    result.errors.push({
      type: 'blank_page',
      message: `Page appears blank or nearly empty (body text length < 50 chars)`,
      severity: 'critical',
      url,
    });
  }

  // 5. Console messages — sliced from per-route baseline (D5)
  const consoleMsgs = normalizeArray(await mcp.list_console_messages()).slice(consoleBaseline);
  for (const msg of consoleMsgs) {
    const text = (msg.text ?? msg.message ?? '');
    // CORS messages are handled exclusively in step 5b (D6.4)
    if (text.toLowerCase().includes('has been blocked by cors policy')) continue;
    const severity = classifyConsoleMessage(msg, route.critical);
    if (severity !== null && msg.level !== 'log') {
      result.errors.push({
        type: 'console',
        level: msg.level,
        message: text || String(msg),
        source: msg.source ?? null,
        line: msg.lineNumber ?? null,
        severity,
        url,
      });
    }
  }

  // 5b. CORS error detection (D6.4) — always critical regardless of route type
  for (const msg of consoleMsgs) {
    const text = (msg.text ?? msg.message ?? '');
    if (text.toLowerCase().includes('has been blocked by cors policy')) {
      result.errors.push({
        type:     'cors_error',
        message:  text || 'CORS policy violation',
        severity: 'critical',
        url,
      });
    }
  }

  // 6. Network requests — sliced from per-route baseline (D5)
  const networkReqs = normalizeArray(await mcp.list_network_requests()).slice(networkBaseline);
  for (const req of networkReqs) {
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

  // 6b. API frequency analysis
  const apiFrequencyBugs = analyzeApiFrequency(networkReqs, url);
  result.errors.push(...apiFrequencyBugs);

  // 7. Extract injected uncaught exceptions
  const injectedErrors = await mcp.evaluate_script({ function:EXTRACT_ERROR_LISTENER });
  try {
    const rawInjected = unwrapEval(injectedErrors);
    const parsed = Array.isArray(rawInjected) ? rawInjected
      : JSON.parse(typeof rawInjected === 'string' ? rawInjected : '[]');
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

  // 7b. Sync XHR detection (D6.1)
  try {
    const syncXhrRaw = await mcp.evaluate_script({ function: EXTRACT_SYNC_XHR_LISTENER });
    const rawSyncXhr = unwrapEval(syncXhrRaw);
    const syncXhrs   = Array.isArray(rawSyncXhr) ? rawSyncXhr
      : JSON.parse(typeof rawSyncXhr === 'string' ? rawSyncXhr : '[]');
    for (const entry of syncXhrs) {
      result.errors.push({
        type:       'sync_xhr',
        method:     entry.method,
        requestUrl: entry.url,
        message:    `Synchronous XHR: ${entry.method} ${entry.url} — blocks the main thread`,
        severity:   'warning',
        url,
      });
    }
  } catch {
    // parse failure — listener may not have been active
  }

  // 7c. document.write detection (D6.2)
  try {
    const docWriteRaw = await mcp.evaluate_script({ function: EXTRACT_DOC_WRITE_LISTENER });
    const rawDocWrite = unwrapEval(docWriteRaw);
    const docWrites   = Array.isArray(rawDocWrite) ? rawDocWrite
      : JSON.parse(typeof rawDocWrite === 'string' ? rawDocWrite : '[]');
    for (const entry of docWrites) {
      result.errors.push({
        type:     'document_write',
        method:   entry.method,
        content:  entry.content,
        message:  `document.${entry.method}() is parser-blocking and degrades page performance`,
        severity: 'warning',
        url,
      });
    }
  } catch {
    // parse failure — listener may not have been active
  }

  // 7d. Long task detection (D6.3)
  try {
    const longTaskRaw = await mcp.evaluate_script({ function: EXTRACT_LONG_TASK_LISTENER });
    const rawLongTasks = unwrapEval(longTaskRaw);
    const longTasks    = Array.isArray(rawLongTasks) ? rawLongTasks
      : JSON.parse(typeof rawLongTasks === 'string' ? rawLongTasks : '[]');
    for (const entry of longTasks) {
      result.errors.push({
        type:      'long_task',
        duration:  entry.duration,
        startTime: entry.startTime,
        attribution: entry.attribution,
        message:   `Long task: ${entry.duration}ms — blocks the main thread (threshold: 50ms)`,
        severity:  'warning',
        url,
      });
    }
  } catch {
    // PerformanceObserver not available or parse failure
  }

  // 7e. Service worker registration failure detection (D6.5)
  try {
    const swRaw  = await mcp.evaluate_script({ function: EXTRACT_SW_LISTENER });
    const rawSw  = unwrapEval(swRaw);
    const swErrs = Array.isArray(rawSw) ? rawSw
      : JSON.parse(typeof rawSw === 'string' ? rawSw : '[]');
    for (const entry of swErrs) {
      result.errors.push({
        type:      'sw_registration_error',
        scriptURL: entry.scriptURL,
        message:   `Service worker registration failed for "${entry.scriptURL}": ${entry.message}`,
        severity:  'warning',
        url,
      });
    }
  } catch {
    // service worker not supported or parse failure
  }

  // 7f. debugger; statement detection (D6.7)
  try {
    const dbgRaw  = await mcp.evaluate_script({ function: DEBUGGER_SCRIPT });
    const rawDbg  = unwrapEval(dbgRaw);
    const dbgHits = Array.isArray(rawDbg) ? rawDbg
      : JSON.parse(typeof rawDbg === 'string' ? rawDbg : '[]');
    for (const entry of dbgHits) {
      result.errors.push({
        type:      'debugger_statement',
        scriptUrl: entry.scriptUrl,
        line:      entry.line,
        snippet:   entry.snippet,
        message:   `debugger; statement found in "${entry.scriptUrl}" (line ${entry.line}) — remove before shipping`,
        severity:  'critical',
        url,
      });
    }
  } catch {
    // parse failure
  }

  // 9b. SEO DOM checks (v3 Phase A3)
  try {
    const seoRaw = await mcp.evaluate_script({ function: SEO_ANALYSIS_SCRIPT });
    const seoResult = unwrapEval(seoRaw);
    result.errors.push(...parseSeoAnalysisResult(seoResult, url));
  } catch (err) {
    console.warn(`[ARGUS] SEO analysis skipped for ${url}: ${err.message}`);
  }

  // 9c. Security checks (v3 Phase A4)
  try {
    const secRaw = await mcp.evaluate_script({ function: SECURITY_ANALYSIS_SCRIPT });
    const secResult = unwrapEval(secRaw);
    result.errors.push(...parseSecurityAnalysisResult(secResult, url));
  } catch (err) {
    console.warn(`[ARGUS] Security DOM analysis skipped for ${url}: ${err.message}`);
  }
  result.errors.push(...analyzeSecurityConsole(consoleMsgs, url));
  result.errors.push(...analyzeSecurityNetwork(networkReqs, url));

  // 9d. Content quality checks (v3 Phase A5)
  try {
    const contentRaw = await mcp.evaluate_script({ function: CONTENT_ANALYSIS_SCRIPT });
    const contentResult = unwrapEval(contentRaw);
    result.errors.push(...parseContentAnalysisResult(contentResult, url));
  } catch (err) {
    console.warn(`[ARGUS] Content analysis skipped for ${url}: ${err.message}`);
  }

  // 10. CSS analysis
  try {
    const cssRaw = await mcp.evaluate_script({ function:CSS_ANALYSIS_SCRIPT });
    const cssResult = unwrapEval(cssRaw);
    result.errors.push(...parseCssAnalysisResult(cssResult, url));
  } catch (err) {
    console.warn(`[ARGUS] CSS analysis skipped for ${url}: ${err.message}`);
  }

  // 11. Deduplicate within this single cheap run
  result.errors = deduplicateErrors(result.errors);

  // 12. Screenshot
  const screenshotPath = path.join(OUTPUT_DIR, `screenshot-${slugify(route.name)}-${Date.now()}.png`);
  const screenshotData = await mcp.take_screenshot({ format: 'png' });
  if (screenshotData?.data) {
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));
    result.screenshot = screenshotPath;
  }

  return result;
}

/**
 * Expensive/deterministic analyzers for one route — called ONCE per route (D3).
 * Navigates to the URL, then runs: network perf, redirect chain,
 * performance budgets, Lighthouse, broken internal links, cache headers (D6.6).
 * Returns an array of finding objects (no result wrapper).
 */
async function crawlRouteExpensive(route, baseUrl, mcp) {
  const url = `${baseUrl}${route.path}`;
  const errors = [];

  // Navigate to a fresh page load so perf trace and redirect count are accurate
  try {
    await mcp.navigate_page({ url });
    if (route.waitFor) {
      await mcp.wait_for({ selector: route.waitFor, timeout: 10000 }).catch(() => {});
    } else {
      await new Promise(r => setTimeout(r, config.pageSettleMs));
    }
  } catch (err) {
    console.warn(`[ARGUS] Expensive crawl: navigation failed for ${url}: ${err.message}`);
    return errors;
  }

  // 6c. Network performance analysis — slow responses + oversized payloads (v3 Phase A2)
  try {
    const perfRaw = await mcp.evaluate_script({ function: NETWORK_PERF_SCRIPT });
    const perfResult = unwrapEval(perfRaw);
    let perfEntries;
    if (Array.isArray(perfResult)) {
      perfEntries = perfResult;
    } else {
      perfEntries = JSON.parse(typeof perfResult === 'string' ? perfResult : '[]');
    }
    errors.push(...analyzeNetworkPerformance(Array.isArray(perfEntries) ? perfEntries : [], url));
  } catch (err) {
    console.warn(`[ARGUS] Network performance analysis skipped for ${url}: ${err.message}`);
  }

  // 6d. Redirect chain detection (D2.1)
  try {
    const rdRaw   = await mcp.evaluate_script({ function: REDIRECT_COUNT_SCRIPT });
    const rdCount = Number(unwrapEval(rdRaw) ?? 0);
    if (rdCount > 2) {
      errors.push({
        type:    'redirect_chain',
        count:   rdCount,
        message: `Redirect chain length ${rdCount} — navigated through ${rdCount} redirects (threshold: > 2)`,
        severity: 'warning',
        url,
      });
    }
  } catch (err) {
    console.warn(`[ARGUS] Redirect chain check skipped for ${url}: ${err.message}`);
  }

  // 8. Performance budget check
  errors.push(...(await checkPerformanceBudgets(mcp, url)));

  // 9. Full Lighthouse audit (accessibility + performance + SEO + best-practices)
  errors.push(...(await checkLighthouse(mcp, url)));

  // 10b. Broken internal link detection (D2.3)
  try {
    const linksRaw  = await mcp.evaluate_script({ function: INTERNAL_LINKS_SCRIPT });
    const rawLinks  = unwrapEval(linksRaw);
    const links     = [...new Set(Array.isArray(rawLinks) ? rawLinks.filter(Boolean) : [])];
    const headResults = await Promise.all(
      links.map(async href => {
        try {
          const res = await fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          return { href, status: res.status };
        } catch {
          return { href, status: 0 };
        }
      })
    );
    for (const { href, status } of headResults) {
      if (status === 404) {
        errors.push({
          type:       'broken_link',
          requestUrl: href,
          status:     404,
          message:    `Broken internal link: ${href} (HTTP 404)`,
          severity:   'warning',
          url,
        });
      }
    }
  } catch (err) {
    console.warn(`[ARGUS] Broken link check skipped for ${url}: ${err.message}`);
  }

  // 10c. Cache header detection — static assets missing Cache-Control + ETag (D6.6)
  try {
    const cacheRaw  = await mcp.evaluate_script({ function: CACHE_HEADER_SCRIPT });
    const rawCache  = unwrapEval(cacheRaw);
    const cacheItems = Array.isArray(rawCache) ? rawCache
      : JSON.parse(typeof rawCache === 'string' ? rawCache : '[]');
    for (const entry of cacheItems) {
      const filename = (entry.url ?? '').replace(/^.*\//, '').split('?')[0] || entry.url;
      errors.push({
        type:       'cache_headers_missing',
        requestUrl: entry.url,
        message:    `No cache headers on "${filename}" — missing both Cache-Control and ETag`,
        severity:   'info',
        url,
      });
    }
  } catch (err) {
    console.warn(`[ARGUS] Cache header check skipped for ${url}: ${err.message}`);
  }

  return errors;
}

// ── Per-route crawl + analysis (D3: cheap×2 merge + expensive×1) ──────────────

async function crawlAndAnalyzeRoute(route, targetBaseUrl, mcp, sessionFile) {
  if (auth?.steps?.length > 0) {
    try {
      await restoreSession(mcp, targetBaseUrl, sessionFile);
    } catch (err) {
      console.warn(`[ARGUS] Auth: session restore skipped for ${route.name}: ${err.message}`);
    }
  }

  // Cheap pass × 2: console, network, JS errors, SEO, security, content, CSS
  console.log(`[ARGUS] ${route.name}: cheap run 1/2...`);
  const cheapRun1 = await crawlRouteCheap(route, targetBaseUrl, mcp);
  console.log(`[ARGUS] ${route.name}: cheap run 2/2 (flakiness check)...`);
  const cheapRun2 = await crawlRouteCheap(route, targetBaseUrl, mcp);
  const result    = mergeRunResults(cheapRun1, cheapRun2);

  // Expensive pass × 1: Lighthouse, perf budgets, network perf, redirect chain, broken links
  console.log(`[ARGUS] ${route.name}: expensive analyzers (once)...`);
  const expensiveErrors = await crawlRouteExpensive(route, targetBaseUrl, mcp);
  result.errors.push(...expensiveErrors);
  result.errors = deduplicateErrors(result.errors);

  // Responsive layout analysis (v3 Phase A6) — once, after crawl to avoid viewport pollution
  try {
    const { findings: responsiveFindings, screenshots: responsiveShots } = await analyzeResponsive(mcp, `${targetBaseUrl}${route.path}`);
    result.errors.push(...responsiveFindings);
    const responsiveScreenshotPaths = {};
    for (const [viewport, data] of Object.entries(responsiveShots)) {
      const shotPath = path.join(OUTPUT_DIR, `screenshot-${slugify(route.name)}-responsive-${viewport}-${Date.now()}.png`);
      fs.writeFileSync(shotPath, Buffer.from(data, 'base64'));
      responsiveScreenshotPaths[viewport] = shotPath;
    }
    if (Object.keys(responsiveScreenshotPaths).length > 0) {
      result.responsiveScreenshots = responsiveScreenshotPaths;
    }
  } catch (err) {
    console.warn(`[ARGUS] Responsive analysis skipped for ${route.name}: ${err.message}`);
  }

  // Memory leak detection (v3 Phase B1) — once
  try {
    const memoryFindings = await analyzeMemory(mcp, `${targetBaseUrl}${route.path}`);
    result.errors.push(...memoryFindings);
  } catch (err) {
    console.warn(`[ARGUS] Memory analysis skipped for ${route.name}: ${err.message}`);
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
    flows: [],
  };

  // Auth session persistence (v3 Phase B2) — login once, restore before each route
  const sessionFile = auth?.sessionFile ?? '.argus-session.json';
  if (auth?.steps?.length > 0) {
    if (!hasSession(sessionFile, auth.sessionMaxAgeMs)) {
      console.log(`[ARGUS] Auth: running login flow (${auth.steps.length} steps)...`);
      try {
        await runLoginFlow(mcp, targetBaseUrl, auth.steps);
        await saveSession(mcp, sessionFile);
      } catch (err) {
        console.warn(`[ARGUS] Auth: login flow failed — crawl will proceed unauthenticated: ${err.message}`);
      }
    } else {
      console.log(`[ARGUS] Auth: reusing existing session from ${sessionFile}`);
    }
  }

  for (const route of targetRoutes) {
    // D3: cheap double-crawl (flakiness) + expensive single-crawl happen inside crawlAndAnalyzeRoute
    console.log(`[ARGUS] Crawling: ${route.name} → ${targetBaseUrl}${route.path}`);
    const result = await crawlAndAnalyzeRoute(route, targetBaseUrl, mcp, sessionFile);

    const flakyCount = result.errors.filter(e => e.flaky).length;
    if (flakyCount > 0) {
      console.log(`[ARGUS] ${route.name}: ${flakyCount} finding(s) downgraded to info (flaky — appeared in only one cheap run)`);
    }

    report.routes.push(result);

    for (const err of result.errors) {
      report.summary.total++;
      report.summary[err.severity] = (report.summary[err.severity] ?? 0) + 1;
    }
  }

  // User flow testing (v3 Phase B5) — named interaction sequences from targets.js flows[]
  if (flows?.length > 0) {
    console.log(`[ARGUS] Running ${flows.length} user flow(s)...`);
    const { results: flowResults, findings: flowFindings } = await runAllFlows(flows, targetBaseUrl, mcp);
    report.flows = flowResults;
    for (const finding of flowFindings) {
      report.summary.total++;
      report.summary[finding.severity] = (report.summary[finding.severity] ?? 0) + 1;
    }
  }

  // Historical baselines + trend tracking (v3 Phase B3)
  const baselinePath = path.join(OUTPUT_DIR, 'baselines', 'baseline.json');
  const trendsPath   = path.join(OUTPUT_DIR, 'baselines', 'trends.json');
  const baseline     = loadBaseline(baselinePath);
  const diff         = applyBaseline(report, baseline);
  if (!diff.isFirstRun) {
    console.log(`[ARGUS] Baseline diff: ${diff.newCount} new finding(s), ${diff.resolvedCount} resolved`);
    if (diff.flowNewCount > 0 || diff.flowResolvedCount > 0) {
      console.log(`[ARGUS] Flow diff: ${diff.flowNewCount} new flow finding(s), ${diff.flowResolvedCount} resolved`);
    }
  } else {
    console.log('[ARGUS] First run — no baseline to compare; all findings treated as new');
  }

  // Write JSON report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(OUTPUT_DIR, `error-report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[ARGUS] Report written: ${reportPath}`);

  // Dispatch to Slack (only new findings trigger critical/warning alerts)
  await dispatchToSlack(report, diff);

  // Persist baseline + append trend entry
  saveBaseline(baselinePath, report);
  appendTrend(trendsPath, {
    runAt:                 report.generatedAt,
    baseUrl:               report.baseUrl,
    summary:               report.summary,
    newFindings:           diff.newCount,
    resolvedFindings:      diff.resolvedCount,
    routeCount:            report.routes.length,
    flowCount:             report.flows?.length ?? 0,
    flowNewFindings:       diff.flowNewCount ?? 0,
    flowResolvedFindings:  diff.flowResolvedCount ?? 0,
  });
  console.log(`[ARGUS] Baseline saved → ${baselinePath}`);

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
async function dispatchToSlack(report, diff) {
  const { summary } = report;

  // ── Criticals: one Slack message per affected route ──────────────────────
  // When a baseline exists, only alert on findings that are new this run.
  for (const routeResult of report.routes) {
    const criticals = routeResult.errors.filter(e => e.severity === 'critical' && e.isNew !== false);
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
    const warnings = routeResult.errors.filter(e => e.severity === 'warning' && e.isNew !== false);
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

  // ── Responsive screenshots: mobile view for routes with responsive findings ──
  // Sent as a separate warning-severity message so the 375px layout is visible
  // alongside the text description (postBugReport accepts only one screenshotPath).
  for (const routeResult of report.routes) {
    const responsiveErrors = routeResult.errors.filter(e =>
      e.type === 'responsive_overflow' || e.type === 'responsive_small_touch_target'
    );
    const mobileShot = routeResult.responsiveScreenshots?.['375x812'];
    if (responsiveErrors.length === 0 || !mobileShot) continue;

    const description = responsiveErrors.map(e => `• *[${e.type}]* ${errorText(e)}`).join('\n');
    await postBugReport({
      severity: 'warning',
      title: `Responsive layout issues — ${routeResult.route} (mobile screenshot)`,
      description: `${description}\n\n_375px mobile view attached. Full grid: ${
        Object.keys(routeResult.responsiveScreenshots ?? {}).join(', ')
      }_`,
      url: routeResult.url,
      screenshotPath: mobileShot,
      details: { responsiveFindings: responsiveErrors },
    });
  }

  // ── Flow failures (v3 Phase B5): one message per failed flow ─────────────
  for (const flowResult of (report.flows ?? [])) {
    const flowCriticals = flowResult.findings.filter(f => f.severity === 'critical' && f.isNew !== false);
    if (flowCriticals.length > 0) {
      await postBugReport({
        severity: 'critical',
        title: `Flow "${flowResult.flowName}" failed — ${flowCriticals.length} critical issue(s)`,
        description: flowCriticals.map(f => `• *[${f.type}]* ${errorText(f)}`).join('\n'),
        url: report.baseUrl,
        screenshotPath: null,
        details: { flow: flowResult.flowName, errors: flowCriticals },
      });
    }
    const flowWarnings = flowResult.findings.filter(f => f.severity === 'warning' && f.isNew !== false);
    if (flowWarnings.length > 0) {
      await postBugReport({
        severity: 'warning',
        title: `Flow "${flowResult.flowName}" — ${flowWarnings.length} warning(s)`,
        description: flowWarnings.map(f => `• *[${f.type}]* ${errorText(f)}`).join('\n'),
        url: report.baseUrl,
        screenshotPath: null,
        details: { flow: flowResult.flowName, errors: flowWarnings },
      });
    }
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
      const flakyTag = e.flaky ? ' :zap: _flaky_' : '';
      digestLines.push(`  • [${e.type}]${flakyTag} ${errorText(e)}`);
    }
  }

  // Flow info findings in digest
  for (const flowResult of (report.flows ?? [])) {
    const flowInfos = flowResult.findings.filter(e => e.severity === 'info');
    if (flowInfos.length === 0) continue;
    digestLines.push(`*Flow: ${flowResult.flowName}* (${flowResult.stepsCompleted}/${flowResult.totalSteps} steps — ${flowResult.status})`);
    for (const e of flowInfos) {
      digestLines.push(`  • [${e.type}] ${errorText(e)}`);
    }
  }

  const allFlowInfos = (report.flows ?? []).flatMap(f => f.findings.filter(e => e.severity === 'info'));

  if (allInfos.length > 0 || allFlowInfos.length > 0) {
    const runDate = new Date(report.generatedAt).toLocaleString();
    const trendLine = diff
      ? diff.isFirstRun
        ? '_Baseline established — future runs will show new / resolved counts._'
        : `:chart_with_upwards_trend: ${diff.newCount} new  :white_check_mark: ${diff.resolvedCount} resolved since last baseline` +
          ((diff.flowNewCount ?? 0) > 0 || (diff.flowResolvedCount ?? 0) > 0
            ? `  _(flows: ${diff.flowNewCount ?? 0} new, ${diff.flowResolvedCount ?? 0} resolved)_`
            : '')
      : '';

    await postBugReport({
      severity: 'info',
      title: `Argus crawl digest — ${report.baseUrl} (${runDate})`,
      description:
        `Summary: ${summary.total} findings across ${report.routes.length} routes\n` +
        `:red_circle: ${summary.critical} critical  :large_yellow_circle: ${summary.warning} warnings  :large_blue_circle: ${summary.info} info\n` +
        (trendLine ? trendLine + '\n' : '') + '\n' +
        (digestLines.length > 0 ? digestLines.join('\n') : '_No info-level findings._'),
      url: report.baseUrl,
      screenshotPath: null,
      details: { summary, infos: allInfos },
    });
  }
}

// ── CLI Entry ──────────────────────────────────────────────────────────────────

// When Claude Code orchestrates this, it calls runCrawl(mcp) with real MCP tools.
// This block shows how a direct CLI invocation would work with a stub.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('[ARGUS] crawl-and-report.js loaded. Invoke runCrawl(mcp) from Claude Code with MCP tools connected.');
  console.log('[ARGUS] Target base URL:', BASE_URL);
  console.log('[ARGUS] Routes to crawl:', routes.map(r => r.path).join(', '));
}
