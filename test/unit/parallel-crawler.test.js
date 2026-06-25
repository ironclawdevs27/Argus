/**
 * Unit tests for the bounded-concurrency route-auditing primitives (Phase D1).
 *
 * These are Chrome-free and network-free: mapWithConcurrency + auditRoutesConcurrently are
 * exercised with fake async workers and fake clients. The load-bearing invariants the PR
 * Validator depends on are:
 *   1. results come back in INPUT order (identical to a sequential map) — so the aggregate
 *      findings and the merge-block decision never depend on how routes interleave;
 *   2. each lane gets its OWN client and no client is ever used by two routes at once — so
 *      concurrent crawlRouteCheap calls never share a Chrome page-navigation state;
 *   3. the ARGUS_CONCURRENCY default (1) stays strictly sequential with no extra clients
 *      (byte-identical to the prior single-client loop).
 */
import { describe, it, expect } from 'vitest';
import { chunkArray, mapWithConcurrency, auditRoutesConcurrently } from '../../src/utils/parallel-crawler.js';

describe('mapWithConcurrency', () => {
  it('preserves input order even when later items resolve first (identical to sequential)', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const out = await mapWithConcurrency(items, 4, async (n) => {
      // Invert the delay so higher indices finish first — completion order ≠ input order.
      await new Promise(r => setTimeout(r, (items.length - n) * 3));
      return n * 2;
    });
    expect(out).toEqual(items.map(n => n * 2));
  });

  it('bounds concurrency: peak in-flight equals min(concurrency, items.length)', async () => {
    let live = 0, peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 10));
      live--;
    });
    expect(peak).toBe(3);
  });

  it('concurrency=1 runs strictly sequentially (peak 1) and in order', async () => {
    let live = 0, peak = 0;
    const out = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 2));
      live--; return n;
    });
    expect(peak).toBe(1);
    expect(out).toEqual([1, 2, 3]);
  });

  it('clamps concurrency to items.length (3 items, concurrency 10 → peak 3)', async () => {
    let live = 0, peak = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5));
      live--;
    });
    expect(peak).toBe(3);
  });

  it('processes every item exactly once', async () => {
    const seen = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); return n; });
    expect(seen.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.length).toBe(5);
  });

  it('passes a stable lane index within [0, lanes)', async () => {
    const lanes = new Set();
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (_n, _i, lane) => { lanes.add(lane); });
    expect([...lanes].sort()).toEqual([0, 1, 2]);
  });

  it('empty array → [] with no worker calls', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => { calls++; });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('re-throws the first worker error after siblings drain (fail-loud)', async () => {
    let completed = 0;
    await expect(mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom on 2');
      await new Promise(r => setTimeout(r, 5));
      completed++;
      return n;
    })).rejects.toThrow('boom on 2');
    expect(completed).toBe(3); // the other three still ran to completion
  });

  it('rejects invalid concurrency', async () => {
    await expect(mapWithConcurrency([1], 0, async () => {})).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async () => {})).rejects.toThrow(RangeError);
  });
});

describe('auditRoutesConcurrently', () => {
  const routes = [{ path: '/a' }, { path: '/b' }, { path: '/c' }, { path: '/d' }];

  it('gives each lane its own client — no client services two routes at once', async () => {
    const live = new Map();
    const peakPer = new Map();
    let created = 0, closed = 0;
    const out = await auditRoutesConcurrently(routes, {
      concurrency: 3,
      primaryClient: 'C0',
      createClient: async () => `C${++created}`,
      closeClient: () => { closed++; },
      crawlRoute: async (route, client) => {
        const u = (live.get(client) ?? 0) + 1; live.set(client, u);
        peakPer.set(client, Math.max(peakPer.get(client) ?? 0, u));
        await new Promise(r => setTimeout(r, 8));
        live.set(client, live.get(client) - 1);
        return route.path;
      },
    });
    expect(Math.max(...peakPer.values())).toBe(1); // never two routes on one client
    expect(created).toBe(2);                        // lanes - 1
    expect(closed).toBe(2);                         // every extra client torn down
    expect(out).toEqual(['/a', '/b', '/c', '/d']);  // input (route) order
  });

  it('concurrency=1 → no extra clients, only the primary used, order preserved', async () => {
    let created = 0;
    const seen = new Set();
    const out = await auditRoutesConcurrently(routes, {
      concurrency: 1,
      primaryClient: 'PRIMARY',
      createClient: async () => { created++; return `X${created}`; },
      crawlRoute: async (route, client) => { seen.add(client); return route.path; },
    });
    expect(created).toBe(0);
    expect([...seen]).toEqual(['PRIMARY']);
    expect(out).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('creates only routes.length-1 extra clients when routes < concurrency', async () => {
    let created = 0;
    await auditRoutesConcurrently([{ path: '/x' }, { path: '/y' }], {
      concurrency: 5,
      primaryClient: 'P',
      createClient: async () => `c${++created}`,
      crawlRoute: async (route) => route.path,
    });
    expect(created).toBe(1); // 2 routes → 2 lanes → 1 extra client
  });

  it('empty routes → [] and never creates a client', async () => {
    let created = 0;
    const out = await auditRoutesConcurrently([], {
      concurrency: 4,
      primaryClient: 'P',
      createClient: async () => { created++; return 'c'; },
      crawlRoute: async () => 'x',
    });
    expect(out).toEqual([]);
    expect(created).toBe(0);
  });

  it('closes extra clients even when a crawlRoute throws', async () => {
    let closed = 0;
    await expect(auditRoutesConcurrently(routes, {
      concurrency: 2,
      primaryClient: 'C0',
      createClient: async () => 'C1',
      closeClient: () => { closed++; },
      crawlRoute: async (route) => { if (route.path === '/b') throw new Error('crawl failed'); return route.path; },
    })).rejects.toThrow('crawl failed');
    expect(closed).toBe(1); // the 1 extra client is still torn down
  });
});

describe('chunkArray (still backs the orchestrator parallel path)', () => {
  it('splits into contiguous order-preserving chunks', () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6], 3)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
  it('never creates empty chunks when n > length', () => {
    expect(chunkArray([1, 2, 3], 5)).toEqual([[1], [2], [3]]);
  });
  it('empty array → []', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});
