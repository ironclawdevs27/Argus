import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prResultToReport,
  reportPrValidation,
  formatPrComment,
  buildStatusPayload,
  postPrComment,
  createCheckRun,
  completeCheckRun,
} from '../../src/utils/github-reporter.js';
import {
  buildStepSummary,
  normalizeRoutePaths,
  writeGithubOutputs,
  writeStepSummary,
  checkTargetReachable,
} from '../../src/cli/pr-validate.js';

const COMMENT_MARKER = '<!-- argus-qa-report -->';
const PR_URL = 'https://github.com/acme/shop/pull/7';

/** A representative PR-Validator result (the CLI / argus_pr_validate response shape). */
function sampleResult(overrides = {}) {
  return {
    prUrl: PR_URL,
    targetUrl: 'https://staging.example.com',
    affectedRoutes: ['/checkout', '/about'],
    changedFiles: ['src/pages/checkout.tsx'],
    summary: { critical: 1, warning: 2, info: 0 },
    blocked: true,
    blockOn: 'critical',
    findings: [
      { severity: 'critical', type: 'console_error', message: 'TypeError: x is null', url: 'https://staging.example.com/checkout' },
      { severity: 'warning',  type: 'seo_meta',       message: 'Missing meta description', url: 'https://staging.example.com/checkout' },
      { severity: 'warning',  type: 'a11y_axe_violation', message: 'Low contrast text', url: 'https://staging.example.com/about' },
    ],
    ...overrides,
  };
}

