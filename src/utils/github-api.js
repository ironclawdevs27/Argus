/**
 * Shared resilient GitHub REST client for the PR Validator (Phase E2).
 *
 * One place that BOTH GitHub throw-path callers route through — fetchPrFiles
 * (pr-diff-analyzer.js, the PR diff) and ghFetch (github-reporter.js, the PR
 * comment / Check Run) — so the two paths can never diverge on resilience.
 * Mirrors the "one shared decision" discipline of decidePrBlock (B1) /
 * selectAnalyzers (D2) / resolveTargetUrl (D3) / routeResilienceFromEnv (D4).
 *
 * What it does:
 *   - retries a 403 PRIMARY rate-limit (X-RateLimit-Remaining: 0), a 403/429
 *     SECONDARY rate-limit (Retry-After), a transient 5xx, and a network error,
 *     with backoff that honours Retry-After / X-RateLimit-Reset when present;
 *   - NEVER retries a 401 / 404 / 422 / plain-403 (permissions) — those are
 *     terminal and throw a structured, cause-carrying error immediately;
 *   - keeps every thrown message SECRET-FREE: the token rides only in request
 *     headers (never the response body), and scrubSecrets() defensively redacts
 *     any Bearer / ghp_ / github_pat_ token that somehow appears in a body.
 *
 * deploy-preview.js's Deployments probe is deliberately NOT routed through here:
 * it is fail-safe-to-null + opt-in (D3) and must degrade fast, not retry.
 *
 * Pure helpers + one fetch wrapper. No Chrome, no MCP, no AI verdict. Imported
 * (transitively) by the MCP server → nothing here writes to stdout.
 */

/** Default per-request timeout (ms) — matches the prior ghFetch behaviour. */
const DEFAULT_TIMEOUT_MS = 15000;
/** Default backoff base (ms) for the exponential fallback. */
const DEFAULT_BASE_MS = 1000;
/**
 * Cap on any single backoff wait (ms). A far-future X-RateLimit-Reset (the GitHub
 * primary-limit window can be up to an hour) must NOT hang CI for the whole window —
 * we cap, retry sooner, and fail loud if still limited. A capped retry that throws a
 * clear "rate limit exceeded — retries exhausted" beats a multi-minute silent stall.
 */
const DEFAULT_MAX_MS = 8000;
/** Default total attempts (1 initial + 2 retries). */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Read a header case-insensitively from a Headers object (fetch Response.headers,
 * which exposes .get()) OR a plain object (used by test stubs). Returns the string
 * value or undefined — never throws on a missing/odd headers bag.
 *
 * @param {Headers|Record<string,string>|undefined} headers
 * @param {string} name
 * @returns {string|undefined}
 */
export function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(key) ?? undefined;
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === key) return headers[k];
  }
  return undefined;
}

/**
 * Redact any GitHub token shape from a string. The token is sent only in request
 * headers, so a response body never contains it — this is belt-and-suspenders so a
 * thrown error message can NEVER leak a credential even if a body echoes one.
 *
 * @param {*} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')   // fine-grained PAT (has underscores)
    .replace(/\bgh[posru]_[A-Za-z0-9_]{10,}/g, '***');   // ghp_ gho_ ghs_ ghr_ ghu_
}

/**
 * Classify a response as a GitHub rate-limit (so it should be retried with backoff).
 *   - 429                                   → always a rate-limit (secondary).
 *   - 403 with X-RateLimit-Remaining === 0  → primary rate-limit exhausted.
 *   - 403 with a Retry-After header          → secondary rate-limit.
 * A plain 403 with no rate-limit signal is a PERMISSIONS error — not retried.
 *
 * @param {number} status
 * @param {Headers|Record<string,string>|undefined} headers
 * @returns {boolean}
 */
export function isRateLimitResponse(status, headers) {
  if (status === 429) return true;
  if (status === 403) {
    const remaining = headerValue(headers, 'x-ratelimit-remaining');
    if (remaining !== undefined && remaining !== null && Number(remaining) === 0) return true;
    if (headerValue(headers, 'retry-after') !== undefined) return true;
  }
  return false;
}

/**
 * Compute the backoff (ms) before the next attempt. Honours GitHub's explicit
 * signals first (Retry-After seconds, then X-RateLimit-Reset epoch seconds),
 * falling back to exponential backoff. Every result is capped at maxMs.
 *
 * @param {number} status   HTTP status (0 for a network error)
 * @param {Headers|Record<string,string>|undefined} headers
 * @param {number} attempt  1-based attempt number that just failed
 * @param {{ baseMs?: number, maxMs?: number, now?: () => number }} [opts]
 * @returns {number}
 */
