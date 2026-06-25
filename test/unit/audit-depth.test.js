import { describe, it, expect } from 'vitest';
import {
  AUDIT_DEPTHS,
  ALL_EXPENSIVE_ANALYZERS,
  STANDARD_POLICY,
  resolveAuditDepth,
  selectAnalyzers,
  runDepthAnalyzers,
} from '../../src/utils/audit-depth.js';

// The deep-only analyzers — never run by the `standard` tier (slow / flaky / need committed
// state). selectAnalyzers('standard', ...) must NEVER return one of these for any file type.
const DEEP_ONLY = ['lighthouse', 'memory', 'design-fidelity', 'har-recorder'];

describe('resolveAuditDepth', () => {
  it('passes through the three valid tiers', () => {
    expect(resolveAuditDepth('cheap')).toBe('cheap');
    expect(resolveAuditDepth('standard')).toBe('standard');
    expect(resolveAuditDepth('deep')).toBe('deep');
  });

  it('fails safe to cheap for unset / empty / unknown values', () => {
    expect(resolveAuditDepth(undefined)).toBe('cheap');
    expect(resolveAuditDepth(null)).toBe('cheap');
    expect(resolveAuditDepth('')).toBe('cheap');
    expect(resolveAuditDepth('full')).toBe('cheap');   // a tempting-but-invalid value
    expect(resolveAuditDepth('garbage')).toBe('cheap');
    expect(resolveAuditDepth(42)).toBe('cheap');
  });

  it('is case-insensitive and trims', () => {
    expect(resolveAuditDepth('DEEP')).toBe('deep');
    expect(resolveAuditDepth('  Standard  ')).toBe('standard');
  });
});

describe('selectAnalyzers — cheap (default)', () => {
  it('returns [] regardless of changed files (byte-identical to the prior behaviour)', () => {
    expect(selectAnalyzers({ depth: 'cheap', changedFiles: ['app.css', 'Page.tsx'] })).toEqual([]);
    expect(selectAnalyzers({})).toEqual([]);            // depth defaults to cheap
    expect(selectAnalyzers()).toEqual([]);
  });

  it('an invalid depth resolves to cheap → []', () => {
    expect(selectAnalyzers({ depth: 'full', changedFiles: ['a.css'] })).toEqual([]);
  });
});

describe('selectAnalyzers — deep', () => {
  it('returns the full registry catalog', () => {
    expect(selectAnalyzers({ depth: 'deep' })).toEqual(ALL_EXPENSIVE_ANALYZERS);
    expect(selectAnalyzers({ depth: 'deep' })).toHaveLength(16);
  });

  it('does not depend on the changed files', () => {
    expect(selectAnalyzers({ depth: 'deep', changedFiles: [] }))
      .toEqual(selectAnalyzers({ depth: 'deep', changedFiles: ['only-docs.md'] }));
  });
});

describe('selectAnalyzers — standard (file-type aware)', () => {
  it('a stylesheet change selects the layout/theming/visual/a11y set', () => {
    const out = selectAnalyzers({ depth: 'standard', changedFiles: ['src/styles/app.scss'] });
    expect(new Set(out)).toEqual(new Set(['css', 'responsive', 'theme', 'motion', 'visual', 'a11y-deep']));
    expect(out).not.toContain('lighthouse');
    expect(out).not.toContain('memory');
  });

  it('a component change selects the a11y/interaction/vitals/form set, NEVER the slow ones', () => {
    const out = selectAnalyzers({ depth: 'standard', changedFiles: ['components/Checkout.tsx'] });
    expect(new Set(out)).toEqual(new Set(['a11y-deep', 'snapshot', 'keyboard', 'hover', 'web-vitals', 'form']));
    for (const slow of DEEP_ONLY) expect(out).not.toContain(slow);
  });

  it('an image change selects only visual regression', () => {
    expect(selectAnalyzers({ depth: 'standard', changedFiles: ['public/hero.png'] })).toEqual(['visual']);
    expect(selectAnalyzers({ depth: 'standard', changedFiles: ['icon.svg'] })).toEqual(['visual']);
  });

  it('a web-font change selects only the font analyzer', () => {
    expect(selectAnalyzers({ depth: 'standard', changedFiles: ['fonts/Inter.woff2'] })).toEqual(['font']);
  });

  it('a non-UI-only change (docs / config) degrades to cheap → []', () => {
    expect(selectAnalyzers({ depth: 'standard', changedFiles: ['README.md', 'tsconfig.json', 'ci.yml'] })).toEqual([]);
  });

  it('unions the rules over a mixed bundle, deduped, in registry order', () => {
    const out = selectAnalyzers({ depth: 'standard', changedFiles: ['theme.css', 'Card.tsx'] });
    // a11y-deep is in BOTH rule sets — must appear exactly once.
    expect(out.filter(a => a === 'a11y-deep')).toHaveLength(1);
    // Union membership (order-agnostic).
    expect(new Set(out)).toEqual(new Set([
      'css', 'responsive', 'theme', 'motion', 'visual', 'a11y-deep',
      'snapshot', 'keyboard', 'hover', 'web-vitals', 'form',
    ]));
    // Determinism: the output is exactly the registry order of the selected set (no dups, no reorder).
    expect(out).toEqual(ALL_EXPENSIVE_ANALYZERS.filter(a => out.includes(a)));
  });

  it('only ever returns real registry analyzer names (no phantom)', () => {
    const out = selectAnalyzers({ depth: 'standard', changedFiles: ['a.css', 'b.tsx', 'c.png', 'd.woff'] });
    for (const name of out) expect(ALL_EXPENSIVE_ANALYZERS).toContain(name);
  });
});

