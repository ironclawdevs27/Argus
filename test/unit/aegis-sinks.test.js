/**
 * Aegis — egress-sink guards (REDACTION_BOUNDARY_MAX_PLAN.md Steps 5–7).
 *
 * Chrome-free proof that the FOUR non-MCP sinks — Slack (dispatcher.js), GitHub
 * (github-reporter.js), HTML (html-reporter.js), and the CI logs / step summary /
 * annotations (cli/pr-validate.js) — each project findings through redactForEgress
 * before anything crosses the trust boundary. The ONE invariant every test pins:
 * no JWT / Anthropic-key / query-string-token substring survives at the sink, while
 *   - a BENIGN finding's message survives (data minimization, not blanket deletion), and
 *   - ARGUS_REDACT_SENSITIVE=0 lets the raw secret through (the non-vacuity guard — proves
 *     the redaction is load-bearing, never a tautology).
 *
 * The Slack sink is exercised through the real dispatchToSlack (via dispatchAll) with
 * slack-notifier mocked; GitHub through the real reportPrValidation / reportToGitHub with
 * an injected fetch; HTML through the real generateHtmlReport({external:true}); the CLI
 * through the real buildStepSummary / safeFindingLine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Secret-bearing + benign sample findings ───────────────────────────────────

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const ANTHROPIC = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789AbCdEf01_xyz';

/** A genuinely sensitive finding: secrets in the message AND a token in the url query. */
function sensitiveFinding() {
  return {
    type: 'security_no_https',
    severity: 'critical',
    isNew: true,
    url: `http://app.internal:8080/login?session=${JWT}`,
    requestUrl: 'http://app.internal:8080/login',
    message: `Login posts credentials over HTTP; captured Authorization: Bearer ${ANTHROPIC}`,
    evidence: `<form action="http://app.internal/login" data-jwt="${JWT}">`,
  };
}

/**
 * A sensitive finding whose secret sits at the START of a SHORT message — so the secret
 * survives the step summary's 100-char message slice when redaction is OFF (otherwise the
 * slice itself would truncate the key and make the non-vacuity guard pass vacuously).
 */
function shortSensitive() {
  return {
    type: 'security_no_https',
    severity: 'critical',
    isNew: true,
    message: `Bearer ${ANTHROPIC} captured`,
    url: 'http://app.example.com/login',
  };
}

/** A benign finding whose message must SURVIVE egress (only secrets get stripped). */
function benignFinding() {
  return {
    type: 'seo_title_missing',
    severity: 'warning',
    isNew: true,
    url: 'http://app.example.com/about',
    message: 'Page is missing a descriptive <title> element',
  };
}

const SECRETS = [JWT, ANTHROPIC];
function leaksAnySecret(text) {
  return SECRETS.some((s) => String(text).includes(s));
}

// ── Slack (dispatcher.js — Step 5) ────────────────────────────────────────────

const postBugReportMock = vi.fn(async () => ({ ok: true }));
vi.mock('../../src/orchestration/slack-notifier.js', () => ({
  postBugReport: (...args) => postBugReportMock(...args),
}));

const { dispatchAll } = await import('../../src/orchestration/dispatcher.js');

