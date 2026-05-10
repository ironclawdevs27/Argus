/**
 * ARGUS Phase 3: Environment Comparison Engine
 *
 * Compares dev vs staging (or any two environments) for the same routes.
 * Captures screenshots, DOM snapshots, console messages, and network requests
 * from both environments, then diffs them across all four dimensions.
 *
 * Run: node src/orchestration/env-comparison.js
 * Or invoke: runComparison(mcp) from Claude Code with MCP tools connected.
 *
 * MCP Tools Used:
 *   navigate_page, take_screenshot, take_snapshot, list_console_messages,
 *   list_network_requests, wait_for, evaluate_script
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { unwrapEval } from '../utils/mcp-client.js';
import { normalizeArray } from '../utils/flow-runner.js';

import { comparisonRoutes, config } from '../config/targets.js';
import { compareScreenshots, diffDomSnapshots, diffNetworkRequests, diffConsoleMessages } from '../utils/diff.js';
import { postBugReport } from './slack-notifier.js';
import { CSS_ANALYSIS_SCRIPT, parseCssAnalysisResult } from '../utils/css-analyzer.js';
import { analyzeApiFrequency } from '../utils/api-frequency.js';
import { slugify } from '../utils/slug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TARGET_DEV_URL ?? 'http://localhost:3000';
const RAW_STAGING_URL = process.env.TARGET_STAGING_URL ?? '';
// Validate as a parseable URL with a non-localhost hostname — checking only against
// one hardcoded placeholder string misses 'TODO', 'your-url-here', http://localhost, etc.
const STAGING_URL_SET = (() => {
  if (!RAW_STAGING_URL || RAW_STAGING_URL === 'https://staging.yourapp.com') return false;
  try {
    const u = new URL(RAW_STAGING_URL);
    return u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname !== '';
  } catch {
    return false;
  }
})();
const STAGING_URL = RAW_STAGING_URL;
const OUTPUT_DIR = path.resolve(__dirname, '../../', config.outputDir);
const SCREENSHOT_THRESHOLD = config.screenshotDiffThreshold; // %

// ── Per-Environment Capture ────────────────────────────────────────────────────

/**
 * Capture the full state of a page for comparison.
 * Returns screenshot path, DOM snapshot, console messages, and network requests.
 *
 * @param {string} url - Full URL to capture
 * @param {string} label - Label for file naming (e.g., 'dev', 'staging')
 * @param {string} routeName - Human-readable route name
 * @param {object} mcp - Chrome DevTools MCP tools
 * @returns {object} Captured page state
 */
async function capturePage(url, label, routeName, mcp) {
  console.log(`[ARGUS] Capturing ${label}: ${url}`);

  // Snapshot buffer counts BEFORE navigation so staging capture does not
  // include dev's accumulated console messages and network requests from the prior capture.
  const consoleBaseline = normalizeArray(await mcp.list_console_messages().catch(() => [])).length;
  const networkBaseline = normalizeArray(await mcp.list_network_requests().catch(() => [])).length;

  await mcp.navigate_page({ url });
  await new Promise(r => setTimeout(r, config.pageSettleMs));

  // Screenshot
  const screenshotPath = path.join(
    OUTPUT_DIR,
    `compare-${slugify(routeName)}-${label}-${Date.now()}.png`
  );
  const screenshotData = await mcp.take_screenshot({ format: 'png' });
  if (screenshotData?.data) {
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));
  }

  // DOM snapshot
  const domSnapshot = await mcp.take_snapshot();
  const domString = JSON.stringify(domSnapshot?.document ?? domSnapshot ?? '');

  // Console messages — sliced from per-capture baseline to exclude prior environment's messages
  const consoleMsgs = normalizeArray(await mcp.list_console_messages().catch(() => [])).slice(consoleBaseline);

  // Network requests — sliced from per-capture baseline to exclude prior environment's requests
  const networkReqs = normalizeArray(await mcp.list_network_requests().catch(() => [])).slice(networkBaseline);

  return {
    url,
    label,
    screenshotPath: screenshotData?.data ? screenshotPath : null,
    domString,
    consoleMsgs,
    networkReqs,
  };
}

// ── Route Comparison ───────────────────────────────────────────────────────────

/**
 * Compare dev and staging for a single route.
 *
 * @param {object} route - Route definition from targets.js
 * @param {object} mcp - Chrome DevTools MCP tools
 * @returns {object} Comparison result with all diffs
 */
