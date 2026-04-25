#!/usr/bin/env node
/**
 * ARGUS Test Harness Validator — full coverage build
 *
 * Closes all 15 gaps identified after the initial harness build:
 *   Gap  1 — HTTP 403 not tested
 *   Gap  2 — console.error on critical route → "critical" severity untested
 *   Gap  3 — waitFor timeout → load_failure never triggered
 *   Gap  4 — API call summary (info) entry never asserted
 *   Gap  5 — Non-!important CSS cascade override never asserted
 *   Gap  6 — SCSS sourceMappingURL never asserted
 *   Gap  7 — Individual Lighthouse audit items never asserted
 *   Gaps 8–10 — LCP / CLS / FID perf metrics: no fixtures, no assertions
 *   Gaps 11–15 — All 7 env-comparison detections missing from validate.js
 *
 * Prerequisites:
 *   Chrome running with remote debugging:
 *     Windows: chrome.exe --remote-debugging-port=9222 --headless=new
 *     Mac:     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *                --remote-debugging-port=9222 --headless=new
 *
 * Usage:
 *   node test-harness/validate.js
 *
 * Exit code: 0 = all hard assertions pass, 1 = any hard assertion fails
 */

import { spawn }        from 'child_process';
import fs               from 'fs';
import path             from 'path';
import { fileURLToPath } from 'url';
import { PNG }          from 'pngjs';
import pixelmatch       from 'pixelmatch';

import { createMcpClient, unwrapEval }              from '../src/utils/mcp-client.js';
import { checkLighthouse }                         from '../src/utils/lighthouse-checker.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../src/utils/css-analyzer.js';
import { SEO_ANALYSIS_SCRIPT, parseSeoAnalysisResult } from '../src/utils/seo-analyzer.js';
import { SECURITY_ANALYSIS_SCRIPT, parseSecurityAnalysisResult, analyzeSecurityConsole, analyzeSecurityNetwork } from '../src/utils/security-analyzer.js';
import { CONTENT_ANALYSIS_SCRIPT, parseContentAnalysisResult } from '../src/utils/content-analyzer.js';
import { analyzeResponsive } from '../src/utils/responsive-analyzer.js';
import { analyzeMemory }    from '../src/utils/memory-analyzer.js';
import { saveSession, restoreSession, refreshSession } from '../src/utils/session-manager.js';
import { loadBaseline, saveBaseline, applyBaseline, appendTrend, getCurrentBranch } from '../src/utils/baseline-manager.js';
import { mergeRunResults } from '../src/utils/flakiness-detector.js';
import { runFlow, normalizeArray } from '../src/utils/flow-runner.js';
import { chunkArray } from '../src/utils/parallel-crawler.js';
import { validateSchema, matchesContract } from '../src/utils/contract-validator.js';
import { applyOverrides } from '../src/utils/severity-overrides.js';
import { isSlackConfigured } from '../src/utils/slack-guard.js';
import { generateHtmlReport } from '../src/utils/html-reporter.js';
import { HARNESS_DEV_URL, HARNESS_DEV_PORT,
         HARNESS_STAGING_URL, HARNESS_STAGING_PORT } from './harness-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;
const failLog = [];

function assert(condition, message) {
  if (condition) {
    console.log(`  \u2713 ${message}`);
    passed++;
  } else {
    console.log(`  \u2717 FAIL: ${message}`);
    failed++;
    failLog.push(message);
  }
}

/** Soft: logged, never counts against exit code. */
function soft(condition, message) {
  console.log(`  ${condition ? '~\u2713' : '~\u2717'} (soft) ${message}`);
}

// ── Server management ─────────────────────────────────────────────────────────

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'node',
      [path.join(__dirname, 'server.js')],
      { env: { ...process.env, PORT: String(port) }, stdio: 'pipe' }
    );
    proc.stdout.on('data', chunk => {
      const line = chunk.toString();
      process.stdout.write(`  [harness:${port}] ${line}`);
      if (line.includes('Server running on')) resolve(proc);
    });
    proc.stderr.on('data', chunk => process.stderr.write(`  [harness:${port}] ${chunk}`));
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`Harness server (port ${port}) did not start within 10 s`)), 10000);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Normalise whatever chrome-devtools-mcp returns into a plain array.
 * The MCP may return [] directly, or wrap it: { requests:[...] }, { messages:[...] }, etc.
 */
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  // Check common single-key wrappers
  for (const key of ['requests', 'networkRequests', 'messages', 'consoleMessages',
                     'items', 'data', 'results', 'entries']) {
    if (Array.isArray(val[key])) return val[key];
  }
  // Last resort: if it's a single-value object whose value is an array
  const vals = Object.values(val);
  if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
  return [];
}

/**
 * Safely extract the plain value from an evaluate_script result.
 * chrome-devtools-mcp may return a raw string/boolean, or a { result, type } wrapper.
 */
function parseEval(val, fallback = '') {
  if (val == null) return fallback;
  if (typeof val === 'string')  return val;
  if (typeof val === 'boolean' || typeof val === 'number') return val;
  if (typeof val?.result === 'string') return val.result;
  if (typeof val?.value  === 'string') return val.value;
  return fallback;
}

/**
 * Parse an evaluate_script result that should be a JSON array.
 * Handles pre-parsed arrays (mcp-client JSON.parses the result string) and raw strings.
 */
function evalToArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  const str = typeof val === 'string' ? val : (val?.result ?? val?.value ?? null);
  if (!str) return [];
  try { const p = JSON.parse(str); return Array.isArray(p) ? p : []; } catch { return []; }
}

// Performance API — collects network requests via PerformanceResourceTiming.
// responseStatus (Chrome 109+) gives the actual HTTP status including 4xx/5xx.
// Returns array directly (no JSON.stringify) so CDP serialises it once, not twice.
const NET_SCRIPT = `() => window.performance.getEntriesByType('resource').map(function(e){return{url:e.name,status:e.responseStatus??0,method:'GET',resourceType:e.initiatorType,duration:Math.round(e.duration||0),transferSize:e.transferSize||0,decodedBodySize:e.decodedBodySize||0}})`;

// Read in-page console capture array (populated by the interceptor in each fixture page).
// Returns array directly so CDP serialises it once.
const CONSOLE_READ_SCRIPT = `() => (window.__argus_console||[])`;

// D6.1 — Synchronous XHR detection (same logic as crawl-and-report.js)
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
const EXTRACT_SYNC_XHR_LISTENER = `() => JSON.stringify(window.__argusSyncXhrs ?? [])`;

// D6.2 — document.write / document.writeln detection (same logic as crawl-and-report.js)
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
const EXTRACT_DOC_WRITE_LISTENER = `() => JSON.stringify(window.__argusDocWrites ?? [])`;

// D6.3 — Long task detection (same logic as crawl-and-report.js)
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
const EXTRACT_LONG_TASK_LISTENER = `() => JSON.stringify(window.__argusLongTasks ?? [])`;

// D6.5 — Service worker registration failure detection (same logic as crawl-and-report.js)
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
const EXTRACT_SW_LISTENER = `() => JSON.stringify(window.__argusSwErrors ?? [])`;

// D6.8 — Duplicate id="" attribute detection
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

// D6.7 — debugger; statement detection (inline + same-origin external scripts)
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

// D6.6 — Cache headers detection (async evaluate_script, runs after page settle)
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

// ── Lightweight page crawler ──────────────────────────────────────────────────
// Does NOT import crawl-and-report.js — avoids Slack initialisation side-effect.