function reportWith(findings) {
  return {
    baseUrl: 'http://app.example.com',
    generatedAt: new Date().toISOString(),
    summary: {
      total: findings.length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    routes: [{ route: '/login', url: 'http://app.example.com/login', screenshot: null, errors: findings }],
    flows: [],
    codebase: [],
  };
}

describe('Aegis Step 5 — Slack egress guard (dispatcher.js)', () => {
  const SLACK_ENV = ['SLACK_BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'ARGUS_REDACT_SENSITIVE'];
  const saved = {};
  beforeEach(() => {
    for (const k of SLACK_ENV) saved[k] = process.env[k];
    postBugReportMock.mockClear();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';   // isSlackConfigured() → true
    delete process.env.GITHUB_TOKEN;             // skip GitHub sink
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.ARGUS_REDACT_SENSITIVE;   // default ON
  });
  afterEach(() => {
    for (const k of SLACK_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('no Slack message (description or details) carries a secret substring; benign message survives', async () => {
    await dispatchAll(reportWith([sensitiveFinding(), benignFinding()]), { isFirstRun: true }, null);
    expect(postBugReportMock).toHaveBeenCalled();
    const blob = JSON.stringify(postBugReportMock.mock.calls);
    expect(leaksAnySecret(blob)).toBe(false);
    // benign finding's message still helps the reader
    expect(blob).toContain('missing a descriptive');
    // the sensitive critical line collapsed to the redaction marker
    expect(blob).toContain('redacted');
  });

  it('opt-out (ARGUS_REDACT_SENSITIVE=0) lets the raw secret through — non-vacuity guard', async () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    await dispatchAll(reportWith([sensitiveFinding()]), { isFirstRun: true }, null);
    const blob = JSON.stringify(postBugReportMock.mock.calls);
    expect(leaksAnySecret(blob)).toBe(true);
  });
});

// ── GitHub (github-reporter.js — Step 6) ──────────────────────────────────────

const { reportPrValidation, reportToGitHub } = await import('../../src/utils/github-reporter.js');

const GH_ENV = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_PR_NUMBER', 'GITHUB_SHA', 'ARGUS_PR_HEAD_SHA', 'ARGUS_REDACT_SENSITIVE'];

function prResult(findings, extra = {}) {
  return {
    prUrl: 'https://github.com/acme/shop/pull/7',
    targetUrl: 'https://staging.example.com',
    affectedRoutes: ['/login'],
    changedFiles: ['src/pages/login.tsx'],
    summary: {
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: 0,
    },
    blocked: true,
    blockOn: 'critical',
    findings,   // keep each finding's own url (the sensitive one carries a JWT in its query)
    ...extra,
  };
}

describe('Aegis Step 6 — GitHub PR-comment egress guard (reportPrValidation)', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of GH_ENV) saved[k] = process.env[k];
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_PR_NUMBER;
    delete process.env.GITHUB_SHA;
    delete process.env.ARGUS_PR_HEAD_SHA;
    delete process.env.ARGUS_REDACT_SENSITIVE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of GH_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  function captureFetch() {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method, body: opts.body });
      return method === 'GET'
        ? { ok: true, status: 200, json: async () => [], text: async () => '[]' }
        : { ok: true, status: 201, json: async () => ({ id: 1001 }), text: async () => '{"id":1001}' };
    }));
    return calls;
  }

  it('the posted PR comment body never carries a secret + shows the 🔒 redaction notice', async () => {
    process.env.GITHUB_TOKEN = 'ghp_sink_token_value';
    const calls = captureFetch();
    const out = await reportPrValidation(prResult([sensitiveFinding(), benignFinding()]), { prUrl: 'https://github.com/acme/shop/pull/7' });
    expect(out.posted).toBe(true);
    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeTruthy();
    expect(leaksAnySecret(post.body)).toBe(false);
    expect(post.body).not.toContain('ghp_sink_token_value'); // token only in the Authorization header
    expect(post.body).toContain('🔒');                        // redaction notice rendered
    expect(post.body).toContain('missing a descriptive');     // benign message survives
  });

  it('opt-out lets the raw secret reach the comment body — non-vacuity guard', async () => {
    process.env.GITHUB_TOKEN = 'ghp_sink_token_value';
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    const calls = captureFetch();
    await reportPrValidation(prResult([sensitiveFinding()]), { prUrl: 'https://github.com/acme/shop/pull/7' });
    const post = calls.find((c) => c.method === 'POST');
    expect(leaksAnySecret(post.body)).toBe(true);
  });
});

describe('Aegis Step 6 — GitHub runCrawl egress guard (reportToGitHub)', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of GH_ENV) saved[k] = process.env[k];
    process.env.GITHUB_TOKEN = 'ghp_runcrawl_token';
    process.env.GITHUB_REPOSITORY = 'acme/shop';
    process.env.GITHUB_PR_NUMBER = '7';
    delete process.env.GITHUB_SHA;
    delete process.env.ARGUS_PR_HEAD_SHA;
    delete process.env.ARGUS_REDACT_SENSITIVE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of GH_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('a step-3c-tagged sensitive finding never reaches the PR comment body', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method, body: opts.body });
      return method === 'GET'
        ? { ok: true, status: 200, json: async () => [], text: async () => '[]' }
        : { ok: true, status: 201, json: async () => ({ id: 1 }), text: async () => '{}' };
    }));
    // Simulate the tagged report shape processReport step-3c produces (sensitive:true on the finding).
    const tagged = { ...sensitiveFinding(), sensitive: true, sensitivityReasons: ['category:security_no_https', 'secret:jwt'] };
    await reportToGitHub(reportWith([tagged]), { isFirstRun: false, resolvedCount: 0, flowResolvedCount: 0 });
    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeTruthy();
    expect(leaksAnySecret(post.body)).toBe(false);
  });
});

