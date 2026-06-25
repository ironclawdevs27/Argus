/**
 * Deploy-preview URL auto-detection (PR Validator D3).
 *
 * Resolves the audit TARGET URL for a PR run, preferring a per-PR deploy preview
 * (Vercel / Netlify / any GitHub Deployment) over the static TARGET_DEV_URL, and ALWAYS
 * degrading gracefully to TARGET_DEV_URL when no preview is found or any detection step
 * fails. Detection never throws and never blocks the run — a wrong/failed/missing preview
 * must never silently audit the wrong app, so only a SUCCESS deploy-status URL for the PR's
 * head SHA is ever adopted; everything else falls back.
 *
 * Resolution precedence (resolveTargetUrl):
 *   1. explicitTarget    — an explicit per-call target (MCP tool `targetUrl` arg). Highest;
 *                          passed through raw (explicit caller intent, like TARGET_DEV_URL).
 *   2. ARGUS_PREVIEW_URL  — explicit env override (opt-in by being set). Provider env vars
 *                          DEPLOY_PRIME_URL (Netlify) + VERCEL_URL (Vercel, bare host) are
 *                          also recognized for convenience.
 *   3. auto-detected preview from the PR head SHA's GitHub Deployments — OPT-IN:
 *      ARGUS_PREVIEW_DETECT truthy + a token + a head SHA + a parseable PR URL. One+one
 *      GitHub API call, fully fail-safe (any error → no preview → fallback).
 *   4. TARGET_DEV_URL (or http://localhost:3000) — the conservative fallback, byte-identical
 *      to the pre-D3 behaviour when nothing above matches.
 *
 * Pure helpers (Chrome-free, network-free) + one fail-safe async fetch. Imported (transitively)
 * by the MCP server → nothing here writes to stdout (logs go to the injected/childLogger).
 * No AI verdict — pure static/heuristic resolution (OSS side of the argus-pro boundary).
 */

import { parsePrUrl } from './pr-diff-analyzer.js';
import { childLogger } from './logger.js';

const logger = childLogger('deploy-preview');

const GITHUB_API   = 'https://api.github.com';
const FETCH_TIMEOUT = 10000;

// Env vars (priority order) that may carry an explicit preview URL. ARGUS_PREVIEW_URL is the
// portable, Argus-namespaced canonical; the rest are provider conventions surfaced for users
// who forward them into the runner. VERCEL_URL is a bare host (no scheme) — normalized below.
const ENV_PREVIEW_VARS = ['ARGUS_PREVIEW_URL', 'DEPLOY_PRIME_URL', 'VERCEL_URL'];

/**
 * Trim a candidate URL and accept it only if it carries an http(s) scheme.
 * Returns the trimmed URL or null (never throws). Untrusted/auto-detected URLs flow through
 * this; explicit caller targets (the MCP arg, TARGET_DEV_URL) are passed through raw.
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeUrl(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * Pick an explicit preview URL from the environment, honouring ENV_PREVIEW_VARS priority.
 * VERCEL_URL is a bare host → prefixed with https:// before validation.
 * @param {Record<string,string|undefined>} env
 * @returns {{ url: string, source: string }|null}
 */
export function pickPreviewFromEnv(env = {}) {
  for (const name of ENV_PREVIEW_VARS) {
    let raw = env[name];
    if (raw == null || String(raw).trim() === '') continue;
    // VERCEL_URL is conventionally a bare host (e.g. my-app-git-pr.vercel.app).
    if (name === 'VERCEL_URL' && !/^https?:\/\//i.test(String(raw).trim())) {
      raw = `https://${String(raw).trim()}`;
    }
    const url = normalizeUrl(raw);
    if (url) return { url, source: `env:${name}` };
    logger.warn(`[ARGUS] D3: ${name} is set but not a valid http(s) URL — ignoring`);
  }
  return null;
}

/**
 * Heuristic: is a GitHub Deployment object a PR/preview deployment (not production)?
 * Recognizes Vercel ("Preview – <project>"), Netlify ("deploy-preview"), and any explicitly
 * non-production / transient environment. Production deployments are excluded.
 * @param {object} deployment
 * @returns {boolean}
 */
export function isPreviewDeployment(deployment) {
  if (!deployment || typeof deployment !== 'object') return false;
  const env = String(deployment.environment ?? '');
  // Explicit production → never a preview target.
  if (deployment.production_environment === true || /production/i.test(env)) return false;
  return (
    /preview|deploy[\s-]?preview|staging/i.test(env) ||
    deployment.transient_environment === true ||
    deployment.production_environment === false
  );
}

