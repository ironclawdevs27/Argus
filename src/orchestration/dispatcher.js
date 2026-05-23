/**
 * Argus Report Dispatcher (v9.3.0)
 *
 * Dispatches a completed report to Slack, GitHub, and/or HTML.
 * Extracted from crawl-and-report.js god object.
 */

import path                                        from 'path';
import { execFile }                               from 'child_process';
import { childLogger }                            from '../utils/logger.js';
import { startSpan }                             from '../utils/telemetry.js';
import { postBugReport }                          from './slack-notifier.js';
import { isSlackConfigured }                      from '../utils/slack-guard.js';
import { isGitHubConfigured, reportToGitHub }     from '../utils/github-reporter.js';
import { generateHtmlReport }                     from '../utils/html-reporter.js';

const logger = childLogger('dispatcher');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Open a local file in the OS default browser (best-effort, skipped in CI).
 */
function openInBrowser(filePath) {
  if (process.env.CI) return;
  try {
    const abs = path.resolve(filePath);
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', abs], () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [abs], () => {});
    } else {
      execFile('xdg-open', [abs], () => {});
    }
  } catch {
    // no display available — skip silently
  }
}

/**
 * Safely extract the display message from any finding object.
 */
function errorText(e) {
  return e.message
    ?? e.description
    ?? (e.requestUrl ? `HTTP ${e.status ?? '?'} — ${e.method ?? 'GET'} ${e.requestUrl}` : null)
    ?? `${e.type ?? 'unknown error'}`;
}

// ── Slack Dispatch ────────────────────────────────────────────────────────────

/**
 * Send Slack notifications for bugs found in the report.
 *
 * Criticals  → one message per route with screenshot attached
 * Warnings   → one message per route (grouped)
 * Info       → single digest message summarising all routes
 */