async function crawlFixture(mcp, url, { critical = false, waitFor = null } = {}) {
  const errors = [];

  // Snapshot browser console count before navigation (for D6.4 CORS baseline slicing)
  const consoleListBaseline = normalizeArray(await mcp.list_console_messages().catch(() => [])).length;

  // Inject listeners before navigation
  await mcp.evaluate_script({ function: INJECT_SYNC_XHR_LISTENER }).catch(() => {});   // D6.1
  await mcp.evaluate_script({ function: INJECT_DOC_WRITE_LISTENER }).catch(() => {});  // D6.2
  await mcp.evaluate_script({ function: INJECT_LONG_TASK_LISTENER }).catch(() => {});  // D6.3
  await mcp.evaluate_script({ function: INJECT_SW_LISTENER        }).catch(() => {});  // D6.5

  await mcp.navigate_page({ url });

  if (waitFor) {
    // Poll every 300 ms for up to 5 s — wait_for alone doesn't reliably reject on timeout.
    const pollEnd = Date.now() + 5000;
    let selectorFound = false;
    while (!selectorFound && Date.now() < pollEnd) {
      const existsRaw = await mcp.evaluate_script({
        function:`() => !!document.querySelector(${JSON.stringify(waitFor)})`,
      });
      selectorFound = parseEval(existsRaw) === true || parseEval(existsRaw) === 'true';
      if (!selectorFound && Date.now() < pollEnd) await sleep(300);
    }
    if (!selectorFound) {
      errors.push({ type: 'load_failure',
        message: `Selector "${waitFor}" not found within timeout`,
        severity: critical ? 'critical' : 'warning' });
    }
    await sleep(300);
  } else {
    await sleep(2000);
  }

  // Blank page check
  const bodyRes  = await mcp.evaluate_script({ function:'() => document.body?.innerText?.trim() ?? ""' });
  const bodyText = String(parseEval(bodyRes, ''));
  if (!bodyText || bodyText.length < 50)
    errors.push({ type: 'blank_page', message: 'Page appears blank (body < 50 chars)', severity: 'critical' });

  // Console messages — read from in-page interceptor; list_console_messages() misses
  // events that fire during page load before the MCP has subscribed.
  const consoleMsgs = evalToArray(await mcp.evaluate_script({ function:CONSOLE_READ_SCRIPT }));
  for (const msg of consoleMsgs) {
    const rawLevel = (msg.level ?? '').toLowerCase();
    const level    = rawLevel === 'warn' ? 'warning' : rawLevel; // normalise console.warn → 'warning'
    if (level !== 'error' && level !== 'warning') continue;
    errors.push({
      type: 'console', level,
      message: msg.text ?? msg.message ?? String(msg),
      severity: level === 'error' ? (critical ? 'critical' : 'warning') : 'info',
    });
  }

  // Network failures — use Performance API instead of list_network_requests()
  // to capture requests that completed before the MCP subscribed.
  const networkReqs = evalToArray(await mcp.evaluate_script({ function:NET_SCRIPT }));
  for (const req of networkReqs) {
    const status = req.status ?? 0;
    if (status < 400) continue;
    const isCrit = status >= 500 || status === 401 || status === 403;
    errors.push({ type: 'network', status, method: req.method ?? 'GET',
      requestUrl: req.url, severity: isCrit ? 'critical' : (critical ? 'warning' : 'info') });
  }

  // API frequency analysis (inlined — no Slack dependency)
  const staticExt = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;
  const apiCalls  = networkReqs.filter(r => {
    const u  = r.url ?? '';
    const rt = (r.resourceType ?? '').toLowerCase();
    return !staticExt.test(u) && (
      /\/(api|graphql|rest|v\d+)\//i.test(u) ||
      rt === 'xmlhttprequest' || rt === 'fetch' || rt === 'xhr'
    );
  });
  const groups = {};
  for (const req of apiCalls) {
    const method = (req.method ?? 'GET').toUpperCase();
    let ep;
    try   { const u = new URL(req.url); ep = u.pathname.replace(/\/\d+/g, '/{id}'); }
    catch { ep = (req.url ?? '').replace(/[?#].*/, '').replace(/\/\d+/g, '/{id}'); }
    const key = `${method}::${ep}`;
    if (!groups[key]) groups[key] = { method, ep, count: 0 };
    groups[key].count++;
  }
  const uniqueCount = Object.keys(groups).length;
  const totalCount  = apiCalls.length;
  for (const { method, ep, count } of Object.values(groups)) {
    if (count <= 1) continue;
    const sev = count >= 5 ? 'critical' : count >= 3 ? 'warning' : 'info';
    errors.push({ type: 'api_duplicate_call', endpoint: ep, callCount: count,
      method, severity: sev, message: `API called ${count}× : ${method} ${ep}` });
  }
  if (totalCount > 0) {
    const dupCount = Object.values(groups).filter(g => g.count > 1).length;
    errors.push({ type: 'api_call_summary', uniqueEndpoints: uniqueCount,
      totalCalls: totalCount, duplicateEndpoints: dupCount, severity: 'info',
      message: `API summary: ${totalCount} calls to ${uniqueCount} unique endpoints` });
  }

  // Network performance analysis — slow/large API detection (v3 Phase A2)
  for (const entry of networkReqs) {
    const reqUrl = entry.url ?? '';
    if (staticExt.test(reqUrl)) continue;
    if (
      !/\/(api|graphql|rest|v\d+)\//i.test(reqUrl) &&
      !['xmlhttprequest', 'fetch', 'xhr'].includes((entry.resourceType ?? '').toLowerCase())
    ) continue;
    const dur   = entry.duration ?? 0;
    const bytes = entry.decodedBodySize || entry.transferSize || 0;
    if (dur > 3000) {
      errors.push({ type: 'slow_api', requestUrl: reqUrl, duration: Math.round(dur),
        severity: 'critical', message: `Slow API ${Math.round(dur)} ms — ${reqUrl}` });
    } else if (dur > 1000) {
      errors.push({ type: 'slow_api', requestUrl: reqUrl, duration: Math.round(dur),
        severity: 'warning', message: `Slow API ${Math.round(dur)} ms — ${reqUrl}` });
    }
    if (bytes > 2 * 1024 * 1024) {
      errors.push({ type: 'large_payload', requestUrl: reqUrl, bytes,
        severity: 'critical', message: `Oversized payload ${Math.round(bytes / 1024)} KB — ${reqUrl}` });
    } else if (bytes > 500 * 1024) {
      errors.push({ type: 'large_payload', requestUrl: reqUrl, bytes,
        severity: 'warning', message: `Oversized payload ${Math.round(bytes / 1024)} KB — ${reqUrl}` });
    }
  }

  // SEO analysis — meta tags, OG, h1, title, canonical, viewport (v3 Phase A3)
  try {
    const seoRaw = await mcp.evaluate_script({ function: SEO_ANALYSIS_SCRIPT });
    const seoInput = seoRaw == null ? null
      : typeof seoRaw === 'object' && !Array.isArray(seoRaw) ? seoRaw
      : parseEval(seoRaw, null);
    if (seoInput) {
      const seoBugs = parseSeoAnalysisResult(seoInput, url);
      errors.push(...seoBugs);
    }
  } catch { /* SEO analysis unavailable */ }

  // Security analysis — localStorage, eval(), cookies, headers, console sensitive data, URL tokens (v3 Phase A4)
  try {
    const secRaw = await mcp.evaluate_script({ function: SECURITY_ANALYSIS_SCRIPT });
    const secInput = secRaw == null ? null
      : typeof secRaw === 'object' && !Array.isArray(secRaw) ? secRaw
      : parseEval(secRaw, null);
    if (secInput) {
      const secBugs = parseSecurityAnalysisResult(secInput, url);
      errors.push(...secBugs);
    }
  } catch { /* Security DOM analysis unavailable */ }
  errors.push(...analyzeSecurityConsole(consoleMsgs, url));
  errors.push(...analyzeSecurityNetwork(networkReqs, url));

  // Content quality analysis — null/undefined text, placeholders, broken images, empty lists (v3 Phase A5)
  try {
    const contentRaw = await mcp.evaluate_script({ function: CONTENT_ANALYSIS_SCRIPT });
    const contentInput = contentRaw == null ? null
      : typeof contentRaw === 'object' && !Array.isArray(contentRaw) ? contentRaw
      : parseEval(contentRaw, null);
    if (contentInput) {
      const contentBugs = parseContentAnalysisResult(contentInput, url);
      errors.push(...contentBugs);
    }
  } catch { /* Content analysis unavailable */ }

  // CSS analysis (CSS_ANALYSIS_SCRIPT returns JSON.stringify(report);
  // mcp-client.js parses that to an object; parseCssAnalysisResult handles both)
  try {
    const cssRaw  = await mcp.evaluate_script({ function:CSS_ANALYSIS_SCRIPT });
    // cssRaw may be a pre-parsed object (common), raw JSON string, or null on error
    const cssInput = cssRaw == null ? null
      : typeof cssRaw === 'object' && !Array.isArray(cssRaw) ? cssRaw
      : parseEval(cssRaw, null);
    if (cssInput) {
      const cssBugs = parseCssAnalysisResult(cssInput, url);
      errors.push(...cssBugs);
    }
  } catch { /* CSS analysis unavailable */ }

  // Redirect chain detection (D2.1) — Navigation Timing redirectCount
  try {
    const rdRaw   = await mcp.evaluate_script({ function: `() => window.performance.getEntriesByType('navigation')[0]?.redirectCount ?? 0` });
    const rdCount = Number(unwrapEval(rdRaw) ?? 0);
    if (rdCount > 2) {
      errors.push({ type: 'redirect_chain', count: rdCount, severity: 'warning',
        message: `Redirect chain length ${rdCount} (threshold: > 2)` });
    }
  } catch { /* skip */ }

  // Broken internal link detection (D2.3) — HEAD each same-origin <a href>
  try {
    const INTERNAL_LINKS_SCRIPT = `() => { try { var orig = window.location.origin; return Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; }).filter(function(h){ if (!h || h.indexOf('#') === 0 || h.indexOf('mailto:') === 0 || h.indexOf('tel:') === 0) return false; try { return new URL(h).origin === orig; } catch { return false; } }); } catch(e) { return []; } }`;
    const linksRaw  = await mcp.evaluate_script({ function: INTERNAL_LINKS_SCRIPT });
    const links     = [...new Set(evalToArray(linksRaw).filter(Boolean))];
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
        errors.push({ type: 'broken_link', requestUrl: href, status: 404,
          severity: 'warning', message: `Broken internal link: ${href} (HTTP 404)` });
      }
    }
  } catch { /* skip */ }

  // Sync XHR detection (D6.1)
  try {
    const syncXhrRaw = await mcp.evaluate_script({ function: EXTRACT_SYNC_XHR_LISTENER });
    const syncXhrs   = evalToArray(syncXhrRaw);
    for (const entry of syncXhrs) {
      errors.push({
        type:       'sync_xhr',
        method:     entry.method ?? 'GET',
        requestUrl: entry.url,
        message:    `Synchronous XHR: ${entry.method ?? 'GET'} ${entry.url} — blocks the main thread`,
        severity:   'warning',
      });
    }
  } catch { /* skip */ }

  // document.write detection (D6.2)
  try {
    const docWriteRaw = await mcp.evaluate_script({ function: EXTRACT_DOC_WRITE_LISTENER });
    const docWrites   = evalToArray(docWriteRaw);
    for (const entry of docWrites) {
      errors.push({
        type:     'document_write',
        method:   entry.method,
        content:  entry.content,
        message:  `document.${entry.method}() is parser-blocking and degrades page performance`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // Long task detection (D6.3)
  try {
    const longTaskRaw = await mcp.evaluate_script({ function: EXTRACT_LONG_TASK_LISTENER });
    const longTasks   = evalToArray(longTaskRaw);
    for (const entry of longTasks) {
      errors.push({
        type:      'long_task',
        duration:  entry.duration,
        startTime: entry.startTime,
        attribution: entry.attribution,
        message:   `Long task: ${entry.duration}ms — blocks the main thread (threshold: 50ms)`,
        severity:  'warning',
      });
    }
  } catch { /* skip */ }

  // CORS error detection (D6.4) — browser-generated errors not captured by in-page interceptor
  try {
    const browserMsgs = normalizeArray(await mcp.list_console_messages().catch(() => [])).slice(consoleListBaseline);
    for (const msg of browserMsgs) {
      const text = (msg.text ?? msg.message ?? '');
      if (text.toLowerCase().includes('has been blocked by cors policy')) {
        errors.push({
          type:     'cors_error',
          message:  text || 'CORS policy violation',
          severity: 'critical',
        });
      }
    }
  } catch { /* skip */ }

  // Service worker registration failure detection (D6.5)
  try {
    const swRaw  = await mcp.evaluate_script({ function: EXTRACT_SW_LISTENER });
    const swErrs = evalToArray(swRaw);
    for (const entry of swErrs) {
      errors.push({
        type:      'sw_registration_error',
        scriptURL: entry.scriptURL,
        message:   `Service worker registration failed for "${entry.scriptURL}": ${entry.message}`,
        severity:  'warning',
      });
    }
  } catch { /* skip */ }

  // Cache header detection — same-origin static assets missing Cache-Control + ETag (D6.6)
  try {
    const cacheRaw   = await mcp.evaluate_script({ function: CACHE_HEADER_SCRIPT });
    const cacheItems = evalToArray(cacheRaw);
    for (const entry of cacheItems) {
      const filename = (entry.url ?? '').replace(/^.*\//, '').split('?')[0] || entry.url;
      errors.push({
        type:       'cache_headers_missing',
        requestUrl: entry.url,
        message:    `No cache headers on "${filename}" — missing both Cache-Control and ETag`,
        severity:   'info',
      });
    }
  } catch { /* skip */ }

  // debugger; statement detection — inline + same-origin external scripts (D6.7)
  try {
    const dbgRaw  = await mcp.evaluate_script({ function: DEBUGGER_SCRIPT });
    const dbgHits = evalToArray(dbgRaw);
    for (const entry of dbgHits) {
      errors.push({
        type:      'debugger_statement',
        scriptUrl: entry.scriptUrl,
        line:      entry.line,
        snippet:   entry.snippet,
        message:   `debugger; statement found in "${entry.scriptUrl}" (line ${entry.line}) — remove before shipping`,
        severity:  'critical',
      });
    }
  } catch { /* skip */ }

  // Duplicate id="" detection (D6.8)
  try {
    const dupIdRaw  = await mcp.evaluate_script({ function: DUPLICATE_ID_SCRIPT });
    const dupIds    = evalToArray(dupIdRaw);
    for (const entry of dupIds) {
      errors.push({
        type:     'duplicate_id',
        id:       entry.id,
        count:    entry.count,
        message:  `Duplicate id="${entry.id}" found on ${entry.count} elements — id must be unique per document`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  return { errors, networkReqs, consoleMsgs };
}

// ── Performance measurement ───────────────────────────────────────────────────

async function measurePerf(mcp, url) {
  try {
    await mcp.navigate_page({ url });
    await mcp.performance_start_trace();
    await sleep(4000);
    const trace    = await mcp.performance_stop_trace();
    const insights = await mcp.performance_analyze_insight({ trace });
    const m        = insights?.metrics ?? insights?.performanceMetrics ?? {};
    return {
      ttfb: m.timeToFirstByte           ?? m.TTFB   ?? null,
      lcp:  m.largestContentfulPaint    ?? m.LCP    ?? null,
      cls:  m.cumulativeLayoutShift     ?? m.CLS    ?? null,
      fid:  m.totalBlockingTime ?? m.TBT ?? m.FID   ?? null,
    };
  } catch { return {}; }
}

// ── Full Lighthouse measurement (v3 — all 4 categories) ──────────────────────

async function measureLighthouse(mcp, url) {
  try {
    const result = await mcp.lighthouse_audit({
      categories: ['accessibility', 'performance', 'seo', 'best-practices'],
      url,
    });
    const cats   = result?.categories ?? {};
    const audits = result?.audits     ?? {};

    const score = (key) => {
      const s = cats[key]?.score ?? result?.[key]?.score ?? null;
      return s != null ? Math.round(s * 100) : null;
    };

    const failingAudits = Object.entries(audits)
      .filter(([, a]) => a.score === 0 && a.details?.type !== 'manual')
      .map(([id, a]) => ({ id, title: a.title ?? id }));

    return {
      accessibility:  score('accessibility'),
      performance:    score('performance'),
      seo:            score('seo'),
      bestPractices:  score('best-practices'),
      failingAudits,
    };
  } catch {
    return { accessibility: null, performance: null, seo: null, bestPractices: null, failingAudits: [] };
  }
}

/** Backwards-compatible alias used by tests 12–14. */
async function measureA11y(mcp, url) {
  const r = await measureLighthouse(mcp, url);
  return { score: r.accessibility, failingAudits: r.failingAudits };
}

// ── Visual diff (env-comparison) ──────────────────────────────────────────────

function extractRegion(png, w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * png.width + x) * 4, d = (y * w + x) * 4;
      buf[d] = png.data[s]; buf[d+1] = png.data[s+1];
      buf[d+2] = png.data[s+2]; buf[d+3] = png.data[s+3];
    }
  return buf;
}

function visualDiff(devShot, stagingShot) {
  if (!devShot?.data || !stagingShot?.data) return { diffPct: null };
  try {
    const i1 = PNG.sync.read(Buffer.from(devShot.data, 'base64'));
    const i2 = PNG.sync.read(Buffer.from(stagingShot.data, 'base64'));
    const w = Math.min(i1.width, i2.width), h = Math.min(i1.height, i2.height);
    const n = pixelmatch(extractRegion(i1, w, h), extractRegion(i2, w, h),
                          Buffer.alloc(w * h * 4), w, h, { threshold: 0.1 });
    return { diffPct: parseFloat(((n / (w * h)) * 100).toFixed(2)) };
  } catch (e) { return { diffPct: null, error: e.message }; }
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function runTests(mcp, stagingProc) {
  const B  = HARNESS_DEV_URL;
  const BS = HARNESS_STAGING_URL;

  // Clear any Chrome state left by a previous harness run (auth cookies, localStorage)
  try {
    await mcp.navigate_page({ url: B });
    await mcp.evaluate_script({
      function: `() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach(function(c) {
          document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
        return true;
      }`,
    });
  } catch { /* best-effort — Chrome may not have the origin loaded yet */ }

  // ── [1] Clean page ────────────────────────────────────────────────────────
  console.log('\n[1] Clean page — expect: zero warnings / criticals');
  {
    const { errors } = await crawlFixture(mcp, `${B}/clean.html`);
    const bads = errors.filter(e => e.severity === 'critical' || e.severity === 'warning');
    assert(bads.length === 0,
      `No warning/critical on clean page (got ${bads.length}: ${bads.map(e => e.type).join(', ') || 'none'})`);
  }

  // ── [2] JS errors (non-critical route) ───────────────────────────────────
  console.log('\n[2] JS Errors — console.error, console.warn, thrown TypeError, unhandled rejection');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors.html`, { critical: false });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    const cw = errors.filter(e => e.type === 'console' && e.level === 'warning');
    assert(ce.length > 0,  `console.error detected (found ${ce.length})`);
    assert(cw.length > 0,  `console.warn detected (found ${cw.length})`);
    assert(ce.every(e => e.severity === 'warning'), `console errors → severity "warning" on non-critical route`);
  }

  // ── [3] JS errors (non-critical, severity check) ─────────────────────────
  console.log('\n[3] Non-critical JS errors — 2+ console.error at severity "warning"');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors-noncritical.html`, { critical: false });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce.length >= 2,                          `At least 2 console errors (found ${ce.length})`);
    assert(ce.every(e => e.severity === 'warning'), `All at severity "warning"`);
  }

  // ── [4] JS errors (critical route) — GAP 2 FIX ──────────────────────────
  console.log('\n[4] JS Errors on critical route — expect: severity "critical" (not "warning")');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors-critical.html`, { critical: true });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce.length >= 2,                            `At least 2 console errors on critical route (found ${ce.length})`);
    assert(ce.every(e => e.severity === 'critical'),  `All console errors → severity "critical" on critical route`);
  }

  // ── [5] Network errors — GAP 1 FIX: added HTTP 403 ───────────────────────
  console.log('\n[5] Network Errors — HTTP 500 critical, 401 critical, 403 critical, 404 info');
  {
    const { errors } = await crawlFixture(mcp, `${B}/network-errors.html`, { critical: false });
    const n500 = errors.filter(e => e.type === 'network' && e.status === 500);
    const n401 = errors.filter(e => e.type === 'network' && e.status === 401);
    const n403 = errors.filter(e => e.type === 'network' && e.status === 403);
    const n404 = errors.filter(e => e.type === 'network' && e.status === 404);
    assert(n500.length > 0,                    `HTTP 500 detected`);
    assert(n401.length > 0,                    `HTTP 401 detected`);
    assert(n403.length > 0,                    `HTTP 403 detected`);              // GAP 1
    assert(n404.length > 0,                    `HTTP 404 detected`);
    assert(n500[0]?.severity === 'critical',   `HTTP 500 → "critical"`);
    assert(n401[0]?.severity === 'critical',   `HTTP 401 → "critical" (auth)`);
    assert(n403[0]?.severity === 'critical',   `HTTP 403 → "critical" (forbidden)`); // GAP 1
    assert(n404[0]?.severity === 'info',       `HTTP 404 → "info" on non-critical route`);
  }

  // ── [6] API frequency — GAP 4 FIX: added api_call_summary assertion ───────
  console.log('\n[6] API Frequency — ×6 critical, ×3 warning, ×2 info, plus summary entry');
  {
    const { errors } = await crawlFixture(mcp, `${B}/api-frequency.html`);
    const loop    = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-loop'));
    const batch   = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-batch'));
    const pair    = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-pair'));
    const summary = errors.filter(e => e.type === 'api_call_summary');
    assert(loop.length  > 0 && loop[0].callCount  >= 6, `data-loop ×6+ (got ${loop[0]?.callCount ?? 0})`);
    assert(batch.length > 0 && batch[0].callCount >= 3, `data-batch ×3+ (got ${batch[0]?.callCount ?? 0})`);
    assert(pair.length  > 0 && pair[0].callCount  >= 2, `data-pair ×2+ (got ${pair[0]?.callCount ?? 0})`);
    assert(loop[0]?.severity  === 'critical', `data-loop → "critical"`);
    assert(batch[0]?.severity === 'warning',  `data-batch → "warning"`);
    assert(pair[0]?.severity  === 'info',     `data-pair → "info"`);
    assert(summary.length > 0,                `API call summary entry generated (gap 4)`); // GAP 4
  }

  // ── [7] Blank page ────────────────────────────────────────────────────────
  console.log('\n[7] Blank page — expect: blank_page critical');
  {
    const { errors } = await crawlFixture(mcp, `${B}/blank-page.html`, { critical: true });
    const blank = errors.filter(e => e.type === 'blank_page');
    assert(blank.length > 0,                   `blank_page detected`);
    assert(blank[0]?.severity === 'critical',  `blank_page → "critical"`);
  }

  // ── [8] WaitFor success ───────────────────────────────────────────────────
  console.log('\n[8] WaitFor success — #late-content appears after 2 s, no load_failure');
  {
    const { errors } = await crawlFixture(mcp, `${B}/waitfor-page.html`, { waitFor: '#late-content' });
    assert(errors.filter(e => e.type === 'load_failure').length === 0,
      `No load_failure — selector appeared within timeout`);
  }

  // ── [9] WaitFor timeout — GAP 3 FIX ─────────────────────────────────────
  console.log('\n[9] WaitFor timeout — #never-appears never exists → load_failure warning');
  {
    const { errors } = await crawlFixture(mcp, `${B}/waitfor-timeout.html`,
      { waitFor: '#never-appears', critical: false });
    const lf = errors.filter(e => e.type === 'load_failure');
    assert(lf.length > 0,                    `load_failure detected when selector never appears`); // GAP 3
    assert(lf[0]?.severity === 'warning',    `load_failure → "warning" on non-critical route`);
  }

  // ── [10] CSS issues — GAPS 5 & 6 FIX: non-important cascade + SCSS map ───
  console.log('\n[10] CSS Issues — !important override, cascade override, unused rules, component leak, CSS Modules, inline conflict, SCSS map');
  {
    const { errors } = await crawlFixture(mcp, `${B}/css-issues.html`);
    const impOverrides    = errors.filter(e => e.type === 'css_override' &&  e.hasImportant);
    const nonImpOverrides = errors.filter(e => e.type === 'css_override' && !e.hasImportant);  // GAP 5
    const unusedRules     = errors.filter(e => e.type === 'css_unused_rules');
    const leaks           = errors.filter(e => e.type === 'css_component_leak');
    const modules         = errors.filter(e => e.type === 'css_modules_detected');
    const inlineConflicts = errors.filter(e => e.type === 'react_inline_style_conflict');
    const cssSummary      = errors.find(e  => e.type === 'css_summary');

    assert(impOverrides.length > 0,
      `!important CSS override detected — header background (found ${impOverrides.length})`);
    assert(nonImpOverrides.length > 0,
      `Non-!important cascade override detected — h1 color declared twice (gap 5, found ${nonImpOverrides.length})`); // GAP 5
    assert(unusedRules.length > 0 && unusedRules[0].count > 10,
      `Unused CSS rules > 10 detected (found ${unusedRules[0]?.count ?? 0})`);
    assert(leaks.length > 0,
      `Component style leak — .card__ in button-styles.css (found ${leaks.length})`);
    assert(modules.length > 0,
      `CSS Modules hashed class names detected (found ${modules.length})`);
    assert(inlineConflicts.length > 0,
      `Inline style conflict — .inline-conflict (found ${inlineConflicts.length})`);
    assert((cssSummary?.scssSourceFiles?.length ?? 0) > 0,
      `SCSS sourceMappingURL detected in <style> tag (gap 6)`);                   // GAP 6
  }

  // ── [11] Performance budgets — GAPS 8–10 FIX: LCP, CLS, FID pages ────────
  console.log('\n[11] Performance budgets (all soft — depends on Chrome trace availability)');
  {
    const ttfbMetrics = await measurePerf(mcp, `${B}/perf-issues.html`);
    soft(ttfbMetrics.ttfb != null && ttfbMetrics.ttfb > 800,
      `TTFB=${ttfbMetrics.ttfb ?? 'N/A'} ms — budget 800 ms`);

    const lcpMetrics = await measurePerf(mcp, `${B}/perf-lcp.html`);   // GAP 8
    soft(lcpMetrics.lcp != null && lcpMetrics.lcp > 2500,
      `LCP=${lcpMetrics.lcp ?? 'N/A'} ms — budget 2500 ms`);

    const clsMetrics = await measurePerf(mcp, `${B}/perf-cls.html`);   // GAP 9
    soft(clsMetrics.cls != null && clsMetrics.cls > 0.1,
      `CLS=${clsMetrics.cls ?? 'N/A'} — budget 0.1`);

    const fidMetrics = await measurePerf(mcp, `${B}/perf-fid.html`);   // GAP 10
    soft(fidMetrics.fid != null && fidMetrics.fid > 100,
      `FID/TBT=${fidMetrics.fid ?? 'N/A'} ms — budget 100 ms`);
  }

  // ── [12] Accessibility critical (soft) ───────────────────────────────────
  console.log('\n[12] A11y critical (soft) — Lighthouse score < 50');
  {
    const { score } = await measureA11y(mcp, `${B}/a11y-critical.html`);
    soft(score != null && score < 50,
      `Lighthouse a11y score=${score ?? 'N/A'}/100 (threshold: 50)`);
  }

  // ── [13] Accessibility warning (soft) ────────────────────────────────────
  console.log('\n[13] A11y warning (soft) — Lighthouse score 50–89');
  {
    const { score } = await measureA11y(mcp, `${B}/a11y-warning.html`);
    soft(score != null && score >= 50 && score < 90,
      `Lighthouse a11y score=${score ?? 'N/A'}/100 (expected 50–89)`);
  }

  // ── [14] Individual Lighthouse audit items — GAP 7 FIX ───────────────────
  console.log('\n[14] Individual Lighthouse audit items — at least one failing audit (gap 7)');
  {
    const { score, failingAudits } = await measureA11y(mcp, `${B}/a11y-critical.html`);
    soft(failingAudits.length > 0,
      `Individual Lighthouse audit failures detected (found ${failingAudits.length}: ` +
      `${failingAudits.slice(0, 3).map(a => a.id).join(', ')}${failingAudits.length > 3 ? '…' : ''})`);
    // Extra soft: confirm they match expected categories
    const knownBadAudits = ['image-alt', 'label', 'button-name', 'duplicate-id', 'color-contrast'];
    const matched = failingAudits.filter(a => knownBadAudits.includes(a.id));
    soft(matched.length > 0,
      `Known audit violations found: ${matched.map(a => a.id).join(', ') || 'none matched'}`);
  }

  // ── [16] Full Lighthouse suite — v3 Phase A1 (all soft) ─────────────────
  console.log('\n[16] Full Lighthouse suite — performance, SEO, best-practices, a11y (all soft)');
  {
    const lh = await measureLighthouse(mcp, `${B}/a11y-critical.html`);
    soft(lh.accessibility != null,
      `a11y score reported: ${lh.accessibility ?? 'N/A'}/100`);
    soft(lh.performance != null,
      `performance score reported: ${lh.performance ?? 'N/A'}/100`);
    soft(lh.seo != null,
      `SEO score reported: ${lh.seo ?? 'N/A'}/100`);
    soft(lh.bestPractices != null,
      `best-practices score reported: ${lh.bestPractices ?? 'N/A'}/100`);
    soft(lh.failingAudits.length > 0,
      `failing audit items across all categories: ${lh.failingAudits.length}`);
  }

  // ── [17] Network performance — slow API + oversized payload (v3 Phase A2) ──
  console.log('\n[17] Network Performance — slow API + large payload detection');
  {
    const { errors: perfErrors } = await crawlFixture(mcp, `${B}/api-performance.html`, {
      critical: false,
      waitFor: '#all-fetches-done',
    });

    // slow-warning: 1 500 ms > 1 000 ms threshold → severity 'warning'
    assert(
      perfErrors.some(e => e.type === 'slow_api' &&
        (e.requestUrl ?? '').includes('/api/slow-warning') && e.severity === 'warning'),
      `slow_api warning detected for /api/slow-warning (found: ${
        perfErrors.filter(e => e.type === 'slow_api').map(e => `${e.requestUrl} ${e.severity} ${e.duration}ms`).join(', ') || 'none'
      })`,
    );

    // slow-critical: 3 200 ms > 3 000 ms threshold → severity 'critical'
    assert(
      perfErrors.some(e => e.type === 'slow_api' &&
        (e.requestUrl ?? '').includes('/api/slow-critical') && e.severity === 'critical'),
      `slow_api critical detected for /api/slow-critical (found: ${
        perfErrors.filter(e => e.type === 'slow_api').map(e => `${e.requestUrl} ${e.severity} ${e.duration}ms`).join(', ') || 'none'
      })`,
    );

    // large-warning: ~600 KB > 500 KB threshold → severity 'warning'
    assert(
      perfErrors.some(e => e.type === 'large_payload' &&
        (e.requestUrl ?? '').includes('/api/large-warning') && e.severity === 'warning'),
      `large_payload warning detected for /api/large-warning (found: ${
        perfErrors.filter(e => e.type === 'large_payload').map(e => `${e.requestUrl} ${e.severity} ${Math.round((e.bytes??0)/1024)}KB`).join(', ') || 'none'
      })`,
    );

    // large-critical: ~2.2 MB > 2 MB threshold → severity 'critical'
    assert(
      perfErrors.some(e => e.type === 'large_payload' &&
        (e.requestUrl ?? '').includes('/api/large-critical') && e.severity === 'critical'),
      `large_payload critical detected for /api/large-critical (found: ${
        perfErrors.filter(e => e.type === 'large_payload').map(e => `${e.requestUrl} ${e.severity} ${Math.round((e.bytes??0)/1024)}KB`).join(', ') || 'none'
      })`,
    );
  }

  // ── [18] SEO checks — v3 Phase A3 (DOM inspection) ──────────────────────
  console.log('\n[18] SEO Checks — missing meta, OG tags, multiple h1, generic title');
  {
    const { errors: seoErrors } = await crawlFixture(mcp, `${B}/seo-issues.html`);

    // Missing meta description
    assert(
      seoErrors.some(e => e.type === 'seo_missing_description'),
      `seo_missing_description detected (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // All 3 OG tags missing at warning severity (og:title + og:description + og:image)
    const missingOgWarnings = seoErrors.filter(e => e.type === 'seo_missing_og' && e.severity === 'warning');
    assert(
      missingOgWarnings.length >= 3,
      `All 3 OG warning tags missing — og:title + og:description + og:image (found ${missingOgWarnings.length}: ${missingOgWarnings.map(e => e.property).join(', ')})`,
    );

    // Multiple h1 tags (seo-issues.html has 3)
    assert(
      seoErrors.some(e => e.type === 'seo_multiple_h1'),
      `seo_multiple_h1 detected — 3 h1 tags on page (found: ${seoErrors.filter(e => e.type === 'seo_multiple_h1').map(e => `h1Count=${e.h1Count}`).join(', ') || 'none'})`,
    );

    // Generic/too-short title ("P" = 1 char)
    assert(
      seoErrors.some(e => e.type === 'seo_generic_title'),
      `seo_generic_title detected — title "P" is too short (found: ${seoErrors.filter(e => e.type === 'seo_generic_title').map(e => `"${e.titleText}" ${e.titleLength}c`).join(', ') || 'none'})`,
    );

    // Missing canonical
    assert(
      seoErrors.some(e => e.type === 'seo_missing_canonical'),
      `seo_missing_canonical detected (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // Missing viewport
    assert(
      seoErrors.some(e => e.type === 'seo_missing_viewport'),
      `seo_missing_viewport detected (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
  }

  // ── [19] Security checks — v3 Phase A4 ──────────────────────────────────────
  console.log('\n[19] Security Checks — localStorage token, eval(), sensitive console, token-in-URL, missing headers, cookie');
  {
    const { errors: secErrors } = await crawlFixture(mcp, `${B}/security-issues.html`, {
      critical: false,
      waitFor: '#security-checks-done[data-ready]',
    });

    // Clean up the localStorage item left by the fixture so subsequent test runs start clean
    await mcp.evaluate_script({ function: "() => localStorage.removeItem('authToken')" });

    // 1. localStorage auth token detected
    assert(
      secErrors.some(e => e.type === 'security_token_in_storage' && e.severity === 'critical'),
      `security_token_in_storage detected — authToken key with JWT value (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 2. Token in API request URL
    assert(
      secErrors.some(e => e.type === 'security_token_in_url' && e.severity === 'critical'),
      `security_token_in_url detected — /api/user-data?token= (found: ${secErrors.filter(e => e.type === 'security_token_in_url').map(e => e.requestUrl).join(', ') || 'none'})`,
    );

    // 3. eval() usage in inline script
    assert(
      secErrors.some(e => e.type === 'security_eval_usage' && e.severity === 'warning'),
      `security_eval_usage detected — inline eval() call (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 4. Sensitive data in console output (email + JWT token in console.error)
    assert(
      secErrors.some(e => e.type === 'security_sensitive_console' && e.severity === 'warning'),
      `security_sensitive_console detected — email + JWT in console.error (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 5. Missing Content-Security-Policy response header
    assert(
      secErrors.some(e => e.type === 'security_missing_csp' && e.severity === 'warning'),
      `security_missing_csp detected — no CSP header on security-issues.html (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 6. Missing X-Frame-Options response header
    assert(
      secErrors.some(e => e.type === 'security_missing_xframe' && e.severity === 'warning'),
      `security_missing_xframe detected — no X-Frame-Options on security-issues.html (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 7. JS-accessible cookie (no HttpOnly) set via document.cookie
    assert(
      secErrors.some(e => e.type === 'security_cookie_no_httponly' && e.severity === 'warning'),
      `security_cookie_no_httponly detected — argus_test_session cookie readable by JS (found types: ${[...new Set(secErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
  }

  // ── [20] Content quality checks — v3 Phase A5 ───────────────────────────────
  console.log('\n[20] Content Quality — null/undefined text, placeholder, broken image, empty list');
  {
    const { errors: contentErrors } = await crawlFixture(mcp, `${B}/content-issues.html`, {
      critical: false,
      waitFor: '#content-checks-done[data-ready]',
    });

    // 1. undefined / null visible in DOM
    assert(
      contentErrors.some(e => e.type === 'content_null_rendered' && e.severity === 'warning'),
      `content_null_rendered detected — "undefined" and "null" in visible text (found types: ${[...new Set(contentErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 2. Placeholder text ("Lorem ipsum")
    assert(
      contentErrors.some(e => e.type === 'content_placeholder_text' && e.severity === 'warning'),
      `content_placeholder_text detected — "lorem ipsum" in body text (found types: ${[...new Set(contentErrors.map(e => e.type))].join(', ') || 'none'})`,
    );

    // 3. Broken image (naturalWidth === 0)
    assert(
      contentErrors.some(e => e.type === 'content_broken_image' && e.severity === 'warning'),
      `content_broken_image detected — /api/broken-image.jpg (found: ${contentErrors.filter(e => e.type === 'content_broken_image').map(e => e.src).join(', ') || 'none'})`,
    );

    // 4. Empty data-oriented list
    assert(
      contentErrors.some(e => e.type === 'content_empty_list' && e.severity === 'warning'),
      `content_empty_list detected — .results-list with no <li> children (found types: ${[...new Set(contentErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
  }

  // ── [21] Responsive layout — v3 Phase A6 ────────────────────────────────
  // Called directly (not via crawlFixture) — viewport changes must stay isolated.
  console.log('\n[21] Responsive Layout — overflow at mobile/tablet, small touch targets at 375px');
  {
    const { findings } = await analyzeResponsive(mcp, `${B}/responsive-issues.html`);

    // Horizontal overflow at ≤768 px → severity "critical"
    const mobileOverflow = findings.filter(f =>
      f.type === 'responsive_overflow' && f.viewport <= 768 && f.severity === 'critical');
    assert(
      mobileOverflow.length > 0,
      `responsive_overflow critical at mobile/tablet viewport (found: ${
        findings.filter(f => f.type === 'responsive_overflow')
          .map(f => `${f.viewport}px ${f.severity}`).join(', ') || 'none'
      })`,
    );

    // Small touch targets at 375 px → severity "warning"
    const smallTargets = findings.filter(f =>
      f.type === 'responsive_small_touch_target' && f.viewport === 375 && f.severity === 'warning');
    assert(
      smallTargets.length > 0,
      `responsive_small_touch_target warning at 375px (found: ${
        findings.filter(f => f.type === 'responsive_small_touch_target')
          .map(f => `${f.count} target(s) at ${f.viewport}px`).join(', ') || 'none'
      })`,
    );

    // Small touch targets at 768 px (tablet) → severity "warning"
    const smallTargets768 = findings.filter(f =>
      f.type === 'responsive_small_touch_target' && f.viewport === 768 && f.severity === 'warning');
    assert(
      smallTargets768.length > 0,
      `responsive_small_touch_target warning at 768px (found: ${
        findings.filter(f => f.type === 'responsive_small_touch_target')
          .map(f => `${f.count} target(s) at ${f.viewport}px`).join(', ') || 'none'
      })`,
    );
  }

  // ── [22] SEO missing h1 — v3 Phase A3 (zero h1 case) ────────────────────
  console.log('\n[22] SEO Missing H1 — page with zero <h1> tags → seo_missing_h1 warning');
  {
    const { errors: seoErrors } = await crawlFixture(mcp, `${B}/seo-no-h1.html`);

    assert(
      seoErrors.some(e => e.type === 'seo_missing_h1'),
      `seo_missing_h1 detected on zero-h1 page (found types: ${[...new Set(seoErrors.map(e => e.type))].join(', ') || 'none'})`,
    );
    assert(
      seoErrors.filter(e => e.type === 'seo_missing_h1').every(e => e.severity === 'warning'),
      `seo_missing_h1 → severity "warning"`,
    );
  }

  // ── [23] Memory leak — detached DOM nodes (v3 Phase B1) ──────────────────
  // Called directly like analyzeResponsive — it navigates on its own.
  console.log('\n[23] Memory Leak — detached DOM nodes detected via heap snapshot');
  {
    const findings = await analyzeMemory(mcp, `${B}/memory-leak.html`);

    const detachedFindings = findings.filter(f => f.type === 'memory_detached_dom_nodes');
    assert(
      detachedFindings.length > 0,
      `memory_detached_dom_nodes detected (found types: ${findings.map(f => f.type).join(', ') || 'none'})`,
    );
    assert(
      (detachedFindings[0]?.count ?? 0) > 10,
      `detached node count > 10 (found: ${detachedFindings[0]?.count ?? 0})`,
    );
    assert(
      detachedFindings.length === 0 || detachedFindings.every(f => f.severity === 'warning'),
      `memory_detached_dom_nodes → severity "warning" (count 11–100)`,
    );

    // Heap growth is soft — depends on GC timing
    const heapFindings = findings.filter(f => f.type === 'memory_heap_growth');
    if (heapFindings.length > 0) {
      soft(true,  `Heap growth detected: ${Math.round(heapFindings[0].growthBytes / 1024)} KB after navigate-away + back`);
    } else {
      soft(false, `Heap growth not detected (GC may have collected objects before measurement)`);
    }
  }

  // ── [24] Auth session persistence — v3 Phase B2 ──────────────────────────
  // Tests: login flow (fill+click+waitFor), saveSession, restoreSession,
  // protected route accessible with session, auth error without session.
  console.log('\n[24] Auth Session — login flow, save, restore, protected route access');
  {
    const sessionFile = path.join(__dirname, '.argus-test-session.json');

    // 1. Baseline: visit protected page with no session → should show auth error
    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(500);
    // Clear any leftover state from previous tests
    await mcp.evaluate_script({
      function: `() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach(function(c) {
          document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
        return true;
      }`,
    });
    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(400);
    const noSessionRaw = await mcp.evaluate_script({
      function: `() => {
        var el = document.getElementById('auth-error');
        return el ? el.style.display !== 'none' : false;
      }`,
    });
    assert(
      parseEval(noSessionRaw) === true || parseEval(noSessionRaw) === 'true',
      'Protected page shows #auth-error when no session (baseline)',
    );

    // 2. Run login flow: navigate to login page, set form values via evaluate_script,
    //    dispatch submit event. Using evaluate_script for reliability in headless Chrome
    //    (fill+click MCP tools are for production runLoginFlow against real apps).
    await mcp.navigate_page({ url: `${B}/auth-login.html` });
    await sleep(500);
    await mcp.evaluate_script({
      function: `() => {
        document.getElementById('email').value    = 'test@example.com';
        document.getElementById('password').value = 'password123';
        document.getElementById('login-form').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })
        );
        return true;
      }`,
    });
    await sleep(300);

    const loginOkRaw = await mcp.evaluate_script({
      function: `() => !!document.querySelector('#login-success[data-ready]')`,
    });
    assert(
      parseEval(loginOkRaw) === true || parseEval(loginOkRaw) === 'true',
      'Login flow succeeded — #login-success[data-ready] set after form submit',
    );

    // 3. Save session — must have localStorage keys (authToken, userId, userEmail)
    const session = await saveSession(mcp, sessionFile);
    assert(
      Object.keys(session.localStorage).length > 0,
      `Session saved with localStorage keys (found: ${Object.keys(session.localStorage).join(', ') || 'none'})`,
    );

    // 4. Clear all browser session state on the origin
    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(300);
    await mcp.evaluate_script({
      function: `() => {
        localStorage.clear();
        sessionStorage.clear();
        document.cookie.split(';').forEach(function(c) {
          document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
        });
        return true;
      }`,
    });

    // 5. Restore session from file → navigate to protected page → should show content
    const restored = await restoreSession(mcp, B, sessionFile);
    assert(restored === true, 'restoreSession returned true — session file found and injected');

    await mcp.navigate_page({ url: `${B}/auth-protected.html` });
    await sleep(400);
    const protectedRaw = await mcp.evaluate_script({
      function: `() => {
        var el = document.getElementById('protected-content');
        return el ? el.style.display !== 'none' : false;
      }`,
    });
    assert(
      parseEval(protectedRaw) === true || parseEval(protectedRaw) === 'true',
      `Protected page shows #protected-content after session restore (userId: ${session.localStorage.userId ?? '?'})`,
    );

    // Cleanup session file
    try { fs.unlinkSync(sessionFile); } catch { /* best-effort */ }

    // Clear Chrome auth state so test [1] passes on the NEXT harness run
    try {
      await mcp.navigate_page({ url: B });
      await mcp.evaluate_script({
        function: `() => {
          localStorage.clear();
          sessionStorage.clear();
          document.cookie.split(';').forEach(function(c) {
            document.cookie = c.trim().replace(/=.*/, '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/');
          });
          return true;
        }`,
      });
    } catch { /* best-effort */ }
  }

  // ── [15] Env comparison — GAPS 11–15 FIX (all 7 detections) ─────────────
  if (!stagingProc) {
    console.log('\n[15] Env Comparison — SKIPPED (staging server not running)');
    return;
  }

  console.log('\n[15] Env Comparison — 7 detections between dev and staging');

  // Navigate to dev home and collect data
  console.log('  → Navigating to dev home...');
  await mcp.navigate_page({ url: `${B}/` });
  await sleep(2500);
  const devReqs    = evalToArray(await mcp.evaluate_script({ function:NET_SCRIPT }));
  const devMsgs    = evalToArray(await mcp.evaluate_script({ function:CONSOLE_READ_SCRIPT }));
  const devShot    = await mcp.take_screenshot({ format: 'png' }).catch(() => null);
  const devDOMRaw  = await mcp.evaluate_script({ function:'() => document.body.innerHTML' });
  const devDOM     = String(parseEval(devDOMRaw, ''));

  // Navigate to staging home and collect data
  console.log('  → Navigating to staging home...');
  await mcp.navigate_page({ url: `${BS}/` });
  await sleep(2500);
  const stagingReqs    = evalToArray(await mcp.evaluate_script({ function:NET_SCRIPT }));
  const stagingMsgs    = evalToArray(await mcp.evaluate_script({ function:CONSOLE_READ_SCRIPT }));
  const stagingShot    = await mcp.take_screenshot({ format: 'png' }).catch(() => null);
  const stagingDOMRaw  = await mcp.evaluate_script({ function:'() => document.body.innerHTML' });
  const stagingDOM     = String(parseEval(stagingDOMRaw, ''));

  // [15a] API status regression: checkout 200 dev → 500 staging (GAP 11)
  const devCheckout     = devReqs.find(r => (r.url ?? '').includes('/api/checkout'));
  const stagingCheckout = stagingReqs.find(r => (r.url ?? '').includes('/api/checkout'));
  assert(devCheckout?.status === 200,
    `Checkout returns 200 on dev (got ${devCheckout?.status ?? 'not found'})`);
  assert(stagingCheckout?.status === 500,
    `Checkout returns 500 on staging — API regression detected (got ${stagingCheckout?.status ?? 'not found'})`);

  // [15b] New network request on staging: /api/tracking (GAP 12)
  const devTracking     = devReqs.find(r => (r.url ?? '').includes('/api/tracking'));
  const stagingTracking = stagingReqs.find(r => (r.url ?? '').includes('/api/tracking'));
  assert(!devTracking && !!stagingTracking,
    `New request on staging only: /api/tracking (dev: ${!!devTracking}, staging: ${!!stagingTracking})`);

  // [15c] Request in dev missing on staging: /api/feature-flags (GAP 13)
  const devFlags     = devReqs.find(r => (r.url ?? '').includes('/api/feature-flags'));
  const stagingFlags = stagingReqs.find(r => (r.url ?? '').includes('/api/feature-flags'));
  assert(!!devFlags && !stagingFlags,
    `Request present in dev but missing on staging: /api/feature-flags (dev: ${!!devFlags}, staging: ${!!stagingFlags})`);

  // [15d] API status changed non-5xx: analytics 200 dev → 404 staging (GAP 14)
  const devAnalytics     = devReqs.find(r => (r.url ?? '').includes('/api/analytics'));
  const stagingAnalytics = stagingReqs.find(r => (r.url ?? '').includes('/api/analytics'));
  assert(devAnalytics?.status === 200 && stagingAnalytics?.status === 404,
    `Analytics status changed: ${devAnalytics?.status ?? '?'} dev → ${stagingAnalytics?.status ?? '?'} staging`);

  // [15e] New console error in staging (GAP 15)
  const devErrCount     = devMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error').length;
  const stagingErrCount = stagingMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error').length;
  assert(stagingErrCount > devErrCount,
    `More console errors on staging (${stagingErrCount}) than dev (${devErrCount}) — regressions logged`);

  // [15f] DOM structural change: pricing section missing on staging (GAP 15)
  assert(devDOM.includes('class="pricing"') && !stagingDOM.includes('class="pricing"'),
    `DOM diff: .pricing section present on dev, missing on staging`);

  // [15g] Visual diff > 0.5% — hero background blue→red (soft, GAP 15)
  const { diffPct, error: diffErr } = visualDiff(devShot, stagingShot);
  soft(diffPct != null && diffPct > 0.5,
    `Visual diff: ${diffPct != null ? diffPct + '%' : `unavailable (${diffErr ?? 'no screenshot data'})`} pixels changed (threshold: 0.5%)`);

  // ── [25] Baseline manager — pure function test (no Chrome) ────────────────
  console.log('\n[25] Baseline Manager — applyBaseline, saveBaseline, loadBaseline, appendTrend, getCurrentBranch');

  const tmpDir      = path.join(__dirname, '.tmp-baseline-test');
  const bFile       = path.join(tmpDir, 'baseline.json');
  const tFile       = path.join(tmpDir, 'trends.json');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const fakeReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3100',
    summary: { total: 2, critical: 1, warning: 1, info: 0 },
    routes: [
      {
        route: '/home', url: 'http://localhost:3100/',
        errors: [
          { type: 'console', severity: 'critical', message: 'TypeError: x is null' },
          { type: 'seo_missing_description', severity: 'warning', message: 'Missing meta description' },
        ],
      },
    ],
  };

  // [25a] First run — isFirstRun true, all findings marked isNew
  const diff1 = applyBaseline(fakeReport, null);
  assert(diff1.isFirstRun === true, 'applyBaseline(null) → isFirstRun: true');
  assert(fakeReport.routes[0].errors.every(f => f.isNew === true),
    'First run — all findings marked isNew: true');

  // [25b] Save + reload baseline round-trip
  saveBaseline(bFile, fakeReport);
  const loaded = loadBaseline(bFile);
  assert(loaded !== null, 'loadBaseline returns non-null after saveBaseline');

  // [25c] Same findings → newCount: 0, resolvedCount: 0
  const fakeReport2 = JSON.parse(JSON.stringify(fakeReport)); // deep clone
  const diff2 = applyBaseline(fakeReport2, loaded);
  assert(diff2.newCount === 0 && diff2.resolvedCount === 0,
    `Identical run → newCount: ${diff2.newCount}, resolvedCount: ${diff2.resolvedCount} (both 0)`);

  // [25d] New finding detected as isNew: true
  const fakeReport3 = JSON.parse(JSON.stringify(fakeReport));
  fakeReport3.routes[0].errors.push({ type: 'blank_page', severity: 'critical', message: 'Page body empty' });
  const diff3 = applyBaseline(fakeReport3, loaded);
  assert(diff3.newCount === 1,
    `New finding detected — newCount: ${diff3.newCount} (expected 1)`);

  // [25e] appendTrend + resolved count from a reduced report
  const fakeReport4 = { ...fakeReport, routes: [{ ...fakeReport.routes[0], errors: [] }] };
  const diff4 = applyBaseline(fakeReport4, loaded);
  appendTrend(tFile, { runAt: new Date().toISOString(), resolvedFindings: diff4.resolvedCount });
  const trends = JSON.parse(fs.readFileSync(tFile, 'utf8'));
  assert(trends.length === 1 && trends[0].resolvedFindings === 2,
    `appendTrend round-trip — resolvedCount: ${diff4.resolvedCount} (expected 2), trends length: ${trends.length}`);

  // ── D4: flow baseline tests ───────────────────────────────────────────────
  const bFile2 = path.join(tmpDir, 'baseline-flows.json');
  const fakeReportWithFlows = {
    ...fakeReport,
    flows: [
      {
        flowName: 'login-flow',
        status: 'fail',
        stepsCompleted: 2,
        totalSteps: 3,
        findings: [
          { type: 'flow_assert_failed', severity: 'critical',
            message: '[login-flow] assert url_contains: URL does not contain "/dashboard"' },
          { type: 'flow_assert_failed', severity: 'warning',
            message: '[login-flow] assert no_console_errors: 1 error(s)' },
        ],
      },
    ],
  };

  // [25f] First run with flow findings — flowNewCount correct, all isNew: true
  const diffFlow1 = applyBaseline(JSON.parse(JSON.stringify(fakeReportWithFlows)), null);
  assert(diffFlow1.isFirstRun === true,
    '[25f] First run with flows → isFirstRun: true');
  assert(diffFlow1.flowNewCount === 2,
    `[25f] First run flowNewCount: ${diffFlow1.flowNewCount} (expected 2)`);
  assert(diffFlow1.flowResolvedCount === 0,
    `[25f] First run flowResolvedCount: ${diffFlow1.flowResolvedCount} (expected 0)`);
  // annotate the canonical copy for save
  applyBaseline(fakeReportWithFlows, null);
  assert(fakeReportWithFlows.flows[0].findings.every(f => f.isNew === true),
    '[25f] All flow findings marked isNew: true on first run');

  // [25g] Save + load flow baseline round-trip
  saveBaseline(bFile2, fakeReportWithFlows);
  const loadedFlows = loadBaseline(bFile2);
  assert(loadedFlows !== null,
    '[25g] loadBaseline returns non-null after saveBaseline with flows');
  assert(loadedFlows.flows instanceof Map,
    '[25g] loaded.flows is a Map');
  assert(loadedFlows.flows.has('login-flow'),
    '[25g] loaded baseline contains "login-flow" key');
  assert(loadedFlows.flows.get('login-flow').size === 2,
    `[25g] login-flow baseline has 2 keys (got ${loadedFlows.flows.get('login-flow').size})`);

  // [25h] Same flow findings → isNew: false, flowNewCount/flowResolvedCount: 0
  const fakeReportSameFlows = JSON.parse(JSON.stringify(fakeReportWithFlows));
  const diffFlow2 = applyBaseline(fakeReportSameFlows, loadedFlows);
  assert(diffFlow2.flowNewCount === 0 && diffFlow2.flowResolvedCount === 0,
    `[25h] Same flow findings → flowNewCount: ${diffFlow2.flowNewCount}, flowResolvedCount: ${diffFlow2.flowResolvedCount} (both 0)`);
  assert(fakeReportSameFlows.flows[0].findings.every(f => f.isNew === false),
    '[25h] Known flow findings marked isNew: false');

  // [25i] New flow finding → flowNewCount: 1
  const fakeReportNewFlowFinding = JSON.parse(JSON.stringify(fakeReportWithFlows));
  fakeReportNewFlowFinding.flows[0].findings.push({
    type: 'flow_step_failed', severity: 'critical',
    message: '[login-flow] step "click" on ".submit-btn" failed: Element not found',
  });
  const diffFlow3 = applyBaseline(fakeReportNewFlowFinding, loadedFlows);
  assert(diffFlow3.flowNewCount === 1,
    `[25i] New flow finding → flowNewCount: ${diffFlow3.flowNewCount} (expected 1)`);

  // [25j] Resolved flow finding → flowResolvedCount: 1
  const fakeReportResolvedFlow = JSON.parse(JSON.stringify(fakeReportWithFlows));
  fakeReportResolvedFlow.flows[0].findings = fakeReportResolvedFlow.flows[0].findings.slice(0, 1);
  const diffFlow4 = applyBaseline(fakeReportResolvedFlow, loadedFlows);
  assert(diffFlow4.flowResolvedCount === 1,
    `[25j] Resolved flow finding → flowResolvedCount: ${diffFlow4.flowResolvedCount} (expected 1)`);

  // [25k] Old baseline (no `flows` field) — backward compat: flow findings treated as new
  const oldBaselineRaw = { savedAt: new Date().toISOString(), routes: { 'http://localhost:3100/': [] } };
  fs.writeFileSync(bFile2, JSON.stringify(oldBaselineRaw, null, 2));
  const loadedOld = loadBaseline(bFile2);
  assert(loadedOld !== null,
    '[25k] Old baseline (no flows field) loads successfully');
  assert(loadedOld.flows instanceof Map && loadedOld.flows.size === 0,
    '[25k] Old baseline flows defaults to empty Map');
  const fakeReportForOld = JSON.parse(JSON.stringify(fakeReportWithFlows));
  const diffOld = applyBaseline(fakeReportForOld, loadedOld);
  assert(diffOld.flowNewCount === 2,
    `[25k] Old baseline: all flow findings treated as new → flowNewCount: ${diffOld.flowNewCount} (expected 2)`);

  // [25l] getCurrentBranch returns a non-empty string
  const branch = getCurrentBranch();
  assert(typeof branch === 'string' && branch.length > 0,
    `[25l] getCurrentBranch returns non-empty string (got: "${branch}")`);

  // [25m] getCurrentBranch result contains only safe filename characters
  assert(/^[a-zA-Z0-9._-]+$/.test(branch),
    `[25m] getCurrentBranch result is filename-safe (got: "${branch}")`);

  // Cleanup temp files
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ── [26] Flakiness detector — mergeRunResults (pure function, no Chrome) ──
  console.log('\n[26] Flakiness Detector — mergeRunResults');

  const flakyRun1 = {
    route: '/home', url: 'http://localhost:3100/', screenshot: null,
    errors: [
      { type: 'console',    severity: 'critical', message: 'TypeError: x is null' }, // in both
      { type: 'blank_page', severity: 'critical', message: 'Page body empty' },       // run1 only
    ],
  };
  const flakyRun2 = {
    route: '/home', url: 'http://localhost:3100/', screenshot: '/tmp/shot2.png',
    errors: [
      { type: 'console', severity: 'critical', message: 'TypeError: x is null' },    // in both
      { type: 'network',  severity: 'warning',  message: 'HTTP 404 /api/foo' },      // run2 only
    ],
  };

  const merged = mergeRunResults(flakyRun1, flakyRun2);

  // [26a] Finding present in both runs → confirmed, original severity, flaky: false
  const confirmedFinding = merged.errors.find(e => e.type === 'console');
  assert(
    confirmedFinding && confirmedFinding.flaky === false && confirmedFinding.severity === 'critical',
    `Confirmed finding — flaky: false, severity: critical (original)`,
  );

  // [26b] Finding only in run1 → flaky: true, severity: 'info'
  const flakyFromRun1 = merged.errors.find(e => e.type === 'blank_page');
  assert(
    flakyFromRun1 && flakyFromRun1.flaky === true && flakyFromRun1.severity === 'info',
    `Run1-only finding → flaky: true, severity: info (was critical)`,
  );

  // [26c] Finding only in run2 → flaky: true, severity: 'info'
  const flakyFromRun2 = merged.errors.find(e => e.type === 'network');
  assert(
    flakyFromRun2 && flakyFromRun2.flaky === true && flakyFromRun2.severity === 'info',
    `Run2-only finding → flaky: true, severity: info (was warning)`,
  );

  // [26d] Confirmed count
  const confirmedCount = merged.errors.filter(e => e.flaky === false).length;
  assert(confirmedCount === 1, `Confirmed count: ${confirmedCount} (expected 1)`);

  // [26e] Flaky count (one from each run)
  const flakyCount = merged.errors.filter(e => e.flaky === true).length;
  assert(flakyCount === 2, `Flaky count: ${flakyCount} (expected 2)`);

  // ── [27] Flow runner — B5 user flow definitions ──────────────────────────
  console.log('\n[27] Flow Runner (B5) — runFlow assertions');
  {
    // [27a] Empty flow → pass, no findings (pure function — no Chrome needed)
    const emptyResult = await runFlow({ name: 'empty', steps: [] }, B, mcp);
    assert(emptyResult.status === 'pass', 'Empty flow: status pass');
    assert(emptyResult.findings.length === 0, 'Empty flow: 0 findings');

    // [27b] Successful flow: navigate → fill → click → assert element_visible
    const successResult = await runFlow({
      name: 'Submit form',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'fill',     selector: '#name',       value: 'Alice' },
        { action: 'fill',     selector: '#email',      value: 'alice@example.com' },
        { action: 'click',    selector: '#submit-btn' },
        { action: 'sleep',    ms: 200 },
        { action: 'assert',   type: 'element_visible', selector: '#form-success' },
      ],
    }, B, mcp);
    assert(successResult.status === 'pass',
      `Successful flow: status pass (steps: ${successResult.stepsCompleted}/${successResult.totalSteps})`);
    assert(successResult.findings.length === 0,
      `Successful flow: 0 findings (got: ${successResult.findings.map(f => f.type).join(', ') || 'none'})`);

    // [27c] Assert element_visible failure → finding detected with correct type
    const failResult = await runFlow({
      name: 'Missing element',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert',   type: 'element_visible', selector: '#does-not-exist', severity: 'warning' },
      ],
    }, B, mcp);
    assert(failResult.findings.length >= 1,
      `Assert element_visible failure: finding detected (got ${failResult.findings.length})`);
    assert(failResult.findings[0]?.type === 'flow_assert_failed',
      `Assert element_visible failure: type = flow_assert_failed`);

    // [27d] Assert no_console_errors on clean form page → 0 findings
    const noErrResult = await runFlow({
      name: 'No console errors',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert',   type: 'no_console_errors' },
      ],
    }, B, mcp);
    assert(noErrResult.findings.length === 0,
      `Assert no_console_errors on clean page: 0 findings (got ${noErrResult.findings.length})`);

    // [27e] Assert url_contains — matching substring
    const urlMatchResult = await runFlow({
      name: 'URL match',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert',   type: 'url_contains', value: 'flow-form' },
      ],
    }, B, mcp);
    assert(urlMatchResult.findings.length === 0,
      `Assert url_contains (match): 0 findings`);

    // [27f] Assert url_contains — non-matching substring → finding detected
    const urlFailResult = await runFlow({
      name: 'URL no match',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert',   type: 'url_contains', value: '/dashboard' },
      ],
    }, B, mcp);
    assert(urlFailResult.findings.length >= 1,
      `Assert url_contains (no match): finding detected (got ${urlFailResult.findings.length})`);
    assert(urlFailResult.findings[0]?.type === 'flow_assert_failed',
      `Assert url_contains (no match): type = flow_assert_failed`);
  }

  // ── [28] Redirect chain detection — D2.1 ─────────────────────────────────
  console.log('\n[28] Redirect Chain — 3-hop chain (start→hop1→hop2→end) → redirect_chain warning');
  {
    const { errors: rdErrors } = await crawlFixture(mcp, `${B}/redirect-chain-start`);
    const chains = rdErrors.filter(e => e.type === 'redirect_chain');
    assert(chains.length > 0,
      `redirect_chain detected after 3-hop redirect (found types: ${[...new Set(rdErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert((chains[0]?.count ?? 0) > 2,
      `redirect_chain count > 2 (got ${chains[0]?.count ?? 'N/A'})`);
    assert(chains[0]?.severity === 'warning',
      `redirect_chain → severity "warning"`);
  }

  // ── [29] Broken internal links — D2.3 ────────────────────────────────────
  console.log('\n[29] Broken Links — 2 internal 404s detected, valid link and skipped links ignored');
  {
    const { errors: blErrors } = await crawlFixture(mcp, `${B}/broken-links.html`);
    const broken = blErrors.filter(e => e.type === 'broken_link');
    assert(broken.length === 2,
      `2 broken_link findings detected (got ${broken.length}: ${broken.map(e => e.requestUrl).join(', ') || 'none'})`);
    assert(broken.every(e => e.severity === 'warning'),
      `All broken_link findings → severity "warning"`);
    assert(broken.every(e => e.status === 404),
      `All broken_link findings have status 404`);
    assert(!broken.some(e => (e.requestUrl ?? '').includes('/clean.html')),
      `Valid link /clean.html NOT in broken list`);
  }

  // ── [30] checkLighthouse direct test — D2.5 ──────────────────────────────
  console.log('\n[30] checkLighthouse (D2.5) — production function returns array with required field shapes');
  {
    const violations = await checkLighthouse(mcp, `${B}/a11y-critical.html`);
    assert(Array.isArray(violations),
      `checkLighthouse returns an array (got ${typeof violations})`);
    if (violations.length > 0) {
      assert(violations.every(v => v.type && v.message && v.severity && v.url),
        `All violations have required fields: type, message, severity, url (${violations.length} violation(s))`);
    }
    const scoreViolations = violations.filter(v => v.type === 'lighthouse_score');
    const auditViolations = violations.filter(v => v.type === 'lighthouse_audit');
    soft(scoreViolations.length > 0,
      `checkLighthouse score violations: ${scoreViolations.length} (category score below threshold)`);
    soft(auditViolations.length > 0,
      `checkLighthouse audit violations: ${auditViolations.length} (individual failing audits)`);
  }

  // ── [31] Console/network per-route slicing — D5 ──────────────────────────
  console.log('\n[31] D5 Console Slicing — prior-route messages excluded from clean-page crawl');
  {
    // Generate console errors on js-errors.html
    await mcp.navigate_page({ url: `${B}/js-errors.html` });
    await sleep(2000);

    // Snapshot baseline BEFORE navigating to clean.html — this is the D5 pattern
    const allBeforeClean = toArray(await mcp.list_console_messages().catch(() => []));
    const consoleBaseline = allBeforeClean.length;

    // Navigate to a clean page (no console errors expected)
    await mcp.navigate_page({ url: `${B}/clean.html` });
    await sleep(1500);

    const allMsgsRaw = await mcp.list_console_messages().catch(() => []);
    const allMsgs    = toArray(allMsgsRaw);

    // Without slicing: errors from js-errors.html are still visible
    const errorsUnsliced = allMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error');

    // With D5 slicing: only messages produced AFTER the baseline (i.e. by clean.html)
    const cleanMsgs   = allMsgs.slice(consoleBaseline);
    const errorsSliced = cleanMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error');

    assert(errorsUnsliced.length > 0,
      `Without slicing: ${errorsUnsliced.length} error(s) visible — prior-route leakage confirmed`);
    assert(errorsSliced.length === 0,
      `With D5 slicing: 0 errors on clean page (baseline ${consoleBaseline}, sliced ${cleanMsgs.length} msgs) — leakage prevented`);
  }

  // ── [32] Synchronous XHR detection — D6.1 ────────────────────────────────
  console.log('\n[32] Sync XHR (D6.1) — synchronous XMLHttpRequest detected as warning');
  {
    const { errors: xhrErrors } = await crawlFixture(mcp, `${B}/sync-xhr.html`);
    const syncXhrs = xhrErrors.filter(e => e.type === 'sync_xhr');
    assert(syncXhrs.length > 0,
      `sync_xhr finding detected (found types: ${[...new Set(xhrErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert(syncXhrs[0]?.severity === 'warning',
      `sync_xhr → severity "warning" (got "${syncXhrs[0]?.severity}")`);
    assert((syncXhrs[0]?.requestUrl ?? '').includes('/api/data'),
      `sync_xhr requestUrl contains "/api/data" (got "${syncXhrs[0]?.requestUrl}")`);
    assert(syncXhrs[0]?.method === 'GET',
      `sync_xhr method is "GET" (got "${syncXhrs[0]?.method}")`);
  }

  // ── [33] document.write detection — D6.2 ─────────────────────────────────
  console.log('\n[33] document.write (D6.2) — document.write + document.writeln detected as warnings');
  {
    const { errors: dwErrors } = await crawlFixture(mcp, `${B}/doc-write.html`);
    const docWrites = dwErrors.filter(e => e.type === 'document_write');
    assert(docWrites.length >= 2,
      `At least 2 document_write findings (write + writeln) (found ${docWrites.length})`);
    assert(docWrites.every(e => e.severity === 'warning'),
      `All document_write findings have severity "warning"`);
    const methods = docWrites.map(e => e.method);
    assert(methods.includes('write'),
      `document.write() call detected (methods: ${methods.join(', ')})`);
    assert(methods.includes('writeln'),
      `document.writeln() call detected (methods: ${methods.join(', ')})`);
  }

  // ── [34] Long task detection — D6.3 ──────────────────────────────────────
  console.log('\n[34] Long Tasks (D6.3) — 120ms busy-loop triggers long_task warning');
  {
    const { errors: ltErrors } = await crawlFixture(mcp, `${B}/long-task.html`);
    const longTasks = ltErrors.filter(e => e.type === 'long_task');
    assert(longTasks.length > 0,
      `At least 1 long_task finding detected (found ${longTasks.length})`);
    assert(longTasks.every(e => e.severity === 'warning'),
      `All long_task findings have severity "warning"`);
    assert(longTasks.some(e => (e.duration ?? 0) >= 50),
      `At least one long task has duration >= 50ms (durations: ${longTasks.map(e => e.duration).join(', ')})`);
  }

  // ── [35] CORS error detection — D6.4 ─────────────────────────────────────
  console.log('\n[35] CORS Error (D6.4) — cross-origin fetch blocked by CORS policy → cors_error critical');
  {
    const { errors: corsErrors } = await crawlFixture(mcp, `${B}/cors-error.html`);
    const corsFindings = corsErrors.filter(e => e.type === 'cors_error');
    assert(corsFindings.length > 0,
      `cors_error finding detected (found types: ${[...new Set(corsErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert(corsFindings.every(e => e.severity === 'critical'),
      `All cors_error findings have severity "critical"`);
    assert(corsFindings.some(e => (e.message ?? '').toLowerCase().includes('cors policy')),
      `cors_error message mentions "cors policy" (got "${corsFindings[0]?.message?.slice(0, 80)}")`);
  }

  // ── [36] Service worker registration failure — D6.5 ──────────────────────
  console.log('\n[36] SW Registration Error (D6.5) — non-existent SW script triggers warning');
  {
    const { errors: swErrors } = await crawlFixture(mcp, `${B}/sw-error.html`);
    const swFindings = swErrors.filter(e => e.type === 'sw_registration_error');
    assert(swFindings.length > 0,
      `sw_registration_error finding detected (found types: ${[...new Set(swErrors.map(e => e.type))].join(', ') || 'none'})`);
    assert(swFindings.every(e => e.severity === 'warning'),
      `All sw_registration_error findings have severity "warning"`);
    assert(swFindings.some(e => (e.scriptURL ?? '').includes('sw-does-not-exist')),
      `sw_registration_error includes failing scriptURL (got "${swFindings[0]?.scriptURL}")`);
  }

  // ── [37] Cache header detection — D6.6 ───────────────────────────────────────
  console.log('\n[37] Cache Headers (D6.6) — assets without Cache-Control or ETag → info');
  {
    const { errors: chErrors } = await crawlFixture(mcp, `${B}/cache-headers.html`);
    const cacheMissing = chErrors.filter(e => e.type === 'cache_headers_missing');
    assert(cacheMissing.length >= 2,
      `At least 2 cache_headers_missing findings (one per nocache asset) (found ${cacheMissing.length}: ${cacheMissing.map(e => e.requestUrl).join(', ') || 'none'})`);
    assert(cacheMissing.every(e => e.severity === 'info'),
      `All cache_headers_missing findings have severity "info"`);
    assert(cacheMissing.some(e => (e.requestUrl ?? '').includes('nocache.css')),
      `nocache.css flagged as missing cache headers`);
    assert(cacheMissing.some(e => (e.requestUrl ?? '').includes('nocache.js')),
      `nocache.js flagged as missing cache headers`);
  }

  // ── [38] debugger; statement detection — D6.7 ────────────────────────────────
  console.log('\n[38] Debugger Statement (D6.7) — debugger; in inline and external scripts → critical');
  {
    const { errors: dbgErrors } = await crawlFixture(mcp, `${B}/debugger-statement.html`);
    const dbgHits = dbgErrors.filter(e => e.type === 'debugger_statement');
    assert(dbgHits.length >= 2,
      `At least 2 debugger_statement findings (inline + external) (found ${dbgHits.length}: ${dbgHits.map(e => e.scriptUrl).join(', ') || 'none'})`);
    assert(dbgHits.every(e => e.severity === 'critical'),
      `All debugger_statement findings have severity "critical"`);
    assert(dbgHits.some(e => e.scriptUrl === '(inline)'),
      `Inline debugger; detected`);
    assert(dbgHits.some(e => (e.scriptUrl ?? '').includes('debug-script.js')),
      `External debug-script.js debugger; detected`);
  }

  // ── [39] Duplicate id="" detection — D6.8 ────────────────────────────────────
  console.log('\n[39] Duplicate IDs (D6.8) — id shared by multiple elements → warning');
  {
    const { errors: didErrors } = await crawlFixture(mcp, `${B}/duplicate-ids.html`);
    const dupIds = didErrors.filter(e => e.type === 'duplicate_id');
    assert(dupIds.length >= 2,
      `At least 2 duplicate_id findings (card ×3 + header ×2) (found ${dupIds.length}: ${dupIds.map(e => e.id).join(', ') || 'none'})`);
    assert(dupIds.every(e => e.severity === 'warning'),
      `All duplicate_id findings have severity "warning"`);
    assert(dupIds.some(e => e.id === 'card' && (e.count ?? 0) >= 3),
      `id="card" flagged with count >= 3`);
    assert(dupIds.some(e => e.id === 'header' && (e.count ?? 0) >= 2),
      `id="header" flagged with count >= 2`);
    assert(!dupIds.some(e => e.id === 'unique-id'),
      `id="unique-id" (used once) not flagged`);
  }

  // ── [40] Mixed content severity — D6.9 ───────────────────────────────────────
  console.log('\n[40] Mixed Content (D6.9) — blocked → critical, passive → warning');
  {
    const { errors: mcErrors } = await crawlFixture(mcp, `${B}/mixed-content.html`);
    const mc = mcErrors.filter(e => e.type === 'security_mixed_content');
    assert(mc.length >= 2,
      `At least 2 security_mixed_content findings (blocked + passive) (found ${mc.length})`);
    assert(mc.some(e => e.severity === 'critical'),
      `Blocked mixed content finding has severity "critical"`);
    assert(mc.some(e => e.severity === 'warning'),
      `Passive mixed content finding has severity "warning"`);
    assert(mc.some(e => e.severity === 'critical' && (e.message ?? '').toLowerCase().includes('blocked')),
      `Critical finding message contains "blocked"`);
  }

  // ── [41] Parallel crawler — chunkArray (pure function, no Chrome) ─────────────
  console.log('\n[41] Parallel Crawler — chunkArray (D7.3)');

  // [41a] Even split: 6 items into 3 → 3 chunks of 2
  const c41a = chunkArray(['a','b','c','d','e','f'], 3);
  assert(c41a.length === 3 && c41a.every(c => c.length === 2),
    `[41a] chunkArray 6 items into 3 → 3 chunks of 2 (got: ${JSON.stringify(c41a)})`);

  // [41b] Uneven split: 5 items into 3 → 3 non-empty chunks, all items preserved
  const c41b = chunkArray(['a','b','c','d','e'], 3);
  assert(c41b.length === 3 && c41b.every(c => c.length > 0),
    `[41b] chunkArray 5 items into 3 → 3 non-empty chunks (got: ${JSON.stringify(c41b)})`);
  assert(c41b.flat().join('') === 'abcde',
    `[41b] chunkArray 5 items into 3 → all items preserved in order (got: ${JSON.stringify(c41b)})`);

  // [41c] Fewer items than target chunks: 3 items into 5 → 3 single-item chunks (no empty chunks)
  const c41c = chunkArray(['a','b','c'], 5);
  assert(c41c.length === 3 && c41c.every(c => c.length === 1),
    `[41c] chunkArray 3 items into 5 → 3 single-item chunks, no empty (got: ${JSON.stringify(c41c)})`);

  // [41d] Empty array → empty result
  const c41d = chunkArray([], 3);
  assert(Array.isArray(c41d) && c41d.length === 0,
    `[41d] chunkArray [] → [] (got: ${JSON.stringify(c41d)})`);

  // [41e] n=1 → single chunk containing all items
  const c41e = chunkArray(['a','b','c'], 1);
  assert(c41e.length === 1 && c41e[0].join('') === 'abc',
    `[41e] chunkArray 3 items into 1 → single chunk (got: ${JSON.stringify(c41e)})`);

  // [41f] ARGUS_CONCURRENCY defaults to 1 (sequential) when env var is unset
  const defConcurrency = Math.max(1, parseInt(process.env.ARGUS_CONCURRENCY ?? '1', 10));
  assert(defConcurrency === 1,
    `[41f] ARGUS_CONCURRENCY defaults to 1 when unset (got: ${defConcurrency})`);

  // ── [42] API contract validator — validateSchema + matchesContract (pure, no Chrome) ─
  console.log('\n[42] API Contract Validator — validateSchema + matchesContract (D7.4)');

  // [42a] Valid object matching required fields + types → 0 violations
  const v42a = validateSchema(
    { id: 1, name: 'Alice' },
    { type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' }, name: { type: 'string' } } }
  );
  assert(v42a.length === 0,
    `[42a] valid object passes schema → 0 violations (got: ${JSON.stringify(v42a)})`);

  // [42b] Missing required field → violation mentioning the field name
  const v42b = validateSchema({ id: 1 }, { type: 'object', required: ['id', 'name'] });
  assert(v42b.length > 0 && v42b.some(m => m.includes('name')),
    `[42b] missing required field → violation (got: ${JSON.stringify(v42b)})`);

  // [42c] Wrong root type → violation mentioning expected type
  const v42c = validateSchema('not-an-object', { type: 'object' });
  assert(v42c.length > 0 && v42c.some(m => m.includes('object')),
    `[42c] wrong type → violation (got: ${JSON.stringify(v42c)})`);

  // [42d] Empty schema → always passes (no constraints)
  const v42d = validateSchema({ anything: true }, {});
  assert(v42d.length === 0,
    `[42d] empty schema → 0 violations (got: ${JSON.stringify(v42d)})`);

  // [42e] Nested property type mismatch → violation
  const v42e = validateSchema(
    { user: { id: 'not-a-number' } },
    { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'number' } } } } }
  );
  assert(v42e.length > 0 && v42e.some(m => m.includes('number')),
    `[42e] nested type mismatch → violation (got: ${JSON.stringify(v42e)})`);

  // [42f] matchesContract: exact pathname + method match → true
  assert(matchesContract('http://localhost:3000/api/user', 'GET', { url: '/api/user', method: 'GET' }),
    `[42f] matchesContract exact pathname + method → true`);

  // [42g] matchesContract: URL mismatch → false
  assert(!matchesContract('http://localhost:3000/api/products', 'GET', { url: '/api/user', method: 'GET' }),
    `[42g] matchesContract URL mismatch → false`);

  // [42h] matchesContract: method mismatch → false
  assert(!matchesContract('http://localhost:3000/api/user', 'POST', { url: '/api/user', method: 'GET' }),
    `[42h] matchesContract method mismatch → false`);

  // [42i] matchesContract: no method constraint → matches any method
  assert(matchesContract('http://localhost:3000/api/data', 'POST', { url: '/api/data' }),
    `[42i] matchesContract no method constraint → true for any method`);

  // ── [43] Severity overrides — applyOverrides (pure function, no Chrome) ──────
  console.log('\n[43] Severity Overrides — applyOverrides (D7.5)');

  // [43a] Override downgrades severity: warning → info; overriddenCount reflects it
  const rep43a = { routes: [{ url: '/', errors: [{ type: 'seo_missing_description', severity: 'warning', message: 't' }] }], flows: [] };
  const s43a = applyOverrides(rep43a, { seo_missing_description: 'info' });
  assert(rep43a.routes[0].errors[0].severity === 'info',
    `[43a] override downgrades warning → info (got: "${rep43a.routes[0].errors[0].severity}")`);
  assert(s43a.overriddenCount === 1,
    `[43a] overriddenCount is 1 (got: ${s43a.overriddenCount})`);

  // [43b] suppress removes finding + suppressedCount reflects it
  const rep43b = { routes: [{ url: '/', errors: [{ type: 'cache_headers_missing', severity: 'info', message: 't' }, { type: 'network', severity: 'critical', message: 't2' }] }], flows: [] };
  const s43b = applyOverrides(rep43b, { cache_headers_missing: 'suppress' });
  assert(rep43b.routes[0].errors.length === 1 && rep43b.routes[0].errors[0].type === 'network',
    `[43b] suppress removes finding from errors array (length: ${rep43b.routes[0].errors.length})`);
  assert(s43b.suppressedCount === 1,
    `[43b] suppressedCount is 1 (got: ${s43b.suppressedCount})`);

  // [43c] override type not present in findings → zero stats, no mutation
  const rep43c = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'critical', message: 't' }] }], flows: [] };
  const s43c = applyOverrides(rep43c, { seo_missing_description: 'info' });
  assert(s43c.overriddenCount === 0 && s43c.suppressedCount === 0,
    `[43c] override on absent type → zero stats (overridden=${s43c.overriddenCount}, suppressed=${s43c.suppressedCount})`);

  // [43d] empty overrides map → no mutations, zero stats
  const rep43d = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'critical', message: 't' }] }], flows: [] };
  const s43d = applyOverrides(rep43d, {});
  assert(s43d.overriddenCount === 0 && s43d.suppressedCount === 0,
    `[43d] empty overrides → zero stats (overridden=${s43d.overriddenCount}, suppressed=${s43d.suppressedCount})`);

  // [43e] override applies to flow findings
  const rep43e = { routes: [], flows: [{ flowName: 'checkout', findings: [{ type: 'flow_assert_failed', severity: 'critical', message: 't' }] }] };
  applyOverrides(rep43e, { flow_assert_failed: 'warning' });
  assert(rep43e.flows[0].findings[0].severity === 'warning',
    `[43e] override applies to flow findings (got: "${rep43e.flows[0].findings[0].severity}")`);

  // [43f] null severityOverrides → same early-return as empty map (zero stats, no mutation)
  const rep43f = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'critical', message: 't' }] }], flows: [] };
  const s43f = applyOverrides(rep43f, null);
  assert(s43f.overriddenCount === 0 && s43f.suppressedCount === 0,
    `[43f] null overrides → zero stats (overridden=${s43f.overriddenCount}, suppressed=${s43f.suppressedCount})`);

  // [43g] unknown/invalid override value → finding left unchanged
  const rep43g = { routes: [{ url: '/', errors: [{ type: 'network', severity: 'warning', message: 't' }] }], flows: [] };
  const s43g = applyOverrides(rep43g, { network: 'critial' }); // deliberate typo — unrecognised value
  assert(rep43g.routes[0].errors[0].severity === 'warning' && s43g.overriddenCount === 0,
    `[43g] unknown override value → finding unchanged (severity=${rep43g.routes[0].errors[0].severity}, overridden=${s43g.overriddenCount})`);

  // ── [44] Auth token refresh — refreshSession (pure function, no Chrome) ────────
  console.log('\n[44] Auth Token Refresh — refreshSession (D7.6)');

  // [44a] null auth → { refreshed: false } (public crawl, no-op)
  const r44a = await refreshSession(null, null, 'http://localhost:3100');
  assert(r44a.refreshed === false,
    `[44a] null auth → refreshed: false (got: ${r44a.refreshed})`);

  // [44b] auth with steps but no session file yet → { refreshed: false }
  const r44b = await refreshSession(null, { steps: [{ action: 'navigate', path: '/login' }], sessionFile: '.argus-no-such-session-44b.json' }, 'http://localhost:3100');
  assert(r44b.refreshed === false,
    `[44b] missing session file → refreshed: false (got: ${r44b.refreshed})`);

  // [44c] fresh session (maxAge=1h, refreshWindow=5min, age≈0) → { refreshed: false }
  const tmpSession44c = '.argus-test-session-44c.json';
  fs.writeFileSync(tmpSession44c, JSON.stringify({ savedAt: new Date().toISOString(), cookies: '', localStorage: {}, sessionStorage: {} }), 'utf8');
  try {
    const r44c = await refreshSession(null, { steps: [{ action: 'navigate', path: '/login' }], sessionFile: tmpSession44c, sessionMaxAgeMs: 60 * 60 * 1000, sessionRefreshWindowMs: 5 * 60 * 1000 }, 'http://localhost:3100');
    assert(r44c.refreshed === false,
      `[44c] fresh session → refreshed: false (got: ${r44c.refreshed})`);
  } finally {
    if (fs.existsSync(tmpSession44c)) fs.unlinkSync(tmpSession44c);
  }

  // [44d] auth with empty steps array → same early-return as null auth
  const r44d = await refreshSession(null, { steps: [], sessionFile: '.argus-no-such-session-44d.json' }, 'http://localhost:3100');
  assert(r44d.refreshed === false,
    `[44d] empty steps array → refreshed: false (got: ${r44d.refreshed})`);

  // [44e] corrupted/unparseable session file → { refreshed: false } (parse error branch)
  const tmpSession44e = '.argus-test-session-44e.json';
  fs.writeFileSync(tmpSession44e, 'not-valid-json', 'utf8');
  try {
    const r44e = await refreshSession(null, { steps: [{ action: 'navigate', path: '/login' }], sessionFile: tmpSession44e }, 'http://localhost:3100');
    assert(r44e.refreshed === false,
      `[44e] corrupted session file → refreshed: false (got: ${r44e.refreshed})`);
  } finally {
    if (fs.existsSync(tmpSession44e)) fs.unlinkSync(tmpSession44e);
  }

  // ── [45] Slack-optional mode — isSlackConfigured + generateHtmlReport (D7.7) ──
  console.log('\n[45] Slack-optional mode — isSlackConfigured + generateHtmlReport (D7.7)');

  // [45a] isSlackConfigured returns false when SLACK_BOT_TOKEN is absent
  const savedToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  assert(isSlackConfigured() === false,
    `[45a] no SLACK_BOT_TOKEN → isSlackConfigured() returns false`);

  // [45b] isSlackConfigured returns true when SLACK_BOT_TOKEN is set
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  assert(isSlackConfigured() === true,
    `[45b] SLACK_BOT_TOKEN present → isSlackConfigured() returns true`);
  // restore original value
  if (savedToken !== undefined) process.env.SLACK_BOT_TOKEN = savedToken;
  else delete process.env.SLACK_BOT_TOKEN;

  // [45c] generateHtmlReport produces a valid self-contained HTML file
  const tmpReportJson = path.join(__dirname, '..', 'reports', 'argus-test-report-45.json');
  const minimalReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:3100',
    summary: { total: 1, critical: 0, warning: 1, info: 0 },
    routes: [{ route: '/test', url: 'http://localhost:3100/test', errors: [{ type: 'test_finding', severity: 'warning', message: 'audit test' }] }],
    flows: [],
  };
  fs.mkdirSync(path.dirname(tmpReportJson), { recursive: true });
  fs.writeFileSync(tmpReportJson, JSON.stringify(minimalReport, null, 2), 'utf8');
  const tmpReportHtml = path.join(path.dirname(tmpReportJson), 'report.html');
  try {
    const htmlPath = generateHtmlReport(tmpReportJson);
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert(
      fs.existsSync(htmlPath) && html.includes('<title>') && html.includes('Argus Report') && html.includes('audit test'),
      `[45c] generateHtmlReport writes valid HTML with embedded findings`
    );
  } finally {
    if (fs.existsSync(tmpReportJson)) fs.unlinkSync(tmpReportJson);
    if (fs.existsSync(tmpReportHtml)) fs.unlinkSync(tmpReportHtml);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('\u2554' + '\u2550'.repeat(54) + '\u2557');
  console.log('\u2551     ARGUS Test Harness Validator — full coverage    \u2551');
  console.log('\u255A' + '\u2550'.repeat(54) + '\u255D');
  console.log('');

  let serverProc, stagingProc, mcp;

  try {
    console.log('\u25B6 Starting dev fixture server on port', HARNESS_DEV_PORT, '...');
    serverProc = await startServer(HARNESS_DEV_PORT);

    console.log('\u25B6 Starting staging fixture server on port', HARNESS_STAGING_PORT, '...');
    stagingProc = await startServer(HARNESS_STAGING_PORT);

    console.log('\u25B6 Connecting to Chrome DevTools MCP ...');
    mcp = await createMcpClient();
    console.log('  Connected.\n');

    await runTests(mcp, stagingProc);

  } catch (err) {
    console.error('\n\u274C Fatal error:', err.message);
    if (/MCP|chrome|connect|ECONNREFUSED/i.test(err.message)) {
      console.error('\n  Start Chrome with --remote-debugging-port=9222:');
      console.error('    Windows: chrome.exe --remote-debugging-port=9222 --headless=new');
      console.error('    Mac:     open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new');
    }
    process.exitCode = 1;

  } finally {
    if (mcp?.close)   try { mcp.close();         } catch {}
    if (stagingProc)  stagingProc.kill();
    if (serverProc)   serverProc.kill();

    const total = passed + failed;
    console.log('\n' + '\u2500'.repeat(56));
    console.log(`Results: ${passed}/${total} hard assertions passed, ${failed} failed`);
    if (failLog.length > 0) {
      console.log('\nFailed assertions:');
      failLog.forEach(f => console.log(`  \u2717 ${f}`));
    }
    if (failed > 0)      process.exitCode = 1;
    else if (total > 0)  console.log('\n\u2705 All hard assertions passed.');
  }
}

main();
