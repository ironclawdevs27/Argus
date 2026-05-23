/**
 * Argus Orchestrator (v9.1.3)
 *
 * Per-route crawl loop: cheap×2 flakiness pass + expensive×1 pass.
 * Extracted from crawl-and-report.js god object.
 *
 * Public exports: runCrawl, crawlRouteCheap, crawlRouteExpensive
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { routes, config, auth, flows, apiContracts, severityOverrides, codebase, autoDiscover, thresholds } from '../config/targets.js';
import { discoverRoutes }                                                from '../utils/route-discoverer.js';
import { analyzeCodebase, detectDeadRoutes, INTERNAL_LINKS_SCRIPT }     from '../utils/codebase-analyzer.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult }                  from '../utils/css-analyzer.js';
import { SEO_ANALYSIS_SCRIPT, parseSeoAnalysisResult }                  from '../utils/seo-analyzer.js';
import { SECURITY_ANALYSIS_SCRIPT, parseSecurityAnalysisResult, analyzeSecurityConsole, analyzeSecurityNetwork } from '../utils/security-analyzer.js';
import { CONTENT_ANALYSIS_SCRIPT, parseContentAnalysisResult }          from '../utils/content-analyzer.js';
import { runLoginFlow, saveSession, restoreSession, hasSession, refreshSession } from '../utils/session-manager.js';
import { mergeRunResults }                                               from '../utils/flakiness-detector.js';
import { runAllFlows, normalizeArray, waitForSelector }                  from '../utils/flow-runner.js';
import { analyzeApiFrequency }                                           from '../utils/api-frequency.js';
import { slugify }                                                       from '../utils/slug.js';
import { unwrapEval, createMcpClient }                                   from '../utils/mcp-client.js';
import { CdpBrowserAdapter }                                             from '../adapters/browser.js';
import { chunkArray }                                                    from '../utils/parallel-crawler.js';
import { validateApiContracts }                                          from '../utils/contract-validator.js';
import { checkLighthouse }                                               from '../utils/lighthouse-checker.js';
import { parseIssues }                                                   from '../utils/issues-analyzer.js';
import { parseNetworkTiming }                                            from '../utils/network-timing-analyzer.js';

// Side-effect imports: each module calls registerExpensive() at load time.
// lighthouse-checker.js also self-registers via its direct named import above (line 31).
// Order below controls iteration order in crawlAndAnalyzeRoute — must match original call order.
import '../utils/responsive-analyzer.js';
import '../utils/memory-analyzer.js';
import '../utils/hover-analyzer.js';
import '../utils/snapshot-analyzer.js';
import '../utils/keyboard-analyzer.js';

import { getExpensive }          from '../registry.js';
import { deduplicateFindings as deduplicateErrors } from './report-processor.js';
import { processReport }         from './report-processor.js';
import { dispatchAll }           from './dispatcher.js';
import { validateConfig }        from '../config/schema.js';
import { childLogger }           from '../utils/logger.js';

const logger = childLogger('orchestrator');

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL    = process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
const OUTPUT_DIR  = path.resolve(__dirname, '../../', config.outputDir);

// Thresholds for perf budgets and network analysis are centralized in targets.js.

// ── Injected Page Scripts ──────────────────────────────────────────────────────

const NETWORK_PERF_SCRIPT = `() => window.performance.getEntriesByType('resource').map(function(e){return{url:e.name,resourceType:e.initiatorType,duration:Math.round(e.duration||0),transferSize:e.transferSize||0,decodedBodySize:e.decodedBodySize||0}})`;

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

const INJECT_ERROR_LISTENER = `() => {
  if (window.__argusErrorsPatched) return;
  window.__argusErrorsPatched = true;
  window.__argusErrors = [];
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
    return false;
  };
  window.addEventListener('unhandledrejection', function(event) {
    window.__argusErrors.push({
      type: 'unhandled_rejection',
      message: String(event.reason),
      stack: event.reason && event.reason.stack ? event.reason.stack : null,
      ts: Date.now()
    });
  });
}`;

const EXTRACT_ERROR_LISTENER    = `() => JSON.stringify(window.__argusErrors ?? [])`;

const DETECT_DOC_WRITE_STATIC = `async () => {
  var found = [];
  var seen = new Set();
  function checkSrc(src, label) {
    if (/\\bdocument\\.write\\s*\\(/.test(src) && !seen.has('write:'+label)) {
      found.push({ method: 'write', content: label }); seen.add('write:'+label);
    }
    if (/\\bdocument\\.writeln\\s*\\(/.test(src) && !seen.has('writeln:'+label)) {
      found.push({ method: 'writeln', content: label }); seen.add('writeln:'+label);
    }
  }
  function isJsType(el) {
    var t = (el.type || '').toLowerCase().trim();
    return t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'module';
  }
  var inlines = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < inlines.length; i++) {
    if (isJsType(inlines[i])) checkSrc(inlines[i].textContent||'','(inline)');
  }
  var externals = document.querySelectorAll('script[src]');
  var fetches = [];
  for (var i = 0; i < externals.length; i++) {
    if (!isJsType(externals[i])) continue;
    var u = externals[i].src;
    if (!u || !u.startsWith(location.origin)) continue;
    fetches.push(fetch(u).then(function(r){return r.text();}).then(function(t){checkSrc(t,u);}).catch(function(){}));
  }
  await Promise.all(fetches);
  return JSON.stringify(found);
}`;

const INJECT_SW_LISTENER = `() => {
  if (!window.__argusSwErrors) window.__argusSwErrors = [];
  if (window.__argusSwPatched) return;
  window.__argusSwPatched = true;
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
}`;

const EXTRACT_SW_LISTENER = `() => JSON.stringify(window.__argusSwErrors ?? [])`;

const DEBUGGER_SCRIPT = `async () => {
  var found = [];
  function isJsType(el) {
    var t = (el.type || '').toLowerCase().trim();
    return t === '' || t === 'text/javascript' || t === 'application/javascript' || t === 'module';
  }
  var inline = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < inline.length; i++) {
    if (!isJsType(inline[i])) continue;
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
  var extEls = document.querySelectorAll('script[src]');
  var extUrls = [];
  for (var i = 0; i < extEls.length && extUrls.length < 20; i++) {
    if (!isJsType(extEls[i])) continue;
    var u = extEls[i].src;
    if (!u || !u.startsWith(origin) || seen[u]) continue;
    seen[u] = true;
    extUrls.push(u);
  }
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

const DUPLICATE_ID_SCRIPT = `() => {
  var counts = {};
  var els = document.querySelectorAll('[id]');
  for (var i = 0; i < els.length; i++) {
    var id = els[i].id;
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  var dupes = [];
  for (var id in counts) {
    if (counts[id] > 1) dupes.push({ id: id, count: counts[id] });
  }
  return JSON.stringify(dupes);
}`;

const INJECT_LONG_TASK_LISTENER = `() => {
  if (!window.__argusLongTasks) window.__argusLongTasks = [];
  if (window.__argusLongTaskPatched) return;
  window.__argusLongTaskPatched = true;
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
  } catch (e) { /* longtask not supported */ }
}`;

const EXTRACT_LONG_TASK_LISTENER = `() => JSON.stringify(window.__argusLongTasks ?? [])`;

const INJECT_SYNC_XHR_LISTENER = `() => {
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
}`;

const EXTRACT_SYNC_XHR_LISTENER = `() => JSON.stringify(window.__argusSyncXhrs ?? [])`;

const REDIRECT_COUNT_SCRIPT = `() => window.performance.getEntriesByType('navigation')[0]?.redirectCount ?? 0`;

// ── Severity Classification ────────────────────────────────────────────────────

function classifyConsoleMessage(msg, routeIsCritical) {
  const level = (msg.level ?? '').toLowerCase();
  if (level === 'error') return routeIsCritical ? 'critical' : 'warning';
  if (level === 'warning') return 'info';
  return 'info';
}

function classifyNetworkRequest(req, routeIsCritical) {
  const status = req.status ?? 0;
  if (status >= 500) return 'critical';
  if (status === 401 || status === 403) return 'critical';
  if (status >= 400) return routeIsCritical ? 'warning' : 'info';
  return null;
}

function classifyOrigin(reqUrl, pageUrl) {
  try {
    return new URL(reqUrl).origin === new URL(pageUrl).origin ? 'first-party' : 'third-party';
  } catch {
    return 'first-party';
  }
}

// ── Network Performance Analysis ──────────────────────────────────────────────

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

    const duration     = entry.duration ?? 0;
    const payloadBytes = entry.decodedBodySize || entry.transferSize || 0;

    if (duration > thresholds.network.slowCritical) {
      bugs.push({
        type:       'slow_api',
        requestUrl: reqUrl,
        duration:   Math.round(duration),
        threshold:  thresholds.network.slowCritical,
        message:    `Slow API response ${Math.round(duration)} ms — ${reqUrl} (critical threshold: ${thresholds.network.slowCritical} ms)`,
        severity:   'critical',
        url:        pageUrl,
      });
    } else if (duration > thresholds.network.slowWarning) {
      bugs.push({
        type:       'slow_api',
        requestUrl: reqUrl,
        duration:   Math.round(duration),
        threshold:  thresholds.network.slowWarning,
        message:    `Slow API response ${Math.round(duration)} ms — ${reqUrl} (warning threshold: ${thresholds.network.slowWarning} ms)`,
        severity:   'warning',
        url:        pageUrl,
      });
    }

    if (payloadBytes > thresholds.network.sizeCritical) {
      bugs.push({
        type:       'large_payload',
        requestUrl: reqUrl,
        bytes:      payloadBytes,
        threshold:  thresholds.network.sizeCritical,
        message:    `Oversized API payload ${Math.round(payloadBytes / 1024)} KB — ${reqUrl} (critical threshold: 2 MB)`,
        severity:   'critical',
        url:        pageUrl,
      });
    } else if (payloadBytes > thresholds.network.sizeWarning) {
      bugs.push({
        type:       'large_payload',
        requestUrl: reqUrl,
        bytes:      payloadBytes,
        threshold:  thresholds.network.sizeWarning,
        message:    `Oversized API payload ${Math.round(payloadBytes / 1024)} KB — ${reqUrl} (warning threshold: 500 KB)`,
        severity:   'warning',
        url:        pageUrl,
      });
    }
  }

  return bugs;
}

// ── Performance Budgets ────────────────────────────────────────────────────────

async function checkPerformanceBudgets(browser, url) {
  const violations = [];
  const LIGHTHOUSE_TIMEOUT_MS = parseInt(process.env.ARGUS_LIGHTHOUSE_TIMEOUT ?? '120000', 10);

  try {
    await browser.startTrace();
    await new Promise(r => setTimeout(r, 3000));
    const trace    = await browser.stopTrace();
    const insights = await browser.analyzeInsight({ insightSetId: trace?.insightSetId ?? trace?.id ?? trace });

    const metrics = insights?.metrics ?? insights?.performanceMetrics ?? {};

    const checks = [
      { key: 'LCP',  value: metrics.largestContentfulPaint ?? metrics.LCP,  budget: thresholds.perf.LCP,  unit: 'ms' },
      { key: 'CLS',  value: metrics.cumulativeLayoutShift  ?? metrics.CLS,  budget: thresholds.perf.CLS,  unit: ''   },
      { key: 'FID',  value: metrics.totalBlockingTime ?? metrics.TBT ?? metrics.FID, budget: thresholds.perf.FID, unit: 'ms' },
      { key: 'TTFB', value: metrics.timeToFirstByte   ?? metrics.TTFB,      budget: thresholds.perf.TTFB, unit: 'ms' },
    ];

    for (const { key, value, budget, unit } of checks) {
      if (value == null) continue;
      if (value > budget) {
        violations.push({
          type:      'performance_budget',
          metric:    key,
          value:     `${value}${unit}`,
          budget:    `${budget}${unit}`,
          message:   `Performance budget exceeded: ${key} = ${value}${unit} (budget: ${budget}${unit})`,
          severity:  'warning',
          url,
        });
      }
    }
  } catch (err) {
    logger.warn(`[ARGUS] Performance trace skipped for ${url}: ${err.message}`);
  }

  void LIGHTHOUSE_TIMEOUT_MS; // referenced only here to prevent unused-var lint
  return violations;
}

// ── Cheap Crawl (called ×2 for flakiness detection) ───────────────────────────

/**
 * Cheap detections for one route.
 * Runs: console, network, JS errors, blank page, API frequency, contracts,
 *       SEO, security, content, CSS, debugger statements, duplicate ids, screenshot.
 * Does NOT run: Lighthouse, perf budgets, network perf, redirect chain, broken links, cache headers.
 */
export async function crawlRouteCheap(route, baseUrl, mcp) {
  const browser = new CdpBrowserAdapter(mcp);
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

  // 0. Snapshot session-wide baselines BEFORE this route starts (D5).
  const consoleBaseline = (await browser.listConsole().catch(() => [])).length;
  const networkBaseline = (await browser.listNetwork().catch(() => [])).length;
  // listConsoleRaw returns raw MCP response — normalizeArray required before .length
  const issuesBaselineRaw = await browser.listConsoleRaw({ types: ['issue'] }).catch(() => null);
  const issuesBaseline    = normalizeArray(issuesBaselineRaw).length;

  // 1. Navigate
  await browser.navigate(url);

  // 2. Inject listeners immediately after navigation (before settle)
  await browser.evaluate(INJECT_ERROR_LISTENER).catch(() => {});
  await browser.evaluate(INJECT_SYNC_XHR_LISTENER).catch(() => {});
  await browser.evaluate(INJECT_LONG_TASK_LISTENER).catch(() => {});
  await browser.evaluate(INJECT_SW_LISTENER).catch(() => {});

  // 3. Wait for page settle
  if (route.waitFor) {
    const found = await waitForSelector(browser, route.waitFor, 10000);
    if (!found) {
      result.errors.push({
        type: 'load_failure',
        message: `Selector "${route.waitFor}" not found after 10s — page may not have loaded`,
        severity: route.critical ? 'critical' : 'warning',
        url,
      });
    }
  } else {
    await new Promise(r => setTimeout(r, config.pageSettleMs));
  }

  // 4. Blank/error page check
  const titleResult = await browser.evaluate('() => document.title');
  result.pageTitle = String(unwrapEval(titleResult) ?? '');
  const bodyText    = await browser.evaluate('() => document.body?.innerText?.trim() ?? ""');
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

  // 5. Console messages — sliced from per-route baseline
  const consoleMsgs = (await browser.listConsole().catch(() => [])).slice(consoleBaseline);
  for (const msg of consoleMsgs) {
    const text = (msg.text ?? msg.message ?? '');
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

  // 5b. CORS error detection
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

  // 6. Network requests — sliced from per-route baseline (cap AFTER slice, not before)
  const networkReqs = (await browser.listNetwork())
    .slice(networkBaseline).slice(0, 500);
  for (const req of networkReqs) {
    const severity = classifyNetworkRequest(req, route.critical);
    if (severity !== null) {
      result.errors.push({
        type:       'network',
        method:     req.method ?? 'GET',
        requestUrl: req.url,
        status:     req.status,
        statusText: req.statusText ?? null,
        origin:     classifyOrigin(req.url, url),
        message:    `HTTP ${req.status}${req.statusText ? ` ${req.statusText}` : ''} — ${req.method ?? 'GET'} ${req.url}`,
        severity,
        url,
      });
    }
  }

  // 6b. API frequency analysis
  result.errors.push(...analyzeApiFrequency(networkReqs, url));

  // 6d. Third-party blocking resource detection via HAR timing
  try {
    result.errors.push(...parseNetworkTiming(networkReqs, url));
  } catch (err) {
    logger.warn(`[ARGUS] Network timing analysis skipped for ${url}: ${err.message}`);
  }

  // 6c. API contract validation
  if (apiContracts?.length > 0) {
    try {
      const contractFindings = await validateApiContracts(networkReqs, browser, apiContracts, url);
      result.errors.push(...contractFindings);
    } catch (err) {
      logger.warn(`[ARGUS] API contract validation skipped for ${url}: ${err.message}`);
    }
  }

  // 7. Injected uncaught exceptions
  const injectedErrors = await browser.evaluate(EXTRACT_ERROR_LISTENER);
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
  } catch { /* parse failure */ }

  // 7b. Sync XHR detection
  try {
    const syncXhrRaw = await browser.evaluate(EXTRACT_SYNC_XHR_LISTENER);
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
  } catch { /* parse failure */ }

  // 7c. document.write detection
  try {
    const docWriteRaw = await browser.evaluate(DETECT_DOC_WRITE_STATIC);
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
  } catch { /* parse failure or fetch error */ }

  // 7d. Long task detection
  try {
    const longTaskRaw  = await browser.evaluate(EXTRACT_LONG_TASK_LISTENER);
    const rawLongTasks = unwrapEval(longTaskRaw);
    const longTasks    = Array.isArray(rawLongTasks) ? rawLongTasks
      : JSON.parse(typeof rawLongTasks === 'string' ? rawLongTasks : '[]');
    for (const entry of longTasks) {
      result.errors.push({
        type:        'long_task',
        duration:    entry.duration,
        startTime:   entry.startTime,
        attribution: entry.attribution,
        message:     `Long task: ${entry.duration}ms — blocks the main thread (threshold: 50ms)`,
        severity:    'warning',
        url,
      });
    }
  } catch { /* PerformanceObserver not available */ }

  // 7e. Service worker registration failures
  try {
    const swRaw  = await browser.evaluate(EXTRACT_SW_LISTENER);
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
  } catch { /* service worker not supported */ }

  // 7f. debugger; statement detection
  try {
    const dbgRaw  = await browser.evaluate(DEBUGGER_SCRIPT);
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
  } catch { /* parse failure */ }

  // 7g. Duplicate id="" detection
  try {
    const dupIdRaw  = await browser.evaluate(DUPLICATE_ID_SCRIPT);
    const rawDupIds = unwrapEval(dupIdRaw);
    const dupIds    = Array.isArray(rawDupIds) ? rawDupIds
      : JSON.parse(typeof rawDupIds === 'string' ? rawDupIds : '[]');
    for (const entry of dupIds) {
      result.errors.push({
        type:     'duplicate_id',
        id:       entry.id,
        count:    entry.count,
        message:  `Duplicate id="${entry.id}" found on ${entry.count} elements — id must be unique per document`,
        severity: 'warning',
        url,
      });
    }
  } catch { /* parse failure */ }

  // 9b. SEO DOM checks
  try {
    const seoRaw = await browser.evaluate(SEO_ANALYSIS_SCRIPT);
    result.errors.push(...parseSeoAnalysisResult(unwrapEval(seoRaw), url));
  } catch (err) {
    logger.warn(`[ARGUS] SEO analysis skipped for ${url}: ${err.message}`);
  }

  // 9c. Security checks
  try {
    const secRaw = await browser.evaluate(SECURITY_ANALYSIS_SCRIPT);
    result.errors.push(...parseSecurityAnalysisResult(unwrapEval(secRaw), url));
  } catch (err) {
    logger.warn(`[ARGUS] Security DOM analysis skipped for ${url}: ${err.message}`);
  }
  result.errors.push(...analyzeSecurityConsole(consoleMsgs, url));
  result.errors.push(...analyzeSecurityNetwork(networkReqs, url));

  // 9d. Content quality checks
  try {
    const contentRaw = await browser.evaluate(CONTENT_ANALYSIS_SCRIPT);
    result.errors.push(...parseContentAnalysisResult(unwrapEval(contentRaw), url));
  } catch (err) {
    logger.warn(`[ARGUS] Content analysis skipped for ${url}: ${err.message}`);
  }

  // 9e. Chrome DevTools Issues panel
  try {
    const issueRaw = await browser.listConsoleRaw({ types: ['issue'] });
    const issues   = normalizeArray(issueRaw).slice(issuesBaseline);
    result.errors.push(...parseIssues(issues, url, route.critical));
  } catch (err) {
    logger.warn(`[ARGUS] Issues analysis skipped for ${url}: ${err.message}`);
  }

  // 9f. HTTPS enforcement check
  try {
    const parsed = new URL(url);
    const isLocalhost = /^(localhost|127\.|::1)/.test(parsed.hostname);
    if (parsed.protocol === 'http:' && !isLocalhost) {
      result.errors.push({
        type:     'security_no_https',
        message:  `Page served over HTTP — enforce HTTPS via server redirect or HSTS`,
        severity: 'warning',
        url,
      });
    }
  } catch { /* URL parse failure */ }

  // 10. CSS analysis
  try {
    const cssRaw = await browser.evaluate(CSS_ANALYSIS_SCRIPT);
    result.errors.push(...parseCssAnalysisResult(unwrapEval(cssRaw), url));
  } catch (err) {
    logger.warn(`[ARGUS] CSS analysis skipped for ${url}: ${err.message}`);
  }

  // 11. Deduplicate within this cheap run
  result.errors = deduplicateErrors(result.errors);

  // 12. Screenshot
  const screenshotPath = path.join(OUTPUT_DIR, `screenshot-${slugify(route.name)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  try {
    const screenshotData = await browser.screenshot({ format: 'png' });
    if (screenshotData?.data) {
      fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));
      result.screenshot = screenshotPath;
    }
  } catch (err) {
    logger.warn(`[ARGUS] Screenshot failed for ${url}: ${err.message}`);
  }

  return result;
}