async function dispatchToSlack(report, diff) {
  const { summary } = report;

  // ── Criticals: one message per affected route ─────────────────────────────
  for (const routeResult of report.routes) {
    const criticals = routeResult.errors.filter(e => e.severity === 'critical' && e.isNew === true);
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
    }).catch(err => logger.warn(`[ARGUS] Slack: critical report failed for ${routeResult.route}: ${err.message}`));
  }

  // ── Warnings: one message per affected route ──────────────────────────────
  for (const routeResult of report.routes) {
    const warnings = routeResult.errors.filter(e => e.severity === 'warning' && e.isNew === true);
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
    }).catch(err => logger.warn(`[ARGUS] Slack: warning report failed for ${routeResult.route}: ${err.message}`));
  }

  // ── Responsive screenshots: mobile view for routes with responsive findings
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
    }).catch(err => logger.warn(`[ARGUS] Slack: responsive report failed for ${routeResult.route}: ${err.message}`));
  }

  // ── Flow failures ─────────────────────────────────────────────────────────
  for (const flowResult of (report.flows ?? [])) {
    const flowCriticals = (flowResult.findings ?? []).filter(f => f.severity === 'critical' && f.isNew === true);
    if (flowCriticals.length > 0) {
      await postBugReport({
        severity: 'critical',
        title: `Flow "${flowResult.flowName}" failed — ${flowCriticals.length} critical issue(s)`,
        description: flowCriticals.map(f => `• *[${f.type}]* ${errorText(f)}`).join('\n'),
        url: report.baseUrl,
        screenshotPath: null,
        details: { flow: flowResult.flowName, errors: flowCriticals },
      }).catch(err => logger.warn(`[ARGUS] Slack: flow critical report failed for ${flowResult.flowName}: ${err.message}`));
    }
    const flowWarnings = (flowResult.findings ?? []).filter(f => f.severity === 'warning' && f.isNew === true);
    if (flowWarnings.length > 0) {
      await postBugReport({
        severity: 'warning',
        title: `Flow "${flowResult.flowName}" — ${flowWarnings.length} warning(s)`,
        description: flowWarnings.map(f => `• *[${f.type}]* ${errorText(f)}`).join('\n'),
        url: report.baseUrl,
        screenshotPath: null,
        details: { flow: flowResult.flowName, errors: flowWarnings },
      }).catch(err => logger.warn(`[ARGUS] Slack: flow warning report failed for ${flowResult.flowName}: ${err.message}`));
    }
  }

  // ── Codebase criticals + warnings ─────────────────────────────────────────
  const cbCriticals = (report.codebase ?? []).filter(f => f.severity === 'critical' && f.isNew === true);
  if (cbCriticals.length > 0) {
    await postBugReport({
      severity: 'critical',
      title: `${cbCriticals.length} codebase critical(s) — ${report.baseUrl}`,
      description: cbCriticals.map(f => `• *[${f.type}]* ${errorText(f)}`).join('\n'),
      url: report.baseUrl,
      screenshotPath: null,
      details: { codebase: cbCriticals },
    }).catch(err => logger.warn(`[ARGUS] Slack: codebase critical report failed: ${err.message}`));
  }
  const cbWarnings = (report.codebase ?? []).filter(f => f.severity === 'warning' && f.isNew === true);
  if (cbWarnings.length > 0) {
    await postBugReport({
      severity: 'warning',
      title: `${cbWarnings.length} codebase warning(s) — ${report.baseUrl}`,
      description: cbWarnings.map(f => `• *[${f.type}]* ${errorText(f)}`).join('\n'),
      url: report.baseUrl,
      screenshotPath: null,
      details: { codebase: cbWarnings },
    }).catch(err => logger.warn(`[ARGUS] Slack: codebase warning report failed: ${err.message}`));
  }

  // ── Info digest: one summary message across all routes ────────────────────
  const allInfos = report.routes.flatMap(r =>
    r.errors.filter(e => e.severity === 'info' && e.isNew !== false).map(e => ({ ...e, routeName: r.route }))
  );

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

  for (const flowResult of (report.flows ?? [])) {
    const flowInfos = (flowResult.findings ?? []).filter(e => e.severity === 'info');
    if (flowInfos.length === 0) continue;
    digestLines.push(`*Flow: ${flowResult.flowName}* (${flowResult.stepsCompleted}/${flowResult.totalSteps} steps — ${flowResult.status})`);
    for (const e of flowInfos) {
      digestLines.push(`  • [${e.type}] ${errorText(e)}`);
    }
  }

  const cbInfos = (report.codebase ?? []).filter(f => f.severity === 'info');
  if (cbInfos.length > 0) {
    digestLines.push('*Codebase (C1)*');
    for (const f of cbInfos) digestLines.push(`  • [${f.type}] ${errorText(f)}`);
  }

  const allFlowInfos = (report.flows ?? []).flatMap(f => (f.findings ?? []).filter(e => e.severity === 'info'));

  if (allInfos.length > 0 || allFlowInfos.length > 0 || cbInfos.length > 0) {
    const runDate  = new Date(report.generatedAt).toLocaleString();
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
    }).catch(err => logger.warn(`[ARGUS] Slack: info digest report failed: ${err.message}`));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Dispatch the completed report to all configured channels (Slack + GitHub + HTML).
 * Each channel is best-effort — a failure in one does not block the others.
 *
 * @param {object} report     - Completed report object (with baseline diff applied)
 * @param {object} diff       - Baseline diff returned by processReport
 * @param {string} reportPath - Path to the written JSON report (for HTML generation)
 */
export async function dispatchAll(report, diff, reportPath) {
  return startSpan('argus.dispatch', { baseUrl: report?.baseUrl ?? '' }, async () => {
  if (isSlackConfigured()) {
    try {
      await startSpan('argus.dispatch', { channel: 'slack' }, () => dispatchToSlack(report, diff));
    } catch (err) {
      logger.error(`[ARGUS] Slack dispatch failed: ${err.message}`);
    }
  } else {
    logger.info('\n[ARGUS] No Slack credentials — generating HTML report...');
    const htmlPath = await startSpan('argus.dispatch', { channel: 'html' }, () => generateHtmlReport(reportPath));
    logger.info(`[ARGUS] ✓ Open in browser: ${htmlPath}\n`);
    openInBrowser(htmlPath);
  }

  if (isGitHubConfigured()) {
    try {
      await startSpan('argus.dispatch', { channel: 'github' }, () => reportToGitHub(report, diff));
    } catch (err) {
      logger.error(`[ARGUS] GitHub reporting failed: ${err.message}`);
    }
  }
  }); // end argus.dispatch span
}