/** Build a Response-like object for the injected fetch mock. */
function res(body, { status = 200, ok = true } = {}) {
  return { ok, status, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
}

// ── Pure adapter ──────────────────────────────────────────────────────────────

describe('prResultToReport', () => {
  it('groups findings per route (url → path) and totals the summary', () => {
    const report = prResultToReport(sampleResult());
    expect(report.summary).toEqual({ critical: 1, warning: 2, info: 0, total: 3 });

    const checkout = report.routes.find(r => r.route === '/checkout');
    const about    = report.routes.find(r => r.route === '/about');
    expect(checkout.errors).toHaveLength(2);
    expect(about.errors).toHaveLength(1);
    // base URL prefix is stripped, trailing slash removed
    expect(report.baseUrl).toBe('https://staging.example.com');
  });

  it('carries the block verdict, reason, and affected routes for the banner', () => {
    const { prValidation } = prResultToReport(sampleResult());
    expect(prValidation.blocked).toBe(true);
    expect(prValidation.reason).toContain('critical');
    expect(prValidation.affectedRoutes).toEqual(['/checkout', '/about']);
    expect(prValidation.changedFileCount).toBe(1);
  });

  it('reports a null reason and no block when not blocked', () => {
    const { prValidation } = prResultToReport(sampleResult({ blocked: false, summary: { critical: 0, warning: 0, info: 1 } }));
    expect(prValidation.blocked).toBe(false);
    expect(prValidation.reason).toBeNull();
  });

  it('phrases the reason for block-on=warning to include warnings', () => {
    const { prValidation } = prResultToReport(sampleResult({ blockOn: 'warning' }));
    expect(prValidation.reason).toContain('warning');
  });

  it('tolerates an empty result without throwing', () => {
    const report = prResultToReport({});
    expect(report.summary.total).toBe(0);
    expect(report.routes).toEqual([]);
    expect(report.prValidation.affectedRoutes).toEqual([]);
  });
});

// ── formatPrComment banner (backward-compatible) ───────────────────────────────

describe('formatPrComment — PR-validation banner', () => {
  const diff = { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 };

  it('renders the block banner, affected routes, and findings table for a PR report', () => {
    const body = formatPrComment(prResultToReport(sampleResult()), diff);
    expect(body).toContain(COMMENT_MARKER);            // idempotent-update key
    expect(body).toContain('Merge blocked');
    expect(body).toContain('Affected routes');
    expect(body).toContain('`/checkout`');
    expect(body).toContain('TypeError: x is null');    // finding is surfaced (non-first diff)
  });

  it('renders a passing banner when the run is not blocked', () => {
    const report = prResultToReport(sampleResult({ blocked: false, summary: { critical: 0, warning: 0, info: 1 } }));
    expect(formatPrComment(report, diff)).toContain('Merge allowed');
  });

  it('adds no banner for a plain runCrawl report (no prValidation field)', () => {
    const plain = {
      baseUrl: 'http://localhost:3000',
      generatedAt: new Date().toISOString(),
      summary: { total: 0, critical: 0, warning: 0, info: 0 },
      routes: [], codebase: [], flows: [],
    };
    const body = formatPrComment(plain, { isFirstRun: true });
    expect(body).not.toContain('Merge blocked');
    expect(body).not.toContain('Merge allowed');
  });
});

// ── reportPrValidation (gating + idempotent post via injected fetch) ────────────

const TRACKED_ENV = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_PR_NUMBER', 'GITHUB_SHA', 'ARGUS_PR_HEAD_SHA'];

describe('reportPrValidation', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of TRACKED_ENV) saved[k] = process.env[k];
    // Comment tests run with no resolvable head SHA, so reportPrValidation's A2 Check Run
    // branch stays inert and only the A1 comment fetches fire (deterministic regardless of
    // the ambient CI env, where GITHUB_SHA is set).
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_SHA;
    delete process.env.ARGUS_PR_HEAD_SHA;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of TRACKED_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('skips cleanly with no token — no fetch, no throw, no token in the result', async () => {
    delete process.env.GITHUB_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await reportPrValidation(sampleResult(), { prUrl: PR_URL });
    expect(out).toEqual({ posted: false, checked: false, skipped: true, reason: expect.stringContaining('GITHUB_TOKEN') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when no repo/PR number can be resolved (token set, no env, unparseable URL)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_x';
    vi.stubGlobal('fetch', vi.fn());
    const out = await reportPrValidation(sampleResult({ prUrl: undefined }), { prUrl: 'not-a-pr-url' });
    expect(out.skipped).toBe(true);
    expect(out.posted).toBe(false);
  });

  it('creates a new comment (POST) at the PR endpoint resolved from the URL, with marker + reason', async () => {
    const SECRET = 'ghp_create_secret_value';
    process.env.GITHUB_TOKEN = SECRET;
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
      return method === 'GET' ? res([]) : res({ id: 1001 }, { status: 201 });
    }));

    const out = await reportPrValidation(sampleResult(), { prUrl: PR_URL });
    expect(out).toEqual({ posted: true, checked: false, skipped: false });

    const post = calls.find(c => c.method === 'POST');
    expect(post.url).toMatch(/\/repos\/acme\/shop\/issues\/7\/comments$/);
    expect(post.body).toContain(COMMENT_MARKER);
    expect(post.body).toContain('Merge blocked');
    // token rides only in the Authorization header — never the comment body
    expect(post.auth).toBe(`Bearer ${SECRET}`);
    expect(post.body).not.toContain(SECRET);
  });

  it('is idempotent — updates the existing Argus comment in place (PATCH), no duplicate POST', async () => {
    process.env.GITHUB_TOKEN = 'ghp_update';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET') return res([{ id: 555, body: `prior\n${COMMENT_MARKER}\nold` }]);
      return res({ id: 555 });
    }));

    const out = await reportPrValidation(sampleResult(), { prUrl: PR_URL });
    expect(out.posted).toBe(true);

    const patch = calls.find(c => c.method === 'PATCH');
    const post  = calls.find(c => c.method === 'POST');
    expect(patch.url).toMatch(/\/issues\/comments\/555$/);
    expect(post).toBeUndefined();
  });

  it('prefers explicit env repo/PR number over the URL', async () => {
    process.env.GITHUB_TOKEN = 'ghp_env';
    process.env.GITHUB_REPOSITORY = 'override/repo';
    process.env.GITHUB_PR_NUMBER = '99';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method });
      return method === 'GET' ? res([]) : res({ id: 1 }, { status: 201 });
    }));

    await reportPrValidation(sampleResult(), { prUrl: PR_URL });
    expect(calls.find(c => c.method === 'POST').url).toMatch(/\/repos\/override\/repo\/issues\/99\/comments$/);
  });
});

// ── reportPrValidation — A2 GitHub Check Run conclusion ─────────────────────────

