/**
 * Argus v3 Phase B3 — Historical baselines + trend tracking
 *
 * Baseline file (reports/baselines/baseline.json): per-route finding key arrays.
 * Trends file  (reports/baselines/trends.json):    append-only run history.
 *
 * Finding key: `type::message[:100]::status` — stable across runs, excludes timestamps.
 */

import fs from 'fs';
import path from 'path';

function findingKey(finding) {
  const msg = (finding.message ?? '').slice(0, 100);
  const status = finding.status != null ? '::' + finding.status : '';
  return `${finding.type}::${msg}${status}`;
}

/**
 * Load baseline from disk. Returns null if file does not exist or cannot be parsed.
 * Route keys are stored as Sets for O(1) lookup.
 */
export function loadBaseline(baselineFile) {
  if (!fs.existsSync(baselineFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    const routes = new Map();
    for (const [url, keys] of Object.entries(raw.routes ?? {})) {
      routes.set(url, new Set(keys));
    }
    return { savedAt: raw.savedAt, routes };
  } catch {
    return null;
  }
}

/**
 * Persist current report as the new baseline.
 * Writes per-route arrays of finding keys — timestamps are excluded.
 */
export function saveBaseline(baselineFile, report) {
  const dir = path.dirname(baselineFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const routes = {};
  for (const routeResult of report.routes) {
    routes[routeResult.url] = routeResult.errors.map(findingKey);
  }
  fs.writeFileSync(
    baselineFile,
    JSON.stringify({ savedAt: new Date().toISOString(), routes }, null, 2),
  );
}

/**
 * Annotate each finding in the report with `isNew: boolean`.
 * Returns { isFirstRun, newCount, resolvedCount }.
 *
 * First run (baseline === null): all findings are new, resolvedCount = 0.
 */
export function applyBaseline(report, baseline) {
  if (!baseline) {
    for (const routeResult of report.routes) {
      for (const finding of routeResult.errors) {
        finding.isNew = true;
      }
    }
    const newCount = report.routes.reduce((n, r) => n + r.errors.length, 0);
    return { isFirstRun: true, newCount, resolvedCount: 0 };
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

  return { isFirstRun: false, newCount, resolvedCount };
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