// ── Expensive Crawl (called ×1) ────────────────────────────────────────────────

/**
 * Expensive/deterministic analyzers for one route — called ONCE per route.
 * Runs: network perf, redirect chain, perf budgets, Lighthouse,
 *       broken internal links, cache headers.
 */
export async function crawlRouteExpensive(route, baseUrl, mcp) {
  const browser = new CdpBrowserAdapter(mcp);
  const url     = `${baseUrl}${route.path}`;
  const errors  = [];

  try {
    await browser.navigate(url);
    if (route.waitFor) {
      await waitForSelector(browser, route.waitFor, 10000);
    } else {
      await new Promise(r => setTimeout(r, config.pageSettleMs));
    }
  } catch (err) {
    logger.warn(`[ARGUS] Expensive crawl: navigation failed for ${url}: ${err.message}`);
    return errors;
  }

  // Network performance — slow responses + oversized payloads
  try {
    const perfRaw    = await browser.evaluate(NETWORK_PERF_SCRIPT);
    const perfResult = unwrapEval(perfRaw);
    let perfEntries  = Array.isArray(perfResult) ? perfResult
      : JSON.parse(typeof perfResult === 'string' ? perfResult : '[]');
    errors.push(...analyzeNetworkPerformance(Array.isArray(perfEntries) ? perfEntries : [], url));
  } catch (err) {
    logger.warn(`[ARGUS] Network performance analysis skipped for ${url}: ${err.message}`);
  }

  // Redirect chain detection
  try {
    const rdRaw   = await browser.evaluate(REDIRECT_COUNT_SCRIPT);
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
    logger.warn(`[ARGUS] Redirect chain check skipped for ${url}: ${err.message}`);
  }

  // Performance budget check
  errors.push(...(await checkPerformanceBudgets(browser, url)));

  // Full Lighthouse audit
  errors.push(...(await checkLighthouse(browser, url)));

  // Broken internal link detection
  try {
    const linksRaw = await browser.evaluate(INTERNAL_LINKS_SCRIPT);
    const rawLinks = unwrapEval(linksRaw);
    const links    = [...new Set(Array.isArray(rawLinks) ? rawLinks.filter(Boolean) : [])];
    const headResults = await Promise.all(
      links.map(async href => {
        try {
          const res = await fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          return { href, status: res.status };
        } catch (err) {
          return { href, status: 0, error: err.message };
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
    logger.warn(`[ARGUS] Broken link check skipped for ${url}: ${err.message}`);
  }

  // Cache header detection
  try {
    const cacheRaw   = await browser.evaluate(CACHE_HEADER_SCRIPT);
    const rawCache   = unwrapEval(cacheRaw);
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
    logger.warn(`[ARGUS] Cache header check skipped for ${url}: ${err.message}`);
  }

  return errors;
}

// ── Per-Route Crawl Coordinator ────────────────────────────────────────────────

async function crawlAndAnalyzeRoute(route, targetBaseUrl, mcp, sessionFile) {
  const browser = new CdpBrowserAdapter(mcp);
  const url     = `${targetBaseUrl}${route.path}`;

  if (auth?.steps?.length > 0) {
    try {
      await refreshSession(browser, auth, targetBaseUrl);
      await restoreSession(browser, targetBaseUrl, sessionFile);
    } catch (err) {
      logger.warn(`[ARGUS] Auth: session restore skipped for ${route.name}: ${err.message}`);
    }
  }

  // Cheap pass × 2 → merge for flakiness
  logger.info(`[ARGUS] ${route.name}: cheap run 1/2...`);
  const cheapRun1 = await crawlRouteCheap(route, targetBaseUrl, mcp);
  logger.info(`[ARGUS] ${route.name}: cheap run 2/2 (flakiness check)...`);
  const cheapRun2 = await crawlRouteCheap(route, targetBaseUrl, mcp);
  const result    = mergeRunResults(cheapRun1, cheapRun2);

  // Expensive pass × 1
  logger.info(`[ARGUS] ${route.name}: expensive analyzers (once)...`);
  const expensiveErrors = await crawlRouteExpensive(route, targetBaseUrl, mcp);
  result.errors.push(...expensiveErrors);
  result.errors = deduplicateErrors(result.errors);

  // Post-crawl expensive analyzers via registry (responsive, memory, hover, snapshot, keyboard)
  for (const { name, analyze } of getExpensive()) {
    if (name === 'lighthouse') continue; // runs inside crawlRouteExpensive
    try {
      const raw      = await analyze(browser, url, route);
      const findings = Array.isArray(raw) ? raw : (raw?.findings ?? []);
      result.errors.push(...findings);
      // Handle responsive screenshot return shape: { findings, screenshots }
      if (raw?.screenshots && Object.keys(raw.screenshots).length > 0) {
        const screenshotPaths = {};
        for (const [viewport, data] of Object.entries(raw.screenshots)) {
          if (typeof data !== 'string') continue; // skip omitted entries ({ omitted: true, reason, bytes })
          const shotPath = path.join(
            OUTPUT_DIR,
            `screenshot-${slugify(route.name)}-responsive-${viewport}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`
          );
          try {
            fs.writeFileSync(shotPath, Buffer.from(data, 'base64'));
            screenshotPaths[viewport] = shotPath;
          } catch (err) {
            logger.warn(`[ARGUS] Responsive screenshot write failed (${viewport}): ${err.message}`);
          }
        }
        if (Object.keys(screenshotPaths).length > 0) result.responsiveScreenshots = screenshotPaths;
      }
    } catch (err) {
      logger.warn(`[ARGUS] ${name} skipped for ${route.name}: ${err.message}`);
    }
  }

  // Collect internal navigation links for dead route detection (C1.4)
  try {
    const linksRaw = await browser.evaluate(INTERNAL_LINKS_SCRIPT);
    const parsed   = unwrapEval(linksRaw);
    result.discoveredLinks = Array.isArray(parsed) ? parsed
      : (() => { try { const p = JSON.parse(String(parsed ?? '[]')); return Array.isArray(p) ? p : []; } catch { return []; } })();
  } catch {
    result.discoveredLinks = [];
  }

  return result;
}

// ── Parallel Shard Runner (D7.3) ──────────────────────────────────────────────

async function crawlShardWithClient(shard, targetBaseUrl, mcp, sessionFile) {
  const results = [];
  for (const route of shard) {
    logger.info(`[ARGUS/parallel] Crawling: ${route.name} → ${targetBaseUrl}${route.path}`);
    const result = await crawlAndAnalyzeRoute(route, targetBaseUrl, mcp, sessionFile);
    const flakyCount = result.errors.filter(e => e.flaky).length;
    if (flakyCount > 0) {
      logger.info(`[ARGUS/parallel] ${route.name}: ${flakyCount} finding(s) downgraded to info (flaky)`);
    }
    results.push(result);
  }
  return results;
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Run all routes, collect results, process report, and dispatch.
 * In production, `mcp` is provided by Claude Code's MCP integration.
 *
 * @param {object} mcp - Chrome DevTools MCP tool interface
 * @param {Array}  [routeOverrides]   - Override the default routes from targets.js
 * @param {string} [baseUrlOverride]  - Override the default base URL
 * @returns {object} Full report object
 */
export async function runCrawl(mcp, routeOverrides = null, baseUrlOverride = null) {
  // Validate config at startup — catches targets.js misconfiguration before any crawl work begins.
  // Named exports are already statically imported above; build the namespace object here.
  validateConfig({ config, routes, thresholds, apiContracts, severityOverrides, auth, flows, codebase, autoDiscover });

  const browser = new CdpBrowserAdapter(mcp);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const targetBaseUrl = baseUrlOverride ?? BASE_URL;

  // C3: auto route discovery
  const baseRoutes    = routeOverrides ?? routes;
  const targetRoutes  = (autoDiscover && !routeOverrides)
    ? await discoverRoutes(targetBaseUrl, codebase?.sourceDir ?? null, autoDiscover, baseRoutes)
    : baseRoutes;

  // Validate route objects
  for (const route of targetRoutes) {
    if (!route || typeof route !== 'object') throw new Error(`[ARGUS] Invalid route entry: ${JSON.stringify(route)}`);
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new Error(`[ARGUS] Invalid route.path "${route.path}" — must be a string starting with "/"`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: targetBaseUrl,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    routes: [],
    flows: [],
  };

  // Auth session persistence (B2)
  const sessionFile = auth?.sessionFile ?? '.argus-session.json';
  if (auth?.steps?.length > 0) {
    if (!hasSession(sessionFile, auth.sessionMaxAgeMs)) {
      logger.info(`[ARGUS] Auth: running login flow (${auth.steps.length} steps)...`);
      try {
        await runLoginFlow(browser, targetBaseUrl, auth.steps);
        await saveSession(browser, sessionFile);
      } catch (err) {
        logger.warn(`[ARGUS] Auth: login flow failed — crawl will proceed unauthenticated: ${err.message}`);
      }
    } else {
      logger.info(`[ARGUS] Auth: reusing existing session from ${sessionFile}`);
    }
  }

  // D7.3: parallel route crawling
  const _rawConcurrency = parseInt(process.env.ARGUS_CONCURRENCY ?? '1', 10);
  const concurrency = Math.min(10, Math.max(1, isNaN(_rawConcurrency) ? 1 : _rawConcurrency));

  if (concurrency > 1) {
    logger.info(`[ARGUS] Parallel mode: concurrency=${concurrency}, sharding ${targetRoutes.length} route(s)`);
    const shards       = chunkArray(targetRoutes, concurrency);
    const extraClients = [];
    try {
      for (let i = 1; i < shards.length; i++) {
        extraClients.push(await createMcpClient());
      }
      const shardPromises = shards.map((shard, idx) => {
        const shardMcp = idx === 0 ? mcp : extraClients[idx - 1];
        return crawlShardWithClient(shard, targetBaseUrl, shardMcp, sessionFile);
      });
      const shardResults = await Promise.all(shardPromises);
      for (const shardResult of shardResults) {
        for (const result of shardResult) {
          report.routes.push(result);
          for (const err of result.errors) {
            report.summary.total++;
            report.summary[err.severity] = (report.summary[err.severity] ?? 0) + 1;
          }
        }
      }
    } finally {
      for (const client of extraClients) {
        try { await client?.close?.(); } catch {}
      }
    }
  } else {
    for (const route of targetRoutes) {
      logger.info(`[ARGUS] Crawling: ${route.name} → ${targetBaseUrl}${route.path}`);
      const result = await crawlAndAnalyzeRoute(route, targetBaseUrl, mcp, sessionFile);

      const flakyCount = result.errors.filter(e => e.flaky).length;
      if (flakyCount > 0) {
        logger.info(`[ARGUS] ${route.name}: ${flakyCount} finding(s) downgraded to info (flaky — appeared in only one cheap run)`);
      }

      report.routes.push(result);
      for (const err of result.errors) {
        report.summary.total++;
        report.summary[err.severity] = (report.summary[err.severity] ?? 0) + 1;
      }
    }
  }

  // User flow testing (B5)
  if (flows?.length > 0) {
    logger.info(`[ARGUS] Running ${flows.length} user flow(s)...`);
    const { results: flowResults, findings: flowFindings } = await runAllFlows(flows, targetBaseUrl, browser);
    report.flows = flowResults;
    for (const finding of flowFindings) {
      report.summary.total++;
      report.summary[finding.severity] = (report.summary[finding.severity] ?? 0) + 1;
    }
  }

  // C1: Codebase cross-reference
  report.codebase = [];
  const allConsoleFindings = report.routes.flatMap(r => r.errors.filter(e => e.type === 'console'));
  try {
    const cbFindings = await analyzeCodebase({
      sourceDir:       codebase?.sourceDir ?? null,
      envFile:         codebase?.envFile   ?? null,
      consoleFindings: allConsoleFindings,
    });
    report.codebase.push(...cbFindings);
    if (cbFindings.length > 0) {
      logger.info(`[ARGUS] C1: ${cbFindings.length} codebase finding(s)`);
    }
  } catch (err) {
    logger.warn(`[ARGUS] C1: codebase analysis skipped: ${err.message}`);
  }

  // C1.4: Dead route detection
  try {
    const allLinks     = [...new Set(report.routes.flatMap(r => r.discoveredLinks ?? []))];
    const testedPaths  = targetRoutes.map(r => r.path);
    const deadFindings = await detectDeadRoutes(targetBaseUrl, allLinks, testedPaths);
    report.codebase.push(...deadFindings);
    if (deadFindings.length > 0) {
      logger.info(`[ARGUS] C1: ${deadFindings.length} dead route(s) detected`);
    }
  } catch (err) {
    logger.warn(`[ARGUS] C1: dead route detection skipped: ${err.message}`);
  }

  // Add codebase findings to running summary
  for (const finding of report.codebase) {
    report.summary.total++;
    report.summary[finding.severity] = (report.summary[finding.severity] ?? 0) + 1;
  }

  // Post-crawl: overrides, baseline, write JSON, dispatch
  const { reportPath, diff } = await processReport(report, {
    outputDir:         OUTPUT_DIR,
    severityOverrides,
  });

  await dispatchAll(report, diff, reportPath);

  return report;
}

// ── CLI Entry ──────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  logger.info('[ARGUS] orchestrator.js loaded. Invoke runCrawl(mcp) from Claude Code with MCP tools connected.');
  logger.info('[ARGUS] Target base URL: ' + BASE_URL);
  logger.info('[ARGUS] Routes to crawl: ' + (routes ?? []).map(r => r?.path ?? '(no path)').join(', '));
}