async function compareRoute(route, mcp) {
  const devUrl = `${DEV_URL}${route.path}`;
  const stagingUrl = `${STAGING_URL}${route.path}`;

  let devData, stagingData;
  try {
    devData = await capturePage(devUrl, 'dev', route.name, mcp);
  } catch (err) {
    return { route: route.name, devUrl, stagingUrl, error: `dev capture failed: ${err.message}`, diffs: [] };
  }
  try {
    stagingData = await capturePage(stagingUrl, 'staging', route.name, mcp);
  } catch (err) {
    return { route: route.name, devUrl, stagingUrl, error: `staging capture failed: ${err.message}`, diffs: [] };
  }

  const diffs = [];

  // ── 1. Screenshot diff ─────────────────────────────────────────────────────
  if (devData.screenshotPath && stagingData.screenshotPath) {
    const diffImagePath = path.join(
      OUTPUT_DIR,
      `diff-${slugify(route.name)}-${Date.now()}.png`
    );

    try {
      // Pass a fixed pixelmatch color-sensitivity (0.1 = 10% per-channel tolerance);
      // SCREENSHOT_THRESHOLD is a separate %‑of‑pixels threshold used only for alerting.
      const { diffPercent } = await compareScreenshots(
        devData.screenshotPath,
        stagingData.screenshotPath,
        diffImagePath,
        0.1
      );

      if (diffPercent > SCREENSHOT_THRESHOLD) {
        diffs.push({
          type: 'screenshot',
          diffPercent: parseFloat(diffPercent.toFixed(2)),
          threshold: SCREENSHOT_THRESHOLD,
          diffImagePath,
          devScreenshot: devData.screenshotPath,
          stagingScreenshot: stagingData.screenshotPath,
          severity: diffPercent > SCREENSHOT_THRESHOLD * 10 ? 'warning' : 'info',
          description: `Visual diff ${diffPercent.toFixed(2)}% (threshold: ${SCREENSHOT_THRESHOLD}%)`,
        });
      }
    } catch (err) {
      diffs.push({
        type: 'screenshot_error',
        severity: 'info',
        description: `Screenshot comparison failed: ${err.message}`,
      });
    }
  }

  // ── 2. DOM structural diff ─────────────────────────────────────────────────
  const domDiffs = diffDomSnapshots(devData.domString, stagingData.domString);
  for (const d of domDiffs) {
    diffs.push({
      type: 'dom',
      severity: Math.abs(d.delta) > 5 ? 'warning' : 'info',
      ...d,
    });
  }

  // ── 3. Network request diff ────────────────────────────────────────────────
  const { added, removed, changed } = diffNetworkRequests(devData.networkReqs, stagingData.networkReqs);

  for (const req of added) {
    diffs.push({
      type: 'network_added',
      severity: 'warning',
      description: `New request in staging: ${req.method ?? 'GET'} ${req.url} (${req.status})`,
    });
  }
  for (const req of removed) {
    diffs.push({
      type: 'network_removed',
      severity: 'warning',
      description: `Request present in dev but missing in staging: ${req.method ?? 'GET'} ${req.url}`,
    });
  }
  for (const req of changed) {
    const isRegression = req.statusB >= 400 && req.statusA < 400;
    diffs.push({
      type: 'network_status_changed',
      severity: isRegression ? 'critical' : 'warning',
      description: `${req.url}: status ${req.statusA} (dev) → ${req.statusB} (staging)`,
    });
  }

  // ── 4. Console error diff ──────────────────────────────────────────────────
  const newConsoleErrors = diffConsoleMessages(devData.consoleMsgs, stagingData.consoleMsgs);
  for (const msg of newConsoleErrors) {
    diffs.push({
      type: 'console_regression',
      severity: 'warning',
      description: `New console error in staging (not in dev): ${msg.text ?? msg.message}`,
      source: msg.source ?? null,
    });
  }

  return {
    route: route.name,
    devUrl,
    stagingUrl,
    capturedAt: new Date().toISOString(),
    devScreenshot: devData.screenshotPath,
    stagingScreenshot: stagingData.screenshotPath,
    diffs,
    summary: {
      total: diffs.length,
      critical: diffs.filter(d => d.severity === 'critical').length,
      warning: diffs.filter(d => d.severity === 'warning').length,
      info: diffs.filter(d => d.severity === 'info').length,
    },
  };
}

// ── Main Orchestration ─────────────────────────────────────────────────────────

/**
 * Run comparison across all configured routes.
 *
 * If TARGET_STAGING_URL is not set (or is still the placeholder), automatically
 * falls back to CSS-only analysis mode — inspects the dev environment for:
 *   - CSS overrides and !important conflicts
 *   - Styles leaking from unexpected components
 *   - Unused CSS rules
 *   - API endpoints called multiple times per page load
 *
 * @param {object} mcp - Chrome DevTools MCP tool interface (provided by Claude Code)
 * @returns {object} Full comparison or CSS-analysis report
 */
