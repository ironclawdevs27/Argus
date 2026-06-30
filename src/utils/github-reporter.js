/**
 * Argus Phase C2: GitHub PR comment + commit status + Check Runs integration.
 *
 * C2.1  formatPrComment(report, diff)         — build Markdown PR comment body (pure)
 * C2.2  buildStatusPayload(report, diff)      — build GitHub commit status payload (pure)
 * C2.3  postPrComment(report, diff)           — create/update PR comment via GitHub API
 * C2.4  setCommitStatus(report, diff)         — set commit status (blocks merge on new criticals)
 * C2.5  isGitHubConfigured()                  — guard: true when GITHUB_TOKEN + GITHUB_REPOSITORY set
 * C2.6  reportToGitHub(report, diff)          — orchestrates C2.3 + C2.4 + C2.7
 * C2.7  createCheckRun(name, sha)             — create a GitHub Checks API run
 * C2.8  completeCheckRun(id, report, diff)    — update Check Run with conclusion + rich output
 * C2.9  generateReleaseNotes(cur, prev, opts) — pure: markdown changelog between two runs
 *
 * Required env vars:
 *   GITHUB_TOKEN        — personal access token or Actions GITHUB_TOKEN (required)
 *   GITHUB_REPOSITORY   — "owner/repo" (set automatically in GitHub Actions)
 *   GITHUB_SHA          — commit SHA for status checks (set automatically in GitHub Actions)
 *   GITHUB_PR_NUMBER    — PR number; set in workflow via:
 *                           env:
 *                             GITHUB_PR_NUMBER: ${{ github.event.pull_request.number }}
 *
 * Optional env vars:
 *   ARGUS_REPORT_URL          — URL to the full HTML report; linked in the commit status check
 *   ARGUS_CRITICAL_THRESHOLD  — number of new criticals before blocking merge (default: 1, set 0 to never block)
 *   ARGUS_DIFF_IMAGE_URL      — URL of visual diff image to embed in PR comment (set after uploading CI artifact)
 *   GITHUB_CHECK_NAME         — name of the Check Run (default: 'argus-qa')
 */

import { childLogger } from './logger.js';
import { parsePrUrl } from './pr-diff-analyzer.js';
import { githubFetch } from './github-api.js';
import { redactForEgress, redactReport, buildRedactionRider } from './sensitivity-classifier.js';

const logger = childLogger('github-reporter');

const COMMENT_MARKER = '<!-- argus-qa-report -->';
const GITHUB_API     = 'https://api.github.com';
const MAX_TABLE_ROWS = 15;  // cap table rows to stay within GitHub's 65536-char limit

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEV_ICON = { critical: '🔴', warning: '🟡', info: '🔵' };
function sevIcon(sev) { return SEV_ICON[sev] ?? '⚪'; }

/** Escape pipe characters so they don't break Markdown tables. */
function mdCell(text, maxLen = 100) {
  return String(text ?? '').slice(0, maxLen).replace(/\|/g, '\\|').replace(/\n/g, ' '); // lgtm[js/incomplete-string-escaping] — escaping pipe and newline is correct and sufficient for GitHub Markdown table cells
}

/**
 * Build the PR-Validator banner lines (block verdict + reason + affected routes).
 * Rendered at the top of the comment only when report.prValidation is present, so
 * existing runCrawl()-sourced reports are unaffected.
 */
function prValidationBanner(pv) {
  const bl = pv.baseline;
  const baselineAware = !!(bl && bl.available);
  const lines = [
    pv.blocked
      ? `> 🔴 **Merge blocked** — ${pv.reason} (block-on: \`${pv.blockOn}\`)`
      : baselineAware
        ? `> ✅ **Merge allowed** — this PR introduces no findings at or above the \`${pv.blockOn}\` threshold`
        : `> ✅ **Merge allowed** — no findings at or above the \`${pv.blockOn}\` threshold`,
  ];
  // Baseline-aware surfacing (Phase B2): what this PR INTRODUCES vs what already existed on the
  // affected routes, so a reviewer sees why the merge was (or wasn't) blocked. When no per-branch
  // baseline was available the decision fell back to absolute counts — say so, never silently.
  if (baselineAware) {
    lines.push(
      '',
      'Blocking on findings this PR **introduces** (vs the base-branch baseline):  ',
      `🔴 ${bl.newCritical} new critical · 🟡 ${bl.newWarning} new warning · 🔵 ${bl.newInfo} new info · ${bl.persisting} persisting · ${bl.resolved} resolved  `,
    );
  } else if (bl && bl.available === false) {
    lines.push('', `> ⚠️ ${bl.note ?? 'Baseline unavailable — blocking on absolute finding counts.'}  `);
  }
  if (Array.isArray(pv.affectedRoutes) && pv.affectedRoutes.length > 0) {
    const shown = pv.affectedRoutes.slice(0, 20).map(r => `\`${r}\``).join(', ');
    const extra = pv.affectedRoutes.length > 20 ? ` _(+${pv.affectedRoutes.length - 20} more)_` : '';
    lines.push('', `**Affected routes** (${pv.affectedRoutes.length}): ${shown}${extra}  `);
  }
  if (typeof pv.changedFileCount === 'number') {
    lines.push(`**Files changed**: ${pv.changedFileCount}  `);
  }
  lines.push('');
  return lines;
}