describe('reportPrValidation — Check Run (A2)', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of TRACKED_ENV) saved[k] = process.env[k];
    delete process.env.GITHUB_REPOSITORY;   // resolve owner/repo + PR from the URL
    delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_SHA;
    process.env.GITHUB_TOKEN = 'ghp_check_run';
    process.env.ARGUS_PR_HEAD_SHA = 'deadbeefcafe';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of TRACKED_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  /** Stub that forces the create path (comment GET → []) and answers the Check Run create. */
  function stubFetch(calls) {
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
      if (method === 'GET')          return res([]);
      if (/\/check-runs$/.test(url)) return res({ id: 9001 }, { status: 201 });
      return res({ id: 1 });
    }));
  }

  it('creates + completes a Check Run on the head SHA with conclusion=failure when blocked', async () => {
    const calls = [];
    stubFetch(calls);
    const out = await reportPrValidation(sampleResult({ blocked: true, blockOn: 'critical', summary: { critical: 1, warning: 0, info: 0 } }), { prUrl: PR_URL });
    expect(out.checked).toBe(true);

    const crPost  = calls.find(c => c.method === 'POST'  && /\/repos\/acme\/shop\/check-runs$/.test(c.url));
    const crPatch = calls.find(c => c.method === 'PATCH' && /\/check-runs\/9001$/.test(c.url));
    expect(JSON.parse(crPost.body)).toMatchObject({ head_sha: 'deadbeefcafe', status: 'in_progress' });
    expect(JSON.parse(crPatch.body)).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it('concludes success when the PR is not blocked', async () => {
    const calls = [];
    stubFetch(calls);
    await reportPrValidation(sampleResult({ blocked: false, blockOn: 'critical', summary: { critical: 0, warning: 0, info: 1 } }), { prUrl: PR_URL });
    const crPatch = calls.find(c => c.method === 'PATCH' && /\/check-runs\//.test(c.url));
    expect(JSON.parse(crPatch.body).conclusion).toBe('success');
  });

  it('block-on=warning with 0 criticals still concludes failure — block verdict wins, not the critical threshold', async () => {
    const calls = [];
    stubFetch(calls);
    await reportPrValidation(sampleResult({ blocked: true, blockOn: 'warning', summary: { critical: 0, warning: 2, info: 0 } }), { prUrl: PR_URL });
    const crPatch = calls.find(c => c.method === 'PATCH' && /\/check-runs\//.test(c.url));
    expect(JSON.parse(crPatch.body).conclusion).toBe('failure');
  });

  it('skips the Check Run (checked=false) when no head SHA is resolvable — comment still posts', async () => {
    delete process.env.ARGUS_PR_HEAD_SHA;
    delete process.env.GITHUB_SHA;
    const calls = [];
    stubFetch(calls);
    const out = await reportPrValidation(sampleResult(), { prUrl: PR_URL });
    expect(out).toEqual({ posted: true, checked: false, skipped: false });
    expect(calls.some(c => /\/check-runs/.test(c.url))).toBe(false);
    expect(calls.some(c => c.method === 'POST' && /\/issues\/7\/comments$/.test(c.url))).toBe(true);
  });

  it('never leaks the token into the Check Run request bodies', async () => {
    const SECRET = 'ghp_super_secret_checkrun';
    process.env.GITHUB_TOKEN = SECRET;
    const calls = [];
    stubFetch(calls);
    await reportPrValidation(sampleResult({ blocked: true }), { prUrl: PR_URL });
    const checkRunCalls = calls.filter(c => /\/check-runs/.test(c.url));
    expect(checkRunCalls.length).toBeGreaterThanOrEqual(2);   // create + complete
    for (const c of checkRunCalls) {
      expect(c.auth).toBe(`Bearer ${SECRET}`);
      expect(String(c.body ?? '')).not.toContain(SECRET);
    }
  });
});

// ── A4 — MCP reporting parity (argus_pr_validate wires the SAME shared helper) ───

const SERVER_SRC = readFileSync(new URL('../../src/mcp-server.js', import.meta.url), 'utf8');

describe('A4 — handlePrValidate reporting wiring (source contract)', () => {
  // Slice the handlePrValidate body so the assertions can't match an unrelated function.
  const fnStart = SERVER_SRC.indexOf('async function handlePrValidate');
  const fnEnd   = SERVER_SRC.indexOf('\nasync function', fnStart + 1);
  const fnBody  = fnStart !== -1 ? SERVER_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd) : '';

  it('imports the shared reportPrValidation helper from github-reporter', () => {
    expect(SERVER_SRC).toMatch(/import\s*{\s*reportPrValidation\s*}\s*from\s*'\.\/utils\/github-reporter\.js'/);
  });

  it('calls reportPrValidation(result, ...) inside a try/catch (best-effort, isolated)', () => {
    expect(fnBody).toMatch(/reportPrValidation\(\s*result\s*,/);
    expect(fnBody).toMatch(/try\s*{[\s\S]*?reportPrValidation\([\s\S]*?}\s*catch/);
  });

  it('reports AFTER the block decision and appends `reporting` — cannot alter blocked', () => {
    const blockedIdx = fnBody.indexOf('const blocked');
    const reportIdx  = fnBody.indexOf('reportPrValidation(');
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(reportIdx).toBeGreaterThan(blockedIdx);          // reporting is strictly after the decision
    expect(fnBody).toMatch(/\.\.\.result,\s*reporting/);    // appended, never overwriting result fields
  });
});

describe('A4 — MCP-shaped result feeds the shared helper', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of TRACKED_ENV) saved[k] = process.env[k];
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_SHA;
    delete process.env.ARGUS_PR_HEAD_SHA;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of TRACKED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  // The EXACT shape handlePrValidate builds: affectedRoutes as a string[], targetUrl
  // un-normalized, findings url'd off targetUrl — distinct from the CLI-shaped sampleResult().
  function mcpResult(overrides = {}) {
    return {
      prUrl: 'https://github.com/acme/web/pull/42',
      targetUrl: 'https://staging.example.com',
      affectedRoutes: ['/checkout'],
      changedFiles: ['src/pages/checkout.tsx'],
      findings: [{ severity: 'critical', type: 'console_error', message: 'TypeError: total is undefined', url: 'https://staging.example.com/checkout' }],
      perRoute: [{ route: '/checkout', critical: 1, warning: 0, info: 0 }],
      summary: { critical: 1, warning: 0, info: 0 },
      blocked: true,
      blockOn: 'critical',
      ...overrides,
    };
  }

  it('posts a PR comment carrying the block reason + affected route, no token leak', async () => {
    const SECRET = 'ghp_mcp_parity_secret';
    process.env.GITHUB_TOKEN = SECRET;
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method, body: opts.body, auth: opts.headers?.Authorization });
      return method === 'GET' ? res([]) : res({ id: 777 }, { status: 201 });
    }));

    const out = await reportPrValidation(mcpResult(), { prUrl: 'https://github.com/acme/web/pull/42' });
    expect(out).toEqual({ posted: true, checked: false, skipped: false });

    const post = calls.find(c => c.method === 'POST' && /\/repos\/acme\/web\/issues\/42\/comments$/.test(c.url));
    expect(post).toBeDefined();
    expect(post.body).toContain('`/checkout`');     // route surfaced (per-route grouping)
    expect(post.body).toMatch(/critical/i);         // block reason
    expect(post.body).not.toContain(SECRET);        // token stays in the Authorization header
    expect(post.auth).toBe(`Bearer ${SECRET}`);
  });
});

