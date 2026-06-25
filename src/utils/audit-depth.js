/**
 * Argus PR-Validator — selective analyzer depth policy (D2).
 *
 * Both PR-validate paths (the CLI `src/cli/pr-validate.js` and the MCP tool
 * `handlePrValidate` in `src/mcp-server.js`) run `crawlRouteCheap` on each affected route
 * by default. This module is the SINGLE, documented, deterministic policy that decides
 * which — if any — registered EXPENSIVE analyzers also run on those routes, based on an
 * opt-in depth tier and the PR's changed file types. Shared by both paths so they can
 * never diverge on depth.
 *
 * Tiers (ARGUS_PR_AUDIT_DEPTH):
 *   cheap    (default) → no expensive analyzers → byte-identical to the prior behaviour.
 *   standard           → a file-type-selected subset of expensive analyzers (this module's
 *                        STANDARD_POLICY) — the "selective" tier; a PR that only touches
 *                        non-UI files (docs/config) degrades to cheap.
 *   deep               → every registered expensive analyzer (ALL_EXPENSIVE_ANALYZERS),
 *                        including Lighthouse + memory.
 *
 * Safety: depth can only ADD findings on a route, never drop one — a failing analyzer is
 * isolated (try/catch) and skipped — so a deeper audit can never turn a real failure into a
 * PASS. The merge-block decision (decidePrBlock) is untouched by this module.
 *
 * Purity: `resolveAuditDepth` / `selectAnalyzers` are pure (no I/O, no Chrome).
 * `runDepthAnalyzers` is dependency-injected (the analyzer list + a browser are passed in),
 * so the whole module is Chrome-free testable and stdout-clean (logs to stderr via Pino) —
 * safe to import from the JSON-RPC MCP server.
 */

import { childLogger } from './logger.js';

const logger = childLogger('audit-depth');

/** Valid depth tiers, cheapest → deepest. The unset/invalid fallback is the cheapest. */
export const AUDIT_DEPTHS = ['cheap', 'standard', 'deep'];

/**
 * The full catalog of registry expensive-analyzer `name`s D2 can run, in registration
 * order (lighthouse self-registers first via its named import in orchestrator.js, then the
 * side-effect imports). A drift-guard test asserts this set equals the live registry
 * (`getExpensive()`), so a renamed/added/removed analyzer fails LOUDLY here instead of
 * silently never running (the recurring "Argus mis-reads its own state" bug class).
 */
export const ALL_EXPENSIVE_ANALYZERS = [
  'lighthouse', 'css', 'responsive', 'memory', 'hover', 'snapshot', 'keyboard',
  'theme', 'design-fidelity', 'web-vitals', 'visual', 'a11y-deep', 'har-recorder',
  'motion', 'font', 'form',
];

/**
 * The documented file-type → analyzer policy for the `standard` tier. Each changed file
 * contributes the analyzers of EVERY rule whose `test` matches its name; the route set runs
 * the UNION (deduped, in registry order). A file matching no rule contributes nothing.
 *
 * Deliberately EXCLUDED from `standard` (reserved for `deep`): `lighthouse` (slow, up to the
 * Lighthouse timeout), `memory` (GC-dependent / flaky), `design-fidelity` (inert without a
 * route `figmaFrameUrl`), `har-recorder` (needs a committed HAR baseline). These add little
 * PR signal per file type and would slow the per-PR gate.
 */
export const STANDARD_POLICY = [
  // Stylesheets → layout/overflow, theming, motion, visual + contrast (a11y) regressions.
  { label: 'stylesheet', test: /\.(css|scss|sass|less|styl)$/i,
    analyzers: ['css', 'responsive', 'theme', 'motion', 'visual', 'a11y-deep'] },
  // Component / markup source → a11y tree, focus order, hover state, vitals, forms.
  { label: 'component', test: /\.(jsx?|tsx?|mjs|cjs|vue|svelte|astro|mdx|html?)$/i,
    analyzers: ['a11y-deep', 'snapshot', 'keyboard', 'hover', 'web-vitals', 'form'] },
  // Raster/vector images → visual regression.
  { label: 'image', test: /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i,
    analyzers: ['visual'] },
  // Web fonts → font-loading (FOIT/FOUT/fallback) regression.
  { label: 'font', test: /\.(woff2?|ttf|otf|eot)$/i,
    analyzers: ['font'] },
];