export async function runComparison(mcp) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!STAGING_URL_SET) {
    console.log('[ARGUS] No staging URL configured — running CSS & API analysis mode on dev environment');
    return runCssAnalysisMode(mcp);
  }

  const report = {
    mode: 'env-comparison',
    generatedAt: new Date().toISOString(),
    devUrl: DEV_URL,
    stagingUrl: STAGING_URL,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    routes: [],
  };

  for (const route of comparisonRoutes) {
    console.log(`[ARGUS] Comparing route: ${route.name} (${route.path})`);
    const result = await compareRoute(route, mcp);
    report.routes.push(result);

    report.summary.total += result.summary?.total ?? 0;
    report.summary.critical += result.summary?.critical ?? 0;
    report.summary.warning += result.summary?.warning ?? 0;
    report.summary.info += result.summary?.info ?? 0;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(OUTPUT_DIR, `comparison-report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[ARGUS] Comparison report: ${reportPath}`);

  // Slack dispatch is best-effort — a network error or Slack API failure should not
  // crash the entire comparison run and discard the already-written JSON report.
  await dispatchComparisonToSlack(report).catch(err =>
    console.error('[ARGUS] Slack dispatch failed:', err.message)
  );
  return report;
}

// ── CSS-Only Analysis Mode (no staging URL) ────────────────────────────────────

/**
 * Fallback mode when no staging URL is configured.
 * Visits each dev route and runs deep CSS + API frequency analysis.
 *
 * Reports:
 *   - CSS property overrides (cascade conflicts, !important abuse)
 *   - Component style leaks (BEM selectors in wrong stylesheet)
 *   - Unused CSS rules (declared but no element matches)
 *   - API endpoints called more than once per page load
 *
 * @param {object} mcp
 * @returns {object} CSS analysis report
 */
async function runCssAnalysisMode(mcp) {
  const report = {
    mode: 'css-analysis',
    generatedAt: new Date().toISOString(),
    baseUrl: DEV_URL,
    note: 'Staging URL not configured — running CSS & API analysis on dev environment only',
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    routes: [],
  };

  for (const route of comparisonRoutes) {
    const url = `${DEV_URL}${route.path}`;
    console.log(`[ARGUS] CSS analysis: ${route.name} (${url})`);

    const routeResult = {
      route: route.name,
      url,
      analyzedAt: new Date().toISOString(),
      findings: [],
      screenshot: null,
    };

    try {
      // Snapshot network count BEFORE navigation so API frequency analysis for
      // this route does not include requests accumulated from previous CSS-analysis routes.
      const networkBaseline = normalizeArray(await mcp.list_network_requests().catch(() => [])).length;

      // Navigate and settle
      await mcp.navigate_page({ url });
      await new Promise(r => setTimeout(r, config.pageSettleMs));

      // CSS analysis
      const cssRaw = await mcp.evaluate_script({ function:CSS_ANALYSIS_SCRIPT });
      const cssResult = unwrapEval(cssRaw);
      // Type-check before parse — unwrapEval may return null/string on MCP error;
      // parseCssAnalysisResult iterating a non-object would throw and drop all findings.
      if (cssResult && typeof cssResult === 'object') {
        const cssBugs = parseCssAnalysisResult(cssResult, url);
        routeResult.findings.push(...cssBugs);
      } else if (cssResult !== null) {
        console.warn(`[ARGUS] CSS analysis: unexpected response type (${typeof cssResult}), skipping ${url}`);
      }

      // API frequency analysis — sliced from per-route baseline
      const networkReqs = normalizeArray(await mcp.list_network_requests().catch(() => [])).slice(networkBaseline);
      const apiFindings = analyzeApiFrequency(networkReqs, url);
      routeResult.findings.push(...apiFindings);

      // Screenshot
      const screenshotPath = path.join(OUTPUT_DIR, `css-analysis-${slugify(route.name)}-${Date.now()}.png`);
      const screenshotData = await mcp.take_screenshot({ format: 'png' });
      if (screenshotData?.data) {
        fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));
        routeResult.screenshot = screenshotPath;
      }
    } catch (err) {
      routeResult.findings.push({
        type: 'analysis_error',
        message: `CSS analysis failed for ${url}: ${err.message}`,
        severity: 'warning',
        url,
      });
    }

    // Tally summary
    for (const f of routeResult.findings) {
      report.summary.total++;
      report.summary[f.severity] = (report.summary[f.severity] ?? 0) + 1;
    }

    report.routes.push(routeResult);
  }

  // Write report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(OUTPUT_DIR, `css-analysis-report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[ARGUS] CSS analysis report: ${reportPath}`);

  // Dispatch to Slack
  await dispatchCssAnalysisToSlack(report).catch(err =>
    console.error('[ARGUS] CSS Slack dispatch failed:', err.message)
  );

  return report;
}

