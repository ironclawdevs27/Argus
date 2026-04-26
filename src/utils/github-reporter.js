/**
 * Argus Phase C2: GitHub PR comment + commit status integration.
 *
 * C2.1  formatPrComment(report, diff)    — build Markdown PR comment body (pure)
 * C2.2  buildStatusPayload(report, diff) — build GitHub commit status payload (pure)
 * C2.3  postPrComment(report, diff)      — create/update PR comment via GitHub API
 * C2.4  setCommitStatus(report, diff)    — set commit status (blocks merge on new criticals)
 * C2.5  isGitHubConfigured()             — guard: true when GITHUB_TOKEN + GITHUB_REPOSITORY set
 * C2.6  reportToGitHub(report, diff)     — orchestrates C2.3 + C2.4
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
 *   ARGUS_REPORT_URL    — URL to the full HTML report; linked in the commit status check
 */

const COMMENT_MARKER = '<!-- argus-qa-report -->';
const GITHUB_API     = 'https://api.github.com';
const MAX_TABLE_ROWS = 15;  // cap table rows to stay within GitHub's 65536-char limit

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEV_ICON = { critical: '🔴', warning: '🟡', info: '🔵' };
function sevIcon(sev) { return SEV_ICON[sev] ?? '⚪'; }

/** Escape pipe characters so they don't break Markdown tables. */
function mdCell(text, maxLen = 100) {
  return String(text ?? '').slice(0, maxLen).replace(/\|/g, '\\|').replace(/\n/g, ' ');
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
    lines.push('', `### 🆕 New Findings (${allNewFindings.length})`);
    lines.push('| Severity | Source | Type | Details |');
    lines.push('|---|---|---|---|');
    for (const f of allNewFindings.slice(0, MAX_TABLE_ROWS)) {
      lines.push(`| ${sevIcon(f.severity)} ${f.severity} | ${f._source} | \`${f.type}\` | ${mdCell(f.message)} |`);
    }
    if (allNewFindings.length > MAX_TABLE_ROWS) {
      lines.push(`| … | … | … | _${allNewFindings.length - MAX_TABLE_ROWS} more — see full report_ |`);
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
  lines.push(`_Generated by [Argus](https://github.com/ironclawdevs/GodMode---AI-Dev-Testing-Tool) · ${new Date(report.generatedAt).toISOString()}_`);

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
    ...report.routes.flatMap(r =>
      r.errors.filter(e => e.severity === 'critical' && e.isNew !== false)
    ),
    ...(report.codebase ?? []).filter(f => f.severity === 'critical' && f.isNew !== false),
    ...(report.flows ?? []).flatMap(f =>
      (f.findings ?? []).filter(e => e.severity === 'critical' && e.isNew !== false)
    ),
  ].length;

  const passing = newCriticals === 0;
  return {
    state:       passing ? 'success' : 'failure',
    description: passing
      ? `Argus: All checks passed (${report.summary.total} total finding(s))`
      : `Argus: ${newCriticals} new critical issue(s) — merge blocked`,
    context:     'argus-qa',
  };
}

// ── GitHub API helper ─────────────────────────────────────────────────────────

async function ghFetch(urlPath, method, body) {
  const headers = {
    'Authorization':        `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${GITHUB_API}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${urlPath} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── C2.3: Post or update PR comment ──────────────────────────────────────────

/**
 * Create a PR comment, or update the existing Argus comment if one is already present.
 * Idempotent: re-running on the same PR updates in-place rather than spamming new comments.
 */
export async function postPrComment(report, diff) {
  const repo  = process.env.GITHUB_REPOSITORY;
  const prNum = process.env.GITHUB_PR_NUMBER;
  if (!repo || !prNum) throw new Error('[ARGUS] C2: GITHUB_REPOSITORY or GITHUB_PR_NUMBER not set');

  const body = formatPrComment(report, diff);

  // Find existing Argus comment to update
  const existing = await ghFetch(`/repos/${repo}/issues/${prNum}/comments?per_page=100`, 'GET');
  const prev = Array.isArray(existing)
    ? existing.find(c => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER))
    : null;

  if (prev) {
    await ghFetch(`/repos/${repo}/issues/comments/${prev.id}`, 'PATCH', { body });
    console.log(`[ARGUS] C2: Updated PR #${prNum} comment (id: ${prev.id})`);
  } else {
    await ghFetch(`/repos/${repo}/issues/${prNum}/comments`, 'POST', { body });
    console.log(`[ARGUS] C2: Posted new comment on PR #${prNum}`);
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
  console.log(`[ARGUS] C2: Commit status → ${payload.state} (${payload.description})`);
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

  if (process.env.GITHUB_PR_NUMBER) {
    tasks.push(
      postPrComment(report, diff).catch(err =>
        console.warn(`[ARGUS] C2: PR comment failed — ${err.message}`)
      )
    );
  }

  if (process.env.GITHUB_SHA) {
    tasks.push(
      setCommitStatus(report, diff).catch(err =>
        console.warn(`[ARGUS] C2: Commit status failed — ${err.message}`)
      )
    );
  }

  if (tasks.length === 0) {
    console.log('[ARGUS] C2: No GITHUB_PR_NUMBER or GITHUB_SHA — skipping GitHub reporting');
    return;
  }

  await Promise.all(tasks);
}
