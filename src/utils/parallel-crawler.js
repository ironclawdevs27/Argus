/**
 * Argus D7.3 — Parallel route crawling: chunkArray utility.
 * Exported separately so test-harness/validate.js can exercise it without
 * importing crawl-and-report.js (which has heavyweight module-level side effects).
 */

/**
 * Split arr into at most n non-empty chunks of roughly equal size.
 *
 * Uses ceiling division so earlier chunks are at most 1 element larger than
 * later ones. If arr.length < n only arr.length chunks are returned (no empty
 * chunks). If arr is empty, returns [].
 *
 * @param {Array}  arr - Source array (not mutated)
 * @param {number} n   - Target number of chunks (must be > 0)
 * @returns {Array[]}
 */
export function chunkArray(arr, n) {
  // Validate inputs — arr.length throws on undefined; non-integer n produces
  // fractional chunk sizes that silently skip elements or create unexpected extra chunks.
  if (!Array.isArray(arr)) throw new TypeError('chunkArray: arr must be an array');
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('chunkArray: n must be a positive integer');
  if (arr.length === 0) return [];
  const size = Math.ceil(arr.length / Math.min(n, arr.length));
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// NOTE: this module is imported by mcp-server.js (via the PR-validate path) and by the
// orchestrator. It MUST stay stdout-clean (no console.log) — stdout is reserved for JSON-RPC.

/**
 * Map `worker` over `items` with bounded concurrency, returning results in INPUT order
 * (results[i] ⟷ items[i]) regardless of completion order — so the output is identical to a
 * sequential `for…of` map. This is the safety property the PR Validator relies on: the
 * aggregate findings and the merge-block decision must not depend on how routes interleave.
 *
 * Spawns exactly `min(concurrency, items.length)` persistent lanes; each lane repeatedly pulls
 * the next item from a shared cursor (the read-then-increment `cursor++` is atomic on the
 * single-threaded event loop — there is no await between the read and the bump, so two lanes can
 * never claim the same index). The lane index (0…lanes-1) is passed to `worker` so a caller can
 * pin a per-lane resource — e.g. one Chrome client per lane — and be sure it is never used by two
 * items at once.
 *
 * Errors: if a `worker` call rejects, its result slot is left `undefined`, the OTHER in-flight
 * items still drain to completion, and the FIRST rejection is re-thrown after every lane finishes
 * (fail-loud — a parallel error is never silently dropped). Callers that need per-item error
 * handling (e.g. recording a per-route audit failure) should catch inside `worker` and return an
 * error marker instead of throwing.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency  max parallel workers; effective lanes = min(concurrency, items.length)
 * @param {(item: T, index: number, lane: number) => Promise<R>} worker
 * @returns {Promise<R[]>} results in input order
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items)) throw new TypeError('mapWithConcurrency: items must be an array');
  if (typeof worker !== 'function') throw new TypeError('mapWithConcurrency: worker must be a function');
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('mapWithConcurrency: concurrency must be a positive integer');
  }

  const results = new Array(items.length);
  if (items.length === 0) return results;

  const lanes = Math.min(concurrency, items.length);
  let cursor = 0;
  let firstError = null;

  async function runLane(lane) {
    for (let index = cursor++; index < items.length; index = cursor++) {
      try {
        results[index] = await worker(items[index], index, lane);
      } catch (err) {
        if (firstError === null) firstError = err;
        // keep draining the remaining items so siblings finish; this slot stays undefined
      }
    }
  }

  await Promise.all(Array.from({ length: lanes }, (_unused, lane) => runLane(lane)));
  if (firstError !== null) throw firstError;
  return results;
}

/**
 * Audit `routes` with bounded concurrency, giving each lane its OWN client, and return the
 * per-route results in INPUT (route) order — identical to a sequential crawl.
 *
 * `crawlRouteCheap` mutates page-navigation state, so two concurrent crawls must never share a
 * Chrome connection. This wrapper allocates one client per lane: lane 0 reuses `primaryClient`
 * (the already-open connection); lanes 1…n-1 each get a fresh client from `createClient()`.
 * Because a lane processes one route at a time, a given client is never used by two routes at
 * once. The extra clients are always closed in a `finally` (via `closeClient`, default
 * `client.close()`); `primaryClient` is owned by the caller and is NOT closed here.
 *
 * `crawlRoute` should handle its own per-route errors (catch + return a marker) so one route's
 * failure does not abort its siblings and the all-routes-failed guard still sees every route.
 *
 * @param {Array} routes  [] returns [] with no clients created
 * @param {object} opts
 * @param {number}   opts.concurrency    desired max parallel clients; lanes = min(concurrency, routes.length)
 * @param {*}        opts.primaryClient  the already-open client used by lane 0
 * @param {() => Promise<*>} opts.createClient  factory for lanes 1…n-1 (only called when lanes > 1)
 * @param {(route: any, client: any, meta: { index: number, lane: number }) => Promise<any>} opts.crawlRoute
 * @param {(client: any) => any} [opts.closeClient]  teardown for the extra clients (default: client.close())
 * @returns {Promise<Array>} results in route order
 */
export async function auditRoutesConcurrently(routes, { concurrency, primaryClient, createClient, crawlRoute, closeClient } = {}) {
  if (!Array.isArray(routes)) throw new TypeError('auditRoutesConcurrently: routes must be an array');
  if (typeof crawlRoute !== 'function') throw new TypeError('auditRoutesConcurrently: crawlRoute must be a function');
  if (routes.length === 0) return [];

  const want  = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const lanes = Math.min(want, routes.length);
  const extraClients = [];
  const close = typeof closeClient === 'function' ? closeClient : (c) => c?.close?.();

  try {
    for (let i = 1; i < lanes; i++) {
      if (typeof createClient !== 'function') {
        throw new TypeError('auditRoutesConcurrently: createClient is required when concurrency > 1');
      }
      extraClients.push(await createClient());
    }
    const clients = [primaryClient, ...extraClients];
    return await mapWithConcurrency(
      routes, lanes,
      (route, index, lane) => crawlRoute(route, clients[lane], { index, lane }),
    );
  } finally {
    for (const client of extraClients) {
      try { await close(client); } catch { /* ignore teardown errors */ }
    }
  }
}

// ── D4 — per-route timeout / retry ────────────────────────────────────────────
// A hung or flaky route audit must surface as a REJECTION, never a silent zero-findings
// resolution — the caller records the rejection as a route ERROR, which feeds the
// all-routes-failed guard (src/cli/pr-validate.js allRoutesFailed). These helpers therefore
// never resolve on timeout; a timed-out audit can never become a false PASS.

/**
 * Race `work` against a timeout. If `ms` elapses before the work settles, the returned promise
 * REJECTS with a timeout Error — it NEVER resolves on timeout. This is the load-bearing safety
 * property of the PR Validator's per-route audit: a hung audit must surface as a rejection
 * (→ recorded as a route ERROR → fed to the all-routes-failed guard), never as a silently
 * passing zero-findings route (a false PASS).
 *
 * A non-finite or non-positive `ms` disables the bound (the work is awaited as-is). The timer is
 * cleared once the work settles so it never keeps the event loop alive; the underlying work is
 * NOT cancelled (there is no abort channel through CDP) — the timer only stops US from waiting.
 *
 * @template R
 * @param {Promise<R> | (() => Promise<R>)} work  a promise, or a thunk returning one (a thunk's
 *   synchronous throw is converted to a rejection)
 * @param {number} ms        timeout in milliseconds (<=0 / non-finite → unbounded)
 * @param {string} [label]   human-readable label used in the timeout message
 * @returns {Promise<R>}
 */
export function withTimeout(work, ms, label = 'operation') {
  // Wrapping a thunk in an async IIFE turns a synchronous throw into a rejection.
  const promise = typeof work === 'function' ? (async () => work())() : Promise.resolve(work);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run a single route audit with a per-attempt timeout and bounded retries. Returns the audit
 * result on the first success; THROWS (fail-loud) if every attempt times out or errors, so the
 * caller's per-route catch records a route ERROR (never a false PASS). With the defaults
 * (1 attempt, unbounded) this is byte-identical to calling `auditFn()` directly.
 *
 * Retries are immediate (no backoff): a route audit re-navigates from a clean state, so a fixed
 * inter-attempt delay would only add wall-clock without changing a deterministic failure. This is
 * deliberately distinct from withRetry() (retry.js), which back-off-retries idempotent CDP ops;
 * a route audit needs a per-ATTEMPT timeout plus a route-scoped retry count.
 *
 * @template R
 * @param {() => Promise<R>} auditFn   the per-route audit, e.g. () => crawlRouteWithDepth(route, …)
 * @param {object} opts
 * @param {number} [opts.timeoutMs=0]  per-attempt timeout (<=0 / non-finite → unbounded)
 * @param {number} [opts.retries=0]    additional attempts after the first (total = retries + 1)
 * @param {string} [opts.label]        label used in the timeout message
 * @param {(attempt: number, err: Error) => void} [opts.onRetry]  invoked before each retry
 * @returns {Promise<R>}
 */
export async function auditRouteWithRetry(auditFn, { timeoutMs = 0, retries = 0, label = 'route audit', onRetry } = {}) {
  if (typeof auditFn !== 'function') throw new TypeError('auditRouteWithRetry: auditFn must be a function');
  const attempts = Math.max(1, Math.floor(Number.isFinite(retries) ? retries : 0) + 1);
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(auditFn, timeoutMs, label);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts && typeof onRetry === 'function') {
        try { onRetry(attempt, err); } catch { /* a logging callback must never break the retry loop */ }
      }
    }
  }
  throw lastErr;
}