// ── C2.1: PR comment formatter (pure — no I/O) ───────────────────────────────

/**
 * Build the full Markdown body for a PR comment.
 * Embed COMMENT_MARKER so future runs can find and update the same comment.
 *
 * @param {object} report  - runCrawl() report object
 * @param {object|null} diff - applyBaseline() diff result (null = first run)
 * @returns {string} Markdown comment body
 */
export function formatPrComment(report, diff) {
  const { baseUrl, summary, routes = [], codebase = [], flows = [] } = report;
  const runDate  = new Date(report.generatedAt).toUTCString();
  const isFirst  = !diff || diff.isFirstRun;

  // Collect new findings from all sources, tagging each with a display source label
  const allNewFindings = [
    ...routes.flatMap(r =>
      r.errors
        .filter(e => e.isNew !== false)
        .map(e => ({ ...e, _source: r.route }))
    ),
    ...(codebase)
      .filter(f => f.isNew !== false)
      .map(f => ({ ...f, _source: 'Codebase (C1)' })),
    ...flows.flatMap(f =>
      (f.findings ?? [])
        .filter(e => e.isNew !== false)
        .map(e => ({ ...e, _source: `Flow: ${f.flowName}` }))
    ),
  ];

  const newCriticals = allNewFindings.filter(f => f.severity === 'critical').length;
  const newWarnings  = allNewFindings.filter(f => f.severity === 'warning').length;
  const newInfos     = allNewFindings.filter(f => f.severity === 'info').length;
  // Sum route + flow resolved findings for the display count
  const resolvedCount = (diff?.resolvedCount ?? 0) + (diff?.flowResolvedCount ?? 0);

  const lines = [
    COMMENT_MARKER,
    '## 🔍 Argus QA Report',
    '',
    `**Base URL**: ${baseUrl}  `,
    `**Run time**: ${runDate}  `,
    '',
    // Aegis (Step 6): when findings were redacted at the egress boundary, say so — the
    // reader sees titles/types, never the raw exploit detail. Additive + gated, so a report
    // that carries no `redaction` rider (every pre-Aegis caller / opt-out) renders unchanged.
    ...(report.redaction && report.redaction.redacted > 0
      ? [`> 🔒 ${report.redaction.redacted} finding(s) redacted at the boundary — full detail in the local report`, '']
      : []),
    ...(report.prValidation ? prValidationBanner(report.prValidation) : []),
    '| | 🔴 Critical | 🟡 Warning | 🔵 Info | Total |',
    '|---|---|---|---|---|',
    `| **Total** | ${summary.critical} | ${summary.warning} | ${summary.info} | ${summary.total} |`,
  ];

  if (isFirst) {
    lines.push('| **New** | _first run_ | _first run_ | _first run_ | _baseline established_ |');
  } else {
    lines.push(`| **New** | ${newCriticals} | ${newWarnings} | ${newInfos} | ${allNewFindings.length} |`);
    lines.push(`| **Resolved** | — | — | — | ${resolvedCount} |`);
  }

  // ── New findings table — skipped on first run (all findings would be "new") ──
  if (allNewFindings.length > 0 && !isFirst) {
    // Check if any finding has a selector (DOM-linked findings) for the extra column
    const hasSelectors = allNewFindings.some(f => f.selector);
    lines.push('', `### 🆕 New Findings (${allNewFindings.length})`);
    if (hasSelectors) {
      lines.push('| Severity | Source | Type | Selector | Details |');
      lines.push('|---|---|---|---|---|');
      for (const f of allNewFindings.slice(0, MAX_TABLE_ROWS)) {
        const sel = f.selector ? `\`${mdCell(f.selector, 60)}\`` : '—';
        lines.push(`| ${sevIcon(f.severity)} ${f.severity} | ${f._source} | \`${f.type}\` | ${sel} | ${mdCell(f.message)} |`);
      }
    } else {
      lines.push('| Severity | Source | Type | Details |');
      lines.push('|---|---|---|---|');
      for (const f of allNewFindings.slice(0, MAX_TABLE_ROWS)) {
        lines.push(`| ${sevIcon(f.severity)} ${f.severity} | ${f._source} | \`${f.type}\` | ${mdCell(f.message)} |`);
      }
    }
    if (allNewFindings.length > MAX_TABLE_ROWS) {
      lines.push(`| … | … | … | _${allNewFindings.length - MAX_TABLE_ROWS} more — see full report_ |`);
    }
  }

  // ── Visual regression section ──────────────────────────────────────────────
  const visualRegressions = routes.flatMap(r =>
    (r.errors ?? []).filter(e => e.type === 'visual_regression')
  );
  if (visualRegressions.length > 0) {
    lines.push('', '### 🖼️ Visual Regressions');
    lines.push('| Route | Diff % | Severity |');
    lines.push('|---|---|---|');
    for (const f of visualRegressions.slice(0, 10)) {
      const pct = typeof f.diffPercent === 'number' ? `${f.diffPercent.toFixed(2)}%` : '—';
      lines.push(`| ${f.url ?? '—'} | ${pct} | ${sevIcon(f.severity)} ${f.severity} |`);
    }
    const diffImageUrl = process.env.ARGUS_DIFF_IMAGE_URL;
    if (diffImageUrl) {
      lines.push('', `**Pixel diff:**`, `![Visual diff](${diffImageUrl})`);
    }
  }

  // ── Resolved note ──
  if (!isFirst && resolvedCount > 0) {
    lines.push('', `### ✅ Resolved (${resolvedCount})`);
    lines.push(`${resolvedCount} finding(s) resolved since last baseline.`);
  }

  // ── C1 codebase findings (all, flagged new where applicable) ──
  if (codebase.length > 0) {
    lines.push('', `### 📦 Codebase Analysis — ${codebase.length} finding(s)`);
    lines.push('| Severity | Type | Details |');
    lines.push('|---|---|---|');
    for (const f of codebase.slice(0, MAX_TABLE_ROWS)) {
      const newTag = f.isNew !== false ? ' _(new)_' : '';
      lines.push(`| ${sevIcon(f.severity)} | \`${f.type}\` | ${mdCell(f.message)}${newTag} |`);
    }
    if (codebase.length > MAX_TABLE_ROWS) {
      lines.push(`| … | … | _${codebase.length - MAX_TABLE_ROWS} more_ |`);
    }
  }

  // ── Screenshot note ──
  const screenshotCount = routes.filter(r => r.screenshot).length;
  if (screenshotCount > 0) {
    lines.push('', `> 📸 ${screenshotCount} route screenshot(s) available in CI artifacts.`);
  }

  lines.push('', '---');
  lines.push(`_Generated by [Argus](https://github.com/ironclawdevs27/Argus) · ${new Date(report.generatedAt).toISOString()}_`);

  return lines.join('\n');
}

