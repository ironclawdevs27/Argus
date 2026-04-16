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
import path             from 'path';
import { fileURLToPath } from 'url';
import { PNG }          from 'pngjs';
import pixelmatch       from 'pixelmatch';

import { createMcpClient }                         from '../src/utils/mcp-client.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../src/utils/css-analyzer.js';
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
const NET_SCRIPT = `() => window.performance.getEntriesByType('resource').map(function(e){return{url:e.name,status:e.responseStatus??0,method:'GET',resourceType:e.initiatorType,duration:Math.round(e.duration||0)}})`;

// Read in-page console capture array (populated by the interceptor in each fixture page).
// Returns array directly so CDP serialises it once.
const CONSOLE_READ_SCRIPT = `() => (window.__argus_console||[])`;

// ── Lightweight page crawler ──────────────────────────────────────────────────
// Does NOT import crawl-and-report.js — avoids Slack initialisation side-effect.

async function crawlFixture(mcp, url, { critical = false, waitFor = null } = {}) {
  const errors = [];

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

// ── Accessibility measurement ─────────────────────────────────────────────────

async function measureA11y(mcp, url) {
  try {
    const result       = await mcp.lighthouse_audit({ categories: ['accessibility'], url });
    const score        = result?.categories?.accessibility?.score ?? result?.accessibility?.score;
    const audits       = result?.audits ?? {};
    const failingAudits = Object.entries(audits)
      .filter(([, a]) => a.score === 0 && a.details?.type !== 'manual')
      .map(([id, a]) => ({ id, title: a.title ?? id }));
    return { score: score != null ? Math.round(score * 100) : null, failingAudits };
  } catch { return { score: null, failingAudits: [] }; }
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