export function retryDelayMs(status, headers, attempt, opts = {}) {
  const { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS, now = Date.now } = opts;

  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== '') {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, maxMs);
  }

  if (isRateLimitResponse(status, headers)) {
    const reset = headerValue(headers, 'x-ratelimit-reset');
    if (reset !== undefined) {
      const resetMs = Number(reset) * 1000 - now();
      if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(resetMs, maxMs);
    }
  }

  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, maxMs);
}

/**
 * Build a structured, secret-free error message for a TERMINAL (non-retried)
 * GitHub response. Carries the cause (status + a short, scrubbed body) and a
 * human hint for the common cases — never the token, never "is not defined".
 *
 * @param {number} status
 * @param {string} [statusText]
 * @param {string} [bodyText]
 * @param {string} [context]  e.g. "GET /repos/o/r/pulls/7/files"
 * @returns {string}
 */
export function classifyGitHubError(status, statusText, bodyText, context) {
  const ctx  = context ? ` (${context})` : '';
  const body = scrubSecrets(String(bodyText ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);
  const tail = body ? `: ${body}` : (statusText ? `: ${statusText}` : '');
  switch (status) {
    case 401:
      return `GitHub API 401 (bad credentials)${ctx} — the token is missing, invalid, or expired${tail}`;
    case 403:
      return `GitHub API 403 (forbidden)${ctx} — the token lacks the required scope or resource access${tail}`;
    case 404:
      return `GitHub API 404 (not found)${ctx} — check the repository and PR exist and the token can access them${tail}`;
    case 422:
      return `GitHub API 422 (unprocessable)${ctx} — GitHub rejected the request${tail}`;
    default:
      return `GitHub API ${status}${ctx}${tail}`;
  }
}

async function safeText(res) {
  try {
    return res && typeof res.text === 'function' ? await res.text() : '';
  } catch {
    return '';
  }
}

/**
 * Resilient GitHub REST request. Resolves to the OK Response (caller reads
 * .json() / paginates) or THROWS a structured, secret-free Error. See the module
 * header for the retry vs throw policy.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {Record<string,string>} [opts.headers]
 * @param {string} [opts.body]              already-serialised body (or undefined)
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.baseMs=1000]
 * @param {number} [opts.maxMs=8000]
 * @param {number} [opts.timeoutMs=15000]   per-attempt timeout; <=0 disables
 * @param {(ms:number)=>Promise<void>} [opts.sleep]  injectable for tests
 * @param {()=>number} [opts.now]           injectable clock for backoff math
 * @param {(url:string,init:object)=>Promise<Response>} [opts.fetchImpl]
 * @param {string} [opts.context]           label woven into error messages
 * @returns {Promise<Response>}
 */
export async function githubFetch(url, opts = {}) {
  const {
    method = 'GET', headers, body,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS, timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    now = Date.now,
    fetchImpl,
    context,
  } = opts;

  const doFetch = fetchImpl ?? ((u, init) => fetch(u, init));
  const ctx = context ? ` (${context})` : '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await doFetch(url, {
        method, headers, body,
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      // Network error / timeout — retry with backoff, else fail loud (secret-free).
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(0, null, attempt, { baseMs, maxMs, now }));
        continue;
      }
      throw new Error(scrubSecrets(`GitHub API request failed${ctx}: ${err.message}`));
    }

    if (res.ok) return res;

    const status = res.status;
    const rateLimited = isRateLimitResponse(status, res.headers);
    const transient = rateLimited || status >= 500;

    if (transient && attempt < maxAttempts) {
      await sleep(retryDelayMs(status, res.headers, attempt, { baseMs, maxMs, now }));
      continue;
    }

    // Terminal: read the body once and throw a structured, secret-free error.
    const bodyText = await safeText(res);
    if (rateLimited) {
      const body = scrubSecrets(String(bodyText ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);
      throw new Error(
        `GitHub API ${status} (rate limit exceeded)${ctx} — retries exhausted after ${attempt} attempt(s)` +
        (body ? `: ${body}` : ''),
      );
    }
    throw new Error(classifyGitHubError(status, res.statusText, bodyText, context));
  }

  // Defensive — the loop above always returns or throws.
  throw new Error(`GitHub API request failed${ctx} — retries exhausted`);
}