describe('STANDARD_POLICY / ALL_EXPENSIVE_ANALYZERS structural integrity', () => {
  it('the catalog has no duplicates', () => {
    expect(new Set(ALL_EXPENSIVE_ANALYZERS).size).toBe(ALL_EXPENSIVE_ANALYZERS.length);
  });

  it('every policy rule only references catalog analyzers', () => {
    for (const rule of STANDARD_POLICY) {
      for (const a of rule.analyzers) expect(ALL_EXPENSIVE_ANALYZERS).toContain(a);
    }
  });

  it('AUDIT_DEPTHS is the cheapest-first ordering', () => {
    expect(AUDIT_DEPTHS).toEqual(['cheap', 'standard', 'deep']);
  });
});

describe('runDepthAnalyzers — selective execution + isolation (DI, no Chrome)', () => {
  const browser = { id: 'fake-browser' };
  const route   = { path: '/checkout', name: 'audit' };
  const url      = 'http://localhost:3000/checkout';

  function makeAnalyzers(calls) {
    return [
      { name: 'good1', analyze: async (b, u, r) => { calls.push({ name: 'good1', b, u, r }); return [{ type: 'g1', severity: 'warning' }]; } },
      { name: 'bad',   analyze: async () => { throw new Error('analyzer boom'); } },
      { name: 'good2', analyze: async () => ({ findings: [{ type: 'g2', severity: 'info' }], screenshots: {} }) },
      { name: 'unwanted', analyze: async () => { calls.push({ name: 'unwanted' }); return [{ type: 'NOPE', severity: 'critical' }]; } },
    ];
  }

  it('returns [] (and runs nothing) when the wanted set is empty', async () => {
    const calls = [];
    const out = await runDepthAnalyzers(makeAnalyzers(calls), browser, url, route, []);
    expect(out).toEqual([]);
    expect(calls).toEqual([]);   // short-circuit: no analyzer was invoked
  });

  it('runs ONLY the wanted analyzers and collects their findings', async () => {
    const calls = [];
    const out = await runDepthAnalyzers(makeAnalyzers(calls), browser, url, route, ['good1', 'good2']);
    expect(out.map(f => f.type)).toEqual(['g1', 'g2']);
    expect(calls.some(c => c.name === 'unwanted')).toBe(false);   // not selected → not run
  });

  it('isolates a throwing analyzer — siblings still run, no finding dropped', async () => {
    const calls = [];
    // 'bad' is wanted and throws; 'good1' + 'good2' must still contribute.
    const out = await runDepthAnalyzers(makeAnalyzers(calls), browser, url, route, ['good1', 'bad', 'good2']);
    expect(out.map(f => f.type)).toEqual(['g1', 'g2']);
  });

  it('passes the browser, url and route through to each analyzer', async () => {
    const calls = [];
    await runDepthAnalyzers(makeAnalyzers(calls), browser, url, route, ['good1']);
    expect(calls[0]).toMatchObject({ name: 'good1', b: browser, u: url, r: route });
  });

  it('tolerates malformed entries (null / missing analyze fn) without throwing', async () => {
    const list = [
      null,
      { name: 'nofn' },                                  // no analyze
      { name: 'ok', analyze: async () => [{ type: 'ok', severity: 'info' }] },
    ];
    const out = await runDepthAnalyzers(list, browser, url, route, ['nofn', 'ok']);
    expect(out.map(f => f.type)).toEqual(['ok']);
  });
});