/**
 * Dispatch CSS analysis findings to Slack.
 */
async function dispatchCssAnalysisToSlack(report) {
  for (const routeResult of report.routes) {
    const overrides = routeResult.findings.filter(f => f.type === 'css_override' && f.severity === 'warning');
    const leaks = routeResult.findings.filter(f => f.type === 'css_component_leak');
    const duplicateApis = routeResult.findings.filter(f => f.type === 'api_duplicate_call' && f.severity !== 'info');
    const criticalApis = routeResult.findings.filter(f => f.type === 'api_duplicate_call' && f.severity === 'critical');
    const summary = routeResult.findings.find(f => f.type === 'css_summary');

    // Critical API calls (5+ duplicates) → #bugs-critical
    for (const api of criticalApis) {
      await postBugReport({
        severity: 'critical',
        title: `Runaway API call on ${routeResult.route}`,
        description: api.message,
        url: routeResult.url,
        screenshotPath: routeResult.screenshot,
        details: api,
      }).catch(err => console.error('[ARGUS] Slack dispatch failed (css critical):', err.message));
    }

    // CSS overrides + leaks + duplicate APIs bundled as one warning per route
    const warningItems = [...overrides, ...leaks, ...duplicateApis.filter(a => a.severity === 'warning')];
    if (warningItems.length > 0) {
      const desc = warningItems.map(f => `• ${f.message}`).join('\n');
      await postBugReport({
        severity: 'warning',
        title: `CSS/API issues on ${routeResult.route} (${warningItems.length} found)`,
        description: desc,
        url: routeResult.url,
        screenshotPath: routeResult.screenshot,
        details: { route: routeResult.route, findings: warningItems },
      }).catch(err => console.error('[ARGUS] Slack dispatch failed (css warning):', err.message));
    }

    // Summary as info digest
    if (summary) {
      await postBugReport({
        severity: 'info',
        title: `CSS analysis complete: ${routeResult.route}`,
        description: summary.message +
          (summary.stylesheetSources?.length ? `\nStylesheets: ${summary.stylesheetSources.map(s => s.source.split('/').pop()).join(', ')}` : ''),
        url: routeResult.url,
        screenshotPath: null,
        details: summary,
      }).catch(err => console.error('[ARGUS] Slack dispatch failed (css info):', err.message));
    }
  }
}

/**
 * Dispatch comparison diffs to Slack.
 * Critical diffs (e.g., a 200→500 status regression) get immediate notification.
 * Screenshot diffs get posted with both images and the diff overlay.
 */
async function dispatchComparisonToSlack(report) {
  for (const routeResult of report.routes) {
    if (!routeResult.diffs?.length) continue;
    const criticals = routeResult.diffs.filter(d => d.severity === 'critical');
    const warnings = routeResult.diffs.filter(d => d.severity === 'warning');

    for (const diff of criticals) {
      await postBugReport({
        severity: 'critical',
        title: `Regression on ${routeResult.route}: ${diff.type}`,
        description: diff.description,
        url: routeResult.stagingUrl,
        screenshotPath: diff.stagingScreenshot ?? routeResult.stagingScreenshot,
        details: {
          diff,
          devUrl: routeResult.devUrl,
          stagingUrl: routeResult.stagingUrl,
        },
      }).catch(err => console.error('[ARGUS] Slack dispatch failed (comparison critical):', err.message));
    }

    if (warnings.length > 0) {
      // For screenshot diffs, attach the diff overlay image
      const screenshotDiff = warnings.find(d => d.type === 'screenshot');
      await postBugReport({
        severity: 'warning',
        title: `${warnings.length} diff(s) on ${routeResult.route}`,
        description: warnings.map(d => `• ${d.description}`).join('\n'),
        url: routeResult.stagingUrl,
        screenshotPath: screenshotDiff?.diffImagePath ?? routeResult.stagingScreenshot,
        details: {
          route: routeResult.route,
          devUrl: routeResult.devUrl,
          stagingUrl: routeResult.stagingUrl,
          diffs: warnings,
        },
      }).catch(err => console.error('[ARGUS] Slack dispatch failed (comparison warning):', err.message));
    }
  }
}

// ── CLI Entry ──────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log('[ARGUS] env-comparison.js loaded. Invoke runComparison(mcp) from Claude Code with MCP tools connected.');
  console.log('[ARGUS] Dev URL:', DEV_URL);
  console.log('[ARGUS] Staging URL:', STAGING_URL);
  console.log('[ARGUS] Routes to compare:', comparisonRoutes.map(r => r.path).join(', '));
}