/**
 * Normalize a raw depth value (env string) to a valid tier. Anything unrecognized →
 * 'cheap' (fail-safe to the cheapest, byte-identical tier — a misconfigured value must
 * never silently deepen or, worse, skip the audit).
 *
 * @param {string|undefined|null} raw
 * @returns {'cheap'|'standard'|'deep'}
 */
export function resolveAuditDepth(raw) {
  const v = String(raw ?? '').toLowerCase().trim();
  return AUDIT_DEPTHS.includes(v) ? v : 'cheap';
}

/**
 * The depth policy: which registered expensive-analyzer names to run on each affected
 * route, given the resolved tier + the PR's changed files. Returns a deduped list in
 * registry (ALL_EXPENSIVE_ANALYZERS) order. `cheap` → []; `deep` → all; `standard` → the
 * union of STANDARD_POLICY rules over the changed files.
 *
 * @param {{depth?: string, changedFiles?: string[]}} [opts]
 * @returns {string[]}
 */
export function selectAnalyzers({ depth = 'cheap', changedFiles = [] } = {}) {
  const tier = resolveAuditDepth(depth);
  if (tier === 'cheap') return [];
  if (tier === 'deep')  return [...ALL_EXPENSIVE_ANALYZERS];

  // standard — union of the file-type rules over the changed files.
  const selected = new Set();
  for (const file of Array.isArray(changedFiles) ? changedFiles : []) {
    const name = String(file ?? '');
    for (const rule of STANDARD_POLICY) {
      if (rule.test.test(name)) {
        for (const a of rule.analyzers) selected.add(a);
      }
    }
  }
  // Emit in registry order for determinism (and so dedup is stable).
  return ALL_EXPENSIVE_ANALYZERS.filter(a => selected.has(a));
}

/**
 * Run a SELECTED SUBSET of expensive analyzers against an already-navigated page.
 * Dependency-injected: `expensiveAnalyzers` is the registry list (`getExpensive()`) and
 * `browser` is the live adapter — both passed in, so this is Chrome-free testable. Only
 * analyzers whose `name` is in `wantedNames` run; each runs in its own try/catch so one
 * failing analyzer never aborts the route (and never drops a finding — depth is additive
 * only, which is why it can never turn a real failure into a PASS).
 *
 * @param {Array<{name: string, analyze: Function}>} expensiveAnalyzers
 * @param {object} browser   CdpBrowserAdapter (or a stub in tests)
 * @param {string} url
 * @param {object} route
 * @param {string[]} [wantedNames]
 * @returns {Promise<Array<object>>} collected findings
 */
export async function runDepthAnalyzers(expensiveAnalyzers, browser, url, route, wantedNames = []) {
  const wanted = new Set(Array.isArray(wantedNames) ? wantedNames : []);
  const findings = [];
  if (wanted.size === 0) return findings;

  for (const entry of Array.isArray(expensiveAnalyzers) ? expensiveAnalyzers : []) {
    if (!entry || !wanted.has(entry.name) || typeof entry.analyze !== 'function') continue;
    try {
      const raw = await entry.analyze(browser, url, route);
      // Analyzers return either findings[] or { findings, screenshots } (responsive).
      const out = Array.isArray(raw) ? raw
        : (raw && Array.isArray(raw.findings) ? raw.findings : []);
      findings.push(...out);
    } catch (err) {
      logger.warn(`[ARGUS] D2: expensive analyzer "${entry.name}" skipped for ${url}: ${err.message}`);
    }
  }
  return findings;
}
