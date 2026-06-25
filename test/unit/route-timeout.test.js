/**
 * Unit tests for the per-route audit timeout/retry primitives (Phase D4).
 *
 * Chrome-free and network-free. The load-bearing invariants the PR Validator depends on are:
 *   1. withTimeout REJECTS on timeout — it never resolves on a hung audit, so a timed-out route
 *      can never become a silent zero-findings pass (a false PASS);
 *   2. auditRouteWithRetry retries a transient failure then succeeds, and THROWS (fail-loud)
 *      once every attempt has timed out / errored — the throw is what the caller records as a
 *      route error;
 *   3. routeResilienceFromEnv resolves a SAFE, bounded default (120000 ms) and clamps inputs;
 *   4. allRoutesFailed trips only when EVERY audited route errored — so an unreachable app /
 *      all-timed-out run blocks, while a partial failure does not over-block.
 */
import { describe, it, expect } from 'vitest';
import {
  withTimeout, auditRouteWithRetry, routeResilienceFromEnv,
} from '../../src/utils/parallel-crawler.js';
import { allRoutesFailed, prExitCode } from '../../src/cli/pr-validate.js';

const never = () => new Promise(() => {});            // a promise that never settles
const after = (ms, val) => new Promise(r => setTimeout(() => r(val), ms));

describe('withTimeout', () => {
  it('REJECTS (never resolves) when the work exceeds the bound', async () => {
    await expect(withTimeout(never(), 20, 'Route audit /x')).rejects.toThrow(/Route audit \/x timed out after 20ms/);
  });

  it('resolves with the value when the work finishes in time', async () => {
    await expect(withTimeout(after(5, 'done'), 200)).resolves.toBe('done');
  });

  it('accepts a thunk and runs it, converting a synchronous throw into a rejection', async () => {
    await expect(withTimeout(() => after(5, 42), 200)).resolves.toBe(42);
    await expect(withTimeout(() => { throw new Error('sync boom'); }, 200)).rejects.toThrow('sync boom');
  });

  it('propagates a thrown audit error (not just timeouts)', async () => {
    await expect(withTimeout(Promise.reject(new Error('audit failed')), 200)).rejects.toThrow('audit failed');
  });

  it('is unbounded when ms <= 0 or non-finite (passes the work through)', async () => {
    await expect(withTimeout(after(5, 'a'), 0)).resolves.toBe('a');
    await expect(withTimeout(after(5, 'b'), -1)).resolves.toBe('b');
    await expect(withTimeout(after(5, 'c'), NaN)).resolves.toBe('c');
  });

  it('a resolving-in-time work never spuriously rejects under a generous bound', async () => {
    // Run several to make a leaked/misfiring timer surface as a flake.
    const out = await Promise.all([1, 2, 3].map(n => withTimeout(after(3, n), 500)));
    expect(out).toEqual([1, 2, 3]);
  });
});

describe('auditRouteWithRetry', () => {
  it('returns the result on first success (default = 1 attempt, no timeout)', async () => {
    let calls = 0;
    const out = await auditRouteWithRetry(async () => { calls++; return 'ok'; });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient failure then succeeds, firing onRetry each retry', async () => {
    let calls = 0;
    const retried = [];
    const out = await auditRouteWithRetry(
      async () => { calls++; if (calls < 3) throw new Error(`fail ${calls}`); return 'recovered'; },
      { retries: 3, onRetry: (attempt, err) => retried.push(`${attempt}:${err.message}`) },
    );
    expect(out).toBe('recovered');
    expect(calls).toBe(3);                       // failed twice, succeeded on the third
    expect(retried).toEqual(['1:fail 1', '2:fail 2']);
  });

  it('THROWS the last error after exhausting attempts (fail-loud)', async () => {
    let calls = 0;
    await expect(auditRouteWithRetry(
      async () => { calls++; throw new Error(`attempt ${calls}`); },
      { retries: 2 },
    )).rejects.toThrow('attempt 3');             // total attempts = retries + 1
    expect(calls).toBe(3);
  });

  it('THROWS a timeout when every attempt times out (the value that feeds the route-error path)', async () => {
    let starts = 0;
    await expect(auditRouteWithRetry(
      () => { starts++; return never(); },
      { timeoutMs: 15, retries: 1, label: 'Route audit /slow' },
    )).rejects.toThrow(/Route audit \/slow timed out after 15ms/);
    expect(starts).toBe(2);                      // first attempt + 1 retry
  });

  it('a logging onRetry that throws never breaks the retry loop', async () => {
    let calls = 0;
    const out = await auditRouteWithRetry(
      async () => { calls++; if (calls < 2) throw new Error('x'); return 'ok'; },
      { retries: 2, onRetry: () => { throw new Error('logger blew up'); } },
    );
    expect(out).toBe('ok');
  });

  it('rejects a non-function auditFn', async () => {
    await expect(auditRouteWithRetry('not a fn')).rejects.toThrow(TypeError);
  });
});

