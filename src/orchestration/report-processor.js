/**
 * Argus Report Processor
 *
 * Post-crawl pipeline: dedup → severity overrides → summary rebuild →
 * baseline load/apply/save → trend append → JSON write.
 *
 * Extracted from crawl-and-report.js god object.
 */

import fs   from 'fs';
import path from 'path';

import { childLogger } from '../utils/logger.js';
import { applyOverrides }                                                  from '../utils/severity-overrides.js';
import { loadBaseline, saveBaseline, applyBaseline, appendTrend, getCurrentBranch } from '../utils/baseline-manager.js';

const logger = childLogger('report-processor');

// ── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Deduplicate findings: same type + message (first 200 chars) + url = one entry.
 * @param {object[]} findings
 * @returns {object[]}
 */
export function deduplicateFindings(findings) {
  const seen = new Set();
  return findings.filter(e => {
    if (!e || typeof e !== 'object') return false;
    const key = `${e.type ?? 'unknown'}::${(e.message ?? '').slice(0, 200)}::${e.url ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Summary Rebuild ───────────────────────────────────────────────────────────

/**
 * Recount report.summary from all findings in routes, flows, and codebase.
 * Called after applyOverrides() which may suppress or reclassify findings.
 * @param {object} report - Mutable report object
 */
export function rebuildSummary(report) {
  report.summary = { total: 0, critical: 0, warning: 0, info: 0 };

  function countFinding(finding) {
    report.summary.total++;
    if (finding.severity === 'critical' || finding.severity === 'warning' || finding.severity === 'info') {
      report.summary[finding.severity]++;
    } else if (finding.severity) {
      logger.warn(`[ARGUS] Unknown severity "${finding.severity}" on finding type "${finding.type ?? 'unknown'}"`);
    }
  }

  for (const routeResult of report.routes) {
    for (const err of routeResult.errors) countFinding(err);
  }
  for (const flowResult of (report.flows ?? [])) {
    for (const finding of (flowResult.findings ?? [])) countFinding(finding);
  }
  for (const finding of (report.codebase ?? [])) {
    countFinding(finding);
  }
}

// ── Main Post-Crawl Processor ─────────────────────────────────────────────────

/**
 * Apply overrides → rebuild summary → baseline load/apply → write JSON → save baseline + trend.
 *
 * @param {object} report     - Mutable report object (modified in place)
 * @param {object} options
 * @param {string} options.outputDir         - Directory to write error-report-*.json
 * @param {Array}  options.severityOverrides - From targets.js
 * @returns {{ reportPath: string, diff: object }}
 */
export async function processReport(report, { outputDir, severityOverrides }) {
  // 1. Apply severity overrides (suppress or reclassify findings)
  const { overriddenCount, suppressedCount } = applyOverrides(report, severityOverrides);
  if (overriddenCount > 0 || suppressedCount > 0) {
    logger.info(`[ARGUS] Severity overrides: ${overriddenCount} remapped, ${suppressedCount} suppressed`);
  }

  // 2. Rebuild summary after overrides
  rebuildSummary(report);

  // 3. Load baseline + compute diff
  const branch     = getCurrentBranch();
  const safeBranch = branch.replace(/[/\\]/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_');
  const baselinePath = path.join(outputDir, 'baselines', `${safeBranch}.json`);
  const trendsPath   = path.join(outputDir, 'baselines', `${safeBranch}-trends.json`);
  logger.info(`[ARGUS] Branch: "${branch}" → baseline: ${baselinePath}`);

  const baseline = loadBaseline(baselinePath);
  const diff     = applyBaseline(report, baseline);

  if (!diff.isFirstRun) {
    logger.info(`[ARGUS] Baseline diff: ${diff.newCount} new finding(s), ${diff.resolvedCount} resolved`);
    if ((diff.flowNewCount ?? 0) > 0 || (diff.flowResolvedCount ?? 0) > 0) {
      logger.info(`[ARGUS] Flow diff: ${diff.flowNewCount} new flow finding(s), ${diff.flowResolvedCount} resolved`);
    }
  } else {
    logger.info('[ARGUS] First run — no baseline to compare; all findings treated as new');
  }

  // 4. Write JSON report
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outputDir, `error-report-${timestamp}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch (err) {
    logger.error(`[ARGUS] Failed to write report JSON: ${err.message}`);
    throw err;
  }
  logger.info(`[ARGUS] Report written: ${reportPath}`);

  // 5. Persist baseline + append trend entry
  saveBaseline(baselinePath, report);
  appendTrend(trendsPath, {
    runAt:                report.generatedAt,
    baseUrl:              report.baseUrl,
    summary:              report.summary,
    newFindings:          diff.newCount,
    resolvedFindings:     diff.resolvedCount,
    routeCount:           report.routes.length,
    flowCount:            report.flows?.length ?? 0,
    flowNewFindings:      diff.flowNewCount  ?? 0,
    flowResolvedFindings: diff.flowResolvedCount ?? 0,
  });
  logger.info(`[ARGUS] Baseline saved → ${baselinePath} (branch: "${branch}")`);

  return { reportPath, diff };
}