// ── C2.2: Commit status payload builder (pure — no I/O) ──────────────────────

/**
 * Build the payload for the GitHub commit status API.
 * State is 'failure' when any new critical findings exist (blocks PR merge).
 * Pure function — reads no env vars; callers attach target_url if desired.
 *
 * @param {object} report
 * @param {object|null} diff
 * @returns {{ state: string, description: string, context: string }}
 */
export function buildStatusPayload(report, diff) {
  const newCriticals = [
    ...(report.routes ?? []).flatMap(r =>
      (r.errors ?? []).filter(e => e.severity === 'critical' && e.isNew !== false)
    ),
    ...(report.codebase ?? []).filter(f => f.severity === 'critical' && f.isNew !== false),
    ...(report.flows ?? []).flatMap(f =>
      (f.findings ?? []).filter(e => e.severity === 'critical' && e.isNew !== false)
    ),
  ].length;

  // ARGUS_CRITICAL_THRESHOLD: number of new criticals before blocking (default: 1).
  // Set to 0 to never block merge; set to N to block only when N+ criticals found.
  const threshold = parseInt(process.env.ARGUS_CRITICAL_THRESHOLD ?? '1', 10);
  const passing   = Number.isFinite(threshold) && threshold > 0
    ? newCriticals < threshold
    : true;  // threshold=0 → never block

  return {
    state:            passing ? 'success' : 'failure',
    description:      passing
      ? `Argus: All checks passed (${report.summary.total} total finding(s))`
      : `Argus: ${newCriticals} new critical issue(s) — merge blocked (threshold: ${threshold})`,
    context:          process.env.GITHUB_CHECK_NAME ?? 'argus-qa',
    newCriticalCount: newCriticals,
    threshold,
  };
}

