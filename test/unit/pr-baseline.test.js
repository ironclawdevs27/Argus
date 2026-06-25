import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  severityTally,
  diffRoutesAgainstBaseline,
  decidePrBlock,
  resolvePrBaselineFile,
  loadPrBaseline,
  savePrBaseline,
  tagFindingNovelty,
} from '../../src/utils/pr-baseline.js';

// A pre-existing critical that lives on the base branch, plus the routes the PR audits.
const PREEXISTING = { severity: 'critical', type: 'console_error', message: 'TypeError: legacy is null', url: 'http://x/checkout' };
const NEW_CRIT    = { severity: 'critical', type: 'console_error', message: 'ReferenceError: total is not defined', url: 'http://x/checkout' };
const NEW_WARN    = { severity: 'warning',  type: 'seo_meta',      message: 'Missing meta description', url: 'http://x/about' };

/** Persist `routeResults` to a temp baseline file and load it back as a diffable baseline. */
function bakeBaseline(routeResults) {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-b1-'));
  const file = path.join(dir, 'base.json');
  savePrBaseline(file, routeResults);
  const baseline = loadPrBaseline(file);
  return { file, baseline, dir };
}

describe('severityTally', () => {
  it('tallies by severity and ignores unknown buckets', () => {
    const t = severityTally([{ severity: 'critical' }, { severity: 'warning' }, { severity: 'warning' }, { severity: 'info' }, { severity: 'mystery' }]);
    expect(t).toEqual({ critical: 1, warning: 2, info: 1 });
  });
  it('returns zeros for non-array input', () => {
    expect(severityTally(null)).toEqual({ critical: 0, warning: 0, info: 0 });
  });
});

describe('CLI ↔ MCP block-decision parity (E4)', () => {
  // Both PR-validate paths now build the decidePrBlock `summary` input via the shared severityTally
  // (replacing two separate inline ".filter(f => f.severity === ...).length" copies). This pins that
  // the swap is byte-identical to that legacy recipe — so it can never change what feeds the gate.
  it('severityTally is byte-identical to the legacy inline filter recipe', () => {
    const mixed = [
      { severity: 'critical' }, { severity: 'critical' }, { severity: 'warning' },
      { severity: 'info' }, { severity: 'info' }, { severity: 'info' }, { severity: 'trace' },
    ];
    const legacy = {
      critical: mixed.filter(f => f.severity === 'critical').length,
      warning:  mixed.filter(f => f.severity === 'warning').length,
      info:     mixed.filter(f => f.severity === 'info').length,
    };
    expect(severityTally(mixed)).toEqual(legacy);
    expect(severityTally(mixed)).toEqual({ critical: 2, warning: 1, info: 3 });
  });

  // The two paths feed decidePrBlock the SAME-shaped inputs but differ in ONE detail: the CLI
  // pre-normalizes blockOn (toLowerCase().trim()) while the MCP path passes it raw. decidePrBlock's
  // internal normalization is the single agreement point — so for the same findings the two paths
  // reach the identical decision regardless of blockOn casing/whitespace.
  it('reaches the identical decision for the same findings whether blockOn is pre-normalized or raw', () => {
    const findings = [
      { severity: 'critical', type: 'console_error', message: 'TypeError', url: 'http://x/checkout' },
      { severity: 'warning',  type: 'seo_meta',      message: 'meta',      url: 'http://x/checkout' },
    ];
    const routeFindings = [{ path: '/checkout', findings }];
    const decide = (blockOn) =>
      decidePrBlock({ routeFindings, summary: severityTally(findings), blockOn, baseline: null });
    for (const [normalized, raw] of [['critical', ' Critical '], ['warning', 'WARNING'], ['none', 'None']]) {
      const a = decide(normalized);
      const b = decide(raw);
      expect({ blocked: b.blocked, reason: b.reason }).toEqual({ blocked: a.blocked, reason: a.reason });
    }
    // Not vacuously equal-because-both-broken: the decisions themselves are the expected ones.
    expect(decide('critical').blocked).toBe(true);
    expect(decide('none').blocked).toBe(false);
  });
});

describe('diffRoutesAgainstBaseline', () => {
  it('classifies persisting vs new vs resolved against a stored baseline', () => {
    // Base: /checkout had the pre-existing critical AND a warning that the PR resolves.
    const RESOLVED = { severity: 'warning', type: 'a11y', message: 'gone now', url: 'http://x/checkout' };
    const { baseline } = bakeBaseline([{ path: '/checkout', findings: [PREEXISTING, RESOLVED] }]);

    // Head run on /checkout: the pre-existing critical persists, a new critical appears.
    const diff = diffRoutesAgainstBaseline(
      [{ path: '/checkout', findings: [PREEXISTING, NEW_CRIT] }],
      baseline,
    );

    expect(diff.newFindings.map(f => f.message)).toEqual([NEW_CRIT.message]);
    expect(diff.persistingFindings.map(f => f.message)).toEqual([PREEXISTING.message]);
    expect(diff.persistingCount).toBe(1);
    expect(diff.resolvedCount).toBe(1);           // RESOLVED disappeared
    expect(diff.newSummary).toEqual({ critical: 1, warning: 0, info: 0 });
  });

  it('treats every finding as new when the baseline has no entry for the route', () => {
    const { baseline } = bakeBaseline([{ path: '/other', findings: [PREEXISTING] }]);
    const diff = diffRoutesAgainstBaseline([{ path: '/checkout', findings: [NEW_CRIT] }], baseline);
    expect(diff.newSummary.critical).toBe(1);
    expect(diff.resolvedCount).toBe(0);           // /other was not audited → not resolved
  });
});