/**
 * Resolve the per-route audit timeout + retry policy from the environment. Shared by BOTH
 * PR-validate paths (CLI + the MCP tool) so they cannot diverge on the bound.
 *   ARGUS_ROUTE_TIMEOUT_MS — per-route audit timeout (default 120000 ms; explicit 0 / negative →
 *     unbounded; unset or non-numeric → the 120000 default, the safe bounded direction).
 *   ARGUS_ROUTE_RETRIES    — extra attempts on a failed/timed-out audit (default 0; clamped 0–5).
 * A timed-out audit is recorded as a route ERROR and feeds the all-routes-failed guard — bounding
 * a route can only BLOCK (the conservative direction), never produce a false PASS.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ timeoutMs: number, retries: number }}
 */
export function routeResilienceFromEnv(env = process.env) {
  const rawTimeout = parseInt(env.ARGUS_ROUTE_TIMEOUT_MS, 10);
  const timeoutMs  = Number.isNaN(rawTimeout) ? 120000 : (rawTimeout > 0 ? rawTimeout : 0);
  const rawRetries = parseInt(env.ARGUS_ROUTE_RETRIES, 10);
  const retries    = Number.isNaN(rawRetries) ? 0 : Math.min(5, Math.max(0, rawRetries));
  return { timeoutMs, retries };
}
