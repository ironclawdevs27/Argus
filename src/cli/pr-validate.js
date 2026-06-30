#!/usr/bin/env node
/**
 * Argus PR Validator — headless CI entry point for GitHub Actions.
 *
 * Environment variables (set by action.yml):
 *   ARGUS_PR_URL         Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/42 (required)
 *   TARGET_DEV_URL       Base URL of the running application, e.g. https://staging.example.com (required)
 *   ARGUS_BLOCK_ON       critical | warning | none  (default: critical)
 *   GITHUB_TOKEN         GitHub PAT or workflow GITHUB_TOKEN — optional for public repos
 *   ARGUS_ROUTES_FILE    Path to a JSON routes array [{path,name}] — optional, see loadRoutes()
 *   GITHUB_OUTPUT        Set by GitHub runner — path for step output key=value pairs
 *   GITHUB_STEP_SUMMARY  Set by GitHub runner — path for markdown step summary
 *
 * Exit codes:
 *   0 — audit passed (blocked=false) or no routes to audit
 *   1 — audit blocked (findings at or above ARGUS_BLOCK_ON threshold) OR startup error
 *
 * Exports (used by test harness — no Chrome required):
 *   buildStepSummary(opts)     → markdown string
 *   writeGithubOutputs(opts)   → void (writes to GITHUB_OUTPUT file)
 *   writeStepSummary(markdown) → void (writes to GITHUB_STEP_SUMMARY file)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath }                              from 'url';
import { createMcpClient }                            from '../utils/mcp-client.js';
import { crawlRouteWithDepth }                         from '../orchestration/crawl-and-report.js';
import { resolveAuditDepth, selectAnalyzers }          from '../utils/audit-depth.js';
import { auditRoutesConcurrently, auditRouteWithRetry, routeResilienceFromEnv } from '../utils/parallel-crawler.js';
import { fetchPrFiles, mapFilesToRoutesDeep, resolveAnnotationTarget } from '../utils/pr-diff-analyzer.js';
import { resolveTargetUrl }                           from '../utils/deploy-preview.js';
import { reportPrValidation }                         from '../utils/github-reporter.js';
import { redactForEgress }                             from '../utils/sensitivity-classifier.js';
import { scrubText }                                   from '../utils/secret-patterns.js';
import { getCurrentBranch }                            from '../utils/baseline-manager.js';
import {
  decidePrBlock, resolvePrBaselineFile, loadPrBaseline, savePrBaseline, tagFindingNovelty, severityTally,
} from '../utils/pr-baseline.js';

// ── Exported helpers (testable without Chrome) ────────────────────────────────

/**
 * Aegis egress guard (Step 7): the $GITHUB_STEP_SUMMARY is a CI artifact readable by anyone
 * with repo access (A4), so a finding's free-text must never cross raw. Project the finding
 * through redactForEgress and return its egress-safe `message` + `url`: a sensitive finding's
 * message collapses to the 🔒 marker, a benign one keeps its scrubbed message; the url is
 * stripped of query/userinfo. ARGUS_REDACT_SENSITIVE=0 ⇒ raw (byte-identical to pre-Aegis).
 *
 * @param {object} f
 * @returns {{ message: string, url: string }}
 */
export function safeFindingLine(f) {
  if (process.env.ARGUS_REDACT_SENSITIVE === '0') {
    return { message: String(f?.message ?? ''), url: String(f?.url ?? '') };
  }
  const [p] = redactForEgress([f]);
  return { message: String(p?.message ?? ''), url: String(p?.url ?? '') };
}

/**
 * Build a GitHub-flavoured markdown step summary.
 *
 * @param {object} opts
 * @param {boolean} opts.blocked
 * @param {{ critical: number, warning: number, info: number }} opts.summary
 * @param {Array<{ path: string }>} opts.affectedRoutes
 * @param {Array<{ route: string, critical: number, warning: number, info: number, error?: string }>} opts.perRoute
 * @param {Array<object>} opts.findings
 * @param {string[]} opts.changedFiles
 * @param {string} opts.blockOn   critical | warning | none
 * @param {object} [opts.baseline] baseline-aware diff status (Phase B1). When available:
 *   { available: true, newCritical, newWarning, newInfo, persisting, resolved }.
 *   When not: { available: false, note }. Omit entirely for non-baseline callers.
 * @param {string} [opts.error]   top-level error message (startup / fetch failure)
 * @returns {string}
 */