describe('decidePrBlock — baseline-aware, mutation-relevant directions', () => {
  it('does NOT block on a pre-existing critical (baseline available)', () => {
    const { baseline } = bakeBaseline([{ path: '/checkout', findings: [PREEXISTING] }]);
    const d = decidePrBlock({
      routeFindings: [{ path: '/checkout', findings: [PREEXISTING] }],
      summary: { critical: 1, warning: 0, info: 0 },
      blockOn: 'critical',
      baseline,
    });
    expect(d.baselineAvailable).toBe(true);
    expect(d.newSummary).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(d.blocked).toBe(false);                // legacy critical must not block
    expect(d.reason).toBeNull();
  });

  it('DOES block on a PR-introduced critical (baseline available)', () => {
    const { baseline } = bakeBaseline([{ path: '/checkout', findings: [PREEXISTING] }]);
    const d = decidePrBlock({
      routeFindings: [{ path: '/checkout', findings: [PREEXISTING, NEW_CRIT] }],
      summary: { critical: 2, warning: 0, info: 0 },
      blockOn: 'critical',
      baseline,
    });
    expect(d.blocked).toBe(true);
    expect(d.newSummary.critical).toBe(1);
    expect(d.reason).toMatch(/critical new finding/);
  });

  it('fails safe to ABSOLUTE blocking when no baseline is available, and says so', () => {
    const d = decidePrBlock({
      routeFindings: [{ path: '/checkout', findings: [PREEXISTING] }],
      summary: { critical: 1, warning: 0, info: 0 },
      blockOn: 'critical',
      baseline: null,
    });
    expect(d.baselineAvailable).toBe(false);
    expect(d.blocked).toBe(true);                 // never silently passes
    expect(d.newSummary).toBeNull();
    expect(d.note).toMatch(/baseline unavailable/i);
    expect(d.reason).toMatch(/critical total finding/);
  });

  it('block-on=warning: a NEW warning blocks but a pre-existing warning does not', () => {
    const baseWarn = { severity: 'warning', type: 'seo_meta', message: 'old warning', url: 'http://x/about' };
    const { baseline } = bakeBaseline([{ path: '/about', findings: [baseWarn] }]);

    const persisting = decidePrBlock({
      routeFindings: [{ path: '/about', findings: [baseWarn] }],
      summary: { critical: 0, warning: 1, info: 0 }, blockOn: 'warning', baseline,
    });
    expect(persisting.blocked).toBe(false);

    const introduced = decidePrBlock({
      routeFindings: [{ path: '/about', findings: [baseWarn, NEW_WARN] }],
      summary: { critical: 0, warning: 2, info: 0 }, blockOn: 'warning', baseline,
    });
    expect(introduced.blocked).toBe(true);
    expect(introduced.newSummary.warning).toBe(1);
  });

  it('block-on=none never blocks regardless of baseline', () => {
    expect(decidePrBlock({ summary: { critical: 9, warning: 9, info: 0 }, blockOn: 'none', baseline: null }).blocked).toBe(false);
  });

  it('round-trip: an unchanged run against its own baseline introduces nothing', () => {
    const routes = [{ path: '/checkout', findings: [PREEXISTING, NEW_WARN] }];
    const { baseline } = bakeBaseline(routes);
    const d = decidePrBlock({ routeFindings: routes, summary: { critical: 1, warning: 1, info: 0 }, blockOn: 'critical', baseline });
    expect(d.blocked).toBe(false);
    expect(d.newSummary).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(d.persistingCount).toBe(2);
  });
});