describe('routeResilienceFromEnv', () => {
  it('defaults to a bounded 120000 ms timeout and 0 retries when unset', () => {
    expect(routeResilienceFromEnv({})).toEqual({ timeoutMs: 120000, retries: 0 });
  });

  it('reads an explicit timeout + retries', () => {
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_TIMEOUT_MS: '5000', ARGUS_ROUTE_RETRIES: '2' }))
      .toEqual({ timeoutMs: 5000, retries: 2 });
  });

  it('treats an explicit 0 / negative timeout as unbounded', () => {
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_TIMEOUT_MS: '0' }).timeoutMs).toBe(0);
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_TIMEOUT_MS: '-1' }).timeoutMs).toBe(0);
  });

  it('falls back to the safe 120000 default on a non-numeric timeout', () => {
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(120000);
  });

  it('clamps retries to 0–5', () => {
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_RETRIES: '99' }).retries).toBe(5);
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_RETRIES: '-3' }).retries).toBe(0);
    expect(routeResilienceFromEnv({ ARGUS_ROUTE_RETRIES: 'xx' }).retries).toBe(0);
  });
});

describe('allRoutesFailed (the all-routes-failed guard)', () => {
  it('blocks when EVERY audited route errored (unreachable app / all timed out)', () => {
    expect(allRoutesFailed([{ route: '/', error: 'timed out after 120000ms' }])).toBe(true);
    expect(allRoutesFailed([{ error: 'a' }, { error: 'b' }])).toBe(true);
  });

  it('does NOT trip on a clean route or a partial failure', () => {
    expect(allRoutesFailed([{ route: '/', critical: 0 }])).toBe(false);
    expect(allRoutesFailed([{ error: 'a' }, { route: '/b', critical: 0 }])).toBe(false);
  });

  it('returns false for an empty or non-array input', () => {
    expect(allRoutesFailed([])).toBe(false);
    expect(allRoutesFailed(undefined)).toBe(false);
    expect(allRoutesFailed(null)).toBe(false);
  });
});

describe('prExitCode (the decision → merge-gate exit-code mapping, E3)', () => {
  it('exits 1 when blocked, 0 when a completed audit passed', () => {
    expect(prExitCode({ blocked: true })).toBe(1);
    expect(prExitCode({ blocked: false })).toBe(0);
  });

  it('exits 1 when the audit failed (all routes errored / startup error) regardless of blocked', () => {
    expect(prExitCode({ failed: true })).toBe(1);
    expect(prExitCode({ blocked: false, failed: true })).toBe(1);
    expect(prExitCode({ blocked: true, failed: false })).toBe(1);
  });

  it('defaults to a passing 0 when called with nothing / neither flag', () => {
    expect(prExitCode()).toBe(0);
    expect(prExitCode({})).toBe(0);
  });

  it('ties to the all-routes-failed guard: every route errored → failed → exit 1; partial → 0', () => {
    const allErr  = allRoutesFailed([{ error: 'a' }, { error: 'b' }]);
    const partial = allRoutesFailed([{ error: 'a' }, { route: '/b', critical: 0 }]);
    expect(prExitCode({ failed: allErr })).toBe(1);
    expect(prExitCode({ failed: partial })).toBe(0);
  });
});

describe('end-to-end: a timed-out only-route blocks (the D4 acceptance)', () => {
  it('records a hung audit as a route error and trips allRoutesFailed', async () => {
    // Replicates the CLI per-route flow: a single route whose audit hangs is bounded, throws,
    // and is recorded as a route error → allRoutesFailed → merge blocked. Never a false PASS.
    const perRoute = [];
    try {
      await auditRouteWithRetry(() => never(), { timeoutMs: 20, label: 'Route audit /only' });
      perRoute.push({ route: '/only', critical: 0, warning: 0, info: 0 });          // would be a false pass
    } catch (err) {
      perRoute.push({ route: '/only', critical: 0, warning: 0, info: 0, error: err.message });
    }
    expect(perRoute[0].error).toMatch(/timed out after 20ms/);
    expect(allRoutesFailed(perRoute)).toBe(true);
  });
});