export function buildStepSummary({ blocked, summary, affectedRoutes, perRoute, findings, changedFiles, blockOn, baseline, error }) {
  const icon   = blocked ? '🔴' : summary.critical + summary.warning === 0 ? '✅' : '⚠️';
  const status = blocked ? 'BLOCKED — merge prevented' : 'PASSED';

  let md = `## ${icon} Argus PR Validator — ${status}\n\n`;

  if (error) {
    md += `> **Error:** ${String(error).replace(/`/g, "'")}\n\n`;
  }

  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Block threshold | \`${blockOn}\` |\n`;
  md += `| Critical findings | **${summary.critical}** |\n`;
  md += `| Warning findings | ${summary.warning} |\n`;
  md += `| Info findings | ${summary.info} |\n`;
  md += `| Routes audited | ${affectedRoutes.length} |\n`;
  md += `| Files changed | ${changedFiles.length} |\n\n`;

  // Baseline-aware blocking status (Phase B1). Either the head-vs-base diff counts, or the
  // fail-safe note when no per-branch baseline was available to diff against.
  if (baseline) {
    if (baseline.available) {
      md += `### Baseline diff\n\n`;
      md += `Blocking on **new** findings this PR introduces (vs the base-branch baseline).\n\n`;
      md += `| | 🔴 Critical | ⚠️ Warning | ℹ️ Info |\n|--|------------|-----------|--------|\n`;
      md += `| New | ${baseline.newCritical} | ${baseline.newWarning} | ${baseline.newInfo} |\n\n`;
      md += `_${baseline.persisting} persisting · ${baseline.resolved} resolved._\n\n`;
    } else {
      md += `> ⚠️ ${baseline.note ?? 'Baseline unavailable — blocking on absolute finding counts.'}\n\n`;
    }
  }

  if (perRoute.length > 0) {
    md += `### Route Breakdown\n\n`;
    md += `| Route | 🔴 Critical | ⚠️ Warning | ℹ️ Info |\n|-------|------------|-----------|--------|\n`;
    for (const r of perRoute) {
      const errNote = r.error ? ` _(error: ${String(r.error).slice(0, 60)})_` : '';
      md += `| \`${r.route}\` | ${r.critical} | ${r.warning} | ${r.info}${errNote} |\n`;
    }
    md += '\n';
  }

  if (findings.length > 0) {
    md += `### Findings\n\n`;
    md += `| Severity | Type | Message | URL |\n|----------|------|---------|-----|\n`;
    const shown = findings.slice(0, 50);
    for (const f of shown) {
      const sev = f.severity === 'critical' ? '🔴 critical'
               : f.severity === 'warning'  ? '⚠️ warning'
               : 'ℹ️ info';
      const safe = safeFindingLine(f);   // Aegis: scrub message + strip url query before egress
      const msg = safe.message.replace(/\|/g, '\\|').slice(0, 100);
      const url = safe.url.replace(/\|/g, '\\|').slice(0, 80);
      md += `| ${sev} | \`${f.type ?? ''}\` | ${msg} | ${url} |\n`;
    }
    if (findings.length > 50) {
      md += `\n_…and ${findings.length - 50} more findings._\n`;
    }
    md += '\n';
  }

  md += `---\n_Powered by [Argus QA](https://argus-qa.com)_\n`;
  return md;
}

/**
 * Write step outputs to $GITHUB_OUTPUT (key=value pairs).
 * No-ops when GITHUB_OUTPUT is not set (local / non-Actions environments).
 */