// ── E3: exhaustive block-on × severity matrix (the merge-gate, fail-safe / absolute path) ──
describe('decidePrBlock — exhaustive block-on × severity matrix (E3)', () => {
  const CRIT = { severity: 'critical', type: 'console_error', message: 'boom', url: 'http://x/c' };
  const WARN = { severity: 'warning',  type: 'seo_meta',      message: 'meta', url: 'http://x/c' };
  const INFO = { severity: 'info',     type: 'design_token',  message: 'nit',  url: 'http://x/c' };
  const STATES = {
    none:     { findings: [],     summary: { critical: 0, warning: 0, info: 0 } },
    onlyInfo: { findings: [INFO], summary: { critical: 0, warning: 0, info: 1 } },
    warning:  { findings: [WARN], summary: { critical: 0, warning: 1, info: 0 } },
    critical: { findings: [CRIT], summary: { critical: 1, warning: 0, info: 0 } },
  };
  // Decide one cell with NO baseline → fail-safe to absolute counts (the block-on matrix).
  const blockedFor = (blockOn, state) => decidePrBlock({
    routeFindings: [{ path: '/c', findings: STATES[state].findings }],
    summary: STATES[state].summary, blockOn, baseline: null,
  }).blocked;

  // [policy][state] → expected blocked
  const EXPECTED = {
    none:     { none: false, onlyInfo: false, warning: false, critical: false },
    warning:  { none: false, onlyInfo: false, warning: true,  critical: true  },
    critical: { none: false, onlyInfo: false, warning: false, critical: true  },
  };

  for (const policy of ['none', 'warning', 'critical']) {
    for (const state of ['none', 'onlyInfo', 'warning', 'critical']) {
      it(`block-on=${policy} × ${state} findings → blocked=${EXPECTED[policy][state]}`, () => {
        expect(blockedFor(policy, state)).toBe(EXPECTED[policy][state]);
      });
    }
  }

  it('every no-baseline cell fails safe: baselineAvailable=false + a stated note, blocked reason scoped "total"', () => {
    const d = decidePrBlock({ routeFindings: [{ path: '/c', findings: [CRIT] }], summary: STATES.critical.summary, blockOn: 'critical', baseline: null });
    expect(d.baselineAvailable).toBe(false);
    expect(d.note).toMatch(/baseline unavailable/i);
    expect(d.reason).toMatch(/critical total finding/);
    expect(d.reason).not.toMatch(/\bnew\b/);
    // a passing cell still carries the note but a null reason
    const pass = decidePrBlock({ routeFindings: [{ path: '/c', findings: [WARN] }], summary: STATES.warning.summary, blockOn: 'critical', baseline: null });
    expect(pass.reason).toBeNull();
    expect(pass.note).toMatch(/baseline unavailable/i);
  });
});

describe('resolvePrBaselineFile', () => {
  const TRACKED = ['ARGUS_BASELINE_FILE', 'GITHUB_BASE_REF', 'ARGUS_BASE_BRANCH', 'REPORT_OUTPUT_DIR'];
  const saved = {};
  beforeEach(() => { for (const k of TRACKED) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(()  => { for (const k of TRACKED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('honours ARGUS_BASELINE_FILE verbatim', () => {
    process.env.ARGUS_BASELINE_FILE = '/custom/base.json';
    expect(resolvePrBaselineFile({ outputDir: './reports', baseRef: 'main' })).toBe('/custom/base.json');
  });

  it('resolves <outputDir>/baselines/<safe(GITHUB_BASE_REF)>.json and sanitizes slashes', () => {
    process.env.GITHUB_BASE_REF = 'release/v2';
    const file = resolvePrBaselineFile({ outputDir: 'out' });
    expect(file).toBe(path.join('out', 'baselines', 'release__v2.json'));
  });

  it('returns null when no base ref can be resolved (→ caller fails safe to absolute)', () => {
    expect(resolvePrBaselineFile({ outputDir: 'out' })).toBeNull();
  });
});

describe('loadPrBaseline', () => {
  it('returns null for a missing file and for a falsy path', () => {
    expect(loadPrBaseline(null)).toBeNull();
    expect(loadPrBaseline(path.join(os.tmpdir(), 'argus-b1-does-not-exist-xyz.json'))).toBeNull();
  });
});

// ── tagFindingNovelty (B2 — the per-finding new/persisting tags the PR comment renders) ──
describe('tagFindingNovelty', () => {
  it('tags a persisting finding isNew=false and a PR-introduced one isNew=true (real baseline)', () => {
    const { baseline } = bakeBaseline([{ path: '/checkout', findings: [PREEXISTING] }]);
    const persisting = { ...PREEXISTING };   // copies — tagFindingNovelty mutates
    const introduced = { ...NEW_CRIT };
    tagFindingNovelty([{ path: '/checkout', findings: [persisting, introduced] }], baseline);
    expect(persisting.isNew).toBe(false);
    expect(introduced.isNew).toBe(true);
  });

  it('tags the SAME object references shared with the flat result.findings array', () => {
    const { baseline } = bakeBaseline([{ path: '/checkout', findings: [PREEXISTING] }]);
    const persisting = { ...PREEXISTING };
    const introduced = { ...NEW_CRIT };
    const flat = [persisting, introduced];   // result.findings shares these very objects
    tagFindingNovelty([{ path: '/checkout', findings: flat }], baseline);
    expect(flat[0].isNew).toBe(false);
    expect(flat[1].isNew).toBe(true);
  });

  it('is a no-op without a baseline — findings stay untagged (fail-safe → counted as new)', () => {
    const f = { ...NEW_CRIT };
    tagFindingNovelty([{ path: '/checkout', findings: [f] }], null);
    expect(f.isNew).toBeUndefined();
  });
});