// ── HTML (html-reporter.js — Step 7) ──────────────────────────────────────────

const { generateHtmlReport } = await import('../../src/utils/html-reporter.js');

describe('Aegis Step 7 — hosted HTML egress guard (generateHtmlReport)', () => {
  let dir;
  const saved = {};
  beforeEach(() => {
    saved.ARGUS_REDACT_SENSITIVE = process.env.ARGUS_REDACT_SENSITIVE;
    saved.ARGUS_REDACT_HTML = process.env.ARGUS_REDACT_HTML;
    delete process.env.ARGUS_REDACT_SENSITIVE;
    delete process.env.ARGUS_REDACT_HTML;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-html-'));
  });
  afterEach(() => {
    if (saved.ARGUS_REDACT_SENSITIVE === undefined) delete process.env.ARGUS_REDACT_SENSITIVE; else process.env.ARGUS_REDACT_SENSITIVE = saved.ARGUS_REDACT_SENSITIVE;
    if (saved.ARGUS_REDACT_HTML === undefined) delete process.env.ARGUS_REDACT_HTML; else process.env.ARGUS_REDACT_HTML = saved.ARGUS_REDACT_HTML;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function writeReport() {
    const rp = path.join(dir, 'error-report-x.json');
    fs.writeFileSync(rp, JSON.stringify(reportWith([sensitiveFinding(), benignFinding()]), null, 2));
    return rp;
  }

  it('external:true render strips secrets but keeps the benign message; the on-disk JSON stays raw', () => {
    const rp = writeReport();
    const htmlPath = generateHtmlReport(rp, { external: true });
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(leaksAnySecret(html)).toBe(false);
    expect(html).toContain('missing a descriptive');
    // local fidelity: the source JSON still contains the raw secret
    expect(leaksAnySecret(fs.readFileSync(rp, 'utf8'))).toBe(true);
  });

  it('default local render keeps full fidelity (raw secret present) — non-vacuity guard', () => {
    const rp = writeReport();
    const html = fs.readFileSync(generateHtmlReport(rp), 'utf8'); // no opts, CI unset → local mode
    expect(leaksAnySecret(html)).toBe(true);
  });

  it('ARGUS_REDACT_HTML=1 forces redaction even for the bare (local) call', () => {
    process.env.ARGUS_REDACT_HTML = '1';
    const rp = writeReport();
    const html = fs.readFileSync(generateHtmlReport(rp), 'utf8');
    expect(leaksAnySecret(html)).toBe(false);
  });
});

// ── CLI logs / step summary (cli/pr-validate.js — Step 7) ─────────────────────

const { buildStepSummary, safeFindingLine } = await import('../../src/cli/pr-validate.js');

describe('Aegis Step 7 — CI step summary + safeFindingLine (pr-validate.js)', () => {
  const saved = {};
  beforeEach(() => { saved.v = process.env.ARGUS_REDACT_SENSITIVE; delete process.env.ARGUS_REDACT_SENSITIVE; });
  afterEach(() => { if (saved.v === undefined) delete process.env.ARGUS_REDACT_SENSITIVE; else process.env.ARGUS_REDACT_SENSITIVE = saved.v; });

  function summaryWith(findings) {
    return buildStepSummary({
      blocked: true,
      summary: { critical: 1, warning: 1, info: 0 },
      affectedRoutes: [{ path: '/login' }],
      perRoute: [{ route: '/login', critical: 1, warning: 1, info: 0 }],
      findings,
      changedFiles: ['src/pages/login.tsx'],
      blockOn: 'critical',
    });
  }

  it('the step summary never carries a secret; benign message + finding type survive', () => {
    const md = summaryWith([shortSensitive(), benignFinding()]);
    expect(leaksAnySecret(md)).toBe(false);
    expect(md).toContain('seo_title_missing');           // type column survives
    expect(md).toContain('missing a descriptive');       // benign message survives
  });

  it('safeFindingLine strips the url query token + the message secret', () => {
    const { message, url } = safeFindingLine(sensitiveFinding());
    expect(leaksAnySecret(message)).toBe(false);
    expect(url).not.toContain('session=');               // query stripped
    expect(url.startsWith('http://app.internal:8080/login')).toBe(true);
  });

  it('opt-out lets the raw secret reach the step summary — non-vacuity guard', () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    const md = summaryWith([shortSensitive()]);
    expect(leaksAnySecret(md)).toBe(true);
  });
});