// ── B2 — baseline-aware new/persisting/resolved surfacing in the PR comment ──────

describe('prResultToReport / formatPrComment — baseline diff surfacing (B2)', () => {
  // Mirror reportPrValidation: the comment's Resolved row is fed from the head-vs-base diff.
  const diffFor = (r) => ({
    isFirstRun: false,
    resolvedCount: r.baseline?.available ? (r.baseline.resolved ?? 0) : 0,
    flowResolvedCount: 0,
  });

  /** A result whose findings are already tagged isNew (as the PR-validate paths produce). */
  function baselineResult(overrides = {}) {
    return sampleResult({
      summary: { critical: 2, warning: 0, info: 0 },
      blocked: true,
      blockOn: 'critical',
      findings: [
        { severity: 'critical', type: 'console_error', message: 'NEW: total is undefined', url: 'https://staging.example.com/checkout', isNew: true },
        { severity: 'critical', type: 'console_error', message: 'LEGACY: x is null',        url: 'https://staging.example.com/checkout', isNew: false },
      ],
      baseline: { available: true, newCritical: 1, newWarning: 0, newInfo: 0, persisting: 1, resolved: 1 },
      ...overrides,
    });
  }

  it('threads the baseline into prValidation and makes the reason reconcile with the NEW counts', () => {
    const { prValidation } = prResultToReport(baselineResult());
    expect(prValidation.baseline).toMatchObject({ available: true, newCritical: 1, persisting: 1, resolved: 1 });
    // blocked on 1 NEW critical (not the 2 absolute) — the reason names "new"
    expect(prValidation.reason).toBe('1 critical new finding(s) found');
  });

  it('renders the new/persisting/resolved line and lists ONLY the introduced finding', () => {
    const r = baselineResult();
    const body = formatPrComment(prResultToReport(r), diffFor(r));
    expect(body).toContain('1 new critical');
    expect(body).toContain('1 persisting');
    expect(body).toContain('1 resolved');
    expect(body).toContain('NEW: total is undefined');   // the PR-introduced finding is surfaced
    expect(body).not.toContain('LEGACY: x is null');     // persisting finding excluded from the new table
  });

  it('a pre-existing-only PR is ALLOWED and the comment says 0 new / 1 persisting', () => {
    const r = baselineResult({
      summary: { critical: 1, warning: 0, info: 0 },
      blocked: false,
      findings: [{ severity: 'critical', type: 'console_error', message: 'LEGACY: x is null', url: 'https://staging.example.com/checkout', isNew: false }],
      baseline: { available: true, newCritical: 0, newWarning: 0, newInfo: 0, persisting: 1, resolved: 0 },
    });
    const body = formatPrComment(prResultToReport(r), diffFor(r));
    expect(body).toContain('Merge allowed');
    expect(body).toContain('0 new critical');
    expect(body).toContain('1 persisting');
  });

  it('surfaces the fail-safe note when no baseline was available', () => {
    const r = baselineResult({ baseline: { available: false, note: 'Baseline unavailable — blocking on absolute finding counts.' } });
    const body = formatPrComment(prResultToReport(r), diffFor(r));
    expect(body).toContain('Baseline unavailable');
  });

  it('adds no baseline line for a legacy result with no baseline field (back-compat)', () => {
    const { prValidation } = prResultToReport(sampleResult());   // sampleResult has no baseline
    expect(prValidation.baseline).toBeNull();
    expect(prValidation.reason).toBe('1 critical finding(s) found');   // legacy phrasing, no scope word
    const body = formatPrComment(prResultToReport(sampleResult()), { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 });
    expect(body).not.toContain('persisting');
    expect(body).not.toContain('Baseline unavailable');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// F3 — direct unit coverage for the CLI helpers + reporting primitives that were
// previously exercised ONLY by the slow Chrome harness ([136]/[138]/[151]/[152]) or
// transitively via reportPrValidation. Chrome-free, network-free (injected fetch /
// temp files), so they run in the fast unit lane on every change.
// ════════════════════════════════════════════════════════════════════════════════

// ── CLI: buildStepSummary (pure markdown builder) ───────────────────────────────

describe('buildStepSummary (CLI)', () => {
  /** Minimal valid opts; override per case. */
  function opts(over = {}) {
    return {
      blocked: false,
      summary: { critical: 0, warning: 0, info: 0 },
      affectedRoutes: [],
      perRoute: [],
      findings: [],
      changedFiles: [],
      blockOn: 'critical',
      ...over,
    };
  }

  it('renders the BLOCKED banner + 🔴 icon and the block-threshold + count metrics when blocked', () => {
    const md = buildStepSummary(opts({
      blocked: true,
      summary: { critical: 2, warning: 1, info: 3 },
      affectedRoutes: [{ path: '/checkout' }, { path: '/about' }],
      changedFiles: ['a.tsx', 'b.css'],
    }));
    expect(md).toContain('🔴 Argus PR Validator — BLOCKED — merge prevented');
    expect(md).toContain('| Block threshold | `critical` |');
    expect(md).toContain('| Critical findings | **2** |');
    expect(md).toContain('| Warning findings | 1 |');
    expect(md).toContain('| Info findings | 3 |');
    expect(md).toContain('| Routes audited | 2 |');
    expect(md).toContain('| Files changed | 2 |');
  });

  it('renders the PASSED banner with ✅ when clean and ⚠️ when warnings exist but not blocked', () => {
    expect(buildStepSummary(opts())).toContain('✅ Argus PR Validator — PASSED');
    const warn = buildStepSummary(opts({ summary: { critical: 0, warning: 2, info: 0 } }));
    expect(warn).toContain('⚠️ Argus PR Validator — PASSED');   // not blocked → status stays PASSED, icon warns
  });

  it('renders the per-route breakdown with counts and an inline error note', () => {
    const md = buildStepSummary(opts({
      perRoute: [
        { route: '/checkout', critical: 1, warning: 0, info: 0 },
        { route: '/broken',   critical: 0, warning: 0, info: 0, error: 'navigation timed out' },
      ],
    }));
    expect(md).toContain('### Route Breakdown');
    expect(md).toContain('| `/checkout` | 1 | 0 | 0 |');
    expect(md).toContain('_(error: navigation timed out)_');
  });

  it('escapes pipes in finding messages and caps the findings table at 50 with an overflow note', () => {
    const findings = Array.from({ length: 53 }, (_, i) => ({
      severity: 'warning', type: 'seo_meta', message: `m${i} a|b`, url: 'http://x',
    }));
    const md = buildStepSummary(opts({ summary: { critical: 0, warning: 53, info: 0 }, findings }));
    expect(md).toContain('### Findings');
    expect(md).toContain('a\\|b');                 // pipe escaped so the table is not broken
    expect(md).toContain('_…and 3 more findings._'); // 53 − 50
  });

  it('renders the baseline-diff section when a baseline is available', () => {
    const md = buildStepSummary(opts({
      baseline: { available: true, newCritical: 1, newWarning: 2, newInfo: 0, persisting: 3, resolved: 4 },
    }));
    expect(md).toContain('### Baseline diff');
    expect(md).toContain('| New | 1 | 2 | 0 |');
    expect(md).toContain('_3 persisting · 4 resolved._');
  });

  it('renders the fail-safe note (not the diff table) when no baseline was available', () => {
    const md = buildStepSummary(opts({
      blocked: true,
      summary: { critical: 1, warning: 0, info: 0 },
      baseline: { available: false, note: 'Baseline unavailable — blocking on absolute finding counts.' },
    }));
    expect(md).toContain('Baseline unavailable — blocking on absolute finding counts.');
    expect(md).not.toContain('### Baseline diff');
  });

  it('surfaces a top-level error and sanitizes backticks', () => {
    const md = buildStepSummary(opts({ error: 'cannot reach `target`' }));
    expect(md).toContain("> **Error:** cannot reach 'target'");
  });
});

// ── CLI: normalizeRoutePaths (pure) ─────────────────────────────────────────────

describe('normalizeRoutePaths (CLI)', () => {
  it('prepends a leading slash to bare paths and leaves rooted paths untouched, preserving other fields', () => {
    const out = normalizeRoutePaths([
      { path: 'checkout', name: 'Checkout' },
      { path: '/about',   name: 'About' },
      { path: 'a/b/c' },
    ]);
    expect(out).toEqual([
      { path: '/checkout', name: 'Checkout' },
      { path: '/about',    name: 'About' },
      { path: '/a/b/c' },
    ]);
  });

  it('returns the same object reference for an already-rooted path (no needless copy)', () => {
    const rooted = { path: '/x', name: 'X' };
    expect(normalizeRoutePaths([rooted])[0]).toBe(rooted);
  });
});

// ── CLI: writeGithubOutputs / writeStepSummary (file I/O via $GITHUB_* env) ──────

describe('writeGithubOutputs / writeStepSummary (CLI)', () => {
  let dir;
  const saved = {};
  const KEYS = ['GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'argus-f3-'));
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the blocked/critical/warning/affected_routes key=value contract to $GITHUB_OUTPUT', () => {
    const file = path.join(dir, 'out.txt');
    process.env.GITHUB_OUTPUT = file;
    writeGithubOutputs({ blocked: true, summary: { critical: 2, warning: 1, info: 0 }, affectedRoutes: [{ path: '/checkout' }, { path: '/about' }] });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('blocked=true');
    expect(text).toContain('critical_count=2');
    expect(text).toContain('warning_count=1');
    expect(text).toContain('affected_routes=/checkout,/about');
  });

  it('accepts affectedRoutes as plain strings as well as {path} objects', () => {
    const file = path.join(dir, 'out2.txt');
    process.env.GITHUB_OUTPUT = file;
    writeGithubOutputs({ blocked: false, summary: { critical: 0, warning: 0, info: 0 }, affectedRoutes: ['/a', '/b'] });
    expect(readFileSync(file, 'utf8')).toContain('affected_routes=/a,/b');
  });

  it('no-ops without throwing when $GITHUB_OUTPUT is unset (local runs)', () => {
    delete process.env.GITHUB_OUTPUT;
    expect(() => writeGithubOutputs({ blocked: false, summary: { critical: 0, warning: 0, info: 0 }, affectedRoutes: [] })).not.toThrow();
  });

  it('appends markdown to $GITHUB_STEP_SUMMARY, and no-ops when unset', () => {
    const file = path.join(dir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = file;
    writeStepSummary('## hello\n');
    writeStepSummary('world\n');
    expect(readFileSync(file, 'utf8')).toBe('## hello\nworld\n');   // appended, not overwritten

    delete process.env.GITHUB_STEP_SUMMARY;
    expect(() => writeStepSummary('ignored')).not.toThrow();
  });
});

// ── CLI: checkTargetReachable (network preflight, fetch injected) ────────────────

describe('checkTargetReachable (CLI)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns ok:true when fetch resolves (HEAD), regardless of HTTP status', async () => {
    // A 404 still means the server is up — Argus should audit it, so only a network throw fails.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    expect(await checkTargetReachable('http://x/')).toEqual({ ok: true });
  });

  it('returns ok:false with the error message on a network-level failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await checkTargetReachable('http://down/')).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

// ── github-reporter: buildStatusPayload (pure commit-status builder) ─────────────

describe('buildStatusPayload (github-reporter)', () => {
  const saved = {};
  const KEYS = ['ARGUS_CRITICAL_THRESHOLD', 'GITHUB_CHECK_NAME'];
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(()  => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  /** A report with one NEW critical, one pre-existing critical (isNew:false), spread across surfaces. */
  function statusReport(over = {}) {
    return {
      summary: { total: 4, critical: 2, warning: 1, info: 1 },
      routes:   [{ route: '/c', errors: [
        { severity: 'critical', isNew: true },    // NEW → counts
        { severity: 'critical', isNew: false },   // pre-existing → excluded
      ] }],
      codebase: [{ severity: 'critical' }],       // no isNew field → treated as new (isNew !== false)
      flows:    [],
      ...over,
    };
  }

  it('blocks (state=failure) at the default threshold of 1 and counts only new criticals', () => {
    const p = buildStatusPayload(statusReport(), null);
    expect(p.newCriticalCount).toBe(2);            // 1 route(new) + 1 codebase(undefined=new); pre-existing excluded
    expect(p.threshold).toBe(1);
    expect(p.state).toBe('failure');
    expect(p.description).toMatch(/2 new critical issue\(s\) — merge blocked \(threshold: 1\)/);
    expect(p.context).toBe('argus-qa');
  });

  it('passes (state=success) when new criticals are below a higher threshold', () => {
    process.env.ARGUS_CRITICAL_THRESHOLD = '5';
    const p = buildStatusPayload(statusReport(), null);
    expect(p.state).toBe('success');
    expect(p.description).toMatch(/All checks passed \(4 total finding\(s\)\)/);
  });

  it('never blocks when the threshold is 0', () => {
    process.env.ARGUS_CRITICAL_THRESHOLD = '0';
    expect(buildStatusPayload(statusReport(), null).state).toBe('success');
  });

  it('honours GITHUB_CHECK_NAME for the status context', () => {
    process.env.GITHUB_CHECK_NAME = 'argus-pr';
    expect(buildStatusPayload(statusReport(), null).context).toBe('argus-pr');
  });
});

// ── github-reporter: PR-reporting primitives (postPrComment / createCheckRun / completeCheckRun) ──

describe('GitHub reporting primitives — direct (injected fetch)', () => {
  const TRACKED = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_PR_NUMBER', 'GITHUB_SHA', 'GITHUB_CHECK_NAME', 'ARGUS_CRITICAL_THRESHOLD'];
  const saved = {};
  beforeEach(() => {
    for (const k of TRACKED) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.GITHUB_TOKEN = 'ghp_f3_secret';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of TRACKED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  const report = () => prResultToReport(sampleResult());
  const diff   = { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 };

  it('postPrComment POSTs a new comment when none exists, token in the header only', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
      const method = o.method ?? 'GET';
      calls.push({ url, method, body: o.body, auth: o.headers?.Authorization });
      return method === 'GET' ? res([]) : res({ id: 4242 }, { status: 201 });
    }));
    await postPrComment(report(), diff, { repo: 'acme/shop', prNumber: 7 });
    const post = calls.find(c => c.method === 'POST');
    expect(post.url).toMatch(/\/repos\/acme\/shop\/issues\/7\/comments$/);
    expect(post.body).toContain(COMMENT_MARKER);
    expect(post.auth).toBe('Bearer ghp_f3_secret');
    expect(post.body).not.toContain('ghp_f3_secret');
  });

  it('postPrComment PATCHes the existing marked Argus comment (idempotent), no duplicate POST', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
      const method = o.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET') return res([{ id: 88, body: `prior\n${COMMENT_MARKER}\nx` }]);
      return res({ id: 88 });
    }));
    await postPrComment(report(), diff, { repo: 'acme/shop', prNumber: 7 });
    expect(calls.find(c => c.method === 'PATCH').url).toMatch(/\/issues\/comments\/88$/);
    expect(calls.find(c => c.method === 'POST')).toBeUndefined();
  });

  it('postPrComment throws (fail-loud) when neither opts nor env supply repo/PR number', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(postPrComment(report(), diff, {})).rejects.toThrow(/GITHUB_REPOSITORY or GITHUB_PR_NUMBER/);
  });

  it('createCheckRun POSTs in_progress on the head SHA and returns the new id', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => {
      calls.push({ url, method: o.method, body: o.body, auth: o.headers?.Authorization });
      return res({ id: 9001 }, { status: 201 });
    }));
    const id = await createCheckRun('argus-qa', 'sha999', { repo: 'acme/shop' });
    expect(id).toBe(9001);
    const post = calls[0];
    expect(post.url).toMatch(/\/repos\/acme\/shop\/check-runs$/);
    expect(JSON.parse(post.body)).toMatchObject({ name: 'argus-qa', head_sha: 'sha999', status: 'in_progress' });
    expect(post.auth).toBe('Bearer ghp_f3_secret');
  });

  it('createCheckRun throws when no repo/SHA is resolvable', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(createCheckRun('argus-qa', undefined, {})).rejects.toThrow(/GITHUB_REPOSITORY or GITHUB_SHA/);
  });

  it('completeCheckRun PATCHes conclusion=failure for a blocked PR report; success when allowed', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => { calls.push({ url, method: o.method, body: o.body }); return res({ id: 9001 }); }));

    await completeCheckRun(9001, prResultToReport(sampleResult()), diff, { repo: 'acme/shop' });   // blocked: true
    const blockedPatch = calls.at(-1);
    expect(blockedPatch.url).toMatch(/\/check-runs\/9001$/);
    expect(JSON.parse(blockedPatch.body)).toMatchObject({ status: 'completed', conclusion: 'failure' });

    await completeCheckRun(9001, prResultToReport(sampleResult({ blocked: false, summary: { critical: 0, warning: 0, info: 1 } })), diff, { repo: 'acme/shop' });
    expect(JSON.parse(calls.at(-1).body).conclusion).toBe('success');
  });

  it('completeCheckRun falls back to buildStatusPayload for a plain (non-prValidation) report', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, o = {}) => { calls.push({ url, method: o.method, body: o.body }); return res({ id: 1 }); }));
    const plain = {
      baseUrl: 'http://localhost:3000', generatedAt: new Date().toISOString(),
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
      routes: [{ route: '/', errors: [{ severity: 'critical', isNew: true }] }], codebase: [], flows: [],
    };
    await completeCheckRun(7, plain, { isFirstRun: true }, { repo: 'acme/shop' });
    expect(JSON.parse(calls.at(-1).body).conclusion).toBe('failure');   // 1 new critical ≥ default threshold 1
  });
});