export function writeGithubOutputs({ blocked, summary, affectedRoutes }) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const routes = Array.isArray(affectedRoutes)
    ? affectedRoutes.map(r => (typeof r === 'string' ? r : r.path)).join(',')
    : '';
  const lines = [
    `blocked=${blocked}`,
    `critical_count=${summary.critical}`,
    `warning_count=${summary.warning}`,
    `affected_routes=${routes}`,
  ].join('\n') + '\n';
  fs.appendFileSync(outputPath, lines);
}

/**
 * Append markdown to $GITHUB_STEP_SUMMARY.
 * No-ops when GITHUB_STEP_SUMMARY is not set.
 */
export function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, markdown);
}

// ── Preflight reachability check ──────────────────────────────────────────────

export async function checkTargetReachable(url) {
  try {
    // fetch throws only on network errors (ECONNREFUSED, ETIMEDOUT, DNS failure).
    // HTTP error status codes (4xx/5xx) still mean the server is up — Argus should
    // audit those pages, so we only gate on network-level failures.
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Normalize route paths — crawlRouteCheap builds URLs via string concatenation
 * (baseUrl + route.path), so paths without a leading slash produce malformed URLs.
 * @param {Array<{path: string, name?: string}>} routes
 * @returns {Array<{path: string, name?: string}>}
 */
export function normalizeRoutePaths(routes) {
  return routes.map(r => {
    if (!r.path.startsWith('/')) {
      return { ...r, path: `/${r.path}` };
    }
    return r;
  });
}

/**
 * All-routes-failed guard (safety-critical — must never false-PASS). True when at least one
 * route was audited and EVERY audited route errored (the app was unreachable, or every audit
 * timed out). The caller throws on this → exit 1 → merge blocked. A timed-out route audit is
 * recorded as a route error (perRoute[i].error set, via auditRouteWithRetry, D4), so a hung
 * audit feeds this guard and can never become a silent pass. A PARTIAL failure (some routes ok)
 * does NOT trip the guard: those errors are surfaced in the summary/annotations and the normal
 * finding-based block decision applies.
 *
 * @param {Array<{ error?: string }>} perRoute
 * @returns {boolean}
 */
export function allRoutesFailed(perRoute) {
  return Array.isArray(perRoute) && perRoute.length > 0 && perRoute.every(r => r && r.error);
}

/**
 * The CLI's audit-decision → process exit-code mapping (the CI merge gate). SAFETY-CRITICAL:
 * exit 1 blocks the merge, exit 0 allows it. Returns 1 when the PR is blocked (findings at or
 * above the block-on threshold — the baseline-aware decidePrBlock decision) OR the audit failed
 * (every route errored / a startup/fetch error — both surface via the catch as `failed`); 0 only
 * when a completed audit passed. Extracted as a pure exported fn (like allRoutesFailed) so the
 * full block-decision → exit matrix is unit- + mutation-testable without driving Chrome.
 *
 * @param {{ blocked?: boolean, failed?: boolean }} [d]
 * @returns {0 | 1}
 */
export function prExitCode({ blocked = false, failed = false } = {}) {
  return (blocked || failed) ? 1 : 0;
}

// ── Route loader ──────────────────────────────────────────────────────────────

async function loadRoutes() {
  // 1. ARGUS_ROUTES_FILE env var
  const routesFile = process.env.ARGUS_ROUTES_FILE;
  if (routesFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
      if (Array.isArray(raw) && raw.length > 0) {
        console.log(`[argus] Loaded ${raw.length} route(s) from ${routesFile}`);
        return raw;
      }
    } catch (err) {
      console.error(`::warning::Could not parse ARGUS_ROUTES_FILE (${routesFile}): ${err.message}`);
    }
  }

  // 2. argus.routes.json in working directory
  const localFile = path.join(process.cwd(), 'argus.routes.json');
  if (fs.existsSync(localFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      if (Array.isArray(raw) && raw.length > 0) {
        console.log(`[argus] Loaded ${raw.length} route(s) from argus.routes.json`);
        return raw;
      }
    } catch (err) {
      console.error(`::warning::Could not parse argus.routes.json: ${err.message}`);
    }
  }

  // 3. Final fallback — audit root path only
  // NOTE: We deliberately do NOT fall back to the package's targets.js here.
  // targets.js contains the developer's own demo routes with app-specific
  // waitFor selectors (e.g. [data-testid="dashboard"]) that do not exist on
  // user apps — falling back to them causes false-positive load_failure
  // findings and incorrectly blocks merges.
  console.log('[argus] No routes configured — falling back to root path audit');
  console.log('[argus] Tip: add argus.routes.json to your repo root to audit specific routes.');
  return [{ path: '/', name: 'home' }];
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Guard: run main() only when this script is executed directly, not when imported.
const _thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === _thisFile) {
  await main();
}

async function main() {
  const prUrl     = process.env.ARGUS_PR_URL;
  const blockOn   = (process.env.ARGUS_BLOCK_ON ?? 'critical').toLowerCase().trim();
  const token     = process.env.GITHUB_TOKEN;

  // Input validation
  if (!prUrl) {
    console.error('::error::ARGUS_PR_URL is not set. Set it to the full GitHub PR URL (e.g. https://github.com/owner/repo/pull/42).');
    process.exit(1);
  }
  if (!['none', 'warning', 'critical'].includes(blockOn)) {
    console.error(`::error::ARGUS_BLOCK_ON must be none | warning | critical, got: "${blockOn}"`);
    process.exit(1);
  }

  // Resolve the audit target (D3 — deploy-preview auto-detection). Prefer a per-PR deploy
  // preview over the static TARGET_DEV_URL, always degrading gracefully back to it. Default
  // (no ARGUS_PREVIEW_URL / ARGUS_PREVIEW_DETECT) → TARGET_DEV_URL exactly, with NO extra
  // network call — byte-identical to the prior behaviour. The head SHA (ARGUS_PR_HEAD_SHA,
  // the PR head, not the runner's merge-commit GITHUB_SHA) keys the GitHub Deployments probe.
  const headSha = process.env.ARGUS_PR_HEAD_SHA || process.env.GITHUB_SHA;
  const { url: targetUrl, source: targetSource } = await resolveTargetUrl({
    env: process.env, prUrl, headSha, token,
  });
  if (targetSource !== 'target-dev-url') {
    console.log(`[argus] Audit target resolved via ${targetSource}: ${targetUrl}`);
  }

  let mcp;
  const changedFiles   = [];
  const affectedRoutes = [];
  const allFindings    = [];
  const perRoute       = [];
  const routeFindings  = [];   // [{ path, findings }] — feeds the baseline-aware diff (B1)

  try {
    // Step 1: Fetch the PR file list from GitHub
    console.log(`[argus] Fetching PR diff: ${prUrl}`);
    // prFiles carries { filename, status, patch } per file; `files` is the filename-only
    // view used for slug mapping + the string[] output contract. prFiles.patch feeds the
    // file:line annotations (Phase A3).
    const prFiles = await fetchPrFiles(prUrl, token);
    const files   = prFiles.map(f => f.filename);
    changedFiles.push(...files);
    console.log(`[argus] ${files.length} changed file(s)`);
    if (files.length >= 300) {
      // CI annotation lives here (CLI owns stdout) — fetchPrFiles itself only
      // logs to stderr so the MCP server's JSON-RPC stdout stays clean.
      console.log('::warning::PR has 300+ changed files — Argus analyzed the first 300. Routes affected by later files may be missed.');
    }

    // Step 2: Map changed files to affected routes. When ARGUS_SOURCE_DIR points at the
    // checked-out app source, mapFilesToRoutesDeep (C1) maps a changed component to only the
    // routes whose page files import it (static import graph + Next.js convention); without
    // it — or on any resolution ambiguity — it falls back to the conservative slug heuristic
    // (all routes on no-match), so a regression is never narrowed away. Opt-in: unset
    // ARGUS_SOURCE_DIR keeps the prior slug-only behaviour exactly.
    const routes   = await loadRoutes();
    const affected = mapFilesToRoutesDeep(files, routes, { sourceDir: process.env.ARGUS_SOURCE_DIR });
    affectedRoutes.push(...affected);

    if (affected.length === 0) {
      console.log('[argus] No affected routes resolved — skipping audit');
      const summary = { critical: 0, warning: 0, info: 0 };
      writeGithubOutputs({ blocked: false, summary, affectedRoutes: [] });
      writeStepSummary(buildStepSummary({ blocked: false, summary, affectedRoutes: [], perRoute: [], findings: [], changedFiles: files, blockOn }));
      process.exit(0);
    }

    console.log(`[argus] Auditing ${affected.length} route(s): ${affected.map(r => r.path).join(', ')}`);

    // Step 3: Verify target is reachable before spending time on Chrome startup
    console.log(`[argus] Verifying target is reachable: ${targetUrl}`);
    const reachable = await checkTargetReachable(targetUrl);
    if (!reachable.ok) {
      throw new Error(`Target URL not reachable (${targetUrl}): ${reachable.error}. Make sure your app is running and accessible from the runner before this action fires.`);
    }

    // Step 4: Connect to Chrome via the chrome-devtools MCP client
    console.log('[argus] Connecting to Chrome on port 9222...');
    mcp = await createMcpClient();
    console.log('[argus] Chrome connected.');

    // INTENTIONAL DIVERGENCE from the MCP tool (src/mcp-server.js handlePrValidate): the CLI
    // audits a routes-file (CI safety + speed); the MCP tool audits config/targets.js (dev
    // convenience). That ROUTE-SOURCE divergence is by design (PR_VALIDATOR A4/E4). Everything
    // downstream of the route list is SHARED so the two paths agree (E4 — CLI↔MCP parity):
    //   • AUDIT DEPTH does NOT diverge — both run crawlRouteCheap by default and share ONE opt-in
    //     depth policy (ARGUS_PR_AUDIT_DEPTH → selectAnalyzers, D2).
    //   • The BLOCK DECISION is the shared decidePrBlock, fed a summary built by the shared
    //     severityTally (Step 6 below) — for the same findings + baseline + blockOn the two paths
    //     reach the IDENTICAL `blocked`/reason (decidePrBlock owns the none|warning|critical matrix
    //     AND normalizes blockOn casing, so neither path re-implements or pre-normalizes the gate).
    //   • Both paths REPORT through the SAME shared helper — reportPrValidation (Step 9 below).
    //
    // Step 5: Audit each affected route via crawlRouteWithDepth (cheap pass + the selected
    // expensive analyzers, if any — see Step 5 depth resolution below).
    // Preserve path prefix (e.g. /project/ in GitHub Pages) — .origin would strip it
    const baseUrl = targetUrl.replace(/\/$/, '');

    // Selective analyzer depth (D2). The shared policy maps ARGUS_PR_AUDIT_DEPTH + the PR's
    // changed file types to the expensive analyzers to also run on each affected route.
    // Default 'cheap' → empty list → crawlRouteWithDepth returns the crawlRouteCheap result
    // unchanged (byte-identical to before). Computed once per PR (selection is per-PR, not
    // per-route — every route gets the same depth).
    const auditDepth     = resolveAuditDepth(process.env.ARGUS_PR_AUDIT_DEPTH);
    const depthAnalyzers = selectAnalyzers({ depth: auditDepth, changedFiles: files });
    if (depthAnalyzers.length > 0) {
      console.log(`[argus] Audit depth: ${auditDepth} → also running expensive analyzers: ${depthAnalyzers.join(', ')}`);
    }

    // Normalize route paths — crawlRouteCheap builds URLs via string concat (baseUrl + route.path)
    // so paths without a leading slash produce malformed URLs like https://example.comlogin
    const normalizedAffected = normalizeRoutePaths(affected).map((r, i) => {
      if (r.path !== affected[i].path) {
        console.log(`::warning::Route path "${affected[i].path}" has no leading slash — normalizing. Update argus.routes.json to use a leading slash.`);
      }
      return r;
    });

    // Audit each affected route. Bounded-concurrency by ARGUS_CONCURRENCY (default 1 = sequential,
    // byte-identical to the prior loop). Each parallel lane gets its OWN Chrome client —
    // crawlRouteCheap mutates page-navigation state, so concurrent crawls must never share a
    // connection — and auditRoutesConcurrently returns the per-route results in ROUTE order, so the
    // aggregate findings + the baseline-aware block decision are identical to a sequential run (only
    // wall-clock changes). Mirrors the orchestrator's parallel route crawling (D7.3).
    const rawConcurrency = parseInt(process.env.ARGUS_CONCURRENCY ?? '1', 10);
    const concurrency    = Math.min(10, Math.max(1, Number.isNaN(rawConcurrency) ? 1 : rawConcurrency));
    if (concurrency > 1) {
      console.log(`[argus] Parallel mode: concurrency=${concurrency} over ${normalizedAffected.length} route(s)`);
    }

    // Per-route timeout + retry (D4). Each route audit is bounded by ARGUS_ROUTE_TIMEOUT_MS
    // (default 120000 ms) and optionally retried ARGUS_ROUTE_RETRIES times. A timed-out audit
    // throws → it is recorded as a route ERROR below (ok:false), feeding the all-routes-failed
    // guard — a hung audit can never silently pass. The bound only ever BLOCKS, never PASSES.
    const { timeoutMs: routeTimeoutMs, retries: routeRetries } = routeResilienceFromEnv();
    if (routeTimeoutMs > 0 || routeRetries > 0) {
      console.log(`[argus] Per-route audit: timeout ${routeTimeoutMs > 0 ? `${routeTimeoutMs}ms` : 'off'}, ${routeRetries} retr${routeRetries === 1 ? 'y' : 'ies'}`);
    }

    const routeResults = await auditRoutesConcurrently(normalizedAffected, {
      concurrency,
      primaryClient: mcp,
      createClient:  createMcpClient,
      crawlRoute: async (route, client) => {
        const url = `${baseUrl}${route.path}`;
        console.log(`[argus] → Auditing ${url}`);
        try {
          const raw = await auditRouteWithRetry(
            () => crawlRouteWithDepth(route, baseUrl, client, depthAnalyzers),
            {
              timeoutMs: routeTimeoutMs,
              retries:   routeRetries,
              label:     `Route audit ${route.path}`,
              onRetry:   (attempt, err) =>
                console.log(`::warning::Route ${route.path} audit attempt ${attempt} failed (${String(err.message).replace(/\n/g, ' ')}) — retrying`),
            },
          );
          return { route, ok: true, raw };
        } catch (routeErr) {
          return { route, ok: false, error: routeErr.message };
        }
      },
    });

    // Aggregate the ordered results sequentially — bookkeeping + annotations stay deterministic and
    // identical to the prior sequential loop (results are in route order regardless of completion).
    for (const item of routeResults) {
      const route = item.route;
      const url   = `${baseUrl}${route.path}`;

      if (!item.ok) {
        console.error(`::warning::Audit failed for ${url}: ${item.error}`);
        perRoute.push({ route: route.path, critical: 0, warning: 0, info: 0, error: item.error });
        continue;
      }

      const findings = Array.isArray(item.raw.errors) ? item.raw.errors : [];
      allFindings.push(...findings);
      routeFindings.push({ path: route.path, findings });

      const critical = findings.filter(f => f.severity === 'critical').length;
      const warning  = findings.filter(f => f.severity === 'warning').length;
      const info     = findings.filter(f => f.severity === 'info').length;
      perRoute.push({ route: route.path, critical, warning, info });

      console.log(`[argus]   ${url}: ${critical} critical, ${warning} warning, ${info} info`);

      // Emit inline GitHub Actions annotations for visible CI feedback (Phase A3).
      // When a changed file SPECIFICALLY maps to this route and has a real added line in
      // its patch, the annotation is anchored at file=path,line=N so it renders inline on
      // the PR "Files changed" tab; otherwise it stays a route-level annotation. The line
      // is never fabricated — resolveAnnotationTarget returns null unless the line is a
      // genuine diff line (see pr-diff-analyzer.js).
      const annTarget = resolveAnnotationTarget(route.path, prFiles);
      const loc = annTarget ? ` file=${annTarget.path},line=${annTarget.line}` : '';
      // Aegis (Step 7): a GitHub Actions ::error/::warning annotation is rendered on the PR and
      // captured in the CI log (A4). scrubText the message so a secret/PII captured from the page
      // never lands in an annotation; the type + audit-target url stay (structural, non-secret).
      const annMsg = (m) => {
        const s = String(m ?? '');
        return (process.env.ARGUS_REDACT_SENSITIVE === '0' ? s : scrubText(s)).replace(/\n/g, ' ');
      };
      for (const f of findings.filter(g => g.severity === 'critical')) {
        console.log(`::error${loc}::${annMsg(f.message)} [${f.type}] on ${url}`);
      }
      for (const f of findings.filter(g => g.severity === 'warning')) {
        console.log(`::warning${loc}::${annMsg(f.message)} [${f.type}] on ${url}`);
      }
    }

    // Guard: if EVERY audited route errored, the app was unreachable after the preflight check
    // (e.g. the app died between check and crawl) or every audit timed out (D4). Throwing here
    // exits 1, which correctly blocks the merge — a hung/unreachable app never false-passes. The
    // decision lives in the exported allRoutesFailed() so it is unit- + mutation-testable.
    if (allRoutesFailed(perRoute)) {
      throw new Error(
        `All ${perRoute.length} route audit(s) failed — Chrome could not reach the app or every audit timed out. ` +
        `Ensure TARGET_DEV_URL is accessible throughout the job. ` +
        `First error: ${perRoute[0].error}`,
      );
    }

    // Step 6: Compute the aggregate (absolute) severity summary that feeds the block decision.
    // Built via the shared severityTally so the CLI and the MCP tool (handlePrValidate) construct
    // the decidePrBlock `summary` input IDENTICALLY — the two paths cannot diverge on the block
    // decision for the same findings (PR_VALIDATOR plan E4 — CLI↔MCP parity).
    const summary = severityTally(allFindings);

    // Step 6a: Baseline-aware merge-block decision (Phase B1). Diff the PR-head findings
    // against the stored base-branch baseline (restored via the actions/cache pattern, keyed
    // on GITHUB_BASE_REF) and gate on the findings this PR INTRODUCES. Fail safe: when no
    // baseline is resolvable the decision blocks on absolute counts (pre-B1 behaviour) and
    // the step summary says so — it never silently passes a broken app. The block-on matrix
    // (none|warning|critical) lives in the shared decidePrBlock, so the CLI and the MCP tool
    // (handlePrValidate) cannot diverge on the block semantics.
    const outputDir    = process.env.REPORT_OUTPUT_DIR || './reports';
    const baselineFile = resolvePrBaselineFile({ outputDir });
    const baseline     = baselineFile ? loadPrBaseline(baselineFile) : null;
    const decision     = decidePrBlock({ routeFindings, summary, blockOn, baseline });
    const blocked      = decision.blocked;

    // B2: tag each finding new-vs-persisting off the same baseline, so the PR comment surfaces
    // ONLY the findings this PR introduced (tags ride on the shared objects in result.findings).
    tagFindingNovelty(routeFindings, baseline);

    const baselineInfo = decision.baselineAvailable
      ? {
          available:   true,
          newCritical: decision.newSummary.critical,
          newWarning:  decision.newSummary.warning,
          newInfo:     decision.newSummary.info,
          persisting:  decision.persistingCount,
          resolved:    decision.resolvedCount,
        }
      : { available: false, note: decision.note };

    if (decision.baselineAvailable) {
      console.log(`[argus] Baseline diff (${baselineFile}): ${baselineInfo.newCritical} critical / ${baselineInfo.newWarning} warning new, ${baselineInfo.persisting} persisting, ${baselineInfo.resolved} resolved`);
    } else {
      console.log(`[argus] ${decision.note}`);
    }

    // Step 6b: Optionally update this branch's baseline (ARGUS_UPDATE_BASELINE). A base-branch
    // run uses this to populate the cache the PR runs diff against; default off → no write,
    // no behaviour change.
    if (/^(1|true|yes|on)$/i.test(process.env.ARGUS_UPDATE_BASELINE || '')) {
      try {
        const writeFile = resolvePrBaselineFile({ outputDir, baseRef: getCurrentBranch() });
        if (writeFile) {
          savePrBaseline(writeFile, routeFindings);
          console.log(`[argus] Baseline updated: ${writeFile}`);
        }
      } catch (baseErr) {
        console.error(`::warning::Argus baseline write failed: ${baseErr.message}`);
      }
    }

    // Step 7: Write GitHub Actions outputs and step summary
    writeGithubOutputs({ blocked, summary, affectedRoutes: normalizedAffected });
    writeStepSummary(buildStepSummary({ blocked, summary, affectedRoutes: normalizedAffected, perRoute, findings: allFindings, changedFiles: files, blockOn, baseline: baselineInfo }));

    // Step 8: Emit JSON result to stdout for downstream pipeline steps
    const result = {
      prUrl, targetUrl,
      affectedRoutes: normalizedAffected.map(r => r.path),
      changedFiles: files,
      findings: allFindings,
      perRoute,
      summary,
      blocked,
      blockOn,
      baseline: baselineInfo,
    };
    // Aegis (Step 7): the CLI prints this result to stdout, which lands in the GitHub Actions log
    // (world-readable for public repos, A4). Project the findings through redactForEgress for the
    // printed view (type/severity/route/scrubbed-message survive — the downstream contract holds);
    // reportPrValidation below receives the RAW `result` and redacts independently. Opt-out ⇒ raw.
    const printResult = process.env.ARGUS_REDACT_SENSITIVE === '0'
      ? result
      : { ...result, findings: redactForEgress(allFindings) };
    console.log(JSON.stringify(printResult, null, 2));

    // Step 9: Post/update the Argus PR comment + Check Run (Phase A). Idempotent — updates
    // the single marker-tagged comment in place; the Check Run conclusion maps to the block
    // decision. Reporting is best-effort: a missing token or a GitHub API failure must never
    // crash the run or change the merge decision (the exit code below is the real gate).
    try {
      const reported = await reportPrValidation(result, { prUrl });
      if (reported.posted) {
        console.log(`[argus] PR comment posted/updated.${reported.checked ? ' Check Run completed.' : ''}`);
      } else {
        console.log(`[argus] PR reporting skipped: ${reported.reason}`);
      }
    } catch (reportErr) {
      console.error(`::warning::Argus PR reporting failed: ${reportErr.message}`);
    }

    // The block decision → exit code (the merge gate) goes through the single prExitCode
    // mapping so the CLI and its tests can never disagree on what a decision exits with.
    const exitCode = prExitCode({ blocked });
    if (blocked) {
      // decision.reason is non-null when blocked and reflects NEW counts when a baseline was
      // available, ABSOLUTE counts otherwise (see decidePrBlock — "new" vs "total").
      console.error(`::error::Argus PR Validator: ${decision.reason}. Merge blocked (block-on=${blockOn}).`);
    } else {
      console.log(`[argus] ✓ Audit passed — ${summary.critical} critical, ${summary.warning} warning, ${summary.info} info.`);
    }
    process.exit(exitCode);

  } catch (err) {
    const summary = { critical: 0, warning: 0, info: 0 };
    console.error(`::error::Argus PR validation failed: ${err.message}`);
    writeGithubOutputs({ blocked: false, summary, affectedRoutes: [] });
    writeStepSummary(buildStepSummary({ blocked: false, summary, affectedRoutes: [], perRoute: [], findings: [], changedFiles, blockOn, error: err.message }));
    // A failed audit (all routes errored, or a startup/fetch error) is conservative: exit 1 =
    // merge blocked, never a false PASS. Routed through prExitCode for one exit-code source.
    process.exit(prExitCode({ failed: true }));

  } finally {
    if (mcp) {
      try { mcp.close(); } catch { /* ignore teardown errors */ }
    }
  }
}
