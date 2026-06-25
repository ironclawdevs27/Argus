/**
 * Argus PR Validator — baseline-aware blocking (PR_VALIDATOR plan, Phase B1).
 *
 * The PR Validator's job is to block on regressions the PR INTRODUCES, not on findings
 * that already exist on the affected routes. This module supplies the head-vs-base finding
 * diff and the (safety-critical) merge-block decision built on it.
 *
 * Base source (PR_VALIDATOR §0): a stored, per-branch baseline file in the standard
 * baseline-manager on-disk format (`reports/baselines/<branch>.json`) — restored in CI via
 * the actions/cache pattern, keyed on the PR's target branch (GITHUB_BASE_REF). NOT a second
 * live audit. When no baseline is available the decision FAILS SAFE to absolute blocking (the
 * validator's pre-B1 behaviour) and SAYS SO — it must never silently pass a broken app.
 *
 * Keying: the baseline route map is keyed by route PATH (e.g. "/checkout"), not the full
 * URL, so a PR-head deploy on a different host (a Vercel/Netlify preview) still diffs against
 * the base correctly. Finding identity reuses findingKey() (type::message[:100]::status) from
 * flakiness-detector, so new/persisting classification matches every other Argus diff.
 *
 * stdout discipline: this module is reachable from src/mcp-server.js — it writes NOTHING to
 * stdout. The CLI owns stdout (the JSON result + CI annotations); diagnostics go to stderr.
 */

import path from 'path';
import { loadBaseline, saveBaseline } from './baseline-manager.js';
import { findingKey } from './flakiness-detector.js';

/** Severity tally for a flat findings array → { critical, warning, info }. */
export function severityTally(findings) {
  const t = { critical: 0, warning: 0, info: 0 };
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if (f && Object.prototype.hasOwnProperty.call(t, f.severity)) t[f.severity]++;
  }
  return t;
}

/**
 * Diff per-route PR-head findings against a loaded baseline.
 *
 * Pure — does not mutate inputs. A finding is NEW when its findingKey is absent from its
 * route's baseline key set; PERSISTING when present. RESOLVED counts baseline keys (on the
 * AUDITED routes only) with no current finding — un-audited baseline routes are never counted
 * resolved (they were not checked this run).
 *
 * @param {Array<{ path: string, findings: Array }>} routeResults  audited routes + their findings
 * @param {{ routes: Map<string, Set<string>> } | null} baseline   loadPrBaseline() output
 * @returns {{ newFindings: Array, persistingFindings: Array,
 *            newSummary: {critical:number,warning:number,info:number},
 *            persistingCount: number, resolvedCount: number }}
 */
export function diffRoutesAgainstBaseline(routeResults, baseline) {
  const routes     = Array.isArray(routeResults) ? routeResults : [];
  const baseRoutes = baseline && baseline.routes instanceof Map ? baseline.routes : new Map();

  const newFindings        = [];
  const persistingFindings = [];
  let   resolvedCount       = 0;

  for (const r of routes) {
    const routePath = String(r?.path ?? '');
    const findings  = Array.isArray(r?.findings) ? r.findings : [];
    const baseKeys  = baseRoutes.get(routePath) ?? new Set();
    const seen      = new Set();

    for (const f of findings) {
      const key = findingKey(f);
      seen.add(key);
      if (baseKeys.has(key)) persistingFindings.push(f);
      else                   newFindings.push(f);
    }

    // Resolved: a baseline finding on THIS audited route that no longer appears.
    for (const k of baseKeys) {
      if (!seen.has(k)) resolvedCount++;
    }
  }

  return {
    newFindings,
    persistingFindings,
    newSummary: severityTally(newFindings),
    persistingCount: persistingFindings.length,
    resolvedCount,
  };
}

/**
 * Tag each PR-head finding with `isNew` (true = PR-introduced, false = persisting) based on the
 * per-route baseline, so the GitHub PR comment's new/persisting surfacing (Phase B2) and the
 * existing isNew-aware reporters (formatPrComment / buildStatusPayload) reflect what the PR
 * actually introduced rather than every finding on the affected routes.
 *
 * Mutates the finding objects in place. In both PR-validate paths the per-route findings ARE the
 * same object references that populate the flat `result.findings` array, so tagging here tags the
 * comment's source data transitively — no second pass needed.
 *
 * Uses findingKey() (the same identity diffRoutesAgainstBaseline uses), so the tags and the
 * head-vs-base counts can never disagree. No-op when no baseline is available: the run fails safe
 * to absolute blocking, where every finding is correctly treated as new (left untagged →
 * `isNew !== false` → counted as new by formatPrComment).
 *
 * @param {Array<{ path: string, findings: Array }>} routeResults
 * @param {{ routes: Map<string, Set<string>> } | null} baseline
 */
export function tagFindingNovelty(routeResults, baseline) {
  if (!(baseline && baseline.routes instanceof Map)) return;
  const baseRoutes = baseline.routes;
  for (const r of (Array.isArray(routeResults) ? routeResults : [])) {
    const baseKeys = baseRoutes.get(String(r?.path ?? '')) ?? new Set();
    for (const f of (Array.isArray(r?.findings) ? r.findings : [])) {
      // A finding is NEW when its key is ABSENT from the baseline; present → persisting.
      if (f && typeof f === 'object') f.isNew = !baseKeys.has(findingKey(f));
    }
  }
}