// ── GitHub API helper ─────────────────────────────────────────────────────────

async function ghFetch(urlPath, method, body) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is not set — GitHub reporting is disabled');
  }
  const headers = {
    'Authorization':        `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';

  // E2: shared resilient client — retries a rate-limit (403 primary / 429 secondary)
  // + transient 5xx + network error with backoff (Retry-After / X-RateLimit-Reset
  // aware), throws a structured, secret-free error on 401/404/422/plain-403. The token
  // rides only in the request headers above, never in any thrown message.
  const res = await githubFetch(`${GITHUB_API}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    context: `${method} ${urlPath}`,
  });
  return res.json();
}

// ── C2.3: Post or update PR comment ──────────────────────────────────────────

/**
 * Create a PR comment, or update the existing Argus comment if one is already present.
 * Idempotent: re-running on the same PR updates in-place rather than spamming new comments.
 */
export async function postPrComment(report, diff, opts = {}) {
  const repo  = opts.repo     ?? process.env.GITHUB_REPOSITORY;
  const prNum = opts.prNumber ?? process.env.GITHUB_PR_NUMBER;
  if (!repo || !prNum) throw new Error('[ARGUS] C2: GITHUB_REPOSITORY or GITHUB_PR_NUMBER not set');

  let body = formatPrComment(report, diff);

  // GitHub hard limit is 65536 chars; truncate gracefully if exceeded.
  const GITHUB_COMMENT_LIMIT = 65000;
  if (body.length > GITHUB_COMMENT_LIMIT) {
    const truncMsg = '\n\n_⚠️ Report truncated — full details in the saved JSON report._';
    body = body.slice(0, GITHUB_COMMENT_LIMIT - truncMsg.length) + truncMsg;
  }

  // Find existing Argus comment to update
  const existing = await ghFetch(`/repos/${repo}/issues/${prNum}/comments?per_page=100`, 'GET');
  const prev = Array.isArray(existing)
    ? existing.find(c => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER))
    : null;

  if (prev) {
    await ghFetch(`/repos/${repo}/issues/comments/${prev.id}`, 'PATCH', { body });
    logger.info(`[ARGUS] C2: Updated PR #${prNum} comment (id: ${prev.id})`);
  } else {
    await ghFetch(`/repos/${repo}/issues/${prNum}/comments`, 'POST', { body });
    logger.info(`[ARGUS] C2: Posted new comment on PR #${prNum}`);
  }
}

// ── C2.4: Set commit status ───────────────────────────────────────────────────

/**
 * Set a GitHub commit status on GITHUB_SHA.
 * 'failure' state prevents merge when required status checks are enforced.
 */
export async function setCommitStatus(report, diff) {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha  = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error('[ARGUS] C2: GITHUB_REPOSITORY or GITHUB_SHA not set');

  const payload = buildStatusPayload(report, diff);
  // ARGUS_REPORT_URL is I/O-dependent — attached here, not in the pure builder
  if (process.env.ARGUS_REPORT_URL) {
    payload.target_url = process.env.ARGUS_REPORT_URL;
  }
  await ghFetch(`/repos/${repo}/statuses/${sha}`, 'POST', payload);
  logger.info(`[ARGUS] C2: Commit status → ${payload.state} (${payload.description})`);
}

// ── C2.7: Create GitHub Check Run ────────────────────────────────────────────

/**
 * Create a new GitHub Check Run in 'in_progress' state.
 * Returns the check run id used by completeCheckRun().
 * Requires GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA.
 *
 * @param {string} [name]   - Check run name (default: GITHUB_CHECK_NAME ?? 'argus-qa')
 * @param {string} [sha]    - Commit SHA (default: GITHUB_SHA env var)
 * @param {object} [opts]
 * @param {string} [opts.repo] - "owner/repo" override (default: GITHUB_REPOSITORY env var).
 *                               Lets callers that resolved the repo from a PR URL (the PR
 *                               Validator) drive the Check Run without relying on env.
 * @returns {Promise<number>} check run id
 */