/**
 * From a list of GitHub Deployments (newest-first, as the API returns them), pick the most
 * recent preview deployment, or null when none qualify.
 * @param {Array<object>} deployments
 * @returns {object|null}
 */
export function pickPreviewDeployment(deployments) {
  if (!Array.isArray(deployments)) return null;
  return deployments.find(isPreviewDeployment) ?? null;
}

/**
 * From a deployment's statuses (newest-first), return the live preview URL — the
 * environment_url (preferred) or target_url of the most recent SUCCESS status — or null.
 * Only a `success` status is adopted: a failed / error / pending / inactive deploy must
 * never become the audit target (auditing a broken or stale preview would be a false result).
 * @param {Array<object>} statuses
 * @returns {string|null}
 */
export function previewUrlFromStatuses(statuses) {
  if (!Array.isArray(statuses)) return null;
  for (const s of statuses) {
    if (!s || s.state !== 'success') continue;
    const url = normalizeUrl(s.environment_url) ?? normalizeUrl(s.target_url);
    if (url) return url;
  }
  return null;
}

async function ghGet(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch the live preview URL for a PR head SHA via the GitHub Deployments API. Fully
 * fail-safe: ANY failure (no SHA, non-2xx, network error, no preview deployment, no success
 * status) resolves to null so the caller degrades to TARGET_DEV_URL. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.sha    PR head SHA (NOT the merge commit)
 * @param {string} [opts.token] GitHub token
 * @returns {Promise<string|null>}
 */
export async function fetchPreviewUrlFromDeployments({ owner, repo, sha, token } = {}) {
  try {
    if (!owner || !repo || !sha) return null;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'argusqa-os',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const deployments = await ghGet(
      `${GITHUB_API}/repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(sha)}&per_page=30`,
      headers,
    );
    const dep = pickPreviewDeployment(deployments);
    if (!dep) return null;
    const statuses = await ghGet(
      `${GITHUB_API}/repos/${owner}/${repo}/deployments/${dep.id}/statuses?per_page=30`,
      headers,
    );
    return previewUrlFromStatuses(statuses);
  } catch (err) {
    // Detection is best-effort — a probe failure must degrade to TARGET_DEV_URL, never break
    // the run. The token never rides into the message (err.message is GitHub's text only).
    logger.warn(`[ARGUS] D3: deploy-preview detection failed — ${err.message}`);
    return null;
  }
}

/**
 * Resolve the audit target URL for a PR run (D3). See the module header for precedence.
 * Always resolves (never throws); `source` records which rung won, for logging/visibility.
 *
 * @param {object} opts
 * @param {Record<string,string|undefined>} opts.env  the process env (or a test object)
 * @param {string} [opts.explicitTarget] an explicit per-call target (MCP `targetUrl` arg)
 * @param {string} [opts.prUrl]
 * @param {string} [opts.headSha]
 * @param {string} [opts.token]
 * @returns {Promise<{ url: string, source: string }>}
 */
export async function resolveTargetUrl({ env = {}, explicitTarget, prUrl, headSha, token } = {}) {
  // The conservative fallback — passed through RAW (explicit operator intent), so the default
  // path is byte-identical to the pre-D3 `TARGET_DEV_URL ?? 'http://localhost:3000'`.
  const fallback = env.TARGET_DEV_URL ?? 'http://localhost:3000';

  // 1. Explicit per-call target (MCP arg) — raw, highest precedence.
  if (explicitTarget != null && String(explicitTarget).trim() !== '') {
    return { url: explicitTarget, source: 'explicit' };
  }

  // 2. Explicit env override (ARGUS_PREVIEW_URL / provider env vars).
  const envPick = pickPreviewFromEnv(env);
  if (envPick) return envPick;

  // 3. Auto-detect from GitHub Deployments — opt-in + fully fail-safe.
  const detectOn = /^(1|true|yes|on)$/i.test(env.ARGUS_PREVIEW_DETECT || '');
  if (detectOn && token && headSha && prUrl) {
    try {
      const { owner, repo } = parsePrUrl(prUrl);
      const url = await fetchPreviewUrlFromDeployments({ owner, repo, sha: headSha, token });
      if (url) return { url, source: 'deployment' };
    } catch {
      // parsePrUrl or detection threw — degrade silently to the fallback below.
    }
  }

  // 4. Conservative fallback.
  return { url: fallback, source: 'target-dev-url' };
}
