import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseImports, resolveSpecifier, loadAliases, buildImportGraph, findDependents,
} from '../../src/utils/import-graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE   = path.resolve(__dirname, '../../test-harness/import-graph-fixture');

describe('parseImports', () => {
  it('extracts import / export-from / require / dynamic-import specifiers', () => {
    const src = [
      "import Hero from '../components/Hero';",
      "import { a, b } from './util';",
      "import './side-effect.css';",
      "export { x } from './re-export';",
      "const y = require('./cjs');",
      "const z = await import('@/lazy');",
    ].join('\n');
    const specs = parseImports(src);
    expect(specs).toEqual(expect.arrayContaining([
      '../components/Hero', './util', './side-effect.css', './re-export', './cjs', '@/lazy',
    ]));
  });

  it('returns [] for non-string / empty / import-free input', () => {
    expect(parseImports(null)).toEqual([]);
    expect(parseImports('')).toEqual([]);
    expect(parseImports('const x = 1; function f() { return x; }')).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  const indexAbs = path.join(FIXTURE, 'pages', 'index.jsx');

  it('resolves a relative import with extension inference', () => {
    expect(resolveSpecifier('../components/Hero', indexAbs, []))
      .toBe(path.join(FIXTURE, 'components', 'Hero.jsx'));
  });

  it('returns null for bare package specifiers (node_modules, not app files)', () => {
    expect(resolveSpecifier('react', indexAbs, [])).toBeNull();
    expect(resolveSpecifier('next/link', indexAbs, [])).toBeNull();
  });

  it('resolves a tsconfig path alias (@/components/Profile)', () => {
    const aliases = loadAliases(FIXTURE);
    expect(resolveSpecifier('@/components/Profile', path.join(FIXTURE, 'pages', 'about.jsx'), aliases))
      .toBe(path.join(FIXTURE, 'components', 'Profile.jsx'));
  });

  it('returns null for an unresolvable relative path', () => {
    expect(resolveSpecifier('./does-not-exist', indexAbs, [])).toBeNull();
  });
});

describe('loadAliases', () => {
  it('reads compilerOptions.paths from the fixture tsconfig', () => {
    const aliases = loadAliases(FIXTURE);
    expect(aliases.some(a => a.prefix === '@/')).toBe(true);
  });

  it('returns [] when no tsconfig/jsconfig is present', () => {
    expect(loadAliases(path.join(FIXTURE, 'components'))).toEqual([]);
  });
});

describe('buildImportGraph + findDependents', () => {
  it('builds forward + reverse edges over the fixture tree', () => {
    const g        = buildImportGraph(FIXTURE);
    const cart     = path.join(FIXTURE, 'components', 'CartSummary.jsx');
    const checkout = path.join(FIXTURE, 'pages', 'checkout.jsx');
    expect(g.truncated).toBe(false);
    expect(g.forward.get(checkout).has(cart)).toBe(true); // checkout imports CartSummary
    expect(g.reverse.get(cart).has(checkout)).toBe(true);  // CartSummary imported by checkout
  });

  it('findDependents walks the reverse graph transitively (lib → component → page)', () => {
    const g        = buildImportGraph(FIXTURE);
    const fmt      = path.join(FIXTURE, 'lib', 'formatPrice.js');
    const cart     = path.join(FIXTURE, 'components', 'CartSummary.jsx');
    const checkout = path.join(FIXTURE, 'pages', 'checkout.jsx');
    const deps     = findDependents(g.reverse, [fmt]);
    expect(deps.has(cart)).toBe(true);
    expect(deps.has(checkout)).toBe(true); // transitive through CartSummary
  });

  it('an orphan module has no dependents (drives the conservative fallback)', () => {
    const g   = buildImportGraph(FIXTURE);
    const orph = path.join(FIXTURE, 'lib', 'orphan.js');
    expect(findDependents(g.reverse, [orph]).size).toBe(0);
  });

  it('returns an empty, non-truncated graph for a non-existent dir', () => {
    const g = buildImportGraph(path.join(FIXTURE, 'nope-does-not-exist'));
    expect(g.files.size).toBe(0);
    expect(g.truncated).toBe(false);
  });
});

describe('stylesheet leaf nodes (C3)', () => {
  const cssMod   = path.join(FIXTURE, 'components', 'CartSummary.module.css');
  const brand    = path.join(FIXTURE, 'styles', 'brand.css');
  const theme    = path.join(FIXTURE, 'styles', 'theme.css');
  const cart     = path.join(FIXTURE, 'components', 'CartSummary.jsx');
  const checkout = path.join(FIXTURE, 'pages', 'checkout.jsx');

  it('resolves an explicit relative .css import to the on-disk stylesheet', () => {
    expect(resolveSpecifier('./CartSummary.module.css', cart, [])).toBe(cssMod);
    expect(resolveSpecifier('../styles/brand.css', cart, [])).toBe(brand);
  });

  it('does not invent a stylesheet via extensionless inference (assets need an explicit ext)', () => {
    // './CartSummary.module' must NOT resolve to the .css file — only source exts are inferred.
    expect(resolveSpecifier('./CartSummary.module', cart, [])).toBeNull();
  });

  it('tracks a stylesheet as a graph node with a reverse edge from its importer', () => {
    const g = buildImportGraph(FIXTURE);
    expect(g.files.has(cssMod)).toBe(true);
    expect(g.reverse.get(cssMod).has(cart)).toBe(true);   // CartSummary imports the module
    expect(g.forward.get(cart).has(cssMod)).toBe(true);
  });

  it('findDependents walks a stylesheet → component → page transitively', () => {
    const g = buildImportGraph(FIXTURE);
    const deps = findDependents(g.reverse, [cssMod]);
    expect(deps.has(cart)).toBe(true);
    expect(deps.has(checkout)).toBe(true); // transitive: module → CartSummary → checkout page
  });

  it('an orphan stylesheet (imported by no module) has no dependents → conservative fallback', () => {
    const g = buildImportGraph(FIXTURE);
    expect(g.files.has(theme)).toBe(true);          // still collected as a node
    expect(findDependents(g.reverse, [theme]).size).toBe(0);
  });

  it('a stylesheet shared by two components reaches both their pages (union), not /about', () => {
    const g     = buildImportGraph(FIXTURE);
    const hero  = path.join(FIXTURE, 'components', 'Hero.jsx');
    const index = path.join(FIXTURE, 'pages', 'index.jsx');
    const about = path.join(FIXTURE, 'pages', 'about.jsx');
    const deps  = findDependents(g.reverse, [brand]);
    expect(deps.has(hero)).toBe(true);
    expect(deps.has(index)).toBe(true);     // Hero → /
    expect(deps.has(checkout)).toBe(true);  // CartSummary → /checkout
    expect(deps.has(about)).toBe(false);    // /about never imports brand.css
  });
});