export async function createCheckRun(name, sha, opts = {}) {
  const repo    = opts.repo ?? process.env.GITHUB_REPOSITORY;
  const headSha = sha ?? process.env.GITHUB_SHA;
  if (!repo || !headSha) throw new Error('[ARGUS] C2: GITHUB_REPOSITORY or GITHUB_SHA not set');

  const checkName = name ?? process.env.GITHUB_CHECK_NAME ?? 'argus-qa';
  const data = await ghFetch(`/repos/${repo}/check-runs`, 'POST', {
    name:       checkName,
    head_sha:   headSha,
    status:     'in_progress',
    started_at: new Date().toISOString(),
  });
  logger.info(`[ARGUS] C2: Check run created (id: ${data.id}, name: ${checkName})`);
  return data.id;
}

// ── C2.8: Complete GitHub Check Run with rich output ─────────────────────────

/**
 * Update an existing Check Run to 'completed' with a conclusion and rich output.
 *
 * Output includes:
 * - summary: one-line result (pass/fail + finding counts)
 * - text:    full findings table in Markdown (same data as PR comment, without COMMENT_MARKER)
 *
 * @param {number} checkRunId - id from createCheckRun()
 * @param {object} report     - runCrawl() report
 * @param {object|null} diff  - baseline diff (null = first run)
 * @param {object} [opts]
 * @param {string} [opts.repo] - "owner/repo" override (default: GITHUB_REPOSITORY env var)
 */
export async function completeCheckRun(checkRunId, report, diff, opts = {}) {
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('[ARGUS] C2: GITHUB_REPOSITORY not set');

  // The conclusion must reflect the merge gate. For a PR-Validator report the authoritative
  // gate is the block-on decision (report.prValidation.blocked), NOT buildStatusPayload's
  // new-criticals-vs-ARGUS_CRITICAL_THRESHOLD rule — the two diverge (e.g. block-on=warning
  // with 0 criticals blocks the merge but has 0 new criticals). runCrawl reports carry no
  // prValidation field, so they keep the existing threshold-based conclusion.
  let conclusion, title;
  const pv = report.prValidation;
  if (pv) {
    conclusion = pv.blocked ? 'failure' : 'success';
    title      = pv.blocked
      ? `Argus: merge blocked — ${pv.reason}`
      : `Argus: merge allowed — no findings at or above block-on=${pv.blockOn}`;
  } else {
    const status = buildStatusPayload(report, diff);
    conclusion   = status.state === 'success' ? 'success' : 'failure';
    title        = status.description;
  }

  // Build rich text output (full findings table, without the COMMENT_MARKER sentinel)
  const fullBody = formatPrComment(report, diff);
  const richText = fullBody
    .replace(COMMENT_MARKER + '\n', '')   // strip the HTML sentinel
    .slice(0, 65000);                     // GitHub Check output text limit

  await ghFetch(`/repos/${repo}/check-runs/${checkRunId}`, 'PATCH', {
    status:       'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title:   title.slice(0, 255),       // GitHub Check output.title limit
      summary: title,
      text:    richText,
    },
  });
  logger.info(`[ARGUS] C2: Check run ${checkRunId} completed (${conclusion})`);
}

// ── C2.9: Release notes generator (pure) ─────────────────────────────────────

/**
 * Generate a Markdown release notes / changelog from two Argus reports.
 * Pure function — no I/O.
 *
 * @param {object} currentReport  - report from the current run
 * @param {object} prevReport     - report from the previous/baseline run
 * @param {object} [opts]
 * @param {string} [opts.fromTag] - git tag for the previous run (e.g. 'v1.2.0')
 * @param {string} [opts.toTag]   - git tag for the current run (e.g. 'v1.3.0')
 * @returns {string} Markdown release notes
 */
