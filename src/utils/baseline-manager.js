/**
 * Argus v3 Phase B3 — Historical baselines + trend tracking
 * Phase D4 — Extended to cover flow findings (flow_assert_failed, flow_step_failed)
 * Phase D7.2 — Per-branch baselines (getCurrentBranch → <branch>.json / <branch>-trends.json)
 *
 * Baseline file (reports/baselines/<branch>.json): per-route + per-flow finding key arrays.
 * Trends file  (reports/baselines/<branch>-trends.json): append-only run history.
 *
 * Finding key: `type::message[:100]::status` — stable across runs, excludes timestamps.
 */

import fs            from 'fs';
import path          from 'path';
import { execSync }  from 'child_process';

function findingKey(finding) {
  const msg = (finding.message ?? '').slice(0, 100);
  const status = finding.status != null ? '::' + finding.status : '';
  return `${finding.type}::${msg}${status}`;
}

/**
 * Sanitize a git branch name into a safe filename segment.
 * Replaces any character that is not alphanumeric, dot, hyphen, or underscore with a hyphen.
 * Collapses consecutive hyphens and strips leading/trailing hyphens.
 */
function sanitizeBranch(branch) {
  return branch
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}

/**
 * Return the current git branch name as a sanitized filename segment.
 *
 * Resolution order:
 *   1. Read <cwd>/.git/HEAD directly (fast, no subprocess)
 *   2. Fall back to `git rev-parse --abbrev-ref HEAD`
 *   3. Fall back to `'default'` when not in a git repo or in detached HEAD state
 *
 * Examples: "main" → "main", "feature/my-feat" → "feature-my-feat"
 *
 * @returns {string}
 */
export function getCurrentBranch() {
  // Strategy 1: read .git/HEAD directly (no subprocess, works in any Node version)
  try {
    const headPath = path.resolve(process.cwd(), '.git', 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    if (match) return sanitizeBranch(match[1]);
    // Detached HEAD (contains a commit hash) — fall through to git command
  } catch { /* .git/HEAD not readable — fall through */ }

  // Strategy 2: git command
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).toString().trim();
    if (branch && branch !== 'HEAD') return sanitizeBranch(branch);
  } catch { /* not a git repo or git not installed — fall through */ }

  return 'default';
}

/**
 * Load baseline from disk. Returns null if file does not exist or cannot be parsed.
 * Route and flow keys are stored as Sets for O(1) lookup.
 * Old baselines (pre-D4) have no `flows` field — flows defaults to an empty Map.
 */
export function loadBaseline(baselineFile) {
  if (!fs.existsSync(baselineFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    const routes = new Map();
    for (const [url, keys] of Object.entries(raw.routes ?? {})) {
      routes.set(url, new Set(keys));
    }
    const flows = new Map();
    for (const [flowName, keys] of Object.entries(raw.flows ?? {})) {
      flows.set(flowName, new Set(keys));
    }
    const codebase = new Set(raw.codebase ?? []);
    return { savedAt: raw.savedAt, routes, flows, codebase };
  } catch {
    return null;
  }
}

/**
 * Persist current report as the new baseline.
 * Writes per-route and per-flow arrays of finding keys — timestamps are excluded.
 */
export function saveBaseline(baselineFile, report) {
  const dir = path.dirname(baselineFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const routes = {};
  for (const routeResult of report.routes) {
    routes[routeResult.url] = routeResult.errors.map(findingKey);
  }
  const flows = {};
  for (const flowResult of (report.flows ?? [])) {
    flows[flowResult.flowName] = flowResult.findings.map(findingKey);
  }
  const codebase = (report.codebase ?? []).map(findingKey);
  fs.writeFileSync(
    baselineFile,
    JSON.stringify({ savedAt: new Date().toISOString(), routes, flows, codebase }, null, 2),
  );
}

/**
 * Annotate each finding in the report with `isNew: boolean`.
 * Returns { isFirstRun, newCount, resolvedCount, flowNewCount, flowResolvedCount }.
 *
 * First run (baseline === null): all findings are new, resolved counts = 0.
 * Old baselines (pre-D4) have no `flows` map — flow findings are treated as new.
 */
export function applyBaseline(report, baseline) {
  if (!baseline) {
    for (const routeResult of report.routes) {
      for (const finding of routeResult.errors) {
        finding.isNew = true;
      }
    }
    for (const flowResult of (report.flows ?? [])) {
      for (const finding of flowResult.findings) {
        finding.isNew = true;
      }
    }
    const newCount     = report.routes.reduce((n, r) => n + r.errors.length, 0);
    const flowNewCount = (report.flows ?? []).reduce((n, f) => n + f.findings.length, 0);
    for (const finding of (report.codebase ?? [])) {
      finding.isNew = true;
    }
    return { isFirstRun: true, newCount, resolvedCount: 0, flowNewCount, flowResolvedCount: 0 };
  }

  let newCount = 0;
  let resolvedCount = 0;

  for (const routeResult of report.routes) {
    const baselineKeys = baseline.routes.get(routeResult.url) ?? new Set();
    const currentKeys = new Set();

    for (const finding of routeResult.errors) {
      const key = findingKey(finding);
      currentKeys.add(key);
      finding.isNew = !baselineKeys.has(key);
      if (finding.isNew) newCount++;
    }

    for (const key of baselineKeys) {
      if (!currentKeys.has(key)) resolvedCount++;
    }
  }

  let flowNewCount = 0;
  let flowResolvedCount = 0;
  const baselineFlows = baseline.flows ?? new Map();

  for (const flowResult of (report.flows ?? [])) {
    const baselineKeys = baselineFlows.get(flowResult.flowName) ?? new Set();
    const currentKeys = new Set();

    for (const finding of flowResult.findings) {
      const key = findingKey(finding);
      currentKeys.add(key);
      finding.isNew = !baselineKeys.has(key);
      if (finding.isNew) flowNewCount++;
    }

    for (const key of baselineKeys) {
      if (!currentKeys.has(key)) flowResolvedCount++;
    }
  }

  // C1 codebase findings — annotate isNew against saved codebase keys
  const baselineCodebase = baseline.codebase ?? new Set();
  const currentCodebaseKeys = new Set();
  for (const finding of (report.codebase ?? [])) {
    const key = findingKey(finding);
    currentCodebaseKeys.add(key);
    finding.isNew = !baselineCodebase.has(key);
  }

  return { isFirstRun: false, newCount, resolvedCount, flowNewCount, flowResolvedCount };
}

/**
 * Append one trend entry to the trends file (creates the file if absent).
 */
export function appendTrend(trendsFile, entry) {
  const dir = path.dirname(trendsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let trends = [];
  if (fs.existsSync(trendsFile)) {
    try { trends = JSON.parse(fs.readFileSync(trendsFile, 'utf8')); } catch {}
  }
  trends.push(entry);
  fs.writeFileSync(trendsFile, JSON.stringify(trends, null, 2));
}