/**
 * The PR Validator's merge-block decision — baseline-aware, fail-safe. SAFETY-CRITICAL.
 *
 * Reused by BOTH PR-validate paths (src/cli/pr-validate.js + src/mcp-server.js
 * handlePrValidate) so they cannot diverge on the block semantics.
 *
 *   - baseline available → gate on the NEW (PR-introduced) findings only.
 *   - baseline absent     → FAIL SAFE: gate on the ABSOLUTE findings (the pre-B1 behaviour)
 *                           AND set `note`, so the summary/comment states that blocking is on
 *                           absolute counts. Never silently passes a broken app.
 *
 * The gate itself is the existing block-on matrix (none | warning | critical).
 *
 * @param {object} args
 * @param {Array<{path:string,findings:Array}>} [args.routeFindings]  audited routes + findings
 * @param {{critical:number,warning:number,info:number}} [args.summary]  absolute severity tally
 * @param {string} [args.blockOn]                                     none | warning | critical
 * @param {{routes: Map}|null} [args.baseline]                        loadPrBaseline() output
 * @returns {{ blocked:boolean, baselineAvailable:boolean,
 *            effectiveSummary:{critical:number,warning:number,info:number},
 *            newSummary:object|null, persistingCount:number, resolvedCount:number,
 *            reason:string|null, note:string|null }}
 */
export function decidePrBlock({
  routeFindings = [],
  summary       = { critical: 0, warning: 0, info: 0 },
  blockOn       = 'critical',
  baseline      = null,
} = {}) {
  const policy            = String(blockOn ?? 'critical').toLowerCase().trim();
  const baselineAvailable = !!(baseline && baseline.routes instanceof Map);

  const diff             = baselineAvailable ? diffRoutesAgainstBaseline(routeFindings, baseline) : null;
  const effectiveSummary = baselineAvailable ? diff.newSummary : { ...summary };

  const blocked =
    policy === 'critical' ? effectiveSummary.critical > 0 :
    policy === 'warning'  ? effectiveSummary.critical + effectiveSummary.warning > 0 :
    false;

  // "new" vs "total" makes the block reason honest about what it counted.
  const scope  = baselineAvailable ? 'new' : 'total';
  const reason = !blocked ? null
    : policy === 'warning'
      ? `${effectiveSummary.critical} critical + ${effectiveSummary.warning} warning ${scope} finding(s) at or above the block threshold`
      : `${effectiveSummary.critical} critical ${scope} finding(s) found`;

  const note = baselineAvailable
    ? null
    : 'Baseline unavailable — blocking on absolute finding counts (no per-branch baseline found to diff against).';

  return {
    blocked,
    baselineAvailable,
    effectiveSummary,
    newSummary:     diff ? diff.newSummary       : null,
    persistingCount: diff ? diff.persistingCount : 0,
    resolvedCount:   diff ? diff.resolvedCount   : 0,
    reason,
    note,
  };
}

/**
 * Resolve the baseline file path for a PR-validate run.
 *
 *   1. ARGUS_BASELINE_FILE — explicit override (used verbatim).
 *   2. <outputDir>/baselines/<safe(baseRef)>.json — baseRef defaults to the PR target branch
 *      (GITHUB_BASE_REF) for the READ path; pass getCurrentBranch() for the WRITE path.
 *   3. null — no resolvable base ref → the caller fails safe to absolute blocking.
 *
 * @param {object} [opts]
 * @param {string} [opts.outputDir]  reports dir (default REPORT_OUTPUT_DIR or ./reports)
 * @param {string} [opts.baseRef]    branch ref to resolve the file for
 * @returns {string|null}
 */
export function resolvePrBaselineFile({ outputDir, baseRef } = {}) {
  if (process.env.ARGUS_BASELINE_FILE) return process.env.ARGUS_BASELINE_FILE;
  const ref = baseRef ?? process.env.GITHUB_BASE_REF ?? process.env.ARGUS_BASE_BRANCH;
  if (!ref) return null;
  const dir  = outputDir || process.env.REPORT_OUTPUT_DIR || './reports';
  const safe = String(ref).replace(/[/\\]/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
  return path.join(dir, 'baselines', `${safe}.json`);
}

/**
 * Load a PR baseline file. Returns { routes: Map<path, Set<key>> } or null (absent/corrupt).
 * Thin wrapper over baseline-manager.loadBaseline — identical on-disk format; here the route
 * keys are PATHS rather than full URLs (see the module header).
 */
export function loadPrBaseline(file) {
  if (!file) return null;
  return loadBaseline(file);
}

/**
 * Persist the current run's per-route findings as this branch's baseline (path-keyed).
 *
 * Reuses baseline-manager.saveBaseline by adapting routeResults into its report shape: each
 * route's `url` is set to the route PATH, so the stored `routes` map is keyed by path.
 *
 * @param {string} file
 * @param {Array<{ path: string, findings: Array }>} routeResults
 */
export function savePrBaseline(file, routeResults) {
  const report = {
    routes: (Array.isArray(routeResults) ? routeResults : []).map(r => ({
      url:    String(r?.path ?? ''),
      errors: Array.isArray(r?.findings) ? r.findings : [],
    })),
    flows: [],
    codebase: [],
  };
  saveBaseline(file, report);
}