export function generateReleaseNotes(currentReport, prevReport, opts = {}) {
  const { fromTag, toTag } = opts;
  const heading = toTag
    ? `## 🚀 Argus Release Notes — ${toTag}` + (fromTag ? ` _(since ${fromTag})_` : '')
    : '## 🚀 Argus Release Notes';

  // Collect all findings from both reports as flat arrays
  function allFindings(report) {
    return [
      ...(report.routes ?? []).flatMap(r => (r.errors ?? []).map(e => ({ ...e, _source: r.route }))),
      ...(report.codebase ?? []).map(f => ({ ...f, _source: 'codebase' })),
      ...(report.flows ?? []).flatMap(f => (f.findings ?? []).map(e => ({ ...e, _source: `flow:${f.flowName}` }))),
    ];
  }

  const curFindings  = allFindings(currentReport);
  const prevFindings = allFindings(prevReport);

  // Key each finding for comparison: type + source + message prefix
  function findingKey(f) { return `${f.type}::${f._source}::${String(f.message ?? '').slice(0, 80)}`; }
  const prevKeys = new Set(prevFindings.map(findingKey));
  const curKeys  = new Set(curFindings.map(findingKey));

  const fixed   = prevFindings.filter(f => !curKeys.has(findingKey(f)));
  const newOnes = curFindings.filter(f => !prevKeys.has(findingKey(f)));

  const lines = [heading, ''];

  if (newOnes.length === 0 && fixed.length === 0) {
    lines.push('_No changes detected since last run._');
  } else {
    lines.push(`**Run date**: ${new Date(currentReport.generatedAt ?? Date.now()).toUTCString()}  `);
    lines.push(`**Total findings**: ${currentReport.summary?.total ?? 0} (was ${prevReport.summary?.total ?? 0})  `);
    lines.push('');

    if (newOnes.length > 0) {
      const crits = newOnes.filter(f => f.severity === 'critical').length;
      lines.push(`### 🆕 New Issues (${newOnes.length})`);
      if (crits > 0) lines.push(`> ⚠️ ${crits} new critical issue(s) require attention`);
      lines.push('');
      lines.push('| Severity | Source | Type | Details |');
      lines.push('|---|---|---|---|');
      for (const f of newOnes.slice(0, MAX_TABLE_ROWS)) {
        lines.push(`| ${sevIcon(f.severity)} ${f.severity} | ${f._source} | \`${f.type}\` | ${mdCell(f.message)} |`);
      }
      if (newOnes.length > MAX_TABLE_ROWS) {
        lines.push(`| … | … | … | _${newOnes.length - MAX_TABLE_ROWS} more_ |`);
      }
      lines.push('');
    }

    if (fixed.length > 0) {
      lines.push(`### ✅ Resolved Issues (${fixed.length})`);
      lines.push('');
      lines.push('| Severity | Source | Type | Details |');
      lines.push('|---|---|---|---|');
      for (const f of fixed.slice(0, MAX_TABLE_ROWS)) {
        lines.push(`| ${sevIcon(f.severity)} ${f.severity} | ${f._source} | \`${f.type}\` | ${mdCell(f.message)} |`);
      }
      if (fixed.length > MAX_TABLE_ROWS) {
        lines.push(`| … | … | … | _${fixed.length - MAX_TABLE_ROWS} more_ |`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`_Generated by [Argus](https://github.com/ironclawdevs27/Argus)_`);
  return lines.join('\n');
}

// ── C2.5: Configuration guard ─────────────────────────────────────────────────

export function isGitHubConfigured() {
  return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);
}

// ── C2.6: Orchestrator ────────────────────────────────────────────────────────

/**
 * Run both PR comment and commit status updates in parallel.
 * Each operation is independent — a failure in one doesn't block the other.
 */
export async function reportToGitHub(report, diff) {
  const tasks = [];

  // Aegis egress guard (Step 6): GitHub (PR comment, Check Run, commit status) is a
  // third-party sink read by anyone with repo access (A2). Project the WHOLE report once
  // through redactReport — every finding array reduced to the deny-by-default allowlist, a
  // `redaction` rider attached (drives the comment's 🔒 notice), metadata + severity counts
  // preserved (so buildStatusPayload's merge gate is unchanged). The findings are already
  // step-3c-tagged in the runCrawl path, so redactReport honours each finding's `sensitive`
  // flag + the report-level `_aegisFailClosed`. ARGUS_REDACT_SENSITIVE=0 ⇒ raw passthrough.
  const guarded = process.env.ARGUS_REDACT_SENSITIVE === '0'
    ? report
    : redactReport(report, { localReportPath: process.env.ARGUS_REPORT_URL || null });

  if (process.env.GITHUB_PR_NUMBER) {
    tasks.push(
      postPrComment(guarded, diff).catch(err =>
        logger.warn(`[ARGUS] C2: PR comment failed — ${err.message}`)
      )
    );
  }

  if (process.env.GITHUB_SHA) {
    // Commit status (fast, minimal)
    tasks.push(
      setCommitStatus(guarded, diff).catch(err =>
        logger.warn(`[ARGUS] C2: Commit status failed — ${err.message}`)
      )
    );

    // Check Run (rich output — created and completed in sequence)
    tasks.push(
      createCheckRun(undefined, process.env.GITHUB_SHA)
        .then(id => completeCheckRun(id, guarded, diff))
        .catch(err =>
          logger.warn(`[ARGUS] C2: Check run failed — ${err.message}`)
        )
    );
  }

  if (tasks.length === 0) {
    logger.info('[ARGUS] C2: No GITHUB_PR_NUMBER or GITHUB_SHA — skipping GitHub reporting');
    return;
  }

  await Promise.all(tasks);
}

// ── PR Validator reporting (Phase A) ──────────────────────────────────────────

/**
 * Adapt a PR-Validator result (the src/cli/pr-validate.js + argus_pr_validate response
 * shape) into the `report` object that formatPrComment / buildStatusPayload consume.
 * Pure — no I/O.
 *
 * The PR Validator has no per-run baseline yet (Phase B introduces head-vs-base
 * diffing), so every finding on an affected route is surfaced as-is; callers pair this
 * with a NON-first `diff` (see reportPrValidation) so formatPrComment renders the
 * findings table rather than treating the run as a baseline-establishing first run.
 *
 * @param {object} result
 * @param {string} [result.targetUrl]
 * @param {{ critical: number, warning: number, info: number }} [result.summary]
 * @param {Array<{ severity: string, type: string, message: string, url: string }>} [result.findings]
 * @param {string[]} [result.affectedRoutes]
 * @param {string[]} [result.changedFiles]
 * @param {boolean} [result.blocked]
 * @param {string}  [result.blockOn]
 * @returns {object} report consumable by formatPrComment
 */
export function prResultToReport(result = {}) {
  const {
    targetUrl,
    summary = { critical: 0, warning: 0, info: 0 },
    findings = [],
    affectedRoutes = [],
    changedFiles = [],
    blocked = false,
    blockOn = 'critical',
    baseline,   // B2: { available, newCritical, newWarning, newInfo, persisting, resolved } | { available:false, note }
  } = result;

  const base = String(targetUrl ?? '').replace(/\/$/, '');

  // Group findings by their route path (derived from each finding's url), so the
  // comment's findings table is sourced per-route — formatPrComment uses
  // report.routes[].route as the display source label for each finding.
  const byRoute = new Map();
  for (const f of findings) {
    const url = String(f.url ?? '');
    let label = url || '(unknown route)';
    if (base && url.startsWith(base)) label = url.slice(base.length) || '/';
    if (!byRoute.has(label)) byRoute.set(label, []);
    byRoute.get(label).push(f);
  }
  const routes = [...byRoute.entries()].map(([route, errors]) => ({
    route, errors, screenshot: null,
  }));

  const crit  = summary.critical ?? 0;
  const warn  = summary.warning  ?? 0;
  const info  = summary.info     ?? 0;

  // The block reason must reflect what the decision actually counted, so the banner reconciles
  // with `blocked` (Phase B2): the NEW (PR-introduced) counts when a baseline was available, the
  // absolute counts otherwise. The scope word ("new"/"total") matches decidePrBlock's phrasing;
  // it is omitted entirely for legacy callers that pass no baseline field (back-compat).
  const blPresent = !!(baseline && typeof baseline === 'object');
  const blAvail   = !!(blPresent && baseline.available);
  const rCrit = blAvail ? (baseline.newCritical ?? 0) : crit;
  const rWarn = blAvail ? (baseline.newWarning  ?? 0) : warn;
  const scope = !blPresent ? '' : blAvail ? 'new ' : 'total ';
  const reason = !blocked ? null
    : blockOn === 'warning'
      ? `${rCrit} critical + ${rWarn} warning ${scope}finding(s) at or above the block threshold`
      : `${rCrit} critical ${scope}finding(s) found`;

  return {
    baseUrl: base || String(targetUrl ?? ''),
    generatedAt: new Date().toISOString(),
    summary: { critical: crit, warning: warn, info, total: crit + warn + info },
    routes,
    codebase: [],
    flows: [],
    prValidation: {
      blocked,
      blockOn,
      reason,
      affectedRoutes: affectedRoutes
        .map(r => (typeof r === 'string' ? r : r?.path))
        .filter(Boolean),
      changedFileCount: Array.isArray(changedFiles) ? changedFiles.length : 0,
      baseline: baseline ?? null,
    },
  };
}

/**
 * Post (or idempotently update) the single Argus PR comment for a PR-Validator run.
 *
 * Gated on GITHUB_TOKEN plus a resolvable owner/repo + PR number — taken from the
 * GITHUB_REPOSITORY / GITHUB_PR_NUMBER env vars (set by the GitHub runner) or, failing
 * that, parsed from the PR URL. A missing token or unresolvable PR context SKIPS
 * reporting (returns a status) rather than throwing: a reporting misconfiguration must
 * never crash or block the validation step. The GitHub token is never echoed into the
 * return value, logs, or thrown errors (it rides only in the Authorization header).
 *
 * Idempotent: postPrComment finds the existing Argus comment by its HTML marker and
 * PATCHes it in place, so re-running on the same PR updates rather than duplicates.
 *
 * In addition to the comment (A1), a GitHub Check Run is created + completed (A2) when a
 * PR head SHA is resolvable (ARGUS_PR_HEAD_SHA — set by action.yml to
 * github.event.pull_request.head.sha — or GITHUB_SHA). Its conclusion maps to the block
 * decision (failure iff blocked). The Check Run is best-effort and isolated: a failure
 * there never discards an already-posted comment and never changes the merge decision.
 *
 * @param {object} result        - PR-validate result (see prResultToReport)
 * @param {object} [opts]
 * @param {string} [opts.prUrl]  - PR URL used to derive owner/repo/prNumber when env vars are absent
 * @returns {Promise<{ posted: boolean, checked: boolean, skipped: boolean, reason?: string }>}
 */
export async function reportPrValidation(result, { prUrl } = {}) {
  if (!process.env.GITHUB_TOKEN) {
    return { posted: false, checked: false, skipped: true, reason: 'GITHUB_TOKEN not set — PR reporting skipped' };
  }

  let repo     = process.env.GITHUB_REPOSITORY;
  let prNumber = process.env.GITHUB_PR_NUMBER;
  const url    = prUrl ?? result?.prUrl;
  if ((!repo || !prNumber) && url) {
    try {
      const { owner, repo: r, prNumber: n } = parsePrUrl(url);
      repo     = repo     || `${owner}/${r}`;
      prNumber = prNumber || n;
    } catch { /* unparseable URL — fall through to the skip below */ }
  }
  if (!repo || !prNumber) {
    return { posted: false, checked: false, skipped: true, reason: 'no resolvable repo / PR number — PR reporting skipped' };
  }

  // Aegis egress guard (Step 6): the PR-Validator path reaches here with RAW findings (it does
  // not run report-processor step 3c). Project them through redactForEgress BEFORE prResultToReport
  // builds the comment, so the posted PR comment / Check Run carry titles + scrubbed messages, never
  // exploit detail (A1/A2). The block decision was already computed upstream on the RAW findings.
  // Attach a `redaction` rider so formatPrComment renders the 🔒 notice. Opt-out ⇒ raw passthrough.
  const guardedResult = process.env.ARGUS_REDACT_SENSITIVE === '0'
    ? result
    : { ...result, findings: redactForEgress(result?.findings ?? []) };
  const report = prResultToReport(guardedResult);
  if (process.env.ARGUS_REDACT_SENSITIVE !== '0') {
    report.redaction = buildRedactionRider(result?.findings ?? [], { localReportPath: null });
  }
  // Non-first diff so findings render (not treated as a baseline-establishing first run). The
  // new/persisting split rides on each finding's `isNew` tag (set in the PR-validate paths via
  // tagFindingNovelty); `resolvedCount` comes from the head-vs-base diff (Phase B2) so the
  // comment's Resolved row reconciles with the block decision. 0 when no baseline was available.
  const diff = {
    isFirstRun: false,
    resolvedCount: (result && result.baseline && result.baseline.available) ? (result.baseline.resolved ?? 0) : 0,
    flowResolvedCount: 0,
  };

  // A1 — idempotent PR comment (the primary visible surface). A failure here propagates to
  // the caller, which logs a ::warning:: and leaves the already-computed merge decision intact.
  await postPrComment(report, diff, { repo, prNumber });

  // A2 — Check Run whose conclusion maps to the block decision. Gated on a resolvable PR
  // head SHA; isolated so a Check Run failure can't discard the posted comment.
  let checked = false;
  let checkError;
  const headSha = process.env.ARGUS_PR_HEAD_SHA || process.env.GITHUB_SHA;
  if (headSha) {
    try {
      const checkId = await createCheckRun(undefined, headSha, { repo });
      await completeCheckRun(checkId, report, diff, { repo });
      checked = true;
    } catch (err) {
      checkError = err.message;
      logger.warn(`[ARGUS] C2: PR Check Run failed — ${err.message}`);
    }
  }

  return { posted: true, checked, skipped: false, ...(checkError ? { reason: `check run failed: ${checkError}` } : {}) };
}
