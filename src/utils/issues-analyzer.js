/**
 * ARGUS Chrome DevTools Issues Analyzer
 *
 * Queries the Chrome DevTools Issues panel via
 * list_console_messages({ types: ['issue'] }). The Issues panel is a
 * completely separate namespace from the console — it surfaces CORS
 * violations, CSP blocks, mixed content, cookie misconfiguration,
 * deprecated API use, and native low-contrast findings. None of these
 * appear in list_console_messages({ types: ['error'] }).
 *
 * Detections:
 *   cors_violation           — Cross-origin request blocked by CORS policy
 *   csp_violation            — Resource/script blocked by Content-Security-Policy
 *   mixed_content            — HTTP resource loaded on HTTPS page
 *   cookie_attribute_missing — SameSite or Secure attribute missing/incorrect
 *   deprecated_api_use       — Use of a deprecated browser API
 *   low_contrast_native      — Text with insufficient color contrast (native check)
 *   permission_policy_violation — Feature blocked by Permissions-Policy header
 *
 * Two surfaces:
 *   parseIssues(issues, url, isCritical) — pure function for use in crawlRouteCheap
 *     after the D5 baseline-slice has already been applied.
 *   analyzeIssues(browser, url, isCritical) — standalone navigator for direct harness use.
 */

import { normalizeArray } from './flow-runner.js';

// ── Issue classifiers ─────────────────────────────────────────────────────────

const CLASSIFIERS = [
  {
    type:             'cors_violation',
    issueTypePattern: /cors/i,
    textPattern:      /cors policy|cross.origin.*blocked|access.control.allow.origin/i,
    severity:         (isCritical) => isCritical ? 'critical' : 'warning',
  },
  {
    type:             'csp_violation',
    issueTypePattern: /ContentSecurityPolicy|content.security|csp/i,
    textPattern:      /content.security.policy|refused to (execute|load|apply|connect|frame)|violates.*csp/i,
    severity:         () => 'critical',
  },
  {
    type:             'mixed_content',
    issueTypePattern: /mixed.content/i,
    textPattern:      /mixed content|http resource.*https|loaded over https.*http/i,
    severity:         () => 'warning',
  },
  {
    type:             'cookie_attribute_missing',
    issueTypePattern: /cookie/i,
    textPattern:      /samesite|secure attribute|partitioned|cookie.*rejected|set-cookie.*blocked/i,
    severity:         () => 'warning',
  },
  {
    type:             'deprecated_api_use',
    issueTypePattern: /deprecat/i,
    textPattern:      /deprecated|will be removed|no longer supported|mutation.event|document\.domain/i,
    severity:         () => 'info',
  },
  {
    type:             'low_contrast_native',
    issueTypePattern: /contrast/i,
    textPattern:      /contrast ratio|insufficient.*contrast|contrast.*insufficient/i,
    severity:         () => 'warning',
  },
  {
    type:             'permission_policy_violation',
    issueTypePattern: /permission.policy|feature.policy/i,
    textPattern:      /permission.policy|feature policy|not allowed in this document/i,
    severity:         () => 'info',
  },
];

function classifyIssue(issue, url, isCritical) {
  const text = (issue.text ?? issue.message ?? issue.description ?? '').toString();
  // chrome-devtools-mcp may expose a structured type identifier
  const structuredType = (issue.issueType ?? issue.code ?? issue.kind ?? '').toString();
  // Skip only when both text AND structured type are absent — structured-type-only
  // issues (e.g. ContentSecurityPolicyIssue with no text body) must not be dropped.
  if (!text && !structuredType) return null;

  for (const c of CLASSIFIERS) {
    const matchesType = structuredType && c.issueTypePattern.test(structuredType);
    const matchesText = c.textPattern.test(text);
    if (matchesType || matchesText) {
      return {
        type:     c.type,
        message:  text.slice(0, 300),
        severity: c.severity(isCritical),
        url,
      };
    }
  }

  // Catch-all: emit unclassified issues so novel Chrome issue types are never silently dropped
  if (text) {
    return {
      type:     'unclassified_devtools_issue',
      message:  `Unclassified DevTools issue: ${text.slice(0, 200)}`,
      severity: 'info',
      url,
    };
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a pre-fetched, already-baseline-sliced issues array into findings.
 * Pure function — used by crawlRouteCheap after the D5 baseline-slice.
 *
 * @param {object[]} issues    - Issues from list_console_messages({ types: ['issue'] })
 * @param {string}   url       - Page URL (used as finding context)
 * @param {boolean}  isCritical
 * @returns {object[]}
 */
export function parseIssues(issues, url, isCritical = false) {
  const findings = [];
  for (const issue of issues) {
    const finding = classifyIssue(issue, url, isCritical);
    if (finding) findings.push(finding);
  }
  return findings.slice(0, 20);
}

/**
 * Standalone issues analyzer — navigates to a URL, baselines the current
 * Issues count, queries the panel after load, and returns findings.
 *
 * Used by the test harness and any standalone caller. Baselines before
 * navigation (D5 pattern) so pre-existing issues from prior pages are excluded.
 *
 * @param {object}  browser
 * @param {string}  url
 * @param {boolean} isCritical
 * @returns {Promise<object[]>}
 */
export async function analyzeIssues(browser, url, isCritical = false) {
  const findings = [];

  let baseline = 0;
  try {
    const priorRaw = await browser.listConsoleRaw({ types: ['issue'], includePreservedMessages: true });
    baseline = normalizeArray(priorRaw).length;
  } catch {
    // Issues API may not be available — baseline stays 0
  }

  try {
    await browser.navigate(url);
    await new Promise(r => setTimeout(r, 1000));
  } catch {
    return findings;
  }

  try {
    const raw    = await browser.listConsoleRaw({
      types: ['issue'],
      includePreservedMessages: true,
    });
    const issues = normalizeArray(raw).slice(baseline);
    findings.push(...parseIssues(issues, url, isCritical));
  } catch {
    // Issues API not available in this chrome-devtools-mcp build — silent skip
  }

  return findings;
}
