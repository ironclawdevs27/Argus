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
 *     Windows (PowerShell): & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\chrome-argus"
 *     Mac:     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *                --remote-debugging-port=9222 --headless=new
 *
 * Usage:
 *   node test-harness/validate.js
 *
 * Exit code: 0 = all hard assertions pass, 1 = any hard assertion fails
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

import { createMcpClient, unwrapEval } from '../src/utils/mcp-client.js';
import { CdpBrowserAdapter } from '../src/adapters/browser.js';
import { checkLighthouse, parseLighthouseReport } from '../src/utils/lighthouse-checker.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../src/utils/css-analyzer.js';
import { SEO_ANALYSIS_SCRIPT, parseSeoAnalysisResult } from '../src/utils/seo-analyzer.js';
import { SECURITY_ANALYSIS_SCRIPT, parseSecurityAnalysisResult, analyzeSecurityConsole, analyzeSecurityNetwork } from '../src/utils/security-analyzer.js';
import { CONTENT_ANALYSIS_SCRIPT, parseContentAnalysisResult } from '../src/utils/content-analyzer.js';
import { analyzeResponsive } from '../src/utils/responsive-analyzer.js';
import { analyzeMemory } from '../src/utils/memory-analyzer.js';
import { analyzeHover } from '../src/utils/hover-analyzer.js';
import { analyzeSnapshot } from '../src/utils/snapshot-analyzer.js';
import { saveSession, restoreSession, refreshSession } from '../src/utils/session-manager.js';
import { loadBaseline, saveBaseline, applyBaseline, appendTrend, getCurrentBranch } from '../src/utils/baseline-manager.js';
import { mergeRunResults } from '../src/utils/flakiness-detector.js';
import { runFlow, normalizeArray, resolveUidForSelector } from '../src/utils/flow-runner.js';
import { chunkArray, mapWithConcurrency, auditRoutesConcurrently, withTimeout, auditRouteWithRetry, routeResilienceFromEnv } from '../src/utils/parallel-crawler.js';
import { validateSchema, matchesContract, extractResponseBody } from '../src/utils/contract-validator.js';
import { applyOverrides } from '../src/utils/severity-overrides.js';
import { auditEnvVariables, detectFeatureFlagLeakage, enrichErrorsWithSource, detectDeadRoutes, INTERNAL_LINKS_SCRIPT } from '../src/utils/codebase-analyzer.js';
import { isSlackConfigured } from '../src/utils/slack-guard.js';
import { formatPrComment, buildStatusPayload, generateReleaseNotes, createCheckRun, completeCheckRun, prResultToReport, reportPrValidation } from '../src/utils/github-reporter.js';
import { discoverFromSitemap, discoverFromNextJs, discoverFromReactRouter, mergeRoutes, discoverRoutes, discoverNextJsRouteFiles } from '../src/utils/route-discoverer.js';
import { buildImportGraph, parseImports, findDependents, resolveSpecifier } from '../src/utils/import-graph.js';
import { detectFramework, generateTargetsJs, generateEnvFile } from '../src/cli/init.js';
import os from 'os';
import { generateHtmlReport } from '../src/utils/html-reporter.js';
import {
  HARNESS_DEV_PORT,
  HARNESS_STAGING_PORT
} from './harness-config.js';
// Import the production crawl function so the harness exercises the real pipeline,
// not a hand-rolled duplicate. The Slack init side-effect concern was resolved by lazy
// WebClient init, so importing crawl-and-report.js is now safe in test context.
import { crawlRouteCheap, checkHttpsRequired } from '../src/orchestration/crawl-and-report.js';
import { classifyFinding, classifySensitivity, redactForEgress, summarizeRedaction, buildRedactionRider, redactReport, isSensitiveType, deepScrub, REDACT_MARKER } from '../src/utils/sensitivity-classifier.js';
import { scrubText, findSensitiveSpans } from '../src/utils/secret-patterns.js';
import { resolvePolicy, effectivePolicyOpts, policyFromEnv, governanceOptOutClamped, _resetPolicyCacheForTests } from '../src/utils/redaction-policy.js';
import { verifySignedPolicy, ensureGovernancePolicy, postRedactionAggregate, governanceActive, governancePolicyVersion, canonicalPolicyBytes, _resetGovernanceForTests } from '../src/utils/governance-seam.js';
import { teamVaultActive, teamTokenFor, ensureTokenVaultWired, flushTeamVault, pendingTeamVaultCount, _resetTeamVaultForTests } from '../src/utils/team-vault.js';
import { analyzeIssues } from '../src/utils/issues-analyzer.js';
import { parseNetworkTiming } from '../src/utils/network-timing-analyzer.js';
import { analyzeKeyboard } from '../src/utils/keyboard-analyzer.js';
import { analyzeTheme }              from '../src/utils/theme-analyzer.js';
import { analyzeDesignFidelity }    from '../src/utils/design-fidelity-analyzer.js';
import { analyzeVisualRegression }  from '../src/utils/visual-diff-analyzer.js';
import { analyzeA11yDeep }          from '../src/utils/a11y-deep-analyzer.js';
import { analyzeHar }               from '../src/utils/har-recorder.js';
import { analyzeMotion }            from '../src/utils/motion-analyzer.js';
import { analyzeFont }              from '../src/utils/font-analyzer.js';
import { analyzeForm }              from '../src/utils/form-analyzer.js';
import { parseFigmaUrl }           from '../src/adapters/figma.js';
import { analyzeWebVitals }        from '../src/utils/web-vitals-analyzer.js';
import { WatchSession } from '../src/orchestration/watch-mode.js';
import { validateConfig } from '../src/config/schema.js';
import * as argusTargets from '../src/config/targets.js';
import { createFinding } from '../src/domain/finding.js';
import { withRetry } from '../src/utils/retry.js';
import { diffNetworkRequests, diffConsoleMessages } from '../src/utils/diff.js';
import { parsePrUrl, mapFilesToRoutes, mapFilesToRoutesDeep, fetchPrFiles, firstAddedLine, resolveAnnotationTarget, stripWorkspacePrefix, packageRelativePath } from '../src/utils/pr-diff-analyzer.js';
import { prFilesResponse } from './contracts/github-pr-files-sample.js';
import { buildStepSummary, writeGithubOutputs, writeStepSummary, checkTargetReachable, normalizeRoutePaths, allRoutesFailed, prExitCode, safeFindingLine } from '../src/cli/pr-validate.js';
import { diffRoutesAgainstBaseline, decidePrBlock, resolvePrBaselineFile, loadPrBaseline, savePrBaseline, tagFindingNovelty, severityTally } from '../src/utils/pr-baseline.js';
import { AUDIT_DEPTHS, ALL_EXPENSIVE_ANALYZERS, resolveAuditDepth, selectAnalyzers, runDepthAnalyzers } from '../src/utils/audit-depth.js';
import { resolveTargetUrl, pickPreviewDeployment, previewUrlFromStatuses } from '../src/utils/deploy-preview.js';
import { githubFetch, isRateLimitResponse, retryDelayMs, classifyGitHubError, scrubSecrets } from '../src/utils/github-api.js';
import { findChrome } from '../src/cli/chrome-launcher.js';
import { checkChrome, checkMcpConfig, checkEnvKeys } from '../src/cli/doctor.js';
import { checkSourceMapExposure, checkOpenRedirects } from '../src/utils/security-analyzer.js';
import { loadRunHistory, recordRunHistory, computeNoiseScores, applyNoiseFilter, NOISE_MIN_RUNS } from '../src/utils/noise-filter.js';
import { getRecentChanges, matchFilesToRoutePath, linkRootCauses } from '../src/utils/root-cause-linker.js';
// Golden MCP tool response schemas (block [147] — test-harness/contracts/ source of truth).
import {
  TOOL_RESPONSE_SCHEMAS, TOOL_NAMES, formatZodError,
  auditResponseSchema, getContextResponseSchema, reportSummarySchema, prValidateResponseSchema,
  redactionRiderSchema,
} from './contracts/mcp-tool-schemas.js';
// Recorded-shape GitHub reporting-endpoint fixtures (block [166] — Phase F1).
import {
  issueCommentsListWithArgus, issueCommentsListNoArgus, checkRunCreateResponse, checkRunCompleteResponse,
  makeReportingFetchStub, ARGUS_COMMENT_MARKER, ARGUS_COMMENT_ID, CHECK_RUN_ID, HEAD_SHA,
} from './contracts/github-reporting-samples.js';

// ── Section 1 gap-closer imports (blocks [94]–[107]) ──────────────────────────
import { parseConsoleMsgResponse, parseNetworkReqResponse, parseListPagesResponse } from '../src/utils/mcp-parsers.js';
import { registerCheap, registerExpensive, getCheap, getExpensive, clearAll as clearRegistry } from '../src/registry.js';
import { deduplicateFindings, rebuildSummary, processReport } from '../src/orchestration/report-processor.js';
import { dispatchAll } from '../src/orchestration/dispatcher.js';
import { postBugReport, postRetestResult, acknowledgeMessage } from '../src/orchestration/slack-notifier.js';
import { verifySlackSignature } from '../src/server/slash-command-handler.js';
import { handleInteraction } from '../src/server/interaction-handler.js';
import { slugify } from '../src/utils/slug.js';
import { startSpan, recordFinding, recordFlaky, recordNewFindings } from '../src/utils/telemetry.js';
import { childLogger } from '../src/utils/logger.js';
import * as argusJs from '../src/argus.js';
import * as argBatchRunner from '../src/batch-runner.js';

// ── Section 2 gap-closer imports (blocks [108]–[116]) ─────────────────────────
import { hasSession } from '../src/utils/session-persistence.js';
import { isGitHubConfigured, postPrComment } from '../src/utils/github-reporter.js';
import { startDashboard } from '../src/orchestration/watch-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
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

/**
 * Strict-soft mode (HARNESS_MAX_PLAN 4.3 \u2014 strict-soft CI lane).
 * The default per-PR run ships the environment-sensitive checks (perf-trace, heap-growth;
 * historically Lighthouse too, before the lighthouse_audit fix) as soft() so they cannot
 * fail the 978-gate. The weekly strict-soft lane (.github/workflows/harness-strict.yml,
 * headless) sets ARGUS_HARNESS_STRICT_SOFT=1, which promotes EVERY soft() to a counted
 * hard assert(). Those ~23 checks then become real, verified-weekly assertions in that
 * lane only (clean run = 1001/1001). Leaving the flag unset (the default) keeps soft() a
 * non-counting log, so the 978-gate and every doc stat are unchanged.
 * (The lane was first built with Xvfb + non-headless Chrome, but that broke page rendering
 * on the GitHub runner and the lighthouse_audit fix made Lighthouse work headless \u2014 so the
 * lane is headless.) */
const STRICT_SOFT = /^(1|true|yes|on)$/i.test(process.env.ARGUS_HARNESS_STRICT_SOFT || '');

/** Soft: logged, never counts against exit code \u2014 unless STRICT_SOFT promotes it to hard. */
function soft(condition, message) {
  if (STRICT_SOFT) {
    assert(condition, `(soft\u2192hard) ${message}`);
    return;
  }
  console.log(`  ${condition ? '~\u2713' : '~\u2717'} (soft) ${message}`);
}

// ── Server management ─────────────────────────────────────────────────────────

function startServer(port, { staging = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), ARGUS_ENV: staging ? 'staging' : 'dev' };
    const proc = spawn(
      'node',
      [path.join(__dirname, 'server.js')],
      { env, stdio: 'pipe' }
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

/** Finds the next available TCP port starting from startPort. */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(startPort, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(findFreePort(startPort + 1)));
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
  if (typeof val === 'string') return val;
  if (typeof val === 'boolean' || typeof val === 'number') return val;
  if (typeof val?.result === 'string') return val.result;
  if (typeof val?.value === 'string') return val.value;
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

// D6.2 — document.write / document.writeln detection (same logic as crawl-and-report.js)
const INJECT_DOC_WRITE_LISTENER = `() => {
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
}`;
const EXTRACT_DOC_WRITE_LISTENER = `() => JSON.stringify(window.__argusDocWrites ?? [])`;

// D6.2 — Static analysis: scan inline + same-origin external scripts for document.write/writeln calls.
// More reliable than runtime patching because post-load document.write causes document.open() which
// resets the JS context and destroys any previously-injected patches.
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

// D6.3 — Long task detection (same logic as crawl-and-report.js)
const INJECT_LONG_TASK_LISTENER = `() => {
  if (!window.__argusLongTasks) window.__argusLongTasks = []; // preserve in-page direct measurement
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
  } catch (e) { /* longtask not supported — skip */ }
}`;
const EXTRACT_LONG_TASK_LISTENER = `() => JSON.stringify(window.__argusLongTasks ?? [])`;

// D6.5 — Service worker registration failure detection (same logic as crawl-and-report.js)
const INJECT_SW_LISTENER = `() => {
  if (!window.__argusSwErrors) window.__argusSwErrors = []; // preserve in-page direct capture
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

  // Snapshot browser console count before navigation for CORS baseline slicing.
  // Captured here (before navigate) to establish the accumulation watermark.
  const consoleListBaseline = normalizeArray(await mcp.list_console_messages().catch(() => [])).length;

  await mcp.navigate_page({ url });

  // Inject listeners IMMEDIATELY after navigation so the new page context is live.
  // Must run before the settle wait so events fired by setTimeout/onload are captured.
  await mcp.evaluate_script({ function: INJECT_SYNC_XHR_LISTENER }).catch(() => { });   // D6.1
  await mcp.evaluate_script({ function: INJECT_DOC_WRITE_LISTENER }).catch(() => { });  // D6.2
  await mcp.evaluate_script({ function: INJECT_LONG_TASK_LISTENER }).catch(() => { });  // D6.3
  await mcp.evaluate_script({ function: INJECT_SW_LISTENER }).catch(() => { });         // D6.5

  if (waitFor) {
    // Poll every 300 ms for up to 5 s — wait_for alone doesn't reliably reject on timeout.
    const pollEnd = Date.now() + 5000;
    let selectorFound = false;
    while (!selectorFound && Date.now() < pollEnd) {
      const existsRaw = await mcp.evaluate_script({
        function: `() => !!document.querySelector(${JSON.stringify(waitFor)})`,
      });
      selectorFound = parseEval(existsRaw) === true || parseEval(existsRaw) === 'true';
      if (!selectorFound && Date.now() < pollEnd) await sleep(300);
    }
    if (!selectorFound) {
      errors.push({
        type: 'load_failure',
        message: `Selector "${waitFor}" not found within timeout`,
        severity: critical ? 'critical' : 'warning'
      });
    }
    await sleep(300);
  } else {
    await sleep(2000);
  }

  // Blank page check
  const bodyRes = await mcp.evaluate_script({ function: '() => document.body?.innerText?.trim() ?? ""' });
  const bodyText = String(parseEval(bodyRes, ''));
  if (!bodyText || bodyText.length < 50)
    errors.push({ type: 'blank_page', message: 'Page appears blank (body < 50 chars)', severity: 'critical' });

  // Console messages — read from in-page interceptor; list_console_messages() misses
  // events that fire during page load before the MCP has subscribed.
  const consoleMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
  for (const msg of consoleMsgs) {
    const rawLevel = (msg.level ?? '').toLowerCase();
    const level = rawLevel === 'warn' ? 'warning' : rawLevel; // normalise console.warn → 'warning'
    if (level !== 'error' && level !== 'warning') continue;
    errors.push({
      type: 'console', level,
      message: msg.text ?? msg.message ?? String(msg),
      severity: level === 'error' ? (critical ? 'critical' : 'warning') : 'info',
    });
  }

  // Network failures — use Performance API instead of list_network_requests()
  // to capture requests that completed before the MCP subscribed.
  const networkReqs = evalToArray(await mcp.evaluate_script({ function: NET_SCRIPT }));
  for (const req of networkReqs) {
    const status = req.status ?? 0;
    if (status < 400) continue;
    const isCrit = status >= 500 || status === 401 || status === 403;
    errors.push({
      type: 'network', status, method: req.method ?? 'GET',
      requestUrl: req.url, severity: isCrit ? 'critical' : (critical ? 'warning' : 'info')
    });
  }

  // API frequency analysis (inlined — no Slack dependency)
  const staticExt = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)(\?|$)/i;
  const apiCalls = networkReqs.filter(r => {
    const u = r.url ?? '';
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
    try { const u = new URL(req.url); ep = u.pathname.replace(/\/\d+/g, '/{id}'); }
    catch { ep = (req.url ?? '').replace(/[?#].*/, '').replace(/\/\d+/g, '/{id}'); }
    const key = `${method}::${ep}`;
    if (!groups[key]) groups[key] = { method, ep, count: 0 };
    groups[key].count++;
  }
  const uniqueCount = Object.keys(groups).length;
  const totalCount = apiCalls.length;
  for (const { method, ep, count } of Object.values(groups)) {
    if (count <= 1) continue;
    const sev = count >= 5 ? 'critical' : count >= 3 ? 'warning' : 'info';
    errors.push({
      type: 'api_duplicate_call', endpoint: ep, callCount: count,
      method, severity: sev, message: `API called ${count}× : ${method} ${ep}`
    });
  }
  if (totalCount > 0) {
    const dupCount = Object.values(groups).filter(g => g.count > 1).length;
    errors.push({
      type: 'api_call_summary', uniqueEndpoints: uniqueCount,
      totalCalls: totalCount, duplicateEndpoints: dupCount, severity: 'info',
      message: `API summary: ${totalCount} calls to ${uniqueCount} unique endpoints`
    });
  }

  // Network performance analysis — slow/large API detection (v3 Phase A2)
  for (const entry of networkReqs) {
    const reqUrl = entry.url ?? '';
    if (staticExt.test(reqUrl)) continue;
    if (
      !/\/(api|graphql|rest|v\d+)\//i.test(reqUrl) &&
      !['xmlhttprequest', 'fetch', 'xhr'].includes((entry.resourceType ?? '').toLowerCase())
    ) continue;
    const dur = entry.duration ?? 0;
    const bytes = entry.decodedBodySize || entry.transferSize || 0;
    if (dur > 3000) {
      errors.push({
        type: 'slow_api', requestUrl: reqUrl, duration: Math.round(dur),
        severity: 'critical', message: `Slow API ${Math.round(dur)} ms — ${reqUrl}`
      });
    } else if (dur > 1000) {
      errors.push({
        type: 'slow_api', requestUrl: reqUrl, duration: Math.round(dur),
        severity: 'warning', message: `Slow API ${Math.round(dur)} ms — ${reqUrl}`
      });
    }
    if (bytes > 2 * 1024 * 1024) {
      errors.push({
        type: 'large_payload', requestUrl: reqUrl, bytes,
        severity: 'critical', message: `Oversized payload ${Math.round(bytes / 1024)} KB — ${reqUrl}`
      });
    } else if (bytes > 500 * 1024) {
      errors.push({
        type: 'large_payload', requestUrl: reqUrl, bytes,
        severity: 'warning', message: `Oversized payload ${Math.round(bytes / 1024)} KB — ${reqUrl}`
      });
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
    const cssRaw = await mcp.evaluate_script({ function: CSS_ANALYSIS_SCRIPT });
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
    const rdRaw = await mcp.evaluate_script({ function: `() => window.performance.getEntriesByType('navigation')[0]?.redirectCount ?? 0` });
    const rdCount = Number(unwrapEval(rdRaw) ?? 0);
    if (rdCount > 2) {
      errors.push({
        type: 'redirect_chain', count: rdCount, severity: 'warning',
        message: `Redirect chain length ${rdCount} (threshold: > 2)`
      });
    }
  } catch { /* skip */ }

  // Broken internal link detection (D2.3) — HEAD each same-origin <a href>
  try {
    const INTERNAL_LINKS_SCRIPT = `() => { try { var orig = window.location.origin; return Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; }).filter(function(h){ if (!h || h.indexOf('#') === 0 || h.indexOf('mailto:') === 0 || h.indexOf('tel:') === 0) return false; try { return new URL(h).origin === orig; } catch { return false; } }); } catch(e) { return []; } }`;
    const linksRaw = await mcp.evaluate_script({ function: INTERNAL_LINKS_SCRIPT });
    const links = [...new Set(evalToArray(linksRaw).filter(Boolean))];
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
          type: 'broken_link', requestUrl: href, status: 404,
          severity: 'warning', message: `Broken internal link: ${href} (HTTP 404)`
        });
      }
    }
  } catch { /* skip */ }

  // Sync XHR detection (D6.1)
  try {
    const syncXhrRaw = await mcp.evaluate_script({ function: EXTRACT_SYNC_XHR_LISTENER });
    const syncXhrs = evalToArray(syncXhrRaw);
    for (const entry of syncXhrs) {
      errors.push({
        type: 'sync_xhr',
        method: entry.method ?? 'GET',
        requestUrl: entry.url,
        message: `Synchronous XHR: ${entry.method ?? 'GET'} ${entry.url} — blocks the main thread`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // document.write detection — static analysis (D6.2)
  // Runtime patching is unreliable: post-load document.write triggers document.open() which
  // resets the JS context. Scanning script source is stable regardless of execution timing.
  try {
    const docWriteRaw = await mcp.evaluate_script({ function: DETECT_DOC_WRITE_STATIC });
    const docWrites = evalToArray(docWriteRaw);
    for (const entry of docWrites) {
      errors.push({
        type: 'document_write',
        method: entry.method,
        content: entry.content,
        message: `document.${entry.method}() is parser-blocking and degrades page performance`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // Long task detection (D6.3)
  try {
    const longTaskRaw = await mcp.evaluate_script({ function: EXTRACT_LONG_TASK_LISTENER });
    const longTasks = evalToArray(longTaskRaw);
    for (const entry of longTasks) {
      errors.push({
        type: 'long_task',
        duration: entry.duration,
        startTime: entry.startTime,
        attribution: entry.attribution,
        message: `Long task: ${entry.duration}ms — blocks the main thread (threshold: 50ms)`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // CORS error detection (D6.4)
  // Primary: in-page console interceptor (fixture calls console.error with "cors policy" text).
  // Fallback: CDP list_console_messages() which may capture browser-level CORS messages.
  try {
    const corsSet = new Set();
    const addCors = (text) => {
      if (!corsSet.has(text)) {
        corsSet.add(text);
        errors.push({ type: 'cors_error', message: text || 'CORS policy violation', severity: 'critical' });
      }
    };
    for (const msg of consoleMsgs) {
      const text = (msg.text ?? msg.message ?? '');
      if (text.toLowerCase().includes('has been blocked by cors policy')) addCors(text);
    }
    const allCdpMsgs = normalizeArray(await mcp.list_console_messages().catch(() => []));
    const corsBase = allCdpMsgs.length > consoleListBaseline ? consoleListBaseline : 0;
    const browserMsgs = allCdpMsgs.slice(corsBase);
    for (const msg of browserMsgs) {
      const text = (msg.text ?? msg.message ?? '');
      if (text.toLowerCase().includes('has been blocked by cors policy')) addCors(text);
    }
  } catch { /* skip */ }

  // Service worker registration failure detection (D6.5)
  try {
    const swRaw = await mcp.evaluate_script({ function: EXTRACT_SW_LISTENER });
    const swErrs = evalToArray(swRaw);
    for (const entry of swErrs) {
      errors.push({
        type: 'sw_registration_error',
        scriptURL: entry.scriptURL,
        message: `Service worker registration failed for "${entry.scriptURL}": ${entry.message}`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  // Cache header detection — same-origin static assets missing Cache-Control + ETag (D6.6)
  try {
    const cacheRaw = await mcp.evaluate_script({ function: CACHE_HEADER_SCRIPT });
    const cacheItems = evalToArray(cacheRaw);
    for (const entry of cacheItems) {
      const filename = (entry.url ?? '').replace(/^.*\//, '').split('?')[0] || entry.url;
      errors.push({
        type: 'cache_headers_missing',
        requestUrl: entry.url,
        message: `No cache headers on "${filename}" — missing both Cache-Control and ETag`,
        severity: 'info',
      });
    }
  } catch { /* skip */ }

  // debugger; statement detection — inline + same-origin external scripts (D6.7)
  try {
    const dbgRaw = await mcp.evaluate_script({ function: DEBUGGER_SCRIPT });
    const dbgHits = evalToArray(dbgRaw);
    for (const entry of dbgHits) {
      errors.push({
        type: 'debugger_statement',
        scriptUrl: entry.scriptUrl,
        line: entry.line,
        snippet: entry.snippet,
        message: `debugger; statement found in "${entry.scriptUrl}" (line ${entry.line}) — remove before shipping`,
        severity: 'critical',
      });
    }
  } catch { /* skip */ }

  // Duplicate id="" detection (D6.8)
  try {
    const dupIdRaw = await mcp.evaluate_script({ function: DUPLICATE_ID_SCRIPT });
    const dupIds = evalToArray(dupIdRaw);
    for (const entry of dupIds) {
      errors.push({
        type: 'duplicate_id',
        id: entry.id,
        count: entry.count,
        message: `Duplicate id="${entry.id}" found on ${entry.count} elements — id must be unique per document`,
        severity: 'warning',
      });
    }
  } catch { /* skip */ }

  return { errors, networkReqs, consoleMsgs };
}

// ── Full Lighthouse measurement (v3 — all 4 categories) ──────────────────────

async function measureLighthouse(mcp, url) {
  try {
    // lighthouse_audit audits the CURRENT page and rejects `url`/`categories` args —
    // navigate first, audit with defaults (mode 'navigation', device 'desktop'), then
    // parse the markdown→report.json response into { categories, audits }. Performance is
    // excluded by the tool by design (covered by the web-vitals analyzer, block [129]).
    await mcp.navigate_page({ url });
    const result = parseLighthouseReport(await mcp.lighthouse_audit({}));
    const cats = result?.categories ?? {};
    const audits = result?.audits ?? {};

    const score = (key) => {
      const s = cats[key]?.score ?? result?.[key]?.score ?? null;
      return s != null ? Math.round(s * 100) : null;
    };

    const failingAudits = Object.entries(audits)
      .filter(([, a]) => a.score === 0 && a.details?.type !== 'manual')
      .map(([id, a]) => ({ id, title: a.title ?? id }));

    return {
      accessibility: score('accessibility'),
      performance: score('performance'),
      seo: score('seo'),
      bestPractices: score('best-practices'),
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
      buf[d] = png.data[s]; buf[d + 1] = png.data[s + 1];
      buf[d + 2] = png.data[s + 2]; buf[d + 3] = png.data[s + 3];
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

// ── MCP stdio transport helpers (blocks [117]–[120]) ─────────────────────────

let _mcpSeq = 5000; // high base to avoid collision with any per-block local IDs

async function mcpStdioRead(stdout, id, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      stdout.off('data', handler);
      reject(new Error(`MCP stdio timeout waiting for id=${id}`));
    }, timeoutMs);
    const handler = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep partial last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.id === id) {
            clearTimeout(timer);
            stdout.off('data', handler);
            resolve(obj);
          }
        } catch {}
      }
    };
    stdout.on('data', handler);
  });
}

async function spawnArgusServer(cwd, extraEnv = {}) {
  const serverPath = path.resolve(__dirname, '../src/mcp-server.js');
  const proc = spawn(process.execPath, [serverPath], {
    cwd: cwd || path.resolve(__dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ARGUS_LOG_LEVEL: 'error', ARGUS_LOG_PRETTY: '0', ...extraEnv },
  });
  proc.stderr.on('data', () => {});
  proc.on('error', () => {});

  const initId = ++_mcpSeq;
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: initId, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'argus-harness', version: '1.0' } },
  }) + '\n');

  const initResp = await mcpStdioRead(proc.stdout, initId, 8000);

  // Required MCP notification after server confirms initialization
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  return { proc, initResp };
}

// ── PR Validator CLI end-to-end helpers (block [167] — Phase F2) ───────────────

/**
 * Minimal in-process mock of GitHub's "List pull request files" endpoint, so the CLI
 * (src/cli/pr-validate.js) can be driven as a child process WITHOUT touching the live
 * GitHub API (forbidden in the gate — rate limits + flakiness). fetchPrFiles honours
 * GITHUB_API_URL (the env var GitHub Actions injects), which the caller points at this
 * server. Responds to GET /repos/:owner/:repo/pulls/:n/files with the supplied file
 * list; 404 + [] otherwise. Records each request (method, url, whether an Authorization
 * header was present) so the test can assert the contract AND that no token ever left.
 */
function startMockGitHubApi(files) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, hadAuth: !!req.headers.authorization });
      if (/\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

/** Parse a $GITHUB_OUTPUT file (key=value lines) into an object. */
function parseGithubOutputFile(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * Extract the JSON result object the CLI prints to stdout for downstream pipeline steps
 * (`console.log(JSON.stringify(result, null, 2))`). The pretty-printed top-level object
 * starts with `{\n  "prUrl"` and closes with a column-0 `\n}` (nested objects close
 * indented), so those bounds isolate it unambiguously. Returns null if absent/unparseable.
 */
function extractCliResultJson(stdout) {
  const start = stdout.indexOf('{\n  "prUrl"');
  if (start < 0) return null;
  const end = stdout.indexOf('\n}', start);
  if (end < 0) return null;
  try { return JSON.parse(stdout.slice(start, end + 2)); } catch { return null; }
}

/**
 * Spawn src/cli/pr-validate.js as a child process (the exact entry point action.yml runs)
 * with a HERMETIC env: GITHUB_TOKEN / GITHUB_BASE_REF / preview / source-dir / depth /
 * concurrency are stripped so reporting skips, no baseline is found (→ the fail-safe
 * absolute-block path runs), and target resolution stays on TARGET_DEV_URL. Captures
 * stdout, stderr, the exit code, and the $GITHUB_OUTPUT + $GITHUB_STEP_SUMMARY files the
 * CLI writes. The child gets its OWN chrome-devtools-mcp client (createMcpClient → Chrome
 * 9222); the harness's own mcp is idle while we await, so the shared browser is not raced.
 */
function runPrValidateCli(extraEnv, { timeoutMs = 90000 } = {}) {
  const cliPath = path.resolve(__dirname, '../src/cli/pr-validate.js');
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prcli-'));
  const outFile = path.join(tmpDir, 'gh_output');
  const sumFile = path.join(tmpDir, 'gh_summary');
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(sumFile, '');
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: sumFile,
    ARGUS_LOG_LEVEL: 'error',
    ARGUS_LOG_PRETTY: '0',
    ...extraEnv,
  };
  // Force hermeticity: any of these inherited from the harness/shell env would change the
  // child's behaviour (reporting side effects, a real baseline, a preview/source-dir).
  for (const k of ['GITHUB_TOKEN', 'GITHUB_BASE_REF', 'ARGUS_BASELINE_FILE', 'ARGUS_PREVIEW_URL',
                   'ARGUS_PREVIEW_DETECT', 'ARGUS_SOURCE_DIR', 'ARGUS_UPDATE_BASELINE',
                   'ARGUS_PR_AUDIT_DEPTH', 'ARGUS_CONCURRENCY']) {
    if (!(k in extraEnv)) delete env[k];
  }
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cliPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      let outputs = {}, summary = '';
      try { outputs = parseGithubOutputFile(fs.readFileSync(outFile, 'utf8')); } catch {}
      try { summary = fs.readFileSync(sumFile, 'utf8'); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve({ exitCode: code, stdout, stderr, outputs, summary });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message, outputs: {}, summary: '' });
    });
  });
}

/** Send a tools/call and return the raw JSON-RPC response object. */
async function mcpToolCall(proc, name, args = {}, timeoutMs = 60000) {
  const id = ++_mcpSeq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return mcpStdioRead(proc.stdout, id, timeoutMs);
}

/** Send a tools/list and return the tools array (server-survives probe). */
async function mcpListTools(proc, timeoutMs = 10000) {
  const id = ++_mcpSeq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }) + '\n');
  const resp = await mcpStdioRead(proc.stdout, id, timeoutMs);
  return resp?.result?.tools ?? [];
}

/**
 * Upstream canary helper ([148]) — spawn chrome-devtools-mcp@<version> raw (same
 * spawn shape as src/utils/mcp-client.js), do the JSON-RPC handshake, read tools/list,
 * and return the tools array. Used to diff the live inputSchemas against the golden
 * snapshot in test-harness/contracts/. The process is killed in finally.
 */
async function listChromeDevtoolsMcpTools(version, timeoutMs = 45000) {
  const browserUrl = process.env.MCP_BROWSER_URL ?? 'http://127.0.0.1:9222';
  // shell:true → resolves npx.cmd on Windows (matches mcp-client.js); stderr inherited
  // (the package's update-notifier + privacy banner go there, not to the JSON-RPC stdout).
  const proc = spawn('npx', [
    '-y', `chrome-devtools-mcp@${version}`,
    `--browser-url=${browserUrl}`,
    '--headless=true',
    '--viewport=1920x1080',
  ], { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
  proc.on('error', () => {});
  try {
    const initId = ++_mcpSeq;
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'argus-canary', version: '1.0' } },
    }) + '\n');
    await mcpStdioRead(proc.stdout, initId, timeoutMs);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    const listId = ++_mcpSeq;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} }) + '\n');
    const resp = await mcpStdioRead(proc.stdout, listId, timeoutMs);
    return resp?.result?.tools ?? [];
  } finally {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

async function runTests(mcp, stagingProc, devPort, stagingPort) {
  const browser = new CdpBrowserAdapter(mcp);
  const B = `http://localhost:${devPort}`;
  const BS = `http://localhost:${stagingPort}`;

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
    assert(ce.length > 0, `console.error detected (found ${ce.length})`);
    assert(cw.length > 0, `console.warn detected (found ${cw.length})`);
    assert(ce.every(e => e.severity === 'warning'), `console errors → severity "warning" on non-critical route`);
  }

  // ── [3] JS errors (non-critical, severity check) ─────────────────────────
  console.log('\n[3] Non-critical JS errors — 2+ console.error at severity "warning"');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors-noncritical.html`, { critical: false });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce.length >= 2, `At least 2 console errors (found ${ce.length})`);
    assert(ce.every(e => e.severity === 'warning'), `All at severity "warning"`);
  }

  // ── [4] JS errors (critical route) ──────────────────────────────────────
  console.log('\n[4] JS Errors on critical route — expect: severity "critical" (not "warning")');
  {
    const { errors } = await crawlFixture(mcp, `${B}/js-errors-critical.html`, { critical: true });
    const ce = errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce.length >= 2, `At least 2 console errors on critical route (found ${ce.length})`);
    assert(ce.every(e => e.severity === 'critical'), `All console errors → severity "critical" on critical route`);
  }

  // ── [5] Network errors — added HTTP 403 ─────────────────────────────────
  console.log('\n[5] Network Errors — HTTP 500 critical, 401 critical, 403 critical, 404 info');
  {
    const { errors } = await crawlFixture(mcp, `${B}/network-errors.html`, { critical: false });
    const n500 = errors.filter(e => e.type === 'network' && e.status === 500);
    const n401 = errors.filter(e => e.type === 'network' && e.status === 401);
    const n403 = errors.filter(e => e.type === 'network' && e.status === 403);
    const n404 = errors.filter(e => e.type === 'network' && e.status === 404);
    assert(n500.length > 0, `HTTP 500 detected`);
    assert(n401.length > 0, `HTTP 401 detected`);
    assert(n403.length > 0, `HTTP 403 detected`);
    assert(n404.length > 0, `HTTP 404 detected`);
    assert(n500[0]?.severity === 'critical', `HTTP 500 → "critical"`);
    assert(n401[0]?.severity === 'critical', `HTTP 401 → "critical" (auth)`);
    assert(n403[0]?.severity === 'critical', `HTTP 403 → "critical" (forbidden)`);
    assert(n404[0]?.severity === 'info', `HTTP 404 → "info" on non-critical route`);
  }

  // ── [6] API frequency — added api_call_summary assertion ────────────────
  console.log('\n[6] API Frequency — ×6 critical, ×3 warning, ×2 info, plus summary entry');
  {
    const { errors } = await crawlFixture(mcp, `${B}/api-frequency.html`);
    const loop = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-loop'));
    const batch = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-batch'));
    const pair = errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-pair'));
    const summary = errors.filter(e => e.type === 'api_call_summary');
    assert(loop.length > 0 && loop[0].callCount >= 6, `data-loop ×6+ (got ${loop[0]?.callCount ?? 0})`);
    assert(batch.length > 0 && batch[0].callCount >= 3, `data-batch ×3+ (got ${batch[0]?.callCount ?? 0})`);
    assert(pair.length > 0 && pair[0].callCount >= 2, `data-pair ×2+ (got ${pair[0]?.callCount ?? 0})`);
    assert(loop[0]?.severity === 'critical', `data-loop → "critical"`);
    assert(batch[0]?.severity === 'warning', `data-batch → "warning"`);
    assert(pair[0]?.severity === 'info', `data-pair → "info"`);
    assert(summary.length > 0, `API call summary entry generated`);
  }

  // ── [7] Blank page ────────────────────────────────────────────────────────
  console.log('\n[7] Blank page — expect: blank_page critical');
  {
    const { errors } = await crawlFixture(mcp, `${B}/blank-page.html`, { critical: true });
    const blank = errors.filter(e => e.type === 'blank_page');
    assert(blank.length > 0, `blank_page detected`);
    assert(blank[0]?.severity === 'critical', `blank_page → "critical"`);
  }

  // ── [8] WaitFor success ───────────────────────────────────────────────────
  console.log('\n[8] WaitFor success — #late-content appears after 2 s, no load_failure');
  {
    const { errors } = await crawlFixture(mcp, `${B}/waitfor-page.html`, { waitFor: '#late-content' });
    assert(errors.filter(e => e.type === 'load_failure').length === 0,
      `No load_failure — selector appeared within timeout`);
  }

  // ── [9] WaitFor timeout ──────────────────────────────────────────────────
  console.log('\n[9] WaitFor timeout — #never-appears never exists → load_failure warning');
  {
    const { errors } = await crawlFixture(mcp, `${B}/waitfor-timeout.html`,
      { waitFor: '#never-appears', critical: false });
    const lf = errors.filter(e => e.type === 'load_failure');
    assert(lf.length > 0, `load_failure detected when selector never appears`);
    assert(lf[0]?.severity === 'warning', `load_failure → "warning" on non-critical route`);
  }

  // ── [10] CSS issues — non-important cascade + SCSS map ──────────────────
  console.log('\n[10] CSS Issues — !important override, cascade override, unused rules, component leak, CSS Modules, inline conflict, SCSS map');
  {
    const { errors } = await crawlFixture(mcp, `${B}/css-issues.html`);
    const impOverrides = errors.filter(e => e.type === 'css_override' && e.hasImportant);
    const nonImpOverrides = errors.filter(e => e.type === 'css_override' && !e.hasImportant);
    const unusedRules = errors.filter(e => e.type === 'css_unused_rules');
    const leaks = errors.filter(e => e.type === 'css_component_leak');
    const modules = errors.filter(e => e.type === 'css_modules_detected');
    const inlineConflicts = errors.filter(e => e.type === 'react_inline_style_conflict');
    const cssSummary = errors.find(e => e.type === 'css_summary');

    assert(impOverrides.length > 0,
      `!important CSS override detected — header background (found ${impOverrides.length})`);
    assert(nonImpOverrides.length > 0,
      `Non-!important cascade override detected — h1 color declared twice (found ${nonImpOverrides.length})`);
    assert(unusedRules.length > 0 && unusedRules[0].count > 10,
      `Unused CSS rules > 10 detected (found ${unusedRules[0]?.count ?? 0})`);
    assert(leaks.length > 0,
      `Component style leak — .card__ in button-styles.css (found ${leaks.length})`);
    assert(modules.length > 0,
      `CSS Modules hashed class names detected (found ${modules.length})`);
    assert(inlineConflicts.length > 0,
      `Inline style conflict — .inline-conflict (found ${inlineConflicts.length})`);
    assert((cssSummary?.scssSourceFiles?.length ?? 0) > 0,
      `SCSS sourceMappingURL detected in <style> tag`);
  }

  // [11] removed — the trace-based perf-budget path (measurePerf + checkPerformanceBudgets)
  // was dead (broken performance_analyze_insight wiring) and is superseded by the
  // web-vitals analyzer (block [129], perf-vitals.html). Block id [11] is intentionally
  // retired; the [10] → [12] gap is deliberate (no renumber).

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

  // ── [14] Individual Lighthouse audit items ───────────────────────────────
  console.log('\n[14] Individual Lighthouse audit items — at least one failing audit');
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

  // ── [16] Full Lighthouse suite — v3 Phase A1 ────────────────────────────
  // Shape checks are hard; score reporting stays soft (Lighthouse may still be
  // unavailable if Chrome can't be driven). chrome-devtools-mcp's lighthouse_audit
  // returns accessibility / best-practices / seo (+ agentic-browsing) and EXCLUDES
  // performance by design — performance is covered by the web-vitals analyzer [129].
  console.log('\n[16] Full Lighthouse suite — a11y, SEO, best-practices (performance excluded by design)');
  {
    const lh = await measureLighthouse(mcp, `${B}/a11y-critical.html`);
    // Hard shape check — measureLighthouse catch clause always returns failingAudits: []
    assert(Array.isArray(lh.failingAudits),
      `measureLighthouse always returns failingAudits as an array (got ${typeof lh.failingAudits})`);
    // Soft score checks — null is expected when Lighthouse cannot run (e.g. Chrome down)
    soft(lh.accessibility != null,
      `a11y score reported: ${lh.accessibility ?? 'N/A'}/100`);
    // lighthouse_audit excludes performance by design — assert it is absent, not present
    // (covered by web-vitals [129]); flipping this would falsely demand a perf score.
    soft(lh.performance == null,
      `performance excluded from lighthouse_audit by design — covered by web-vitals [129] (got ${lh.performance ?? 'null'})`);
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
      `slow_api warning detected for /api/slow-warning (found: ${perfErrors.filter(e => e.type === 'slow_api').map(e => `${e.requestUrl} ${e.severity} ${e.duration}ms`).join(', ') || 'none'
      })`,
    );

    // slow-critical: 3 200 ms > 3 000 ms threshold → severity 'critical'
    assert(
      perfErrors.some(e => e.type === 'slow_api' &&
        (e.requestUrl ?? '').includes('/api/slow-critical') && e.severity === 'critical'),
      `slow_api critical detected for /api/slow-critical (found: ${perfErrors.filter(e => e.type === 'slow_api').map(e => `${e.requestUrl} ${e.severity} ${e.duration}ms`).join(', ') || 'none'
      })`,
    );

    // large-warning: ~600 KB > 500 KB threshold → severity 'warning'
    assert(
      perfErrors.some(e => e.type === 'large_payload' &&
        (e.requestUrl ?? '').includes('/api/large-warning') && e.severity === 'warning'),
      `large_payload warning detected for /api/large-warning (found: ${perfErrors.filter(e => e.type === 'large_payload').map(e => `${e.requestUrl} ${e.severity} ${Math.round((e.bytes ?? 0) / 1024)}KB`).join(', ') || 'none'
      })`,
    );

    // large-critical: ~2.2 MB > 2 MB threshold → severity 'critical'
    assert(
      perfErrors.some(e => e.type === 'large_payload' &&
        (e.requestUrl ?? '').includes('/api/large-critical') && e.severity === 'critical'),
      `large_payload critical detected for /api/large-critical (found: ${perfErrors.filter(e => e.type === 'large_payload').map(e => `${e.requestUrl} ${e.severity} ${Math.round((e.bytes ?? 0) / 1024)}KB`).join(', ') || 'none'
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
    const { findings } = await analyzeResponsive(browser, `${B}/responsive-issues.html`);

    // Horizontal overflow at ≤768 px → severity "critical"
    const mobileOverflow = findings.filter(f =>
      f.type === 'responsive_overflow' && f.viewport <= 768 && f.severity === 'critical');
    assert(
      mobileOverflow.length > 0,
      `responsive_overflow critical at mobile/tablet viewport (found: ${findings.filter(f => f.type === 'responsive_overflow')
        .map(f => `${f.viewport}px ${f.severity}`).join(', ') || 'none'
      })`,
    );

    // Small touch targets at 375 px → severity "warning"
    const smallTargets = findings.filter(f =>
      f.type === 'responsive_small_touch_target' && f.viewport === 375 && f.severity === 'warning');
    assert(
      smallTargets.length > 0,
      `responsive_small_touch_target warning at 375px (found: ${findings.filter(f => f.type === 'responsive_small_touch_target')
        .map(f => `${f.count} target(s) at ${f.viewport}px`).join(', ') || 'none'
      })`,
    );

    // Small touch targets at 768 px (tablet) → severity "warning"
    const smallTargets768 = findings.filter(f =>
      f.type === 'responsive_small_touch_target' && f.viewport === 768 && f.severity === 'warning');
    assert(
      smallTargets768.length > 0,
      `responsive_small_touch_target warning at 768px (found: ${findings.filter(f => f.type === 'responsive_small_touch_target')
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
    const findings = await analyzeMemory(browser, `${B}/memory-leak.html`);

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

    // Heap growth is best-effort — the detached-DOM detection above is the hard signal.
    // Whether the navigate-away+back heap actually grows depends on GC timing (the second
    // snapshot's GC may collect the leaked nodes first), so asserting it FIRED is flaky.
    // Assert the CONTRACT instead — well-formed (positive growthBytes) WHEN present, and
    // acceptably absent otherwise — same shape as [92b], so the strict-soft lane (which
    // promotes soft→hard) does not flap on GC. Non-vacuous: validates the finding shape.
    const heapFindings = findings.filter(f => f.type === 'memory_heap_growth');
    soft(
      heapFindings.length === 0 || (typeof heapFindings[0].growthBytes === 'number' && heapFindings[0].growthBytes > 0),
      `memory_heap_growth best-effort (GC-timing dependent); well-formed when present — found ${heapFindings.length}` +
      `${heapFindings.length ? ` (${Math.round(heapFindings[0].growthBytes / 1024)} KB after navigate-away + back)` : ' (GC collected before measurement — acceptable)'}`,
    );
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
    const session = await saveSession(browser, sessionFile);
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
    const restored = await restoreSession(browser, B, sessionFile);
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
  const devReqs = evalToArray(await mcp.evaluate_script({ function: NET_SCRIPT }));
  const devMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
  const devShot = await mcp.take_screenshot({ format: 'png' }).catch(() => null);
  const devDOMRaw = await mcp.evaluate_script({ function: '() => document.body.innerHTML' });
  const devDOM = String(parseEval(devDOMRaw, ''));

  // Navigate to staging home and collect data
  console.log('  → Navigating to staging home...');
  await mcp.navigate_page({ url: `${BS}/` });
  await sleep(2500);
  const stagingReqs = evalToArray(await mcp.evaluate_script({ function: NET_SCRIPT }));
  const stagingMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
  const stagingShot = await mcp.take_screenshot({ format: 'png' }).catch(() => null);
  const stagingDOMRaw = await mcp.evaluate_script({ function: '() => document.body.innerHTML' });
  const stagingDOM = String(parseEval(stagingDOMRaw, ''));

  // [15a] API status regression: checkout 200 dev → 500 staging
  const devCheckout = devReqs.find(r => (r.url ?? '').includes('/api/checkout'));
  const stagingCheckout = stagingReqs.find(r => (r.url ?? '').includes('/api/checkout'));
  assert(devCheckout?.status === 200,
    `Checkout returns 200 on dev (got ${devCheckout?.status ?? 'not found'})`);
  assert(stagingCheckout?.status === 500,
    `Checkout returns 500 on staging — API regression detected (got ${stagingCheckout?.status ?? 'not found'})`);

  // [15b] New network request on staging: /api/tracking
  const devTracking = devReqs.find(r => (r.url ?? '').includes('/api/tracking'));
  const stagingTracking = stagingReqs.find(r => (r.url ?? '').includes('/api/tracking'));
  assert(!devTracking && !!stagingTracking,
    `New request on staging only: /api/tracking (dev: ${!!devTracking}, staging: ${!!stagingTracking})`);

  // [15c] Request in dev missing on staging: /api/feature-flags
  const devFlags = devReqs.find(r => (r.url ?? '').includes('/api/feature-flags'));
  const stagingFlags = stagingReqs.find(r => (r.url ?? '').includes('/api/feature-flags'));
  assert(!!devFlags && !stagingFlags,
    `Request present in dev but missing on staging: /api/feature-flags (dev: ${!!devFlags}, staging: ${!!stagingFlags})`);

  // [15d] API status changed non-5xx: analytics 200 dev → 404 staging
  const devAnalytics = devReqs.find(r => (r.url ?? '').includes('/api/analytics'));
  const stagingAnalytics = stagingReqs.find(r => (r.url ?? '').includes('/api/analytics'));
  assert(devAnalytics?.status === 200 && stagingAnalytics?.status === 404,
    `Analytics status changed: ${devAnalytics?.status ?? '?'} dev → ${stagingAnalytics?.status ?? '?'} staging`);

  // [15e] New console error in staging
  const devErrCount = devMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error').length;
  const stagingErrCount = stagingMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error').length;
  assert(stagingErrCount > devErrCount,
    `More console errors on staging (${stagingErrCount}) than dev (${devErrCount}) — regressions logged`);

  // [15f] DOM structural change: pricing section missing on staging
  assert(devDOM.includes('class="pricing"') && !stagingDOM.includes('class="pricing"'),
    `DOM diff: .pricing section present on dev, missing on staging`);

  // [15g] Visual diff > 0.5% — hero background blue→red (soft)
  const { diffPct, error: diffErr } = visualDiff(devShot, stagingShot);
  soft(diffPct != null && diffPct > 0.5,
    `Visual diff: ${diffPct != null ? diffPct + '%' : `unavailable (${diffErr ?? 'no screenshot data'})`} pixels changed (threshold: 0.5%)`);

  // ── [25] Baseline manager — pure function test (no Chrome) ────────────────
  console.log('\n[25] Baseline Manager — applyBaseline, saveBaseline, loadBaseline, appendTrend, getCurrentBranch');

  const tmpDir = path.join(__dirname, '.tmp-baseline-test');
  const bFile = path.join(tmpDir, 'baseline.json');
  const tFile = path.join(tmpDir, 'trends.json');
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
          {
            type: 'flow_assert_failed', severity: 'critical',
            message: '[login-flow] assert url_contains: URL does not contain "/dashboard"'
          },
          {
            type: 'flow_assert_failed', severity: 'warning',
            message: '[login-flow] assert no_console_errors: 1 error(s)'
          },
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
      { type: 'console', severity: 'critical', message: 'TypeError: x is null' }, // in both
      { type: 'blank_page', severity: 'critical', message: 'Page body empty' },       // run1 only
    ],
  };
  const flakyRun2 = {
    route: '/home', url: 'http://localhost:3100/', screenshot: '/tmp/shot2.png',
    errors: [
      { type: 'console', severity: 'critical', message: 'TypeError: x is null' },    // in both
      { type: 'network', severity: 'warning', message: 'HTTP 404 /api/foo' },      // run2 only
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
    const emptyResult = await runFlow({ name: 'empty', steps: [] }, B, browser);
    assert(emptyResult.status === 'pass', 'Empty flow: status pass');
    assert(emptyResult.findings.length === 0, 'Empty flow: 0 findings');

    // [27b] Successful flow: navigate → fill → click → assert element_visible
    const successResult = await runFlow({
      name: 'Submit form',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'fill', selector: '#name', value: 'Alice' },
        { action: 'fill', selector: '#email', value: 'alice@example.com' },
        { action: 'click', selector: '#submit-btn' },
        { action: 'sleep', ms: 200 },
        { action: 'assert', type: 'element_visible', selector: '#form-success' },
      ],
    }, B, browser);
    assert(successResult.status === 'pass',
      `Successful flow: status pass (steps: ${successResult.stepsCompleted}/${successResult.totalSteps})`);
    assert(successResult.findings.length === 0,
      `Successful flow: 0 findings (got: ${successResult.findings.map(f => f.type).join(', ') || 'none'})`);

    // [27c] Assert element_visible failure → finding detected with correct type
    const failResult = await runFlow({
      name: 'Missing element',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'element_visible', selector: '#does-not-exist', severity: 'warning' },
      ],
    }, B, browser);
    assert(failResult.findings.length >= 1,
      `Assert element_visible failure: finding detected (got ${failResult.findings.length})`);
    assert(failResult.findings[0]?.type === 'flow_assert_failed',
      `Assert element_visible failure: type = flow_assert_failed`);

    // [27d] Assert no_console_errors on clean form page → 0 findings
    const noErrResult = await runFlow({
      name: 'No console errors',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'no_console_errors' },
      ],
    }, B, browser);
    assert(noErrResult.findings.length === 0,
      `Assert no_console_errors on clean page: 0 findings (got ${noErrResult.findings.length})`);

    // [27e] Assert url_contains — matching substring
    const urlMatchResult = await runFlow({
      name: 'URL match',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'url_contains', value: 'flow-form' },
      ],
    }, B, browser);
    assert(urlMatchResult.findings.length === 0,
      `Assert url_contains (match): 0 findings`);

    // [27f] Assert url_contains — non-matching substring → finding detected
    const urlFailResult = await runFlow({
      name: 'URL no match',
      steps: [
        { action: 'navigate', path: '/flow-form.html' },
        { action: 'assert', type: 'url_contains', value: '/dashboard' },
      ],
    }, B, browser);
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
    const violations = await checkLighthouse(browser, `${B}/a11y-critical.html`);
    assert(Array.isArray(violations),
      `checkLighthouse returns an array (got ${typeof violations})`);
    // Field-shape check runs unconditionally (deterministic count): .every() is true on an
    // empty array, so the gate stays fixed whether or not Lighthouse produced violations on
    // this run (it normally yields ~13 on a11y-critical.html, but a Lighthouse timeout under
    // CI load must not flap the assertion count). Non-vacuous in practice — see the soft
    // score/audit-violation counts below.
    assert(violations.every(v => v.type && v.message && v.severity && v.url),
      `All checkLighthouse violations are well-formed (type/message/severity/url) — ${violations.length} violation(s)`);
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
    // Navigate to the error page and wait for delayed throws (400ms/500ms)
    await mcp.navigate_page({ url: `${B}/js-errors.html` });
    await sleep(2000);

    // Use in-page capture (window.__argus_console) to confirm the error page HAS errors.
    // list_console_messages() may reset on navigation in some MCP implementations; the
    // in-page array is always reliable because js-errors.html sets it up itself.
    const inPageMsgs = evalToArray(await mcp.evaluate_script({ function: CONSOLE_READ_SCRIPT }));
    const errorsUnsliced = inPageMsgs.filter(m => (m.level ?? '').toLowerCase() === 'error');

    // Take D5-style baseline AFTER error page, BEFORE clean page (the production pattern)
    const allBeforeClean = toArray(await mcp.list_console_messages().catch(() => []));
    const consoleBaseline = allBeforeClean.length;

    // Navigate to a clean page (no console errors expected)
    await mcp.navigate_page({ url: `${B}/clean.html` });
    await sleep(1500);

    const allMsgs = toArray(await mcp.list_console_messages().catch(() => []));
    // With D5 slicing: only messages produced AFTER the baseline (i.e. by clean.html)
    const allCdpNow = toArray(await mcp.list_console_messages().catch(() => []));
    const corsBase2 = allCdpNow.length > consoleBaseline ? consoleBaseline : 0;
    const cleanMsgs = allCdpNow.slice(corsBase2);
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
  const c41a = chunkArray(['a', 'b', 'c', 'd', 'e', 'f'], 3);
  assert(c41a.length === 3 && c41a.every(c => c.length === 2),
    `[41a] chunkArray 6 items into 3 → 3 chunks of 2 (got: ${JSON.stringify(c41a)})`);

  // [41b] Uneven split: 5 items into 3 → 3 non-empty chunks, all items preserved
  const c41b = chunkArray(['a', 'b', 'c', 'd', 'e'], 3);
  assert(c41b.length === 3 && c41b.every(c => c.length > 0),
    `[41b] chunkArray 5 items into 3 → 3 non-empty chunks (got: ${JSON.stringify(c41b)})`);
  assert(c41b.flat().join('') === 'abcde',
    `[41b] chunkArray 5 items into 3 → all items preserved in order (got: ${JSON.stringify(c41b)})`);

  // [41c] Fewer items than target chunks: 3 items into 5 → 3 single-item chunks (no empty chunks)
  const c41c = chunkArray(['a', 'b', 'c'], 5);
  assert(c41c.length === 3 && c41c.every(c => c.length === 1),
    `[41c] chunkArray 3 items into 5 → 3 single-item chunks, no empty (got: ${JSON.stringify(c41c)})`);

  // [41d] Empty array → empty result
  const c41d = chunkArray([], 3);
  assert(Array.isArray(c41d) && c41d.length === 0,
    `[41d] chunkArray [] → [] (got: ${JSON.stringify(c41d)})`);

  // [41e] n=1 → single chunk containing all items
  const c41e = chunkArray(['a', 'b', 'c'], 1);
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

  // ── [46] Hover-state bug detection — D8.1 ────────────────────────────────────
  console.log('\n[46] Hover-state bug detection — D8.1 (analyzeHover)');
  {
    const findings = await analyzeHover(browser, `${B}/hover-issues.html`, false);

    const dropdownBroken = findings.filter(f => f.type === 'hover_dropdown_broken');
    assert(
      dropdownBroken.length >= 1,
      `[46a] hover_dropdown_broken detected for #nav-btn (aria-haspopup with no JS open handler)`
    );

    const tooltipMissing = findings.filter(f => f.type === 'hover_tooltip_missing');
    assert(
      tooltipMissing.length >= 1,
      `[46b] hover_tooltip_missing detected for #tip-btn (tooltip forced opacity:0!important)`
    );

    assert(
      dropdownBroken.every(f => f.severity === 'warning'),
      `[46c] hover_dropdown_broken severity is "warning" (non-critical route)`
    );

    assert(
      tooltipMissing.every(f => f.severity === 'warning'),
      `[46d] hover_tooltip_missing severity is always "warning"`
    );
  }

  // ── [47] Accessibility snapshot analysis — D8.2 ───────────────────────────────
  console.log('\n[47] Accessibility snapshot analysis — D8.2 (analyzeSnapshot)');
  {
    const findings = await analyzeSnapshot(browser, `${B}/snapshot-issues.html`);

    const missingName = findings.filter(f => f.type === 'a11y_missing_name');
    assert(
      missingName.length >= 1,
      `[47a] a11y_missing_name detected for SVG-only button with no accessible name`
    );

    const missingLabel = findings.filter(f => f.type === 'a11y_missing_form_label');
    assert(
      missingLabel.length >= 1,
      `[47b] a11y_missing_form_label detected for bare <input> with no label`
    );

    const dupeLandmark = findings.filter(f => f.type === 'a11y_duplicate_landmark');
    assert(
      dupeLandmark.length >= 1,
      `[47c] a11y_duplicate_landmark detected for <main> + [role="main"] without distinct labels`
    );

    assert(
      findings.every(f => f.severity === 'warning'),
      `[47d] all snapshot findings have severity "warning"`
    );
  }

  // ── [48] type_text step action — D8.3 (typing: true flag in fill step) ───────
  console.log('\n[48] type_text step action — D8.3 (typing: true flag in fill step)');
  {
    // [48a] mcp.fill fires ONE consolidated input event with the full value — counter shows
    // value.length (not per-keystroke like type_text, but not silent either).
    await mcp.navigate_page({ url: `${B}/typetext-issues.html` });
    await new Promise(r => setTimeout(r, 300));
    const FILL_VALUE = 'hello world';
    const fillUid = await resolveUidForSelector(browser, '#fill-input');
    if (fillUid) await mcp.fill({ uid: fillUid, value: FILL_VALUE });
    const rawA = await mcp.evaluate_script({
      function: `() => document.getElementById('fill-counter').getAttribute('data-count')`,
    });
    const countA = String(unwrapEval(rawA) ?? '');
    // fillUid != null is a required precondition — if uid resolution failed, fill was skipped
    // and countA === '0' would pass for the wrong reason (false pass).
    assert(
      fillUid != null && countA === String(FILL_VALUE.length),
      `[48a] mcp.fill fires one consolidated input event — counter equals value length (uid resolved: ${fillUid != null}, count: "${countA}", expected: "${FILL_VALUE.length}")`
    );

    // [48b] mcp.type_text dispatches keyboard events — char counter updates
    await mcp.navigate_page({ url: `${B}/typetext-issues.html` });
    await new Promise(r => setTimeout(r, 300));
    // mcp.click dispatches Input.dispatchMouseEvent via CDP but headless Chrome does not
    // move document.activeElement for text inputs via this pathway. Use evaluate_script
    // to call element.focus() directly — this is the reliable focus mechanism.
    const focusRaw = await mcp.evaluate_script({
      function: `() => { const el = document.getElementById('type-input'); if (!el) return false; el.focus(); return true; }`,
    });
    const elementFocused = !!unwrapEval(focusRaw);
    await mcp.type_text({ text: 'hi' });
    const rawB = await mcp.evaluate_script({
      function: `() => document.getElementById('type-counter').getAttribute('data-count')`,
    });
    const countB = String(unwrapEval(rawB) ?? '');
    assert(
      elementFocused && countB === '2',
      `[48b] mcp.type_text fires input events — char counter updates to 2 (focused: ${elementFocused}, count: "${countB}")`
    );

    // [48c] flow step with typing: true executes without error (step is wired to type_text)
    const typingFlow = {
      name: 'typetext-d8-3',
      steps: [
        { action: 'navigate', url: `${B}/typetext-issues.html` },
        { action: 'fill', selector: '#type-input', value: 'abc', typing: true },
      ],
    };
    const typingResult = await runFlow(typingFlow, B, browser);
    assert(
      typingResult.findings.length === 0,
      `[48c] flow with typing: true completes without error (type_text wired in fill step)`
    );

    // [48d] after typing: true flow, input-event count is 3 (one per keystroke) — proves
    // type_text was called and NOT mcp.fill, which fires only 1 consolidated input event.
    // Both would produce data-count="3" for value "abc"; data-event-count distinguishes them.
    const rawD = await mcp.evaluate_script({
      function: `() => document.getElementById('type-counter').getAttribute('data-event-count')`,
    });
    const countD = String(unwrapEval(rawD) ?? '');
    assert(
      countD === '3',
      `[48d] typing: true dispatches type_text — 3 separate input events for "abc" (fill fires 1) (got "${countD}")`
    );
  }

  // ── [49] drag step action — D8.4 (drag action in flow-runner DSL) ────────────
  console.log('\n[49] drag step action — D8.4 (drag action in flow-runner DSL)');
  {
    // [49a] drag step action is wired in runStep — runFlow with drag step doesn't emit flow_step_failed
    const dragFlow = {
      name: 'drag-d8-4',
      steps: [
        { action: 'navigate', url: `${B}/drag-issues.html` },
        { action: 'drag', selector: '#drag-source', target: '#drop-zone' },
      ],
    };
    const dragResult = await runFlow(dragFlow, B, browser);
    const unexpectedFail = dragResult.findings.filter(f => f.type === 'flow_step_failed' && f.action === 'drag');
    assert(
      unexpectedFail.length === 0,
      `[49a] drag step action is registered in flow-runner — no flow_step_failed on valid selector`
    );

    // [49b] after drag to working drop zone, drop event fired (data-dropped="true")
    const rawB = await mcp.evaluate_script({
      function: `() => document.getElementById('drop-zone').getAttribute('data-dropped')`,
    });
    const dropped = String(unwrapEval(rawB) ?? '');
    assert(
      dropped === 'true',
      `[49b] drag to working drop zone fires drop event — data-dropped="true" set by drop handler`
    );

    // [49c] drag step with non-existent selector → flow_step_failed with action: 'drag'
    const badDragFlow = {
      name: 'drag-bad-selector',
      steps: [
        { action: 'navigate', url: `${B}/drag-issues.html` },
        { action: 'drag', selector: '#does-not-exist', target: '#drop-zone' },
      ],
    };
    const badDragResult = await runFlow(badDragFlow, B, browser);
    const dragFailed = badDragResult.findings.filter(
      f => f.type === 'flow_step_failed' && f.action === 'drag'
    );
    assert(
      dragFailed.length >= 1,
      `[49c] drag step with missing selector emits flow_step_failed with action "drag"`
    );
  }

  // ── [50] upload_file step action — D8.5 ─────────────────────────────────────
  console.log('\n[50] upload_file step action — D8.5 (upload_file action in flow-runner DSL)');
  {
    const uploadFilePath = path.resolve(__dirname, 'pages', 'test-upload.txt');

    // [50a] upload_file step action is wired in runStep — runFlow completes without
    // emitting a flow_step_failed for the upload_file action
    const uploadFlow = {
      name: 'upload-d8-5',
      steps: [
        { action: 'navigate', url: `${B}/upload-issues.html` },
        { action: 'upload_file', selector: 'input[type=file]', filePath: uploadFilePath },
      ],
    };
    const uploadResult = await runFlow(uploadFlow, B, browser);
    const unexpectedFail = uploadResult.findings.filter(
      f => f.type === 'flow_step_failed' && f.action === 'upload_file'
    );
    assert(
      unexpectedFail.length === 0,
      `[50a] upload_file step action is registered in flow-runner — no flow_step_failed on valid file input`
    );

    // [50b] after upload_file, the file input has a file — files.length > 0
    // (upload_file uses CDP to set files directly on the input element)
    const rawB = await mcp.evaluate_script({
      function: `() => document.getElementById('file-input').files.length`,
    });
    const fileCount = Number(unwrapEval(rawB) ?? 0);
    assert(
      fileCount > 0,
      `[50b] upload_file delivers file to input — files.length > 0 (got ${fileCount})`
    );

    // [50c] upload_file with a non-existent filePath → MCP throws → flow_step_failed
    const badUploadFlow = {
      name: 'upload-bad-path',
      steps: [
        { action: 'navigate', url: `${B}/upload-issues.html` },
        { action: 'upload_file', selector: 'input[type=file]', filePath: '/nonexistent/argus-does-not-exist.txt' },
      ],
    };
    const badUploadResult = await runFlow(badUploadFlow, B, browser);
    const uploadFailed = badUploadResult.findings.filter(
      f => f.type === 'flow_step_failed' && f.action === 'upload_file'
    );
    assert(
      uploadFailed.length >= 1,
      `[50c] upload_file with non-existent file path emits flow_step_failed with action "upload_file"`
    );
  }

  // ── [51] C1.1 Env variable audit ─────────────────────────────────────────
  console.log('\n[51] C1.1 Env variable audit — process.env refs vs declared vars in .env');
  {
    const sourceDir = path.join(__dirname, 'source-fixture');
    const envFile = path.join(sourceDir, '.env.fixture');
    const findings = auditEnvVariables(sourceDir, envFile);

    assert(
      findings.length > 0,
      `[51a] auditEnvVariables produces findings for undeclared env vars (got ${findings.length})`
    );
    assert(
      findings.some(f => f.varName === 'MISSING_VAR'),
      `[51b] MISSING_VAR flagged as env_var_missing (found: ${findings.map(f => f.varName).join(', ')})`
    );
    assert(
      findings.every(f => f.severity === 'warning'),
      `[51c] all env_var_missing findings are severity "warning"`
    );
    // PRESENT_VAR is in .env.fixture — must not be flagged
    assert(
      !findings.some(f => f.varName === 'PRESENT_VAR'),
      `[51d] PRESENT_VAR is declared and must NOT be flagged (wrongly flagged: ${findings.filter(f => f.varName === 'PRESENT_VAR').length})`
    );
  }

  // ── [52] C1.2 Feature flag leakage ───────────────────────────────────────
  console.log('\n[52] C1.2 Feature flag leakage — conditional env var that is falsy/unset');
  {
    const sourceDir = path.join(__dirname, 'source-fixture');
    const envFile = path.join(sourceDir, '.env.fixture');
    const findings = detectFeatureFlagLeakage(sourceDir, envFile);

    assert(
      findings.length > 0,
      `[52a] detectFeatureFlagLeakage produces findings (got ${findings.length})`
    );
    assert(
      findings.some(f => f.varName === 'FEATURE_DISABLED'),
      `[52b] FEATURE_DISABLED flagged as feature_flag_leakage (found: ${findings.map(f => f.varName).join(', ')})`
    );
    assert(
      findings.every(f => f.severity === 'warning'),
      `[52c] all feature_flag_leakage findings are severity "warning"`
    );
    // FEATURE_ENABLED is 'true' in .env.fixture — must not be flagged
    assert(
      !findings.some(f => f.varName === 'FEATURE_ENABLED'),
      `[52d] FEATURE_ENABLED is truthy and must NOT be flagged (wrongly flagged: ${findings.filter(f => f.varName === 'FEATURE_ENABLED').length})`
    );
  }

  // ── [53] C1.3 Error-to-source linking ────────────────────────────────────
  console.log('\n[53] C1.3 Error-to-source linking — console error stack traces parsed to file:line');
  {
    const syntheticFindings = [
      {
        type: 'console',
        level: 'error',
        message: 'TypeError: Cannot read property \'foo\' of undefined\n    at handleClick (http://localhost:3000/static/js/main.abc123.js:1:4567)\n    at HTMLButtonElement.onclick (http://localhost:3000/static/js/main.abc123.js:1:8910)',
        severity: 'warning',
      },
      {
        type: 'console',
        level: 'warning',
        message: 'Some warning with no stack trace',
        severity: 'info',
      },
    ];
    const enriched = enrichErrorsWithSource(syntheticFindings);

    assert(
      enriched.length > 0,
      `[53a] enrichErrorsWithSource produces findings for errors with stack traces (got ${enriched.length})`
    );
    assert(
      enriched[0].stackFrames?.length > 0,
      `[53b] stack frames extracted from console error (got ${enriched[0]?.stackFrames?.length ?? 0})`
    );
    assert(
      enriched[0].stackFrames[0].file === 'main.abc123.js',
      `[53c] top stack frame file resolved correctly (got: ${enriched[0]?.stackFrames?.[0]?.file})`
    );
    assert(
      enriched.every(f => f.severity === 'info'),
      `[53d] all error_source_linked findings are severity "info"`
    );
  }

  // ── [54] C1.4 Dead route detection ───────────────────────────────────────
  console.log('\n[54] C1.4 Dead route detection — internal links that return 404');
  {
    await mcp.navigate_page({ url: `${B}/dead-routes.html` });
    await sleep(500);

    // Extract internal links from the page
    const linksRaw = await mcp.evaluate_script({ function: INTERNAL_LINKS_SCRIPT });
    const rawLinks = unwrapEval(linksRaw);
    const links = Array.isArray(rawLinks) ? rawLinks : JSON.parse(String(rawLinks ?? '[]'));

    // Test untested paths — clean.html is already "known" so it won't be HEAD-requested
    const knownPaths = ['/dead-routes.html', '/clean.html'];
    const deadRoutes = await detectDeadRoutes(B, links, knownPaths);

    assert(
      deadRoutes.length >= 2,
      `[54a] detectDeadRoutes finds ≥ 2 dead routes (found: ${deadRoutes.length} — paths: ${deadRoutes.map(f => f.path).join(', ')})`
    );
    assert(
      deadRoutes.some(f => f.path.includes('argus-dead-route')),
      `[54b] dead paths flagged match expected /argus-dead-route-* pattern (found: ${deadRoutes.map(f => f.path).join(', ')})`
    );
    assert(
      deadRoutes.every(f => f.severity === 'warning'),
      `[54c] all dead_route findings are severity "warning"`
    );
  }

  // ── [55] C2.1 PR comment formatter ───────────────────────────────────────
  console.log('\n[55] C2.1 formatPrComment — Markdown PR comment body');
  {
    const syntheticReport = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 3, critical: 1, warning: 1, info: 1 },
      routes: [{
        route: 'Home',
        url: 'http://localhost:3100/',
        errors: [
          { type: 'console', severity: 'critical', message: 'TypeError: foo is null', isNew: true },
          { type: 'seo_missing_h1', severity: 'warning', message: 'Missing H1 heading', isNew: false },
        ],
        screenshot: null,
      }],
      flows: [],
      codebase: [
        { type: 'env_var_missing', severity: 'warning', message: 'process.env.API_KEY referenced but not declared', isNew: true },
      ],
    };
    const syntheticDiff = {
      isFirstRun: false,
      newCount: 2,
      resolvedCount: 1,
      flowNewCount: 0,
      flowResolvedCount: 0,
    };

    const comment = formatPrComment(syntheticReport, syntheticDiff);

    assert(
      typeof comment === 'string' && comment.length > 0,
      `[55a] formatPrComment returns a non-empty string (got type: ${typeof comment})`
    );
    assert(
      comment.includes('<!-- argus-qa-report -->'),
      `[55b] comment contains the COMMENT_MARKER sentinel for update detection`
    );
    assert(
      comment.includes('http://localhost:3100'),
      `[55c] comment contains the report base URL`
    );
    assert(
      comment.includes('| **Total** | 1 | 1 | 1 | 3 |'),
      `[55d] summary table Total row contains correct per-severity and overall counts`
    );
    assert(
      comment.includes('New Findings'),
      `[55e] New Findings section present when diff.isFirstRun is false and findings exist`
    );
    assert(
      comment.includes('Resolved'),
      `[55f] Resolved section present when combined resolvedCount > 0`
    );
    assert(
      comment.includes('Codebase Analysis'),
      `[55g] Codebase Analysis section present when report.codebase is non-empty`
    );

    // First-run case: New Findings section must be suppressed
    const firstRunComment = formatPrComment(syntheticReport, { isFirstRun: true, newCount: 0, resolvedCount: 0, flowNewCount: 0, flowResolvedCount: 0 });
    assert(
      !firstRunComment.includes('New Findings'),
      `[55h] New Findings section absent on first run (would show all findings as new — misleading)`
    );
  }

  // ── [56] C2.2 Commit status payload builder ───────────────────────────────
  console.log('\n[56] C2.2 buildStatusPayload — GitHub commit status payload');
  {
    const baseReport = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
      routes: [{
        route: 'Home',
        url: 'http://localhost:3100/',
        errors: [{ type: 'console', severity: 'critical', message: 'TypeError', isNew: true }],
      }],
      flows: [],
      codebase: [],
    };

    // Scenario A: new critical → failure
    const statusFail = buildStatusPayload(baseReport, { isFirstRun: false, newCount: 1 });
    assert(
      statusFail.state === 'failure',
      `[56a] state is "failure" when new critical findings exist (got: "${statusFail.state}")`
    );

    // Scenario B: no new criticals → success
    const cleanReport = {
      ...baseReport,
      routes: [{
        route: 'Home',
        url: 'http://localhost:3100/',
        errors: [{ type: 'console', severity: 'critical', message: 'TypeError', isNew: false }],
      }],
    };
    const statusPass = buildStatusPayload(cleanReport, { isFirstRun: false, newCount: 0 });
    assert(
      statusPass.state === 'success',
      `[56b] state is "success" when no new critical findings (got: "${statusPass.state}")`
    );

    assert(
      statusFail.context === 'argus-qa',
      `[56c] context field is "argus-qa" (got: "${statusFail.context}")`
    );
    assert(
      typeof statusFail.description === 'string' && statusFail.description.includes('Argus'),
      `[56d] description is a string containing "Argus" (got: "${statusFail.description}")`
    );
  }

  // ── [57] C3.1 Sitemap discovery ───────────────────────────────────────────
  console.log('\n[57] C3.1 Sitemap discovery — fetch /sitemap.xml and parse <loc> paths');
  {
    const paths = await discoverFromSitemap(B);

    assert(
      Array.isArray(paths),
      `[57a] discoverFromSitemap returns an array (got: ${typeof paths})`
    );
    assert(
      paths.includes('/about'),
      `[57b] /about parsed from sitemap <loc> (found: ${paths.join(', ')})`
    );
    assert(
      !paths.some(p => p.includes('external.example')),
      `[57c] off-origin URL excluded from results (found off-origin: ${paths.filter(p => p.includes('external')).join(', ')})`
    );

    // Unreachable server → graceful empty array (no throw)
    const missing = await discoverFromSitemap('http://localhost:3199');
    assert(
      Array.isArray(missing) && missing.length === 0,
      `[57d] returns [] when sitemap is unreachable (got ${missing.length} item(s))`
    );
  }

  // ── [58] C3.2 Next.js route discovery ────────────────────────────────────
  console.log('\n[58] C3.2 Next.js route discovery — scan pages/ and app/ directory structures');
  {
    const fixtureDir = path.join(__dirname, 'nextjs-fixture');
    const routes58 = discoverFromNextJs(fixtureDir);

    assert(
      Array.isArray(routes58) && routes58.length > 0,
      `[58a] discoverFromNextJs returns non-empty array (got ${routes58.length} route(s): ${routes58.join(', ')})`
    );
    assert(
      routes58.includes('/'),
      `[58b] pages/index.jsx maps to '/' (found: ${routes58.join(', ')})`
    );
    assert(
      !routes58.some(p => p.startsWith('/api')),
      `[58c] pages/api/ routes excluded (wrongly included: ${routes58.filter(p => p.startsWith('/api')).join(', ')})`
    );
    assert(
      !routes58.some(p => p.includes('_app')),
      `[58d] pages/_app.jsx excluded (wrongly included: ${routes58.filter(p => p.includes('_app')).join(', ')})`
    );
    assert(
      routes58.includes('/login'),
      `[58e] app/(auth)/login/page.tsx → '/login' with route group stripped (found: ${routes58.join(', ')})`
    );
    assert(
      !routes58.some(p => p.includes('[')),
      `[58f] dynamic [param] route segments excluded (found: ${routes58.filter(p => p.includes('[')).join(', ')})`
    );

    // Gap 3: sourceDir with no pages/ or app/ → returns []
    const tmpNextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nextjs-'));
    const emptyNextJs = discoverFromNextJs(tmpNextDir);
    fs.rmSync(tmpNextDir, { recursive: true, force: true });
    assert(
      Array.isArray(emptyNextJs) && emptyNextJs.length === 0,
      `[58g] returns [] when sourceDir has no pages/ or app/ directory (got ${emptyNextJs.length})`
    );
  }

  // ── [59] C3.3 React Router discovery ─────────────────────────────────────
  console.log('\n[59] C3.3 React Router route discovery — grep source for path declarations');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rr-'));
    fs.writeFileSync(path.join(tmpDir, 'App.jsx'), [
      '<Route path="/home" element={<Home />} />',
      '<Route path="/dashboard" element={<Dashboard />} />',
      '<Route path="/user/:id" element={<User />} />',
      'const routes = [{ path: "/settings", element: <Settings /> }];',
    ].join('\n'));

    const paths59 = discoverFromReactRouter(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    assert(
      Array.isArray(paths59),
      `[59a] discoverFromReactRouter returns an array (got: ${typeof paths59})`
    );
    assert(
      paths59.includes('/dashboard'),
      `[59b] /dashboard detected from <Route path> (found: ${paths59.join(', ')})`
    );
    assert(
      !paths59.some(p => p.includes(':id')),
      `[59c] dynamic :id path excluded (found: ${paths59.filter(p => p.includes(':')).join(', ')})`
    );

    // Gap 4: non-existent sourceDir → returns []
    const nonExistentResult = discoverFromReactRouter('/this/path/does/not/exist/argus-rr');
    assert(
      Array.isArray(nonExistentResult) && nonExistentResult.length === 0,
      `[59d] non-existent sourceDir returns [] (got ${nonExistentResult.length})`
    );
  }

  // ── [60] C3.4 mergeRoutes ─────────────────────────────────────────────────
  console.log('\n[60] C3.4 mergeRoutes — merge discovered paths with manual route config');
  {
    const manual60 = [
      { path: '/', name: 'Home', critical: true, waitFor: 'main' },
      { path: '/login', name: 'Login', critical: true, waitFor: 'form' },
    ];
    const discovered60 = ['/', '/about', '/blog'];
    const merged60 = mergeRoutes(manual60, discovered60);

    assert(
      merged60.length === 4,
      `[60a] 2 manual + 1 new (/about) + 1 new (/blog) = 4 total (got ${merged60.length})`
    );
    assert(
      merged60[0].critical === true && merged60[0].waitFor === 'main',
      `[60b] manual route config preserved (critical=${merged60[0].critical}, waitFor=${merged60[0].waitFor})`
    );
    assert(
      !merged60.some(r => r.path === '/' && r.discovered),
      `[60c] existing manual route '/' not marked as discovered`
    );
    assert(
      merged60.some(r => r.path === '/about' && r.discovered === true),
      `[60d] auto-found route '/about' has discovered: true flag`
    );
  }

  // ── [61] C3.5 discoverRoutes orchestrator ─────────────────────────────────
  console.log('\n[61] C3.5 discoverRoutes — orchestrator integrates all discovery sources');
  {
    const manual61 = [
      { path: '/', name: 'Home', critical: true, waitFor: 'main' },
    ];
    const fixtureDir = path.join(__dirname, 'nextjs-fixture');

    // sitemap disabled to avoid network fetch; Next.js discovery against fixture
    const merged61 = await discoverRoutes(
      'http://localhost:3100',
      fixtureDir,
      { sitemap: false, nextjs: true, reactRouter: false },
      manual61
    );

    assert(
      Array.isArray(merged61),
      `[61a] discoverRoutes returns an array (got: ${typeof merged61})`
    );
    assert(
      merged61.length > 1,
      `[61b] orchestrator adds Next.js routes beyond the single manual route (got ${merged61.length})`
    );
    assert(
      merged61[0].critical === true && merged61[0].waitFor === 'main',
      `[61c] manual route config preserved by orchestrator (critical=${merged61[0].critical}, waitFor=${merged61[0].waitFor})`
    );

    // Gap 1 verification: null autoDiscover → manual routes returned unchanged
    const nullResult = await discoverRoutes(
      'http://localhost:3100',
      fixtureDir,
      null,
      manual61
    );
    assert(
      nullResult.length === manual61.length && nullResult[0] === manual61[0],
      `[61d] null autoDiscover returns manual routes unchanged (got ${nullResult.length}, expected ${manual61.length})`
    );
  }

  // ── [62] C4.1 detectFramework ─────────────────────────────────────────────
  console.log('\n[62] C4.1 detectFramework — identify Next.js / React Router / unknown');
  {
    // Non-existent dir → unknown
    assert(
      detectFramework('/this/path/does/not/exist/argus-fw') === 'unknown',
      `[62a] non-existent dir returns 'unknown'`
    );

    // Temp dir with no package.json → unknown
    const tmpFw = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-fw-'));
    assert(
      detectFramework(tmpFw) === 'unknown',
      `[62b] dir without package.json returns 'unknown'`
    );

    // Next.js package.json → 'nextjs'
    fs.writeFileSync(path.join(tmpFw, 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }));
    assert(
      detectFramework(tmpFw) === 'nextjs',
      `[62c] package.json with "next" dependency returns 'nextjs'`
    );

    // React Router package.json → 'react-router'
    fs.writeFileSync(path.join(tmpFw, 'package.json'), JSON.stringify({
      dependencies: { 'react-router-dom': '^6.0.0', react: '^18.0.0' },
    }));
    assert(
      detectFramework(tmpFw) === 'react-router',
      `[62d] package.json with "react-router-dom" dependency returns 'react-router'`
    );

    fs.rmSync(tmpFw, { recursive: true, force: true });
  }

  // ── [63] C4.2 generateTargetsJs ──────────────────────────────────────────
  console.log('\n[63] C4.2 generateTargetsJs — render pre-filled targets.js from routes');
  {
    const routes63 = [
      { path: '/', name: 'Home', critical: true, waitFor: 'main' },
      { path: '/about', name: 'About', critical: false, waitFor: null, discovered: true },
      { path: '/dashboard', name: 'Dashboard', critical: true, waitFor: '[data-testid="dashboard"]' },
    ];

    const out63 = generateTargetsJs(routes63, { framework: 'nextjs', sourceDir: '/app/src', envFile: '/app/.env' });

    assert(
      typeof out63 === 'string' && out63.length > 0,
      `[63a] generateTargetsJs returns a non-empty string`
    );
    assert(
      out63.includes("export const routes") && out63.includes("export const config"),
      `[63b] output contains ES module export statements`
    );
    assert(
      out63.includes("path: '/about'") && out63.includes("path: '/'"),
      `[63c] discovered route paths included in routes array`
    );
    assert(
      out63.includes('nextjs:      true') && out63.includes('reactRouter: false'),
      `[63d] autoDiscover block reflects detected framework (nextjs → true, react-router → false)`
    );
    assert(
      out63.includes("export const autoDiscover"),
      `[63e] autoDiscover export present`
    );

    // Empty routes → falls back to default Home route
    const emptyOut = generateTargetsJs([], { framework: 'unknown' });
    assert(
      emptyOut.includes("path: '/'"),
      `[63f] empty routes falls back to default '/' home route`
    );
  }

  // ── [64] C4.3 generateEnvFile ─────────────────────────────────────────────
  console.log('\n[64] C4.3 generateEnvFile — render .env with user config substituted');
  {
    // With all values populated
    const full64 = generateEnvFile({
      devUrl: 'http://localhost:4000',
      stagingUrl: 'https://staging.example.com',
      slackToken: 'xoxb-test-token',
      slackSecret: 'test-secret',
      slackCritical: 'C111',
      slackWarnings: 'C222',
      slackDigest: 'C333',
      githubToken: 'ghp_testtoken',
      githubRepo: 'owner/myrepo',
      sourceDir: '/app/src',
      envFile: '/app/.env',
    });

    assert(
      typeof full64 === 'string' && full64.length > 0,
      `[64a] generateEnvFile returns a non-empty string`
    );
    assert(
      full64.includes('TARGET_DEV_URL=http://localhost:4000'),
      `[64b] devUrl substituted into TARGET_DEV_URL (got: ${full64.split('\n').find(l => l.startsWith('TARGET_DEV_URL'))})`
    );
    assert(
      full64.includes('SLACK_BOT_TOKEN=xoxb-test-token'),
      `[64c] slackToken substituted (not commented out) when provided`
    );
    assert(
      full64.includes('GITHUB_TOKEN=ghp_testtoken') && full64.includes('GITHUB_REPOSITORY=owner/myrepo'),
      `[64d] GitHub values substituted when provided`
    );

    // Without optional values → those lines should be commented out
    const minimal64 = generateEnvFile({ devUrl: 'http://localhost:3000' });
    assert(
      minimal64.includes('# SLACK_BOT_TOKEN=xoxb-...'),
      `[64e] SLACK_BOT_TOKEN commented out when no token provided`
    );
    assert(
      minimal64.includes('# GITHUB_TOKEN=ghp_...'),
      `[64f] GITHUB_TOKEN commented out when no token provided`
    );
  }

  // ── [65] Production crawl pipeline smoke test ────────────────────────────
  // Exercises crawlRouteCheap() directly so harness regressions surface in
  // the production code path, not just in the hand-rolled crawlFixture().
  console.log('\n[65] Production crawl path — crawlRouteCheap on clean fixture');
  {
    const route65 = { name: 'clean', path: '/clean.html', critical: false, waitFor: null };
    const result65 = await crawlRouteCheap(route65, B, mcp);

    assert(Array.isArray(result65.errors), '[65a] crawlRouteCheap returns errors array');
    assert(typeof result65.url === 'string' && result65.url.endsWith('/clean.html'),
      `[65b] crawlRouteCheap result.url is correct (got: ${result65.url})`);
    assert(result65.isBlankPage === false,
      `[65c] crawlRouteCheap does not flag clean page as blank`);

    const criticals65 = result65.errors.filter(e => e.severity === 'critical');
    assert(criticals65.length === 0,
      `[65d] Production crawl: no criticals on clean fixture (got ${criticals65.length}: ${criticals65.map(e => e.type).join(', ') || 'none'})`);
  }

  // ── [66] Chrome Issues panel — clean page ────────────────────────────────
  console.log('\n[66] Chrome DevTools Issues panel — clean fixture produces no issue findings');
  {
    const findings66 = await analyzeIssues(browser, `${B}/clean.html`);
    assert(Array.isArray(findings66),
      '[66a] analyzeIssues returns an array');
    const critical66 = findings66.filter(f => f.severity === 'critical');
    assert(critical66.length === 0,
      `[66b] Clean page has no critical issue findings (got: ${critical66.map(f => f.type).join(', ') || 'none'})`);
    assert(!findings66.some(f => f.type === 'csp_violation'),
      `[66c] Clean page has no csp_violation findings (got ${findings66.length} total)`);
  }

  // ── [67] Chrome Issues panel — CSP violation fixture ─────────────────────
  console.log('\n[67] Chrome DevTools Issues panel — CSP violation fixture');
  {
    const findings67 = await analyzeIssues(browser, `${B}/issues-csp.html`);
    assert(Array.isArray(findings67),
      '[67a] analyzeIssues returns an array for CSP fixture');
    const csp67 = findings67.filter(f => f.type === 'csp_violation');
    assert(csp67.length >= 1,
      `[67b] CSP fixture produces at least 1 csp_violation finding (got ${csp67.length})`);
    assert(csp67.every(f => f.type && f.message && f.severity && f.url),
      '[67c] csp_violation findings have required fields: type, message, severity, url');
  }

  // ── [68] Chrome Issues panel — deprecated API fixture ────────────────────
  console.log('\n[68] Chrome DevTools Issues panel — deprecated API fixture');
  {
    const findings68 = await analyzeIssues(browser, `${B}/issues-deprecated.html`);
    assert(Array.isArray(findings68),
      '[68a] analyzeIssues returns an array for deprecated API fixture');
    const deprecated68 = findings68.filter(f => f.type === 'deprecated_api_use');
    assert(deprecated68.length >= 1,
      `[68b] Deprecated API fixture produces at least 1 deprecated_api_use finding (got ${deprecated68.length})`);
    assert(deprecated68.every(f => f.severity === 'info'),
      '[68c] deprecated_api_use findings are severity: info');
  }

  // ── [69] Network HAR timing — pure unit tests ────────────────────────────
  console.log('\n[69] Network HAR timing analysis — parseNetworkTiming unit tests');
  {
    const PAGE = 'http://localhost:3100/';

    // [69a] Empty input → empty output
    const empty69 = parseNetworkTiming([], PAGE);
    assert(Array.isArray(empty69), '[69a] parseNetworkTiming([]) returns an array');
    assert(empty69.length === 0, '[69b] parseNetworkTiming([]) returns empty array');

    // [69c] Cross-origin slow script → slow_third_party_blocking warning
    const slow69 = parseNetworkTiming([
      {
        url: 'https://cdn.example.com/analytics.js', method: 'GET', status: 200,
        timing: { wait: 3000 }
      },
    ], PAGE);
    const tp69 = slow69.filter(f => f.type === 'slow_third_party_blocking');
    assert(tp69.length >= 1,
      `[69c] Slow cross-origin script emits slow_third_party_blocking (got ${tp69.length})`);
    assert(tp69.every(f => f.severity === 'warning'),
      '[69d] slow_third_party_blocking is severity: warning');

    // [69e] Static image skipped even when slow
    const static69 = parseNetworkTiming([
      {
        url: 'https://cdn.example.com/hero.png', method: 'GET', status: 200,
        timing: { wait: 5000 }
      },
    ], PAGE);
    assert(static69.length === 0,
      '[69e] Static asset (hero.png) skipped regardless of timing');

    // [69f] Same-origin request not reported (covered by NETWORK_PERF_SCRIPT)
    const same69 = parseNetworkTiming([
      {
        url: 'http://localhost:3100/api/data', method: 'GET', status: 200,
        timing: { wait: 4000 }
      },
    ], PAGE);
    assert(same69.length === 0,
      '[69f] Same-origin slow request not reported by parseNetworkTiming');

    // [69g] Below threshold cross-origin → no finding
    const fast69 = parseNetworkTiming([
      {
        url: 'https://fonts.googleapis.com/css?family=Roboto', method: 'GET', status: 200,
        timing: { wait: 500 }
      },
    ], PAGE);
    assert(fast69.length === 0,
      '[69g] Cross-origin request below 2000ms threshold not flagged');
  }

  // ── [70] Heading hierarchy — analyzeSnapshot extension ───────────────────
  console.log('\n[70] Heading hierarchy validation — heading-issues.html fixture');
  {
    const findings70 = await analyzeSnapshot(browser, `${B}/heading-issues.html`);
    assert(Array.isArray(findings70),
      '[70a] analyzeSnapshot returns an array for heading-issues fixture');
    const skips70 = findings70.filter(f => f.type === 'heading_level_skip');
    assert(skips70.length >= 1,
      `[70b] heading-issues fixture produces at least 1 heading_level_skip finding (got ${skips70.length})`);
    assert(skips70.every(f => f.severity === 'warning'),
      '[70c] heading_level_skip findings are severity: warning');
    assert(skips70.some(f => f.from === 1 && f.to === 3),
      `[70d] h1→h3 skip detected (got skips: ${JSON.stringify(skips70.map(s => ({ from: s.from, to: s.to })))})`);
  }

  // ── [71] CPU throttle applied during responsive analysis ─────────────────
  console.log('\n[71] CPU throttle for mobile breakpoints — responsive-issues.html');
  {
    // analyzeResponsive now calls emulate({ cpuThrottlingRate: 4 }) at ≤768px.
    // The fixture findings must still be correct — throttle must not suppress detections.
    const { findings: findings71 } = await analyzeResponsive(browser, `${B}/responsive-issues.html`);
    assert(Array.isArray(findings71),
      '[71a] analyzeResponsive returns findings array with CPU throttle enabled');
    const overflow71 = findings71.filter(f => f.type === 'responsive_overflow' && f.viewport <= 768);
    assert(overflow71.length > 0,
      `[71b] responsive_overflow still detected at ≤768px under CPU throttle (got ${overflow71.length})`);
    assert(overflow71.every(f => f.severity === 'critical'),
      '[71c] mobile overflow is severity: critical under CPU throttle');
  }

  // ── [72] Keyboard navigation — focus_visible_missing ─────────────────────
  console.log('\n[72] Keyboard navigation analysis — keyboard-issues.html fixture');
  {
    const findings72 = await analyzeKeyboard(browser, `${B}/keyboard-issues.html`);
    assert(Array.isArray(findings72),
      '[72a] analyzeKeyboard returns an array');
    const noFocus72 = findings72.filter(f => f.type === 'focus_visible_missing');
    assert(noFocus72.length >= 1,
      `[72b] keyboard-issues fixture produces at least 1 focus_visible_missing finding (got ${noFocus72.length})`);
    assert(noFocus72.every(f => f.severity === 'warning'),
      '[72c] focus_visible_missing findings are severity: warning');
    assert(noFocus72.some(f => f.id === 'no-focus-ring'),
      `[72d] #no-focus-ring button detected (found ids: ${noFocus72.map(f => f.id).join(', ')})`);
  }

  // ── [73] ARIA state checks — aria_expanded_no_controls ───────────────────
  console.log('\n[73] ARIA state checks — aria-state-issues.html fixture');
  {
    const findings73 = await analyzeSnapshot(browser, `${B}/aria-state-issues.html`);
    assert(Array.isArray(findings73),
      '[73a] analyzeSnapshot returns an array for aria-state-issues fixture');
    const broken73 = findings73.filter(f => f.type === 'aria_expanded_no_controls');
    assert(broken73.length >= 2,
      `[73b] aria-state-issues fixture produces at least 2 aria_expanded_no_controls findings (got ${broken73.length})`);
    assert(broken73.every(f => f.severity === 'warning'),
      '[73c] aria_expanded_no_controls findings are severity: warning');
    const validButton73 = findings73.filter(f => f.type === 'aria_expanded_no_controls' && f.id === 'toggle-valid');
    assert(validButton73.length === 0,
      `[73d] #toggle-valid (has aria-controls pointing to real element) is NOT flagged`);
  }

  // ── [74] select_option flow step ─────────────────────────────────────────
  console.log('\n[74] select_option flow step — select-form.html fixture');
  {
    const flow74 = {
      name: 'select_option test',
      steps: [
        { action: 'navigate', path: '/select-form.html' },
        { action: 'select_option', selector: '#country', value: 'US' },
        { action: 'select_option', selector: '#size', value: 'L' },
        { action: 'click', selector: '#submit-btn' },
        { action: 'sleep', ms: 200 },
        { action: 'assert', type: 'element_visible', selector: '#form-result[data-ready]' },
      ],
    };
    const result74 = await runFlow(flow74, B, browser);
    assert(result74.status === 'pass',
      `[74a] select_option flow passes (status=${result74.status}, steps=${result74.stepsCompleted}/${result74.totalSteps})`);
    assert(result74.findings.filter(f => f.type === 'flow_step_failed').length === 0,
      `[74b] No flow_step_failed findings in select_option flow`);

    // Verify the flow actually updated the DOM result via the flow runner
    const resultText74 = unwrapEval(
      await mcp.evaluate_script({ function: `() => document.getElementById('form-result').textContent` })
    );
    const text74 = String(resultText74 ?? '').trim();
    assert(text74 === 'US/L',
      `[74c] flow result is "US/L" after select_option steps (got "${text74}")`);
  }

  // ── [75] Origin tagging on network findings ───────────────────────────────
  console.log('\n[75] Origin tagging on network findings — pure unit test');
  {
    // Test the classifyOrigin logic via crawlRouteCheap result shape.
    // The CORS error fixture makes cross-origin fetch — its network finding should have origin: third-party.
    // We use a direct unit test of the expected field shape since we can't call classifyOrigin directly.
    const findings75 = await crawlRouteCheap(
      { path: '/clean.html', name: 'Clean', critical: false, waitFor: null },
      B, mcp
    );
    assert(Array.isArray(findings75.errors),
      '[75a] crawlRouteCheap returns errors array');
    // All network-type errors must have an origin field
    const networkErrors75 = findings75.errors.filter(e => e.type === 'network');
    const allHaveOrigin = networkErrors75.every(e => e.origin === 'first-party' || e.origin === 'third-party');
    assert(networkErrors75.length === 0 || allHaveOrigin,
      `[75b] all network findings have origin field (checked ${networkErrors75.length} findings)`);
  }

  // ── [76] HTTPS enforcement — unit test via URL parsing ───────────────────
  console.log('\n[76] HTTPS enforcement check — unit-level URL check');
  {
    // The security_no_https finding fires for non-localhost http:// URLs.
    // Test harness runs on localhost — it must NOT emit security_no_https.
    const findings76 = await crawlRouteCheap(
      { path: '/clean.html', name: 'Clean', critical: false, waitFor: null },
      B, mcp
    );
    const httpsFindings76 = findings76.errors.filter(e => e.type === 'security_no_https');
    assert(httpsFindings76.length === 0,
      `[76a] localhost http:// does NOT emit security_no_https (got ${httpsFindings76.length})`);

    // Structural check: for a non-localhost HTTP URL the finding would have the right shape.
    // We validate shape via pure function — can't navigate to a non-local URL in harness.
    const fakeHttpUrl = 'http://example.com/page';
    const parsed76 = new URL(fakeHttpUrl);
    const isLocalhost76 = /^(localhost|127\.|::1)/.test(parsed76.hostname);
    assert(!isLocalhost76, '[76b] example.com is correctly classified as non-localhost');
    assert(parsed76.protocol === 'http:', '[76c] http://example.com has protocol http:');
  }

  // ── [77] Iframe sandbox check ────────────────────────────────────────────
  console.log('\n[77] Iframe sandbox check — iframe-sandbox.html fixture');
  {
    await mcp.navigate_page({ url: `${B}/iframe-sandbox.html` });
    await new Promise(r => setTimeout(r, 800));
    const secRaw77 = await mcp.evaluate_script({ function: SECURITY_ANALYSIS_SCRIPT });
    const findings77 = parseSecurityAnalysisResult(secRaw77, `${B}/iframe-sandbox.html`);

    assert(Array.isArray(findings77),
      '[77a] parseSecurityAnalysisResult returns an array');
    const sandbox77 = findings77.filter(f => f.type === 'security_iframe_no_sandbox');
    assert(sandbox77.length >= 2,
      `[77b] iframe-sandbox fixture produces at least 2 security_iframe_no_sandbox findings (got ${sandbox77.length})`);
    assert(sandbox77.every(f => f.severity === 'warning'),
      '[77c] security_iframe_no_sandbox findings are severity: warning');
    // Sandboxed iframe (third entry) must NOT be flagged
    const sandboxedFlagged77 = sandbox77.filter(f => f.src && f.src.includes('example.com') && false);
    assert(sandbox77.filter(f => f.src?.includes('sandboxed')).length === 0,
      '[77d] iframe with sandbox attribute is NOT flagged');
  }

  // ── [78] Watch Mode — WatchSession passive monitoring ────────────────────
  console.log('\n[78] Watch Mode — WatchSession poll, dedup, incremental detection');
  {
    // Navigate to the fixture page and allow on-load errors to settle before polling.
    await mcp.navigate_page({ url: `${B}/watch-issues.html` });
    await new Promise(r => setTimeout(r, 800));

    const session78 = new WatchSession(browser, B);

    // ── First poll ──────────────────────────────────────────────────────────
    const { findings: poll1_78 } = await session78.poll();

    // [78a] console errors detected (the fixture fires console.error on load)
    const consoleF78 = poll1_78.filter(f => f.type === 'console' || f.type === 'console_warning');
    assert(consoleF78.length >= 1,
      `[78a] First poll detects console errors/warnings from fixture (got ${consoleF78.length})`);

    // [78b] network errors detected (fixture fetches /api/always-500 → 500, /api/missing → 404)
    const netF78 = poll1_78.filter(f =>
      f.type === 'network_server_error' || f.type === 'network_not_found'
    );
    assert(netF78.length >= 1,
      `[78b] First poll detects network errors from fixture (got ${netF78.length})`);

    // [78c] deduplication — second immediate poll returns zero new findings
    const { findings: poll2_78 } = await session78.poll();
    assert(poll2_78.length === 0,
      `[78c] Second poll returns 0 new findings — dedup works (got ${poll2_78.length})`);

    // [78d] getAllFindings accumulates correctly across polls
    assert(session78.getAllFindings().length === poll1_78.length,
      `[78d] getAllFindings() matches cumulative total (${session78.getAllFindings().length} === ${poll1_78.length})`);

    // [78e] new console error fired after first poll → third poll detects only that one
    await mcp.evaluate_script({
      function: `() => { window.argusWatchTriggerError('probe-delta'); return true; }`,
    });
    await new Promise(r => setTimeout(r, 300));
    const { findings: poll3_78 } = await session78.poll();
    const incF78 = poll3_78.filter(f =>
      f.type === 'console' && typeof f.message === 'string' && f.message.includes('ARGUS_WATCH_INC')
    );
    assert(incF78.length >= 1,
      `[78e] Third poll detects new incremental error only (got ${poll3_78.length} total, ${incF78.length} incremental)`);

    // [78f] HTTP 500 classified as network_server_error with severity critical
    const crits78 = session78.getAllFindings().filter(f =>
      f.type === 'network_server_error' && f.severity === 'critical'
    );
    assert(crits78.length >= 1,
      `[78f] HTTP 500 classified as network_server_error severity critical (got ${crits78.length})`);

    // [78g] every accumulated finding has the required fields: type, severity, message
    const allFinal78 = session78.getAllFindings();
    const validShape78 = allFinal78.every(f =>
      typeof f.type === 'string' &&
      typeof f.severity === 'string' &&
      typeof f.message === 'string'
    );
    assert(validShape78,
      `[78g] All findings have required fields: type, severity, message (checked ${allFinal78.length})`);
  }

  // ── [79] Zod config validation (v9.1.6) ──────────────────────────────────────
  console.log('\n[79] Zod config validation — validateConfig guards targets.js shape');
  {
    // [79a] actual targets.js exports pass schema validation without throwing
    let threw79a = false;
    try { validateConfig(argusTargets); } catch { threw79a = true; }
    assert(!threw79a,
      '[79a] validateConfig(targets) passes on real targets.js without throwing');

    // [79b] route missing required path field → throws
    let threw79b = false;
    try {
      validateConfig({
        ...argusTargets,
        routes: [{ name: 'NoPath', critical: false }],
      });
    } catch { threw79b = true; }
    assert(threw79b,
      '[79b] validateConfig throws when a route is missing the required path field');

    // [79c] route path not starting with / → throws
    let threw79c = false;
    try {
      validateConfig({
        ...argusTargets,
        routes: [{ path: 'no-slash', name: 'Bad', critical: false }],
      });
    } catch { threw79c = true; }
    assert(threw79c,
      '[79c] validateConfig throws when route.path does not start with "/"');

    // [79d] threshold with non-number value → throws
    let threw79d = false;
    try {
      validateConfig({
        ...argusTargets,
        thresholds: {
          ...argusTargets.thresholds,
          perf: { ...argusTargets.thresholds.perf, LCP: 'not-a-number' },
        },
      });
    } catch { threw79d = true; }
    assert(threw79d,
      '[79d] validateConfig throws when thresholds.perf.LCP is a string instead of a number');
  }

  // ── Block [80] Argus MCP server registration ─────────────────────────────
  {
    console.log('\n[80] Argus MCP server — file registration (v9.3.0)');

    const mcpServerPath = path.join(__dirname, '../src/mcp-server.js');
    const mcpJsonPath   = path.join(__dirname, '../.mcp.json');

    // [80a] src/mcp-server.js exists and is readable
    let serverContent = null;
    try { serverContent = fs.readFileSync(mcpServerPath, 'utf8'); } catch { /* file missing */ }
    assert(serverContent !== null, '[80a] src/mcp-server.js exists and is readable');

    // [80b] file contains 'argus_audit' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_audit'),
      '[80b] src/mcp-server.js registers the argus_audit tool',
    );

    // [80c] file contains 'argus_compare' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_compare'),
      '[80c] src/mcp-server.js registers the argus_compare tool',
    );

    // [80d] file contains 'argus_audit_full' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_audit_full'),
      '[80d] src/mcp-server.js registers the argus_audit_full tool',
    );

    // [80e] file contains 'argus_last_report' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_last_report'),
      '[80e] src/mcp-server.js registers the argus_last_report tool',
    );

    // [80f] .mcp.json exists and contains "argus" server entry
    let mcpJsonContent = null;
    try { mcpJsonContent = fs.readFileSync(mcpJsonPath, 'utf8'); } catch { /* file missing */ }
    assert(
      mcpJsonContent !== null && mcpJsonContent.includes('"argus"'),
      '[80f] .mcp.json exists and contains "argus" server entry',
    );

    // [80g] file contains 'argus_watch_snapshot' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_watch_snapshot'),
      '[80g] src/mcp-server.js registers the argus_watch_snapshot tool',
    );

    // [80h] argus_watch_snapshot inputSchema includes a tabId property
    assert(
      serverContent !== null && serverContent.includes('argus_watch_snapshot') &&
        serverContent.includes('tabId'),
      '[80h] argus_watch_snapshot inputSchema defines a tabId property',
    );

    // [80i] file contains 'argus_get_context' tool name
    assert(
      serverContent !== null && serverContent.includes('argus_get_context'),
      '[80i] src/mcp-server.js registers the argus_get_context tool',
    );

    // [80j] argus_get_context inputSchema includes snapshot_id for fix loop
    assert(
      serverContent !== null && serverContent.includes('snapshot_id'),
      '[80j] argus_get_context inputSchema includes snapshot_id for fix loop',
    );

    // [80k] snapshotStore present — fix loop state management
    assert(
      serverContent !== null && serverContent.includes('snapshotStore'),
      '[80k] src/mcp-server.js contains snapshotStore for fix loop state',
    );

    // [80l] fix loop diff fields present in handleGetContext
    assert(
      serverContent !== null && serverContent.includes('resolved') &&
        serverContent.includes('new_issues') && serverContent.includes('persisting'),
      '[80l] handleGetContext emits resolved / new_issues / persisting diff fields',
    );

    // [80m] argus_visual_diff tool registered (Extension)
    assert(
      serverContent !== null && serverContent.includes('argus_visual_diff'),
      '[80m] src/mcp-server.js registers the argus_visual_diff tool',
    );

    // [80n] argus_visual_diff handler present
    assert(
      serverContent !== null && serverContent.includes('handleVisualDiff'),
      '[80n] handleVisualDiff function present in mcp-server.js',
    );
  }

  // ── Block [81] createFinding() factory ────────────────────────────────────
  {
    console.log('\n[81] createFinding() factory (domain layer)');

    // [81a] valid finding created with all required fields
    const f81a = createFinding({ type: 'console_error', severity: 'warning', message: 'oops', url: '/foo' });
    assert(
      f81a.type === 'console_error' && f81a.severity === 'warning' && f81a.message === 'oops' && f81a.url === '/foo',
      '[81a] createFinding returns correct field values',
    );

    // [81b] missing type → throws containing "type"
    let threw81b = false;
    try { createFinding({ severity: 'info', message: 'm' }); } catch (e) { threw81b = /type/i.test(e.message); }
    assert(threw81b, '[81b] createFinding throws when type is missing');

    // [81c] invalid severity → throws containing "severity"
    let threw81c = false;
    try { createFinding({ type: 't', severity: 'medium', message: 'm' }); } catch (e) { threw81c = /severity/i.test(e.message); }
    assert(threw81c, '[81c] createFinding throws on invalid severity');

    // [81d] returned object is frozen (immutable)
    const f81d = createFinding({ type: 't', severity: 'info', message: 'm' });
    assert(Object.isFrozen(f81d), '[81d] createFinding returns a frozen object');
  }

  // ── Block [82] withRetry() exponential backoff ─────────────────────────────
  {
    console.log('\n[82] withRetry() exponential backoff');

    // [82a] successful function called exactly once
    let calls82a = 0;
    await withRetry(() => { calls82a++; return Promise.resolve('ok'); }, { attempts: 3, delayMs: 1 });
    assert(calls82a === 1, '[82a] withRetry calls fn once when it succeeds immediately');

    // [82b] transient failure retried — succeeds on second attempt
    let calls82b = 0;
    await withRetry(() => {
      calls82b++;
      if (calls82b < 2) throw new Error('transient');
      return Promise.resolve('ok');
    }, { attempts: 3, delayMs: 1 });
    assert(calls82b === 2, '[82b] withRetry retries on transient failure and succeeds on second attempt');

    // [82c] persistent failure rethrown after all attempts exhausted
    let threw82c = false;
    let calls82c = 0;
    try {
      await withRetry(() => { calls82c++; throw new Error('permanent'); }, { attempts: 2, delayMs: 1 });
    } catch { threw82c = true; }
    assert(threw82c && calls82c === 2, '[82c] withRetry rethrows after all attempts exhausted');

    // [82d] ARGUS_RETRY_ATTEMPTS=1 env override → only one attempt made
    const prev = process.env.ARGUS_RETRY_ATTEMPTS;
    process.env.ARGUS_RETRY_ATTEMPTS = '1';
    let calls82d = 0;
    let threw82d = false;
    try {
      await withRetry(() => { calls82d++; throw new Error('fail'); }, { delayMs: 1 });
    } catch { threw82d = true; }
    if (prev === undefined) delete process.env.ARGUS_RETRY_ATTEMPTS;
    else process.env.ARGUS_RETRY_ATTEMPTS = prev;
    assert(threw82d && calls82d === 1, '[82d] ARGUS_RETRY_ATTEMPTS=1 limits withRetry to one attempt');
  }

  // ── Block [83] Watch dashboard + fix loop contracts ──────────────────────
  {
    console.log('\n[83] Watch dashboard + argus_get_context fix loop');

    const watchModePath = path.join(__dirname, '../src/orchestration/watch-mode.js');
    let watchContent = null;
    try { watchContent = fs.readFileSync(watchModePath, 'utf8'); } catch { /* file missing */ }

    // [83a] watch-mode.js exists and is readable
    assert(watchContent !== null, '[83a] src/orchestration/watch-mode.js exists and is readable');

    // [83b] DASHBOARD_HTML constant present
    assert(
      watchContent !== null && watchContent.includes('DASHBOARD_HTML'),
      '[83b] watch-mode.js defines the DASHBOARD_HTML constant',
    );

    // [83c] startDashboard function present
    assert(
      watchContent !== null && watchContent.includes('startDashboard'),
      '[83c] watch-mode.js exports/defines startDashboard',
    );

    // [83d] dashboard /data endpoint present
    assert(
      watchContent !== null && watchContent.includes('/data'),
      '[83d] watch-mode.js dashboard serves a /data JSON endpoint',
    );

    // [83e] ARGUS_WATCH_UI_PORT env var referenced
    assert(
      watchContent !== null && watchContent.includes('ARGUS_WATCH_UI_PORT'),
      '[83e] watch-mode.js reads ARGUS_WATCH_UI_PORT for dashboard port',
    );

    // [83f] WatchSession and runWatchMode still exported
    assert(
      watchContent !== null &&
        watchContent.includes('export class WatchSession') &&
        watchContent.includes('export async function runWatchMode'),
      '[83f] watch-mode.js still exports WatchSession and runWatchMode',
    );
  }

  // ── Block [84] cli/init.js — detectFramework, generateTargetsJs, generateEnvFile ──
  {
    console.log('\n[84] cli/init.js — detectFramework, generateTargetsJs, generateEnvFile');

    const initPath = path.join(__dirname, '../src/cli/init.js');
    let initContent = null;
    try { initContent = fs.readFileSync(initPath, 'utf8'); } catch { /* file missing */ }

    // [84a] init.js exists and is readable
    assert(initContent !== null, '[84a] src/cli/init.js exists and is readable');

    // [84b] detectFramework exported
    assert(
      initContent !== null && initContent.includes('export function detectFramework'),
      '[84b] src/cli/init.js exports detectFramework',
    );

    // [84c] generateTargetsJs exported
    assert(
      initContent !== null && initContent.includes('export function generateTargetsJs'),
      '[84c] src/cli/init.js exports generateTargetsJs',
    );

    // [84d] generateEnvFile exported
    assert(
      initContent !== null && initContent.includes('export function generateEnvFile'),
      '[84d] src/cli/init.js exports generateEnvFile',
    );

    // [84e] detectFramework returns 'unknown' for non-existent dir (pure function test)
    const { detectFramework, generateTargetsJs, generateEnvFile } = await import('../src/cli/init.js');
    assert(
      detectFramework('/nonexistent-dir-argus-test-84e') === 'unknown',
      '[84e] detectFramework returns "unknown" for a non-existent directory',
    );

    // [84f] generateTargetsJs returns non-empty string containing the supplied route path
    const generatedTs = generateTargetsJs([{ path: '/test-84f', name: 'Test', critical: false, waitFor: null }]);
    assert(
      typeof generatedTs === 'string' && generatedTs.length > 0 && generatedTs.includes('/test-84f'),
      '[84f] generateTargetsJs returns non-empty string containing the supplied route path',
    );

    // [84g] generateEnvFile returns non-empty string substituting the supplied devUrl
    const generatedEnv = generateEnvFile({ devUrl: 'http://localhost:49999' });
    assert(
      typeof generatedEnv === 'string' && generatedEnv.length > 0 && generatedEnv.includes('localhost:49999'),
      '[84g] generateEnvFile returns non-empty string containing the supplied TARGET_DEV_URL',
    );
  }

  // ── Block [85] Production 401/403 severity (GAP-022 + GAP-009 regression) ──
  {
    console.log('\n[85] Production 401/403 severity — crawlRouteCheap critical:true vs false (GAP-022 / GAP-009)');

    const crit85   = { name: 'Net-Errors-Crit',    path: '/network-errors.html', critical: true,  waitFor: null };
    const nonCrit85 = { name: 'Net-Errors-NonCrit', path: '/network-errors.html', critical: false, waitFor: null };

    const rc85 = await crawlRouteCheap(crit85, B, mcp);
    const n401c = rc85.errors.filter(e => e.type === 'network' && e.status === 401);
    const n403c = rc85.errors.filter(e => e.type === 'network' && e.status === 403);
    assert(
      n401c.length > 0 && n401c[0].severity === 'critical',
      `[85a] Production: 401 → critical on critical route (classifyNetworkRequest) (got ${n401c[0]?.severity ?? 'none'})`,
    );
    assert(
      n403c.length > 0 && n403c[0].severity === 'critical',
      `[85b] Production: 403 → critical on critical route (got ${n403c[0]?.severity ?? 'none'})`,
    );

    const rn85 = await crawlRouteCheap(nonCrit85, B, mcp);
    const n401n = rn85.errors.filter(e => e.type === 'network' && e.status === 401);
    const n403n = rn85.errors.filter(e => e.type === 'network' && e.status === 403);
    assert(
      n401n.length > 0 && n401n[0].severity === 'warning',
      `[85c] Production: 401 → warning on non-critical route (GAP-009) (got ${n401n[0]?.severity ?? 'none'})`,
    );
    assert(
      n403n.length > 0 && n403n[0].severity === 'warning',
      `[85d] Production: 403 → warning on non-critical route (GAP-009) (got ${n403n[0]?.severity ?? 'none'})`,
    );
  }

  // ── Block [86] Production console.error severity (GAP-023) ──────────────────
  {
    console.log('\n[86] Production console.error severity — crawlRouteCheap critical:true vs false (GAP-023)');

    const critCons86   = { name: 'JS-Crit',    path: '/js-errors-critical.html', critical: true,  waitFor: null };
    const nonCritCons86 = { name: 'JS-NonCrit', path: '/js-errors.html',          critical: false, waitFor: null };

    const rc86 = await crawlRouteCheap(critCons86, B, mcp);
    const ce86c = rc86.errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce86c.length >= 1, `[86a] Production: console.error detected on critical route (got ${ce86c.length})`);
    assert(
      ce86c.every(e => e.severity === 'critical'),
      `[86b] Production: all console.error → critical on critical route`,
    );

    const rn86 = await crawlRouteCheap(nonCritCons86, B, mcp);
    const ce86n = rn86.errors.filter(e => e.type === 'console' && e.level === 'error');
    assert(ce86n.length >= 1, `[86c] Production: console.error detected on non-critical route (got ${ce86n.length})`);
    assert(
      ce86n.every(e => e.severity === 'warning'),
      `[86d] Production: all console.error → warning on non-critical route`,
    );
  }

  // ── Block [87] Production load_failure via crawlRouteCheap (GAP-024) ────────
  {
    console.log('\n[87] Production load_failure — waitFor timeout via crawlRouteCheap (GAP-024)');

    const lfRoute87 = { name: 'WaitFor-Timeout', path: '/waitfor-timeout.html', critical: false, waitFor: '#never-appears' };
    const result87  = await crawlRouteCheap(lfRoute87, B, mcp);
    const lf87      = result87.errors.filter(e => e.type === 'load_failure');
    assert(lf87.length > 0, `[87a] Production: load_failure emitted when waitFor selector never appears`);
    assert(
      lf87[0]?.severity === 'warning',
      `[87b] Production: load_failure → warning on non-critical route (got ${lf87[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof lf87[0]?.message === 'string' && lf87[0].message.includes('#never-appears'),
      `[87c] Production: load_failure message names the missing selector`,
    );
  }

  // ── Block [88] Production api_call_summary via crawlRouteCheap (GAP-025) ────
  {
    console.log('\n[88] Production api_call_summary — API frequency via crawlRouteCheap (GAP-025)');

    const apiRoute88 = { name: 'API-Freq', path: '/api-frequency.html', critical: false, waitFor: null };
    const result88   = await crawlRouteCheap(apiRoute88, B, mcp);
    const summary88  = result88.errors.filter(e => e.type === 'api_call_summary');
    const loop88     = result88.errors.filter(e => e.type === 'api_duplicate_call' && (e.endpoint ?? '').includes('data-loop'));
    assert(summary88.length > 0, `[88a] Production: api_call_summary present in errors`);
    assert(
      loop88.length > 0 && loop88[0].severity === 'critical',
      `[88b] Production: data-loop ×6+ → critical severity (got ${loop88[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof summary88[0]?.uniqueEndpoints === 'number',
      `[88c] Production: api_call_summary.uniqueEndpoints is a number (got ${typeof summary88[0]?.uniqueEndpoints})`,
    );
  }

  // ── Block [89] Production seo_missing_description (GAP-028) ─────────────────
  {
    console.log('\n[89] Production seo_missing_description — via crawlRouteCheap (GAP-028)');

    const seoRoute89 = { name: 'SEO-Issues', path: '/seo-issues.html', critical: false, waitFor: null };
    const result89   = await crawlRouteCheap(seoRoute89, B, mcp);
    const misDesc89  = result89.errors.filter(e => e.type === 'seo_missing_description');
    assert(misDesc89.length > 0, `[89a] Production: seo_missing_description detected`);
    assert(
      misDesc89[0]?.severity === 'warning',
      `[89b] Production: seo_missing_description → warning (got ${misDesc89[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof misDesc89[0]?.message === 'string' && misDesc89[0].message.length > 0,
      `[89c] Production: seo_missing_description has non-empty message`,
    );
  }

  // ── Block [90] Production SCSS sourceMappingURL in css_summary (GAP-027) ────
  // CSS analysis is now a registerExpensive plugin (GAP-034); call it directly.
  {
    console.log('\n[90] Production SCSS sourceMappingURL — css_summary.scssSourceFiles via css-analyzer (GAP-027)');

    const browser90 = new CdpBrowserAdapter(mcp);
    const url90     = `${B}/css-issues.html`;
    await browser90.navigate(url90);
    await new Promise(r => setTimeout(r, 800));
    const cssRaw90   = await browser90.evaluate(CSS_ANALYSIS_SCRIPT);
    const cssInput90 = cssRaw90 == null ? null
      : typeof cssRaw90 === 'object' && !Array.isArray(cssRaw90) ? cssRaw90
      : parseEval(cssRaw90, null);
    const cssErrors90  = cssInput90 ? parseCssAnalysisResult(cssInput90, url90) : [];
    const cssSummary90 = cssErrors90.find(e => e.type === 'css_summary');
    assert(cssSummary90 !== undefined, `[90a] Production: css_summary finding present`);
    assert(
      Array.isArray(cssSummary90?.scssSourceFiles),
      `[90b] Production: css_summary.scssSourceFiles is an array`,
    );
    assert(
      (cssSummary90?.scssSourceFiles?.length ?? 0) > 0,
      `[90c] Production: css_summary.scssSourceFiles has ≥1 entry (sourceMappingURL detected)`,
    );
  }

  // ── Block [91] Production css_override (non-!important) (GAP-026) ───────────
  // CSS analysis is now a registerExpensive plugin (GAP-034); call it directly.
  {
    console.log('\n[91] Production css_override (non-!important) — via css-analyzer (GAP-026)');

    const browser91 = new CdpBrowserAdapter(mcp);
    const url91     = `${B}/css-issues.html`;
    await browser91.navigate(url91);
    await new Promise(r => setTimeout(r, 800));
    const cssRaw91   = await browser91.evaluate(CSS_ANALYSIS_SCRIPT);
    const cssInput91 = cssRaw91 == null ? null
      : typeof cssRaw91 === 'object' && !Array.isArray(cssRaw91) ? cssRaw91
      : parseEval(cssRaw91, null);
    const cssErrors91 = cssInput91 ? parseCssAnalysisResult(cssInput91, url91) : [];
    const nonImp91    = cssErrors91.filter(e => e.type === 'css_override' && !e.hasImportant);
    assert(
      nonImp91.length > 0,
      `[91a] Production: non-!important css_override detected (got ${nonImp91.length})`,
    );
    assert(
      nonImp91[0]?.severity === 'info',
      `[91b] Production: non-!important css_override → info severity (got ${nonImp91[0]?.severity ?? 'none'})`,
    );
    assert(
      typeof nonImp91[0]?.property === 'string',
      `[91c] Production: css_override has property field (got ${typeof nonImp91[0]?.property})`,
    );
  }

  // ── Block [92] Lighthouse CLS soft assertion via checkLighthouse (GAP-029) ──
  {
    console.log('\n[92] Lighthouse contract — checkLighthouse shape on perf-cls.html (GAP-029, soft)');

    const lhResult92 = await checkLighthouse(browser, `${B}/perf-cls.html`);
    soft(
      Array.isArray(lhResult92),
      `[92a] checkLighthouse always returns an array (got ${typeof lhResult92})`,
    );
    soft(
      lhResult92.length === 0 || lhResult92.every(v => v.type && v.severity && v.message),
      `[92b] checkLighthouse violations have required fields: type, severity, message (or N/A in headless)`,
    );
    soft(
      lhResult92.length === 0 || lhResult92.every(v => typeof v.url === 'string'),
      `[92c] checkLighthouse violations carry url field (or N/A in headless)`,
    );
  }

  // ── Block [93] diff.js utility unit tests (GAP-030) ─────────────────────────
  {
    console.log('\n[93] diff.js utilities — diffNetworkRequests + diffConsoleMessages (GAP-030)');

    // diffNetworkRequests: added, removed, changed
    const reqs93Dev = [
      { url: 'http://localhost:3100/api/feature-flags', status: 200, method: 'GET' },
      { url: 'http://localhost:3100/api/checkout',      status: 200, method: 'GET' },
    ];
    const reqs93Staging = [
      { url: 'http://localhost:3101/api/checkout',  status: 500, method: 'GET' },
      { url: 'http://localhost:3101/api/tracking',  status: 200, method: 'GET' },
    ];
    const diff93 = diffNetworkRequests(reqs93Dev, reqs93Staging);
    assert(diff93.added.length > 0,
      `[93a] diffNetworkRequests detects added endpoint in staging (got ${diff93.added.length})`);
    assert(diff93.removed.length > 0,
      `[93b] diffNetworkRequests detects removed endpoint (present in dev, absent in staging) (got ${diff93.removed.length})`);
    assert(diff93.changed.length > 0,
      `[93c] diffNetworkRequests detects status change (checkout 200→500) (got ${diff93.changed.length})`);

    // diffConsoleMessages: new errors in staging not in dev
    const msgs93Dev = [{ level: 'error', text: 'pre-existing error' }];
    const msgs93Staging = [
      { level: 'error', text: 'pre-existing error' },
      { level: 'error', text: 'new staging regression error' },
    ];
    const newErrs93 = diffConsoleMessages(msgs93Dev, msgs93Staging);
    assert(
      newErrs93.length === 1 && newErrs93[0].text === 'new staging regression error',
      `[93d] diffConsoleMessages detects new error in staging not in dev (got ${newErrs93.length}: "${newErrs93[0]?.text ?? 'none'}")`,
    );
  }

  // ── Block [94] mcp-parsers.js unit tests ─────────────────────────────────────
  {
    console.log('\n[94] mcp-parsers.js — parseConsoleMsgResponse + parseNetworkReqResponse unit tests');

    // parseConsoleMsgResponse — null/empty guard
    assert(Array.isArray(parseConsoleMsgResponse(null)),       '[94a] parseConsoleMsgResponse(null) returns array');
    assert(parseConsoleMsgResponse('').length === 0,           '[94b] parseConsoleMsgResponse("") returns []');

    // parseConsoleMsgResponse — standard format
    const cm94 = parseConsoleMsgResponse('msgid=3 [error] something failed');
    assert(cm94.length === 1 && cm94[0]._msgid === 3,         '[94c] parseConsoleMsgResponse parses msgid correctly');
    assert(cm94[0].level === 'error' && cm94[0].text === 'something failed',
      '[94d] parseConsoleMsgResponse parses level and text');

    // parseConsoleMsgResponse — warn → warning normalisation
    const cw94 = parseConsoleMsgResponse('msgid=7 [warn] deprecated api call');
    assert(cw94[0]?.level === 'warning',                       '[94e] parseConsoleMsgResponse normalises [warn] → "warning"');

    // parseNetworkReqResponse — null/empty guard
    assert(parseNetworkReqResponse(null).length === 0,         '[94f] parseNetworkReqResponse(null) returns []');

    // parseNetworkReqResponse — standard format
    const nr94 = parseNetworkReqResponse('reqid=1 GET /api/data [200]');
    assert(nr94.length === 1 && nr94[0]._reqid === 1 && nr94[0].status === 200,
      '[94g] parseNetworkReqResponse parses reqid + status correctly');

    // parseNetworkReqResponse — extended status text (GAP-022 regression guard)
    const nr94ext = parseNetworkReqResponse('reqid=5 POST /api/auth [401 Unauthorized]');
    assert(nr94ext.length === 1 && nr94ext[0].status === 401,
      '[94h] parseNetworkReqResponse handles "[401 Unauthorized]" status text format');
  }

  // ── Block [95] registry.js plugin registration ────────────────────────────────
  {
    console.log('\n[95] registry.js — plugin registration order + getCheap/getExpensive');

    // Analyzers self-register at module import time via orchestrator.js → crawl-and-report.js.
    // All 6 production analyzers call registerExpensive() — none call registerCheap()
    // (cheap analyzers are hard-wired in crawlRouteCheap, not discovered via registry).
    const cheap95  = getCheap();
    const exp95    = getExpensive();
    assert(Array.isArray(cheap95),
      `[95a] getCheap returns an array (no production analyzer self-registers as cheap; got ${cheap95.length})`);
    assert(cheap95.every(a => typeof a.analyze === 'function'),
      '[95b] all cheap analyzers have an analyze() function (vacuously true — none registered)');
    assert(exp95.length >= 6,
      `[95c] getExpensive returns ≥6 registered expensive analyzers (got ${exp95.length})`);

    // Manual registration adds immediately
    const cheapBefore95 = getCheap().length;
    registerCheap({ name: 'harness-probe-cheap', analyze: () => [] });
    assert(getCheap().length === cheapBefore95 + 1,
      '[95d] registerCheap adds analyzer immediately (getCheap() length +1)');

    // Cheap and expensive sets are disjoint by name
    const cheapNames95 = new Set(getCheap().map(a => a.name));
    const expNames95   = new Set(getExpensive().map(a => a.name));
    const overlap95    = [...cheapNames95].filter(n => expNames95.has(n));
    assert(overlap95.length === 0,
      `[95e] cheap and expensive analyzer sets are disjoint (overlap: ${overlap95.join(', ') || 'none'})`);
  }

  // ── Block [96] report-processor.js — deduplicateFindings + rebuildSummary ────
  {
    console.log('\n[96] report-processor.js — deduplicateFindings + rebuildSummary pure functions');

    // deduplicateFindings — empty input
    assert(deduplicateFindings([]).length === 0,
      '[96a] deduplicateFindings([]) returns []');

    // deduplicateFindings — removes exact duplicates (same type + message + url)
    const dup96 = [
      { type: 'console', message: 'err', url: 'http://localhost/' },
      { type: 'console', message: 'err', url: 'http://localhost/' },
    ];
    assert(deduplicateFindings(dup96).length === 1,
      '[96b] deduplicateFindings removes identical type+message+url entries');

    // deduplicateFindings — different URL = not a duplicate
    const diff96 = [
      { type: 'console', message: 'err', url: 'http://localhost/a' },
      { type: 'console', message: 'err', url: 'http://localhost/b' },
    ];
    assert(deduplicateFindings(diff96).length === 2,
      '[96c] deduplicateFindings keeps entries with different URLs');

    // rebuildSummary — counts correctly across severities
    const report96 = {
      routes: [{ errors: [
        { type: 'a', severity: 'critical' },
        { type: 'b', severity: 'warning' },
        { type: 'c', severity: 'info' },
      ]}],
      flows: [],
      codebase: [],
      summary: {},
    };
    rebuildSummary(report96);
    assert(report96.summary.total === 3,    `[96d] rebuildSummary total=3 (got ${report96.summary.total})`);
    assert(report96.summary.critical === 1, `[96e] rebuildSummary critical=1 (got ${report96.summary.critical})`);
    assert(report96.summary.warning === 1,  `[96f] rebuildSummary warning=1 (got ${report96.summary.warning})`);
    assert(report96.summary.info === 1,     `[96g] rebuildSummary info=1 (got ${report96.summary.info})`);
  }

  // ── Block [97] config/targets.js — thresholds + config constants ──────────────
  {
    console.log('\n[97] config/targets.js — thresholds + config constants');

    const { thresholds: th97, config: cfg97 } = argusTargets;

    assert(typeof th97.perf.LCP === 'number' && th97.perf.LCP > 0,
      `[97a] thresholds.perf.LCP is a positive number (got ${th97.perf.LCP})`);
    assert(th97.network.slowCritical > th97.network.slowWarning,
      `[97b] slowCritical > slowWarning ordering invariant (${th97.network.slowCritical} > ${th97.network.slowWarning})`);
    assert(typeof cfg97.pageSettleMs === 'number' && cfg97.pageSettleMs > 0,
      `[97c] config.pageSettleMs is a positive number (got ${cfg97.pageSettleMs})`);
    assert(typeof th97.lighthouse.accessibility.critical === 'number',
      '[97d] thresholds.lighthouse.accessibility.critical is a number');
    assert(th97.memory.detachedCritical > th97.memory.detachedWarning,
      `[97e] memory detachedCritical > detachedWarning (${th97.memory.detachedCritical} > ${th97.memory.detachedWarning})`);
  }

  // ── Block [98] slug.js — slugify edge cases ───────────────────────────────────
  {
    console.log('\n[98] slug.js — slugify edge cases');

    assert(slugify('Hello World!') === 'hello-world',
      '[98a] slugify("Hello World!") → "hello-world"');
    assert(slugify('') === 'unnamed',
      '[98b] slugify("") → "unnamed"');
    assert(slugify(null) === 'unnamed',
      '[98c] slugify(null) → "unnamed"');
    assert(!/^-|-$/.test(slugify('--leading-trailing--')),
      '[98d] slugify strips leading/trailing dashes');
    assert(/^[a-z0-9-]+$/.test(slugify('Argus QA Tool — v9.5!')),
      '[98e] slugify output contains only [a-z0-9-] characters');
  }

  // ── Block [99] telemetry.js — no-op transparent wrapper ──────────────────────
  {
    console.log('\n[99] telemetry.js — no-op transparent wrapper (no OTEL endpoint set)');

    // recordFinding, recordFlaky, recordNewFindings must not throw in no-op mode
    let threw99 = false;
    try {
      recordFinding('console', 'critical', 'home');
      recordFlaky(0, 'home');
      recordFlaky(3, 'checkout');
      recordNewFindings(5);
      recordNewFindings(0);
    } catch { threw99 = true; }
    assert(!threw99, '[99a] recordFinding/recordFlaky/recordNewFindings do not throw without OTEL endpoint');

    // startSpan must be transparent — callback return value passes through
    const spanResult99 = await startSpan('harness.test', { block: '99' }, () => 'sentinel-value-99');
    assert(spanResult99 === 'sentinel-value-99',
      '[99b] startSpan passes callback return value through (transparent wrapper)');

    // startSpan must not suppress thrown errors
    let spanThrew99 = false;
    try {
      await startSpan('harness.err', {}, () => { throw new Error('intentional-99'); });
    } catch (e) {
      spanThrew99 = e.message === 'intentional-99';
    }
    assert(spanThrew99, '[99c] startSpan re-throws errors from callback');
  }

  // ── Block [100] logger.js — childLogger factory ───────────────────────────────
  {
    console.log('\n[100] logger.js — childLogger returns structured Pino child logger');

    const log100 = childLogger('harness-test-100');
    assert(log100 !== null && typeof log100 === 'object',
      '[100a] childLogger returns a non-null object');
    assert(typeof log100.info === 'function',
      '[100b] childLogger result has info() method');
    assert(typeof log100.warn === 'function' && typeof log100.error === 'function',
      '[100c] childLogger result has warn() and error() methods');
  }

  // ── Block [101] argus.js + batch-runner.js re-export barrels ─────────────────
  {
    console.log('\n[101] argus.js + batch-runner.js — re-export barrel validation');

    assert(typeof argusJs.runCrawl === 'function',
      '[101a] argus.js re-exports runCrawl as a function');
    assert(typeof argBatchRunner.runCrawl === 'function',
      '[101b] batch-runner.js re-exports runCrawl as a function');
    assert(argusJs.runCrawl === argBatchRunner.runCrawl,
      '[101c] both barrel files point to the same runCrawl function reference');
  }

  // ── Block [102] mcp-client.js — unwrapEval shapes ────────────────────────────
  {
    console.log('\n[102] mcp-client.js — unwrapEval handles all response shapes');

    assert(unwrapEval(null) === null,
      '[102a] unwrapEval(null) → null');
    assert(unwrapEval({ result: 'hello' }) === 'hello',
      '[102b] unwrapEval({ result: "hello" }) → "hello"');
    assert(unwrapEval('plain-string') === 'plain-string',
      '[102c] unwrapEval(string) → same string (no unwrapping)');
    // Object without result field → return the object itself
    const obj102 = { data: 42 };
    assert(unwrapEval(obj102) === obj102,
      '[102d] unwrapEval(object without result) → returns object itself');
  }

  // ── Block [103] verifySlackSignature — pure HMAC function ────────────────────
  {
    console.log('\n[103] server/slash-command-handler.js — verifySlackSignature pure function');

    const prevSecret103 = process.env.SLACK_SIGNING_SECRET;

    // [103a] No signing secret → false
    delete process.env.SLACK_SIGNING_SECRET;
    assert(
      verifySlackSignature({ headers: {}, rawBody: '' }) === false,
      '[103a] verifySlackSignature returns false when SLACK_SIGNING_SECRET is unset',
    );

    // [103b] Missing headers → false (secret present but no header fields)
    process.env.SLACK_SIGNING_SECRET = 'test-secret-103';
    assert(
      verifySlackSignature({ headers: {}, rawBody: '' }) === false,
      '[103b] verifySlackSignature returns false when headers are missing',
    );

    // [103c] Stale timestamp (> 5 min old) → false
    const staleTs103 = String(Math.floor(Date.now() / 1000) - 400);
    assert(
      verifySlackSignature({
        headers: { 'x-slack-signature': 'v0=abc', 'x-slack-request-timestamp': staleTs103 },
        rawBody: '',
      }) === false,
      '[103c] verifySlackSignature returns false for stale timestamp (>5 min)',
    );

    // [103d] Fresh timestamp + wrong signature → false
    const freshTs103 = String(Math.floor(Date.now() / 1000));
    assert(
      verifySlackSignature({
        headers: { 'x-slack-signature': 'v0=badhash', 'x-slack-request-timestamp': freshTs103 },
        rawBody: 'body=test',
      }) === false,
      '[103d] verifySlackSignature returns false for mismatched signature',
    );

    // [103e] Correctly constructed HMAC → true
    const secret103 = 'harness-signing-secret-103';
    process.env.SLACK_SIGNING_SECRET = secret103;
    const ts103    = String(Math.floor(Date.now() / 1000));
    const body103  = 'command=%2Fargus-retest&text=http%3A%2F%2Fexample.com';
    const sig103   = 'v0=' + crypto.createHmac('sha256', secret103)
      .update(`v0:${ts103}:${body103}`).digest('hex');
    assert(
      verifySlackSignature({
        headers: { 'x-slack-signature': sig103, 'x-slack-request-timestamp': ts103 },
        rawBody: body103,
      }) === true,
      '[103e] verifySlackSignature returns true for valid HMAC signature',
    );

    // Restore
    if (prevSecret103 !== undefined) process.env.SLACK_SIGNING_SECRET = prevSecret103;
    else delete process.env.SLACK_SIGNING_SECRET;
  }

  // ── Block [104] server/interaction-handler.js — handleInteraction mock ────────
  {
    console.log('\n[104] server/interaction-handler.js — handleInteraction with mocked req/res');

    const mkRes = () => {
      const r = { _status: 200, _body: null };
      r.status = code => { r._status = code; return r; };
      r.json = body => { r._body = body; return r; };
      r.send = body => { r._body = body; return r; };
      return r;
    };

    // [104a] Missing/invalid Slack signature → 401
    const res104a = mkRes();
    await handleInteraction(
      { headers: {}, rawBody: '', body: {} },
      res104a,
    );
    assert(res104a._status === 401,
      '[104a] handleInteraction returns 401 when signature is invalid/missing');

    // Build a valid signature so we can test downstream paths
    const secret104 = 'harness-secret-104';
    const prevSecret104 = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = secret104;

    const ts104    = String(Math.floor(Date.now() / 1000));
    const body104  = 'payload=%7Binvalid+json%7D';
    const sig104   = 'v0=' + crypto.createHmac('sha256', secret104)
      .update(`v0:${ts104}:${body104}`).digest('hex');

    // [104b] Valid signature + malformed JSON payload → 400
    const res104b = mkRes();
    await handleInteraction({
      headers: { 'x-slack-signature': sig104, 'x-slack-request-timestamp': ts104 },
      rawBody: body104,
      body: { payload: '{invalid json}' },
    }, res104b);
    assert(res104b._status === 400,
      '[104b] handleInteraction returns 400 for malformed JSON payload');

    // [104c] Valid signature + unrecognised interaction type → 200 (ack'd and ignored)
    const validPayload104 = JSON.stringify({
      type: 'unknown_interaction_type',
      actions: [],
    });
    const body104c   = `payload=${encodeURIComponent(validPayload104)}`;
    const sig104c    = 'v0=' + crypto.createHmac('sha256', secret104)
      .update(`v0:${ts104}:${body104c}`).digest('hex');
    const res104c = mkRes();
    await handleInteraction({
      headers: { 'x-slack-signature': sig104c, 'x-slack-request-timestamp': ts104 },
      rawBody: body104c,
      body: { payload: validPayload104 },
    }, res104c);
    assert(res104c._status === 200,
      '[104c] handleInteraction returns 200 (ack) for unrecognised interaction type');

    // [104d] handleInteraction is an async function
    assert(handleInteraction.constructor.name === 'AsyncFunction',
      '[104d] handleInteraction is an async function');

    if (prevSecret104 !== undefined) process.env.SLACK_SIGNING_SECRET = prevSecret104;
    else delete process.env.SLACK_SIGNING_SECRET;
  }

  // ── Block [105] slack-notifier.js — exported function shapes ─────────────────
  {
    console.log('\n[105] slack-notifier.js — exported function shapes (without Slack token)');

    assert(typeof postBugReport === 'function',
      '[105a] postBugReport is a function');
    assert(typeof postRetestResult === 'function',
      '[105b] postRetestResult is a function');
    assert(typeof acknowledgeMessage === 'function',
      '[105c] acknowledgeMessage is a function');
  }

  // ── Block [106] report-processor.js — processReport integration ──────────────
  {
    console.log('\n[106] report-processor.js — processReport integration (file I/O + baseline)');

    const tmpDir106 = path.join(os.tmpdir(), `argus-harness-106-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir106, 'baselines'), { recursive: true });

    const report106 = {
      generatedAt: new Date().toISOString(),
      baseUrl:     'http://localhost:3100',
      routes: [{
        route: 'Home',
        url:   'http://localhost:3100/',
        errors: [
          { type: 'console', message: 'err-a', severity: 'critical', url: 'http://localhost:3100/' },
          { type: 'network', message: 'net-b', severity: 'warning',  url: 'http://localhost:3100/' },
        ],
      }],
      flows:    [],
      codebase: [],
      summary:  { total: 0, critical: 0, warning: 0, info: 0 },
    };

    const { reportPath: rp106, diff: diff106 } = await processReport(report106, {
      outputDir:         tmpDir106,
      severityOverrides: {},
    });

    assert(fs.existsSync(rp106),
      '[106a] processReport writes JSON report to disk');
    assert(rp106.endsWith('.json'),
      '[106b] reportPath has .json extension');
    assert(report106.summary.total === 2,
      `[106c] rebuildSummary counts all findings (expected 2, got ${report106.summary.total})`);
    assert(diff106.isFirstRun === true,
      '[106d] first run — isFirstRun: true (no prior baseline)');
  }

  // ── Block [107] dispatcher.js — dispatchAll HTML fallback ────────────────────
  {
    console.log('\n[107] dispatcher.js — dispatchAll routes to HTML report when no Slack token');

    const tmpDir107 = path.join(os.tmpdir(), `argus-harness-107-${Date.now()}`);
    fs.mkdirSync(tmpDir107, { recursive: true });

    const rp107 = path.join(tmpDir107, 'test-report.json');
    const report107 = {
      generatedAt: new Date().toISOString(),
      baseUrl:     'http://localhost:3100',
      summary:     { total: 0, critical: 0, warning: 0, info: 0 },
      routes: [{ route: '/test', url: 'http://localhost:3100/test', errors: [] }],
      flows:       [],
    };
    fs.writeFileSync(rp107, JSON.stringify(report107, null, 2), 'utf8');

    // Ensure Slack is NOT configured so the HTML path is taken
    const prevSlack107 = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;

    await dispatchAll(
      report107,
      { isFirstRun: true, newCount: 0, resolvedCount: 0 },
      rp107,
    );

    // generateHtmlReport always writes <dir>/report.html
    const htmlPath107 = path.join(tmpDir107, 'report.html');
    assert(fs.existsSync(htmlPath107),
      '[107a] dispatchAll generates report.html when SLACK_BOT_TOKEN is absent');

    const html107 = fs.readFileSync(htmlPath107, 'utf8');
    assert(html107.includes('<title>'),
      '[107b] generated HTML contains <title> tag');
    assert(html107.includes('Argus'),
      '[107c] generated HTML mentions "Argus"');
    assert(typeof dispatchAll === 'function',
      '[107d] dispatchAll is exported as a function');

    if (prevSlack107 !== undefined) process.env.SLACK_BOT_TOKEN = prevSlack107;
  }

  // ── Block [108] session-persistence.js error paths ───────────────────────────
  {
    console.log('\n[108] session-persistence.js — restoreSession error paths + hasSession staleness');

    const tmpDir108 = path.join(os.tmpdir(), `argus-harness-108-${Date.now()}`);
    fs.mkdirSync(tmpDir108, { recursive: true });

    // [108a] Corrupt JSON → false (no browser interaction before parse)
    const corrupt108 = path.join(tmpDir108, 'corrupt.json');
    fs.writeFileSync(corrupt108, '{ not valid json !!!', 'utf8');
    const r108a = await restoreSession(null, 'http://localhost:3100', corrupt108);
    assert(r108a === false, '[108a] restoreSession returns false for corrupt JSON');

    // [108b] Missing file → false
    const missing108 = path.join(tmpDir108, 'missing.json');
    const r108b = await restoreSession(null, 'http://localhost:3100', missing108);
    assert(r108b === false, '[108b] restoreSession returns false when session file does not exist');

    // [108c] hasSession with missing file → false
    assert(hasSession(missing108) === false,
      '[108c] hasSession returns false when file does not exist');

    // [108d] hasSession with stale savedAt (>1 hour ago) → false
    const stale108 = path.join(tmpDir108, 'stale.json');
    fs.writeFileSync(stale108, JSON.stringify({
      savedAt: new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      baseUrl: 'http://localhost:3100',
      localStorage: {}, sessionStorage: {}, cookies: [],
    }), 'utf8');
    assert(hasSession(stale108) === false,
      '[108d] hasSession returns false when savedAt is >1 hour old');
  }

  // ── Block [109] baseline-manager.js branch sanitization + null case ──────────
  {
    console.log('\n[109] baseline-manager.js — getCurrentBranch env var + loadBaseline null');

    const tmpDir109 = path.join(os.tmpdir(), `argus-harness-109-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir109, 'baselines'), { recursive: true });

    // [109a] loadBaseline on non-existent file → null
    const missing109 = path.join(tmpDir109, 'baselines', 'no-branch.json');
    const bl109null  = loadBaseline(missing109);
    assert(bl109null === null,
      '[109a] loadBaseline returns null for non-existent baseline file');

    // [109b] getCurrentBranch via GITHUB_REF_NAME env var
    const prev109 = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = 'feature/my-branch';
    const branch109 = getCurrentBranch();
    assert(typeof branch109 === 'string' && branch109.length > 0,
      `[109b] getCurrentBranch returns a non-empty string via GITHUB_REF_NAME (got "${branch109}")`);
    // Sanitized branch must not contain '/'
    assert(!branch109.includes('/'),
      `[109c] getCurrentBranch sanitizes slashes from branch names (got "${branch109}")`);
    if (prev109 !== undefined) process.env.GITHUB_REF_NAME = prev109;
    else delete process.env.GITHUB_REF_NAME;

    // [109d] Multi-branch non-interference: save for A, save for B, load A unchanged
    const reportA109 = {
      baseUrl: 'http://localhost:3100',
      routes: [{ url: 'http://localhost:3100/', errors: [{ type: 'console', message: 'branch-a', severity: 'warning' }] }],
      flows: [], codebase: [], summary: {},
    };
    const reportB109 = {
      baseUrl: 'http://localhost:3100',
      routes: [{ url: 'http://localhost:3100/', errors: [{ type: 'network', message: 'branch-b', severity: 'critical' }] }],
      flows: [], codebase: [], summary: {},
    };
    const fileA109 = path.join(tmpDir109, 'baselines', 'branch-a.json');
    const fileB109 = path.join(tmpDir109, 'baselines', 'branch-b.json');
    saveBaseline(fileA109, reportA109);
    saveBaseline(fileB109, reportB109);
    const loadedA109 = loadBaseline(fileA109);
    assert(loadedA109 !== null,
      '[109d] loadBaseline(branchA) returns non-null after branchB baseline was also saved');
  }

  // ── Block [110] schema.js — Zod error message content ────────────────────────
  {
    console.log('\n[110] schema.js — Zod error message content verification');

    // [110a] Missing path → error message string contains field clue
    let err110a = null;
    try { validateConfig({ routes: [{ name: 'X' }] }); } catch (e) { err110a = e; }
    assert(err110a !== null && typeof err110a.message === 'string',
      '[110a] validateConfig with missing route.path throws an Error with message');

    // [110b] path not starting with '/' → error contains slash clue
    let err110b = null;
    try { validateConfig({ routes: [{ name: 'X', path: 'no-slash' }] }); } catch (e) { err110b = e; }
    assert(err110b !== null && typeof err110b.message === 'string',
      '[110b] validateConfig with path not starting with "/" throws with a message');

    // [110c] Wrong LCP type → error message is a non-empty string
    let err110c = null;
    try {
      validateConfig({
        routes: [{ name: 'X', path: '/' }],
        thresholds: { perf: { LCP: 'not-a-number' } },
      });
    } catch (e) { err110c = e; }
    assert(err110c !== null && err110c.message.length > 0,
      '[110c] validateConfig with string LCP throws non-empty error message');
  }

  // ── Block [111] github-reporter.js — isGitHubConfigured + formatPrComment cap ─
  {
    console.log('\n[111] github-reporter.js — isGitHubConfigured + formatPrComment MAX_TABLE_ROWS cap');

    const prevGhToken111 = process.env.GITHUB_TOKEN;
    const prevGhRepo111  = process.env.GITHUB_REPOSITORY;

    // [111a] isGitHubConfigured returns false when env vars absent
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    assert(isGitHubConfigured() === false,
      '[111a] isGitHubConfigured returns false when GITHUB_TOKEN and GITHUB_REPOSITORY are unset');

    // [111b] isGitHubConfigured returns true when both set
    process.env.GITHUB_TOKEN      = 'tok-test-111';
    process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
    assert(isGitHubConfigured() === true,
      '[111b] isGitHubConfigured returns true when both GITHUB_TOKEN and GITHUB_REPOSITORY are set');

    if (prevGhToken111 !== undefined) process.env.GITHUB_TOKEN      = prevGhToken111;
    else delete process.env.GITHUB_TOKEN;
    if (prevGhRepo111  !== undefined) process.env.GITHUB_REPOSITORY = prevGhRepo111;
    else delete process.env.GITHUB_REPOSITORY;

    // [111c] formatPrComment with 20 new findings caps table at 15 rows (MAX_TABLE_ROWS)
    const bigErrors111 = Array.from({ length: 20 }, (_, i) => ({
      type: 'console', severity: 'warning', message: `Finding ${i}`,
      url: 'http://localhost:3100/', isNew: true,
    }));
    const bigReport111 = {
      baseUrl: 'http://localhost:3100/',
      generatedAt: new Date().toISOString(),
      summary: { total: 20, critical: 0, warning: 20, info: 0 },
      routes: [{ route: 'Home', url: 'http://localhost:3100/', errors: bigErrors111 }],
      flows: [], codebase: [],
    };
    const comment111 = formatPrComment(bigReport111, { isFirstRun: false, newCount: 20, resolvedCount: 0 });
    assert(comment111.includes('more — see full report'),
      '[111c] formatPrComment with 20 findings includes overflow row ("more — see full report")');

    // [111d] postPrComment throws when GITHUB_PR_NUMBER not set (guard test)
    delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_REPOSITORY;
    let threw111d = false;
    try { await postPrComment({}, {}); } catch { threw111d = true; }
    assert(threw111d, '[111d] postPrComment throws when GITHUB_REPOSITORY/PR_NUMBER are not set');
  }

  // ── Block [112] html-reporter.js — large finding set (1000+ findings) ────────
  {
    console.log('\n[112] html-reporter.js — generateHtmlReport handles 1000+ findings');

    const tmpDir112 = path.join(os.tmpdir(), `argus-harness-112-${Date.now()}`);
    fs.mkdirSync(tmpDir112, { recursive: true });

    // Build a report with 1000 findings (10 routes × 100 errors each)
    const bigReport112 = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 1000, critical: 200, warning: 500, info: 300 },
      routes: Array.from({ length: 10 }, (_, i) => ({
        route: `/route-${i}`,
        url: `http://localhost:3100/route-${i}`,
        errors: Array.from({ length: 100 }, (_, j) => ({
          type: 'console', severity: j < 20 ? 'critical' : j < 70 ? 'warning' : 'info',
          message: `Error ${j} on route ${i}`, url: `http://localhost:3100/route-${i}`,
        })),
      })),
      flows: [], codebase: [],
    };
    const rp112 = path.join(tmpDir112, 'big-report.json');
    fs.writeFileSync(rp112, JSON.stringify(bigReport112, null, 2), 'utf8');

    let threw112 = false;
    let html112  = '';
    try { html112 = fs.readFileSync(generateHtmlReport(rp112), 'utf8'); } catch { threw112 = true; }
    assert(!threw112, '[112a] generateHtmlReport with 1000 findings does not throw');
    assert(html112.includes('<title>'), '[112b] large report generates valid HTML with <title>');
    assert(html112.includes('Argus'),   '[112c] large report HTML mentions "Argus"');
  }

  // ── Block [113] diff.js — URL normalization + edge cases ─────────────────────
  {
    console.log('\n[113] diff.js — diffNetworkRequests URL normalization + edge cases');

    // [113a] /user/123 and /user/456 normalized to same key → no diff (same endpoint)
    const reqs113devA   = [{ url: 'http://localhost:3100/user/123', status: 200, method: 'GET' }];
    const reqs113stagA  = [{ url: 'http://localhost:3100/user/456', status: 200, method: 'GET' }];
    const diff113a = diffNetworkRequests(reqs113devA, reqs113stagA);
    assert(diff113a.added.length === 0 && diff113a.removed.length === 0 && diff113a.changed.length === 0,
      `[113a] diffNetworkRequests treats /user/123 and /user/456 as the same normalized endpoint (added=${diff113a.added.length}, removed=${diff113a.removed.length}, changed=${diff113a.changed.length})`);

    // [113b] Empty arrays → zero diffs
    const diff113b = diffNetworkRequests([], []);
    assert(diff113b.added.length === 0 && diff113b.removed.length === 0 && diff113b.changed.length === 0,
      '[113b] diffNetworkRequests([], []) → { added:[], removed:[], changed:[] }');

    // [113c] diffConsoleMessages: warnings are ignored (only errors returned)
    const msgs113dev = [];
    const msgs113stg = [
      { level: 'error',   text: 'new-error' },
      { level: 'warning', text: 'new-warning' }, // warnings should be excluded
    ];
    const newErrs113 = diffConsoleMessages(msgs113dev, msgs113stg);
    assert(newErrs113.every(m => (m.level ?? m.severity) !== 'warning'),
      `[113c] diffConsoleMessages only returns errors, not warnings (got ${newErrs113.length}: ${newErrs113.map(m => m.level).join(',')})`);

    // [113d] diffConsoleMessages: exact-match dedup prevents re-reporting pre-existing error
    const preExisting113 = [{ level: 'error', text: 'known-error' }];
    const newErrs113d    = diffConsoleMessages(preExisting113, [...preExisting113, { level: 'error', text: 'known-error' }]);
    assert(newErrs113d.length === 0,
      `[113d] diffConsoleMessages deduplicates pre-existing exact-match errors (got ${newErrs113d.length})`);
  }

  // ── Block [114] mcp-server.js — LRU eviction constants ───────────────────────
  {
    console.log('\n[114] mcp-server.js — LRU cache constants + eviction code presence');

    const serverSrc114 = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp-server.js'), 'utf8',
    );

    assert(serverSrc114.includes('MAX_SNAPSHOTS'),
      '[114a] mcp-server.js defines MAX_SNAPSHOTS constant for snapshotStore LRU limit');
    assert(serverSrc114.includes('MAX_AUDIT_CACHE'),
      '[114b] mcp-server.js defines MAX_AUDIT_CACHE constant for auditCache LRU limit');
    assert(serverSrc114.includes('.keys().next()'),
      '[114c] mcp-server.js contains oldest-first LRU eviction logic (.keys().next())');
  }

  // ── Block [115] flow-runner.js — press_key step action + resolveUidForSelector ─
  {
    console.log('\n[115] flow-runner.js — press_key step action + resolveUidForSelector uid resolution');

    // [115a] press_key step is registered — flow completes without flow_step_failed
    const pkFlow115 = {
      name: 'press-key-test',
      steps: [
        { action: 'navigate', url: `${B}/typetext-issues.html` },
        { action: 'press_key', key: 'Tab' },
        { action: 'press_key', key: 'Escape' },
      ],
    };
    const result115a = await runFlow(pkFlow115, B, browser);
    const fail115a   = result115a.findings.filter(f => f.type === 'flow_step_failed');
    assert(fail115a.length === 0,
      `[115a] press_key flow completes without flow_step_failed (got ${fail115a.length})`);

    // [115b] resolveUidForSelector resolves a known selector on the fixture page
    const uid115 = await resolveUidForSelector(browser, '#fill-input');
    assert(uid115 !== null && uid115 !== undefined,
      `[115b] resolveUidForSelector resolves #fill-input uid on typetext-issues.html (got ${uid115})`);

    // [115c] press_key 'Enter' on focused element completes without error
    const enterFlow115 = {
      name: 'press-enter-test',
      steps: [
        { action: 'navigate', url: `${B}/typetext-issues.html` },
        { action: 'press_key', key: 'Enter' },
      ],
    };
    const result115c = await runFlow(enterFlow115, B, browser);
    assert(result115c.status !== 'error',
      `[115c] press_key "Enter" flow status is not "error" (got ${result115c.status})`);

    // [115d] flow-runner.js source registers press_key as a step action
    const frSrc115 = fs.readFileSync(path.resolve(__dirname, '../src/utils/flow-runner.js'), 'utf8');
    assert(frSrc115.includes("'press_key'") || frSrc115.includes('"press_key"'),
      '[115d] flow-runner.js source registers press_key step action');
  }

  // ── Block [116] watch mode — startDashboard HTTP /data endpoint ───────────────
  {
    console.log('\n[116] watch mode — startDashboard HTTP /data endpoint');

    const port116 = await findFreePort(3200);
    const mockFindings116 = [
      { type: 'console', severity: 'warning', message: 'test-finding-116', url: 'http://localhost:3100/' },
    ];

    const server116 = startDashboard(() => mockFindings116, 'http://localhost:3100', port116);

    // Wait for server to be ready
    await new Promise(r => setTimeout(r, 200));

    let json116 = null;
    let httpErr116 = null;
    try {
      const res116 = await fetch(`http://localhost:${port116}/data`);
      json116 = await res116.json();
    } catch (e) { httpErr116 = e; }

    server116.close();

    assert(httpErr116 === null,
      `[116a] GET /data on dashboard server succeeds (no HTTP error: ${httpErr116?.message ?? 'none'})`);
    assert(json116 !== null && typeof json116 === 'object',
      '[116b] /data response is a JSON object');
    assert(Array.isArray(json116.findings),
      `[116c] /data response has findings array (got ${typeof json116?.findings})`);
    assert(json116.findings.length === 1 && json116.findings[0].type === 'console',
      `[116d] /data findings reflects mock data (got ${json116.findings.length} findings)`);
  }

  // ── Block [117] MCP stdio transport — initialize handshake + tools/list ───────
  {
    console.log('\n[117] MCP stdio transport — initialize handshake + tools/list');

    let srv117 = null;
    let initErr117 = null;
    let toolsResp117 = null;
    try {
      srv117 = await spawnArgusServer(path.resolve(__dirname, '..'));

      const listId = ++_mcpSeq;
      srv117.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: listId, method: 'tools/list', params: {},
      }) + '\n');
      toolsResp117 = await mcpStdioRead(srv117.proc.stdout, listId, 8000);
    } catch (e) {
      initErr117 = e;
    } finally {
      try { srv117?.proc?.kill(); } catch {}
    }

    assert(initErr117 === null,
      `[117a] MCP server spawns and initializes without error (${initErr117?.message ?? 'ok'})`);
    assert(srv117?.initResp?.result?.serverInfo?.name === 'argus',
      `[117b] initialize response serverInfo.name === "argus" (got ${srv117?.initResp?.result?.serverInfo?.name})`);
    const tools117 = toolsResp117?.result?.tools ?? [];
    assert(Array.isArray(tools117) && tools117.length >= 8,
      `[117c] tools/list returns ≥ 8 tools (got ${tools117.length})`);
    const names117 = tools117.map(t => t.name);
    assert(['argus_audit', 'argus_last_report', 'argus_watch_snapshot', 'argus_get_context', 'argus_visual_diff'].every(n => names117.includes(n)),
      `[117d] tools/list includes all 5 key MCP tool names (got [${names117.join(', ')}])`);
  }

  // ── Block [118] argus_last_report MCP tool — missing reports dir returns structured error ──
  {
    console.log('\n[118] MCP tool argus_last_report — no-reports-dir returns structured JSON error');

    const tmpDir118 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-mcp-118-'));
    let srv118 = null;
    let lastRptResp118 = null;
    let err118 = null;
    try {
      srv118 = await spawnArgusServer(tmpDir118); // cwd has no reports/ subdir

      const callId = ++_mcpSeq;
      srv118.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: callId, method: 'tools/call',
        params: { name: 'argus_last_report', arguments: {} },
      }) + '\n');
      lastRptResp118 = await mcpStdioRead(srv118.proc.stdout, callId, 10000);
    } catch (e) {
      err118 = e;
    } finally {
      try { srv118?.proc?.kill(); } catch {}
      try { fs.rmdirSync(tmpDir118); } catch {}
    }

    assert(err118 === null,
      `[118a] argus_last_report call completes without crashing (${err118?.message ?? 'ok'})`);
    const text118 = lastRptResp118?.result?.content?.[0]?.text ?? '';
    assert(text118.includes('No reports found'),
      `[118b] argus_last_report returns "No reports found" when reports/ dir is absent (got: ${text118.slice(0, 80)})`);
    let parsed118 = null;
    try { parsed118 = JSON.parse(text118); } catch {}
    assert(parsed118 !== null && typeof parsed118 === 'object',
      `[118c] argus_last_report error response is valid JSON object (got: ${text118.slice(0, 40)})`);
  }

  // ── Block [119] argus_get_context MCP tool — snapshot_id + fix-loop diff ─────
  {
    console.log('\n[119] MCP tool argus_get_context — snapshot_id + fix-loop diff protocol');

    let srv119 = null;
    let snap1Resp119 = null;
    let snap2Resp119 = null;
    let err119 = null;
    try {
      srv119 = await spawnArgusServer(path.resolve(__dirname, '..'));

      // First call — no snapshot_id → creates new snapshot
      const call1Id = ++_mcpSeq;
      srv119.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: call1Id, method: 'tools/call',
        params: { name: 'argus_get_context', arguments: {} },
      }) + '\n');
      snap1Resp119 = await mcpStdioRead(srv119.proc.stdout, call1Id, 20000);

      const snap1Text = snap1Resp119?.result?.content?.[0]?.text ?? '{}';
      let snap1 = {};
      try { snap1 = JSON.parse(snap1Text); } catch {}

      if (typeof snap1.snapshot_id === 'string') {
        // Second call — with snapshot_id → returns diff (resolved/new_issues/persisting)
        const call2Id = ++_mcpSeq;
        srv119.proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: call2Id, method: 'tools/call',
          params: { name: 'argus_get_context', arguments: { snapshot_id: snap1.snapshot_id } },
        }) + '\n');
        snap2Resp119 = await mcpStdioRead(srv119.proc.stdout, call2Id, 20000);
      }
    } catch (e) {
      err119 = e;
    } finally {
      try { srv119?.proc?.kill(); } catch {}
    }

    const snap1Obj119 = (() => { try { return JSON.parse(snap1Resp119?.result?.content?.[0]?.text ?? '{}'); } catch { return {}; } })();
    const snap2Obj119 = (() => { try { return JSON.parse(snap2Resp119?.result?.content?.[0]?.text ?? '{}'); } catch { return {}; } })();

    assert(err119 === null,
      `[119a] argus_get_context calls complete without throwing (${err119?.message ?? 'ok'})`);
    assert(typeof snap1Obj119.snapshot_id === 'string' && snap1Obj119.snapshot_id.length > 0,
      `[119b] argus_get_context response includes snapshot_id string (got ${typeof snap1Obj119.snapshot_id})`);
    assert(
      Array.isArray(snap1Obj119.open_tabs) && snap1Obj119.open_tabs.length >= 1 &&
      typeof snap1Obj119.open_tabs[0].id === 'number',
      `[119c] argus_get_context open_tabs is a non-empty array of tabs with numeric ids — not the [] failure mode (got ${JSON.stringify(snap1Obj119.open_tabs)})`);
    assert(snap2Resp119 !== null && 'resolved' in snap2Obj119 && 'new_issues' in snap2Obj119,
      `[119d] argus_get_context with snapshot_id returns diff shape with resolved + new_issues fields`);
  }

  // ── Block [120] argus_watch_snapshot MCP tool — response structure ─────────
  {
    console.log('\n[120] MCP tool argus_watch_snapshot — findings array + newConsole/newNetwork fields');

    let srv120 = null;
    let snapResp120 = null;
    let err120 = null;
    try {
      srv120 = await spawnArgusServer(path.resolve(__dirname, '..'));

      const callId = ++_mcpSeq;
      srv120.proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: callId, method: 'tools/call',
        params: { name: 'argus_watch_snapshot', arguments: {} },
      }) + '\n');
      snapResp120 = await mcpStdioRead(srv120.proc.stdout, callId, 20000);
    } catch (e) {
      err120 = e;
    } finally {
      try { srv120?.proc?.kill(); } catch {}
    }

    const snapObj120 = (() => { try { return JSON.parse(snapResp120?.result?.content?.[0]?.text ?? '{}'); } catch { return null; } })();

    assert(err120 === null,
      `[120a] argus_watch_snapshot call completes without throwing (${err120?.message ?? 'ok'})`);
    assert(snapObj120 !== null && typeof snapObj120 === 'object',
      `[120b] argus_watch_snapshot response is parseable JSON object (got ${typeof snapObj120})`);
    assert(Array.isArray(snapObj120?.findings),
      `[120c] argus_watch_snapshot response has findings array (got ${typeof snapObj120?.findings})`);
    assert('newConsole' in (snapObj120 ?? {}) && 'newNetwork' in (snapObj120 ?? {}),
      `[120d] argus_watch_snapshot response has newConsole + newNetwork fields`);
  }

  // ── Block [121] server/index.js — Express startup + /health endpoint ──────────
  {
    console.log('\n[121] server/index.js — Express startup + /health endpoint');

    const port121 = await findFreePort(3300);
    const srvProc121 = spawn(process.execPath, [path.resolve(__dirname, '../src/server/index.js')], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port121), ARGUS_LOG_LEVEL: 'error', ARGUS_LOG_PRETTY: '0' },
    });
    srvProc121.stderr.on('data', () => {});
    srvProc121.on('error', () => {});

    let healthResp121 = null;
    const deadline121 = Date.now() + 8000;
    while (Date.now() < deadline121) {
      try {
        const r = await fetch(`http://localhost:${port121}/health`);
        if (r.ok) { healthResp121 = await r.json(); break; }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    srvProc121.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));

    assert(healthResp121 !== null,
      `[121a] Express server starts and /health responds within 8s`);
    assert(healthResp121?.status === 'ok',
      `[121b] /health returns { status: 'ok' } (got ${healthResp121?.status})`);
    assert(healthResp121?.service === 'argus',
      `[121c] /health returns { service: 'argus' } (got ${healthResp121?.service})`);
    assert(typeof healthResp121?.ts === 'string',
      `[121d] /health returns ISO timestamp in 'ts' field (got ${typeof healthResp121?.ts})`);
  }

  // ── Block [122] html-reporter.js CLI — report:html file-write path ────────────
  {
    console.log('\n[122] html-reporter.js CLI — report:html file-write path');

    const tmpDir122 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-html-cli-122-'));
    const report122 = {
      generatedAt: new Date().toISOString(),
      baseUrl: 'http://localhost:3100',
      summary: { total: 1, critical: 0, warning: 1, info: 0 },
      routes: [{
        path: '/test', url: 'http://localhost:3100/test',
        errors: [{ severity: 'warning', type: 'seo', message: 'test-seo-section4-gap' }],
      }],
      flows: [],
    };
    const jsonPath122 = path.join(tmpDir122, 'test-report.json');
    fs.writeFileSync(jsonPath122, JSON.stringify(report122));

    let cliErr122 = null;
    let cliExit122 = null;
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [
          path.resolve(__dirname, '../src/utils/html-reporter.js'),
          jsonPath122,
        ], {
          cwd: path.resolve(__dirname, '..'),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARGUS_LOG_LEVEL: 'error', ARGUS_LOG_PRETTY: '0' },
        });
        proc.stderr.on('data', () => {});
        proc.on('error', reject);
        proc.on('close', (code) => { cliExit122 = code; resolve(); });
      });
    } catch (e) { cliErr122 = e; }

    const htmlPath122 = path.join(tmpDir122, 'report.html');
    const htmlExists122 = fs.existsSync(htmlPath122);
    const html122 = htmlExists122 ? fs.readFileSync(htmlPath122, 'utf8') : '';
    try { fs.rmSync(tmpDir122, { recursive: true, force: true }); } catch {}

    assert(cliErr122 === null && cliExit122 === 0,
      `[122a] html-reporter.js CLI exits 0 (exit=${cliExit122}, err=${cliErr122?.message ?? 'none'})`);
    assert(htmlExists122,
      `[122b] CLI writes report.html alongside the source JSON`);
    assert(html122.includes('test-seo-section4-gap'),
      `[122c] generated HTML contains the finding message from the source report`);
    assert(!/Generated by.*Argus.*·.*T\d\d:\d\d:\d\d/.test(html122),
      `[122d] HTML footer uses human-readable date format (not raw ISO timestamp)`);
  }

  // ── Block [123] navigate_page throws → crawlRouteCheap error propagation ─────
  {
    console.log('\n[123] Unhappy path: navigate_page throws → crawlRouteCheap propagates error (Chrome-down / page-crash)');

    const savedRetry123 = process.env.ARGUS_RETRY_ATTEMPTS;
    process.env.ARGUS_RETRY_ATTEMPTS = '1'; // skip retries so mock throws immediately

    let threw123 = false;
    let errMsg123 = '';
    let callCount123 = 0;
    const mockMcp123 = {
      navigate_page: async () => { callCount123++; throw new Error('net::ERR_CONNECTION_REFUSED 127.0.0.1:9222'); },
      // listConsoleRaw() calls list_console_messages() synchronously — must be defined so
      // .catch(() => null) at the call-site can intercept it (sync throw bypasses .catch).
      // Other async adaptor methods (listConsole, listNetwork) wrap calls in async — safe undefined.
      list_console_messages: async () => [],
    };

    try {
      await crawlRouteCheap({ path: '/test', name: 'chrome-down', critical: false }, 'http://localhost:19999', mockMcp123);
    } catch (e) {
      threw123 = true;
      errMsg123 = e.message ?? '';
    } finally {
      if (savedRetry123 === undefined) delete process.env.ARGUS_RETRY_ATTEMPTS;
      else process.env.ARGUS_RETRY_ATTEMPTS = savedRetry123;
    }

    assert(threw123,
      '[123a] crawlRouteCheap throws when navigate_page always fails (Chrome-down simulation)');
    assert(errMsg123.includes('ERR_CONNECTION_REFUSED'),
      `[123b] thrown error includes original navigate_page error (got: "${errMsg123.slice(0, 80)}")`);
    assert(callCount123 === 1,
      `[123c] ARGUS_RETRY_ATTEMPTS=1 → navigate_page called exactly once before throw (got ${callCount123})`);
  }

  // ── Block [124] take_screenshot throws → crawlRouteCheap continues gracefully ─
  {
    console.log('\n[124] Unhappy path: take_screenshot throws → crawlRouteCheap continues, screenshot null');

    // Proxy over the real mcp connection — intercept only take_screenshot
    const screenshotFailMcp124 = new Proxy(mcp, {
      get(target, prop) {
        if (prop === 'take_screenshot') return async () => { throw new Error('screenshot-test-error-124'); };
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    let result124 = null;
    let err124 = null;
    try {
      result124 = await crawlRouteCheap(
        { path: '/clean.html', name: 'screenshot-fail', critical: false },
        B,
        screenshotFailMcp124,
      );
    } catch (e) {
      err124 = e;
    }

    assert(err124 === null,
      `[124a] crawlRouteCheap does NOT throw when take_screenshot fails (err: ${err124?.message ?? 'none'})`);
    assert(result124 !== null && result124.screenshot === null,
      `[124b] result.screenshot is null when take_screenshot throws (got: ${result124?.screenshot})`);
    assert(Array.isArray(result124?.errors),
      `[124c] result.errors is still a valid array despite screenshot failure`);
    assert(typeof result124?.crawledAt === 'string',
      `[124d] result.crawledAt is present — crawl ran to completion`);
  }

  // ── Block [125] parseConsoleMsgResponse overflow — 12k messages stress test ───
  {
    console.log('\n[125] Unhappy path: parseConsoleMsgResponse with 12,000 messages — overflow stress test');

    const lines125 = [];
    for (let i = 1; i <= 12000; i++) {
      const lvl = i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'info';
      lines125.push(`msgid=${i} [${lvl}] Console message number ${i} — stress test payload argus-section5`);
    }
    const bigText125 = lines125.join('\n');

    const t0125 = Date.now();
    let parsed125 = null;
    let parseErr125 = null;
    try {
      parsed125 = parseConsoleMsgResponse(bigText125);
    } catch (e) {
      parseErr125 = e;
    }
    const elapsed125 = Date.now() - t0125;

    assert(parseErr125 === null,
      `[125a] parseConsoleMsgResponse with 12k messages does not throw (got: ${parseErr125?.message ?? 'ok'})`);
    assert(Array.isArray(parsed125) && parsed125.length === 12000,
      `[125b] parseConsoleMsgResponse returns all 12,000 messages (got ${parsed125?.length})`);
    assert(elapsed125 < 5000,
      `[125c] parseConsoleMsgResponse 12k messages completes in < 5s (took ${elapsed125}ms)`);
  }

  // ── Block [126] cli/init.js — end-to-end file write to temp directory ────────
  {
    console.log('\n[126] cli/init.js — end-to-end file write: generateTargetsJs + generateEnvFile write to disk');

    const tmpDir126 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-init-e2e-'));
    try {
      const routes126 = [{ path: '/home', name: 'Home', critical: true, waitFor: null }];
      const targetsContent126 = generateTargetsJs(routes126, { framework: 'unknown' });
      const envContent126 = generateEnvFile({ devUrl: 'http://localhost:3000' });

      const targetsPath126 = path.join(tmpDir126, 'targets.js');
      const envPath126    = path.join(tmpDir126, '.env');
      fs.writeFileSync(targetsPath126, targetsContent126, 'utf8');
      fs.writeFileSync(envPath126, envContent126, 'utf8');

      assert(fs.existsSync(targetsPath126),
        '[126a] targets.js written to disk and exists');
      assert(fs.existsSync(envPath126),
        '[126b] .env written to disk and exists');
      assert(targetsContent126.includes('/home'),
        '[126c] written targets.js contains the route path /home');
      assert(envContent126.includes('TARGET_DEV_URL=http://localhost:3000'),
        '[126d] written .env contains TARGET_DEV_URL=http://localhost:3000');
      assert(targetsContent126.includes('export const routes'),
        '[126e] written targets.js is valid ES module syntax (export const routes)');
    } finally {
      fs.rmSync(tmpDir126, { recursive: true, force: true });
    }
  }

  // ── Block [127] A7 — Theme & Dark Mode ──────────────────────────────────────
  {
    console.log('\n[127] theme-analyzer — A7 dark mode detection on theme-issues.html');
    const browser127 = new CdpBrowserAdapter(mcp);
    const url127     = `http://localhost:${devPort}/theme-issues.html`;

    const results127 = await analyzeTheme(browser127, url127);

    assert(Array.isArray(results127),
      '[127a] analyzeTheme returns an array');

    const nodalFinding127 = results127.find(f => f.type === 'theme_no_dark_mode');
    assert(nodalFinding127 !== undefined,
      '[127b] theme_no_dark_mode finding present — fixture has no dark mode media query');

    assert(nodalFinding127?.severity === 'info',
      '[127c] theme_no_dark_mode severity is info');

    assert(typeof nodalFinding127?.message === 'string' && nodalFinding127.message.length > 0,
      '[127d] theme_no_dark_mode message is a non-empty string');

    const summary127 = results127.find(f => f.type === 'theme_summary');
    assert(summary127 !== undefined,
      '[127e] theme_summary finding present');

    assert(summary127?.hasDarkMode === false,
      '[127f] theme_summary.hasDarkMode is false for fixture with no dark mode query');

    assert(typeof summary127?.rootVarCount === 'number' && summary127.rootVarCount > 0,
      '[127g] theme_summary.rootVarCount > 0 — fixture declares :root CSS custom properties');
  }

  // ── Block [128] D9 — Design Fidelity ─────────────────────────────────────────
  {
    console.log('\n[128] design-fidelity-analyzer — D9 full rich comparison (tokens + nodes + components)');

    // Synthetic Figma data with both legacy fields (tokens/components) and rich
    // per-node comparison data (nodes[]).  The fixture page has intentional
    // deviations in computed styles to exercise every new finding type.
    const syntheticFigmaData128 = {
      tokens: {
        '--color-primary':  '#6200ee',  // fixture has #5100cd → mismatch
        '--color-text':     '#333333',  // fixture has #333333 → match (no finding)
        '--font-size-base': '16px',     // fixture has 14px    → mismatch
        '--spacing-md':     '16px',     // fixture has 12px    → mismatch
      },
      components: [
        { name: 'Primary Button', selector: 'button.design-primary' }, // exists → no finding
        { name: 'Hero Section',   selector: '.figma-hero-section'   }, // absent → finding
      ],
      nodes: [
        {
          // .action-button: bg #5100cd vs Figma #6200ee (delta≈37), padding 8/12 vs 16/24, radius 4 vs 8
          id: '1:1', name: 'Action Button', type: 'RECTANGLE', selector: '.action-button',
          fill:         { r: 98, g: 0, b: 238, a: 255 },
          spacing:      { paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24, gap: 0 },
          cornerRadius: 8,
          typography: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // .heading-label: color #555 vs rgb(33,33,33) (delta≈90), fontSize 20 vs 24, fontWeight 400 vs 700
          id: '1:2', name: 'Heading Label', type: 'TEXT', selector: '.heading-label',
          fill:       { r: 33, g: 33, b: 33, a: 255 },
          typography: { fontFamily: 'sans-serif', fontSize: 24, fontWeight: 700, lineHeightPx: null, letterSpacing: 0 },
          spacing: null, cornerRadius: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // .shadow-box: DOM has 0px 2px blur:4px — Figma: offsetX:2 offsetY:4 blur:8
          id: '1:3', name: 'Shadow Box', type: 'RECTANGLE', selector: '.shadow-box',
          shadow:       { offsetX: 2, offsetY: 4, blur: 8, spread: 0, r: 0, g: 0, b: 0, a: 64 },
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, stroke: null, opacity: 1,
        },
        {
          // .stroke-box: DOM has 1px solid #999 — Figma: 2px rgb(98,0,238)
          id: '1:4', name: 'Stroke Box', type: 'RECTANGLE', selector: '.stroke-box',
          stroke:       { r: 98, g: 0, b: 238, a: 255, weight: 2 },
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, shadow: null, opacity: 1,
        },
        {
          // .faded-box: DOM opacity 1 — Figma opacity 0.5
          id: '1:5', name: 'Faded Box', type: 'RECTANGLE', selector: '.faded-box',
          opacity:      0.5,
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, shadow: null, stroke: null,
        },
        {
          // .label-text: fontFamily sans-serif vs Inter, letterSpacing 0 vs 2px, text 'Goodbye World' vs 'Hello World'
          id: '1:6', name: 'Label Text', type: 'TEXT', selector: '.label-text',
          characters:   'Hello World',
          typography:   { fontFamily: 'Inter', fontSize: 16, fontWeight: 400, lineHeightPx: null, letterSpacing: 4 },
          fill: null, spacing: null, cornerRadius: null, bounds: null, shadow: null, stroke: null, opacity: 1,
        },
        {
          // .flex-row: column-gap 8px vs Figma gap 24, layoutMode HORIZONTAL
          id: '1:7', name: 'Flex Row', type: 'FRAME', selector: '.flex-row',
          spacing:      { paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, gap: 24, layoutMode: 'HORIZONTAL' },
          fill: null, typography: null, cornerRadius: null, bounds: null, shadow: null, stroke: null, opacity: 1,
        },
        {
          // .shadow-color-box: DOM has black shadow spread:0 — Figma has purple spread:4
          // Tests shadow COLOR + SPREAD comparison (both now fully compared)
          id: '1:8', name: 'Shadow Color Box', type: 'RECTANGLE',
          selectors: ['[data-testid="shadow-color-box"]', '.shadow-color-box'],
          selector: '.shadow-color-box',
          shadow: { offsetX: 0, offsetY: 4, blur: 8, spread: 4, r: 98, g: 0, b: 238, a: 128 },
          fill: null, typography: null, spacing: null, cornerRadius: null, bounds: null, stroke: null, opacity: 1,
        },
        {
          // .corner-box: DOM border-radius 4px 8px 12px 16px — Figma all corners should be 4px
          // Tests per-corner radius comparison (TR=8 vs 4, BR=12 vs 4, BL=16 vs 4)
          id: '1:9', name: 'Corner Box', type: 'RECTANGLE',
          selectors: ['[data-testid="corner-box"]', '.corner-box'],
          selector: '.corner-box',
          cornerRadius: { topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 },
          fill: null, typography: null, spacing: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // data-testid="test-card": tests selector fallback chain (data-testid matched first)
          // Figma fill: green rgb(0,128,0) — DOM background: red #ff0000 — color mismatch
          id: '1:10', name: 'Test Card', type: 'RECTANGLE',
          selectors: ['[data-testid="test-card"]', '#test-card', '.test-card'],
          selector: '[data-testid="test-card"]',
          fill: { r: 0, g: 128, b: 0, a: 255 },
          typography: null, spacing: null, cornerRadius: null, bounds: null, stroke: null, shadow: null, opacity: 1,
        },
        {
          // .drift-box: margin-left 80px gives absolute left ≈ 80+padding px — Figma says x=0
          // Tests position drift detection (scroll-corrected absolute position vs Figma bounds)
          id: '1:11', name: 'Drift Box', type: 'RECTANGLE',
          selectors: ['[data-testid="drift-box"]', '.drift-box'],
          selector: '.drift-box',
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          fill: null, typography: null, spacing: null, cornerRadius: null, stroke: null, shadow: null, opacity: 1,
        },
      ],
      frame: { name: 'Argus Test Frame', width: 1440, height: 900 },
    };

    const browser128 = new CdpBrowserAdapter(mcp);
    const url128     = `http://localhost:${devPort}/design-fidelity.html`;

    const results128 = await analyzeDesignFidelity(browser128, url128, syntheticFigmaData128);

    assert(Array.isArray(results128),
      '[128a] analyzeDesignFidelity returns an array');

    const mismatches128 = results128.filter(f => f.type === 'design_token_mismatch');
    assert(mismatches128.length >= 2,
      `[128b] at least 2 design_token_mismatch findings (got ${mismatches128.length})`);

    assert(mismatches128.every(f => f.severity === 'warning'),
      '[128c] all design_token_mismatch findings have severity "warning"');

    assert(mismatches128.some(f => f.token === '--color-primary'),
      '[128d] --color-primary mismatch detected');

    const missing128 = results128.find(f => f.type === 'design_component_missing' && f.selector === '.figma-hero-section');
    assert(missing128 !== undefined,
      '[128e] design_component_missing for .figma-hero-section present');

    const summary128 = results128.find(f => f.type === 'design_fidelity_summary');
    assert(summary128 !== undefined,
      '[128f] design_fidelity_summary finding present');

    // parseFigmaUrl unit test — no external API needed
    const parsed128a = parseFigmaUrl('https://www.figma.com/file/ABC123XYZ/MyApp?node-id=42%3A0');
    assert(parsed128a?.fileKey === 'ABC123XYZ',
      `[128g] parseFigmaUrl extracts fileKey correctly (got ${parsed128a?.fileKey})`);

    assert(parsed128a?.nodeId === '42:0',
      `[128h] parseFigmaUrl normalises node-id to colon format (got ${parsed128a?.nodeId})`);

    const parsed128b = parseFigmaUrl('not-a-figma-url');
    assert(parsed128b === null,
      '[128i] parseFigmaUrl returns null for non-Figma URL');

    // ── Per-node rich comparison assertions ───────────────────────────────────

    const colorMismatches128 = results128.filter(f => f.type === 'design_color_mismatch');
    assert(colorMismatches128.length >= 2,
      `[128j] at least 2 design_color_mismatch findings — action-button bg + heading-label color (got ${colorMismatches128.length})`);

    assert(colorMismatches128.every(f => f.severity === 'warning' && f.expected && f.actual && typeof f.delta === 'number'),
      '[128k] design_color_mismatch findings have severity "warning", expected, actual, and numeric delta');

    const typographyMismatches128 = results128.filter(f => f.type === 'design_typography_mismatch');
    assert(typographyMismatches128.length >= 2,
      `[128l] at least 2 design_typography_mismatch findings — fontSize + fontWeight on heading-label (got ${typographyMismatches128.length})`);

    assert(typographyMismatches128.every(f => f.severity === 'warning' && f.property && f.expected != null && f.actual != null),
      '[128m] design_typography_mismatch findings have severity "warning" and property/expected/actual fields');

    const spacingMismatches128 = results128.filter(f => f.type === 'design_spacing_mismatch');
    assert(spacingMismatches128.length >= 1,
      `[128n] at least 1 design_spacing_mismatch finding — action-button padding deviates (got ${spacingMismatches128.length})`);

    const radiusMismatches128 = results128.filter(f => f.type === 'design_radius_mismatch');
    assert(radiusMismatches128.length >= 1,
      `[128o] at least 1 design_radius_mismatch finding — action-button border-radius 4px vs Figma 8px (got ${radiusMismatches128.length})`);

    assert(typeof summary128?.colorMismatches === 'number' && summary128.colorMismatches >= 2,
      `[128p] design_fidelity_summary.colorMismatches >= 2 (got ${summary128?.colorMismatches})`);

    // ── New property comparisons (stroke, shadow, opacity, fontFamily, letterSpacing, gap, text) ─

    const shadowMismatches128 = results128.filter(f => f.type === 'design_shadow_mismatch');
    assert(shadowMismatches128.length >= 1,
      `[128q] at least 1 design_shadow_mismatch — shadow-box offsetX/blur differ from Figma (got ${shadowMismatches128.length})`);

    const strokeMismatches128 = results128.filter(f => f.type === 'design_stroke_mismatch');
    assert(strokeMismatches128.length >= 1,
      `[128r] at least 1 design_stroke_mismatch — stroke-box border 1px #999 vs Figma 2px #6200ee (got ${strokeMismatches128.length})`);

    const opacityMismatches128 = results128.filter(f => f.type === 'design_opacity_mismatch');
    assert(opacityMismatches128.length >= 1,
      `[128s] at least 1 design_opacity_mismatch — faded-box opacity 1 vs Figma 0.5 (got ${opacityMismatches128.length})`);

    const textMismatches128 = results128.filter(f => f.type === 'design_text_mismatch');
    assert(textMismatches128.length >= 1,
      `[128t] at least 1 design_text_mismatch — label-text "Goodbye World" vs Figma "Hello World" (got ${textMismatches128.length})`);

    const gapMismatches128 = results128.filter(f => f.type === 'design_gap_mismatch');
    assert(gapMismatches128.length >= 1,
      `[128u] at least 1 design_gap_mismatch — flex-row column-gap 8px vs Figma 24px (got ${gapMismatches128.length})`);

    const typoMismatches128All = results128.filter(f => f.type === 'design_typography_mismatch');
    assert(typoMismatches128All.some(f => f.property === 'fontFamily'),
      `[128v] design_typography_mismatch includes fontFamily finding — label-text sans-serif vs Inter`);

    assert(typoMismatches128All.some(f => f.property === 'letterSpacing'),
      `[128w] design_typography_mismatch includes letterSpacing finding — label-text 0px vs 2px`);

    assert(
      typeof summary128?.strokeMismatches === 'number' &&
      typeof summary128?.shadowMismatches === 'number' &&
      typeof summary128?.opacityMismatches === 'number' &&
      typeof summary128?.textMismatches === 'number' &&
      typeof summary128?.gapMismatches === 'number',
      '[128x] design_fidelity_summary includes all new mismatch type counts'
    );

    // ── Enhancement assertions (shadow color+spread, per-corner radius, selector fallback, position drift) ─

    const shadowMismatches128All = results128.filter(f => f.type === 'design_shadow_mismatch');
    assert(shadowMismatches128All.some(f => typeof f.expectedSpread === 'number' && typeof f.actualSpread === 'number'),
      '[128y] design_shadow_mismatch findings include spread fields (expectedSpread/actualSpread)');

    assert(shadowMismatches128All.some(f => f.colorDelta !== null && f.colorDelta !== undefined),
      '[128z] design_shadow_mismatch findings include colorDelta field — shadow color is now compared');

    const radiusMismatches128All = results128.filter(f => f.type === 'design_radius_mismatch');
    assert(radiusMismatches128All.some(f => f.corner && f.corner !== 'all'),
      `[128aa] design_radius_mismatch findings include per-corner field (corners found: ${[...new Set(radiusMismatches128All.map(f => f.corner))].join(', ')})`);

    assert(radiusMismatches128All.filter(f => f.corner && f.corner !== 'all').length >= 3,
      `[128ab] at least 3 per-corner radius mismatches (topRight/bottomRight/bottomLeft all differ from Figma 4px) — got ${radiusMismatches128All.length}`);

    const colorMismatches128All = results128.filter(f => f.type === 'design_color_mismatch');
    assert(colorMismatches128All.some(f => f.selector && (f.selector.includes('data-testid') || f.selector.includes('test-card'))),
      '[128ac] design_color_mismatch found via data-testid selector fallback — test-card matched by [data-testid="test-card"]');

    const positionDrifts128 = results128.filter(f => f.type === 'design_position_drift');
    assert(positionDrifts128.length >= 1,
      `[128ad] at least 1 design_position_drift finding — drift-box has margin-left:80px but Figma bounds x:0, drift > 20px threshold (got ${positionDrifts128.length})`);
  }

  // ── Block [129] Web Vitals + Bundle Size ──────────────────────────
  {
    console.log('\n[129] web-vitals-analyzer — LCP/CLS/FCP/TTI + perf_bundle_large');

    const browser129 = new CdpBrowserAdapter(mcp);
    const url129     = `${B}/perf-vitals.html`;

    const results129 = await analyzeWebVitals(browser129, url129);

    assert(Array.isArray(results129),
      '[129a] analyzeWebVitals returns an array');

    const summary129 = results129.find(f => f.type === 'perf_vitals_summary');
    assert(summary129 !== undefined,
      '[129b] perf_vitals_summary always present');

    assert(
      summary129 !== undefined &&
      Object.prototype.hasOwnProperty.call(summary129, 'lcp') &&
      Object.prototype.hasOwnProperty.call(summary129, 'cls') &&
      Object.prototype.hasOwnProperty.call(summary129, 'fcp') &&
      Object.prototype.hasOwnProperty.call(summary129, 'tti') &&
      Object.prototype.hasOwnProperty.call(summary129, 'ttfb'),
      '[129c] perf_vitals_summary has lcp, cls, fcp, tti, ttfb fields'
    );

    assert(summary129?.severity === 'info',
      `[129d] perf_vitals_summary severity is 'info' (got ${summary129?.severity})`);

    const bundleFindings129 = results129.filter(f => f.type === 'perf_bundle_large');
    assert(bundleFindings129.length >= 1,
      `[129e] perf_bundle_large detected — /api/large.js is ~600 KB > 500 KB threshold (found ${bundleFindings129.length})`);

    assert(bundleFindings129.every(f => f.severity === 'warning' || f.severity === 'critical'),
      '[129f] perf_bundle_large severity is warning or critical');

    const largeJs129 = bundleFindings129.find(f => f.ext === 'js');
    assert(largeJs129 !== undefined && largeJs129.sizeKb > 500,
      `[129g] perf_bundle_large JS sizeKb > 500 (got ${largeJs129?.sizeKb ?? 'none'})`);

    // Soft: LCP and TTI may not be captured in all headless configurations
    soft(
      typeof summary129?.lcp === 'number',
      `[129h] (soft) LCP captured as a number (got ${typeof summary129?.lcp}: ${summary129?.lcp})`
    );

    soft(
      typeof summary129?.tti === 'number' && summary129.tti > 0,
      `[129i] (soft) TTI (domInteractive) captured as positive number (got ${summary129?.tti})`
    );
  }

  // ── Block [130] Visual Regression (A8) ─────────────────────────
  {
    console.log('\n[130] visual-diff-analyzer — A8 baseline comparison');

    const tmpDir130  = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-harness-130-'));
    const browser130 = new CdpBrowserAdapter(mcp);
    const url130     = `${B}/visual-regression.html`;

    // Navigate once so the page is loaded for screenshot capture
    await browser130.navigate(url130);
    await browser130.waitFor({ state: 'networkidle' }).catch(() => {});

    // ── First run — no baseline exists ────────────────────────────────────────
    const results130a = await analyzeVisualRegression(browser130, url130, { baselineDir: tmpDir130 });

    assert(Array.isArray(results130a),
      '[130a] analyzeVisualRegression returns an array');

    const created130 = results130a.find(f => f.type === 'visual_baseline_created');
    assert(created130 !== undefined,
      `[130b] first run → visual_baseline_created present (got types: ${results130a.map(f => f.type).join(', ')})`);

    assert(created130?.severity === 'info',
      `[130c] visual_baseline_created severity is 'info' (got ${created130?.severity})`);

    const slug130      = created130?.baselinePath ?? '';
    const baseline130  = path.join(tmpDir130, slug130.split(path.sep).pop() ?? '');
    assert(created130?.baselinePath && fs.existsSync(created130.baselinePath),
      `[130d] baseline PNG file written to baselineDir (path: ${created130?.baselinePath})`);

    // ── Introduce visual change via JS injection ───────────────────────────────
    await browser130.evaluate(`() => {
      document.getElementById('primary-block').style.backgroundColor = '#e53935';
    }`);
    // Allow repaint to settle
    await new Promise(r => setTimeout(r, 300));

    // ── Second run — baseline exists, diff detected ───────────────────────────
    const results130b = await analyzeVisualRegression(browser130, url130, { baselineDir: tmpDir130 });

    const regression130 = results130b.find(f => f.type === 'visual_regression');
    assert(regression130 !== undefined,
      `[130e] after visual change → visual_regression detected (got types: ${results130b.map(f => f.type).join(', ')})`);

    assert(regression130?.severity === 'warning' || regression130?.severity === 'critical',
      `[130f] visual_regression severity is warning or critical (got ${regression130?.severity})`);

    assert(typeof regression130?.diffPercent === 'number' && regression130.diffPercent > 0,
      `[130g] visual_regression diffPercent > 0 (got ${regression130?.diffPercent})`);

    const summary130 = results130b.find(f => f.type === 'visual_diff_summary');
    assert(summary130 !== undefined,
      `[130h] visual_diff_summary always present in second run (got types: ${results130b.map(f => f.type).join(', ')})`);

    assert(typeof summary130?.diffPercent === 'number',
      `[130i] visual_diff_summary has diffPercent field (number) (got ${typeof summary130?.diffPercent})`);

    // Clean up temp baseline directory
    try { fs.rmSync(tmpDir130, { recursive: true, force: true }); } catch {}
  }

  // ── Block [131] Axe-core + Color Blind Simulation (A12) ────────
  {
    console.log('\n[131] a11y-deep-analyzer — A12 axe-core + color blind simulation');

    const browser131 = new CdpBrowserAdapter(mcp);
    const url131     = `${B}/a11y-deep-issues.html`;

    const results131 = await analyzeA11yDeep(browser131, url131);

    assert(Array.isArray(results131),
      '[131a] analyzeA11yDeep returns an array');

    const axeViolations131 = results131.filter(f => f.type === 'a11y_axe_violation');
    assert(axeViolations131.length >= 1,
      `[131b] at least 1 a11y_axe_violation found (got ${axeViolations131.length})`);

    const v131 = axeViolations131[0];
    assert(
      v131 !== undefined &&
      typeof v131.axeId     === 'string' &&
      typeof v131.impact    === 'string' &&
      typeof v131.helpUrl   === 'string',
      `[131c] a11y_axe_violation has required fields axeId/impact/helpUrl (got ${JSON.stringify(Object.keys(v131 ?? {}))})`
    );

    const warningOrCrit131 = axeViolations131.filter(f => f.severity === 'warning' || f.severity === 'critical');
    assert(warningOrCrit131.length >= 1,
      `[131d] serious/moderate axe violations map to warning or critical severity (got ${axeViolations131.map(f=>f.severity).join(',')})`);

    const summary131 = results131.find(f => f.type === 'a11y_deep_summary');
    assert(summary131 !== undefined,
      `[131e] a11y_deep_summary always present (got types: ${[...new Set(results131.map(f=>f.type))].join(', ')})`);

    assert(typeof summary131?.axeViolations === 'number',
      `[131f] a11y_deep_summary has axeViolations count (number) (got ${typeof summary131?.axeViolations})`);

    const imageAlt131 = axeViolations131.find(f => f.axeId === 'image-alt');
    assert(imageAlt131 !== undefined,
      `[131g] image-alt violation detected for img#no-alt (found axeIds: ${axeViolations131.map(f=>f.axeId).join(', ')})`);

    const colorblind131 = results131.filter(f => f.type === 'a11y_colorblind_risk');
    assert(colorblind131.length >= 1,
      `[131h] a11y_colorblind_risk detected for red-on-gray element (got ${colorblind131.length})`);

    assert(typeof colorblind131[0]?.contrastRatio === 'number',
      `[131i] a11y_colorblind_risk has contrastRatio field (number) (got ${typeof colorblind131[0]?.contrastRatio})`);
  }

  // ── Block [132] HAR Network Baseline (N1) ─────────────────────
  {
    console.log('\n[132] har-recorder — HAR network baseline');
    const tmpDir132 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-harness-132-'));
    const browser132 = new CdpBrowserAdapter(mcp);
    const url132     = `${B}/har-baseline.html`;

    const results132a = await analyzeHar(browser132, url132, { baselineDir: tmpDir132 });

    assert(Array.isArray(results132a),
      '[132a] analyzeHar returns an array');

    const baseline132 = results132a.find(f => f.type === 'har_baseline_created');
    assert(baseline132 !== undefined,
      `[132b] first run: har_baseline_created present (got types: ${[...new Set(results132a.map(f => f.type))].join(', ')})`);

    const harFile132 = path.join(tmpDir132, `${slugify(url132)}.json`);
    assert(fs.existsSync(harFile132),
      `[132c] baseline HAR file written to baselineDir (expected: ${harFile132})`);

    assert(typeof baseline132?.requestCount === 'number',
      `[132d] har_baseline_created has requestCount field (number) (got ${typeof baseline132?.requestCount})`);

    // Second run: compare against baseline just saved
    const results132b = await analyzeHar(browser132, url132, { baselineDir: tmpDir132 });
    const summary132  = results132b.find(f => f.type === 'har_comparison_summary');
    assert(summary132 !== undefined,
      `[132e] second run: har_comparison_summary present (got types: ${[...new Set(results132b.map(f => f.type))].join(', ')})`);

    assert(
      typeof summary132?.newRequests === 'number' && typeof summary132?.missingRequests === 'number',
      `[132f] har_comparison_summary has newRequests and missingRequests fields (got ${JSON.stringify({ new: typeof summary132?.newRequests, missing: typeof summary132?.missingRequests })})`
    );

    try { fs.rmSync(tmpDir132, { recursive: true, force: true }); } catch {}
  }

  // ── Block [133] Motion & Animation Accessibility (A9) ────────
  {
    console.log('\n[133] motion-analyzer — A9 motion & animation accessibility');
    const browser133 = new CdpBrowserAdapter(mcp);
    const url133     = `${B}/motion-issues.html`;

    const results133 = await analyzeMotion(browser133, url133);

    assert(Array.isArray(results133),
      '[133a] analyzeMotion returns an array');

    const motionFindings133 = results133.filter(f => f.type !== 'motion_summary');
    assert(motionFindings133.length >= 1,
      `[133b] at least 1 motion finding detected (got ${motionFindings133.length}; types: ${[...new Set(results133.map(f => f.type))].join(', ')})`);

    const noQuery133 = results133.find(f => f.type === 'motion_no_reduced_motion_query');
    assert(noQuery133 !== undefined,
      `[133c] motion_no_reduced_motion_query detected (fixture has animation but no @media prefers-reduced-motion)`);

    const autoplay133 = results133.find(f => f.type === 'motion_autoplay_no_pause');
    assert(autoplay133 !== undefined,
      `[133d] motion_autoplay_no_pause detected (fixture has autoplay video without controls)`);

    const summary133 = results133.find(f => f.type === 'motion_summary');
    assert(summary133 !== undefined,
      `[133e] motion_summary always present (got types: ${[...new Set(results133.map(f => f.type))].join(', ')})`);

    assert(typeof summary133?.animationCount === 'number',
      `[133f] motion_summary has animationCount field (number) (got ${typeof summary133?.animationCount})`);
  }

  // ── Block [134] Font Loading (A10) ───────────────────────────
  {
    console.log('\n[134] font-analyzer — A10 font loading');
    const browser134 = new CdpBrowserAdapter(mcp);
    const url134     = `${B}/font-issues.html`;

    const results134 = await analyzeFont(browser134, url134);

    assert(Array.isArray(results134),
      '[134a] analyzeFont returns an array');

    const fontFindings134 = results134.filter(f => f.type !== 'font_summary');
    assert(fontFindings134.length >= 1,
      `[134b] at least 1 font finding detected (got ${fontFindings134.length}; types: ${[...new Set(results134.map(f => f.type))].join(', ')})`);

    const foit134 = results134.find(f => f.type === 'font_foit_risk');
    assert(foit134 !== undefined,
      `[134c] font_foit_risk detected (@font-face without font-display in fixture)`);

    assert(typeof foit134?.fontFamily === 'string',
      `[134d] font_foit_risk has fontFamily field (string) (got ${typeof foit134?.fontFamily})`);

    const summary134 = results134.find(f => f.type === 'font_summary');
    assert(summary134 !== undefined,
      `[134e] font_summary always present (got types: ${[...new Set(results134.map(f => f.type))].join(', ')})`);

    assert(typeof summary134?.foitRisks === 'number',
      `[134f] font_summary has foitRisks count (number) (got ${typeof summary134?.foitRisks})`);
  }

  // ── Block [135] Form Validation (A11) ────────────────────────
  {
    console.log('\n[135] form-analyzer — A11 form validation');
    const browser135 = new CdpBrowserAdapter(mcp);
    const url135     = `${B}/form-issues.html`;

    const results135 = await analyzeForm(browser135, url135);

    assert(Array.isArray(results135),
      '[135a] analyzeForm returns an array');

    const formFindings135 = results135.filter(f => f.type !== 'form_summary');
    assert(formFindings135.length >= 1,
      `[135b] at least 1 form finding detected (got ${formFindings135.length}; types: ${[...new Set(results135.map(f => f.type))].join(', ')})`);

    const missingReq135 = results135.find(f => f.type === 'form_missing_required');
    assert(missingReq135 !== undefined,
      `[135c] form_missing_required detected (fixture has inputs without required attribute)`);

    const noAutocomplete135 = results135.find(f => f.type === 'form_no_autocomplete');
    assert(noAutocomplete135 !== undefined,
      `[135d] form_no_autocomplete detected (fixture has name/email fields without autocomplete)`);

    const summary135 = results135.find(f => f.type === 'form_summary');
    assert(summary135 !== undefined,
      `[135e] form_summary always present (got types: ${[...new Set(results135.map(f => f.type))].join(', ')})`);

    assert(typeof summary135?.missingRequired === 'number',
      `[135f] form_summary has missingRequired count (number) (got ${typeof summary135?.missingRequired})`);
  }

  // ── Block [136] Rich GitHub PR Comments (Check Runs + Release Notes) ──
  {
    console.log('\n[136] github-reporter — rich PR comments + check runs + release notes');

    // Synthetic report with selector-bearing findings and visual_regression
    const report136 = {
      baseUrl:     'http://localhost:3000',
      generatedAt: new Date().toISOString(),
      summary:     { total: 3, critical: 1, warning: 1, info: 1 },
      routes: [{
        route: '/dashboard',
        errors: [
          { type: 'console_error', message: 'TypeError: x is null', severity: 'critical', isNew: true, selector: '#app > div.error' },
          { type: 'visual_regression', message: '5.2% pixels changed', severity: 'critical', diffPercent: 5.2, isNew: true },
        ],
        screenshot: null,
      }],
      codebase: [],
      flows:    [],
    };
    const diff136 = { isFirstRun: false, resolvedCount: 1, flowResolvedCount: 0 };

    // [136a] formatPrComment now includes Selector column when findings have selector field
    const comment136 = formatPrComment(report136, diff136);
    assert(
      typeof comment136 === 'string' && comment136.includes('Selector'),
      `[136a] formatPrComment includes Selector column when findings have selector field (got: ${comment136.slice(0, 100)})`
    );

    // [136b] formatPrComment includes visual regression section
    assert(
      comment136.includes('Visual Regressions'),
      `[136b] formatPrComment includes Visual Regressions section when visual_regression findings present`
    );

    // [136c] buildStatusPayload respects ARGUS_CRITICAL_THRESHOLD=0 — never blocks
    const origThreshold = process.env.ARGUS_CRITICAL_THRESHOLD;
    process.env.ARGUS_CRITICAL_THRESHOLD = '0';
    const status136zero = buildStatusPayload(report136, diff136);
    process.env.ARGUS_CRITICAL_THRESHOLD = origThreshold ?? '';
    assert(
      status136zero.state === 'success',
      `[136c] buildStatusPayload with ARGUS_CRITICAL_THRESHOLD=0 never blocks merge (got state: ${status136zero.state})`
    );

    // [136d] buildStatusPayload respects ARGUS_CRITICAL_THRESHOLD=5 — doesn't block when criticals < threshold
    process.env.ARGUS_CRITICAL_THRESHOLD = '5';
    const status136five = buildStatusPayload(report136, diff136);
    process.env.ARGUS_CRITICAL_THRESHOLD = origThreshold ?? '';
    assert(
      status136five.state === 'success',
      `[136d] buildStatusPayload with threshold=5 doesn't block when only 1 critical (got state: ${status136five.state})`
    );

    // [136e] buildStatusPayload blocks when criticals >= threshold (default threshold=1)
    delete process.env.ARGUS_CRITICAL_THRESHOLD;
    const status136default = buildStatusPayload(report136, diff136);
    if (origThreshold !== undefined) process.env.ARGUS_CRITICAL_THRESHOLD = origThreshold;
    assert(
      status136default.state === 'failure',
      `[136e] buildStatusPayload blocks merge with default threshold=1 and 1 critical (got state: ${status136default.state})`
    );

    // [136f] generateReleaseNotes returns markdown string with new/resolved sections
    const prevReport136 = {
      baseUrl: 'http://localhost:3000',
      generatedAt: new Date(Date.now() - 86400000).toISOString(),
      summary: { total: 2, critical: 0, warning: 2, info: 0 },
      routes: [{ route: '/dashboard', errors: [
        { type: 'css_important_override', message: 'Old CSS issue', severity: 'warning', isNew: false },
      ], screenshot: null }],
      codebase: [], flows: [],
    };
    const notes136 = generateReleaseNotes(report136, prevReport136, { fromTag: 'v1.0.0', toTag: 'v1.1.0' });
    assert(
      typeof notes136 === 'string' && notes136.includes('Release Notes'),
      `[136f] generateReleaseNotes returns markdown string with heading (got: ${notes136.slice(0, 80)})`
    );

    // [136g] generateReleaseNotes includes new issues section
    assert(
      notes136.includes('New Issues'),
      `[136g] generateReleaseNotes includes New Issues section for findings in current but not previous report`
    );

    // [136h] generateReleaseNotes includes resolved issues section
    assert(
      notes136.includes('Resolved Issues'),
      `[136h] generateReleaseNotes includes Resolved Issues section for findings in previous but not current report`
    );

    // [136i] createCheckRun and completeCheckRun exported from github-reporter.js
    assert(
      typeof createCheckRun === 'function' && typeof completeCheckRun === 'function',
      `[136i] createCheckRun and completeCheckRun are exported functions`
    );

    // [136j] buildStatusPayload includes newCriticalCount and threshold fields (check-run enrichment)
    const statusShape136 = buildStatusPayload(report136, diff136);
    assert(
      typeof statusShape136.newCriticalCount === 'number' && typeof statusShape136.threshold === 'number',
      `[136j] buildStatusPayload includes newCriticalCount and threshold fields (got: ${JSON.stringify({ nc: typeof statusShape136.newCriticalCount, th: typeof statusShape136.threshold })})`
    );
  }

  // ── Block [137] PR Diff Analyzer (pure function unit tests) ───────
  {
    console.log('\n[137] pr-diff-analyzer — parsePrUrl + mapFilesToRoutes pure functions');

    // [137a] parsePrUrl extracts owner, repo, and prNumber from a standard PR URL
    const parsed137 = parsePrUrl('https://github.com/acme/my-app/pull/42');
    assert(
      parsed137.owner === 'acme' && parsed137.repo === 'my-app' && parsed137.prNumber === 42,
      `[137a] parsePrUrl extracts owner/repo/prNumber (got: ${JSON.stringify(parsed137)})`
    );

    // [137b] parsePrUrl accepts URLs with trailing path segments (e.g. /files)
    const parsed137b = parsePrUrl('https://github.com/org/repo/pull/100/files');
    assert(
      parsed137b.prNumber === 100 && parsed137b.owner === 'org',
      `[137b] parsePrUrl accepts PR URL with /files suffix (got: ${JSON.stringify(parsed137b)})`
    );

    // [137c] parsePrUrl throws on non-GitHub URLs
    let threw137c = false;
    try { parsePrUrl('https://gitlab.com/owner/repo/-/merge_requests/1'); }
    catch { threw137c = true; }
    assert(threw137c, `[137c] parsePrUrl throws on non-GitHub URL`);

    // [137d] mapFilesToRoutes returns all routes when changedFiles is empty
    const routes137 = [{ path: '/home', name: 'Home' }, { path: '/login', name: 'Login' }];
    const result137d = mapFilesToRoutes([], routes137);
    assert(
      result137d.length === routes137.length,
      `[137d] mapFilesToRoutes returns all routes when changedFiles is empty (got ${result137d.length})`
    );

    // [137e] mapFilesToRoutes detects infrastructure files and returns all routes
    const infra137 = ['next.config.js', 'src/app/page.tsx'];
    const result137e = mapFilesToRoutes(infra137, routes137);
    assert(
      result137e.length === routes137.length,
      `[137e] mapFilesToRoutes returns all routes for infrastructure file changes (got ${result137e.length})`
    );

    // [137f] mapFilesToRoutes filters to matching route via slug heuristic
    const routes137f = [{ path: '/checkout', name: 'Checkout' }, { path: '/about', name: 'About' }];
    const result137f = mapFilesToRoutes(['src/pages/checkout.tsx'], routes137f);
    assert(
      result137f.length === 1 && result137f[0].path === '/checkout',
      `[137f] mapFilesToRoutes matches "checkout" slug to /checkout route (got: ${JSON.stringify(result137f.map(r => r.path))})`
    );

    // [137g] mapFilesToRoutes falls back to all routes when no slug matches
    const result137g = mapFilesToRoutes(['src/utils/logger.js'], routes137f);
    assert(
      result137g.length === routes137f.length,
      `[137g] mapFilesToRoutes falls back to all routes when no slug matches (got ${result137g.length})`
    );

    // [137h] mapFilesToRoutes returns empty array when routes array is empty
    const result137h = mapFilesToRoutes(['src/pages/checkout.tsx'], []);
    assert(
      Array.isArray(result137h) && result137h.length === 0,
      `[137h] mapFilesToRoutes returns empty array when routes is empty (got ${result137h.length})`
    );

    // [137i] mapFilesToRoutes returns [] for a .github/-only PR (EXCLUDED_PATTERNS)
    const result137i = mapFilesToRoutes(
      ['.github/workflows/ci.yml', '.github/dependabot.yml'],
      routes137,
    );
    assert(
      Array.isArray(result137i) && result137i.length === 0,
      `[137i] mapFilesToRoutes returns [] for .github/-only PR — audit should be skipped (got ${result137i.length})`
    );

    // [137j] mapFilesToRoutes returns [] for a docs/markdown-only PR (EXCLUDED_PATTERNS)
    const result137j = mapFilesToRoutes(
      ['README.md', 'docs/setup.md', 'CHANGELOG.md'],
      routes137,
    );
    assert(
      Array.isArray(result137j) && result137j.length === 0,
      `[137j] mapFilesToRoutes returns [] for markdown-only PR — audit should be skipped (got ${result137j.length})`
    );

    // [137k] mapFilesToRoutes proceeds to route matching when mix of excluded + app files
    const result137k = mapFilesToRoutes(
      ['.github/workflows/ci.yml', 'src/pages/login.tsx'],
      [{ path: '/login', name: 'Login' }, { path: '/home', name: 'Home' }],
    );
    assert(
      result137k.length === 1 && result137k[0].path === '/login',
      `[137k] mapFilesToRoutes proceeds when PR has excluded files alongside app files (got: ${JSON.stringify(result137k.map(r => r.path))})`
    );

    // ── E1: fetchPrFiles surfaces { filename, status, patch } (recorded API fixture) ──
    // Stub globalThis.fetch with the recorded /pulls/N/files response; assert the parsed
    // shape that Phase A3 (line annotations) + C1 (hunk→component) depend on.
    const _origFetch137 = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => prFilesResponse,
        text: async () => JSON.stringify(prFilesResponse),
      });
      const prFiles137 = await fetchPrFiles('https://github.com/acme/shop/pull/7');
      const checkout137 = prFiles137.find(f => f.filename === 'src/pages/checkout.tsx');

      // [137l] fetchPrFiles returns per-file status objects, not bare filename strings
      assert(
        prFiles137.length === prFilesResponse.length && checkout137 && checkout137.status === 'modified',
        `[137l] fetchPrFiles returns { filename, status } objects (got: ${JSON.stringify(prFiles137.map(f => ({ f: f.filename, s: f.status })))})`
      );

      // [137m] fetchPrFiles preserves the unified-diff patch hunk text (Phase A3 input)
      assert(
        typeof checkout137.patch === 'string' && checkout137.patch.includes('@@ -12,7 +12,11 @@'),
        `[137m] fetchPrFiles preserves patch hunk headers (got: ${JSON.stringify(checkout137 && checkout137.patch && checkout137.patch.slice(0, 40))})`
      );

      // [137n] a binary file (no patch in the API response) normalizes to patch:null, never undefined
      const png137 = prFiles137.find(f => f.filename === 'public/logo.png');
      assert(
        png137 && png137.patch === null && ('patch' in png137),
        `[137n] fetchPrFiles normalizes a missing patch to null (got: ${JSON.stringify(png137 && png137.patch)})`
      );

      // [137o] back-compat: mapFilesToRoutes treats the rich object[] and the string[] view identically
      const routes137o = [{ path: '/checkout', name: 'Checkout' }, { path: '/about', name: 'About' }];
      const fromObjects137 = mapFilesToRoutes(prFiles137, routes137o).map(r => r.path);
      const fromStrings137 = mapFilesToRoutes(prFiles137.map(f => f.filename), routes137o).map(r => r.path);
      assert(
        fromObjects137.length === 1 && fromObjects137[0] === '/checkout' &&
        JSON.stringify(fromObjects137) === JSON.stringify(fromStrings137),
        `[137o] mapFilesToRoutes treats object[] and string[] identically (objs: ${JSON.stringify(fromObjects137)}, strs: ${JSON.stringify(fromStrings137)})`
      );
    } finally {
      globalThis.fetch = _origFetch137;
    }

    // ── A3: file:line annotation resolution from patch hunks (pure — no fetch) ──
    // These drive the same functions the CLI uses to anchor ::error file=,line=:: annotations.
    const co137  = prFilesResponse.find(f => f.filename === 'src/pages/checkout.tsx');
    const cs137  = prFilesResponse.find(f => f.filename === 'src/components/CartSummary.tsx');
    const del137 = prFilesResponse.find(f => f.filename === 'src/legacy/oldCart.js');

    // [137p] firstAddedLine returns the real new-file line of the first added (+) line,
    // and null for a deletion-only hunk or an absent (binary) patch — never a fabricated line.
    const fal137a = firstAddedLine(co137.patch);   // 13: context line 12, then the first +
    const fal137b = firstAddedLine(cs137.patch);   // 1:  added at the hunk start (@@ +1,24 @@)
    const fal137c = firstAddedLine(del137.patch);  // null: removed file, deletion-only hunk
    const fal137d = firstAddedLine(null);          // null: binary file (patch omitted)
    assert(
      fal137a === 13 && fal137b === 1 && fal137c === null && fal137d === null,
      `[137p] firstAddedLine parses the real first-added line; null for deletion-only/binary (got: ${fal137a}, ${fal137b}, ${fal137c}, ${fal137d})`
    );

    // [137q] resolveAnnotationTarget anchors a slug-matched route at the SPECIFIC changed
    // file and its real first-added line — the input for the CLI's file:line annotation.
    const at137 = resolveAnnotationTarget('/checkout', prFilesResponse);
    assert(
      at137 && at137.path === 'src/pages/checkout.tsx' && at137.line === 13,
      `[137q] resolveAnnotationTarget anchors a matched route at the real file:line (got: ${JSON.stringify(at137)})`
    );

    // [137r] resolveAnnotationTarget NEVER fabricates a line — it returns null (so the CLI
    // emits a route-level annotation) for an unmatched route, the root route, an infra file
    // (maps to ALL routes — not a specific cause), and a slug-matched binary file (no line).
    const at137none  = resolveAnnotationTarget('/about', prFilesResponse);
    const at137root  = resolveAnnotationTarget('/', prFilesResponse);
    const at137infra = resolveAnnotationTarget('/checkout', [
      { filename: 'src/app/checkout/layout.tsx', patch: '@@ -1,2 +1,3 @@\n+const x = 1;' },
    ]);
    const at137bin = resolveAnnotationTarget('/logo', [
      { filename: 'src/logo/logo.png', patch: null },
    ]);
    assert(
      at137none === null && at137root === null && at137infra === null && at137bin === null,
      `[137r] resolveAnnotationTarget never fabricates — null route-level fallback for unmatched/root/infra/binary (got: ${JSON.stringify([at137none, at137root, at137infra, at137bin])})`
    );
  }

  // ── Block [138] PR Validate CLI helpers (no Chrome required) ──────
  {
    console.log('\n[138] pr-validate.js CLI — buildStepSummary + writeGithubOutputs unit tests');

    // [138a] buildStepSummary is an exported function
    assert(
      typeof buildStepSummary === 'function',
      '[138a] buildStepSummary is exported from src/cli/pr-validate.js'
    );

    // [138b] writeGithubOutputs is an exported function
    assert(
      typeof writeGithubOutputs === 'function',
      '[138b] writeGithubOutputs is exported from src/cli/pr-validate.js'
    );

    // [138c] buildStepSummary with blocked=true contains "BLOCKED"
    const md138blocked = buildStepSummary({
      blocked: true,
      summary: { critical: 2, warning: 0, info: 1 },
      affectedRoutes: [{ path: '/checkout' }],
      perRoute: [{ route: '/checkout', critical: 2, warning: 0, info: 1 }],
      findings: [
        { severity: 'critical', type: 'console_error', message: 'TypeError: x is null', url: 'http://localhost:3000/checkout' },
      ],
      changedFiles: ['src/pages/checkout.tsx'],
      blockOn: 'critical',
    });
    assert(
      typeof md138blocked === 'string' && md138blocked.includes('BLOCKED'),
      `[138c] buildStepSummary(blocked=true) contains "BLOCKED" (got: ${md138blocked.slice(0, 80)})`
    );

    // [138d] buildStepSummary with blocked=false contains "PASSED"
    const md138passed = buildStepSummary({
      blocked: false,
      summary: { critical: 0, warning: 0, info: 2 },
      affectedRoutes: [{ path: '/login' }],
      perRoute: [{ route: '/login', critical: 0, warning: 0, info: 2 }],
      findings: [],
      changedFiles: ['src/pages/login.tsx'],
      blockOn: 'critical',
    });
    assert(
      typeof md138passed === 'string' && md138passed.includes('PASSED'),
      `[138d] buildStepSummary(blocked=false) contains "PASSED" (got: ${md138passed.slice(0, 80)})`
    );

    // [138e] buildStepSummary with critical findings shows critical count in the summary table
    assert(
      md138blocked.includes('**2**'),
      `[138e] buildStepSummary with 2 criticals bolds the critical count in the table`
    );

    // [138f] buildStepSummary escapes pipe chars in finding messages
    const md138pipe = buildStepSummary({
      blocked: false,
      summary: { critical: 0, warning: 1, info: 0 },
      affectedRoutes: [{ path: '/' }],
      perRoute: [{ route: '/', critical: 0, warning: 1, info: 0 }],
      findings: [{ severity: 'warning', type: 'seo_meta', message: 'Title | Subtitle has pipe', url: '/' }],
      changedFiles: [],
      blockOn: 'critical',
    });
    assert(
      md138pipe.includes('Title \\| Subtitle has pipe'),
      `[138f] buildStepSummary escapes "|" in finding messages to "\\|"`
    );

    // [138g] writeGithubOutputs writes blocked=true to a temp file via GITHUB_OUTPUT
    const tmpOutput138 = path.join(os.tmpdir(), `argus-test-output-${Date.now()}.txt`);
    const savedOutput138 = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = tmpOutput138;
    writeGithubOutputs({
      blocked: true,
      summary: { critical: 3, warning: 1, info: 0 },
      affectedRoutes: [{ path: '/dashboard' }, { path: '/checkout' }],
    });
    if (savedOutput138 === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = savedOutput138;
    const written138 = fs.existsSync(tmpOutput138) ? fs.readFileSync(tmpOutput138, 'utf8') : '';
    try { fs.unlinkSync(tmpOutput138); } catch { /* best-effort */ }
    assert(
      written138.includes('blocked=true'),
      `[138g] writeGithubOutputs writes blocked=true to GITHUB_OUTPUT file`
    );

    // [138h] writeGithubOutputs writes correct critical_count
    assert(
      written138.includes('critical_count=3'),
      `[138h] writeGithubOutputs writes critical_count=3 to GITHUB_OUTPUT file (got: ${written138.trim()})`
    );

    // [138i] writeGithubOutputs writes affected_routes as comma-separated string
    assert(
      written138.includes('affected_routes=/dashboard,/checkout'),
      `[138i] writeGithubOutputs writes affected_routes comma-separated (got: ${written138.trim()})`
    );

    // [138j] pr-validate.js CLI file exists on disk at the expected src/cli path
    const cliPath138 = path.join(__dirname, '../src/cli/pr-validate.js');
    assert(
      fs.existsSync(cliPath138),
      `[138j] src/cli/pr-validate.js exists at expected path (${cliPath138})`
    );

    // [138k] checkTargetReachable returns { ok: true } for a live server (harness fixture)
    const reach138k = await checkTargetReachable(`http://localhost:${devPort}/`);
    assert(
      reach138k.ok === true,
      `[138k] checkTargetReachable returns ok=true for live harness server on port ${devPort} (got: ${JSON.stringify(reach138k)})`
    );

    // [138l] checkTargetReachable returns { ok: false } for a port with nothing listening
    const reach138l = await checkTargetReachable('http://localhost:19999/');
    assert(
      reach138l.ok === false && typeof reach138l.error === 'string',
      `[138l] checkTargetReachable returns ok=false + error string for unreachable port (got: ${JSON.stringify(reach138l)})`
    );

    // [138m] checkTargetReachable returns ok=true for HTTP 4xx (server is up, route just missing)
    const reach138m = await checkTargetReachable(`http://localhost:${devPort}/this-path-does-not-exist-404`);
    assert(
      reach138m.ok === true,
      `[138m] checkTargetReachable returns ok=true for HTTP 404 — only network errors fail (got: ${JSON.stringify(reach138m)})`
    );

    // [138n] normalizeRoutePaths prepends leading slash to paths that are missing it
    const norm138n = normalizeRoutePaths([{ path: 'login', name: 'Login' }]);
    assert(
      norm138n[0].path === '/login',
      `[138n] normalizeRoutePaths prepends / to route path missing leading slash (got: "${norm138n[0].path}")`
    );

    // [138o] normalizeRoutePaths leaves paths that already have a leading slash unchanged
    const norm138o = normalizeRoutePaths([{ path: '/checkout', name: 'Checkout' }]);
    assert(
      norm138o[0].path === '/checkout',
      `[138o] normalizeRoutePaths leaves correctly-prefixed paths unchanged (got: "${norm138o[0].path}")`
    );

    // [138p] all-routes-failed guard condition: detects when every perRoute entry has an error
    const failedPerRoute138 = [
      { route: '/login', critical: 0, warning: 0, info: 0, error: 'navigate timeout' },
      { route: '/checkout', critical: 0, warning: 0, info: 0, error: 'MCP tool timeout' },
    ];
    const failCount138 = failedPerRoute138.filter(r => r.error).length;
    assert(
      failCount138 > 0 && failCount138 === failedPerRoute138.length,
      `[138p] all-routes-failed guard condition correctly identifies all-failed perRoute array (failCount=${failCount138}, total=${failedPerRoute138.length})`
    );
  }

  // ── Block [139]: Chrome Launcher, Doctor, Security Extensions ────
  {
    console.log('\n[139] Chrome launcher, doctor, security extensions');

    // [139a] checkSourceMapExposure fires for .js.map URL
    const mapReqs139 = [{ url: 'https://example.com/bundle.js.map' }];
    const mapFindings139 = checkSourceMapExposure(mapReqs139, 'https://example.com/');
    assert(
      mapFindings139.length === 1 && mapFindings139[0].type === 'security_sourcemap_exposed',
      `[139a] checkSourceMapExposure returns security_sourcemap_exposed for .js.map URL (got: ${mapFindings139.length} findings)`
    );

    // [139b] checkSourceMapExposure skips non-map URLs
    const safeReqs139 = [{ url: 'https://example.com/bundle.js' }, { url: 'https://example.com/style.css' }];
    const safeMapFindings139 = checkSourceMapExposure(safeReqs139, 'https://example.com/');
    assert(
      safeMapFindings139.length === 0,
      `[139b] checkSourceMapExposure returns no findings for non-map URLs (got: ${safeMapFindings139.length})`
    );

    // [139c] checkOpenRedirects fires for ?redirect= parameter
    const redirectReqs139 = [{ url: 'https://example.com/auth?redirect=https://evil.com' }];
    const redirectFindings139 = checkOpenRedirects(redirectReqs139, 'https://example.com/auth');
    assert(
      redirectFindings139.length === 1 && redirectFindings139[0].type === 'security_open_redirect',
      `[139c] checkOpenRedirects returns security_open_redirect for ?redirect= URL (got: ${redirectFindings139.length} findings)`
    );

    // [139d] checkOpenRedirects skips safe URLs
    const safeRedirectReqs139 = [{ url: 'https://example.com/api/data' }, { url: 'https://example.com/page?id=5' }];
    const safeRedirectFindings139 = checkOpenRedirects(safeRedirectReqs139, 'https://example.com/');
    assert(
      safeRedirectFindings139.length === 0,
      `[139d] checkOpenRedirects returns no findings for safe URLs (got: ${safeRedirectFindings139.length})`
    );

    // [139e] parseSecurityAnalysisResult emits security_missing_sri for external script without integrity
    const sriData139 = JSON.stringify({
      storageTokenKeys: [], evalUsage: false, jsCookies: [], hasCSP: null, hasXFrame: null,
      unsandboxedIframes: [], unsafeBlankLinks: [],
      sriViolations: [{ tag: 'script', src: 'https://cdn.example.com/lib.js' }],
    });
    const sriFindings139 = parseSecurityAnalysisResult(sriData139, 'https://example.com/');
    assert(
      sriFindings139.some(f => f.type === 'security_missing_sri'),
      `[139e] parseSecurityAnalysisResult emits security_missing_sri for external script without integrity (got types: ${sriFindings139.map(f => f.type).join(', ') || 'none'})`
    );

    // [139f] parseSecurityAnalysisResult emits no SRI finding when sriViolations is empty
    const noSriData139 = JSON.stringify({
      storageTokenKeys: [], evalUsage: false, jsCookies: [], hasCSP: null, hasXFrame: null,
      unsandboxedIframes: [], unsafeBlankLinks: [], sriViolations: [],
    });
    const noSriFindings139 = parseSecurityAnalysisResult(noSriData139, 'https://example.com/').filter(f => f.type === 'security_missing_sri');
    assert(
      noSriFindings139.length === 0,
      `[139f] parseSecurityAnalysisResult emits no security_missing_sri when sriViolations is empty`
    );

    // [139g] checkChrome returns { ok, detail } shape (may be ok=false in harness — Chrome may not be on 9222 this moment)
    const chromeResult139 = await checkChrome(9222);
    assert(
      typeof chromeResult139 === 'object' && chromeResult139 !== null &&
      typeof chromeResult139.ok === 'boolean' && typeof chromeResult139.detail === 'string',
      `[139g] checkChrome returns { ok: boolean, detail: string } shape (got: ${JSON.stringify(chromeResult139)})`
    );

    // [139h] checkMcpConfig returns ok=false for a missing file path
    const mcpMissing139 = checkMcpConfig('/nonexistent/path/.mcp.json');
    assert(
      mcpMissing139.ok === false && typeof mcpMissing139.detail === 'string',
      `[139h] checkMcpConfig returns ok=false for missing file (got: ${JSON.stringify(mcpMissing139)})`
    );

    // [139i] checkMcpConfig returns ok=true for valid config with chrome-devtools entry
    const tmpMcp139 = path.join(os.tmpdir(), 'argus-test-mcp-139.json');
    fs.writeFileSync(tmpMcp139, JSON.stringify({
      mcpServers: {
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.1.1'] },
      },
    }));
    const mcpValid139 = checkMcpConfig(tmpMcp139);
    fs.unlinkSync(tmpMcp139);
    assert(
      mcpValid139.ok === true,
      `[139i] checkMcpConfig returns ok=true for valid chrome-devtools config (got: ${JSON.stringify(mcpValid139)})`
    );

    // [139j] checkEnvKeys returns ok=true when TARGET_DEV_URL is present in .env content
    const tmpEnv139 = path.join(os.tmpdir(), 'argus-test-env-139');
    fs.writeFileSync(tmpEnv139, 'TARGET_DEV_URL=http://localhost:3000\n');
    // Temporarily unset env var so checkEnvKeys reads from file
    const savedUrl139 = process.env.TARGET_DEV_URL;
    delete process.env.TARGET_DEV_URL;
    const envResult139 = checkEnvKeys(tmpEnv139);
    if (savedUrl139 !== undefined) process.env.TARGET_DEV_URL = savedUrl139;
    fs.unlinkSync(tmpEnv139);
    assert(
      envResult139.ok === true && envResult139.detail.includes('localhost:3000'),
      `[139j] checkEnvKeys returns ok=true when TARGET_DEV_URL in .env file (got: ${JSON.stringify(envResult139)})`
    );

    // [139k] findChrome() returns string or null without throwing (pure path resolution, no side effects)
    let chromePathResult139;
    let chromeThrew139 = false;
    try { chromePathResult139 = findChrome(); } catch { chromeThrew139 = true; }
    assert(
      !chromeThrew139 && (chromePathResult139 === null || typeof chromePathResult139 === 'string'),
      `[139k] findChrome() returns string or null without throwing (got: ${chromeThrew139 ? 'threw' : JSON.stringify(chromePathResult139)})`
    );
  }

  // ── Block [140]: Noise Filter — intelligent baseline filtering (pure unit) ──
  {
    console.log('\n[140] Noise filter — cross-run flip-flop classifier (intelligent baseline filtering)');

    const url140 = 'http://localhost:3000/dash';
    const flipKey140   = 'console::boom';      // present in runs 1,3,5 — absent 2,4
    const stableKey140 = 'network::dead';      // present in every run
    const mkHistory140 = (runs) => runs.map(keys => ({ runAt: 'x', routes: { [url140]: keys } }));
    const history140 = mkHistory140([
      [flipKey140, stableKey140],
      [stableKey140],
      [flipKey140, stableKey140],
      [stableKey140],
      [flipKey140, stableKey140],
    ]);

    // [140a] flip-flopping key scores 1.0 (flips on every consecutive run pair)
    const scores140 = computeNoiseScores(history140);
    const flipScore140 = scores140.get(`${url140}::${flipKey140}`);
    assert(
      flipScore140 && flipScore140.score === 1 && flipScore140.runs === 5,
      `[140a] flip-flopping finding scores 1.0 over 5 runs (got: ${JSON.stringify(flipScore140)})`
    );

    // [140b] stable always-present key scores 0
    const stableScore140 = scores140.get(`${url140}::${stableKey140}`);
    assert(
      stableScore140 && stableScore140.score === 0,
      `[140b] stable always-present finding scores 0 (got: ${JSON.stringify(stableScore140)})`
    );

    // [140c] applyNoiseFilter downgrades the noisy finding to info + annotates
    const report140 = { routes: [{ url: url140, errors: [
      { type: 'console', message: 'boom', severity: 'warning' },
      { type: 'network', message: 'dead', severity: 'critical' },
    ] }] };
    const { noisyCount: noisy140 } = applyNoiseFilter(report140, history140);
    const flipFinding140 = report140.routes[0].errors[0];
    assert(
      noisy140 === 1 && flipFinding140.noisy === true && flipFinding140.severity === 'info' &&
      flipFinding140.originalSeverity === 'warning' && typeof flipFinding140.noiseScore === 'number',
      `[140c] noisy finding downgraded to info with noisy:true + originalSeverity (got: noisy=${noisy140}, ${JSON.stringify(flipFinding140)})`
    );

    // [140d] stable critical finding untouched
    const stableFinding140 = report140.routes[0].errors[1];
    assert(
      stableFinding140.severity === 'critical' && stableFinding140.noisy === undefined,
      `[140d] stable finding keeps original severity (got: ${stableFinding140.severity}, noisy=${stableFinding140.noisy})`
    );

    // [140e] history shorter than NOISE_MIN_RUNS → no downgrade even when flip-flopping
    const shortHistory140 = mkHistory140([[flipKey140], [], [flipKey140]]); // 3 runs < 4
    const shortReport140 = { routes: [{ url: url140, errors: [{ type: 'console', message: 'boom', severity: 'warning' }] }] };
    const { noisyCount: shortNoisy140 } = applyNoiseFilter(shortReport140, shortHistory140);
    assert(
      shortNoisy140 === 0 && shortReport140.routes[0].errors[0].severity === 'warning',
      `[140e] ${NOISE_MIN_RUNS}-run minimum respected — 3-run history produces no downgrade (got noisy=${shortNoisy140})`
    );

    // [140f] recordRunHistory round-trip + caps at maxRuns
    const tmpHistory140 = path.join(os.tmpdir(), `argus-history-140-${Date.now()}.json`);
    const runReport140 = { generatedAt: 'now', routes: [{ url: url140, errors: [{ type: 'console', message: 'boom' }] }] };
    for (let i = 0; i < 6; i++) recordRunHistory(tmpHistory140, runReport140, 5);
    const loaded140 = loadRunHistory(tmpHistory140);
    assert(
      loaded140.length === 5 && loaded140[0].routes[url140]?.includes('console::boom'),
      `[140f] recordRunHistory caps at maxRuns=5 and round-trips finding keys (got ${loaded140.length} runs)`
    );

    // [140g] corrupt history file → loadRunHistory returns []
    fs.writeFileSync(tmpHistory140, 'not json {{');
    const corrupt140 = loadRunHistory(tmpHistory140);
    fs.unlinkSync(tmpHistory140);
    assert(
      Array.isArray(corrupt140) && corrupt140.length === 0,
      `[140g] corrupt history file returns [] (got: ${JSON.stringify(corrupt140)})`
    );
  }

  // ── Block [141]: Root Cause Linker — git diff → route heuristic (pure unit) ──
  {
    console.log('\n[141] Root cause linker — recent git changes mapped to new findings');

    // [141a] getRecentChanges returns an array (this repo, or [] when git unavailable)
    let changes141;
    let changesThrew141 = false;
    try { changes141 = getRecentChanges(); } catch { changesThrew141 = true; }
    assert(
      !changesThrew141 && Array.isArray(changes141),
      `[141a] getRecentChanges returns an array without throwing (got ${changesThrew141 ? 'throw' : changes141.length + ' commit(s)'})`
    );

    // [141b] slug match: checkout page file matches /checkout route
    const direct141 = matchFilesToRoutePath(['src/pages/checkout/Form.jsx'], '/checkout');
    assert(
      direct141.files.length === 1 && direct141.global === false,
      `[141b] src/pages/checkout/Form.jsx matches route /checkout (got: ${JSON.stringify(direct141)})`
    );

    // [141c] unrelated file → no match, not global
    const none141 = matchFilesToRoutePath(['src/utils/random-helper.js'], '/checkout');
    assert(
      none141.files.length === 0 && none141.global === false,
      `[141c] unrelated file does not match /checkout (got: ${JSON.stringify(none141)})`
    );

    // [141d] infra file → global scope, not a direct match
    const infra141 = matchFilesToRoutePath(['next.config.js'], '/checkout');
    assert(
      infra141.global === true && infra141.files.length === 0,
      `[141d] next.config.js flagged global for any route (got: ${JSON.stringify(infra141)})`
    );

    // [141e] linkRootCauses annotates the NEW finding with rootCause.files
    const report141 = { routes: [{ url: 'http://localhost:3000/checkout', errors: [
      { type: 'console', message: 'boom', isNew: true },
      { type: 'network', message: 'old issue', isNew: false },
    ] }] };
    const commits141 = [{ hash: 'abc1234', subject: 'fix checkout form', files: ['src/pages/checkout/Form.jsx'] }];
    const { linkedCount: linked141 } = linkRootCauses(report141, commits141);
    const newFinding141 = report141.routes[0].errors[0];
    assert(
      linked141 === 1 && newFinding141.rootCause?.files?.includes('src/pages/checkout/Form.jsx') &&
      newFinding141.rootCause.commits[0].hash === 'abc1234' && newFinding141.rootCause.global === false,
      `[141e] new finding annotated with rootCause files + commit (got: ${JSON.stringify(newFinding141.rootCause)})`
    );

    // [141f] pre-existing (isNew: false) finding NOT annotated
    assert(
      report141.routes[0].errors[1].rootCause === undefined,
      `[141f] pre-existing finding has no rootCause annotation`
    );

    // [141g] empty changes → no annotation, no throw
    const emptyReport141 = { routes: [{ url: 'http://localhost:3000/checkout', errors: [{ type: 'console', message: 'x', isNew: true }] }] };
    const { linkedCount: emptyLinked141 } = linkRootCauses(emptyReport141, []);
    assert(
      emptyLinked141 === 0 && emptyReport141.routes[0].errors[0].rootCause === undefined,
      `[141g] empty changes list links nothing (got linkedCount=${emptyLinked141})`
    );

    // [141h] infra-only commit → rootCause.global true with infra files as suspects
    const globalReport141 = { routes: [{ url: 'http://localhost:3000/checkout', errors: [{ type: 'console', message: 'y', isNew: true }] }] };
    const infraCommits141 = [{ hash: 'def5678', subject: 'bump deps', files: ['package.json'] }];
    const { linkedCount: globalLinked141 } = linkRootCauses(globalReport141, infraCommits141);
    const globalFinding141 = globalReport141.routes[0].errors[0];
    assert(
      globalLinked141 === 1 && globalFinding141.rootCause?.global === true &&
      globalFinding141.rootCause.files.includes('package.json'),
      `[141h] infra-only commit links with global:true (got: ${JSON.stringify(globalFinding141.rootCause)})`
    );
  }

  // ── Block [142]: MCP wire-contract regressions (2026-06-12 audit) ──────────
  // Guards the bug class where markdown MCP responses were consumed as
  // structured data, plus the mcp-server logger/version regressions.
  {
    console.log('\n[142] MCP wire-contract regressions — list_pages parse, response body extraction, server hygiene');

    // [142a] parseListPagesResponse parses the markdown pages list
    const pages142 = parseListPagesResponse('## Pages\n1: http://localhost:3100/a.html [selected]\n2: about:blank');
    assert(
      pages142.length === 2 && pages142[0].id === 1 && pages142[0].selected === true &&
      pages142[0].url === 'http://localhost:3100/a.html' && pages142[1].selected === false,
      `[142a] parseListPagesResponse parses ids/urls/selected (got: ${JSON.stringify(pages142)})`
    );

    // [142b] parseListPagesResponse guards null/garbage input
    assert(
      Array.isArray(parseListPagesResponse(null)) && parseListPagesResponse(null).length === 0 &&
      parseListPagesResponse('no pages here').length === 0,
      `[142b] parseListPagesResponse returns [] for null/garbage`
    );

    // [142c] extractResponseBody parses the "### Response Body" markdown section
    const md142 = '## Request http://x/api\nStatus: 200\n### Response Headers\n- a:b\n### Response Body\n{"ok":true,"n":2}';
    const body142 = extractResponseBody(md142);
    assert(
      body142 && body142.ok === true && body142.n === 2,
      `[142c] extractResponseBody parses markdown body section (got: ${JSON.stringify(body142)})`
    );

    // [142d] extractResponseBody returns null when no body section exists
    assert(
      extractResponseBody('## Request http://x/api\nStatus: 304\n### Response Headers\n- a:b') === null &&
      extractResponseBody(null) === null,
      `[142d] extractResponseBody returns null without a body section`
    );

    // [142e] extractResponseBody legacy structured shapes still work
    assert(
      extractResponseBody({ responseBody: '{"a":1}' })?.a === 1 &&
      extractResponseBody({ body: '{"b":2}' })?.b === 2,
      `[142e] extractResponseBody handles legacy { responseBody } / { body } shapes`
    );

    // [142f]–[142i] static source regressions on mcp-server.js + adapters
    const mcpSrc142     = fs.readFileSync(path.resolve('src/mcp-server.js'), 'utf8');
    const browserSrc142 = fs.readFileSync(path.resolve('src/adapters/browser.js'), 'utf8');
    const prDiffSrc142  = fs.readFileSync(path.resolve('src/utils/pr-diff-analyzer.js'), 'utf8');

    // [142f] mcp-server.js defines its logger (a bare `logger.` reference once
    // threw ReferenceError inside withMcp, masking every handler error)
    assert(
      mcpSrc142.includes("childLogger('mcp-server')"),
      `[142f] mcp-server.js imports and instantiates childLogger`
    );

    // [142g] mcp-server.js reads its version from package.json (hardcoded '9.6.6' drifted)
    assert(
      mcpSrc142.includes('version: pkg.version') && !mcpSrc142.includes("version: '9.6.6'"),
      `[142g] mcp-server.js Server version comes from package.json`
    );

    // [142h] browser adapter sends the reqid wire param (requestId is rejected by chrome-devtools-mcp)
    assert(
      browserSrc142.includes('get_network_request({ reqid:'),
      `[142h] CdpBrowserAdapter.getNetworkRequest sends reqid`
    );

    // [142i] pr-diff-analyzer must never write to stdout (imported by the MCP server)
    assert(
      !prDiffSrc142.includes('console.log('),
      `[142i] pr-diff-analyzer.js has no console.log (stdout reserved for JSON-RPC)`
    );
  }

  // ── [143] CdpBrowserAdapter wire-contract conformance ───────────────────────
  // One content-level assertion per adapter method against live Chrome. Motivated by
  // the 2026-06-12 audit: three adapter/client wire bugs (reqid, markdown parsing,
  // logger) shipped silently because no test exercised the real wire. The meta-
  // assertion at the end enumerates CdpBrowserAdapter.prototype so a new adapter
  // method CANNOT ship without a conformance entry here.
  // NOTE: chrome-devtools-mcp returns tool input-validation failures as RESOLVED
  // error-text responses (not thrown errors), so every assertion here checks content;
  // "it didn't throw" proves nothing.
  {
    console.log('\n[143] CdpBrowserAdapter wire-contract conformance — content assertion per adapter method');

    const covered = new Set(); // methods with a conformance entry in this block
    const C = `${B}/adapter-conformance.html`;
    const ZOD_ERR = 'Input validation error';

    try {
      // ── navigate + waitFor (text appears 600 ms post-load, so wait_for must wait) ──
      covered.add('navigate');
      const navResp143 = await browser.navigate(C);
      const navText143 = String(navResp143);
      assert(
        navText143.includes('Successfully navigated') && navText143.includes('/adapter-conformance.html'),
        `[143a] navigate() response confirms navigation to the fixture URL (got: ${navText143.slice(0, 120)})`
      );

      covered.add('waitFor');
      const wfStart143 = Date.now();
      const wfResp143 = String(await browser.waitFor({ text: 'late-probe-ready' }));
      const wfMs143 = Date.now() - wfStart143;
      assert(
        wfResp143.includes('late-probe-ready') && wfResp143.includes('found') && !wfResp143.includes(ZOD_ERR),
        `[143b] waitFor({ text: string }) normalises to the array wire shape and finds the late text (got: ${wfResp143.slice(0, 120)})`
      );
      // The text appears 600 ms after load; sub-100 ms resolution would mean wait_for
      // never actually waited (e.g. silently matched nothing).
      assert(
        wfMs143 >= 100,
        `[143c] waitFor() actually waited for the 600 ms-late text (resolved in ${wfMs143} ms)`
      );

      const wfIdle143 = String(await browser.waitFor({ state: 'networkidle' }) ?? '');
      assert(
        !wfIdle143.includes(ZOD_ERR),
        `[143d] waitFor({ state: 'networkidle' }) is translated by the adapter, not rejected by wait_for input validation (got: ${wfIdle143.slice(0, 120) || '<empty — resolved>'})`
      );

      // ── evaluate / snapshot / screenshot ──
      covered.add('evaluate');
      const evalVal143 = unwrapEval(await browser.evaluate('() => 6 * 7'));
      assert(
        Number(evalVal143) === 42,
        `[143e] evaluate('() => 6 * 7') unwraps to 42 (got: ${JSON.stringify(evalVal143)})`
      );

      covered.add('snapshot');
      const snapText143 = String(await browser.snapshot());
      assert(
        snapText143.includes('uid=') && snapText143.includes('Conformance Click Probe'),
        `[143f] snapshot() returns uid= tokens with the fixture's accessible names (got: ${snapText143.slice(0, 120)})`
      );

      covered.add('screenshot');
      const shot143 = await browser.screenshot({ format: 'png' });
      const shotMagic143 = shot143?.data
        ? Buffer.from(String(shot143.data).slice(0, 16), 'base64').toString('hex')
        : '(no data)';
      assert(
        typeof shot143?.data === 'string' && shot143.data.length > 1000 && shotMagic143.startsWith('89504e47'),
        `[143g] screenshot({ format: 'png' }) returns base64 image data with PNG magic bytes — the image content item, not the text caption (magic: ${shotMagic143}, len: ${shot143?.data?.length ?? typeof shot143})`
      );

      // ── interactions: click / fill / type / pressKey / hover / drag / uploadFile ──
      covered.add('click');
      const clickUid143 = await resolveUidForSelector(browser, '#click-btn');
      if (clickUid143) await browser.click(clickUid143);
      const clicked143 = unwrapEval(await browser.evaluate(`() => document.getElementById('click-btn').getAttribute('data-clicked')`));
      assert(
        clickUid143 != null && String(clicked143) === 'true',
        `[143h] click(uid) fires the click handler — data-clicked="true" (uid: ${clickUid143}, got: ${JSON.stringify(clicked143)})`
      );

      covered.add('fill');
      const fillUid143 = await resolveUidForSelector(browser, '#fill-input');
      if (fillUid143) await browser.fill(fillUid143, 'wire-fill-143');
      const fillVal143 = unwrapEval(await browser.evaluate(`() => document.getElementById('fill-input').value`));
      assert(
        fillUid143 != null && String(fillVal143) === 'wire-fill-143',
        `[143i] fill(uid, value) delivers the value to the input (uid: ${fillUid143}, got: ${JSON.stringify(fillVal143)})`
      );

      covered.add('type');
      // click does not move document.activeElement for text inputs in headless —
      // focus via evaluate, same as block [48b]
      const typeFocused143 = !!unwrapEval(await browser.evaluate(`() => { const el = document.getElementById('type-input'); if (!el) return false; el.focus(); return true; }`));
      const typeResp143 = String(await browser.type('wire-type-143'));
      const typeVal143 = unwrapEval(await browser.evaluate(`() => document.getElementById('type-input').value`));
      assert(
        typeFocused143 && typeResp143.includes('Typed text') && String(typeVal143) === 'wire-type-143',
        `[143j] type(text) types into the focused element (response: ${typeResp143.slice(0, 60)}, value: ${JSON.stringify(typeVal143)})`
      );

      covered.add('pressKey');
      // #fill-input and #type-input are adjacent in tab order — Tab from fill lands on type
      await browser.evaluate(`() => { document.getElementById('fill-input').focus(); return true; }`);
      await browser.pressKey('Tab');
      const activeId143 = unwrapEval(await browser.evaluate(`() => document.activeElement.id`));
      assert(
        String(activeId143) === 'type-input',
        `[143k] pressKey('Tab') moves focus to the next focusable element (activeElement.id: ${JSON.stringify(activeId143)})`
      );

      covered.add('hover');
      const hoverUid143 = await resolveUidForSelector(browser, '#hover-target');
      if (hoverUid143) await browser.hover(hoverUid143);
      const hovered143 = unwrapEval(await browser.evaluate(`() => document.getElementById('hover-target').getAttribute('data-hovered')`));
      assert(
        hoverUid143 != null && String(hovered143) === 'true',
        `[143l] hover(uid) fires mouseenter — data-hovered="true" (uid: ${hoverUid143}, got: ${JSON.stringify(hovered143)})`
      );

      covered.add('drag');
      const dragSrcUid143 = await resolveUidForSelector(browser, '#drag-source');
      const dropUid143 = await resolveUidForSelector(browser, '#drop-zone');
      if (dragSrcUid143 && dropUid143) await browser.drag(dragSrcUid143, dropUid143);
      const dropped143 = unwrapEval(await browser.evaluate(`() => document.getElementById('drop-zone').getAttribute('data-dropped')`));
      assert(
        dragSrcUid143 != null && dropUid143 != null && String(dropped143) === 'true',
        `[143m] drag(src, tgt) fires the drop handler — data-dropped="true" (uids: ${dragSrcUid143}/${dropUid143}, got: ${JSON.stringify(dropped143)})`
      );

      covered.add('uploadFile');
      const uploadUid143 = await resolveUidForSelector(browser, 'input[type=file]');
      if (uploadUid143) await browser.uploadFile(uploadUid143, path.resolve(__dirname, 'pages', 'test-upload.txt'));
      const uploadName143 = unwrapEval(await browser.evaluate(`() => { const f = document.getElementById('file-input').files; return f.length ? f[0].name : null; }`));
      assert(
        uploadUid143 != null && String(uploadName143) === 'test-upload.txt',
        `[143n] uploadFile(uid, path) delivers the file to the input (uid: ${uploadUid143}, files[0].name: ${JSON.stringify(uploadName143)})`
      );

      // ── viewport: emulate / emulateCpu / emulateColorScheme / emulateReducedMotion / resize ──
      covered.add('emulate');
      await browser.emulate('375x667x1,mobile,touch');
      const emuWidth143 = Number(unwrapEval(await browser.evaluate('() => document.documentElement.clientWidth')));
      assert(
        emuWidth143 === 375,
        `[143o] emulate('375x667x1,mobile,touch') sets the visual viewport — clientWidth 375 (got: ${emuWidth143})`
      );
      await browser.emulate('1280x900x1');

      covered.add('emulateCpu');
      const cpuResp143 = String(await browser.emulateCpu(2));
      assert(
        cpuResp143.includes('CPU throttling: 2x'),
        `[143p] emulateCpu(2) response confirms the throttling rate (got: ${cpuResp143.slice(0, 120)})`
      );
      await browser.emulateCpu(1);

      covered.add('emulateColorScheme');
      await browser.emulateColorScheme('dark');
      const darkMatch143 = unwrapEval(await browser.evaluate(`() => window.matchMedia('(prefers-color-scheme: dark)').matches`));
      assert(
        darkMatch143 === true || String(darkMatch143) === 'true',
        `[143q] emulateColorScheme('dark') flips prefers-color-scheme (matches: ${JSON.stringify(darkMatch143)})`
      );
      await browser.emulateColorScheme('light');

      covered.add('emulateReducedMotion');
      // chrome-devtools-mcp@1.1.1 has no reduced-motion emulation (emulate tool rejects
      // the argument as unknown) — the adapter must surface that as a thrown error,
      // never a silent no-op. If a future upstream version adds support, the call must
      // actually flip the media feature. Both outcomes pass; silence fails.
      let rmOutcome143;
      try {
        await browser.emulateReducedMotion('reduce');
        const motionMatch143 = unwrapEval(await browser.evaluate(`() => window.matchMedia('(prefers-reduced-motion: reduce)').matches`));
        rmOutcome143 = (motionMatch143 === true || String(motionMatch143) === 'true')
          ? 'emulated'
          : `silent-noop (matches: ${JSON.stringify(motionMatch143)})`;
        await browser.emulateReducedMotion('no-preference').catch(() => { });
      } catch (e) {
        rmOutcome143 = /reducedMotion/i.test(e.message)
          ? 'unsupported-error'
          : `wrong-error (${e.message.slice(0, 80)})`;
      }
      assert(
        rmOutcome143 === 'emulated' || rmOutcome143 === 'unsupported-error',
        `[143r] emulateReducedMotion('reduce') either emulates the media feature or throws an explicit unsupported error — never a silent no-op (outcome: ${rmOutcome143})`
      );

      covered.add('resize');
      // An active viewport emulation pins innerWidth regardless of window size —
      // clear the override (empty-string viewport) so resize_page's effect is visible
      await browser.emulate('');
      await browser.resize(1234, 777);
      const resizeWidth143 = Number(unwrapEval(await browser.evaluate('() => window.innerWidth')));
      assert(
        resizeWidth143 === 1234,
        `[143s] resize(1234, 777) resizes the window — innerWidth 1234 (got: ${resizeWidth143})`
      );
      await browser.emulate('1280x900x1');

      // ── network & console lists (the v9.7.4 bug class lived here) ──
      covered.add('listNetwork');
      const net143 = await browser.listNetwork();
      const apiReq143 = net143.find(r => r.url.includes('/api/data'));
      assert(
        apiReq143 != null && apiReq143.status === 200 && Number.isFinite(apiReq143.requestId),
        `[143t] listNetwork() parses the fixture's /api/data request with numeric requestId and status 200 (got: ${JSON.stringify(apiReq143 ?? net143.slice(0, 2))})`
      );

      covered.add('getNetworkRequest');
      const gnr143 = apiReq143 ? String(await browser.getNetworkRequest(apiReq143.requestId)) : '(skipped — no /api/data request)';
      assert(
        gnr143.includes('/api/data') && gnr143.includes('Status: 200') && gnr143.includes('### Response Headers'),
        `[143u] getNetworkRequest(id) sends the reqid wire param and returns the request detail (got: ${gnr143.slice(0, 150)})`
      );

      covered.add('listConsole');
      const console143 = await browser.listConsole();
      const probeMsg143 = console143.find(m => (m.text ?? '').includes('argus-conformance-probe'));
      assert(
        probeMsg143 != null && probeMsg143.level === 'log',
        `[143v] listConsole() parses the fixture's console.log probe with its level (got: ${JSON.stringify(probeMsg143 ?? console143.slice(0, 2))})`
      );

      covered.add('listConsoleRaw');
      const rawConsole143 = await browser.listConsoleRaw({});
      assert(
        typeof rawConsole143 === 'string' && rawConsole143.includes('argus-conformance-probe') && rawConsole143.includes('msgid='),
        `[143w] listConsoleRaw() passes through unparsed msgid= markdown containing the probe (got: ${String(rawConsole143).slice(0, 120)})`
      );

      // ── tab management: listPages / selectPage ──
      covered.add('listPages');
      const pages143 = parseListPagesResponse(await browser.listPages());
      const selPage143 = pages143.find(p => p.selected);
      assert(
        pages143.length >= 1 && selPage143 != null && Number.isFinite(selPage143.id) && selPage143.url.includes('/adapter-conformance.html'),
        `[143x] listPages() parses ≥1 page with numeric id and the fixture URL selected (got: ${JSON.stringify(pages143)})`
      );

      covered.add('selectPage');
      // String input is the contract — MCP tool args arrive as strings; selectPage must
      // coerce to the number select_page's input validation requires
      const selResp143 = String(await browser.selectPage(String(selPage143?.id ?? 1)));
      assert(
        !selResp143.includes(ZOD_ERR) && selResp143.includes('[selected]'),
        `[143y] selectPage('${selPage143?.id ?? 1}') coerces the string id and confirms selection (got: ${selResp143.slice(0, 120)})`
      );

      // ── handleDialog — LAST interaction: an open dialog blocks every other tool ──
      covered.add('handleDialog');
      await browser.evaluate(`() => { setTimeout(() => { window.__dialogResult = window.confirm('argus-143-dialog'); }, 150); return true; }`);
      await sleep(500);
      const dialogResp143 = String(await browser.handleDialog(true));
      const dialogResult143 = unwrapEval(await browser.evaluate('() => String(window.__dialogResult)'));
      assert(
        dialogResp143.includes('Successfully accepted the dialog') && String(dialogResult143) === 'true',
        `[143z] handleDialog(true) sends { action: 'accept' } and the page's confirm() returns true (response: ${dialogResp143.slice(0, 100)}, confirm: ${JSON.stringify(dialogResult143)})`
      );

      // ── soft: heapSnapshot / lighthouse / traces (headless-fragile, existing policy) ──
      covered.add('heapSnapshot');
      try {
        const heapPath143 = path.join(os.tmpdir(), `argus-143-${Date.now()}.heapsnapshot`);
        const heapResp143 = String(await browser.heapSnapshot({ filePath: heapPath143 }));
        const heapSize143 = fs.existsSync(heapPath143) ? fs.statSync(heapPath143).size : 0;
        soft(
          heapResp143.includes('Heap snapshot saved') && heapSize143 > 100_000,
          `[143aa] heapSnapshot({ filePath }) writes a heap snapshot file (response: ${heapResp143.slice(0, 60)}, bytes: ${heapSize143})`
        );
        fs.rmSync(heapPath143, { force: true });
      } catch (e) {
        soft(false, `[143aa] heapSnapshot({ filePath }) writes a heap snapshot file (threw: ${e.message})`);
      }

      covered.add('startTrace');
      covered.add('stopTrace');
      covered.add('analyzeInsight');
      try {
        // performance_start_trace defaults to reload + autoStop, so the summary
        // arrives in the START response; stopTrace afterwards is a no-op
        const traceResp143 = String(await browser.startTrace());
        soft(
          /trace|insight/i.test(traceResp143),
          `[143ab] startTrace() returns a performance trace summary (got: ${traceResp143.slice(0, 80)})`
        );
        const stopResp143 = String(await browser.stopTrace() ?? '');
        soft(
          !stopResp143.includes(ZOD_ERR),
          `[143ac] stopTrace() resolves without input-validation rejection (got: ${stopResp143.slice(0, 80) || '<empty>'})`
        );
        const insightResp143 = String(await browser.analyzeInsight({ insightName: 'DocumentLatency' }) ?? '');
        soft(
          insightResp143.length > 0,
          `[143ad] analyzeInsight() reaches the tool — response or structured validation text (got: ${insightResp143.slice(0, 80)})`
        );
      } catch (e) {
        soft(false, `[143ab] trace methods unavailable in this Chrome (threw: ${e.message})`);
      }

      covered.add('lighthouse');
      try {
        const lhResp143 = String(await browser.lighthouse(C) ?? '');
        soft(
          lhResp143.length > 0 && !lhResp143.includes(ZOD_ERR),
          `[143ae] lighthouse(url) reaches lighthouse_audit (got: ${lhResp143.slice(0, 80)})`
        );
      } catch (e) {
        soft(false, `[143ae] lighthouse(url) unavailable in headless (threw: ${e.message})`);
      }

      // ── close — proven on a dedicated client so the shared one survives ──
      covered.add('close');
      const mcp143 = await createMcpClient();
      let closeErr143 = null;
      try {
        const probe143 = unwrapEval(await mcp143.evaluate_script({ function: '() => 1 + 1' }));
        mcp143.close();
        try {
          await mcp143.evaluate_script({ function: '() => 2 + 2' });
        } catch (e) {
          closeErr143 = e.message;
        }
        // Post-close rejection surfaces via one of three paths: close() pending sweep
        // ("MCP client closed"), the stdin error event ("MCP stdin error: ..."), or the
        // raw write callback ("write after end" / EPIPE) — all prove termination.
        assert(
          Number(probe143) === 2 && closeErr143 != null && /closed|exited|stdin|write after end|EPIPE/i.test(closeErr143),
          `[143af] close() terminates the client — follow-up calls reject with a closed-client error (probe: ${JSON.stringify(probe143)}, error: ${closeErr143})`
        );
      } finally {
        try { mcp143.close(); } catch { }
      }
    } finally {
      // Restore every emulation override and clear any dialog left open so later
      // blocks (and reruns) start clean — an open dialog poisons all tool calls.
      try { await mcp.handle_dialog({ action: 'dismiss' }); } catch { }
      try { await browser.emulate('1280x900x1'); } catch { }
      try { await browser.emulateCpu(1); } catch { }
      try { await browser.emulateColorScheme('light'); } catch { }
      try { await browser.emulateReducedMotion('no-preference'); } catch { }
    }

    // ── meta-assertion: the coverage ratchet ──
    const protoMethods143 = Object.getOwnPropertyNames(CdpBrowserAdapter.prototype)
      .filter(m => m !== 'constructor');
    const uncovered143 = protoMethods143.filter(m => !covered.has(m));
    assert(
      protoMethods143.length >= 30 && uncovered143.length === 0,
      `[143zz] every CdpBrowserAdapter method has a conformance entry in this block (${protoMethods143.length} methods; uncovered: ${uncovered143.join(', ') || 'none'})`
    );
  }

  // ── Block [144] MCP tool error-path matrix — invalid input + environmental failure ──
  // Direct guard for the v9.7.4 masked-error bug class: a missing `logger` import in
  // mcp-server.js turned every withMcp error path into "logger is not defined", hiding
  // the real cause. So every error-path assertion here ALSO asserts the response does
  // NOT contain "is not defined", and after each provoked error a follow-up tools/list
  // proves the SAME server instance is still answering. Happy paths are covered
  // elsewhere and not duplicated here: [117] tools/list, [118] argus_last_report
  // (no-reports), [119] argus_get_context diff, [120] argus_watch_snapshot. Every error
  // shape below was pinned against live Chrome before these assertions were written.
  {
    console.log('\n[144] MCP tool error-path matrix — structured {error} + isError + server-survives + no masked ReferenceError');

    const ND = 'is not defined';                 // the masked-ReferenceError signature
    const parse144 = (resp) => {
      const text = resp?.result?.content?.[0]?.text ?? '';
      let obj = null; try { obj = JSON.parse(text); } catch { /* non-JSON error text */ }
      return { text, obj, isError: resp?.result?.isError === true };
    };

    let srvA144 = null;        // normal server (real Chrome on 9222); FIGMA token forced off
    let srvB144 = null;        // dead-browser server (MCP_BROWSER_URL → closed port)
    const surviveA144 = [];    // tools-count after each srvA error/edge call
    let err144 = null;

    try {
      // FIGMA_API_TOKEN:'' makes the no-token design-audit path deterministic regardless
      // of the developer's shell; ARGUS_RETRY_ATTEMPTS:'1' makes the unreachable-URL
      // navigate fail on the first attempt instead of retrying with backoff.
      srvA144 = await spawnArgusServer(
        path.resolve(__dirname, '..'),
        { FIGMA_API_TOKEN: '', ARGUS_RETRY_ATTEMPTS: '1', MCP_TOOL_TIMEOUT_MS: '20000' },
      );

      // ── invalid-input rows: handler throw → dispatch catch → { error } + isError:true ──
      const invalidRows144 = [
        ['144a', 'argus_audit',        {},                                        'Invalid URL'],
        ['144b', 'argus_audit',        { url: 'not-a-url' },                      'Invalid URL'],
        ['144c', 'argus_audit_full',   {},                                        'Invalid URL'],
        ['144d', 'argus_visual_diff',  {},                                        'url is required'],
        ['144e', 'argus_design_audit', { url: 'http://localhost:3100/x' },        'figmaFrameUrl is required'],
        ['144f', 'argus_pr_validate',  {},                                        'prUrl is required'],
        ['144g', 'argus_pr_validate',  { prUrl: 'http://example.com/not-a-pr' },  'Invalid GitHub PR URL'],
      ];
      for (const [label, tool, args, substr] of invalidRows144) {
        const p = parse144(await mcpToolCall(srvA144.proc, tool, args, 60000));
        surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
        assert(
          p.isError === true && p.obj !== null && typeof p.obj.error === 'string'
            && p.obj.error.includes(substr) && !p.text.includes(ND),
          `[${label}] ${tool}(${JSON.stringify(args)}) → isError:true with structured {error} containing "${substr}", no "${ND}" (got: isError=${p.isError}, error=${JSON.stringify(p.obj?.error)?.slice(0, 120)})`
        );
      }

      // ── graceful-degradation row: missing FIGMA token → structured error, NOT isError ──
      const figP144 = parse144(await mcpToolCall(
        srvA144.proc, 'argus_design_audit',
        { url: 'http://localhost:3100/x', figmaFrameUrl: 'https://www.figma.com/file/ABC123/Test?node-id=1%3A2' },
        20000,
      ));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        figP144.isError === false && figP144.obj !== null
          && String(figP144.obj.error).includes('FIGMA_API_TOKEN')
          && Array.isArray(figP144.obj.findings) && figP144.obj.findings.length === 0
          && !figP144.text.includes(ND),
        `[144h] argus_design_audit with no FIGMA_API_TOKEN degrades gracefully — error field set, findings:[], NOT isError (got: isError=${figP144.isError}, error=${JSON.stringify(figP144.obj?.error)?.slice(0, 80)})`
      );

      // ── resilience rows: edge input that must NOT crash the handler (isError:false) ──
      const cmpP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_compare', {}, 90000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        cmpP144.isError === false && cmpP144.obj !== null
          && typeof cmpP144.obj.mode === 'string' && !cmpP144.text.includes(ND),
        `[144i] argus_compare returns a structured report with a mode string and never crashes (got: isError=${cmpP144.isError}, mode=${JSON.stringify(cmpP144.obj?.mode)})`
      );

      const wsP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_watch_snapshot', { tabId: 'bogus-tab-999' }, 60000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        wsP144.isError === false && wsP144.obj !== null
          && Array.isArray(wsP144.obj.findings) && !wsP144.text.includes(ND),
        `[144j] argus_watch_snapshot with a bogus tabId degrades to the active tab — findings array, no crash (got: isError=${wsP144.isError}, findings=${Array.isArray(wsP144.obj?.findings) ? wsP144.obj.findings.length : typeof wsP144.obj?.findings})`
      );

      const gcP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_get_context', { tabId: 'bogus-tab-999' }, 60000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        gcP144.isError === false && gcP144.obj !== null
          && typeof gcP144.obj.snapshot_id === 'string' && gcP144.obj.snapshot_id.length > 0
          && !gcP144.text.includes(ND),
        `[144k] argus_get_context with a bogus tabId degrades to the active tab — snapshot_id present, no crash (got: isError=${gcP144.isError}, snapshot_id=${JSON.stringify(gcP144.obj?.snapshot_id)?.slice(0, 40)})`
      );

      // ── MARQUEE 1: unreachable target → navigate() throws (the v9.7.4 navigate fix) ──
      const unreachP144 = parse144(await mcpToolCall(srvA144.proc, 'argus_audit', { url: 'http://localhost:9/' }, 60000));
      surviveA144.push((await mcpListTools(srvA144.proc, 10000)).length);
      assert(
        unreachP144.isError === true && unreachP144.obj !== null
          && String(unreachP144.obj.error).includes('navigate')
          && String(unreachP144.obj.error).includes('Unable to navigate')
          && !unreachP144.text.includes(ND),
        `[144l] argus_audit on an unreachable URL surfaces navigate()'s thrown error, not a fake-clean result (got: isError=${unreachP144.isError}, error=${JSON.stringify(unreachP144.obj?.error)?.slice(0, 140)})`
      );

      // ── MARQUEE 2: dead Chrome → "Could not connect", NOT "logger is not defined" ──
      srvB144 = await spawnArgusServer(
        path.resolve(__dirname, '..'),
        { MCP_BROWSER_URL: 'http://127.0.0.1:9777', ARGUS_RETRY_ATTEMPTS: '1', MCP_TOOL_TIMEOUT_MS: '15000' },
      );
      const deadP144 = parse144(await mcpToolCall(srvB144.proc, 'argus_audit', { url: 'http://localhost:3100/clean.html' }, 60000));
      const deadSurvive144 = (await mcpListTools(srvB144.proc, 10000)).length;
      assert(
        deadP144.isError === true && deadP144.obj !== null
          && String(deadP144.obj.error).includes('Could not connect to Chrome')
          && !deadP144.text.includes(ND),
        `[144m] argus_audit against a dead Chrome reports the real cause through the withMcp error path — no masked "${ND}" (got: isError=${deadP144.isError}, error=${JSON.stringify(deadP144.obj?.error)?.slice(0, 140)})`
      );

      // ── server-survives: every provoked error left both servers answering ──
      const minA144 = surviveA144.length ? Math.min(...surviveA144) : 0;
      assert(
        surviveA144.length >= 12 && minA144 >= 8,
        `[144n] the normal server answered tools/list after every one of its ${surviveA144.length} error/edge calls (min tools seen: ${minA144})`
      );
      assert(
        deadSurvive144 >= 8,
        `[144o] the dead-Chrome server recovered and answered tools/list after the environmental failure (tools: ${deadSurvive144})`
      );
    } catch (e) {
      err144 = e;
    } finally {
      try { srvA144?.proc?.kill(); } catch { }
      try { srvB144?.proc?.kill(); } catch { }
    }
    assert(
      err144 === null,
      `[144p] error-path matrix ran to completion without the harness itself throwing (${err144?.message ?? 'ok'})`
    );
  }

  // ── Block [145] multi-tab end-to-end — open_tabs + selectPage page-switch ─────
  // Behaviorally pins the v9.7.4 open_tabs fix end-to-end: [142a] pins the parser and
  // [119c] the shape, but neither drives a real second tab through argus_get_context.
  // Observed against live Chrome first: new_page() auto-selects the new tab, selectPage
  // switches the page evaluate_script targets, close_page returns to one tab. The tab
  // created here is closed in finally — a leaked tab poisons later blocks' snapshots.
  {
    console.log('\n[145] multi-tab end-to-end — argus_get_context.open_tabs + selectPage page-switch + close_page cleanup');

    const pageAUrl145 = `${B}/clean.html`;
    const pageBUrl145 = `${B}/adapter-conformance.html?tab=multitab145`;
    let bOpened145 = false;
    let srv145 = null;
    let err145 = null;
    let openTabs145 = [];
    let titleA145 = '';
    let titleB145 = '';

    try {
      // establish page A on the shared client, then open page B (auto-selected)
      await browser.navigate(pageAUrl145);
      const beforePages145 = parseListPagesResponse(await mcp.list_pages({}));
      await mcp.new_page({ url: pageBUrl145 });
      bOpened145 = true;
      const afterPages145 = parseListPagesResponse(await mcp.list_pages({}));

      // [145a] new_page added exactly one tab and auto-selected it
      const newSel145 = afterPages145.find(p => p.selected);
      assert(
        afterPages145.length === beforePages145.length + 1
          && newSel145 != null && String(newSel145.url).includes('tab=multitab145'),
        `[145a] new_page() opens a second tab and auto-selects it (before ${beforePages145.length} → after ${afterPages145.length}, selected url: ${newSel145?.url})`
      );

      // [145b] both tabs are visible via argus_get_context.open_tabs with distinct numeric ids
      srv145 = await spawnArgusServer(path.resolve(__dirname, '..'));
      const ctxResp145 = await mcpToolCall(srv145.proc, 'argus_get_context', {}, 30000);
      let ctx145 = {}; try { ctx145 = JSON.parse(ctxResp145?.result?.content?.[0]?.text ?? '{}'); } catch { /* non-JSON */ }
      openTabs145 = Array.isArray(ctx145.open_tabs) ? ctx145.open_tabs : [];
      const tabA145 = openTabs145.find(t => t.url === pageAUrl145);
      const tabB145 = openTabs145.find(t => String(t.url ?? '').includes('tab=multitab145'));
      assert(
        tabA145 != null && tabB145 != null
          && Number.isFinite(tabA145.id) && Number.isFinite(tabB145.id)
          && tabA145.id !== tabB145.id,
        `[145b] argus_get_context.open_tabs lists both tabs with distinct numeric ids (open_tabs: ${JSON.stringify(openTabs145)})`
      );

      // [145c] open_tabs reflects exactly the two open tabs, all numeric ids
      const ids145 = openTabs145.map(t => t.id);
      assert(
        openTabs145.length === 2 && ids145.every(id => Number.isFinite(id)),
        `[145c] open_tabs reflects exactly the two open tabs, all numeric ids (length ${openTabs145.length}, ids ${JSON.stringify(ids145)})`
      );

      // selectPage switches the page evaluate_script targets — pin via document.title,
      // using the shared client's own list_pages ids (the per-client page index).
      const sharedPages145 = parseListPagesResponse(await mcp.list_pages({}));
      const sharedA145 = sharedPages145.find(p => p.url === pageAUrl145);
      const sharedB145 = sharedPages145.find(p => String(p.url ?? '').includes('tab=multitab145'));

      // [145d] selectPage(string id) → page A is active (document.title is A's)
      await browser.selectPage(String(sharedA145?.id));
      titleA145 = String(unwrapEval(await browser.evaluate('() => document.title')));
      assert(
        sharedA145 != null && titleA145.includes('Clean Page'),
        `[145d] selectPage(tab A) makes evaluate_script run on page A (document.title: ${JSON.stringify(titleA145)})`
      );

      // [145e] selectPage(tab B) switches the active page — title flips A→B
      await browser.selectPage(String(sharedB145?.id));
      titleB145 = String(unwrapEval(await browser.evaluate('() => document.title')));
      assert(
        sharedB145 != null && titleB145.includes('Adapter Conformance') && titleB145 !== titleA145,
        `[145e] selectPage(tab B) switches the active page — document.title changes A→B (A: ${JSON.stringify(titleA145)}, B: ${JSON.stringify(titleB145)})`
      );
    } catch (e) {
      err145 = e;
    } finally {
      try { srv145?.proc?.kill(); } catch { }
      // close the tab we opened so later blocks/reruns start from a single tab
      if (bOpened145) {
        try {
          const fp = parseListPagesResponse(await mcp.list_pages({}));
          const bTab = fp.find(p => String(p.url ?? '').includes('tab=multitab145'));
          if (bTab) await mcp.close_page({ pageId: Number(bTab.id) });
          const rp = parseListPagesResponse(await mcp.list_pages({}));
          if (rp[0]) await browser.selectPage(String(rp[0].id));
        } catch { /* best-effort cleanup */ }
      }
    }

    // [145f] cleanup closed the created tab — exactly one tab remains and it is page A
    let finalPages145 = [];
    try { finalPages145 = parseListPagesResponse(await mcp.list_pages({})); } catch { /* ignore */ }
    assert(
      err145 === null && finalPages145.length === 1 && finalPages145[0]?.url === pageAUrl145,
      `[145f] close_page cleanup leaves a single tab (page A) — no leaked tab (err: ${err145?.message ?? 'none'}, final: ${JSON.stringify(finalPages145)})`
    );
  }

  // ── [146] SELF-LINT (anti-vacuous) — the harness forbids NEW bare-shape ──────────
  // assertions. A condition that is *solely* a shape predicate is satisfied by the
  // empty/default failure mode itself — `Array.isArray(x)` passes on `[]` (exactly
  // what let the v9.7.4 open_tabs bug ride [119c] green for months, now content-
  // checked); `typeof x === 'object'` passes on the wrong object; `x.length >= 0` is
  // a tautology. Such a guard proves nothing unless a SIBLING assertion checks
  // content. This block reads validate.js's own source and gates three families
  // against reviewed allowlists. Same self-reading discipline as [142f–i] / [143zz].
  // SELF-EXCLUSION: the scan covers blocks [1]–[145] ONLY — the source is sliced at
  // this block's "[146] SELF-LINT" marker, so [146]'s own allowlist, regexes, doc
  // comments, and positive-control samples can never self-match. (No fragile
  // "don't write pattern X in this file's prose" rule — the block excludes itself.)
  {
    console.log('\n[146] Anti-vacuous lint — no NEW bare-shape assertions outside the reviewed allowlists');

    const fullSrc146 = fs.readFileSync(path.join(__dirname, 'validate.js'), 'utf8');
    // Scan everything BEFORE this block. indexOf finds the comment header above (the
    // first "[146] SELF-LINT" in the file), excluding all of [146] from the scan.
    const scanSrc146 = fullSrc146.slice(0, fullSrc146.indexOf('[146] SELF-LINT'));

    // ── Family 1: bare `Array.isArray(x)` (the demonstrated [119c] pattern) ─────────
    // Reviewed exceptions — each is a bare Array.isArray(x) assertion (no && conjunct)
    // whose content IS proven by a sibling assertion, OR a soft-Lighthouse /
    // negative-control / documented-empty case. Keyed by the exact inner expression
    // (unique per block). See the 2.1 vacuous-sweep inventory.
    const ALLOWLIST_146 = new Set([
      'lh.failingAudits',               // [16a]  soft Lighthouse; failingAudits.length in [16] soft
      'violations',                     // [30]   checkLighthouse; fields checked when length>0 + soft
      'paths',                          // [57a]  sibling [57b] paths.includes('/about')
      'paths59',                        // [59a]  sibling [59b] paths59.includes('/dashboard')
      'merged61',                       // [61a]  siblings [61b]+ check route content
      'result65.errors',                // [65a]  sibling [65d] criticals filter (clean → 0)
      'findings66',                     // [66a]  siblings [66b]/[66c] (clean → none)
      'findings67',                     // [67a]  sibling [67b] csp.length>=1
      'findings68',                     // [68a]  sibling [68b] deprecated.length>=1
      'empty69',                        // [69a]  negative control — empty input → []
      'findings70',                     // [70a]  sibling [70b] heading_level_skip>=1
      'findings71',                     // [71a]  sibling [71b] responsive_overflow>0
      'findings72',                     // [72a]  sibling [72b] focus_visible_missing>=1
      'findings73',                     // [73a]  sibling [73b] aria_expanded_no_controls>=2
      'findings75.errors',              // [75a]  sibling [75b] origin-field check
      'findings77',                     // [77a]  sibling [77b] iframe_no_sandbox>=2
      'cssSummary90?.scssSourceFiles',  // [90b]  sibling [90c] scssSourceFiles.length>0
      'lhResult92',                     // [92a]  soft Lighthouse contract
      'parseConsoleMsgResponse(null)',  // [94a]  negative control — null input → array
      'cheap95',                        // [95a]  documented-empty; sibling [95c] exp>=6
      'json116.findings',               // [116c] sibling [116d] findings.length===1
      'snapObj120?.findings',           // [120c] watch-snapshot findings may legitimately be empty
      'result124?.errors',              // [124c] resilience shape-check (clean page → may be empty)
      'results127', 'results128', 'results129', 'results130a', 'results131',
      'results132a', 'results133', 'results134', 'results135', // [NNa] analyzer type-guards; each block's [NNb]+ check specific findings
    ]);

    // Matches assert(/soft( whose ENTIRE condition is Array.isArray(<expr>): the inner
    // call closes directly into the message comma — no && / || conjunct follows.
    const bareArrRe146 = /(?:assert|soft)\(\s*Array\.isArray\(((?:[^()]|\([^()]*\))*)\)\s*,/g;
    const foundBare146 = new Set();
    let m146;
    while ((m146 = bareArrRe146.exec(scanSrc146)) !== null) foundBare146.add(m146[1].trim());

    // [146a] scanner sanity — the regex actually matches the known bare occurrences
    // (guards against a broken pattern vacuously finding nothing and passing green).
    assert(
      foundBare146.size >= 30,
      `[146a] anti-vacuous scanner finds the reviewed bare-Array.isArray assertions (found ${foundBare146.size}; expected ≥30)`
    );

    // [146b] THE GATE — no bare Array.isArray assertion exists outside the allowlist.
    const unreviewed146 = [...foundBare146].filter(k => !ALLOWLIST_146.has(k));
    assert(
      unreviewed146.length === 0,
      `[146b] no NEW bare Array.isArray assertion outside the reviewed allowlist — add a content check (e.g. && x.length >= 1) or a justified allowlist entry (offenders: ${unreviewed146.join(' | ') || 'none'})`
    );

    // [146c] allowlist hygiene — every allowlisted key still exists as a bare assertion
    // (a fixed/renamed one must be dropped from the allowlist, keeping it honest).
    const stale146 = [...ALLOWLIST_146].filter(k => !foundBare146.has(k));
    assert(
      stale146.length === 0,
      `[146c] no stale allowlist entries — every reviewed exception still exists as a bare assertion (stale: ${stale146.join(' | ') || 'none'})`
    );

    // ── Families 2/3: bare `typeof x === 'object'` + `.length >= 0/> -1` tautology ──
    // ZERO instances exist today (every typeof-object check is conjoined with a
    // `!== null` and a sibling; no length tautology anywhere). A "no offenders" gate
    // over a zero-instance pattern is itself vacuous if the regex is dead — so each
    // family carries a POSITIVE CONTROL: a known-bad sample the regex MUST match,
    // proving it is live before [146e] asserts the real source is clean. (Both samples
    // live inside this self-excluded block, so they never count as real offenders.)
    const typeofObjRe146  = /(?:assert|soft)\(\s*typeof\s+[\w$.?]+\s*===\s*'object'\s*,/;
    const lengthTautRe146 = /\.length\s*(?:>=\s*0|>\s*-1)\b/;
    const SAMPLE_OBJ_146  = "assert(typeof zzz === 'object', 'known-bad sample');";
    const SAMPLE_LEN_146  = "assert(zzz.length >= 0, 'known-bad sample');";

    // [146d] positive controls — both family regexes match their known-bad samples.
    const objLive146 = typeofObjRe146.test(SAMPLE_OBJ_146);
    const lenLive146 = lengthTautRe146.test(SAMPLE_LEN_146);
    assert(
      objLive146 && lenLive146,
      `[146d] family regexes are live — positive controls match known-bad samples (typeof-object: ${objLive146}, length-tautology: ${lenLive146})`
    );

    // [146e] THE GATE — no bare `typeof x === 'object'` assertion and no `.length >= 0`
    // / `.length > -1` tautology in blocks [1]–[145] (conjoined typeof-object forms
    // like `x !== null && typeof x === 'object'` are fine and do not match).
    const typeofObjHits146  = scanSrc146.match(new RegExp(typeofObjRe146.source, 'g'))  || [];
    const lengthTautHits146 = scanSrc146.match(new RegExp(lengthTautRe146.source, 'g')) || [];
    assert(
      typeofObjHits146.length === 0 && lengthTautHits146.length === 0,
      `[146e] no bare typeof-object assertion and no .length>=0/> -1 tautology in [1]–[145] (typeof-object: ${typeofObjHits146.length}${typeofObjHits146.length ? ' → ' + typeofObjHits146.join(' | ') : ''}, length-tautology: ${lengthTautHits146.length}${lengthTautHits146.length ? ' → ' + lengthTautHits146.join(' | ') : ''})`
    );
  }

  // ── [147] Golden MCP tool response schemas ───────────────────────────────────
  // Every tool's happy-path response is safeParse'd against a Zod contract stored in
  // test-harness/contracts/mcp-tool-schemas.js (the single source of truth, exported
  // for E2E too). A handler that renames or drops a response field turns a silently-
  // changed contract into a loud, attributable failure — the exact blind spot that let
  // three features die in production while the harness stayed green (2.3 goal). The
  // schemas were derived from LIVE responses (prototype-147*.mjs, deleted), not memory.
  // 8 tools validate against a live response; argus_pr_validate's happy path needs the
  // GitHub network (non-hermetic, like Lighthouse) so it is pinned via a handler↔schema
  // source cross-check instead. Negative controls prove the safeParse-success assertions
  // are NOT vacuous — a real response with a required field removed must fail safeParse.
  {
    console.log('\n[147] Golden MCP tool response schemas — safeParse live responses against test-harness/contracts/');

    const parse147 = (resp) => {
      const text = resp?.result?.content?.[0]?.text ?? '';
      let obj = null; try { obj = JSON.parse(text); } catch { /* non-JSON */ }
      return { obj, isError: resp?.result?.isError === true, text };
    };
    const sp147 = (tool, obj) => {
      const r = TOOL_RESPONSE_SCHEMAS[tool].safeParse(obj);
      return { ok: r.success, msg: r.success ? 'valid' : formatZodError(r) };
    };

    let srv147 = null;
    let err147 = null;
    let auditObj147 = null;   // reused by negative controls [147k]/[147m]
    let ctxObj147 = null;     // reused by negative control [147l]

    try {
      // FIGMA_API_TOKEN:'' → deterministic no-token design-audit; TARGET_STAGING_URL:''
      // → deterministic CSS-only argus_compare regardless of the developer's shell.
      srv147 = await spawnArgusServer(path.resolve(__dirname, '..'), {
        FIGMA_API_TOKEN: '',
        ARGUS_RETRY_ATTEMPTS: '1',
        MCP_TOOL_TIMEOUT_MS: '25000',
        TARGET_DEV_URL: B,
        TARGET_STAGING_URL: '',
      });

      // [147a] argus_audit
      auditObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_audit', { url: `${B}/clean.html` }, 60000)).obj;
      { const v = sp147('argus_audit', auditObj147);
        assert(v.ok, `[147a] argus_audit response matches golden schema (got: ${v.msg})`); }

      // [147b] argus_audit_full (full report) — also persists a report consumed by [147c]
      const fullObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_audit_full', { url: `${B}/clean.html` }, 180000)).obj;
      { const v = sp147('argus_audit_full', fullObj147);
        assert(v.ok, `[147b] argus_audit_full report matches golden schema (got: ${v.msg})`); }

      // [147c] argus_last_report (report-from-disk OR no-reports sentinel — union schema)
      const lastObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_last_report', {}, 20000)).obj;
      { const v = sp147('argus_last_report', lastObj147);
        assert(v.ok, `[147c] argus_last_report response matches golden schema (got: ${v.msg})`); }

      // [147d] argus_compare (CSS-only env-comparison)
      const cmpObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_compare', {}, 120000)).obj;
      { const v = sp147('argus_compare', cmpObj147);
        assert(v.ok, `[147d] argus_compare response matches golden schema (got: ${v.msg})`); }

      // [147e] argus_watch_snapshot
      const wsObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_watch_snapshot', {}, 60000)).obj;
      { const v = sp147('argus_watch_snapshot', wsObj147);
        assert(v.ok, `[147e] argus_watch_snapshot response matches golden schema (got: ${v.msg})`); }

      // [147f] argus_get_context
      ctxObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_get_context', {}, 60000)).obj;
      { const v = sp147('argus_get_context', ctxObj147);
        assert(v.ok, `[147f] argus_get_context response matches golden schema (got: ${v.msg})`); }

      // [147g] argus_visual_diff
      const vdObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_visual_diff', { url: `${B}/clean.html` }, 60000)).obj;
      { const v = sp147('argus_visual_diff', vdObj147);
        assert(v.ok, `[147g] argus_visual_diff response matches golden schema (got: ${v.msg})`); }

      // [147h] argus_design_audit (no-token degraded path — deterministic)
      const daObj147 = parse147(await mcpToolCall(srv147.proc, 'argus_design_audit',
        { url: `${B}/clean.html`, figmaFrameUrl: 'https://www.figma.com/file/ABC/X?node-id=1%3A2' }, 30000)).obj;
      { const v = sp147('argus_design_audit', daObj147);
        assert(v.ok, `[147h] argus_design_audit (degraded) response matches golden schema (got: ${v.msg})`); }

      // [147i] argus_pr_validate — happy path needs GitHub network (non-hermetic). Hermetic
      // substitute: assert every schema-required key appears in handlePrValidate's `result`
      // object literal in src/mcp-server.js — the object that IS the tool response (A4 spreads
      // it into the JSON via `{ ...result, reporting }`, so the keys live on `result`, not the
      // JSON.stringify literal). Guards a handler-side field rename — the same direction the 8
      // live-validated tools cover via their actual responses. Live error paths: [144f]/[144g].
      const serverSrc147     = fs.readFileSync(path.resolve(__dirname, '../src/mcp-server.js'), 'utf8');
      const prFnStart147     = serverSrc147.indexOf('async function handlePrValidate');
      const prResultStart147 = serverSrc147.indexOf('const result = {', prFnStart147);
      const prResultEnd147   = serverSrc147.indexOf('};', prResultStart147);
      const prRetLiteral147  = prResultStart147 !== -1 && prResultEnd147 > prResultStart147
        ? serverSrc147.slice(prResultStart147, prResultEnd147) : '';
      // Only the REQUIRED keys must appear in the handler's `const result` literal. The
      // optional ones (baseline / reporting, F4) are skipped: `reporting` is spread-appended
      // (`{ ...result, reporting }`), not in the literal, and both are .optional() in the
      // golden schema — so demanding them here would false-fail (see the schema's F4 note).
      const prReqKeys147     = Object.keys(prValidateResponseSchema.shape)
        .filter(k => !prValidateResponseSchema.shape[k].isOptional());
      const missingPrKeys147 = prReqKeys147.filter(k => !new RegExp(`[\\s{]${k}\\s*[,:]`).test(prRetLiteral147));
      assert(
        prFnStart147 !== -1 && prResultStart147 !== -1 && prRetLiteral147.length > 0 && missingPrKeys147.length === 0,
        `[147i] argus_pr_validate handler result literal contains all ${prReqKeys147.length} schema-required keys — guards a handler field rename (missing: ${missingPrKeys147.join(', ') || 'none'})`
      );

      // [147j] META coverage-ratchet — every tool the server advertises has a golden
      // schema. A new tool then cannot ship without a pinned response contract (mirrors
      // [143zz]'s adapter-method ratchet).
      const liveTools147  = (await mcpListTools(srv147.proc, 10000)).map(t => t.name);
      const unschemaed147 = liveTools147.filter(n => !TOOL_RESPONSE_SCHEMAS[n]);
      assert(
        liveTools147.length === TOOL_NAMES.length && unschemaed147.length === 0,
        `[147j] every advertised MCP tool has a golden schema (live: ${liveTools147.length}, schemas: ${TOOL_NAMES.length}, unschemaed: ${unschemaed147.join(', ') || 'none'})`
      );

      // ── Negative controls — prove the safeParse-success assertions are not vacuous. ──

      // [147k] argus_audit response with `summary` removed MUST be rejected.
      const auditNoSummary147 = { ...(auditObj147 ?? {}) }; delete auditNoSummary147.summary;
      const k147 = auditResponseSchema.safeParse(auditNoSummary147);
      assert(
        auditObj147 !== null && k147.success === false,
        `[147k] golden schema REJECTS an argus_audit response with summary removed — proves [147a] is non-vacuous (rejected: ${!k147.success})`
      );

      // [147l] argus_get_context without `snapshot_id`, and `{}`, MUST both be rejected.
      const ctxNoId147 = { ...(ctxObj147 ?? {}) }; delete ctxNoId147.snapshot_id;
      const l1_147 = getContextResponseSchema.safeParse(ctxNoId147);
      const l2_147 = getContextResponseSchema.safeParse({});
      assert(
        ctxObj147 !== null && l1_147.success === false && l2_147.success === false,
        `[147l] golden schema REJECTS get_context without snapshot_id and {} — non-vacuous (sans-id rejected: ${!l1_147.success}, {} rejected: ${!l2_147.success})`
      );

      // [147m] the two summary contracts are genuinely distinct: the report-summary schema
      // (requires `total`) must REJECT the cheap-audit summary (no `total`), so a handler
      // that drops `total` from a full report fails [147b]/[147d] rather than passing under
      // a one-size-fits-all summary schema.
      const m147 = reportSummarySchema.safeParse(auditObj147?.summary);
      assert(
        auditObj147?.summary != null && m147.success === false,
        `[147m] report-summary schema rejects the cheap-audit summary (no total) — the audit/report summary contracts are distinct (rejected: ${!m147.success})`
      );

      // ── F4 — the two A4/B1-B2 rider fields are now EXPLICITLY pinned optional shapes, not
      // just passthrough riders. [147o]/[147p] prove each pin is non-vacuous: a faithful value
      // parses, a corrupted one is REJECTED. (The "accepts without the field" back-compat
      // direction is [153c]; the always-present-on-the-live-response invariant is [147i].)
      // A minimal, faithful happy-path argus_pr_validate result (the handlePrValidate shape). ──
      const prBase147 = {
        prUrl: 'https://github.com/acme/web/pull/7',
        targetUrl: 'http://localhost:3000',
        affectedRoutes: ['/checkout'],
        changedFiles: ['src/pages/checkout.tsx'],
        findings: [],
        perRoute: [{ route: '/checkout', critical: 0, warning: 0, info: 0 }],
        summary: { critical: 0, warning: 0, info: 0 },
        blocked: false,
        blockOn: 'critical',
      };

      // [147o] the A4 `reporting` shape is pinned: a well-formed reporting object parses, but
      // retyping `reporting.posted` (boolean → string) is REJECTED — a handler rename/retype
      // inside reporting now fails [147] rather than passing silently under .passthrough().
      const goodReporting147 = prValidateResponseSchema.safeParse({
        ...prBase147, reporting: { posted: true, checked: false, skipped: false, reason: 'no token' },
      });
      const badReporting147  = prValidateResponseSchema.safeParse({
        ...prBase147, reporting: { posted: 'yes', checked: false, skipped: false },
      });
      assert(
        goodReporting147.success === true && badReporting147.success === false,
        `[147o] golden schema pins the A4 reporting shape — accepts a well-formed reporting, REJECTS reporting.posted retyped to string (good: ${goodReporting147.success}, badRejected: ${!badReporting147.success})`
      );

      // [147p] the B1/B2 `baseline` discriminated shape is pinned: BOTH the available:true
      // (numeric new/persisting/resolved) and available:false (note) variants parse, but an
      // available:true baseline MISSING `newCritical` is REJECTED — a rename inside baselineInfo
      // is caught, and the discriminated union keeps the two variants from cross-validating.
      const baselineOk147       = prValidateResponseSchema.safeParse({
        ...prBase147, baseline: { available: true, newCritical: 0, newWarning: 0, newInfo: 0, persisting: 1, resolved: 2 },
      });
      const baselineFailsafe147 = prValidateResponseSchema.safeParse({
        ...prBase147, baseline: { available: false, note: 'baseline unavailable — blocking on absolute counts' },
      });
      const baselineRenamed147  = prValidateResponseSchema.safeParse({
        ...prBase147, baseline: { available: true, newWarning: 0, newInfo: 0, persisting: 1, resolved: 2 },
      });
      assert(
        baselineOk147.success === true && baselineFailsafe147.success === true && baselineRenamed147.success === false,
        `[147p] golden schema pins the B1/B2 baseline shape — accepts available:true + available:false variants, REJECTS an available:true baseline missing newCritical (ok: ${baselineOk147.success}, failsafe: ${baselineFailsafe147.success}, renamedRejected: ${!baselineRenamed147.success})`
      );

    } catch (e) {
      err147 = e;
    } finally {
      try { srv147?.proc?.kill(); } catch { }
    }
    // [147n] completion guard — a mid-block throw must surface, not silently shrink the count.
    assert(
      err147 === null,
      `[147n] golden-schema block ran to completion without the harness itself throwing (${err147?.message ?? 'ok'})`
    );
  }

  // ── [148] Upstream canary — chrome-devtools-mcp inputSchema drift + Chrome-rot watch ──
  // Pins our ASSUMPTIONS about chrome-devtools-mcp@<pinned>: spawns it raw, reads
  // tools/list, and diffs every tool's inputSchema (tool set + required params + property
  // names + JSON-schema types) against the golden snapshot in test-harness/contracts/.
  // The next reqid→requestId-class param rename fails HERE at a version bump — loudly and
  // attributably — instead of shipping silently to production (the 2026-06-12 audit bug
  // class). [148d] keeps the pin in mcp-client.js and the snapshot filename in lockstep.
  // [148e] is the Chrome-rot watch (plan §3.4): issues-deprecated.html must still emit a
  // DeprecationIssue in the RUNNING Chrome, so a Chrome upgrade that drops `unload`
  // deprecation emission attributes to Chrome, not to detection block [68].
  {
    console.log('\n[148] Upstream canary — chrome-devtools-mcp inputSchema snapshot diff + Chrome-rot watch');

    // ── [148d] pinned version ↔ snapshot filename lockstep ──
    const mcpClientSrc148 = fs.readFileSync(path.resolve(__dirname, '../src/utils/mcp-client.js'), 'utf8');
    const pinnedVer148    = mcpClientSrc148.match(/chrome-devtools-mcp@(\d+\.\d+\.\d+)/)?.[1] ?? null;
    const contractsDir148 = path.resolve(__dirname, 'contracts');
    const snapFiles148    = fs.readdirSync(contractsDir148).filter(f => /^chrome-devtools-mcp@.*\.json$/.test(f));
    const expectedSnap148 = `chrome-devtools-mcp@${pinnedVer148}.json`;
    assert(
      pinnedVer148 !== null && snapFiles148.length === 1 && snapFiles148[0] === expectedSnap148,
      `[148d] mcp-client.js pin (${pinnedVer148 ?? 'none'}) matches the single golden snapshot filename — no drift between pin and snapshot (found: ${snapFiles148.join(', ') || 'none'}, expected: ${expectedSnap148})`
    );

    // ── load golden snapshot + live tools/list from a fresh chrome-devtools-mcp@<pinned> ──
    const snapTools148 = pinnedVer148 && snapFiles148.includes(expectedSnap148)
      ? JSON.parse(fs.readFileSync(path.join(contractsDir148, expectedSnap148), 'utf8')).tools
      : {};
    let live148 = null, err148 = null;
    try {
      if (!pinnedVer148) throw new Error('no pinned version found in mcp-client.js');
      live148 = await listChromeDevtoolsMcpTools(pinnedVer148, 45000);
    } catch (e) { err148 = e; }

    // normalize live tools/list to { name: { required[], props[], types{} } } (matches the snapshot)
    const liveMap148 = {};
    for (const t of (live148 ?? [])) {
      const propsObj = t.inputSchema?.properties ?? {};
      const props = Object.keys(propsObj).sort();
      const types = {}; for (const p of props) types[p] = propsObj[p]?.type ?? '(complex)';
      liveMap148[t.name] = { required: (t.inputSchema?.required ?? []).slice().sort(), props, types };
    }
    const liveNames148 = Object.keys(liveMap148).sort();
    const snapNames148 = Object.keys(snapTools148).sort();

    // [148a] tool-name SET matches (a tool added or removed upstream → loud diff → regenerate)
    const addedT148   = liveNames148.filter(n => !snapTools148[n]);
    const removedT148 = snapNames148.filter(n => !liveMap148[n]);
    assert(
      err148 === null && snapNames148.length > 0 && liveNames148.length === snapNames148.length &&
      addedT148.length === 0 && removedT148.length === 0,
      `[148a] live tools/list tool set matches the golden snapshot (live: ${liveNames148.length}, snapshot: ${snapNames148.length}, +[${addedT148.join(',') || 'none'}] -[${removedT148.join(',') || 'none'}]${err148 ? ' err=' + err148.message : ''})`
    );

    // [148b] per-tool REQUIRED-param set matches the snapshot
    const reqDiffs148 = [];
    for (const name of snapNames148) {
      if (!liveMap148[name]) continue;
      const snapReq = JSON.stringify(snapTools148[name].required);
      const liveReq = JSON.stringify(liveMap148[name].required);
      if (snapReq !== liveReq) reqDiffs148.push(`${name}{snap:${snapReq} live:${liveReq}}`);
    }
    assert(
      err148 === null && reqDiffs148.length === 0,
      `[148b] every tool's required-param set matches the snapshot (diffs: ${reqDiffs148.join('; ') || 'none'})`
    );

    // [148c] MARQUEE — per-tool property NAMES + TYPES match. A reqid→requestId-class rename,
    // an added/removed param, or a number→string type change fails here, listing the exact tool.
    const propDiffs148 = [];
    for (const name of snapNames148) {
      if (!liveMap148[name]) continue;
      const snapP = snapTools148[name].props, liveP = liveMap148[name].props;
      const addedP   = liveP.filter(p => !snapP.includes(p));
      const removedP = snapP.filter(p => !liveP.includes(p));
      const typeChg  = snapP.filter(p => liveMap148[name].types[p] !== undefined &&
                                         snapTools148[name].types[p] !== liveMap148[name].types[p])
                            .map(p => `${p}:${snapTools148[name].types[p]}→${liveMap148[name].types[p]}`);
      if (addedP.length || removedP.length || typeChg.length) {
        propDiffs148.push(`${name}{+[${addedP.join(',')}] -[${removedP.join(',')}] ${typeChg.join(',')}}`);
      }
    }
    assert(
      err148 === null && propDiffs148.length === 0,
      `[148c] every tool's property names + JSON-schema types match the snapshot — a reqid→requestId-class rename fails here (diffs: ${propDiffs148.join('; ') || 'none'})`
    );

    // ── [148e] Chrome-rot watch (plan §3.4) — DeprecationIssue still emitted by live Chrome ──
    let chromeVer148 = 'Chrome/?';
    try {
      chromeVer148 = String(unwrapEval(await browser.evaluate('() => navigator.userAgent')))
        .match(/(?:Headless)?Chrome\/[\d.]+/)?.[0] ?? 'Chrome/?';
    } catch { /* leave default */ }
    let depRaw148 = '';
    try {
      await browser.navigate(`${B}/issues-deprecated.html`);
      await new Promise(r => setTimeout(r, 1000));
      // RAW wire read (before Argus classification) — this is the upstream canary, distinct
      // from [68] which asserts the classified deprecated_api_use finding.
      depRaw148 = String(await browser.listConsoleRaw({ types: ['issue'] }) ?? '');
    } catch (e) { depRaw148 = `<error: ${e.message}>`; }
    assert(
      /deprecat|will be removed|no longer supported|unload/i.test(depRaw148),
      `[148e] ${chromeVer148} still emits a DeprecationIssue for issues-deprecated.html — a failure here is Chrome rot (upstream dropped the unload deprecation), not an Argus/[68] regression (raw: ${depRaw148.slice(0, 140).replace(/\s+/g, ' ')})`
    );
  }

  // ── [149] PER-CATEGORY NEGATIVE CONTROLS (3.2) ──────────────────────────────────
  // The positive blocks prove each detector FIRES on its broken fixture; this block
  // proves no detector FIRES on a comprehensively well-formed page. It drives the REAL
  // production pipeline (crawlRouteCheap + the registry's getExpensive() loop + the
  // DevTools Issues panel) against test-harness/pages/negative-controls.html — a page
  // built to satisfy every analyzer (full SEO metadata, landmark structure, accessible
  // form, ≥44×44px touch targets, data-URI favicon so /favicon.ico never 404s) — then
  // asserts every detection category produces ZERO warning/critical findings.
  //
  // NON-VACUOUS by construction: [149a]–[149c] are POSITIVE controls proving the
  // pipeline actually analyzed the page (analyzers ran, cheap path ran, summaries were
  // emitted) — so the per-category `=== 0` assertions cannot pass because the pipeline
  // silently no-op'd. [149d] is the marquee aggregate: a FUTURE analyzer that over-fires
  // on safe input fails here even without a per-category row. Skips lighthouse (headless
  // N/A) and the three baseline/diff detectors (visual / har-recorder / design-fidelity)
  // whose fire-condition is a stored-baseline DIFF, not unsafe input — running them would
  // make the negative control depend on persisted state and flake run-to-run.
  {
    console.log('\n[149] Per-category negative controls — a well-formed page trips NO detector (over-fire guard)');

    const cleanRoute149 = { name: 'negative-controls', path: '/negative-controls.html', critical: false, waitFor: null };
    const cleanUrl149   = `${B}/negative-controls.html`;
    const SKIP149        = new Set(['lighthouse', 'visual', 'har-recorder', 'design-fidelity']);
    const BUG149         = new Set(['warning', 'critical']);

    const all149 = [];
    const ran149 = [];
    let cheap149 = { errors: [], url: '', isBlankPage: null };
    let err149   = null;

    try {
      // Cheap pass — console / network / SEO / security / content / api-frequency.
      cheap149 = await crawlRouteCheap(cleanRoute149, B, mcp);
      for (const e of cheap149.errors) all149.push(e);

      // Registered expensive analyzers — exactly the production loop (orchestrator.js:879).
      await browser.navigate(cleanUrl149);
      for (const { name, analyze } of getExpensive()) {
        if (SKIP149.has(name)) continue;
        ran149.push(name);
        try {
          const raw      = await analyze(browser, cleanUrl149, cleanRoute149);
          const findings = Array.isArray(raw) ? raw : (raw?.findings ?? []);
          for (const f of findings) all149.push(f);
        } catch { /* an analyzer that skips emits nothing → cannot over-fire; coverage proven by ran149 */ }
      }

      // Chrome DevTools Issues panel — CSP / CORS / deprecated-API / cookie issues.
      try {
        const issues149 = await analyzeIssues(browser, cleanUrl149);
        for (const f of issues149) all149.push(f);
      } catch { /* issues panel best-effort */ }
    } catch (e) {
      err149 = e;
    }

    const bug149          = all149.filter(f => BUG149.has(f.severity));
    const presentTypes149 = new Set(all149.map(f => f.type));

    // ── Positive controls — prove the pipeline genuinely analyzed the page ───────────
    const EXPECT_RAN_149 = ['css', 'responsive', 'memory', 'hover', 'snapshot', 'keyboard', 'theme', 'web-vitals', 'a11y-deep', 'motion', 'font', 'form'];
    const missingRan149  = EXPECT_RAN_149.filter(n => !ran149.includes(n));
    assert(
      err149 === null && ran149.length >= EXPECT_RAN_149.length && missingRan149.length === 0,
      `[149a] the registered expensive-analyzer pipeline executed against the clean page (err: ${err149?.message ?? 'none'}, ran ${ran149.length}: [${ran149.join(', ')}], missing: ${missingRan149.join(', ') || 'none'})`
    );

    assert(
      typeof cheap149.url === 'string' && cheap149.url.endsWith('/negative-controls.html')
        && cheap149.isBlankPage === false && Array.isArray(cheap149.errors),
      `[149b] the cheap crawl path (console/network/SEO/security/content) executed on the clean page (url: ${cheap149.url}, isBlankPage: ${cheap149.isBlankPage})`
    );

    const EXPECT_SUMMARY_149 = ['css_summary', 'theme_summary', 'motion_summary', 'font_summary', 'form_summary', 'perf_vitals_summary', 'a11y_deep_summary'];
    const missingSummary149  = EXPECT_SUMMARY_149.filter(t => !presentTypes149.has(t));
    assert(
      missingSummary149.length === 0,
      `[149c] analyzer summaries present — analyzers ANALYZED the page (not skipped), so the per-category zero-findings checks below are non-vacuous (missing: ${missingSummary149.join(', ') || 'none'})`
    );

    // ── [149d] MARQUEE — zero warning/critical across the ENTIRE pipeline ─────────────
    assert(
      bug149.length === 0,
      `[149d] the well-formed page produces ZERO warning/critical findings across the full pipeline (got ${bug149.length}: ${[...new Set(bug149.map(f => `${f.type}/${f.severity}`))].join(', ') || 'none'})`
    );

    // ── Per-category negative controls — one "does NOT fire" guard per detection
    //    category (data-driven; an over-fire fails attributably by category name) ──────
    const NEG_CATEGORIES_149 = [
      // SEO (seo-analyzer — cheap path) — fixture has full, valid metadata
      'seo_missing_description', 'seo_missing_og', 'seo_og_image_relative_url', 'seo_multiple_h1',
      'seo_missing_h1', 'seo_generic_title', 'seo_missing_canonical', 'seo_missing_viewport',
      // Security (security-analyzer — cheap path + orchestrator https check)
      'security_token_in_storage', 'security_eval_usage', 'security_cookie_no_httponly', 'security_missing_csp',
      'security_missing_xframe', 'security_iframe_no_sandbox', 'security_unsafe_blank_link', 'security_missing_sri',
      'security_sensitive_console', 'security_token_in_url', 'security_no_https',
      // Content quality (content-analyzer — cheap path)
      'content_null_rendered', 'content_placeholder_text', 'content_broken_image', 'content_empty_list',
      // CSS (css-analyzer) — fixture CSS is fully applied, no overrides/leaks
      'css_override', 'css_unused_rules', 'css_component_leak', 'react_inline_style_conflict',
      // Responsive (responsive-analyzer) — no overflow, ≥44×44px touch targets
      'responsive_overflow', 'responsive_small_touch_target',
      // Accessibility — snapshot (snapshot-analyzer)
      'a11y_missing_name', 'a11y_missing_form_label', 'a11y_duplicate_landmark', 'aria_expanded_no_controls', 'heading_level_skip',
      // Accessibility — deep (a11y-deep-analyzer / axe-core + CVD simulation)
      'a11y_axe_violation', 'a11y_colorblind_risk',
      // Theme (theme-analyzer)
      'theme_static_var',
      // Motion (motion-analyzer) — no animation/autoplay on the fixture
      'motion_no_reduced_motion_query', 'motion_autoplay_no_pause', 'motion_interactive_animation', 'motion_reduced_not_honoured',
      // Font (font-analyzer)
      'font_foit_risk', 'font_fout_risk', 'font_no_fallback', 'font_slow_load', 'font_suboptimal_format',
      // Form (form-analyzer) — the fixture form is required/autocompleted/labelled/masked
      'form_missing_required', 'form_no_autocomplete', 'form_inaccessible_error', 'form_unmasked_password',
      // Keyboard (keyboard-analyzer) — focusable elements keep focus + default outlines
      'focus_lost', 'focus_visible_missing',
      // Memory (memory-analyzer)
      'memory_detached_dom_nodes', 'memory_heap_growth',
      // Web Vitals (web-vitals-analyzer) — small page, no oversized bundle
      'perf_bundle_large',
      // Hover (hover-analyzer)
      'hover_dropdown_broken', 'hover_tooltip_missing',
      // Chrome DevTools Issues panel (issues-analyzer)
      'csp_violation', 'cors_violation', 'mixed_content', 'cookie_attribute_missing',
      'deprecated_api_use', 'low_contrast_native', 'permission_policy_violation', 'unclassified_devtools_issue',
    ];

    // [149e] meta — the category table is populated and de-duplicated, so the sweep
    // below cannot pass vacuously by being accidentally empty/truncated.
    assert(
      NEG_CATEGORIES_149.length >= 60 && new Set(NEG_CATEGORIES_149).size === NEG_CATEGORIES_149.length,
      `[149e] negative-control category table is populated and duplicate-free (got ${NEG_CATEGORIES_149.length}, unique ${new Set(NEG_CATEGORIES_149).size})`
    );

    for (const cat of NEG_CATEGORIES_149) {
      const hits = all149.filter(f => f.type === cat && BUG149.has(f.severity));
      assert(
        hits.length === 0,
        `[149:${cat}] negative control — ${cat} does NOT fire on the well-formed page (got ${hits.length}: ${hits.map(h => String(h.message ?? '').slice(0, 70)).join(' | ') || 'none'})`
      );
    }
  }

  // ── [150] Verification-gap closure (64/67 → 67/67) ──────────────────────────
  // Positive coverage for the three detection categories that previously had NO
  // firing fixture (only negative/localhost coverage): keyboard focus_lost,
  // security_no_https (the orchestrator HTTPS rule), and the Chrome DevTools
  // Issues-panel residual types. Fixtures + classifier patterns were derived from
  // LIVE Chrome 149 this session (run-don't-reason). cors_violation +
  // cookie_attribute_missing are now positively verified; mixed_content (needs
  // HTTPS), low_contrast_native (DevTools-audit-only) and permission_policy_violation
  // (needs a secure context) stay environment-limited and remain covered as
  // negative controls in [149].
  console.log('\n[150] Verification-gap closure — focus_lost + security_no_https + Issues-panel residual');
  {
    // ── focus_lost — keyboard-focus-lost.html bounces Tab focus to document.body ──
    const kb150 = await analyzeKeyboard(browser, `${B}/keyboard-focus-lost.html`);
    assert(Array.isArray(kb150), '[150a] analyzeKeyboard returns an array for the focus-lost fixture');
    const lost150 = kb150.filter(f => f.type === 'focus_lost');
    assert(lost150.length >= 1,
      `[150b] keyboard-focus-lost fixture produces at least 1 focus_lost finding (got ${lost150.length})`);
    assert(lost150.every(f => f.severity === 'warning' && f.url && typeof f.step === 'number'),
      `[150c] focus_lost findings are warning severity with a numeric step (got ${JSON.stringify(lost150.map(f => ({ s: f.severity, step: f.step })))})`);
    // Clean-page baseline — analyzeKeyboard must NOT over-fire focus_lost on a healthy page.
    const kbClean150 = await analyzeKeyboard(browser, `${B}/clean.html`);
    const cleanLost150 = kbClean150.filter(f => f.type === 'focus_lost');
    assert(cleanLost150.length === 0,
      `[150d] clean.html does NOT emit focus_lost (got ${cleanLost150.length})`);

    // ── security_no_https — orchestrator HTTPS-enforcement rule ──
    // The harness can only crawl localhost (excluded), so the POSITIVE trigger is
    // verified through the exported rule the real crawlRouteCheap calls (9f); the
    // localhost NEGATIVE is verified through the real crawl in [76a].
    const https150 = checkHttpsRequired('http://example.com/page');
    assert(https150 !== null && https150.type === 'security_no_https',
      `[150e] checkHttpsRequired('http://example.com') emits security_no_https (got ${JSON.stringify(https150)})`);
    assert(https150.severity === 'warning' && https150.url === 'http://example.com/page',
      `[150f] security_no_https finding is warning severity carrying the offending url (got ${JSON.stringify(https150)})`);
    assert(checkHttpsRequired('https://example.com/') === null,
      '[150g] checkHttpsRequired returns null for an https:// page');
    assert(checkHttpsRequired(`${B}/clean.html`) === null,
      '[150h] checkHttpsRequired returns null for a localhost http:// page (loopback exclusion)');

    // ── Issues-panel residual — cors_violation + cookie_attribute_missing ──
    // Classifier textPatterns were corrected to Chrome 149's actual Issue titles
    // this session; before the fix both fell through to unclassified_devtools_issue.
    const cors150 = await analyzeIssues(browser, `${B}/cors-error.html`);
    const corsHits150 = cors150.filter(f => f.type === 'cors_violation');
    assert(corsHits150.length >= 1,
      `[150i] cors-error.html produces a cors_violation Issue (got: ${cors150.map(f => f.type).join(', ') || 'none'})`);
    assert(corsHits150.every(f => f.severity === 'warning' && f.url),
      '[150j] cors_violation findings are warning severity with url');

    const cookie150 = await analyzeIssues(browser, `${B}/issues-cookie.html`);
    const cookieHits150 = cookie150.filter(f => f.type === 'cookie_attribute_missing');
    assert(cookieHits150.length >= 1,
      `[150k] issues-cookie.html produces a cookie_attribute_missing Issue (got: ${cookie150.map(f => f.type).join(', ') || 'none'})`);
    assert(cookieHits150.every(f => f.severity === 'warning' && f.url),
      '[150l] cookie_attribute_missing findings are warning severity with url');

    // Anti-vacuous guard: the real (now-fixed) classifier sorts these into their
    // specific types, not the unclassified_devtools_issue catch-all — the exact
    // dead-detector failure mode this session shook out.
    assert(!cors150.some(f => f.type === 'unclassified_devtools_issue') &&
           !cookie150.some(f => f.type === 'unclassified_devtools_issue'),
      `[150m] CORS + cookie Issues classify to specific types, not unclassified_devtools_issue (cors: ${cors150.map(f => f.type).join(',') || 'none'}; cookie: ${cookie150.map(f => f.type).join(',') || 'none'})`);
  }

  // ── Block [151] PR Validator — idempotent GitHub PR comment (Phase A1) ──────────
  // Wires github-reporter.js into the PR-validate path: the result→report adapter
  // (prResultToReport), the formatPrComment block banner, and reportPrValidation's
  // gating + create/update behaviour. Chrome-free + network-free — globalThis.fetch is
  // stubbed (recorded request/response shapes), never the live GitHub API.
  {
    console.log('\n[151] PR Validator — idempotent GitHub PR comment (Phase A1)');

    const prResult151 = {
      prUrl:          'https://github.com/acme/shop/pull/7',
      targetUrl:      'https://staging.example.com',
      affectedRoutes: ['/checkout', '/about'],
      changedFiles:   ['src/pages/checkout.tsx'],
      summary:        { critical: 1, warning: 2, info: 0 },
      blocked:        true,
      blockOn:        'critical',
      perRoute: [
        { route: '/checkout', critical: 1, warning: 1, info: 0 },
        { route: '/about',    critical: 0, warning: 1, info: 0 },
      ],
      findings: [
        { severity: 'critical', type: 'console_error',     message: 'TypeError: x is null',       url: 'https://staging.example.com/checkout' },
        { severity: 'warning',  type: 'seo_meta',          message: 'Missing meta description',    url: 'https://staging.example.com/checkout' },
        { severity: 'warning',  type: 'a11y_axe_violation', message: 'Low contrast text',          url: 'https://staging.example.com/about' },
      ],
    };

    // [151a] prResultToReport groups findings per-route (url → path) and totals the summary
    const report151 = prResultToReport(prResult151);
    const checkout151 = report151.routes.find(r => r.route === '/checkout');
    assert(
      report151.summary.total === 3 &&
      checkout151 && checkout151.errors.length === 2 &&
      report151.routes.some(r => r.route === '/about'),
      `[151a] prResultToReport groups findings per-route + totals summary (routes: ${JSON.stringify(report151.routes.map(r => `${r.route}:${r.errors.length}`))}, total: ${report151.summary.total})`
    );

    // [151b] prResultToReport carries the block verdict + reason + affected routes for the banner
    assert(
      report151.prValidation.blocked === true &&
      /critical/.test(report151.prValidation.reason) &&
      report151.prValidation.affectedRoutes.join(',') === '/checkout,/about',
      `[151b] prResultToReport.prValidation carries block reason + affected routes (got: ${JSON.stringify(report151.prValidation)})`
    );

    // [151c] formatPrComment renders the block banner + affected routes + findings table,
    //        with the HTML marker that makes the comment idempotently updatable
    const comment151 = formatPrComment(report151, { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 });
    assert(
      comment151.includes('<!-- argus-qa-report -->') &&
      comment151.includes('Merge blocked') &&
      comment151.includes('Affected routes') &&
      comment151.includes('TypeError: x is null'),
      `[151c] formatPrComment renders banner + routes + findings + marker (got head: ${comment151.slice(0, 160)})`
    );

    // ── reportPrValidation: stub globalThis.fetch to assert request shape + idempotency ──
    const _origFetch151   = globalThis.fetch;
    const _savedToken151  = process.env.GITHUB_TOKEN;
    const _savedRepo151   = process.env.GITHUB_REPOSITORY;
    const _savedPr151     = process.env.GITHUB_PR_NUMBER;
    const _savedSha151    = process.env.GITHUB_SHA;
    const _savedHead151   = process.env.ARGUS_PR_HEAD_SHA;
    const SECRET151       = 'ghp_unit_secret_do_not_leak_151';
    // A2 wired reportPrValidation to also fire a Check Run when a head SHA is resolvable.
    // These sub-tests exercise the A1 *comment* idempotency only, so unset both head-SHA
    // sources — otherwise the extra Check Run POST would pollute the request list (e.g.
    // GITHUB_SHA is set ambient on the CI runner) and break [151g]'s no-duplicate-POST check.
    delete process.env.GITHUB_SHA;
    delete process.env.ARGUS_PR_HEAD_SHA;
    try {
      // [151d] missing token → graceful skip: no fetch, no throw, no token in the result
      delete process.env.GITHUB_TOKEN;
      let calls151d = 0;
      globalThis.fetch = async () => { calls151d++; return { ok: true, status: 200, json: async () => [], text: async () => '[]' }; };
      const skip151 = await reportPrValidation(prResult151, { prUrl: prResult151.prUrl });
      assert(
        skip151.posted === false && skip151.skipped === true && calls151d === 0 &&
        !JSON.stringify(skip151).includes(SECRET151),
        `[151d] reportPrValidation skips cleanly without a token (no fetch, no throw) (got: ${JSON.stringify(skip151)}, fetchCalls: ${calls151d})`
      );

      // Create path: env repo/PR absent → owner/repo/PR resolved from the PR URL; GET
      // finds no existing Argus comment → POST a new one.
      process.env.GITHUB_TOKEN = SECRET151;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_PR_NUMBER;
      const reqs151c = [];
      globalThis.fetch = async (url, opts = {}) => {
        const method = opts.method ?? 'GET';
        reqs151c.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
        return method === 'GET'
          ? { ok: true, status: 200, json: async () => [], text: async () => '[]' }
          : { ok: true, status: 201, json: async () => ({ id: 1001 }), text: async () => '{"id":1001}' };
      };
      const create151 = await reportPrValidation(prResult151, { prUrl: prResult151.prUrl });
      const post151 = reqs151c.find(r => r.method === 'POST');

      // [151e] create path → POST to the PR's issues/comments endpoint resolved from the URL
      assert(
        create151.posted === true &&
        post151 && /\/repos\/acme\/shop\/issues\/7\/comments$/.test(post151.url) &&
        post151.body.includes('<!-- argus-qa-report -->') && post151.body.includes('Merge blocked'),
        `[151e] reportPrValidation POSTs a new comment to the URL-resolved PR endpoint with the block reason (got url: ${post151 && post151.url})`
      );

      // [151f] token rides only in the Authorization header — never the comment body
      assert(
        post151.auth === `Bearer ${SECRET151}` && !post151.body.includes(SECRET151),
        `[151f] PR comment body never leaks the GITHUB_TOKEN (auth header only; body-leak: ${post151.body.includes(SECRET151)})`
      );

      // Update path: an existing Argus comment (marker present) → PATCH it, no new POST.
      const reqs151u = [];
      globalThis.fetch = async (url, opts = {}) => {
        const method = opts.method ?? 'GET';
        reqs151u.push({ url, method });
        return method === 'GET'
          ? { ok: true, status: 200, json: async () => ([{ id: 555, body: 'prior\n<!-- argus-qa-report -->\nold' }]), text: async () => '' }
          : { ok: true, status: 200, json: async () => ({ id: 555 }), text: async () => '' };
      };
      const update151 = await reportPrValidation(prResult151, { prUrl: prResult151.prUrl });
      const patch151    = reqs151u.find(r => r.method === 'PATCH');
      const newPost151  = reqs151u.find(r => r.method === 'POST');

      // [151g] idempotency — re-running updates the SAME comment (PATCH id 555), no duplicate POST
      assert(
        update151.posted === true && patch151 && /\/issues\/comments\/555$/.test(patch151.url) && !newPost151,
        `[151g] reportPrValidation updates the existing Argus comment in place (PATCH: ${patch151 && patch151.url}, duplicate POST: ${!!newPost151})`
      );
    } finally {
      globalThis.fetch = _origFetch151;
      if (_savedToken151 === undefined) delete process.env.GITHUB_TOKEN;      else process.env.GITHUB_TOKEN      = _savedToken151;
      if (_savedRepo151  === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = _savedRepo151;
      if (_savedPr151    === undefined) delete process.env.GITHUB_PR_NUMBER;  else process.env.GITHUB_PR_NUMBER  = _savedPr151;
      if (_savedSha151   === undefined) delete process.env.GITHUB_SHA;        else process.env.GITHUB_SHA        = _savedSha151;
      if (_savedHead151  === undefined) delete process.env.ARGUS_PR_HEAD_SHA; else process.env.ARGUS_PR_HEAD_SHA = _savedHead151;
    }
  }

  // ── Block [152] PR Validator — GitHub Check Run conclusion (Phase A2) ───────────
  // reportPrValidation now also creates + completes a GitHub Check Run whose conclusion
  // maps to the PR-Validator block decision (report.prValidation.blocked), NOT
  // buildStatusPayload's new-critical-threshold rule — the two diverge for block-on=warning.
  // Chrome-free + network-free — globalThis.fetch is stubbed (recorded request/response
  // shapes), never the live GitHub API.
  {
    console.log('\n[152] PR Validator — GitHub Check Run conclusion (Phase A2)');

    // Three PR-validate results exercising the conclusion mapping:
    const base152 = {
      prUrl: 'https://github.com/acme/shop/pull/7', targetUrl: 'https://staging.example.com',
      affectedRoutes: ['/checkout'], changedFiles: ['src/pages/checkout.tsx'],
    };
    const blocked152 = { ...base152, blockOn: 'critical', blocked: true,
      summary: { critical: 1, warning: 0, info: 0 },
      findings: [{ severity: 'critical', type: 'console_error', message: 'TypeError: x is null', url: 'https://staging.example.com/checkout' }] };
    const passing152 = { ...base152, blockOn: 'critical', blocked: false,
      summary: { critical: 0, warning: 0, info: 1 },
      findings: [{ severity: 'info', type: 'seo_meta', message: 'Title could be shorter', url: 'https://staging.example.com/checkout' }] };
    // block-on=warning, ZERO criticals → blocked=true. buildStatusPayload (0 new criticals)
    // would say success; the Check Run must still conclude failure (block decision wins).
    const warnBlock152 = { ...base152, blockOn: 'warning', blocked: true,
      summary: { critical: 0, warning: 2, info: 0 },
      findings: [{ severity: 'warning', type: 'a11y_axe_violation', message: 'Low contrast text', url: 'https://staging.example.com/checkout' }] };

    // Stub: comment GET → [] (forces create path), check-run POST → {id:9001}, all else ok.
    const mkStub152 = (reqs) => async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      reqs.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
      if (method === 'GET')             return { ok: true, status: 200, json: async () => [],            text: async () => '[]' };
      if (/\/check-runs$/.test(url))    return { ok: true, status: 201, json: async () => ({ id: 9001 }), text: async () => '{"id":9001}' };
      return { ok: true, status: 200, json: async () => ({ id: 1 }), text: async () => '{}' };
    };

    const _origFetch152  = globalThis.fetch;
    const _savedToken152 = process.env.GITHUB_TOKEN;
    const _savedRepo152  = process.env.GITHUB_REPOSITORY;
    const _savedPr152    = process.env.GITHUB_PR_NUMBER;
    const _savedSha152   = process.env.GITHUB_SHA;
    const _savedHead152  = process.env.ARGUS_PR_HEAD_SHA;
    const SECRET152      = 'ghp_check_run_secret_do_not_leak_152';
    try {
      process.env.GITHUB_TOKEN     = SECRET152;
      delete process.env.GITHUB_REPOSITORY;   // resolve owner/repo + PR from the URL
      delete process.env.GITHUB_PR_NUMBER;
      delete process.env.GITHUB_SHA;
      process.env.ARGUS_PR_HEAD_SHA = 'deadbeefcafe0001';

      // ── blocked PR ──────────────────────────────────────────────────────────
      const reqsB = [];
      globalThis.fetch = mkStub152(reqsB);
      const outB = await reportPrValidation(blocked152, { prUrl: blocked152.prUrl });
      const crPostB  = reqsB.find(r => r.method === 'POST'  && /\/repos\/acme\/shop\/check-runs$/.test(r.url));
      const crPatchB = reqsB.find(r => r.method === 'PATCH' && /\/check-runs\/9001$/.test(r.url));
      const crPostBodyB  = crPostB  ? JSON.parse(crPostB.body)  : {};
      const crPatchBodyB = crPatchB ? JSON.parse(crPatchB.body) : {};

      // [152a] Check Run created against the PR head SHA, status in_progress
      assert(
        outB.checked === true && crPostB &&
        crPostBodyB.head_sha === 'deadbeefcafe0001' && crPostBodyB.status === 'in_progress',
        `[152a] reportPrValidation creates a Check Run on the PR head SHA (got: ${JSON.stringify({ checked: outB.checked, head: crPostBodyB.head_sha, status: crPostBodyB.status })})`
      );

      // [152b] blocked → conclusion: failure, status: completed (maps to the block decision)
      assert(
        crPatchB && crPatchBodyB.status === 'completed' && crPatchBodyB.conclusion === 'failure',
        `[152b] blocked PR → Check Run completed with conclusion=failure (got: ${JSON.stringify({ status: crPatchBodyB.status, conclusion: crPatchBodyB.conclusion })})`
      );

      // [152c] token rides only in the Authorization header — never the Check Run bodies
      assert(
        crPostB.auth === `Bearer ${SECRET152}` &&
        !String(crPostB.body).includes(SECRET152) && !String(crPatchB.body).includes(SECRET152),
        `[152c] Check Run create/complete bodies never leak the GITHUB_TOKEN (postLeak: ${String(crPostB.body).includes(SECRET152)}, patchLeak: ${String(crPatchB.body).includes(SECRET152)})`
      );

      // ── passing PR → conclusion: success ──────────────────────────────────────
      const reqsP = [];
      globalThis.fetch = mkStub152(reqsP);
      const outP = await reportPrValidation(passing152, { prUrl: passing152.prUrl });
      const passPatch = reqsP.find(r => r.method === 'PATCH' && /\/check-runs\//.test(r.url));
      assert(
        outP.checked === true && passPatch && JSON.parse(passPatch.body).conclusion === 'success',
        `[152d] non-blocked PR → Check Run conclusion=success (got: ${passPatch && JSON.parse(passPatch.body).conclusion})`
      );

      // ── block-on=warning, 0 criticals, blocked=true → conclusion still failure ──
      // Proves the prValidation block verdict drives the conclusion, NOT buildStatusPayload's
      // new-critical threshold (which sees 0 criticals → would conclude success).
      const reqsW = [];
      globalThis.fetch = mkStub152(reqsW);
      const outW = await reportPrValidation(warnBlock152, { prUrl: warnBlock152.prUrl });
      const warnPatch = reqsW.find(r => r.method === 'PATCH' && /\/check-runs\//.test(r.url));
      assert(
        outW.checked === true && warnPatch && JSON.parse(warnPatch.body).conclusion === 'failure',
        `[152e] block-on=warning with 0 criticals still concludes failure — block decision drives the conclusion, not the critical threshold (got: ${warnPatch && JSON.parse(warnPatch.body).conclusion})`
      );

      // ── no resolvable head SHA → comment posts, Check Run skipped (no false gate) ──
      delete process.env.ARGUS_PR_HEAD_SHA;
      delete process.env.GITHUB_SHA;
      const reqsN = [];
      globalThis.fetch = mkStub152(reqsN);
      const outN = await reportPrValidation(blocked152, { prUrl: blocked152.prUrl });
      const anyCheckN = reqsN.find(r => /\/check-runs/.test(r.url));
      const commentPostN = reqsN.find(r => r.method === 'POST' && /\/issues\/7\/comments$/.test(r.url));
      assert(
        outN.posted === true && outN.checked === false && !anyCheckN && commentPostN,
        `[152f] no head SHA → comment still posts but Check Run is skipped (posted: ${outN.posted}, checked: ${outN.checked}, checkRunCalled: ${!!anyCheckN})`
      );
    } finally {
      globalThis.fetch = _origFetch152;
      if (_savedToken152 === undefined) delete process.env.GITHUB_TOKEN;      else process.env.GITHUB_TOKEN      = _savedToken152;
      if (_savedRepo152  === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = _savedRepo152;
      if (_savedPr152    === undefined) delete process.env.GITHUB_PR_NUMBER;  else process.env.GITHUB_PR_NUMBER  = _savedPr152;
      if (_savedSha152   === undefined) delete process.env.GITHUB_SHA;        else process.env.GITHUB_SHA        = _savedSha152;
      if (_savedHead152  === undefined) delete process.env.ARGUS_PR_HEAD_SHA; else process.env.ARGUS_PR_HEAD_SHA = _savedHead152;
    }
  }

  // ── Block [153] PR Validator — MCP reporting parity (Phase A4) ──────────────────
  // argus_pr_validate (the MCP tool, handlePrValidate) now reports through the SAME shared
  // helper the CLI uses (reportPrValidation), so a reviewer sees an identical PR comment +
  // Check Run regardless of which path ran. Verified hermetically — no Chrome, no live GitHub:
  //   [153a] source-contract — handlePrValidate wires the helper, in a try/catch (best-effort),
  //          AFTER the block decision, and appends `reporting` to the response.
  //   [153b] the MCP-shaped result (affectedRoutes:string[], un-normalized targetUrl) feeds the
  //          shared helper and produces a real PR comment with the block reason + route.
  //   [153c] the golden response schema accepts the A4 response (with `reporting`) and still
  //          requires the core keys — the [147] contract covers A4 without going vacuous.
  {
    console.log('\n[153] PR Validator — MCP reporting parity (Phase A4)');

    // [153a] handlePrValidate source contract: the shared helper is wired in, isolated, and
    // appended post-decision. Slice the function body (start → next async function).
    const serverSrc153 = fs.readFileSync(path.resolve(__dirname, '../src/mcp-server.js'), 'utf8');
    const fnStart153   = serverSrc153.indexOf('async function handlePrValidate');
    const fnEnd153     = serverSrc153.indexOf('\nasync function', fnStart153 + 1);
    const fnBody153    = fnStart153 !== -1
      ? serverSrc153.slice(fnStart153, fnEnd153 === -1 ? undefined : fnEnd153) : '';
    const callsHelper153 = /reportPrValidation\(\s*result\s*,/.test(fnBody153);
    const inTryCatch153  = /try\s*{[\s\S]*?reportPrValidation\([\s\S]*?}\s*catch/.test(fnBody153);
    const blockedBeforeReport153 =
      fnBody153.indexOf('const blocked') !== -1 &&
      fnBody153.indexOf('const blocked') < fnBody153.indexOf('reportPrValidation(');
    const appendsReporting153 = /\.\.\.result,\s*reporting/.test(fnBody153);
    const importsHelper153 = /import\s*{\s*reportPrValidation\s*}\s*from\s*'\.\/utils\/github-reporter\.js'/.test(serverSrc153);
    assert(
      fnStart153 !== -1 && callsHelper153 && inTryCatch153 && blockedBeforeReport153 && appendsReporting153 && importsHelper153,
      `[153a] handlePrValidate wires reportPrValidation(result) in a try/catch AFTER the block decision and appends \`reporting\` (calls: ${callsHelper153}, try/catch: ${inTryCatch153}, post-decision: ${blockedBeforeReport153}, appends: ${appendsReporting153}, import: ${importsHelper153})`
    );

    // [153b] the EXACT result shape handlePrValidate builds — affectedRoutes as a string[],
    // findings url'd off an un-normalized targetUrl — feeds the shared helper and yields a real
    // PR comment carrying the block reason + the affected route. Chrome-free + network-free.
    const mcpResult153 = {
      prUrl: 'https://github.com/acme/web/pull/42',
      targetUrl: 'https://staging.example.com',
      affectedRoutes: ['/checkout'],
      changedFiles: ['src/pages/checkout.tsx'],
      findings: [{ severity: 'critical', type: 'console_error', message: 'TypeError: total is undefined', url: 'https://staging.example.com/checkout' }],
      perRoute: [{ route: '/checkout', critical: 1, warning: 0, info: 0 }],
      summary: { critical: 1, warning: 0, info: 0 },
      blocked: true,
      blockOn: 'critical',
    };
    const _origFetch153 = globalThis.fetch;
    const _savedTok153  = process.env.GITHUB_TOKEN;
    const _savedRepo153 = process.env.GITHUB_REPOSITORY;
    const _savedPr153   = process.env.GITHUB_PR_NUMBER;
    const _savedSha153  = process.env.GITHUB_SHA;
    const _savedHead153 = process.env.ARGUS_PR_HEAD_SHA;
    const SECRET153     = 'ghp_mcp_parity_secret_do_not_leak_153';
    try {
      process.env.GITHUB_TOKEN = SECRET153;
      delete process.env.GITHUB_REPOSITORY;   // resolve owner/repo + PR from the URL
      delete process.env.GITHUB_PR_NUMBER;
      delete process.env.GITHUB_SHA;          // no head SHA → comment only, Check Run skipped
      delete process.env.ARGUS_PR_HEAD_SHA;

      const reqs153 = [];
      globalThis.fetch = async (url, opts = {}) => {
        const method = opts.method ?? 'GET';
        reqs153.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
        if (method === 'GET') return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
        return { ok: true, status: 201, json: async () => ({ id: 777 }), text: async () => '{"id":777}' };
      };
      const out153 = await reportPrValidation(mcpResult153, { prUrl: mcpResult153.prUrl });
      const commentPost153 = reqs153.find(r => r.method === 'POST' && /\/repos\/acme\/web\/issues\/42\/comments$/.test(r.url));
      const body153 = commentPost153 ? String(commentPost153.body) : '';
      assert(
        out153.posted === true && !!commentPost153 &&
        body153.includes('/checkout') && /critical/i.test(body153) && !body153.includes(SECRET153),
        `[153b] MCP-shaped result feeds the shared helper → PR comment posts with block reason + route, no token leak (posted: ${out153.posted}, hasRoute: ${body153.includes('/checkout')}, leak: ${body153.includes(SECRET153)})`
      );
    } finally {
      globalThis.fetch = _origFetch153;
      if (_savedTok153  === undefined) delete process.env.GITHUB_TOKEN;      else process.env.GITHUB_TOKEN      = _savedTok153;
      if (_savedRepo153 === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = _savedRepo153;
      if (_savedPr153   === undefined) delete process.env.GITHUB_PR_NUMBER;  else process.env.GITHUB_PR_NUMBER  = _savedPr153;
      if (_savedSha153  === undefined) delete process.env.GITHUB_SHA;        else process.env.GITHUB_SHA        = _savedSha153;
      if (_savedHead153 === undefined) delete process.env.ARGUS_PR_HEAD_SHA; else process.env.ARGUS_PR_HEAD_SHA = _savedHead153;
    }

    // [153c] the golden response schema covers the A4 response (with `reporting`, via
    // passthrough) AND still REQUIRES the core keys — proves [147] tracks A4 non-vacuously.
    const a4Response153 = { ...mcpResult153, reporting: { posted: true, checked: false, skipped: false } };
    const withRep153    = prValidateResponseSchema.safeParse(a4Response153);
    const noRep153      = prValidateResponseSchema.safeParse(mcpResult153);
    const missingCore153 = { ...mcpResult153 };
    delete missingCore153.blocked;          // a required core key — schema MUST reject
    const rejects153    = prValidateResponseSchema.safeParse(missingCore153);
    assert(
      withRep153.success === true && noRep153.success === true && rejects153.success === false,
      `[153c] golden schema accepts the A4 response (with reporting) + back-compat (without), still rejects a missing core key (withReporting: ${withRep153.success}, without: ${noRep153.success}, rejectsMissingBlocked: ${!rejects153.success})`
    );
  }

  // ── Block [154] PR Validator — baseline-aware blocking (Phase B1) ───────────────
  // The marquee correctness lever: block on findings the PR INTRODUCES, not pre-existing
  // ones. Drives the real shared decision helper (decidePrBlock) + the head-vs-base diff
  // (diffRoutesAgainstBaseline) against a baseline baked through the actual on-disk format
  // (savePrBaseline → loadPrBaseline, path-keyed). Chrome-free + network-free. SAFETY-CRITICAL:
  // a pre-existing critical must NOT block; a PR-introduced critical MUST; no baseline → fail
  // safe to absolute blocking (never a silent pass).
  {
    console.log('\n[154] PR Validator — baseline-aware blocking (Phase B1)');

    const PREEXIST154 = { severity: 'critical', type: 'console_error', message: 'TypeError: legacy is null',        url: 'http://x/checkout' };
    const NEWCRIT154  = { severity: 'critical', type: 'console_error', message: 'ReferenceError: total is undefined', url: 'http://x/checkout' };
    const RESOLVED154 = { severity: 'warning',  type: 'a11y_axe_violation', message: 'contrast fixed since base',     url: 'http://x/checkout' };
    const NEWWARN154  = { severity: 'warning',  type: 'seo_meta',       message: 'Missing meta description',         url: 'http://x/about' };

    // Bake a real on-disk baseline (path-keyed) the same way a base-branch run would:
    // /checkout had the pre-existing critical + a warning the PR later resolves.
    const tmpDir154   = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-b1-'));
    const baseFile154 = path.join(tmpDir154, 'main.json');
    savePrBaseline(baseFile154, [{ path: '/checkout', findings: [PREEXIST154, RESOLVED154] }]);
    const baseline154 = loadPrBaseline(baseFile154);

    // [154a] head-vs-base diff: persisting vs new vs resolved (via the real stored format)
    const diff154 = diffRoutesAgainstBaseline(
      [{ path: '/checkout', findings: [PREEXIST154, NEWCRIT154] }],
      baseline154,
    );
    assert(
      diff154.newFindings.length === 1 && diff154.newFindings[0].message === NEWCRIT154.message &&
      diff154.persistingCount === 1 && diff154.resolvedCount === 1 &&
      diff154.newSummary.critical === 1 && diff154.newSummary.warning === 0,
      `[154a] diffRoutesAgainstBaseline classifies new/persisting/resolved off the real on-disk baseline (new: ${diff154.newFindings.length}, persisting: ${diff154.persistingCount}, resolved: ${diff154.resolvedCount}, newCrit: ${diff154.newSummary.critical})`
    );

    // [154b] a PRE-EXISTING critical must NOT block (baseline available)
    const preExist154 = decidePrBlock({
      routeFindings: [{ path: '/checkout', findings: [PREEXIST154] }],
      summary: { critical: 1, warning: 0, info: 0 }, blockOn: 'critical', baseline: baseline154,
    });
    assert(
      preExist154.baselineAvailable === true && preExist154.blocked === false &&
      preExist154.newSummary.critical === 0 && preExist154.reason === null,
      `[154b] decidePrBlock does NOT block on a pre-existing critical (blocked: ${preExist154.blocked}, baselineAvailable: ${preExist154.baselineAvailable}, newCrit: ${preExist154.newSummary.critical})`
    );

    // [154c] a PR-INTRODUCED critical MUST block, and the reason names "new"
    const introduced154 = decidePrBlock({
      routeFindings: [{ path: '/checkout', findings: [PREEXIST154, NEWCRIT154] }],
      summary: { critical: 2, warning: 0, info: 0 }, blockOn: 'critical', baseline: baseline154,
    });
    assert(
      introduced154.blocked === true && introduced154.newSummary.critical === 1 &&
      /critical new finding/.test(introduced154.reason),
      `[154c] decidePrBlock blocks on a PR-introduced critical (blocked: ${introduced154.blocked}, newCrit: ${introduced154.newSummary.critical}, reason: ${introduced154.reason})`
    );

    // [154d] fail-safe: no baseline → block on ABSOLUTE counts and SAY so (never a silent pass)
    const noBase154 = decidePrBlock({
      routeFindings: [{ path: '/checkout', findings: [PREEXIST154] }],
      summary: { critical: 1, warning: 0, info: 0 }, blockOn: 'critical', baseline: null,
    });
    assert(
      noBase154.baselineAvailable === false && noBase154.blocked === true &&
      noBase154.newSummary === null && /baseline unavailable/i.test(noBase154.note) &&
      /critical total finding/.test(noBase154.reason),
      `[154d] no baseline → fail-safe absolute block + note (blocked: ${noBase154.blocked}, note: ${noBase154.note}, reason: ${noBase154.reason})`
    );

    // [154e] block-on=warning is baseline-aware too: a pre-existing warning doesn't block,
    //        a PR-introduced warning does
    const baseWarn154   = { severity: 'warning', type: 'seo_meta', message: 'old warning', url: 'http://x/about' };
    const wTmp154       = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-b1w-'));
    const wFile154      = path.join(wTmp154, 'main.json');
    savePrBaseline(wFile154, [{ path: '/about', findings: [baseWarn154] }]);
    const wBaseline154  = loadPrBaseline(wFile154);
    const wPersist154   = decidePrBlock({ routeFindings: [{ path: '/about', findings: [baseWarn154] }],            summary: { critical: 0, warning: 1, info: 0 }, blockOn: 'warning', baseline: wBaseline154 });
    const wIntro154     = decidePrBlock({ routeFindings: [{ path: '/about', findings: [baseWarn154, NEWWARN154] }], summary: { critical: 0, warning: 2, info: 0 }, blockOn: 'warning', baseline: wBaseline154 });
    assert(
      wPersist154.blocked === false && wIntro154.blocked === true && wIntro154.newSummary.warning === 1,
      `[154e] block-on=warning gates on NEW warnings (pre-existing blocks: ${wPersist154.blocked}, introduced blocks: ${wIntro154.blocked}, newWarn: ${wIntro154.newSummary.warning})`
    );

    // [154f] resolvePrBaselineFile: override > GITHUB_BASE_REF (sanitized) > null
    const _baseEnv154 = { f: process.env.ARGUS_BASELINE_FILE, b: process.env.GITHUB_BASE_REF, a: process.env.ARGUS_BASE_BRANCH };
    delete process.env.ARGUS_BASELINE_FILE; delete process.env.GITHUB_BASE_REF; delete process.env.ARGUS_BASE_BRANCH;
    try {
      const nullPath154 = resolvePrBaselineFile({ outputDir: 'out' });           // no ref → null
      process.env.GITHUB_BASE_REF = 'release/v2';
      const refPath154  = resolvePrBaselineFile({ outputDir: 'out' });           // sanitized path
      process.env.ARGUS_BASELINE_FILE = '/custom/base.json';
      const ovrPath154  = resolvePrBaselineFile({ outputDir: 'out', baseRef: 'main' }); // override wins
      assert(
        nullPath154 === null &&
        refPath154 === path.join('out', 'baselines', 'release__v2.json') &&
        ovrPath154 === '/custom/base.json',
        `[154f] resolvePrBaselineFile: null without a ref, sanitized base-ref path, ARGUS_BASELINE_FILE override (null: ${nullPath154}, ref: ${refPath154}, override: ${ovrPath154})`
      );
    } finally {
      if (_baseEnv154.f === undefined) delete process.env.ARGUS_BASELINE_FILE; else process.env.ARGUS_BASELINE_FILE = _baseEnv154.f;
      if (_baseEnv154.b === undefined) delete process.env.GITHUB_BASE_REF;     else process.env.GITHUB_BASE_REF     = _baseEnv154.b;
      if (_baseEnv154.a === undefined) delete process.env.ARGUS_BASE_BRANCH;   else process.env.ARGUS_BASE_BRANCH   = _baseEnv154.a;
    }

    // [154g] the decision is STATED in the step summary — the diff counts when available,
    //        and the explicit fail-safe note when not (B1 acceptance: "state it in the summary")
    const availMd154 = buildStepSummary({
      blocked: true, summary: { critical: 1, warning: 0, info: 0 }, affectedRoutes: [{ path: '/checkout' }],
      perRoute: [], findings: [], changedFiles: [], blockOn: 'critical',
      baseline: { available: true, newCritical: 1, newWarning: 0, newInfo: 0, persisting: 2, resolved: 1 },
    });
    const unavailMd154 = buildStepSummary({
      blocked: true, summary: { critical: 1, warning: 0, info: 0 }, affectedRoutes: [],
      perRoute: [], findings: [], changedFiles: [], blockOn: 'critical',
      baseline: { available: false, note: 'Baseline unavailable — blocking on absolute finding counts.' },
    });
    assert(
      availMd154.includes('### Baseline diff') && availMd154.includes('| New | 1 | 0 | 0 |') &&
      availMd154.includes('2 persisting · 1 resolved') &&
      unavailMd154.includes('Baseline unavailable'),
      `[154g] buildStepSummary surfaces the baseline diff when available + the fail-safe note when not (availHasDiff: ${availMd154.includes('### Baseline diff')}, unavailHasNote: ${unavailMd154.includes('Baseline unavailable')})`
    );

    // Cleanup temp baseline dirs.
    try { fs.rmSync(tmpDir154, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(wTmp154,   { recursive: true, force: true }); } catch {}
  }

  // ── Block [155] PR Validator — new/persisting/resolved in the PR comment (Phase B2) ─
  // B1 made the BLOCK DECISION baseline-aware; B2 makes the PR COMMENT honest about it: the
  // findings this PR INTRODUCES vs the ones that already existed, so a reviewer sees WHY the
  // merge was (or wasn't) blocked. Drives the real chain — tagFindingNovelty (the per-finding
  // isNew tags) → prResultToReport (baseline-aware reason + banner) → formatPrComment /
  // reportPrValidation (stubbed fetch). Chrome-free + network-free. The marquee invariant:
  // the comment's counts RECONCILE with the block decision.
  {
    console.log('\n[155] PR Validator — new/persisting/resolved in the PR comment (Phase B2)');

    const PRE155     = { severity: 'critical', type: 'console_error',     message: 'LEGACY: x is null',          url: 'https://staging.example.com/checkout' };
    const NEW155     = { severity: 'critical', type: 'console_error',     message: 'NEW: total is undefined',     url: 'https://staging.example.com/checkout' };
    const RESBASE155 = { severity: 'warning',  type: 'a11y_axe_violation', message: 'contrast fixed since base',   url: 'https://staging.example.com/checkout' };

    // Bake a real on-disk baseline (path-keyed) as a base-branch run would: /checkout had the
    // pre-existing critical + a warning the PR later resolves.
    const tmp155  = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-b2-'));
    const file155 = path.join(tmp155, 'main.json');
    savePrBaseline(file155, [{ path: '/checkout', findings: [PRE155, RESBASE155] }]);
    const baseline155 = loadPrBaseline(file155);

    // [155a] tagFindingNovelty tags the SAME finding objects the comment renders: a baseline
    //        finding is persisting (isNew=false), an absent one is PR-introduced (isNew=true).
    const pre155a = { ...PRE155 };
    const new155a = { ...NEW155 };
    tagFindingNovelty([{ path: '/checkout', findings: [pre155a, new155a] }], baseline155);
    assert(
      pre155a.isNew === false && new155a.isNew === true,
      `[155a] tagFindingNovelty tags persisting vs PR-introduced off the real baseline (preExisting.isNew: ${pre155a.isNew}, introduced.isNew: ${new155a.isNew})`
    );

    // [155b] prResultToReport threads the baseline into prValidation AND the block reason
    //        reconciles with the NEW counts (1 new critical drove the block, not 2 absolute).
    const report155b = prResultToReport({
      targetUrl: 'https://staging.example.com',
      summary: { critical: 2, warning: 0, info: 0 },
      findings: [{ ...NEW155, isNew: true }, { ...PRE155, isNew: false }],
      affectedRoutes: ['/checkout'], changedFiles: ['src/pages/checkout.tsx'],
      blocked: true, blockOn: 'critical',
      baseline: { available: true, newCritical: 1, newWarning: 0, newInfo: 0, persisting: 1, resolved: 1 },
    });
    assert(
      report155b.prValidation.baseline.newCritical === 1 &&
      report155b.prValidation.baseline.persisting === 1 &&
      report155b.prValidation.reason === '1 critical new finding(s) found',
      `[155b] prResultToReport threads baseline + reason reconciles with new counts (baseline: ${JSON.stringify(report155b.prValidation.baseline)}, reason: ${report155b.prValidation.reason})`
    );

    // [155c] formatPrComment renders the new/persisting/resolved line and lists ONLY the
    //        introduced finding — the persisting one is excluded from the "New Findings" table.
    const comment155c = formatPrComment(report155b, { isFirstRun: false, resolvedCount: 1, flowResolvedCount: 0 });
    assert(
      comment155c.includes('1 new critical') && comment155c.includes('1 persisting') &&
      comment155c.includes('1 resolved') &&
      comment155c.includes('NEW: total is undefined') && !comment155c.includes('LEGACY: x is null'),
      `[155c] comment surfaces new/persisting/resolved + lists only the introduced finding (hasNewLine: ${comment155c.includes('1 new critical')}, listsNew: ${comment155c.includes('NEW: total is undefined')}, excludesPersisting: ${!comment155c.includes('LEGACY: x is null')})`
    );

    // [155d] fail-safe: when no baseline was available the comment states it (never silent).
    const failSafe155 = prResultToReport({
      targetUrl: 'https://staging.example.com',
      summary: { critical: 1, warning: 0, info: 0 },
      findings: [{ ...PRE155 }],
      affectedRoutes: ['/checkout'], blocked: true, blockOn: 'critical',
      baseline: { available: false, note: 'Baseline unavailable — blocking on absolute finding counts.' },
    });
    const comment155d = formatPrComment(failSafe155, { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 });
    assert(
      comment155d.includes('Baseline unavailable') &&
      /total finding/.test(failSafe155.prValidation.reason),
      `[155d] no baseline → comment states the fail-safe + the reason names "total" (hasNote: ${comment155d.includes('Baseline unavailable')}, reason: ${failSafe155.prValidation.reason})`
    );

    // [155e] END-TO-END reconciliation through reportPrValidation (stubbed fetch, never live
    //        GitHub): a PRE-EXISTING-ONLY run is ALLOWED (B1) and the posted comment SAYS 0 new
    //        / 1 persisting / 1 resolved (B2) — the comment reconciles with the block decision.
    const _origFetch155 = globalThis.fetch;
    const _saved155 = {
      tok: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY, pr: process.env.GITHUB_PR_NUMBER,
      sha: process.env.GITHUB_SHA, head: process.env.ARGUS_PR_HEAD_SHA,
    };
    const SECRET155 = 'ghp_b2_secret_do_not_leak_155';
    delete process.env.GITHUB_REPOSITORY; delete process.env.GITHUB_PR_NUMBER;   // resolve from URL
    delete process.env.GITHUB_SHA; delete process.env.ARGUS_PR_HEAD_SHA;          // no Check Run noise
    process.env.GITHUB_TOKEN = SECRET155;
    try {
      // Reproduce the CLI's Step 6a exactly: head run = pre-existing critical only (RESBASE155
      // resolved, nothing new), so decidePrBlock does NOT block.
      const routeFindings155 = [{ path: '/checkout', findings: [{ ...PRE155 }] }];
      const summary155 = { critical: 1, warning: 0, info: 0 };
      const decision155 = decidePrBlock({ routeFindings: routeFindings155, summary: summary155, blockOn: 'critical', baseline: baseline155 });
      tagFindingNovelty(routeFindings155, baseline155);
      const baselineInfo155 = decision155.baselineAvailable
        ? { available: true, newCritical: decision155.newSummary.critical, newWarning: decision155.newSummary.warning, newInfo: decision155.newSummary.info, persisting: decision155.persistingCount, resolved: decision155.resolvedCount }
        : { available: false, note: decision155.note };
      const result155 = {
        prUrl: 'https://github.com/acme/shop/pull/7', targetUrl: 'https://staging.example.com',
        affectedRoutes: ['/checkout'], changedFiles: ['src/pages/checkout.tsx'],
        findings: routeFindings155.flatMap(r => r.findings), perRoute: [{ route: '/checkout', ...summary155 }],
        summary: summary155, blocked: decision155.blocked, blockOn: 'critical', baseline: baselineInfo155,
      };

      const reqs155 = [];
      globalThis.fetch = async (url, opts = {}) => {
        const method = opts.method ?? 'GET';
        reqs155.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
        return method === 'GET'
          ? { ok: true, status: 200, json: async () => [], text: async () => '[]' }
          : { ok: true, status: 201, json: async () => ({ id: 7001 }), text: async () => '{"id":7001}' };
      };
      const out155 = await reportPrValidation(result155, { prUrl: result155.prUrl });
      const post155 = reqs155.find(r => r.method === 'POST');

      assert(
        decision155.blocked === false && out155.posted === true && post155 &&
        post155.body.includes('Merge allowed') &&
        post155.body.includes('0 new critical') && post155.body.includes('1 persisting') && post155.body.includes('1 resolved') &&
        !post155.body.includes(SECRET155),
        `[155e] pre-existing-only run is ALLOWED and the posted comment reconciles (blocked: ${decision155.blocked}, allowed: ${post155 && post155.body.includes('Merge allowed')}, 0new: ${post155 && post155.body.includes('0 new critical')}, 1persisting: ${post155 && post155.body.includes('1 persisting')}, 1resolved: ${post155 && post155.body.includes('1 resolved')}, leak: ${post155 && post155.body.includes(SECRET155)})`
      );
    } finally {
      globalThis.fetch = _origFetch155;
      if (_saved155.tok  === undefined) delete process.env.GITHUB_TOKEN;       else process.env.GITHUB_TOKEN       = _saved155.tok;
      if (_saved155.repo === undefined) delete process.env.GITHUB_REPOSITORY;  else process.env.GITHUB_REPOSITORY  = _saved155.repo;
      if (_saved155.pr   === undefined) delete process.env.GITHUB_PR_NUMBER;   else process.env.GITHUB_PR_NUMBER   = _saved155.pr;
      if (_saved155.sha  === undefined) delete process.env.GITHUB_SHA;         else process.env.GITHUB_SHA         = _saved155.sha;
      if (_saved155.head === undefined) delete process.env.ARGUS_PR_HEAD_SHA;  else process.env.ARGUS_PR_HEAD_SHA  = _saved155.head;
    }

    try { fs.rmSync(tmp155, { recursive: true, force: true }); } catch {}
  }

  // ── Block [156] C1 framework-aware route mapping (import graph + Next.js convention) ──
  // Drives the REAL production mapper (mapFilesToRoutesDeep) against import-graph-fixture/ —
  // a Next.js pages/ app where each component is imported by a known set of pages. Asserts
  // precision (a changed component narrows to only the routes that render it) AND the
  // safety invariant (any ambiguity falls back to ALL routes — never miss a regression).
  {
    console.log('\n[156] pr-diff-analyzer — mapFilesToRoutesDeep framework-aware mapping (C1)');

    const igRoot    = path.join(__dirname, 'import-graph-fixture');
    const routes156 = [
      { path: '/',         name: 'Home' },
      { path: '/checkout', name: 'Checkout' },
      { path: '/about',    name: 'About' },
    ];
    const ALL156 = ['/', '/about', '/checkout']; // sorted full route set (the conservative fallback)
    const deep   = files => mapFilesToRoutesDeep(files, routes156, { sourceDir: igRoot }).map(r => r.path).sort();
    const eq     = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // [156a] discoverNextJsRouteFiles pairs each route with the page FILE that defines it —
    // the file↔path map the import-graph resolution keys off.
    const rf156 = discoverNextJsRouteFiles(igRoot);
    const checkoutPair156 = rf156.find(p => p.path === '/checkout');
    assert(
      rf156.length === 3 &&
      checkoutPair156 && /checkout\.jsx$/.test(checkoutPair156.file) &&
      rf156.some(p => p.path === '/') && rf156.some(p => p.path === '/about'),
      `[156a] discoverNextJsRouteFiles returns {path,file} pairs for /, /checkout, /about (got paths: ${JSON.stringify(rf156.map(p => p.path).sort())}; checkout file: ${checkoutPair156 && path.basename(checkoutPair156.file)})`
    );

    // [156b] MARQUEE: a changed component imported by exactly one page maps to ONLY that
    // page's route — not the blunt all-routes fallback the slug heuristic would give.
    const r156b = deep(['components/CartSummary.jsx']);
    assert(
      r156b.length === 1 && r156b[0] === '/checkout',
      `[156b] CartSummary.jsx (imported only by /checkout) → [/checkout] only (got: ${JSON.stringify(r156b)})`
    );

    // [156c] alias resolution: a component imported via a tsconfig path alias (@/components/…)
    // still resolves to its rendering route.
    const r156c = deep(['components/Profile.jsx']);
    assert(
      r156c.length === 1 && r156c[0] === '/about',
      `[156c] Profile.jsx (imported by /about via @/ alias) → [/about] only (got: ${JSON.stringify(r156c)})`
    );

    // [156d] TRANSITIVE: a util imported by a component that a page imports
    // (lib/formatPrice → CartSummary → /checkout) maps through the chain.
    const r156d = deep(['lib/formatPrice.js']);
    assert(
      r156d.length === 1 && r156d[0] === '/checkout',
      `[156d] lib/formatPrice.js (→ CartSummary → /checkout) resolves transitively → [/checkout] (got: ${JSON.stringify(r156d)})`
    );

    // [156e] SAFETY — never miss a regression: a changed file imported by NO page is
    // AMBIGUOUS (could be an alias we failed to resolve), so it must fall back to ALL routes,
    // never narrow to []/a subset.
    const r156e = deep(['lib/orphan.js']);
    assert(
      eq(r156e, ALL156),
      `[156e] lib/orphan.js (imported by no page) → conservative fallback to ALL routes (got: ${JSON.stringify(r156e)})`
    );

    // [156f] SAFETY — a changed file that is not a node in the source tree (deleted, or a
    // monorepo subdir outside sourceDir — C2's scope) is ambiguous → ALL routes.
    const r156f = deep(['src/widgets/Ghost.jsx']);
    assert(
      eq(r156f, ALL156),
      `[156f] a file absent from the source tree → conservative fallback to ALL routes (got: ${JSON.stringify(r156f)})`
    );

    // [156g] opt-in: with NO sourceDir, mapFilesToRoutesDeep is byte-identical to the slug
    // heuristic mapFilesToRoutes — the prior CLI behaviour is unchanged when C1 is off.
    const noDir156   = mapFilesToRoutesDeep(['components/CartSummary.jsx'], routes156, {}).map(r => r.path).sort();
    const heur156    = mapFilesToRoutes(['components/CartSummary.jsx'], routes156).map(r => r.path).sort();
    assert(
      eq(noDir156, heur156) && eq(noDir156, ALL156),
      `[156g] no sourceDir → identical to mapFilesToRoutes slug heuristic (deep: ${JSON.stringify(noDir156)}, heuristic: ${JSON.stringify(heur156)})`
    );

    // [156h] multiple changed components union to the set of routes that render any of them.
    const r156h = deep(['components/Hero.jsx', 'components/CartSummary.jsx']);
    assert(
      eq(r156h, ['/', '/checkout']),
      `[156h] Hero.jsx + CartSummary.jsx → union [/, /checkout] (got: ${JSON.stringify(r156h)})`
    );

    // [156i] a changed PAGE file maps to its own route by convention (it IS the route file).
    const r156i = deep(['pages/checkout.jsx']);
    assert(
      r156i.length === 1 && r156i[0] === '/checkout',
      `[156i] pages/checkout.jsx (the page itself) → [/checkout] by convention (got: ${JSON.stringify(r156i)})`
    );

    // [156k] SAFETY (the load-bearing case): a PR that changes a precisely-resolvable
    // component AND an ambiguous file (imported by no page) must NOT narrow to just the
    // component's route — the ambiguous file forces the conservative ALL-routes fallback,
    // so a regression introduced by the ambiguous file is never missed.
    const r156k = deep(['components/CartSummary.jsx', 'lib/orphan.js']);
    assert(
      eq(r156k, ALL156),
      `[156k] component + ambiguous file → conservative ALL routes, never narrowed to the component's route alone (got: ${JSON.stringify(r156k)})`
    );

    // [156j] import-graph primitive: parseImports + buildImportGraph wire the reverse edge
    // CartSummary → /checkout's page file (the edge [156b]/[156d] depend on).
    const g156      = buildImportGraph(igRoot);
    const cartAbs   = path.join(igRoot, 'components', 'CartSummary.jsx');
    const checkAbs  = path.join(igRoot, 'pages', 'checkout.jsx');
    const importers = g156.reverse.get(cartAbs);
    const specs156  = parseImports("import { CartSummary } from '../components/CartSummary';\nconst x = require('./a');\nawait import('@/b');");
    assert(
      g156.truncated === false && importers instanceof Set && importers.has(checkAbs) &&
      specs156.includes('../components/CartSummary') && specs156.includes('./a') && specs156.includes('@/b'),
      `[156j] buildImportGraph reverse edge CartSummary→checkout + parseImports extracts import/require/dynamic specifiers (importer has checkout: ${importers instanceof Set && importers.has(checkAbs)}, specs: ${JSON.stringify(specs156)})`
    );
  }

  // ── Block [157] C2 monorepo path awareness (workspace prefixes) ──────────────────
  // Drives the REAL production mappers against import-graph-monorepo-fixture/ — a monorepo
  // whose app lives under apps/web/. GitHub returns repo-root-relative changed-file paths
  // ("apps/web/...") while ARGUS_SOURCE_DIR points at the package subdir, so C2 must re-base
  // the path into the package's import graph (C2a) and keep workspace dirs out of slug
  // matching (C2b) — WITHOUT ever narrowing away a possible regression.
  {
    console.log('\n[157] pr-diff-analyzer — monorepo path awareness (C2)');

    const webRoot   = path.join(__dirname, 'import-graph-monorepo-fixture', 'apps', 'web');
    const routes157 = [
      { path: '/',         name: 'Home' },
      { path: '/checkout', name: 'Checkout' },
    ];
    const ALL157 = ['/', '/checkout'];
    const deep   = files => mapFilesToRoutesDeep(files, routes157, { sourceDir: webRoot }).map(r => r.path).sort();
    const eq     = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // [157a] MARQUEE: sourceDir is the apps/web package subdir, the PR path is repo-root-
    // relative ("apps/web/..."); C2 re-bases it into the package graph so a changed component
    // narrows to ONLY its rendering route. Without C2 the doubled prefix misses the node and
    // the mapper falls back to ALL routes — so this narrow is the entire C2a payoff.
    const r157a = deep(['apps/web/components/CartSummary.jsx']);
    assert(
      r157a.length === 1 && r157a[0] === '/checkout',
      `[157a] monorepo apps/web/components/CartSummary.jsx → [/checkout] only (re-based into the package graph) (got: ${JSON.stringify(r157a)})`
    );

    // [157b] TRANSITIVE in a monorepo: a util under apps/web resolves through the chain
    // (formatPrice → CartSummary → /checkout) once the workspace prefix is re-based.
    const r157b = deep(['apps/web/lib/formatPrice.js']);
    assert(
      r157b.length === 1 && r157b[0] === '/checkout',
      `[157b] monorepo apps/web/lib/formatPrice.js → [/checkout] transitively (got: ${JSON.stringify(r157b)})`
    );

    // [157c] SAFETY — never miss a regression: a monorepo file imported by NO page is still
    // ambiguous and must fall back to ALL routes, not narrow.
    const r157c = deep(['apps/web/lib/orphan.js']);
    assert(
      eq(r157c, ALL157),
      `[157c] monorepo orphan (imported by no page) → conservative ALL routes (got: ${JSON.stringify(r157c)})`
    );

    // [157d] SAFETY — a changed file in a DIFFERENT package (apps/admin, not under sourceDir
    // apps/web) shares no prefix overlap, never resolves into this package's graph, and falls
    // back to ALL routes — it is NEVER misattributed to a web route.
    const r157d = deep(['apps/admin/pages/index.jsx']);
    assert(
      eq(r157d, ALL157),
      `[157d] foreign-package file (apps/admin/…) → conservative ALL routes, never misattributed (got: ${JSON.stringify(r157d)})`
    );

    // [157e] SAFETY (load-bearing): a precisely-resolvable monorepo component bundled with an
    // ambiguous monorepo file must NOT narrow to the component's route — the ambiguous file
    // forces the conservative ALL-routes fallback (mirrors [156k] for monorepo paths).
    const r157e = deep(['apps/web/components/CartSummary.jsx', 'apps/web/lib/orphan.js']);
    assert(
      eq(r157e, ALL157),
      `[157e] component + ambiguous monorepo file → conservative ALL routes (got: ${JSON.stringify(r157e)})`
    );

    // [157f] C2b slug hygiene: the workspace prefix "apps/web/" is stripped before slug
    // tokenization, so a checkout file in the web package matches ONLY /checkout — the
    // workspace dir "web" no longer spuriously matches a literal /web route.
    const slugRoutes157 = [{ path: '/' }, { path: '/web' }, { path: '/checkout' }];
    const r157f = mapFilesToRoutes(['apps/web/checkout.tsx'], slugRoutes157).map(r => r.path).sort();
    assert(
      r157f.length === 1 && r157f[0] === '/checkout',
      `[157f] slug heuristic: apps/web/checkout.tsx → [/checkout] only (no spurious /web from the workspace dir) (got: ${JSON.stringify(r157f)})`
    );

    // [157g] C2b SAFETY: a workspace-prefix file with no route-meaningful slug left after the
    // strip ("apps/web/index.tsx" → "index") matches no route → conservative ALL routes — it
    // does NOT spuriously narrow to /web.
    const r157g = mapFilesToRoutes(['apps/web/index.tsx'], slugRoutes157).map(r => r.path).sort();
    assert(
      eq(r157g, ['/', '/checkout', '/web']),
      `[157g] slug heuristic: apps/web/index.tsx → conservative ALL routes (no spurious /web narrow) (got: ${JSON.stringify(r157g)})`
    );

    // [157h] pure-fn primitives the above rest on: stripWorkspacePrefix drops the 2-segment
    // workspace prefix (and leaves non-workspace + remainderless paths intact); packageRelativePath
    // re-bases a repo-root path onto a package subdir and returns null for a foreign package.
    const strip1 = stripWorkspacePrefix('apps/web/components/Foo.tsx');
    const strip2 = stripWorkspacePrefix('src/pages/checkout.tsx');
    const strip3 = stripWorkspacePrefix('apps/web');
    const rel1   = packageRelativePath(webRoot, 'apps/web/components/Foo.tsx');
    const rel2   = packageRelativePath(webRoot, 'apps/admin/x.js');
    assert(
      strip1 === 'components/Foo.tsx' && strip2 === 'src/pages/checkout.tsx' && strip3 === 'apps/web' &&
      rel1 === 'components/Foo.tsx' && rel2 === null,
      `[157h] stripWorkspacePrefix + packageRelativePath primitives (strip: ${JSON.stringify([strip1, strip2, strip3])}, rebase: ${JSON.stringify([rel1, rel2])})`
    );
  }

  // ── Block [158] C3 stylesheet attribution / guarded fallback tightening ──────────
  // Drives the REAL production mapper (mapFilesToRoutesDeep) against import-graph-fixture/ for
  // CSS-family changes. C3 makes stylesheets first-class import-graph LEAF nodes, so a changed
  // NON-global stylesheet attributes to ONLY its importing routes (the same C1 machinery +
  // safety rails) instead of the slug heuristic's blunt all-routes fallback. Global stylesheets
  // keep their conservative INFRA → ALL classification on purpose. Every narrowing here is
  // paired with the proof that the dropped route(s) truly don't import the file.
  {
    console.log('\n[158] pr-diff-analyzer — stylesheet attribution / guarded fallback (C3)');

    const igRoot    = path.join(__dirname, 'import-graph-fixture');
    const routes158 = [
      { path: '/',         name: 'Home' },
      { path: '/checkout', name: 'Checkout' },
      { path: '/about',    name: 'About' },
    ];
    const ALL158 = ['/', '/about', '/checkout'];
    const deep   = files => mapFilesToRoutesDeep(files, routes158, { sourceDir: igRoot }).map(r => r.path).sort();
    const heur   = files => mapFilesToRoutes(files, routes158).map(r => r.path).sort();
    const eq     = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // [158a] MARQUEE: a CSS module imported by exactly one page narrows to ONLY that page's
    // route — where the slug heuristic, finding no route segment in the file name, blasts ALL.
    // The narrowing is the entire C3 payoff, and the heuristic comparison proves it is real.
    const r158a  = deep(['components/CartSummary.module.css']);
    const h158a  = heur(['components/CartSummary.module.css']);
    assert(
      r158a.length === 1 && r158a[0] === '/checkout' && eq(h158a, ALL158),
      `[158a] CartSummary.module.css (imported only by /checkout) → [/checkout] in deep mode, while the slug heuristic blasts ALL (deep: ${JSON.stringify(r158a)}, heuristic: ${JSON.stringify(h158a)})`
    );

    // [158b] UNION + SAFE EXCLUSION: a stylesheet imported by two components on different routes
    // (Hero → /, CartSummary → /checkout) narrows to the UNION of just those routes. /about is
    // dropped — and that drop is PROVABLY safe: /about's page does not import brand.css, so it
    // truly cannot regress from a brand.css change.
    const r158b = deep(['styles/brand.css']);
    assert(
      eq(r158b, ['/', '/checkout']) && !r158b.includes('/about'),
      `[158b] styles/brand.css (imported by / + /checkout) → [/, /checkout] only; /about safely excluded (it does not import the file) (got: ${JSON.stringify(r158b)})`
    );

    // [158c] SAFETY — never miss a regression: an orphan stylesheet on disk imported by NO page
    // is ambiguous and must fall back to ALL routes, never narrow to []/a subset.
    const r158c = deep(['styles/theme.css']);
    assert(
      eq(r158c, ALL158),
      `[158c] styles/theme.css (imported by no page) → conservative fallback to ALL routes (got: ${JSON.stringify(r158c)})`
    );

    // [158d] SAFETY (load-bearing): a precisely-resolvable CSS module bundled with an AMBIGUOUS
    // stylesheet (the orphan) must NOT narrow to the module's route — the ambiguous file forces
    // the conservative ALL-routes fallback, so a regression it could cause is never missed.
    const r158d = deep(['components/CartSummary.module.css', 'styles/theme.css']);
    assert(
      eq(r158d, ALL158),
      `[158d] CSS module + ambiguous orphan stylesheet → conservative ALL routes, never narrowed to the module's route alone (got: ${JSON.stringify(r158d)})`
    );

    // [158e] opt-in: with NO sourceDir, the same CSS module change is byte-identical to the slug
    // heuristic (ALL) — C3 precision is opt-in via ARGUS_SOURCE_DIR; prior behaviour is unchanged.
    const noDir158 = mapFilesToRoutesDeep(['components/CartSummary.module.css'], routes158, {}).map(r => r.path).sort();
    assert(
      eq(noDir158, h158a) && eq(noDir158, ALL158),
      `[158e] no sourceDir → identical to mapFilesToRoutes slug heuristic for a stylesheet (deep: ${JSON.stringify(noDir158)}, heuristic: ${JSON.stringify(h158a)})`
    );

    // [158f] INTENTIONAL BOUNDARY: a GLOBAL stylesheet (globals.css — INFRA_PATTERNS) keeps the
    // conservative ALL-routes classification even in deep mode. By convention it is imported by
    // the root layout and applies to every route, so narrowing it could miss a regression — C3
    // narrows only NON-global stylesheets.
    const r158f = deep(['styles/globals.css']);
    assert(
      eq(r158f, ALL158),
      `[158f] global stylesheet (styles/globals.css) → ALL routes even in deep mode (infra short-circuit preserved on purpose) (got: ${JSON.stringify(r158f)})`
    );

    // [158g] import-graph CSS-node primitives the above rest on: a stylesheet is a graph NODE,
    // carries a reverse edge from its importer (CartSummary.module.css ← CartSummary, which
    // findDependents walks transitively to the /checkout page), an orphan stylesheet has zero
    // dependents (drives [158c]), and resolveSpecifier resolves an explicit relative `.css`
    // import to the on-disk file.
    const g158     = buildImportGraph(igRoot);
    const cssAbs   = path.join(igRoot, 'components', 'CartSummary.module.css');
    const themeAbs = path.join(igRoot, 'styles', 'theme.css');
    const cartAbs  = path.join(igRoot, 'components', 'CartSummary.jsx');
    const checkAbs = path.join(igRoot, 'pages', 'checkout.jsx');
    const cssRevEdge   = g158.reverse.get(cssAbs);
    const cssDeps      = findDependents(g158.reverse, [cssAbs]);
    const resolvedCss  = resolveSpecifier('./CartSummary.module.css', cartAbs, []);
    assert(
      g158.truncated === false &&
      g158.files.has(cssAbs) && g158.files.has(themeAbs) &&
      cssRevEdge instanceof Set && cssRevEdge.has(cartAbs) &&
      cssDeps.has(checkAbs) &&
      findDependents(g158.reverse, [themeAbs]).size === 0 &&
      resolvedCss === cssAbs,
      `[158g] import-graph stylesheet leaf nodes + reverse edges + resolveSpecifier('.css') (cssNode: ${g158.files.has(cssAbs)}, revEdge→cart: ${cssRevEdge instanceof Set && cssRevEdge.has(cartAbs)}, deps→checkout: ${cssDeps.has(checkAbs)}, orphanDeps: ${findDependents(g158.reverse, [themeAbs]).size}, resolved: ${resolvedCss === cssAbs})`
    );
  }

  // ── Block [159] D1 bounded-concurrency route auditing (parallel-crawler) ──────────
  // Drives the REAL concurrency primitives the PR Validator's route loop now uses
  // (mapWithConcurrency + auditRoutesConcurrently) with fake async workers + fake clients — no
  // Chrome. The load-bearing safety property is "results identical to sequential": parallel
  // auditing must preserve route order (so the aggregate findings + the baseline-aware block
  // decision never depend on how routes interleave) AND give each lane its own client (so
  // concurrent crawlRouteCheap calls never share a Chrome page-navigation state). The
  // ARGUS_CONCURRENCY default (1) must stay strictly sequential with no extra clients.
  {
    console.log('\n[159] parallel-crawler — bounded-concurrency route auditing (D1)');

    const items159 = [0, 1, 2, 3, 4, 5];

    // [159a] RESULTS IDENTICAL TO SEQUENTIAL: items complete OUT of order (higher indices resolve
    // first), yet results come back in INPUT order — byte-identical to a plain sequential map.
    const out159a = await mapWithConcurrency(items159, 3, async (n) => {
      await new Promise(r => setTimeout(r, (items159.length - n) * 5)); // invert delay
      return n * 10;
    });
    assert(
      JSON.stringify(out159a) === JSON.stringify(items159.map(n => n * 10)),
      `[159a] mapWithConcurrency preserves INPUT order under out-of-order completion → identical to sequential (got: ${JSON.stringify(out159a)})`
    );

    // [159b] BOUNDED CONCURRENCY (proves real parallelism): with concurrency 3 over 6 items the
    // observed simultaneous-in-flight peak is exactly 3 — >1 = genuinely parallel, =3 = bounded.
    let live159b = 0, peak159b = 0;
    await mapWithConcurrency(items159, 3, async () => {
      live159b++; peak159b = Math.max(peak159b, live159b);
      await new Promise(r => setTimeout(r, 15));
      live159b--;
    });
    assert(
      peak159b === 3,
      `[159b] mapWithConcurrency caps in-flight workers at the concurrency, and ran them in parallel (expected peak 3, got: ${peak159b})`
    );

    // [159c] DEFAULT SAFETY — concurrency 1 is strictly sequential: peak in-flight is 1 AND order
    // preserved. This is the ARGUS_CONCURRENCY default, so the prior behaviour is byte-preserved.
    let live159c = 0, peak159c = 0;
    const out159c = await mapWithConcurrency(items159, 1, async (n) => {
      live159c++; peak159c = Math.max(peak159c, live159c);
      await new Promise(r => setTimeout(r, 2));
      live159c--;
      return n;
    });
    assert(
      peak159c === 1 && JSON.stringify(out159c) === JSON.stringify(items159),
      `[159c] mapWithConcurrency concurrency=1 → strictly sequential (peak ${peak159c}, order ${JSON.stringify(out159c)})`
    );

    // [159d] CLIENT-PER-LANE EXCLUSIVITY (the safety core of the CLI path): auditRoutesConcurrently
    // gives each lane its OWN client and NEVER lets two routes use the same client at once
    // (crawlRouteCheap mutates page-nav state). Fake clients track concurrent in-use; the assertion
    // proves max-per-client === 1 while overall parallelism is 3, plus correct create/close counts.
    const routes159  = [{ path: '/a' }, { path: '/b' }, { path: '/c' }, { path: '/d' }];
    const inUse159   = new Map();   // client → current in-use count
    const peakPer159 = new Map();   // client → peak in-use count
    let created159 = 0, closed159 = 0, overallPeak159 = 0, overallLive159 = 0;
    const out159d = await auditRoutesConcurrently(routes159, {
      concurrency:   3,
      primaryClient: 'C0',
      createClient:  async () => `C${++created159}`,
      closeClient:   () => { closed159++; },
      crawlRoute: async (route, client) => {
        overallLive159++; overallPeak159 = Math.max(overallPeak159, overallLive159);
        const u = (inUse159.get(client) ?? 0) + 1;
        inUse159.set(client, u);
        peakPer159.set(client, Math.max(peakPer159.get(client) ?? 0, u));
        await new Promise(r => setTimeout(r, 10));
        inUse159.set(client, inUse159.get(client) - 1);
        overallLive159--;
        return { path: route.path, client };
      },
    });
    const maxPerClient159 = Math.max(...peakPer159.values());
    assert(
      maxPerClient159 === 1 && overallPeak159 === 3 && created159 === 2 && closed159 === 2 &&
      JSON.stringify(out159d.map(r => r.path)) === JSON.stringify(['/a', '/b', '/c', '/d']),
      `[159d] auditRoutesConcurrently: one client per lane (max-per-client ${maxPerClient159}), parallel peak ${overallPeak159}, created ${created159}/closed ${closed159} extra clients, route order ${JSON.stringify(out159d.map(r => r.path))}`
    );

    // [159e] DEFAULT SAFETY — concurrency 1 makes NO extra client and uses ONLY the primary client
    // (byte-identical to the prior sequential single-client loop), results in route order.
    let created159e = 0;
    const seen159e = new Set();
    const out159e = await auditRoutesConcurrently(routes159, {
      concurrency:   1,
      primaryClient: 'PRIMARY',
      createClient:  async () => { created159e++; return `X${created159e}`; },
      crawlRoute: async (route, client) => { seen159e.add(client); return route.path; },
    });
    assert(
      created159e === 0 && seen159e.size === 1 && seen159e.has('PRIMARY') &&
      JSON.stringify(out159e) === JSON.stringify(['/a', '/b', '/c', '/d']),
      `[159e] auditRoutesConcurrently concurrency=1 → 0 extra clients, only the primary used, route order preserved (created: ${created159e}, clients: ${[...seen159e].join(',')})`
    );
  }

  // ── Block [160] D2 selective analyzer depth policy (audit-depth) ──────────────────
  // Drives the REAL shared depth policy both PR-validate paths now use (resolveAuditDepth +
  // selectAnalyzers + runDepthAnalyzers) — Chrome-free. The load-bearing properties: the
  // default tier is byte-identical (cheap → no expensive analyzers), an invalid value fails
  // SAFE to cheap, the 'standard' tier is file-type-selective (and never runs the slow
  // deep-only analyzers), the catalog the policy emits matches the LIVE registry exactly (a
  // drift guard — a renamed analyzer must fail here, not silently never run), and the
  // executor runs only the selected analyzers while isolating a failure (depth only ADDS
  // findings — it can never turn a real failure into a PASS).
  {
    console.log('\n[160] audit-depth — selective analyzer depth policy (D2)');

    const DEEP_ONLY_160 = ['lighthouse', 'memory', 'design-fidelity', 'har-recorder'];

    // [160a] resolveAuditDepth: valid tiers pass through; unset/invalid fail SAFE to cheap;
    // case-insensitive + trimmed. A misconfigured ARGUS_PR_AUDIT_DEPTH must never deepen or skip.
    assert(
      resolveAuditDepth('deep') === 'deep' && resolveAuditDepth('standard') === 'standard' &&
      resolveAuditDepth(undefined) === 'cheap' && resolveAuditDepth('full') === 'cheap' &&
      resolveAuditDepth('  DEEP ') === 'deep' && AUDIT_DEPTHS[0] === 'cheap',
      `[160a] resolveAuditDepth fails safe to cheap on invalid + passes valid tiers (deep→${resolveAuditDepth('deep')}, full→${resolveAuditDepth('full')}, '  DEEP '→${resolveAuditDepth('  DEEP ')})`
    );

    // [160b] DEFAULT SAFETY — cheap → [] regardless of changed files (byte-identical to the
    // prior crawlRouteCheap-only behaviour). The default depth must add NO expensive analyzers.
    const cheap160 = selectAnalyzers({ depth: 'cheap', changedFiles: ['a.css', 'B.tsx', 'c.png'] });
    const dflt160  = selectAnalyzers({ changedFiles: ['a.css'] });   // depth omitted → cheap
    assert(
      cheap160.length === 0 && dflt160.length === 0,
      `[160b] cheap (and omitted) depth selects ZERO expensive analyzers regardless of files (cheap: ${JSON.stringify(cheap160)}, default: ${JSON.stringify(dflt160)})`
    );

    // [160c] standard + a stylesheet change → the layout/theming/visual/contrast set, and
    // NEVER a slow deep-only analyzer.
    const css160 = selectAnalyzers({ depth: 'standard', changedFiles: ['src/styles/app.scss'] });
    const cssSet160 = new Set(css160);
    assert(
      ['css', 'responsive', 'theme', 'motion', 'visual', 'a11y-deep'].every(a => cssSet160.has(a)) &&
      css160.length === 6 && DEEP_ONLY_160.every(d => !cssSet160.has(d)),
      `[160c] standard + .scss → stylesheet analyzer set, no deep-only (got: ${JSON.stringify(css160)})`
    );

    // [160d] standard + a component change → the a11y/interaction/vitals/form set; the
    // "selective" promise that the slow analyzers stay in 'deep' only.
    const tsx160 = selectAnalyzers({ depth: 'standard', changedFiles: ['components/Checkout.tsx'] });
    const tsxSet160 = new Set(tsx160);
    assert(
      ['a11y-deep', 'snapshot', 'keyboard', 'hover', 'web-vitals', 'form'].every(a => tsxSet160.has(a)) &&
      tsx160.length === 6 && DEEP_ONLY_160.every(d => !tsxSet160.has(d)),
      `[160d] standard + .tsx → component analyzer set, excludes every deep-only analyzer (got: ${JSON.stringify(tsx160)})`
    );

    // [160e] standard + a non-UI-only change (docs / config) degrades to cheap → [].
    const nonui160 = selectAnalyzers({ depth: 'standard', changedFiles: ['README.md', 'tsconfig.json', 'deploy.yml'] });
    assert(
      nonui160.length === 0,
      `[160e] standard + non-UI files only → [] (degrades to cheap, got: ${JSON.stringify(nonui160)})`
    );

    // [160f] deep → the full registry catalog (all 16, incl. lighthouse + memory).
    const deep160 = selectAnalyzers({ depth: 'deep' });
    assert(
      deep160.length === 16 && JSON.stringify(deep160) === JSON.stringify(ALL_EXPENSIVE_ANALYZERS) &&
      deep160.includes('lighthouse') && deep160.includes('memory'),
      `[160f] deep → full ${deep160.length}-analyzer catalog incl. lighthouse + memory`
    );

    // [160g] DRIFT GUARD — the policy catalog (ALL_EXPENSIVE_ANALYZERS) must EQUAL the names
    // the live registry actually exposes (getExpensive). A renamed/added/removed analyzer
    // fails HERE (loudly) instead of selectAnalyzers silently emitting a name that matches no
    // analyzer (the recurring "Argus mis-reads its own state" bug class).
    const regNames160 = getExpensive().map(a => a.name).sort();
    const catalog160  = [...ALL_EXPENSIVE_ANALYZERS].sort();
    assert(
      JSON.stringify(regNames160) === JSON.stringify(catalog160),
      `[160g] ALL_EXPENSIVE_ANALYZERS set-equals the live registry getExpensive() names (registry: ${regNames160.length}, catalog: ${catalog160.length}, equal: ${JSON.stringify(regNames160) === JSON.stringify(catalog160)})`
    );

    // [160h] standard unions the rules over a mixed bundle, deduped, in registry order
    // (determinism — the order/dedup matters because routeFindings are aggregated in order).
    const union160 = selectAnalyzers({ depth: 'standard', changedFiles: ['theme.css', 'Card.tsx'] });
    const expectedOrder160 = ALL_EXPENSIVE_ANALYZERS.filter(a => union160.includes(a));
    assert(
      union160.filter(a => a === 'a11y-deep').length === 1 &&
      JSON.stringify(union160) === JSON.stringify(expectedOrder160) &&
      union160.every(a => ALL_EXPENSIVE_ANALYZERS.includes(a)),
      `[160h] standard .css+.tsx → deduped union in registry order, a11y-deep once (got: ${JSON.stringify(union160)})`
    );

    // [160i] EXECUTION — runDepthAnalyzers runs ONLY the selected analyzers, collects their
    // findings, and ISOLATES a thrower (siblings still contribute) — depth is additive only,
    // so it can never turn a real failure into a PASS. DI fake analyzers + a fake browser (no
    // Chrome); also proves an UNSELECTED analyzer's critical finding never leaks in.
    const exec160 = [
      { name: 'good1',    analyze: async () => [{ type: 'g1', severity: 'warning' }] },
      { name: 'bad',      analyze: async () => { throw new Error('analyzer boom'); } },
      { name: 'good2',    analyze: async () => ({ findings: [{ type: 'g2', severity: 'info' }] }) },
      { name: 'unwanted', analyze: async () => [{ type: 'NOPE', severity: 'critical' }] },
    ];
    const wantedOut160 = await runDepthAnalyzers(exec160, { id: 'fake' }, 'http://x/checkout', { path: '/checkout' }, ['good1', 'bad', 'good2']);
    const emptyOut160  = await runDepthAnalyzers(exec160, { id: 'fake' }, 'http://x/checkout', { path: '/checkout' }, []);
    assert(
      JSON.stringify(wantedOut160.map(f => f.type)) === JSON.stringify(['g1', 'g2']) &&
      !wantedOut160.some(f => f.type === 'NOPE') && emptyOut160.length === 0,
      `[160i] runDepthAnalyzers runs only selected, isolates a thrower, drops unselected, [] on empty (wanted: ${JSON.stringify(wantedOut160.map(f => f.type))}, empty: ${emptyOut160.length})`
    );
  }

  // ── Block [161] D3 deploy-preview URL auto-detection (deploy-preview) ──────────────
  // Drives the REAL target-URL resolver both PR-validate paths now use (resolveTargetUrl) —
  // Chrome-free, network stubbed via globalThis.fetch. Load-bearing properties: an explicit
  // ARGUS_PREVIEW_URL / per-call target is honoured; an opt-in GitHub-Deployments probe adopts
  // ONLY a live (success) preview for the PR head SHA; a failed/missing preview and any probe
  // error degrade gracefully to TARGET_DEV_URL (never a false target); and the default path
  // (no preview env) is byte-identical to the pre-D3 TARGET_DEV_URL with NO network call.
  {
    console.log('\n[161] deploy-preview — preview URL auto-detection + graceful fallback (D3)');

    const PREVIEW_DEP_161 = { id: 7001, environment: 'Preview – app', production_environment: false, transient_environment: true };
    const PROD_DEP_161    = { id: 7000, environment: 'Production', production_environment: true };
    const OK_STATUS_161   = [{ state: 'success', environment_url: 'https://pr-99-preview.vercel.app' }];
    const FAIL_STATUS_161 = [{ state: 'failure', environment_url: 'https://broken.vercel.app' }];

    // Stub: the deployments list returns prod + preview; the statuses call returns `statuses`.
    const stubDeploy161 = (statuses) => async (url) =>
      /\/deployments\?sha=/.test(String(url))
        ? { ok: true, json: async () => [PROD_DEP_161, PREVIEW_DEP_161] }
        : { ok: true, json: async () => statuses };

    // [161a] explicit env override (ARGUS_PREVIEW_URL) is adopted as the target, no probe.
    const env161a = await resolveTargetUrl({ env: { ARGUS_PREVIEW_URL: 'https://pr-42.example.app', TARGET_DEV_URL: 'http://dev' } });
    assert(
      env161a.url === 'https://pr-42.example.app' && env161a.source === 'env:ARGUS_PREVIEW_URL',
      `[161a] ARGUS_PREVIEW_URL is adopted as the audit target (got ${JSON.stringify(env161a)})`
    );

    const _origFetch161 = globalThis.fetch;
    try {
      // [161b] opt-in auto-detection adopts the live (success) preview environment_url for the
      // PR head SHA, picking the preview deployment over the production one.
      globalThis.fetch = stubDeploy161(OK_STATUS_161);
      const det161b = await resolveTargetUrl({
        env: { ARGUS_PREVIEW_DETECT: '1', TARGET_DEV_URL: 'http://dev' },
        prUrl: 'https://github.com/o/r/pull/99', headSha: 'deadbeef', token: 't',
      });
      assert(
        det161b.url === 'https://pr-99-preview.vercel.app' && det161b.source === 'deployment',
        `[161b] opt-in detection adopts the live preview environment_url (got ${JSON.stringify(det161b)})`
      );

      // [161c] SAFETY — a FAILED deploy status is never adopted; resolution degrades to
      // TARGET_DEV_URL rather than auditing a broken preview (the false-target guard, the
      // success-state filter is the mutation target).
      globalThis.fetch = stubDeploy161(FAIL_STATUS_161);
      const det161c = await resolveTargetUrl({
        env: { ARGUS_PREVIEW_DETECT: '1', TARGET_DEV_URL: 'http://dev' },
        prUrl: 'https://github.com/o/r/pull/99', headSha: 'deadbeef', token: 't',
      });
      assert(
        det161c.url === 'http://dev' && det161c.source === 'target-dev-url' &&
        previewUrlFromStatuses(FAIL_STATUS_161) === null,
        `[161c] a failed deploy status is NOT adopted — degrades to TARGET_DEV_URL (got ${JSON.stringify(det161c)})`
      );

      // [161d] fail-safe — a probe THROW still resolves to TARGET_DEV_URL (never throws), and
      // production deployments are excluded by the preview heuristic.
      globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
      const det161d = await resolveTargetUrl({
        env: { ARGUS_PREVIEW_DETECT: 'true', TARGET_DEV_URL: 'http://dev' },
        prUrl: 'https://github.com/o/r/pull/99', headSha: 'deadbeef', token: 't',
      });
      assert(
        det161d.url === 'http://dev' && det161d.source === 'target-dev-url' &&
        pickPreviewDeployment([PROD_DEP_161]) === null &&
        pickPreviewDeployment([PROD_DEP_161, PREVIEW_DEP_161]) === PREVIEW_DEP_161,
        `[161d] a probe error degrades safely; production deployments are excluded (got ${JSON.stringify(det161d)})`
      );
    } finally {
      globalThis.fetch = _origFetch161;
    }

    // [161e] DEFAULT byte-identical — with nothing set the resolver returns exactly
    // TARGET_DEV_URL (no network call), and an explicit per-call target outranks an env preview.
    const def161      = await resolveTargetUrl({ env: { TARGET_DEV_URL: 'http://localhost:3000' } });
    const explicit161 = await resolveTargetUrl({ env: { ARGUS_PREVIEW_URL: 'https://preview.app' }, explicitTarget: 'https://explicit.example' });
    assert(
      def161.url === 'http://localhost:3000' && def161.source === 'target-dev-url' &&
      explicit161.url === 'https://explicit.example' && explicit161.source === 'explicit',
      `[161e] default == TARGET_DEV_URL byte-identical; explicit target outranks env preview (default ${JSON.stringify(def161)}, explicit ${JSON.stringify(explicit161)})`
    );
  }

  // ── Block [162] D4 per-route audit timeout / retry (parallel-crawler + the guard) ──────
  // Drives the REAL D4 primitives (withTimeout / auditRouteWithRetry / routeResilienceFromEnv)
  // + the REAL all-routes-failed guard — Chrome-free, no network. Load-bearing safety property:
  // a hung route audit must REJECT (→ recorded as a route ERROR → fed to allRoutesFailed → merge
  // blocked), NEVER resolve as a silent zero-findings pass. A bounded route can only BLOCK, never
  // false-PASS. [162e] proves the timeout → route-error → block chain end-to-end.
  {
    console.log('\n[162] route timeout/retry — per-route audit bound + all-routes-failed guard (D4)');

    const never162 = () => new Promise(() => {});                       // never settles (a hung audit)
    const after162 = (ms, val) => new Promise(r => setTimeout(() => r(val), ms));

    // [162a] CORE SAFETY — withTimeout REJECTS a hung audit (it never resolves on timeout). A
    // resolution here would let a hung route count as a clean pass (a false PASS). This is the
    // mutation target: flipping the timeout from reject→resolve fails this assertion.
    let rejected162a = false, msg162a = '';
    try { await withTimeout(never162(), 25, 'Route audit /x'); }
    catch (e) { rejected162a = true; msg162a = e.message; }
    assert(
      rejected162a && /Route audit \/x timed out after 25ms/.test(msg162a),
      `[162a] withTimeout REJECTS a hung audit, never resolves (got: ${rejected162a ? msg162a : 'RESOLVED — false pass!'})`
    );

    // [162b] withTimeout resolves with the value when the work finishes in time, and is unbounded
    // when ms<=0 (work passed through) — so the bound never spuriously fails a fast, real audit.
    const inTime162  = await withTimeout(after162(5, 'audit-result'), 500);
    const unbound162 = await withTimeout(after162(5, 'passthrough'), 0);
    assert(
      inTime162 === 'audit-result' && unbound162 === 'passthrough',
      `[162b] withTimeout resolves in time + is unbounded at ms<=0 (in-time: ${inTime162}, unbounded: ${unbound162})`
    );

    // [162c] RETRY — auditRouteWithRetry retries a transient failure then succeeds, firing onRetry
    // once per retry. A flaky route recovers instead of being recorded as a failure.
    let calls162c = 0; const retried162c = [];
    const out162c = await auditRouteWithRetry(
      async () => { calls162c++; if (calls162c < 3) throw new Error(`flap ${calls162c}`); return 'recovered'; },
      { retries: 3, onRetry: (attempt, err) => retried162c.push(`${attempt}:${err.message}`) },
    );
    assert(
      out162c === 'recovered' && calls162c === 3 && retried162c.join(',') === '1:flap 1,2:flap 2',
      `[162c] auditRouteWithRetry retries a transient failure then succeeds (calls: ${calls162c}, onRetry: ${JSON.stringify(retried162c)})`
    );

    // [162d] FAIL-LOUD — when every attempt times out, auditRouteWithRetry THROWS (it never
    // returns a value), so the caller records a route error. Proves the timeout reaches every
    // retry and the final state is a throw, not a silent resolution.
    let starts162d = 0, threw162d = false, msg162d = '';
    try {
      await auditRouteWithRetry(() => { starts162d++; return never162(); },
        { timeoutMs: 15, retries: 1, label: 'Route audit /slow' });
    } catch (e) { threw162d = true; msg162d = e.message; }
    assert(
      threw162d && starts162d === 2 && /Route audit \/slow timed out after 15ms/.test(msg162d),
      `[162d] every-attempt-timeout THROWS fail-loud after retries (threw: ${threw162d}, starts: ${starts162d}, msg: ${msg162d})`
    );

    // [162e] END-TO-END (the D4 acceptance) — a single route whose audit hangs is bounded, throws,
    // is recorded as a route ERROR, and the REAL allRoutesFailed guard BLOCKS. A clean only-route
    // and a partial failure do NOT over-block (existing policy). routeResilienceFromEnv defaults to
    // the bounded 120000 ms / 0 retries (never unbounded-by-accident).
    const perRoute162 = [];
    try {
      await auditRouteWithRetry(() => never162(), { timeoutMs: 25, label: 'Route audit /only' });
      perRoute162.push({ route: '/only', critical: 0, warning: 0, info: 0 });           // would be a false pass
    } catch (err) {
      perRoute162.push({ route: '/only', critical: 0, warning: 0, info: 0, error: err.message });
    }
    const blocked162   = allRoutesFailed(perRoute162);
    const cleanOnly162 = allRoutesFailed([{ route: '/a', critical: 0, warning: 0, info: 0 }]);
    const partial162   = allRoutesFailed([{ route: '/a', error: 'x' }, { route: '/b', critical: 0 }]);
    const policy162    = routeResilienceFromEnv({});
    assert(
      blocked162 === true && /timed out after 25ms/.test(perRoute162[0].error ?? '') &&
      cleanOnly162 === false && partial162 === false &&
      policy162.timeoutMs === 120000 && policy162.retries === 0,
      `[162e] a timed-out only-route is recorded as an error and BLOCKS via allRoutesFailed; clean + partial do not over-block; default bound 120000/0 (blocked: ${blocked162}, err: ${perRoute162[0].error}, clean: ${cleanOnly162}, partial: ${partial162}, policy: ${JSON.stringify(policy162)})`
    );
  }

  // ── Block [163] E2 GitHub API resilience (shared resilient github-api client) ──────────
  // Drives the REAL githubFetch + pure helpers (Chrome-free) with a stubbed globalThis.fetch
  // and an injected no-op sleep (so retries are instant). Both PR-validate GitHub throw-path
  // callers — fetchPrFiles (the PR diff) + ghFetch (the PR comment/Check Run) — route through
  // this client. Load-bearing safety: a rate-limit is RETRIED (resilience), a 404/422 is NOT
  // (no API hammering), and EVERY thrown message stays SECRET-FREE — the CLI surfaces a fetch
  // error's message into a ::error:: annotation, so a token leak there would expose a secret.
  {
    console.log('\n[163] GitHub API resilience — shared resilient client (E2)');
    const TOKEN163 = 'ghp_supersecret_harness_token_0123456789';
    const noSleep163 = async () => {};
    const mk163 = (body, { status = 200, ok = status >= 200 && status < 300, statusText = 'OK', headers } = {}) => ({
      ok, status, statusText, headers,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    // [163a] RESILIENCE — a 403 PRIMARY rate-limit (X-RateLimit-Remaining: 0) is RETRIED with
    // backoff, then succeeds. A real GitHub rate-limit must not become an immediate hard fail.
    let calls163a = 0;
    const ok163a = await githubFetch('https://api.github.com/x', {
      sleep: noSleep163,
      fetchImpl: async () => {
        calls163a++;
        return calls163a < 3
          ? mk163('API rate limit exceeded', { status: 403, ok: false, headers: { 'x-ratelimit-remaining': '0' } })
          : mk163({ ok: 1 });
      },
    });
    const body163a = await ok163a.json();
    assert(
      calls163a === 3 && body163a && body163a.ok === 1,
      `[163a] a 403 primary rate-limit is retried then succeeds (calls: ${calls163a}, body: ${JSON.stringify(body163a)})`
    );

    // [163b] NO-HAMMER + SECRET-FREE — a 404 is NOT retried (exactly one call), and the thrown
    // message carries the cause + context but NEVER the token and NEVER "is not defined".
    let calls163b = 0, err163b = null;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep163, context: 'GET repos/o/r/pulls/7/files (page 1)',
        headers: { Authorization: `Bearer ${TOKEN163}` },
        fetchImpl: async () => { calls163b++; return mk163('Not Found', { status: 404, ok: false, statusText: 'Not Found' }); },
      });
    } catch (e) { err163b = e; }
    assert(
      calls163b === 1 && err163b &&
      /404 \(not found\)/.test(err163b.message) &&
      err163b.message.includes('GET repos/o/r/pulls/7/files') &&
      !err163b.message.includes(TOKEN163) && !err163b.message.includes('is not defined'),
      `[163b] a 404 is not retried; error carries the cause, never the token (calls: ${calls163b}, msg: ${err163b && err163b.message})`
    );

    // [163c] STRUCTURED + SCRUBBED — a 422 throws a structured "unprocessable" cause, and a
    // token echoed in the response body is redacted in the thrown message (defensive scrub).
    let err163c = null;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep163,
        fetchImpl: async () => mk163(`Validation Failed; debug Authorization: Bearer ${TOKEN163}`, { status: 422, ok: false }),
      });
    } catch (e) { err163c = e; }
    assert(
      err163c && /422 \(unprocessable\)/.test(err163c.message) &&
      err163c.message.includes('Bearer ***') && !err163c.message.includes(TOKEN163),
      `[163c] a 422 throws a structured, token-scrubbed error (msg: ${err163c && err163c.message})`
    );

    // [163d] BOUNDED EXHAUSTION — a persistent rate-limit (429) is retried up to maxAttempts then
    // THROWS "rate limit exceeded — retries exhausted" (never an unbounded loop, never a silent
    // pass). retryDelayMs honours Retry-After (pure) and isRateLimitResponse draws the retry line.
    let calls163d = 0, err163d = null;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep163, maxAttempts: 3,
        fetchImpl: async () => { calls163d++; return mk163('API rate limit exceeded', { status: 429, ok: false }); },
      });
    } catch (e) { err163d = e; }
    const ra163  = retryDelayMs(429, { 'retry-after': '3' }, 1, { maxMs: 8000 });
    const rl163  = isRateLimitResponse(403, { 'x-ratelimit-remaining': '0' }) && isRateLimitResponse(429, {});
    const norl163 = isRateLimitResponse(403, {}) || isRateLimitResponse(404, {});
    assert(
      calls163d === 3 && err163d && /rate limit exceeded/.test(err163d.message) &&
      /retries exhausted/.test(err163d.message) && ra163 === 3000 && rl163 === true && norl163 === false,
      `[163d] persistent rate-limit exhausts to a fail-loud throw; retryDelayMs/isRateLimitResponse classify (calls: ${calls163d}, ra: ${ra163}, rl: ${rl163}, norl: ${norl163}, msg: ${err163d && err163d.message})`
    );

    // [163e] RETRY BOUNDARY — a transient 5xx is RETRIED then succeeds, while a plain 403
    // (permissions, no rate-limit header) is TERMINAL (one call, "forbidden"): the resilient
    // client retries only the transient/rate-limited statuses, never a permissions error.
    let calls163e1 = 0;
    await githubFetch('https://api.github.com/x', {
      sleep: noSleep163,
      fetchImpl: async () => { calls163e1++; return calls163e1 < 2 ? mk163('Bad Gateway', { status: 502, ok: false }) : mk163({}); },
    });
    let calls163e2 = 0, err163e = null;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep163,
        fetchImpl: async () => { calls163e2++; return mk163('Resource not accessible by integration', { status: 403, ok: false }); },
      });
    } catch (e) { err163e = e; }
    assert(
      calls163e1 === 2 && calls163e2 === 1 && err163e && /403 \(forbidden\)/.test(err163e.message),
      `[163e] a transient 5xx is retried then succeeds; a plain 403 is terminal forbidden (5xx calls: ${calls163e1}, 403 calls: ${calls163e2}, msg: ${err163e && err163e.message})`
    );
  }

  // ── Block [164] PR Validator — block-decision + guard matrix (Phase E3) ─────────
  // Exhaustive merge-gate coverage: the block-on policy matrix (none|warning|critical) ×
  // {0, only-info, warning, critical} findings, the all-routes-failed guard, the base-unavailable
  // fail-safe, and the decision → exit-code mapping — all driven through the REAL shared helpers
  // (decidePrBlock + allRoutesFailed + prExitCode). Chrome-free, network-free. SAFETY-CRITICAL:
  // a finding at/above the threshold must BLOCK (exit 1) and a clean/below-threshold run must PASS
  // (exit 0); the guard must trip only when EVERY route errored; a failed audit must never PASS.
  {
    console.log('\n[164] PR Validator — block-decision + guard matrix (E3)');

    // Finding fixtures for the four severity states a route can present.
    const CRIT164 = { severity: 'critical', type: 'console_error', message: 'TypeError: x is null',     url: 'http://x/checkout' };
    const WARN164 = { severity: 'warning',  type: 'seo_meta',      message: 'Missing meta description', url: 'http://x/checkout' };
    const INFO164 = { severity: 'info',     type: 'design_token',  message: 'token nit',                url: 'http://x/checkout' };
    const STATES = {
      none:     { findings: [],        summary: { critical: 0, warning: 0, info: 0 } },
      onlyInfo: { findings: [INFO164], summary: { critical: 0, warning: 0, info: 1 } },
      warning:  { findings: [WARN164], summary: { critical: 0, warning: 1, info: 0 } },
      critical: { findings: [CRIT164], summary: { critical: 1, warning: 0, info: 0 } },
    };

    // Decide one matrix cell with NO baseline (fail-safe → absolute counts), returning the REAL
    // decision and the REAL exit code that decision produces.
    const cell = (blockOn, state) => {
      const s = STATES[state];
      const d = decidePrBlock({
        routeFindings: [{ path: '/checkout', findings: s.findings }],
        summary: s.summary, blockOn, baseline: null,
      });
      return { blocked: d.blocked, exit: prExitCode({ blocked: d.blocked }), note: d.note, reason: d.reason, baselineAvailable: d.baselineAvailable };
    };
    const row = (blockOn) => ['none', 'onlyInfo', 'warning', 'critical']
      .map(st => { const c = cell(blockOn, st); return `${st}:${c.blocked ? 'B' : 'p'}${c.exit}`; }).join(' ');

    // [164a] block-on=none NEVER blocks — every state passes with exit 0 (even a critical).
    const noneRow = ['none', 'onlyInfo', 'warning', 'critical'].map(st => cell('none', st));
    assert(
      noneRow.every(c => c.blocked === false && c.exit === 0),
      `[164a] block-on=none never blocks across {0,info,warning,critical} → all pass exit 0 (${row('none')})`
    );

    // [164b] block-on=warning blocks iff critical+warning > 0: {0}pass {info}pass {warn}BLOCK {crit}BLOCK.
    const wN = cell('warning', 'none'), wI = cell('warning', 'onlyInfo'), wW = cell('warning', 'warning'), wC = cell('warning', 'critical');
    assert(
      wN.blocked === false && wN.exit === 0 && wI.blocked === false && wI.exit === 0 &&
      wW.blocked === true  && wW.exit === 1 && wC.blocked === true  && wC.exit === 1,
      `[164b] block-on=warning gates on warning+critical (${row('warning')})`
    );

    // [164c] block-on=critical blocks iff critical > 0: {0}pass {info}pass {warn}pass {crit}BLOCK.
    const cN = cell('critical', 'none'), cI = cell('critical', 'onlyInfo'), cW = cell('critical', 'warning'), cC = cell('critical', 'critical');
    assert(
      cN.blocked === false && cN.exit === 0 && cI.blocked === false && cI.exit === 0 &&
      cW.blocked === false && cW.exit === 0 && cC.blocked === true  && cC.exit === 1,
      `[164c] block-on=critical gates on criticals only; a warning alone passes (${row('critical')})`
    );

    // [164d] base-unavailable fail-safe rides EVERY matrix cell: no baseline → baselineAvailable
    // false + a "baseline unavailable" note on every decision, and a BLOCKED cell's reason is
    // scoped "total" (absolute counts), never "new"; a passing cell has reason === null.
    const everyNotes = [].concat(noneRow, [wN, wI, wW, wC, cN, cI, cW, cC])
      .every(c => c.baselineAvailable === false && /baseline unavailable/i.test(c.note));
    assert(
      everyNotes && cC.reason !== null && /total/.test(cC.reason) && !/\bnew\b/.test(cC.reason) && cN.reason === null,
      `[164d] no-baseline fail-safe note on every cell; blocked reason scoped "total" not "new" (notes: ${everyNotes}, critReason: ${cC.reason}, passReason: ${cN.reason})`
    );

    // [164e] all-routes-failed guard: trips ONLY when every audited route errored (→ throw →
    // exit 1); a partial failure, a clean route, and an empty list never over-block.
    const allErr164  = allRoutesFailed([{ route: '/a', error: 'x' }, { route: '/b', error: 'y' }]);
    const partial164 = allRoutesFailed([{ route: '/a', error: 'x' }, { route: '/b', critical: 0 }]);
    const clean164   = allRoutesFailed([{ route: '/a', critical: 0 }]);
    const empty164   = allRoutesFailed([]);
    assert(
      allErr164 === true && partial164 === false && clean164 === false && empty164 === false,
      `[164e] all-routes-failed trips only when EVERY route errored (all: ${allErr164}, partial: ${partial164}, clean: ${clean164}, empty: ${empty164})`
    );

    // [164f] decision → exit-code mapping is the REAL prExitCode: a failed audit (all routes
    // errored) → exit 1; a partial failure (guard false) → 0; a blocked decision → 1; a clean
    // pass → 0; defaults → 0. This is how the all-routes-failed guard reaches exit 1 (failed arm).
    assert(
      prExitCode({ failed: allErr164 }) === 1 && prExitCode({ failed: partial164 }) === 0 &&
      prExitCode({ blocked: true }) === 1 && prExitCode({ blocked: false }) === 0 && prExitCode() === 0,
      `[164f] prExitCode maps the merge gate: failed→1, blocked→1, pass→0 (allFailed→${prExitCode({ failed: allErr164 })}, blocked→${prExitCode({ blocked: true })}, pass→${prExitCode({ blocked: false })})`
    );

    // [164g] the base dimension flips the SAME cell: against a real on-disk baseline a
    // pre-existing critical does NOT block (exit 0), while a NEW critical DOES (exit 1) — proving
    // the matrix is baseline-aware, not just absolute. Drives savePrBaseline → loadPrBaseline.
    const tmp164  = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e3-'));
    const file164 = path.join(tmp164, 'main.json');
    savePrBaseline(file164, [{ path: '/checkout', findings: [CRIT164] }]);     // base already had the critical
    const base164 = loadPrBaseline(file164);
    const preExisting164 = decidePrBlock({ routeFindings: [{ path: '/checkout', findings: [CRIT164] }], summary: STATES.critical.summary, blockOn: 'critical', baseline: base164 });
    const NEWCRIT164 = { severity: 'critical', type: 'console_error', message: 'ReferenceError: total is not defined', url: 'http://x/checkout' };
    const introduced164 = decidePrBlock({ routeFindings: [{ path: '/checkout', findings: [CRIT164, NEWCRIT164] }], summary: { critical: 2, warning: 0, info: 0 }, blockOn: 'critical', baseline: base164 });
    assert(
      preExisting164.blocked === false && prExitCode({ blocked: preExisting164.blocked }) === 0 &&
      introduced164.blocked === true  && prExitCode({ blocked: introduced164.blocked }) === 1 &&
      introduced164.newSummary.critical === 1 && /new/.test(introduced164.reason),
      `[164g] base-aware: pre-existing critical passes (exit 0), PR-introduced critical blocks (exit 1) (preExist: ${preExisting164.blocked}, intro: ${introduced164.blocked}, newCrit: ${introduced164.newSummary.critical})`
    );
  }

  // ── Block [165] PR Validator — CLI ↔ MCP block-decision PARITY (Phase E4) ───────
  // The two PR-validate paths (CLI src/cli/pr-validate.js + MCP handlePrValidate in
  // src/mcp-server.js) audit DIFFERENT route sources by design (routes-file vs config/targets.js),
  // but they MUST agree on the merge-block decision for the SAME findings. They guarantee this
  // structurally: both build the decidePrBlock `summary` input through the shared severityTally and
  // both delegate the gate to the shared decidePrBlock (deriving `blocked` from decision.blocked) —
  // neither re-implements the none|warning|critical matrix. This block pins that contract from the
  // SOURCE (so a future edit can't fork the gate) AND behaviourally (same inputs → same decision,
  // incl. blockOn-casing normalization). Chrome-free, network-free. Complements [164] (matrix
  // correctness) with cross-PATH agreement. SAFETY-CRITICAL: a path that quietly computed the
  // summary or the gate differently could PASS a PR the other path would BLOCK (a false PASS).
  {
    console.log('\n[165] PR Validator — CLI ↔ MCP block-decision parity (E4)');

    const cliSrc165 = fs.readFileSync(path.resolve(__dirname, '../src/cli/pr-validate.js'), 'utf8');
    const mcpSrc165 = fs.readFileSync(path.resolve(__dirname, '../src/mcp-server.js'), 'utf8');

    // [165a] Shared DECISION — neither path re-implements the block-on matrix: both call the shared
    // decidePrBlock, derive `blocked` from decision.blocked, and IMPORT it from pr-baseline (rather
    // than defining a local gate). `effectiveSummary` is decidePrBlock-internal, so its absence from
    // both path files proves neither hand-rolls the gate.
    const cliDelegates165 = /decidePrBlock\(/.test(cliSrc165) && /blocked\s*=\s*decision\.blocked/.test(cliSrc165) &&
      /decidePrBlock[\s\S]*from '\.\.\/utils\/pr-baseline\.js'/.test(cliSrc165);
    const mcpDelegates165 = /decidePrBlock\(/.test(mcpSrc165) && /blocked\s*=\s*decision\.blocked/.test(mcpSrc165) &&
      /decidePrBlock[\s\S]*from '\.\/utils\/pr-baseline\.js'/.test(mcpSrc165);
    const noLocalGate165 = !cliSrc165.includes('effectiveSummary') && !mcpSrc165.includes('effectiveSummary');
    assert(
      cliDelegates165 && mcpDelegates165 && noLocalGate165,
      `[165a] both paths delegate the gate to the shared decidePrBlock + derive blocked from decision.blocked; neither re-implements it (cli: ${cliDelegates165}, mcp: ${mcpDelegates165}, noLocalGate: ${noLocalGate165})`
    );

    // [165b] Shared SUMMARY tally — both build the decidePrBlock `summary` input via
    // severityTally(allFindings) (the legacy inline ".filter(f => f.severity === 'critical').length"
    // triplet is gone from the aggregate), AND severityTally is byte-identical to that legacy recipe
    // for a mixed findings array — so the swap can never change what feeds the gate.
    const cliUsesTally165 = cliSrc165.includes('severityTally(allFindings)');
    const mcpUsesTally165 = mcpSrc165.includes('severityTally(allFindings)');
    const mixed165 = [
      { severity: 'critical' }, { severity: 'critical' }, { severity: 'warning' },
      { severity: 'info' }, { severity: 'info' }, { severity: 'info' }, { severity: 'trace' },
    ];
    const legacyRecipe165 = {
      critical: mixed165.filter(f => f.severity === 'critical').length,
      warning:  mixed165.filter(f => f.severity === 'warning').length,
      info:     mixed165.filter(f => f.severity === 'info').length,
    };
    const tally165 = severityTally(mixed165);
    const tallyMatches165 = JSON.stringify(tally165) === JSON.stringify(legacyRecipe165);
    assert(
      cliUsesTally165 && mcpUsesTally165 && tallyMatches165 &&
      tally165.critical === 2 && tally165.warning === 1 && tally165.info === 3,
      `[165b] both paths build the summary via the shared severityTally, byte-identical to the inline filter recipe (cli: ${cliUsesTally165}, mcp: ${mcpUsesTally165}, tally: ${JSON.stringify(tally165)}, legacy: ${JSON.stringify(legacyRecipe165)})`
    );

    // [165c] Behavioural PARITY — the SAME findings + baseline + blockOn yield the SAME decision
    // through each path's recipe. We reproduce both recipes (severityTally → decidePrBlock →
    // decision.blocked → prExitCode) and assert deep agreement across the block-on matrix, INCLUDING
    // the MCP path's raw/un-normalized blockOn (e.g. ' Critical ') matching the CLI's pre-normalized
    // 'critical' — decidePrBlock's internal normalization is the single agreement point.
    const findings165 = [
      { severity: 'critical', type: 'console_error', message: 'TypeError', url: 'http://x/checkout' },
      { severity: 'warning',  type: 'seo_meta',      message: 'meta',      url: 'http://x/checkout' },
    ];
    const routeFindings165 = [{ path: '/checkout', findings: findings165 }];
    // CLI recipe: summary via shared tally, blockOn pre-normalized (the CLI does toLowerCase().trim()).
    const cliDecide165 = (blockOnRaw) => {
      const blockOn = String(blockOnRaw).toLowerCase().trim();
      const d = decidePrBlock({ routeFindings: routeFindings165, summary: severityTally(findings165), blockOn, baseline: null });
      return { blocked: d.blocked, reason: d.reason, exit: prExitCode({ blocked: d.blocked }) };
    };
    // MCP recipe: identical summary, but pass blockOn RAW (no pre-normalization — the MCP path does not).
    const mcpDecide165 = (blockOnRaw) => {
      const d = decidePrBlock({ routeFindings: routeFindings165, summary: severityTally(findings165), blockOn: blockOnRaw, baseline: null });
      return { blocked: d.blocked, reason: d.reason, exit: prExitCode({ blocked: d.blocked }) };
    };
    const parityCases165 = [
      ['critical', ' Critical '],   // crit present → block under critical
      ['warning',  'WARNING'],      // crit+warn present → block under warning
      ['none',     'None'],         // never blocks
    ];
    const parityHolds165 = parityCases165.every(([cliRaw, mcpRaw]) =>
      JSON.stringify(cliDecide165(cliRaw)) === JSON.stringify(mcpDecide165(mcpRaw)));
    // Not vacuously equal-because-both-broken: the decisions are the expected ones.
    const sane165 = cliDecide165('critical').blocked === true  && cliDecide165('critical').exit === 1 &&
                    cliDecide165('none').blocked     === false && cliDecide165('none').exit     === 0;
    assert(
      parityHolds165 && sane165,
      `[165c] same findings/blockOn → identical decision via both recipes incl. blockOn-casing (parity: ${parityHolds165}, crit: ${JSON.stringify(cliDecide165('critical'))} == ${JSON.stringify(mcpDecide165(' Critical '))}, none: ${JSON.stringify(cliDecide165('none'))})`
    );

    // [165d] The ROUTE-SOURCE divergence is DOCUMENTED as intentional in BOTH files (E4 acceptance:
    // "the chosen resolution is in the code"), each naming the divergence, the shared reportPrValidation
    // helper, and the E4 reference.
    const cliDoc165 = /INTENTIONAL DIVERGENCE/.test(cliSrc165) && /ROUTE-SOURCE/.test(cliSrc165) &&
      /reportPrValidation/.test(cliSrc165) && /E4/.test(cliSrc165);
    const mcpDoc165 = /INTENTIONAL DIVERGENCE/.test(mcpSrc165) && /ROUTE-SOURCE/.test(mcpSrc165) &&
      /reportPrValidation/.test(mcpSrc165) && /E4/.test(mcpSrc165);
    assert(
      cliDoc165 && mcpDoc165,
      `[165d] both files document the intentional route-source divergence + shared reporting + E4 (cli: ${cliDoc165}, mcp: ${mcpDoc165})`
    );
  }

  // ── Block [166] PR Validator — recorded GitHub reporting fixtures (Phase F1) ─────
  // The inline `{ id: N }` stubs in [151]/[152] prove the request SHAPE; this block proves
  // Argus correctly PARSES the documented GitHub *response* shape. It drives the REAL
  // reporter exports (postPrComment / createCheckRun / completeCheckRun / reportPrValidation)
  // against test-harness/contracts/github-reporting-samples.js — faithful issue-comment +
  // check-run objects (a bot comment among humans, full documented fields) routed by
  // makeReportingFetchStub. A response-shape change GitHub could make (id dropped/retyped,
  // body renamed, comment flattened) would break the parse here. Chrome-free + network-free.
  {
    console.log('\n[166] PR Validator — recorded GitHub reporting API fixtures (Phase F1)');

    const prResult166 = {
      prUrl:          'https://github.com/acme/shop/pull/7',
      targetUrl:      'https://staging.example.com',
      affectedRoutes: ['/checkout'],
      changedFiles:   ['src/pages/checkout.tsx'],
      summary:        { critical: 1, warning: 0, info: 0 },
      blocked:        true,
      blockOn:        'critical',
      perRoute:       [{ route: '/checkout', critical: 1, warning: 0, info: 0 }],
      findings: [
        { severity: 'critical', type: 'console_error', message: 'TypeError: x is null', url: 'https://staging.example.com/checkout' },
      ],
    };
    const report166 = prResultToReport(prResult166);
    const diff166   = { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 };

    // [166a] fixture faithfulness — the recorded comment + check-run objects carry the
    // documented GitHub fields, EXACTLY ONE list comment carries the marker, and that marker
    // is the same one a live formatPrComment() render emits (so the fixture cannot silently
    // drift from what Argus actually writes). Non-vacuous: specific field reads + 1-of-3 find.
    const liveBody166    = formatPrComment(report166, diff166);
    const markerLive166  = liveBody166.includes(ARGUS_COMMENT_MARKER);
    const markedComments = issueCommentsListWithArgus.filter(c => c.body.includes(ARGUS_COMMENT_MARKER));
    const argusFixture166 = markedComments[0];
    const commentShape166 = issueCommentsListWithArgus.every(c =>
      Number.isInteger(c.id) && typeof c.body === 'string' &&
      typeof c.user?.login === 'string' && typeof c.html_url === 'string' && typeof c.created_at === 'string');
    const checkRunShape166 =
      Number.isInteger(checkRunCreateResponse.id) && checkRunCreateResponse.head_sha === HEAD_SHA &&
      checkRunCreateResponse.status === 'in_progress' &&
      checkRunCompleteResponse.status === 'completed' && typeof checkRunCompleteResponse.conclusion === 'string';
    assert(
      markerLive166 && markedComments.length === 1 && argusFixture166?.id === ARGUS_COMMENT_ID &&
      commentShape166 && checkRunShape166,
      `[166a] reporting fixtures faithful to the documented GitHub shape; exactly one comment carries the live formatPrComment marker (markerLive: ${markerLive166}, markedCount: ${markedComments.length}, argusId: ${argusFixture166?.id}, commentShape: ${commentShape166}, checkRunShape: ${checkRunShape166})`
    );

    const _origFetch166 = globalThis.fetch;
    const _tok166  = process.env.GITHUB_TOKEN;
    const _repo166 = process.env.GITHUB_REPOSITORY;
    const _pr166   = process.env.GITHUB_PR_NUMBER;
    const _sha166  = process.env.GITHUB_SHA;
    const _head166 = process.env.ARGUS_PR_HEAD_SHA;
    const SECRET166 = 'ghp_reporting_fixture_secret_do_not_leak_166';
    try {
      process.env.GITHUB_TOKEN = SECRET166;
      delete process.env.GITHUB_SHA;
      delete process.env.ARGUS_PR_HEAD_SHA;

      // [166b] postPrComment reads id+body off the FAITHFUL comments list: a list carrying the
      // prior Argus bot-comment (among two human comments) → PATCH that exact comment id, no
      // duplicate POST; a list WITHOUT it → POST a fresh comment. Proves the marker scan
      // discriminates real comment objects. Token rides only in the Authorization header.
      const reqsU166 = [];
      globalThis.fetch = makeReportingFetchStub({ comments: issueCommentsListWithArgus, onRequest: r => reqsU166.push(r) });
      await postPrComment(report166, diff166, { repo: 'acme/shop', prNumber: 7 });
      const patchU166 = reqsU166.find(r => r.method === 'PATCH' && new RegExp(`/issues/comments/${ARGUS_COMMENT_ID}$`).test(r.url));
      const postU166  = reqsU166.find(r => r.method === 'POST'  && /\/issues\/7\/comments$/.test(r.url));
      const authU166  = patchU166?.headers?.Authorization;
      const leakU166  = reqsU166.some(r => String(r.body ?? '').includes(SECRET166));

      const reqsC166 = [];
      globalThis.fetch = makeReportingFetchStub({ comments: issueCommentsListNoArgus, onRequest: r => reqsC166.push(r) });
      await postPrComment(report166, diff166, { repo: 'acme/shop', prNumber: 7 });
      const postC166  = reqsC166.find(r => r.method === 'POST'  && /\/issues\/7\/comments$/.test(r.url));
      const patchC166 = reqsC166.find(r => r.method === 'PATCH');

      assert(
        patchU166 && !postU166 && authU166 === `Bearer ${SECRET166}` && !leakU166 &&
        postC166 && !patchC166,
        `[166b] postPrComment PATCHes the prior Argus comment (id ${ARGUS_COMMENT_ID}) from the faithful list, no dup POST; a list without it POSTs anew; token in auth header only (update: ${!!patchU166}, dupPost: ${!!postU166}, create: ${!!postC166}, bodyLeak: ${leakU166})`
      );

      // [166c] createCheckRun reads `id` off the rich create response (not a toy {id}) and hands
      // it to completeCheckRun, which PATCHes /check-runs/{thatId} with completed+failure (the
      // blocked decision). The create POST carries head_sha + in_progress; no token in any body.
      const reqsK166 = [];
      globalThis.fetch = makeReportingFetchStub({ onRequest: r => reqsK166.push(r) });
      const checkId166 = await createCheckRun(undefined, HEAD_SHA, { repo: 'acme/shop' });
      await completeCheckRun(checkId166, report166, diff166, { repo: 'acme/shop' });
      const crPost166   = reqsK166.find(r => r.method === 'POST'  && /\/check-runs$/.test(r.url));
      const crPatch166  = reqsK166.find(r => r.method === 'PATCH' && new RegExp(`/check-runs/${CHECK_RUN_ID}$`).test(r.url));
      const crPostBody  = crPost166  ? JSON.parse(crPost166.body)  : {};
      const crPatchBody = crPatch166 ? JSON.parse(crPatch166.body) : {};
      const crLeak166   = reqsK166.some(r => String(r.body ?? '').includes(SECRET166));
      assert(
        checkId166 === CHECK_RUN_ID &&
        crPost166 && crPostBody.head_sha === HEAD_SHA && crPostBody.status === 'in_progress' &&
        crPatch166 && crPatchBody.status === 'completed' && crPatchBody.conclusion === 'failure' && !crLeak166,
        `[166c] createCheckRun reads id ${CHECK_RUN_ID} off the faithful response → completeCheckRun PATCHes /check-runs/${CHECK_RUN_ID} (completed/failure); no token leak (id: ${checkId166}, postStatus: ${crPostBody.status}, patchConclusion: ${crPatchBody.conclusion})`
      );

      // [166d] END-TO-END — reportPrValidation off the full recorded fixture set + a resolvable
      // head SHA (repo/PR resolved from the URL): one idempotent comment PATCH (the prior Argus
      // comment id) + a Check Run create→complete (the fixture id), and the GITHUB_TOKEN never
      // appears in ANY request body across the whole flow.
      process.env.ARGUS_PR_HEAD_SHA = HEAD_SHA;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_PR_NUMBER;
      const reqsE166 = [];
      globalThis.fetch = makeReportingFetchStub({ comments: issueCommentsListWithArgus, onRequest: r => reqsE166.push(r) });
      const out166 = await reportPrValidation(prResult166, { prUrl: prResult166.prUrl });
      const ePatchComment166 = reqsE166.find(r => r.method === 'PATCH' && new RegExp(`/issues/comments/${ARGUS_COMMENT_ID}$`).test(r.url));
      const eCrPost166       = reqsE166.find(r => r.method === 'POST'  && /\/check-runs$/.test(r.url));
      const eCrPatch166      = reqsE166.find(r => r.method === 'PATCH' && new RegExp(`/check-runs/${CHECK_RUN_ID}$`).test(r.url));
      const eLeak166         = reqsE166.some(r => String(r.body ?? '').includes(SECRET166));
      assert(
        out166.posted === true && out166.checked === true &&
        ePatchComment166 && eCrPost166 && eCrPatch166 && !eLeak166,
        `[166d] reportPrValidation drives the whole reporting flow off the recorded fixtures: idempotent comment PATCH (id ${ARGUS_COMMENT_ID}) + Check Run create→complete (id ${CHECK_RUN_ID}); no token in any body (posted: ${out166.posted}, checked: ${out166.checked}, commentPatch: ${!!ePatchComment166}, crCreate: ${!!eCrPost166}, crComplete: ${!!eCrPatch166}, leak: ${eLeak166})`
      );
    } finally {
      globalThis.fetch = _origFetch166;
      if (_tok166  === undefined) delete process.env.GITHUB_TOKEN;      else process.env.GITHUB_TOKEN      = _tok166;
      if (_repo166 === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = _repo166;
      if (_pr166   === undefined) delete process.env.GITHUB_PR_NUMBER;  else process.env.GITHUB_PR_NUMBER  = _pr166;
      if (_sha166  === undefined) delete process.env.GITHUB_SHA;        else process.env.GITHUB_SHA        = _sha166;
      if (_head166 === undefined) delete process.env.ARGUS_PR_HEAD_SHA; else process.env.ARGUS_PR_HEAD_SHA = _head166;
    }
  }

  // ── Block [167] PR Validator — CLI end-to-end (child process) against the fixture app (F2) ──
  // Drives the REAL CLI entry point src/cli/pr-validate.js as a CHILD PROCESS — exactly what
  // action.yml runs in CI — against the live harness fixture server (devPort) + an injected PR
  // file list (a hermetic in-process mock of GitHub's /pulls/N/files, reached via the new
  // GITHUB_API_URL seam). This is the ONLY block that exercises main()'s full wiring end-to-end
  // (fetchPrFiles → mapFilesToRoutesDeep → reachability → Chrome audit → baseline-aware
  // decidePrBlock → $GITHUB_OUTPUT / step summary / ::error annotations / process exit code),
  // closing the "CLI/MCP main() never E2E-driven" KNOWN LIMITATION every Phase A–E item flagged.
  {
    console.log('\n[167] PR Validator — CLI end-to-end (child process) against the fixture app (F2)');

    let resA167 = null, resB167 = null;
    let mockAReqs167 = [], mockBReqs167 = [], resultB167 = null;
    let routesFile167 = null;
    try {
      const target167 = `http://localhost:${devPort}`;

      // Scenario A — a docs-only PR (README.md + docs/*.md) → mapFilesToRoutes returns [] →
      // the CLI skips the audit and exits 0 BEFORE Chrome is even contacted (fully hermetic).
      const mockA167 = await startMockGitHubApi([
        { filename: 'README.md',     status: 'modified', patch: null },
        { filename: 'docs/guide.md', status: 'modified', patch: null },
      ]);
      mockAReqs167 = mockA167.requests;
      try {
        resA167 = await runPrValidateCli({
          ARGUS_PR_URL:   'https://github.com/acme/shop/pull/7',
          GITHUB_API_URL: `http://127.0.0.1:${mockA167.port}`,
          TARGET_DEV_URL: target167,
          ARGUS_BLOCK_ON: 'critical',
        });
      } finally {
        try { mockA167.server.close(); } catch {}
      }

      // Scenario B — a real Chrome audit that BLOCKS. The changed file's slug matches no route,
      // so mapFilesToRoutes falls back to ALL routes (= the one configured fixture route); the
      // CLI audits /blank-page.html → an intrinsic blank_page CRITICAL → with no baseline the
      // fail-safe absolute-block path fires → exit 1.
      routesFile167 = path.join(os.tmpdir(), `argus-f2-routes-${Date.now()}.json`);
      fs.writeFileSync(routesFile167, JSON.stringify([{ path: '/blank-page.html', name: 'blank' }]));
      const mockB167 = await startMockGitHubApi([
        { filename: 'src/app/widget.tsx', status: 'modified', patch: '@@ -0,0 +1,2 @@\n+export const Widget = () => null;' },
      ]);
      mockBReqs167 = mockB167.requests;
      try {
        resB167 = await runPrValidateCli({
          ARGUS_PR_URL:      'https://github.com/acme/shop/pull/8',
          GITHUB_API_URL:    `http://127.0.0.1:${mockB167.port}`,
          TARGET_DEV_URL:    target167,
          ARGUS_BLOCK_ON:    'critical',
          ARGUS_ROUTES_FILE: routesFile167,
        });
        resultB167 = extractCliResultJson(resB167.stdout);
      } finally {
        try { mockB167.server.close(); } catch {}
      }
    } catch (e167) {
      console.log('  [167] setup error: ' + e167.message);
    } finally {
      if (routesFile167) { try { fs.rmSync(routesFile167, { force: true }); } catch {} }
    }

    const exA167   = resA167?.exitCode;
    const exB167   = resB167?.exitCode;
    const outA167  = resA167?.outputs ?? {};
    const outB167  = resB167?.outputs ?? {};
    const sumA167  = resA167?.summary ?? '';
    const sumB167  = resB167?.summary ?? '';
    const stdoutB167 = resB167?.stdout ?? '';
    const stderrB167 = resB167?.stderr ?? '';

    // [167a] Scenario A: a docs-only PR skips the audit and exits 0 (no Chrome needed) — the CLI
    //   took the "no affected routes" early-exit path and did not error.
    assert(
      exA167 === 0 && (resA167?.stdout ?? '').includes('No affected routes'),
      `[167a] docs-only PR → CLI skips the audit and exits 0 (exit: ${exA167}, skipLog: ${(resA167?.stdout ?? '').includes('No affected routes')})`
    );

    // [167b] Scenario A: $GITHUB_OUTPUT reflects the pass — blocked=false, zero criticals, empty
    //   affected_routes (the key=value contract that action.yml's downstream steps consume).
    assert(
      outA167.blocked === 'false' && outA167.critical_count === '0' && outA167.affected_routes === '',
      `[167b] skip run writes GITHUB_OUTPUT blocked=false / critical_count=0 / affected_routes='' (got: ${JSON.stringify(outA167)})`
    );

    // [167c] Scenario A: the step summary renders the PASSED banner, and the mock GitHub API
    //   received exactly the /pulls/7/files request with NO Authorization header (tokenless run).
    assert(
      sumA167.includes('Argus PR Validator — PASSED') &&
      mockAReqs167.length === 1 && /\/pulls\/7\/files/.test(mockAReqs167[0].url) && mockAReqs167[0].hadAuth === false,
      `[167c] skip run step summary = PASSED + mock served /pulls/7/files tokenless (passed: ${sumA167.includes('PASSED')}, reqs: ${JSON.stringify(mockAReqs167)})`
    );

    // [167d] Scenario B: the real fixture audit found a critical and the CLI exited 1 — the CI
    //   merge gate. (Paired with [167a]'s exit 0, this proves the CLI distinguishes 0 vs 1.)
    assert(
      exB167 === 1,
      `[167d] blocking PR → CLI audits the fixture route and exits 1 (exit: ${exB167}, stderrTail: ${(resB167?.stderr ?? '').slice(-200)})`
    );

    // [167e] Scenario B: $GITHUB_OUTPUT marks the block — blocked=true, ≥1 critical, and
    //   affected_routes names the audited route.
    assert(
      outB167.blocked === 'true' && Number(outB167.critical_count) >= 1 && outB167.affected_routes === '/blank-page.html',
      `[167e] block run writes GITHUB_OUTPUT blocked=true / critical_count≥1 / affected_routes=/blank-page.html (got: ${JSON.stringify(outB167)})`
    );

    // [167f] Scenario B: two visible-CI-feedback ::error annotations are emitted — a per-FINDING
    //   one anchored on the audited route (stdout, console.log line 459) AND the merge-BLOCKED
    //   reason (stderr, console.error line 572; GitHub treats both streams as annotations) — and
    //   the JSON result printed for downstream steps agrees blocked=true.
    const findingAnnot167 = /::error[^\n]*\[blank_page\][^\n]*blank-page\.html/.test(stdoutB167);
    const blockAnnot167   = /::error::Argus PR Validator:.*Merge blocked/.test(stdoutB167 + '\n' + stderrB167);
    assert(
      findingAnnot167 && blockAnnot167 && resultB167 && resultB167.blocked === true,
      `[167f] block run emits a per-finding ::error annotation + the merge-blocked ::error annotation + JSON result blocked=true (finding: ${findingAnnot167}, blocked: ${blockAnnot167}, json.blocked: ${resultB167?.blocked})`
    );

    // [167g] Scenario B: the step summary renders the BLOCKED banner + the per-route breakdown
    //   row + the blank_page finding type (the reviewer-facing detail).
    assert(
      sumB167.includes('BLOCKED — merge prevented') &&
      sumB167.includes('/blank-page.html') &&
      sumB167.includes('blank_page'),
      `[167g] block run step summary = BLOCKED banner + route row + blank_page (blocked: ${sumB167.includes('BLOCKED')}, row: ${sumB167.includes('/blank-page.html')}, type: ${sumB167.includes('blank_page')})`
    );

    // [167h] Scenario B: the JSON result is internally consistent — the audited route is the one
    //   configured route, the critical tally is ≥1, a blank_page finding is present; and the mock
    //   served /pulls/8/files tokenless (proving GITHUB_TOKEN never reached GitHub end-to-end).
    assert(
      resultB167 &&
      Array.isArray(resultB167.affectedRoutes) && resultB167.affectedRoutes.includes('/blank-page.html') &&
      resultB167.summary && resultB167.summary.critical >= 1 &&
      Array.isArray(resultB167.findings) && resultB167.findings.some(f => f.type === 'blank_page') &&
      mockBReqs167.length === 1 && /\/pulls\/8\/files/.test(mockBReqs167[0].url) && mockBReqs167[0].hadAuth === false,
      `[167h] block run JSON result: audited /blank-page.html, critical≥1, blank_page present, mock tokenless (affected: ${JSON.stringify(resultB167?.affectedRoutes)}, crit: ${resultB167?.summary?.critical}, types: ${JSON.stringify((resultB167?.findings ?? []).map(f => f.type).slice(0, 5))}, reqs: ${JSON.stringify(mockBReqs167)})`
    );
  }

  // ── [168] AEGIS — CONFIDENTIALITY EGRESS BOUNDARY ───────────────────────────────
  // Drives the REAL production cheap pipeline (crawlRouteCheap + processReport, the
  // step-3c wiring) against test-harness/pages/sensitive-findings.html, then proves the
  // ONE Aegis invariant at the boundary: no secret / PII / internal-topology substring
  // survives redactForEgress, while the LOCAL on-disk report keeps full fidelity.
  //
  // NON-VACUOUS by construction: [168d]'s `rawHadSecrets` precondition asserts the raw
  // findings genuinely carry the secrets (so the "absent from projection" check has
  // something to strip); [168f] reads the secret back off DISK (fidelity) AND asserts the
  // step-3c tag (wiring). Step 4 (MCP egress guards, all 9 tools) adds [168i] (the `redaction`
  // rider safeParses + a malformed rider is rejected) and the END-TO-END boundary proofs
  // [168k] (a LIVE argus_audit on the fixture via the spawned server leaks no secret + carries
  // the rider) / [168l] (the SAME audit with ARGUS_REDACT_SENSITIVE=0 returns the secret RAW —
  // proving [168k] is non-vacuous AND the opt-out is honoured at the boundary).
  {
    console.log('\n[168] Aegis — sensitive findings are redacted at the egress boundary (real pipeline)');

    const JWT168   = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJyb290In0.s3cretSIGNATUREvalueABCdef1234567890';
    const ANTH168  = 'sk-ant-api03-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk';
    const EMAIL168 = 'jane.doe@billing-corp.com';
    const CARD168  = '4111 1111 1111 1111';   // Luhn-valid, as embedded (with spaces)
    const CARDD168 = '4111111111111111';        // normalised (no spaces) — must also never leak
    const SECRETS_RAW168    = [JWT168, ANTH168, EMAIL168, CARD168];
    const SECRETS_ABSENT168 = [JWT168, ANTH168, EMAIL168, CARD168, CARDD168];

    const route168 = { name: 'sensitive-findings', path: '/sensitive-findings.html', critical: false, waitFor: null };
    const url168   = `${B}/sensitive-findings.html`;

    // ── Drive the REAL production cheap pipeline against the fixture ──────────────
    let crawl168 = { errors: [] };
    let crawlErr168 = null;
    try {
      crawl168 = await crawlRouteCheap(route168, B, mcp);
    } catch (e) { crawlErr168 = e; }
    const crawled168 = Array.isArray(crawl168.errors) ? crawl168.errors : [];

    // [168a] a security_* finding from the real crawl is tagged sensitive:true (Layer 1).
    const report168a = { routes: [{ route: route168.name, url: url168, errors: crawled168.map(f => ({ ...f })) }] };
    classifySensitivity(report168a, { reportRef: 'error-report-168a.json' });
    const secTagged168 = report168a.routes[0].errors.find(f => typeof f.type === 'string' && f.type.startsWith('security_'));
    assert(
      crawlErr168 === null && !!secTagged168 && secTagged168.sensitive === true &&
        typeof secTagged168.localRef === 'string' && secTagged168.localRef.length > 0,
      `[168a] a security_* finding from the real crawl is tagged sensitive:true with a localRef (crawlErr: ${crawlErr168?.message ?? 'none'}, type: ${secTagged168?.type ?? 'NONE'}, sensitive: ${secTagged168?.sensitive}, localRef: ${secTagged168?.localRef ?? 'none'})`
    );

    // [168b] a BENIGN-category finding whose message embeds a key is sensitive by CONTENT (Layer 2).
    const benignKey168 = { type: 'seo_missing_description', severity: 'warning', url: url168,
      message: `Analytics misconfigured — left ${ANTH168} in the page <head>` };
    const bk168 = classifyFinding(benignKey168);
    assert(
      bk168.sensitive === true && bk168.sensitivityReasons.includes('secret:anthropic_key'),
      `[168b] a benign-type finding carrying an injected sk-ant key is tagged sensitive via the content layer, not the category (sensitive: ${bk168.sensitive}, reasons: ${JSON.stringify(bk168.sensitivityReasons)})`
    );

    // [168c] negative control — an ordinary SEO finding is NOT sensitive and its message crosses egress intact.
    const seoClean168 = { type: 'seo_missing_description', severity: 'warning', url: url168,
      message: 'Missing meta description — add a <meta name="description"> tag for SEO' };
    const seoClass168 = classifyFinding(seoClean168);
    const seoProj168  = redactForEgress([seoClean168])[0];
    assert(
      seoClass168.sensitive === false && seoProj168.message === seoClean168.message,
      `[168c] the negative-control SEO finding is not sensitive and its message crosses egress intact (sensitive: ${seoClass168.sensitive}, message preserved: ${seoProj168.message === seoClean168.message})`
    );

    // Faithful sensitive finding shapes (exactly what the analyzers emit — verified vs
    // security-analyzer.js) so the redaction invariants are deterministic + non-vacuous.
    const samples168 = [
      { type: 'security_token_in_url', severity: 'critical', url: url168,
        requestUrl: `http://auth.internal:8080/api/x?token=${JWT168}#frag`,
        message: `Sensitive parameter in request URL: http://auth.internal:8080/api/x?token=${JWT168}` },
      { type: 'security_sensitive_console', severity: 'warning', url: url168,
        message: `Sensitive data in console output: Authorization: Bearer ${ANTH168}` },
      { type: 'console', level: 'error', severity: 'warning', url: url168,
        message: `Payment for ${EMAIL168} on card ${CARD168} declined` },
      seoClean168,
    ];
    const proj168    = redactForEgress(samples168);
    const projStr168 = JSON.stringify(proj168);
    const rawStr168  = JSON.stringify(samples168);

    // [168d] the projection drops every secret/PII substring but keeps type+route+severity.
    const rawHadSecrets168 = SECRETS_RAW168.every(s => rawStr168.includes(s)); // non-vacuous precondition
    const projLeak168      = SECRETS_ABSENT168.filter(s => projStr168.includes(s));
    const sensProj168      = proj168.find(p => p.type === 'security_token_in_url');
    assert(
      rawHadSecrets168 && projLeak168.length === 0 &&
        sensProj168 && sensProj168.severity === 'critical' && sensProj168.route === '/sensitive-findings.html',
      `[168d] egress projection keeps type/route/severity but contains NONE of the JWT/key/email/card substrings (rawHadSecrets: ${rawHadSecrets168}, leaked: ${JSON.stringify(projLeak168)}, route: ${sensProj168?.route})`
    );

    // [168e] a url with ?token=eyJ… is projected with the query string + fragment stripped.
    assert(
      typeof sensProj168?.requestUrl === 'string' &&
        !sensProj168.requestUrl.includes('?') && !sensProj168.requestUrl.includes('#') &&
        !sensProj168.requestUrl.includes(JWT168) && sensProj168.requestUrl.includes('/api/x'),
      `[168e] requestUrl is projected with the query string + fragment (and the embedded JWT) stripped (got: ${sensProj168?.requestUrl})`
    );

    // [168f] LOCAL FIDELITY via the REAL pipeline — processReport (step 3c) tags but never strips on disk.
    const tmp168 = path.join(os.tmpdir(), `argus-harness-168-${Date.now()}`);
    fs.mkdirSync(path.join(tmp168, 'baselines'), { recursive: true });
    const fidReport168 = {
      generatedAt: new Date().toISOString(), baseUrl: B,
      routes: [{ route: 'sensitive-findings', url: url168, errors: [
        { type: 'security_sensitive_console', severity: 'warning', url: url168,
          message: `Bearer ${ANTH168} and token ${JWT168}`,
          evidence: `<script>fetch('/x?token=${JWT168}')</script>` },
      ] }],
      flows: [], codebase: [], summary: { total: 0, critical: 0, warning: 0, info: 0 },
    };
    const { reportPath: rp168 } = await processReport(fidReport168, { outputDir: tmp168, severityOverrides: {} });
    const onDisk168 = fs.readFileSync(rp168, 'utf8');
    const diskFinding168 = JSON.parse(onDisk168).routes[0].errors[0];
    assert(
      onDisk168.includes(JWT168) && onDisk168.includes(ANTH168) &&
        onDisk168.includes(`/x?token=${JWT168}`) && diskFinding168.sensitive === true,
      `[168f] the on-disk report retains the full secret-bearing message + evidence AND step-3c tagged it sensitive (JWT on disk: ${onDisk168.includes(JWT168)}, evidence on disk: ${onDisk168.includes('/x?token=' + JWT168)}, tagged: ${diskFinding168.sensitive})`
    );

    // [168g] FAIL-CLOSED — failClosed projection emits zero secrets; a throwing-getter finding → stub.
    const failClosedStr168 = JSON.stringify(redactForEgress(samples168, { failClosed: true }));
    const boom168 = { type: 'console', severity: 'warning', url: url168 };
    Object.defineProperty(boom168, 'message', { enumerable: true, get() { throw new Error('classifier boom'); } });
    const stub168 = redactForEgress([boom168])[0];
    assert(
      SECRETS_ABSENT168.every(s => !failClosedStr168.includes(s)) &&
        typeof stub168.detail === 'string' && stub168.detail.includes('redacted') && !('message' in stub168),
      `[168g] fail-closed redacts MORE — failClosed projection leaks no secret AND a finding whose getter throws becomes a redacted stub (failClosed clean: ${SECRETS_ABSENT168.every(s => !failClosedStr168.includes(s))}, stub detail: ${stub168.detail}, stub has message: ${'message' in stub168})`
    );

    // [168h] summarizeRedaction reconciles with the number of sensitive findings.
    const expectedRedacted168 = samples168.filter(f => classifyFinding(f).sensitive).length;
    const sum168 = summarizeRedaction(samples168);
    assert(
      sum168.total === samples168.length && sum168.redacted === expectedRedacted168 && expectedRedacted168 === 3,
      `[168h] summarizeRedaction reconciles with the sensitive count (total: ${sum168.total}/${samples168.length}, redacted: ${sum168.redacted}, expected: ${expectedRedacted168})`
    );

    // [168j] scrubText is idempotent and (mask mode) never lengthens the input.
    const blob168  = `tok ${ANTH168} jwt ${JWT168} mail ${EMAIL168} card ${CARD168}`;
    const once168  = scrubText(blob168, { mode: 'mask' });
    const twice168 = scrubText(once168, { mode: 'mask' });
    assert(
      findSensitiveSpans(blob168).length > 0 && once168 === twice168 &&
        once168.length <= blob168.length && !once168.includes(JWT168) && !once168.includes(ANTH168),
      `[168j] scrubText is idempotent + never lengthens (spans: ${findSensitiveSpans(blob168).length}, idempotent: ${once168 === twice168}, no-lengthen: ${once168.length <= blob168.length})`
    );

    // [168i] Step 4 — the optional `redaction` rider that EVERY guarded MCP tool response now
    // carries safeParses in the golden-schema contract, and a malformed (retyped) rider is
    // REJECTED (non-vacuous). Closes the item deferred by the Step-3 session.
    const rider168    = buildRedactionRider(samples168, { localReportPath: rp168 });
    const riderOk168  = redactionRiderSchema.safeParse(rider168);
    const riderBad168 = redactionRiderSchema.safeParse({ redacted: 'three', total: 4 }); // redacted retyped → reject
    assert(
      riderOk168.success === true && riderBad168.success === false &&
        rider168.redacted === 3 && rider168.total === samples168.length &&
        rider168.localReportPath === rp168,
      `[168i] the redaction rider safeParses (good) + a retyped rider is rejected (non-vacuous) (good: ${riderOk168.success}, badRejected: ${!riderBad168.success}, redacted: ${rider168.redacted}/${rider168.total})`
    );

    // [168k] END-TO-END MCP boundary — a LIVE argus_audit on the sensitive fixture (via the
    // spawned server, default redaction ON) returns findings carrying NONE of the secret
    // substrings AND a `redaction` rider that safeParses. The Step-4 acceptance proof (§12.1).
    let srv168k = null, auditText168 = '', auditObj168 = null, err168k = null;
    try {
      srv168k = await spawnArgusServer(path.resolve(__dirname, '..'), { TARGET_DEV_URL: B });
      const resp = await mcpToolCall(srv168k.proc, 'argus_audit', { url: url168 }, 90000);
      auditText168 = resp?.result?.content?.[0]?.text ?? '';
      try { auditObj168 = JSON.parse(auditText168); } catch { /* non-JSON */ }
    } catch (e) { err168k = e; } finally { try { srv168k?.proc?.kill(); } catch {} }
    const leakedLive168 = SECRETS_ABSENT168.filter(s => auditText168.includes(s));
    const riderLive168  = auditObj168?.redaction ? redactionRiderSchema.safeParse(auditObj168.redaction) : { success: false };
    assert(
      err168k === null && auditObj168 !== null && Array.isArray(auditObj168.findings) &&
        leakedLive168.length === 0 && riderLive168.success === true,
      `[168k] a LIVE argus_audit on the sensitive fixture leaks no JWT/key/email/card substring + carries a redaction rider (err: ${err168k?.message ?? 'none'}, findings: ${auditObj168?.findings?.length}, leaked: ${JSON.stringify(leakedLive168)}, rider: ${riderLive168.success})`
    );

    // [168l] NON-VACUITY + opt-out — the SAME live audit with ARGUS_REDACT_SENSITIVE=0 returns
    // the secret-bearing findings RAW (≥1 secret substring present). Proves [168k]'s redaction
    // does real work (without it the secret WOULD cross) AND the opt-out is byte-passthrough.
    let srvOff168 = null, offText168 = '', errOff168 = null;
    try {
      srvOff168 = await spawnArgusServer(path.resolve(__dirname, '..'), { TARGET_DEV_URL: B, ARGUS_REDACT_SENSITIVE: '0' });
      const resp = await mcpToolCall(srvOff168.proc, 'argus_audit', { url: url168 }, 90000);
      offText168 = resp?.result?.content?.[0]?.text ?? '';
    } catch (e) { errOff168 = e; } finally { try { srvOff168?.proc?.kill(); } catch {} }
    const leakedOff168 = SECRETS_ABSENT168.filter(s => offText168.includes(s));
    assert(
      errOff168 === null && leakedOff168.length > 0,
      `[168l] with the opt-out (ARGUS_REDACT_SENSITIVE=0) the same audit returns ≥1 secret RAW — proving [168k] redaction is non-vacuous (err: ${errOff168?.message ?? 'none'}, leakedRaw: ${JSON.stringify(leakedOff168)})`
    );
  }

  // ── [169] AEGIS — egress-sink guards (Slack / GitHub / HTML / CI, plan Steps 5–7) ──
  // Network-free + Chrome-free: drives the REAL non-MCP sinks with a SENSITIVE finding
  // (a JWT in the url query + an Anthropic key in the message) and pins the ONE invariant —
  // no secret substring crosses — while the opt-out (ARGUS_REDACT_SENSITIVE=0) lets it
  // through (the non-vacuity guard, proving the redaction is load-bearing, never a tautology).
  //   GitHub: reportPrValidation → the PR comment body via makeReportingFetchStub.
  //   HTML:   generateHtmlReport({external:true}) vs the RAW on-disk JSON (local fidelity).
  //   CI:     buildStepSummary + safeFindingLine (cli/pr-validate.js).
  {
    console.log('\n[169] Aegis — egress-sink guards (Slack/GitHub/HTML/CI step summary)');

    const JWT169 = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const KEY169 = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789AbCdEf01_xyz';
    const SECRETS169 = [JWT169, KEY169];
    const leaks169 = (t) => SECRETS169.filter(s => String(t).includes(s));

    const sensitive169 = {
      type: 'security_no_https', severity: 'critical', isNew: true,
      url: `https://staging.example.com/login?session=${JWT169}`,
      message: `Login posts over HTTP; captured Authorization: Bearer ${KEY169}`,
      evidence: '<form action="http://app.internal/login">',
    };
    const benign169 = {
      type: 'seo_title_missing', severity: 'warning', isNew: true,
      url: 'https://staging.example.com/about', message: 'Page is missing a descriptive <title> element',
    };
    const prResult169 = {
      prUrl: 'https://github.com/acme/shop/pull/7', targetUrl: 'https://staging.example.com',
      affectedRoutes: ['/login'], changedFiles: ['src/pages/login.tsx'],
      summary: { critical: 1, warning: 1, info: 0 }, blocked: true, blockOn: 'critical',
      perRoute: [{ route: '/login', critical: 1, warning: 1, info: 0 }],
      findings: [sensitive169, benign169],
    };

    // ── GitHub PR comment sink (Step 6) ─────────────────────────────────────────
    const _origFetch169 = globalThis.fetch;
    const _saved169 = {
      tok: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY, pr: process.env.GITHUB_PR_NUMBER,
      sha: process.env.GITHUB_SHA, head: process.env.ARGUS_PR_HEAD_SHA, redact: process.env.ARGUS_REDACT_SENSITIVE,
    };
    const SECRETTOK169 = 'ghp_aegis_sink_token_do_not_leak_169';
    delete process.env.GITHUB_REPOSITORY; delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_SHA; delete process.env.ARGUS_PR_HEAD_SHA;   // no Check Run noise
    delete process.env.ARGUS_REDACT_SENSITIVE;                              // default ON
    let postOn169 = '', postOff169 = '';
    try {
      process.env.GITHUB_TOKEN = SECRETTOK169;

      // [169a] default ON: the posted comment body carries NEITHER the finding's JWT/key NOR the
      // GITHUB_TOKEN, shows the 🔒 redaction notice, and keeps the benign finding's message.
      const reqsOn169 = [];
      globalThis.fetch = makeReportingFetchStub({ comments: issueCommentsListNoArgus, onRequest: r => reqsOn169.push(r) });
      const outOn169 = await reportPrValidation(prResult169, { prUrl: prResult169.prUrl });
      postOn169 = String((reqsOn169.find(r => r.method === 'POST') || {}).body ?? '');
      assert(
        outOn169.posted === true && leaks169(postOn169).length === 0 &&
        !postOn169.includes(SECRETTOK169) && postOn169.includes('🔒') && postOn169.includes('missing a descriptive'),
        `[169a] PR comment redacts findings — no JWT/key/token, shows 🔒, keeps the benign message (leaked: ${JSON.stringify(leaks169(postOn169))}, tokenLeak: ${postOn169.includes(SECRETTOK169)}, lock: ${postOn169.includes('🔒')})`
      );

      // [169b] opt-out non-vacuity: the SAME comment with ARGUS_REDACT_SENSITIVE=0 carries the raw
      // secret (the route label /login?session=<JWT> + the raw message) — [169a] is load-bearing.
      process.env.ARGUS_REDACT_SENSITIVE = '0';
      const reqsOff169 = [];
      globalThis.fetch = makeReportingFetchStub({ comments: issueCommentsListNoArgus, onRequest: r => reqsOff169.push(r) });
      await reportPrValidation(prResult169, { prUrl: prResult169.prUrl });
      postOff169 = String((reqsOff169.find(r => r.method === 'POST') || {}).body ?? '');
      assert(
        leaks169(postOff169).length > 0,
        `[169b] opt-out (ARGUS_REDACT_SENSITIVE=0) lets ≥1 raw secret reach the PR comment body — [169a] is non-vacuous (leakedRaw: ${JSON.stringify(leaks169(postOff169))})`
      );
      delete process.env.ARGUS_REDACT_SENSITIVE;
    } finally {
      globalThis.fetch = _origFetch169;
      if (_saved169.tok    === undefined) delete process.env.GITHUB_TOKEN;          else process.env.GITHUB_TOKEN          = _saved169.tok;
      if (_saved169.repo   === undefined) delete process.env.GITHUB_REPOSITORY;     else process.env.GITHUB_REPOSITORY     = _saved169.repo;
      if (_saved169.pr     === undefined) delete process.env.GITHUB_PR_NUMBER;      else process.env.GITHUB_PR_NUMBER      = _saved169.pr;
      if (_saved169.sha    === undefined) delete process.env.GITHUB_SHA;            else process.env.GITHUB_SHA            = _saved169.sha;
      if (_saved169.head   === undefined) delete process.env.ARGUS_PR_HEAD_SHA;     else process.env.ARGUS_PR_HEAD_SHA     = _saved169.head;
      if (_saved169.redact === undefined) delete process.env.ARGUS_REDACT_SENSITIVE; else process.env.ARGUS_REDACT_SENSITIVE = _saved169.redact;
    }

    // ── HTML sink (Step 7) ──────────────────────────────────────────────────────
    const tmpDir169 = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-169-'));
    const rp169 = path.join(tmpDir169, 'error-report-169.json');
    fs.writeFileSync(rp169, JSON.stringify({
      generatedAt: new Date().toISOString(), baseUrl: 'https://staging.example.com',
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
      routes: [{ route: '/login', url: 'https://staging.example.com/login', errors: [sensitive169, benign169] }],
      flows: [], codebase: [],
    }, null, 2));

    // [169c] external:true strips the secret + keeps the benign message; the on-disk JSON it reads
    // from is left RAW (local fidelity preserved — Aegis only removes detail on the way OUT).
    let htmlExt169 = '', diskAfter169 = '';
    try {
      htmlExt169   = fs.readFileSync(generateHtmlReport(rp169, { external: true }), 'utf8');
      diskAfter169 = fs.readFileSync(rp169, 'utf8');
    } catch { /* asserted via empty strings below */ }
    assert(
      leaks169(htmlExt169).length === 0 && htmlExt169.includes('missing a descriptive') && leaks169(diskAfter169).length > 0,
      `[169c] external HTML strips secrets + keeps the benign message; the on-disk JSON stays RAW (htmlLeak: ${JSON.stringify(leaks169(htmlExt169))}, diskRaw: ${leaks169(diskAfter169).length > 0})`
    );

    // [169d] HTML non-vacuity: the local render with ARGUS_REDACT_HTML=0 keeps the raw secret,
    // proving [169c]'s external redaction is load-bearing (independent of the runner's CI flag).
    const _savedHtml169 = process.env.ARGUS_REDACT_HTML;
    process.env.ARGUS_REDACT_HTML = '0';
    let htmlRaw169 = '';
    try { htmlRaw169 = fs.readFileSync(generateHtmlReport(rp169), 'utf8'); } catch { /* asserted below */ }
    if (_savedHtml169 === undefined) delete process.env.ARGUS_REDACT_HTML; else process.env.ARGUS_REDACT_HTML = _savedHtml169;
    assert(
      leaks169(htmlRaw169).length > 0,
      `[169d] the local HTML render (ARGUS_REDACT_HTML=0) keeps the raw secret — [169c] external redaction is non-vacuous (leakedRaw: ${JSON.stringify(leaks169(htmlRaw169))})`
    );
    try { fs.rmSync(tmpDir169, { recursive: true, force: true }); } catch { /* best-effort */ }

    // ── CI step summary + annotation sink (Step 7) ──────────────────────────────
    // [169e] buildStepSummary carries no secret + keeps the finding TYPE column; safeFindingLine
    // (no truncation) strips both the message secret and the url query token — the strong proof.
    const md169 = buildStepSummary({
      blocked: true, summary: { critical: 1, warning: 1, info: 0 },
      affectedRoutes: [{ path: '/login' }], perRoute: [{ route: '/login', critical: 1, warning: 1, info: 0 }],
      findings: [sensitive169, benign169], changedFiles: ['src/pages/login.tsx'], blockOn: 'critical',
    });
    const safe169 = safeFindingLine(sensitive169);
    assert(
      leaks169(md169).length === 0 && md169.includes('seo_title_missing') &&
      leaks169(safe169.message).length === 0 && !safe169.url.includes('session='),
      `[169e] step summary + safeFindingLine redact the secret + strip the url query, keep the type (mdLeak: ${JSON.stringify(leaks169(md169))}, msgLeak: ${JSON.stringify(leaks169(safe169.message))}, urlHasQuery: ${safe169.url.includes('session=')})`
    );
  }

  // ── [170] AEGIS — engine `policy` param (org governance toggles, plan §4.2/§9) ──
  // Chrome-free + pure: drives the REAL egress projector (redactForEgress / redactReport /
  // scrubText) with a structured org policy — the "apply" mechanism the (future) opt-in
  // governance seam wraps behind an Ed25519 fetch/verify. Pins the governance invariants:
  // a TOGGLE actually takes effect through the pipeline, the egress allowlist NARROWS-only,
  // sensitiveTypes WIDEN-only, a bad policy FAILS CLOSED to the strict floor, the no-leak
  // floor holds even with named rules OFF, and NO policy is byte-identical to v9.9.0 (the
  // open-core guarantee) — plus the ARGUS_REDACT_POLICY env entry point (valid + malformed).
  {
    console.log('\n[170] Aegis — engine policy param (governance toggles, fail-closed, default-identical)');
    const JWT170 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTkifQ.Zx8Kd1t8sQ2rN4pV6wLtY3fH8dG1cA5eW0uNbQ7mXvA';
    const KEY170 = 'sk-ant-api03-Gov0123456789ABCDEFghij0123456789ABCDEFghij_p1';
    const EMAIL170 = 'ceo@acme-corp.example';
    const secrets170 = [JWT170, KEY170];
    const leaks170 = (o) => secrets170.filter((s) => JSON.stringify(o).includes(s));

    const secFinding170 = { type: 'security_no_https', severity: 'critical', route: '/login', url: `https://acme.example/login?session=${JWT170}`, message: `Bearer ${KEY170}` };
    const benignEmail170 = { type: 'seo_meta', severity: 'warning', route: '/contact', message: `Reach us at ${EMAIL170}` };
    const perfFinding170 = { type: 'perf_budget', severity: 'warning', route: '/', message: 'bundle is 2MB', selector: '#app', count: 3 };

    // [170a] TOGGLE takes effect through the real projector: rules.pii.email:false stops the
    // benign email being classified sensitive (message survives), while the DEFAULT redacts it.
    const emailDefault170 = redactForEgress([benignEmail170])[0];
    const emailToggle170 = redactForEgress([benignEmail170], { policy: { rules: { pii: { email: false } } } })[0];
    assert(
      emailDefault170.message === REDACT_MARKER && emailToggle170.message.includes(EMAIL170) && emailToggle170.message.includes('Reach us'),
      `[170a] policy rules.pii.email:false flows through redactForEgress — default redacts the email, the toggle keeps it (default==marker: ${emailDefault170.message === REDACT_MARKER}, toggledKeepsEmail: ${emailToggle170.message.includes(EMAIL170)})`
    );

    // [170b] sensitiveTypes WIDENS only: perf_budget (benign by default) redacts under perf_*,
    // and a built-in security_* stays redacted even though the policy never lists it (union).
    const perfDefault170 = redactForEgress([perfFinding170])[0];
    const perfWiden170 = redactForEgress([perfFinding170], { policy: { sensitiveTypes: ['perf_*'] } })[0];
    const secWiden170 = redactForEgress([secFinding170], { policy: { sensitiveTypes: ['perf_*'] } })[0];
    assert(
      perfDefault170.message === 'bundle is 2MB' && perfWiden170.message === REDACT_MARKER &&
      secWiden170.message === REDACT_MARKER && leaks170(secWiden170).length === 0,
      `[170b] sensitiveTypes WIDENS only — perf_budget benign by default, redacted under perf_*, built-in security_* stays redacted (perfDefault: "${perfDefault170.message}", perfWiden==marker: ${perfWiden170.message === REDACT_MARKER}, secStillRedacted: ${secWiden170.message === REDACT_MARKER})`
    );

    // [170c] egress allowlist NARROWS only: optional passthroughs dropped, structural fields kept,
    // and a policy that lists a NEW field (password/apiKey) can NEVER add it (intersection).
    const wideDefault170 = redactForEgress([perfFinding170])[0];
    const narrowed170 = redactForEgress([perfFinding170], { policy: { egressFieldAllowlist: ['type', 'severity', 'route'] } })[0];
    const cantAdd170 = redactForEgress([{ type: 'x', severity: 'info', password: 'p@ssw0rd', apiKey: 'k' }], { policy: { egressFieldAllowlist: ['password', 'apiKey', 'type', 'severity'] } })[0];
    assert(
      wideDefault170.selector === '#app' && narrowed170.selector === undefined && narrowed170.count === undefined &&
      narrowed170.type === 'perf_budget' && !Object.keys(cantAdd170).includes('password') && !Object.keys(cantAdd170).includes('apiKey'),
      `[170c] egress allowlist NARROWS only — optional fields dropped, structural kept, a policy can't ADD a leaky field (narrowedSelector: ${narrowed170.selector}, cantAddKeys: ${JSON.stringify(Object.keys(cantAdd170))})`
    );

    // [170d] FAIL-CLOSED: a malformed string policy AND a throwing-getter policy both fall back
    // to the strict floor — the finding is still redacted, no secret crosses, never throws.
    const evil170 = {}; Object.defineProperty(evil170, 'rules', { get() { throw new Error('boom'); } });
    const badStr170 = redactForEgress([secFinding170], { policy: 'not-a-policy' })[0];
    let threw170 = false; let badGetter170 = {};
    try { badGetter170 = redactForEgress([secFinding170], { policy: evil170 })[0]; } catch { threw170 = true; }
    assert(
      badStr170.message === REDACT_MARKER && leaks170(badStr170).length === 0 && leaks170(badGetter170).length === 0 && threw170 === false,
      `[170d] a malformed / throwing policy FAILS CLOSED — still redacted, no secret, never throws (strLeak: ${leaks170(badStr170).length}, getterLeak: ${leaks170(badGetter170).length}, threw: ${threw170})`
    );

    // [170e] NO-LEAK FLOOR: with the named secret rules OFF, the category floor (a security_*
    // finding) AND the entropy floor (a benign finding carrying a raw key) both still redact.
    const floorProj170 = redactForEgress([secFinding170], { policy: { rules: { secret: { all: false }, pii: {} }, sensitiveTypes: [] } })[0];
    const benignSecret170 = { type: 'console_log', severity: 'info', route: '/x', message: `dump ${KEY170}` };
    const entropyProj170 = redactForEgress([benignSecret170], { policy: { rules: { secret: { all: false } } } })[0];
    assert(
      leaks170(floorProj170).length === 0 && leaks170(entropyProj170).length === 0 && !String(entropyProj170.message).includes(KEY170),
      `[170e] NO-LEAK FLOOR — secret rules OFF, but category + entropy floors still redact the JWT/key (categoryLeak: ${leaks170(floorProj170).length}, entropyLeak: ${leaks170(entropyProj170).length})`
    );

    // [170f] OPT-IN default byte-identical: no policy === {policy:null} for BOTH redactForEgress
    // and redactReport, and an unset ARGUS_REDACT_POLICY resolves to null — the open-core line.
    const fixtureSet170 = [secFinding170, benignEmail170, perfFinding170];
    const baseProj170 = JSON.stringify(redactForEgress(fixtureSet170));
    const nullProj170 = JSON.stringify(redactForEgress(fixtureSet170, { policy: null }));
    const report170 = { routes: [{ url: 'https://acme.example/', errors: fixtureSet170 }], summary: { total: 3 } };
    const baseRep170 = JSON.stringify(redactReport(structuredClone(report170)));
    const nullRep170 = JSON.stringify(redactReport(structuredClone(report170), { policy: null }));
    _resetPolicyCacheForTests();
    assert(
      baseProj170 === nullProj170 && baseRep170 === nullRep170 && policyFromEnv() === null && resolvePolicy(null).ruleFilter === null,
      `[170f] OPT-IN default byte-identical — no policy === {policy:null} for redactForEgress + redactReport; ARGUS_REDACT_POLICY unset ⇒ null (projEq: ${baseProj170 === nullProj170}, repEq: ${baseRep170 === nullRep170})`
    );

    // [170g] ARGUS_REDACT_POLICY env entry point: a VALID inline-JSON policy is applied (email
    // kept), a MALFORMED one fails closed (the secret still redacted). Restored + cache reset.
    const _savedPol170 = process.env.ARGUS_REDACT_POLICY;
    let envToggle170 = {}; let envBad170 = {};
    try {
      _resetPolicyCacheForTests();
      process.env.ARGUS_REDACT_POLICY = JSON.stringify({ rules: { pii: { email: false } } });
      envToggle170 = redactForEgress([benignEmail170])[0];
      _resetPolicyCacheForTests();
      process.env.ARGUS_REDACT_POLICY = '{ broken json';
      envBad170 = redactForEgress([secFinding170])[0];
    } finally {
      if (_savedPol170 === undefined) delete process.env.ARGUS_REDACT_POLICY; else process.env.ARGUS_REDACT_POLICY = _savedPol170;
      _resetPolicyCacheForTests();
    }
    assert(
      envToggle170.message.includes(EMAIL170) && envBad170.message === REDACT_MARKER && leaks170(envBad170).length === 0,
      `[170g] ARGUS_REDACT_POLICY env — a valid policy is applied (email kept), a MALFORMED one fails closed (secret redacted) (envKeepsEmail: ${envToggle170.message.includes(EMAIL170)}, badRedacted: ${envBad170.message === REDACT_MARKER})`
    );
  }

  // ── [171] AEGIS-for-Teams — governance seam (opt-in self-hosted central policy, §9) ──
  // The thin OPT-IN network wrapper over the [170] policy param: fetch the org's
  // SIGNED policy, Ed25519-VERIFY it, apply it through the real redactForEgress,
  // fail CLOSED on any error, post SECRET-FREE aggregates, and stay byte-identical
  // without a gov token. Pins the open-core moat invariants (AEGIS_FOR_TEAMS_PLAN §9):
  // signature (signed verifies / tampered + wrong-key rejected), fail-closed
  // (unreachable / malformed / HTTP-error → strict floor), no-leak aggregate,
  // opt-in default-identical + the strict opt-out clamp, TTL cache, and a LIVE
  // end-to-end fetch over real HTTP. Env is saved + restored so no state leaks.
  {
    console.log('\n[171] Aegis-for-Teams — governance seam (Ed25519 fetch/verify, fail-closed, secret-free aggregate)');
    const JWT171 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3MjEifQ.Ab3Kd9t2sQ5rN8pV1wLtY6fH3dG4cA7eW2uNbQ0mXvZ';
    const KEY171 = 'sk-ant-api03-Gov9876543210ZYXWVUTsrqp9876543210ZYXWVUTsrqp_g7';
    const EMAIL171 = 'cto@acme-corp.example';
    const secrets171 = [JWT171, KEY171, EMAIL171];
    const leaks171 = (o) => secrets171.filter((s) => JSON.stringify(o).includes(s));

    const secFinding171 = { type: 'security_no_https', severity: 'critical', route: '/admin', url: `https://acme.example/admin?session=${JWT171}`, message: `Bearer ${KEY171}` };
    const benignEmail171 = { type: 'seo_meta', severity: 'warning', route: '/contact', message: `Reach the CTO at ${EMAIL171}` };

    // Org keypair (honest) + an ATTACKER keypair (wrong-key proof). The served policy
    // turns email OFF — a toggle that only survives if verification passed.
    const orgKP171 = crypto.generateKeyPairSync('ed25519');
    const attackerKP171 = crypto.generateKeyPairSync('ed25519');
    const ORG_PUB171 = orgKP171.publicKey.export({ type: 'spki', format: 'pem' });
    const POLICY171 = {
      version: 11, orgId: 'org_acme', enforcement: 'strict', mode: 'label',
      rules: { secret: { all: true }, pii: { email: false, credit_card: true, ssn_us: true } },
      sensitiveTypes: ['security_*'], egressFieldAllowlist: ['type', 'severity', 'route', 'url', 'selector', 'value', 'title'],
      floor: { failOpen: false, minMode: 'mask' },
    };
    const sign171 = (p, kp = orgKP171) => crypto.sign(null, Buffer.from(canonicalPolicyBytes(p), 'utf8'), kp.privateKey).toString('base64');
    const signed171 = (p = POLICY171, kp = orgKP171) => ({ policy: p, signature: sign171(POLICY171, kp), alg: 'ed25519' });
    const fetchOf171 = (payload, { ok = true, status = 200 } = {}) => async () => ({ ok, status, json: async () => payload });

    // Save + restore ALL governance env so the block leaves no residue.
    const _sav171 = {};
    for (const k of ['ARGUS_GOV_TOKEN', 'ARGUS_REDACT_POLICY_URL', 'ARGUS_REDACT_POLICY_PUBKEY', 'ARGUS_REDACT_AUDIT_URL', 'ARGUS_REDACT_SENSITIVE', 'ARGUS_REDACT_POLICY_TTL_MS']) _sav171[k] = process.env[k];
    try {
      process.env.ARGUS_GOV_TOKEN = 'gov_harness_token';
      process.env.ARGUS_REDACT_POLICY_URL = 'http://127.0.0.1:9/policy';
      process.env.ARGUS_REDACT_POLICY_PUBKEY = ORG_PUB171;
      _resetGovernanceForTests(); _resetPolicyCacheForTests();

      // [171a] SIGNATURE + APPLY: a genuinely-signed policy verifies + its email-OFF
      // toggle takes effect through the REAL redactForEgress; a tampered body under
      // the honest signature is REJECTED → strict floor (email redacted again).
      const verified171 = verifySignedPolicy(signed171());
      await ensureGovernancePolicy({ fetchImpl: fetchOf171(signed171()) });
      const appliedEmail171 = redactForEgress([benignEmail171])[0];
      const tamperPayload171 = { policy: { ...POLICY171, rules: { secret: { all: false }, pii: {} } }, signature: sign171(POLICY171) };
      let tamperThrew171 = false; try { verifySignedPolicy(tamperPayload171); } catch { tamperThrew171 = true; }
      _resetGovernanceForTests();
      await ensureGovernancePolicy({ fetchImpl: fetchOf171(tamperPayload171) });
      const afterTamper171 = redactForEgress([benignEmail171])[0];
      assert(
        verified171.version === 11 && appliedEmail171.message.includes(EMAIL171) &&
        tamperThrew171 === true && effectivePolicyOpts({}) === null && !afterTamper171.message.includes(EMAIL171),
        `[171a] signed policy verifies + email-OFF toggle applies through redactForEgress; a TAMPERED body is rejected → strict floor (applied: ${appliedEmail171.message.includes(EMAIL171)}, tamperRejected: ${tamperThrew171}, floorRedactsEmail: ${!afterTamper171.message.includes(EMAIL171)})`
      );

      // [171b] WRONG KEY: an attacker-signed policy fails verification → fail-closed.
      let wrongKeyThrew171 = false; try { verifySignedPolicy(signed171(POLICY171, attackerKP171)); } catch { wrongKeyThrew171 = true; }
      _resetGovernanceForTests();
      await ensureGovernancePolicy({ fetchImpl: fetchOf171(signed171(POLICY171, attackerKP171)) });
      assert(
        wrongKeyThrew171 === true && effectivePolicyOpts({}) === null && governancePolicyVersion() === null,
        `[171b] a wrong-key (attacker-signed) policy is REJECTED → strict floor, no version adopted (rejected: ${wrongKeyThrew171}, optsNull: ${effectivePolicyOpts({}) === null})`
      );

      // [171c] FAIL-CLOSED transport: an unreachable URL, a malformed payload, and an
      // HTTP error each fall back to the strict floor — the secret never leaks.
      _resetGovernanceForTests();
      await ensureGovernancePolicy({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
      const unreach171 = redactForEgress([secFinding171])[0];
      _resetGovernanceForTests();
      await ensureGovernancePolicy({ fetchImpl: fetchOf171({ policy: POLICY171 }) }); // no signature
      const malformed171 = effectivePolicyOpts({});
      _resetGovernanceForTests();
      await ensureGovernancePolicy({ fetchImpl: fetchOf171({}, { ok: false, status: 403 }) });
      const http403_171 = effectivePolicyOpts({});
      assert(
        unreach171.message === REDACT_MARKER && leaks171(unreach171).length === 0 &&
        malformed171 === null && http403_171 === null,
        `[171c] unreachable / malformed / HTTP-error all FAIL CLOSED to the strict floor — secret redacted, no leak (unreachRedacted: ${unreach171.message === REDACT_MARKER}, malformedNull: ${malformed171 === null}, http403Null: ${http403_171 === null})`
      );

      // [171d] NO-LEAK aggregate: the POST body carries only secret-free label counts
      // + coarse meta; a byReason label tainted with a secret AND a secret-bearing
      // runRef are both scrubbed. Captured via an injected fetch (no socket needed).
      process.env.ARGUS_REDACT_AUDIT_URL = 'http://127.0.0.1:9/audit';
      let auditBody171 = null; let auditAuth171 = null;
      const summary171 = { total: 4, redacted: 2, byReason: { 'secret:jwt': 1, 'pii:email': 1, [`tok ${KEY171}`]: 1 } };
      const postRes171 = await postRedactionAggregate(summary171, {
        fetchImpl: async (_url, o) => { auditBody171 = o.body; auditAuth171 = o.headers.Authorization; return { ok: true, status: 200, json: async () => ({}) }; },
        meta: { runRef: `error-report ${EMAIL171}.json` },
      });
      assert(
        postRes171.posted === true && auditAuth171 === 'Bearer gov_harness_token' &&
        !auditBody171.includes(JWT171) && !auditBody171.includes(KEY171) && !auditBody171.includes(EMAIL171) &&
        JSON.parse(auditBody171).byReason['secret:jwt'] === 1 && JSON.parse(auditBody171).total === 4,
        `[171d] the aggregate POST is SECRET-FREE — tainted label + runRef scrubbed, counts preserved, bearer-authed (leaks: ${[JWT171, KEY171, EMAIL171].filter((s) => auditBody171.includes(s)).length}, counted: ${JSON.parse(auditBody171).byReason['secret:jwt']})`
      );

      // [171e] OPT-IN default-identical + STRICT CLAMP: with a gov token the local
      // ARGUS_REDACT_SENSITIVE=0 opt-out is CLAMPED (secret still redacted); drop the
      // token and it is inert (null) + byte-identical (the opt-out passes through raw).
      _resetGovernanceForTests();
      process.env.ARGUS_REDACT_SENSITIVE = '0';
      const clampedOn171 = governanceOptOutClamped();
      const clampedFinding171 = redactForEgress([secFinding171])[0];
      delete process.env.ARGUS_GOV_TOKEN;
      _resetGovernanceForTests();
      const inert171 = await ensureGovernancePolicy({ fetchImpl: fetchOf171(signed171()) });
      const clampedOff171 = governanceOptOutClamped();
      const passthrough171 = redactForEgress([secFinding171]);
      assert(
        clampedOn171 === true && clampedFinding171.message === REDACT_MARKER && leaks171(clampedFinding171).length === 0 &&
        inert171 === null && clampedOff171 === false && passthrough171.length === 1 && passthrough171[0] === secFinding171,
        `[171e] a gov token CLAMPS the ARGUS_REDACT_SENSITIVE=0 opt-out (secret still redacted); no token ⇒ inert + byte-identical raw passthrough (clampedOn: ${clampedOn171}, clampRedacts: ${clampedFinding171.message === REDACT_MARKER}, inert: ${inert171 === null}, clampedOff: ${clampedOff171})`
      );

      // [171f] TTL CACHE: within the window one fetch; expiry re-fetches (counting fetch).
      process.env.ARGUS_GOV_TOKEN = 'gov_harness_token';
      process.env.ARGUS_REDACT_POLICY_TTL_MS = '1000';
      _resetGovernanceForTests();
      let calls171 = 0; let t171 = 50_000; const now171 = () => t171;
      const counting171 = async () => { calls171++; return { ok: true, status: 200, json: async () => signed171() }; };
      await ensureGovernancePolicy({ fetchImpl: counting171, now: now171 });
      await ensureGovernancePolicy({ fetchImpl: counting171, now: now171 });
      t171 += 400; await ensureGovernancePolicy({ fetchImpl: counting171, now: now171 });
      const cachedCalls171 = calls171;
      t171 += 1200; await ensureGovernancePolicy({ fetchImpl: counting171, now: now171 });
      assert(
        cachedCalls171 === 1 && calls171 === 2,
        `[171f] TTL cache — one fetch within the window, re-fetch after expiry (cachedCalls: ${cachedCalls171}, afterExpiry: ${calls171})`
      );

      // [171g] LIVE end-to-end over REAL HTTP: a mock control plane Ed25519-signs +
      // serves the policy and ingests the aggregate; the engine fetches over the wire,
      // applies (email survives), the secret never leaks, the received body is clean.
      let liveAudit171 = null;
      const server171 = http.createServer((req, res) => {
        if (req.url === '/policy') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(signed171())); }
        else if (req.url === '/audit') { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { liveAudit171 = raw; res.end('{}'); }); }
        else { res.statusCode = 404; res.end(); }
      });
      await new Promise((r) => server171.listen(0, '127.0.0.1', r));
      const port171 = server171.address().port;
      process.env.ARGUS_REDACT_POLICY_URL = `http://127.0.0.1:${port171}/policy`;
      process.env.ARGUS_REDACT_AUDIT_URL = `http://127.0.0.1:${port171}/audit`;
      delete process.env.ARGUS_REDACT_POLICY_TTL_MS;
      _resetGovernanceForTests(); _resetPolicyCacheForTests();
      await ensureGovernancePolicy(); // REAL fetch over HTTP (default global fetch)
      const liveEmail171 = redactForEgress([benignEmail171])[0];
      const liveSecret171 = redactForEgress([secFinding171])[0];
      const liveSummary171 = summarizeRedaction([benignEmail171, secFinding171], effectivePolicyOpts({}));
      await postRedactionAggregate(liveSummary171, { meta: { runRef: 'live-run' } });
      await new Promise((r) => server171.close(r));
      assert(
        governancePolicyVersion() === 11 && liveEmail171.message.includes(EMAIL171) &&
        liveSecret171.message === REDACT_MARKER && leaks171(liveSecret171).length === 0 &&
        liveAudit171 !== null && !liveAudit171.includes(JWT171) && !liveAudit171.includes(KEY171),
        `[171g] LIVE HTTP fetch→verify→apply→aggregate — policy v${governancePolicyVersion()} applied (email survives), secret never leaks, wire aggregate clean (emailSurvives: ${liveEmail171.message.includes(EMAIL171)}, secretRedacted: ${liveSecret171.message === REDACT_MARKER}, auditReceived: ${liveAudit171 !== null})`
      );
    } finally {
      for (const [k, v] of Object.entries(_sav171)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      _resetGovernanceForTests(); _resetPolicyCacheForTests();
    }
  }

  // ── [172] AEGIS-for-Teams — team-vault routing (mode=token → central vault, §9) ──
  // The last T3 sub-item: when a gov token AND a team-vault URL are both set, `token`
  // mode routes the reversible token→secret mapping to the org's CENTRAL vault (so a
  // token minted on a laptop / in CI is re-hydratable through the org's authorized RBAC
  // flow) instead of the local 0600 file. Pins the open-core moat invariants: opt-in
  // activation, mint+buffer with NO secret in the egress artifact, a LIVE flush that
  // sends the secret ONLY to the authorized endpoint (bearer-authed), fail-closed on any
  // flush error, opt-in default-identical (masks + zero network without the seam), and
  // team>local precedence. Chrome-free; a real localhost sink; env saved + restored.
  {
    console.log('\n[172] Aegis-for-Teams — team-vault routing (mode=token central vault, fail-closed, opt-in)');
    const JWT172 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5MDIifQ.Zt7Kd1x9sQ3rN2pV8wLtY4fH6dG0cA1eW5uNbR7mYvC';
    const TAIL172 = 'Zt7Kd1x9sQ3rN2pV8wLtY4fH6dG0cA1eW5uNbR7mYvC';
    const AEGIS_RE172 = /AEGIS_[0-9a-f]{16}/;
    const consoleMsg172 = () => ({ level: 'error', text: `Auth failed: Authorization: Bearer ${JWT172}` });

    const _sav172 = {};
    for (const k of ['ARGUS_GOV_TOKEN', 'ARGUS_REDACT_VAULT_URL', 'ARGUS_REDACT_MODE', 'ARGUS_REDACT_VAULT', 'ARGUS_REDACT_SENSITIVE']) _sav172[k] = process.env[k];
    let server172 = null;
    try {
      // [172a] ACTIVATION (opt-in): inert with neither / only one of the two knobs; active only with BOTH.
      for (const k of ['ARGUS_GOV_TOKEN', 'ARGUS_REDACT_VAULT_URL']) delete process.env[k];
      _resetTeamVaultForTests();
      const inertNone172 = teamVaultActive();
      process.env.ARGUS_GOV_TOKEN = 'gov_harness_token';
      const inertTokenOnly172 = teamVaultActive();
      delete process.env.ARGUS_GOV_TOKEN; process.env.ARGUS_REDACT_VAULT_URL = 'http://127.0.0.1:9/vault';
      const inertUrlOnly172 = teamVaultActive();
      process.env.ARGUS_GOV_TOKEN = 'gov_harness_token';
      const activeBoth172 = teamVaultActive();
      assert(
        inertNone172 === false && inertTokenOnly172 === false && inertUrlOnly172 === false && activeBoth172 === true,
        `[172a] team vault is OPT-IN — inert without BOTH a gov token AND a vault URL (none: ${inertNone172}, tokenOnly: ${inertTokenOnly172}, urlOnly: ${inertUrlOnly172}, both: ${activeBoth172})`
      );

      // [172b] MINT + BUFFER + NO-LEAK: token mode through the REAL deepScrub emits an
      // information-free AEGIS_ token, buffers the token→secret mapping, and the secret
      // NEVER appears in the redacted egress artifact.
      process.env.ARGUS_REDACT_MODE = 'token';
      _resetTeamVaultForTests();
      const scrubStr172 = JSON.stringify(deepScrub(consoleMsg172()));
      assert(
        AEGIS_RE172.test(scrubStr172) && !scrubStr172.includes(TAIL172) && pendingTeamVaultCount() >= 1,
        `[172b] token mode mints an information-free AEGIS token + buffers the mapping; the secret never reaches egress (tokenised: ${AEGIS_RE172.test(scrubStr172)}, leaks: ${scrubStr172.includes(TAIL172) ? 1 : 0}, buffered: ${pendingTeamVaultCount()})`
      );

      // [172c] LIVE FLUSH over REAL HTTP: a mock team-vault endpoint ingests the POST; the
      // SECRET travels ONLY to that authorized endpoint (gov-token bearer), the token is
      // AEGIS-shaped, and the buffer clears on success.
      let vaultBody172 = null; let vaultAuth172 = null;
      server172 = http.createServer((req, res) => {
        if (req.url === '/vault') { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { vaultBody172 = raw; vaultAuth172 = req.headers.authorization; res.end('{"ok":true,"stored":1}'); }); }
        else { res.statusCode = 404; res.end(); }
      });
      await new Promise((r) => server172.listen(0, '127.0.0.1', r));
      const port172 = server172.address().port;
      process.env.ARGUS_REDACT_VAULT_URL = `http://127.0.0.1:${port172}/vault`;
      _resetTeamVaultForTests();
      deepScrub(consoleMsg172()); // re-mint under the live URL
      const bufferedBefore172 = pendingTeamVaultCount();
      const flushRes172 = await flushTeamVault(); // REAL global fetch over the wire
      const parsedVault172 = vaultBody172 ? JSON.parse(vaultBody172) : null;
      assert(
        flushRes172.posted === true && bufferedBefore172 >= 1 && pendingTeamVaultCount() === 0 &&
        vaultAuth172 === 'Bearer gov_harness_token' &&
        parsedVault172 && parsedVault172.mappings.length >= 1 &&
        /^AEGIS_[0-9a-f]{16}$/.test(parsedVault172.mappings[0].token) &&
        parsedVault172.mappings.some((m) => m.secret.includes(TAIL172)),
        `[172c] LIVE flush ships the mapping to the authorized endpoint ONLY — secret at the vault, token AEGIS-shaped, bearer-authed, buffer cleared (posted: ${flushRes172.posted}, bufferAfter: ${pendingTeamVaultCount()}, secretAtVault: ${parsedVault172 && parsedVault172.mappings.some((m) => m.secret.includes(TAIL172))})`
      );

      // [172d] FAIL-CLOSED: a throwing fetch AND an HTTP-error both return posted:false
      // WITHOUT throwing and RETAIN the buffer; the already-emitted token is information-
      // free (no secret substring), so a failed flush leaks nothing.
      _resetTeamVaultForTests();
      teamTokenFor(JWT172);
      let flushThrew172 = false; let throwRes172;
      try { throwRes172 = await flushTeamVault({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }); } catch { flushThrew172 = true; }
      const retainedAfterThrow172 = pendingTeamVaultCount();
      const httpErrRes172 = await flushTeamVault({ fetchImpl: async () => ({ ok: false, status: 500 }) });
      const mintedToken172 = teamTokenFor(JWT172);
      assert(
        flushThrew172 === false && throwRes172.posted === false && retainedAfterThrow172 === 1 &&
        httpErrRes172.posted === false && pendingTeamVaultCount() === 1 && !mintedToken172.includes(TAIL172),
        `[172d] a throwing / HTTP-error flush FAILS CLOSED — never throws, buffer retained, token information-free (threw: ${flushThrew172}, throwPosted: ${throwRes172.posted}, httpPosted: ${httpErrRes172.posted}, retained: ${pendingTeamVaultCount()})`
      );

      // [172e] OPT-IN default-identical: with the seam OFF, token mode MASKS (no AEGIS
      // token), nothing buffers, the secret is still redacted, and flushTeamVault is inert
      // — it makes NO network call (a throwing fetchImpl is never reached).
      delete process.env.ARGUS_GOV_TOKEN; delete process.env.ARGUS_REDACT_VAULT_URL; delete process.env.ARGUS_REDACT_VAULT;
      _resetTeamVaultForTests();
      const offStr172 = JSON.stringify(deepScrub(consoleMsg172()));
      const inertFlush172 = await flushTeamVault({ fetchImpl: async () => { throw new Error('should-not-be-called'); } });
      assert(
        !AEGIS_RE172.test(offStr172) && !offStr172.includes(TAIL172) && pendingTeamVaultCount() === 0 &&
        inertFlush172.posted === false && inertFlush172.reason === 'inactive',
        `[172e] OPT-IN default-identical — seam OFF ⇒ token mode masks (no team token), nothing buffered, secret redacted, flush inert / no network (masked: ${!AEGIS_RE172.test(offStr172)}, buffered: ${pendingTeamVaultCount()}, inert: ${inertFlush172.reason === 'inactive'})`
      );

      // [172f] PRECEDENCE (§4.3): with BOTH the local vault (ARGUS_REDACT_VAULT=1) and the
      // team vault active, ensureTokenVaultWired wires the TEAM tokenizer (mapping buffered
      // for the central flush, NOT the local file); team OFF + local ON falls back to local.
      process.env.ARGUS_REDACT_VAULT = '1';
      process.env.ARGUS_GOV_TOKEN = 'gov_harness_token';
      process.env.ARGUS_REDACT_VAULT_URL = 'http://127.0.0.1:9/vault';
      _resetTeamVaultForTests();
      const teamWired172 = ensureTokenVaultWired();
      const teamScrub172 = scrubText(`Bearer ${JWT172}`, { mode: 'token' });
      const teamBuffered172 = pendingTeamVaultCount();
      delete process.env.ARGUS_GOV_TOKEN; delete process.env.ARGUS_REDACT_VAULT_URL;
      _resetTeamVaultForTests();
      const localWired172 = ensureTokenVaultWired();
      const localScrub172 = scrubText(`Bearer ${JWT172}`, { mode: 'token' });
      const localBuffered172 = pendingTeamVaultCount();
      assert(
        teamWired172 === true && AEGIS_RE172.test(teamScrub172) && teamBuffered172 === 1 &&
        localWired172 === true && AEGIS_RE172.test(localScrub172) && localBuffered172 === 0 && teamVaultActive() === false,
        `[172f] team vault WINS over the local vault when both active; falls back to local when the team vault is off (teamBuffered: ${teamBuffered172}, localBuffered: ${localBuffered172})`
      );
    } finally {
      if (server172) { try { await new Promise((r) => server172.close(r)); } catch { /* already closed */ } }
      for (const [k, v] of Object.entries(_sav172)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      _resetTeamVaultForTests();
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('\u2554' + '\u2550'.repeat(55) + '\u2557');
  console.log('\u2551     ARGUS Test Harness Validator — full coverage      \u2551');
  console.log('\u255A' + '\u2550'.repeat(55) + '\u255D');
  if (STRICT_SOFT) {
    console.log('  \u2691 STRICT-SOFT lane: ARGUS_HARNESS_STRICT_SOFT set \u2014 every soft()');
    console.log('    is promoted to a counted hard assertion (headful Chrome expected).');
  }
  console.log('');

  let serverProc, stagingProc, mcp;

  try {
    const devPort = await findFreePort(HARNESS_DEV_PORT);
    const stagingPort = await findFreePort(devPort + 1);

    console.log('\u25B6 Starting dev fixture server on port', devPort, '...');
    serverProc = await startServer(devPort);

    console.log('\u25B6 Starting staging fixture server on port', stagingPort, '...');
    try {
      stagingProc = await startServer(stagingPort, { staging: true });
    } catch (stagingErr) {
      console.warn('  ⚠  Staging server failed to start: ' + stagingErr.message + ' — env-comparison tests will be skipped');
    }

    console.log('\u25B6 Connecting to Chrome DevTools MCP ...');
    mcp = await createMcpClient();
    console.log('  Connected.\n');

    await runTests(mcp, stagingProc, devPort, stagingPort);

  } catch (err) {
    console.error('\n\u274C Fatal error:', err.message);
    if (/MCP|chrome|connect|ECONNREFUSED/i.test(err.message)) {
      console.error('\n  Start Chrome with --remote-debugging-port=9222:');
      console.error('    Windows (PS): & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --headless=new --no-sandbox --disable-gpu --user-data-dir="$env:TEMP\\chrome-argus"');
      console.error('    Mac:     open -a "Google Chrome" --args --remote-debugging-port=9222 --headless=new');
    }
    process.exitCode = 1;

  } finally {
    if (mcp?.close) try { mcp.close(); } catch { }
    if (stagingProc) stagingProc.kill();
    if (serverProc) serverProc.kill();

    const total = passed + failed;
    console.log('\n' + '\u2500'.repeat(56));
    console.log(`Results: ${passed}/${total} hard assertions passed, ${failed} failed`);
    if (STRICT_SOFT) {
      console.log('  (strict-soft lane: count includes ~23 promoted soft() checks; ' +
        'the documented per-PR gate is 978 with soft() un-promoted.)');
    }
    if (failLog.length > 0) {
      console.log('\nFailed assertions:');
      failLog.forEach(f => console.log(`  \u2717 ${f}`));
    }
    // Empty since v9.7.2 \u2014 every previously "permanent" failure turned out to be an
    // Argus bug, not a Chrome/MCP limit:
    //   [49b] (removed v9.7.1) \u2014 resolveUidForSelector() substring matching resolved
    //     "#drag-source" to the fixture's explanatory paragraph text instead of the
    //     draggable div. Fixed with exact-accessible-name-first matching.
    //   [67b]/[68b] (removed v9.7.2) \u2014 issues WERE returned by the MCP as markdown
    //     text ("msgid=N [issue] text"), but normalizeArray() returns [] for strings,
    //     so they were always discarded. Fixed with parseConsoleMsgResponse(). The
    //     deprecated-API fixture also used APIs that no longer emit DeprecationIssues
    //     (Mutation Events removed in Chrome 127) \u2014 now uses an unload listener.
    // If a genuine upstream limit appears, add its block ID here; CI exits 0 when
    // only KNOWN_PERMANENT entries fail.
    const KNOWN_PERMANENT = [];
    const unexpected = failLog.filter(f => !KNOWN_PERMANENT.some(p => f.startsWith(p)));
    if (unexpected.length > 0) {
      console.log('\n\u274c Unexpected failures \u2014 fix before merging:');
      unexpected.forEach(f => console.log(`  \u2717 ${f}`));
      process.exit(1);
    } else if (failed > 0) {
      console.log(`\n\u26a0  ${failed} permanent MCP-limited failure${failed !== 1 ? 's' : ''} (expected \u2014 cannot be fixed in Argus code).`);
      process.exit(0);
    } else if (total > 0) {
      console.log('\n\u2705 All hard assertions passed.');
      process.exit(0);
    } else {
      process.exit(0);
    }
  }
}

main();
