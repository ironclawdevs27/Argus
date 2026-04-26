/**
 * Argus D7.5 — Severity policy overrides.
 * Post-processes all findings in a report before Slack routing and baseline
 * comparison, letting teams adjust or silence detection types without touching
 * analyzer code.
 *
 * Configure in src/config/targets.js:
 *   export const severityOverrides = {
 *     seo_missing_description: 'info',      // downgrade to info
 *     cache_headers_missing:   'suppress',  // remove entirely from report
 *   };
 *
 * Supported target values: 'critical' | 'warning' | 'info' | 'suppress'
 */

const VALID_SEVERITIES = new Set(['critical', 'warning', 'info']);

/**
 * Apply severity overrides to every finding in the report (mutates in-place).
 *
 * For each finding whose `type` key appears in severityOverrides:
 *   - If the override value is 'suppress'        → finding is removed from its array
 *   - If the override is a valid severity string  → finding.severity is replaced
 *   - If the override value is unrecognized       → finding is left unchanged
 *
 * After this call, report.routes[].errors and report.flows[].findings reflect
 * the overridden state. The caller is responsible for rebuilding report.summary.
 *
 * @param {object} report           - Report object (mutated in-place)
 * @param {object} severityOverrides - Map of finding type → target severity / 'suppress'
 * @returns {{ overriddenCount: number, suppressedCount: number }}
 */
export function applyOverrides(report, severityOverrides) {
  if (!severityOverrides || Object.keys(severityOverrides).length === 0) {
    return { overriddenCount: 0, suppressedCount: 0 };
  }

  let overriddenCount = 0;
  let suppressedCount = 0;

  function processFindings(findings) {
    const kept = [];
    for (const finding of findings) {
      const override = severityOverrides[finding.type];
      if (override === undefined) {
        kept.push(finding);
        continue;
      }
      if (override === 'suppress') {
        suppressedCount++;
        continue;
      }
      if (VALID_SEVERITIES.has(override)) {
        if (finding.severity !== override) {
          finding.severity = override;
          overriddenCount++;
        }
        kept.push(finding);
        continue;
      }
      // Unknown override value — leave finding unchanged
      kept.push(finding);
    }
    return kept;
  }

  for (const routeResult of report.routes) {
    routeResult.errors = processFindings(routeResult.errors);
  }
  for (const flowResult of (report.flows ?? [])) {
    flowResult.findings = processFindings(flowResult.findings);
  }
  if (report.codebase) {
    report.codebase = processFindings(report.codebase);
  }

  return { overriddenCount, suppressedCount };
}
