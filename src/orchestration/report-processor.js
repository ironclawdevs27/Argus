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
import { loadRunHistory, recordRunHistory, applyNoiseFilter }              from '../utils/noise-filter.js';
import { getRecentChanges, linkRootCauses }                                from '../utils/root-cause-linker.js';
import { classifySensitivity, summarizeRedaction }                        from '../utils/sensitivity-classifier.js';
import { effectivePolicyOpts, governanceOptOutClamped }                   from '../utils/redaction-policy.js';
import { ensureGovernancePolicy, postRedactionAggregate, governanceActive } from '../utils/governance-seam.js';

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

/**
 * Flatten every finding in a report (route errors, flow findings, codebase) into
 * one array — used to compute the secret-free governance aggregate. Read-only.
 * @param {object} report
 * @returns {object[]}
 */
export function collectAllFindings(report) {
  const out = [];
  for (const routeResult of (report.routes ?? [])) {
    for (const err of (routeResult.errors ?? [])) out.push(err);
  }
  for (const flowResult of (report.flows ?? [])) {
    for (const finding of (flowResult.findings ?? [])) out.push(finding);
  }
  for (const finding of (report.codebase ?? [])) out.push(finding);
  return out;
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
  // 0. Aegis governance seam (opt-in, AEGIS_FOR_TEAMS §9): if a gov token is set,
  //    fetch + Ed25519-verify the org's central policy BEFORE any classification so
  //    every downstream redaction enforces it. Best-effort + fail-closed internally
  //    (a fetch/verify error leaves the engine on its strict floor). No token ⇒ no
  //    network, byte-identical.
  await ensureGovernancePolicy();

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

  // 3a. Intelligent baseline filtering — downgrade cross-run flip-flopping findings
  //     to info. Best-effort; disable with ARGUS_NOISE_FILTER=0.
  const historyPath = path.join(outputDir, 'baselines', `${safeBranch}-history.json`);
  if (process.env.ARGUS_NOISE_FILTER !== '0') {
    try {
      const history = loadRunHistory(historyPath);
      const { noisyCount } = applyNoiseFilter(report, history);
      if (noisyCount > 0) rebuildSummary(report); // downgrades change severity counts
    } catch (err) {
      logger.warn(`[ARGUS] Noise filter skipped: ${err.message}`);
    }
  }

  // 3b. Root cause linking — annotate new findings with recent git changes that
  //     map to their route. Best-effort; disable with ARGUS_ROOT_CAUSE=0.
  if (process.env.ARGUS_ROOT_CAUSE !== '0') {
    try {
      linkRootCauses(report, getRecentChanges());
    } catch (err) {
      logger.warn(`[ARGUS] Root cause linking skipped: ${err.message}`);
    }
  }

  // reportPath is computed here (ahead of the write) so step 3c can point each
  // finding's localRef at the on-disk report file it will be written to.
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(outputDir, `error-report-${timestamp}.json`);

  // 3c. Aegis sensitivity classification — tag findings for the egress guards
  //     (REDACTION_BOUNDARY_MAX_PLAN.md §6 Step 3). Tagging happens on shallow
  //     CLONES, so the LOCAL report below keeps 100% fidelity — Aegis only ever
  //     removes detail at an external sink, never on disk.
  //     SECURITY-CRITICAL: this is the ONE post-processor that fails CLOSED. On
  //     any error the egress guards must redact everything, so we set the
  //     _aegisFailClosed flag rather than swallowing-and-continuing.
  //     A gov token clamps the ARGUS_REDACT_SENSITIVE=0 opt-out (§4.3) so tagging
  //     still runs under an org policy — a dev can't disable it locally.
  if (process.env.ARGUS_REDACT_SENSITIVE !== '0' || governanceOptOutClamped()) {
    try {
      const { sensitiveCount } = classifySensitivity(report, { reportRef: path.basename(reportPath) });
      if (sensitiveCount > 0) logger.info(`[ARGUS] Aegis: ${sensitiveCount} finding(s) tagged sensitive`);
    } catch (err) {
      logger.error(`[ARGUS] Aegis classify failed — egress guards will fail closed: ${err.message}`);
      report._aegisFailClosed = true; // sinks read this and redact everything
    }

    // 3d. Governance audit trail (opt-in): post a SECRET-FREE redaction aggregate
    //     (byReason label counts only) to the org's audit sink. Best-effort — never
    //     blocks or fails the run, never sends a secret. No-op unless a gov token +
    //     ARGUS_REDACT_AUDIT_URL are set.
    if (governanceActive() && process.env.ARGUS_REDACT_AUDIT_URL) {
      try {
        const all = collectAllFindings(report);
        const summary = summarizeRedaction(all, effectivePolicyOpts({}));
        await postRedactionAggregate(summary, { meta: { runRef: path.basename(reportPath) } });
      } catch (err) {
        logger.debug(`[ARGUS] Aegis governance aggregate skipped: ${err.message}`);
      }
    }
  }

  // 4. Write JSON report
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); // lgtm[js/network-data-to-file] — intentional: Argus persists crawl findings to a local JSON report file by design
  } catch (err) {
    logger.error(`[ARGUS] Failed to write report JSON: ${err.message}`);
    throw err;
  }
  logger.info(`[ARGUS] Report written: ${reportPath}`);

  // 5. Persist baseline + run history + append trend entry
  saveBaseline(baselinePath, report);
  if (process.env.ARGUS_NOISE_FILTER !== '0') {
    try {
      recordRunHistory(historyPath, report);
    } catch (err) {
      logger.warn(`[ARGUS] Run history write skipped: ${err.message}`);
    }
  }
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
