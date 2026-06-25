import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parsePrUrl, fetchPrFiles, mapFilesToRoutes, mapFilesToRoutesDeep,
  firstAddedLine, resolveAnnotationTarget, stripWorkspacePrefix, packageRelativePath,
} from '../../src/utils/pr-diff-analyzer.js';
import { prFilesResponse } from '../../test-harness/contracts/github-pr-files-sample.js';

const PR_URL  = 'https://github.com/acme/shop/pull/7';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IG_FIXTURE = path.resolve(__dirname, '../../test-harness/import-graph-fixture');
const IG_MONOREPO = path.resolve(__dirname, '../../test-harness/import-graph-monorepo-fixture/apps/web');

/** Build a Response-like object for the injected fetch mock. */
function okResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPrFiles — request shape', () => {
  it('requests the v2022-11-28 /pulls/N/files endpoint with the documented headers', async () => {
    const fetchMock = vi.fn(async () => okResponse(prFilesResponse));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPrFiles(PR_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.github.com/repos/acme/shop/pulls/7/files?per_page=100&page=1',
    );
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
    expect(opts.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(opts.headers['User-Agent']).toBe('argusqa-os');
  });

  it('sends Authorization only when a token is provided', async () => {
    const withToken = vi.fn(async () => okResponse(prFilesResponse));
    vi.stubGlobal('fetch', withToken);
    await fetchPrFiles(PR_URL, 'ghp_exampletoken123');
    expect(withToken.mock.calls[0][1].headers.Authorization).toBe('Bearer ghp_exampletoken123');

    vi.unstubAllGlobals();

    const noToken = vi.fn(async () => okResponse(prFilesResponse));
    vi.stubGlobal('fetch', noToken);
    await fetchPrFiles(PR_URL);
    expect(noToken.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe('fetchPrFiles — parse', () => {
  it('returns { filename, status, patch } objects from a real-shaped response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(prFilesResponse)));

    const files = await fetchPrFiles(PR_URL);

    expect(files).toHaveLength(prFilesResponse.length);
    const checkout = files.find(f => f.filename === 'src/pages/checkout.tsx');
    expect(checkout.status).toBe('modified');
    expect(checkout.patch).toContain('@@ -12,7 +12,11 @@');
    expect(files.map(f => f.status).sort()).toEqual(['added', 'added', 'modified', 'removed']);
  });

  it('normalizes a missing patch (binary file) to null, never undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(prFilesResponse)));

    const files = await fetchPrFiles(PR_URL);
    const png = files.find(f => f.filename === 'public/logo.png');
    expect(png.patch).toBeNull();
    expect('patch' in png).toBe(true); // present-but-null, not absent
  });
});

describe('fetchPrFiles — pagination + 300 cap', () => {
  it('stops after a page returns fewer than 100 files', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/file${i}.js`, status: 'modified', patch: '@@ -1 +1 @@',
    }));
    const page2 = [{ filename: 'src/last.js', status: 'added', patch: '@@ -0,0 +1 @@' }];
    const paged = vi.fn(async (url) => okResponse(url.includes('page=2') ? page2 : page1));
    vi.stubGlobal('fetch', paged);

    const files = await fetchPrFiles(PR_URL);

    expect(paged).toHaveBeenCalledTimes(2); // page 1 full → page 2 partial → stop
    expect(files).toHaveLength(101);
  });

  it('caps at 300 files (3 pages) even when every page is full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.js`, status: 'modified', patch: '@@',
    }));
    const paged = vi.fn(async () => okResponse(fullPage));
    vi.stubGlobal('fetch', paged);

    const files = await fetchPrFiles(PR_URL);

    expect(paged).toHaveBeenCalledTimes(3); // MAX_PAGES
    expect(files).toHaveLength(300);
  });
});

describe('fetchPrFiles — error path', () => {
  it('throws with the HTTP status and never leaks the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'API rate limit exceeded',
      json: async () => ({}),
    })));

    let err;
    try {
      await fetchPrFiles(PR_URL, 'ghp_supersecret_value');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('GitHub API 403');
    expect(err.message).toContain('API rate limit exceeded');
    expect(err.message).not.toContain('ghp_supersecret_value');
  });
});

describe('mapFilesToRoutes — accepts both string[] and fetchPrFiles object[]', () => {
  const routes = [{ path: '/checkout', name: 'Checkout' }, { path: '/about', name: 'About' }];

  it('maps the fetchPrFiles object shape to routes by filename slug', () => {
    const matched = mapFilesToRoutes(prFilesResponse, routes);
    expect(matched.map(r => r.path)).toContain('/checkout');
    expect(matched.map(r => r.path)).not.toContain('/about');
  });

  it('still maps the legacy string[] shape identically', () => {
    const strings = prFilesResponse.map(f => f.filename);
    const fromStrings = mapFilesToRoutes(strings, routes).map(r => r.path);
    const fromObjects = mapFilesToRoutes(prFilesResponse, routes).map(r => r.path);
    expect(fromObjects).toEqual(fromStrings);
  });

  it('parsePrUrl still parses the fixture PR URL', () => {
    expect(parsePrUrl(PR_URL)).toEqual({ owner: 'acme', repo: 'shop', prNumber: 7 });
  });
});

describe('firstAddedLine — patch hunk parsing (Phase A3)', () => {
  it('returns the new-file line of the first added line after a context line', () => {
    // @@ +12 → context line is 12, the first + line is 13
    const checkout = prFilesResponse.find(f => f.filename === 'src/pages/checkout.tsx');
    expect(firstAddedLine(checkout.patch)).toBe(13);
  });

  it('returns the hunk start line when the first body line is an addition', () => {
    const added = prFilesResponse.find(f => f.filename === 'src/components/CartSummary.tsx');
    expect(firstAddedLine(added.patch)).toBe(1); // @@ -0,0 +1,24 @@ then +import...
  });

  it('returns null for a deletion-only hunk (no added line)', () => {
    const removed = prFilesResponse.find(f => f.filename === 'src/legacy/oldCart.js');
    expect(firstAddedLine(removed.patch)).toBeNull();
  });

  it('returns null for an absent/binary patch and empty string', () => {
    expect(firstAddedLine(null)).toBeNull();
    expect(firstAddedLine(undefined)).toBeNull();
    expect(firstAddedLine('')).toBeNull();
  });

  it('does not mistake the +++ file header for an added line', () => {
    // A full git patch starts with ---/+++ headers BEFORE the first @@ hunk.
    const patch = '--- a/src/foo.js\n+++ b/src/foo.js\n@@ -5,3 +5,4 @@\n existing\n+brand new line\n more';
    expect(firstAddedLine(patch)).toBe(6); // line 5 is context, the + is line 6
  });

  it('counts only context lines toward the new-file line, not deletions', () => {
    const patch = '@@ -10,5 +10,5 @@\n ctx a\n-removed one\n-removed two\n ctx b\n+added here';
    // 10 = "ctx a", deletions don't advance, 11 = "ctx b", 12 = "+added here"
    expect(firstAddedLine(patch)).toBe(12);
  });
});

describe('resolveAnnotationTarget — file:line for a route (Phase A3)', () => {
  it('anchors a slug-matched route at the specific changed file and its real line', () => {
    expect(resolveAnnotationTarget('/checkout', prFilesResponse))
      .toEqual({ path: 'src/pages/checkout.tsx', line: 13 });
  });

  it('returns null for a route no changed file maps to (route-level fallback)', () => {
    expect(resolveAnnotationTarget('/about', prFilesResponse)).toBeNull();
  });

  it('returns null for the root route — no segment to match specifically', () => {
    expect(resolveAnnotationTarget('/', prFilesResponse)).toBeNull();
  });

  it('never fabricates from an infra file (it maps to ALL routes, not a specific cause)', () => {
    const infra = [{ filename: 'src/app/checkout/layout.tsx', patch: '@@ -1,2 +1,3 @@\n+const x = 1;' }];
    // slug "checkout" would match, but layout.tsx is INFRA → must be skipped → null
    expect(resolveAnnotationTarget('/checkout', infra)).toBeNull();
  });

  it('returns null when the only matching file has no usable patch line (binary)', () => {
    const binary = [{ filename: 'src/logo/logo.png', patch: null }];
    expect(resolveAnnotationTarget('/logo', binary)).toBeNull();
  });

  it('skips a matched-but-lineless file and picks a later file with a real line', () => {
    const files = [
      { filename: 'src/checkout/icon.png', patch: null },                       // matches, no line
      { filename: 'src/checkout/page.tsx', patch: '@@ -3,2 +3,3 @@\n ctx\n+code' }, // matches, line 4
    ];
    expect(resolveAnnotationTarget('/checkout', files))
      .toEqual({ path: 'src/checkout/page.tsx', line: 4 });
  });

  it('accepts the bare string[] shape (no patch → null, never throws)', () => {
    expect(resolveAnnotationTarget('/checkout', ['src/pages/checkout.tsx'])).toBeNull();
  });

  it('returns null for empty or non-array input', () => {
    expect(resolveAnnotationTarget('/checkout', [])).toBeNull();
    expect(resolveAnnotationTarget('/checkout', null)).toBeNull();
  });
});

describe('mapFilesToRoutesDeep — framework-aware mapping (C1)', () => {
  const routes = [
    { path: '/',         name: 'Home' },
    { path: '/checkout', name: 'Checkout' },
    { path: '/about',    name: 'About' },
  ];
  const ALL  = ['/', '/about', '/checkout'];
  const deep = files => mapFilesToRoutesDeep(files, routes, { sourceDir: IG_FIXTURE }).map(r => r.path).sort();

  it('narrows a changed component to ONLY the route that renders it', () => {
    expect(deep(['components/CartSummary.jsx'])).toEqual(['/checkout']);
  });

  it('resolves a component imported via a tsconfig path alias', () => {
    expect(deep(['components/Profile.jsx'])).toEqual(['/about']);
  });

  it('resolves a util transitively (lib → component → page)', () => {
    expect(deep(['lib/formatPrice.js'])).toEqual(['/checkout']);
  });

  it('unions the routes for multiple changed components', () => {
    expect(deep(['components/Hero.jsx', 'components/CartSummary.jsx'])).toEqual(['/', '/checkout']);
  });

  it('maps a changed page file to its own route by convention', () => {
    expect(deep(['pages/checkout.jsx'])).toEqual(['/checkout']);
  });

  // ── SAFETY: never narrow away a possible regression ──
  it('falls back to ALL routes for a file imported by no page (ambiguous)', () => {
    expect(deep(['lib/orphan.js'])).toEqual(ALL);
  });

  it('falls back to ALL routes for a file absent from the source tree', () => {
    expect(deep(['src/widgets/Ghost.jsx'])).toEqual(ALL);
  });

  it('a precise component + an ambiguous file falls back to ALL routes (never narrows away the unknown)', () => {
    // The load-bearing safety case: CartSummary alone → [/checkout], but bundled with an
    // orphan file the change must audit everything (the orphan could affect any route).
    expect(deep(['components/CartSummary.jsx', 'lib/orphan.js'])).toEqual(ALL);
  });

  it('skips the audit for a docs/CI-only PR (same as the heuristic)', () => {
    expect(mapFilesToRoutesDeep(['README.md'], routes, { sourceDir: IG_FIXTURE })).toEqual([]);
  });

  it('is byte-identical to the slug heuristic when no sourceDir is given (opt-in)', () => {
    const noDir = mapFilesToRoutesDeep(['components/CartSummary.jsx'], routes, {}).map(r => r.path).sort();
    const heur  = mapFilesToRoutes(['components/CartSummary.jsx'], routes).map(r => r.path).sort();
    expect(noDir).toEqual(heur);
    expect(noDir).toEqual(ALL); // slug 'cartsummary' matches no route segment → conservative
  });

  it('returns [] when the routes list is empty, regardless of source dir', () => {
    expect(mapFilesToRoutesDeep(['components/CartSummary.jsx'], [], { sourceDir: IG_FIXTURE })).toEqual([]);
  });
});

describe('mapFilesToRoutesDeep — stylesheet attribution (C3)', () => {
  const routes = [
    { path: '/',         name: 'Home' },
    { path: '/checkout', name: 'Checkout' },
    { path: '/about',    name: 'About' },
  ];
  const ALL  = ['/', '/about', '/checkout'];
  const deep = files => mapFilesToRoutesDeep(files, routes, { sourceDir: IG_FIXTURE }).map(r => r.path).sort();

  it('narrows a CSS module to ONLY the route that imports it (heuristic would blast ALL)', () => {
    expect(deep(['components/CartSummary.module.css'])).toEqual(['/checkout']);
    // The slug heuristic finds no route segment in the file name → conservative ALL.
    expect(mapFilesToRoutes(['components/CartSummary.module.css'], routes).map(r => r.path).sort()).toEqual(ALL);
  });

  it('unions a shared stylesheet to its importing routes, safely excluding the rest', () => {
    // brand.css is imported by Hero (→ /) + CartSummary (→ /checkout); /about never imports it.
    expect(deep(['styles/brand.css'])).toEqual(['/', '/checkout']);
  });

  // ── SAFETY: never narrow away a possible regression ──
  it('falls back to ALL routes for an orphan stylesheet (imported by no page)', () => {
    expect(deep(['styles/theme.css'])).toEqual(ALL);
  });

  it('a precise CSS module + an ambiguous orphan stylesheet falls back to ALL routes', () => {
    expect(deep(['components/CartSummary.module.css', 'styles/theme.css'])).toEqual(ALL);
  });

  it('keeps a GLOBAL stylesheet (globals.css) at ALL routes — infra short-circuit preserved', () => {
    expect(deep(['styles/globals.css'])).toEqual(ALL);
  });

  it('is byte-identical to the slug heuristic for a stylesheet when no sourceDir is given', () => {
    const noDir = mapFilesToRoutesDeep(['components/CartSummary.module.css'], routes, {}).map(r => r.path).sort();
    const heur  = mapFilesToRoutes(['components/CartSummary.module.css'], routes).map(r => r.path).sort();
    expect(noDir).toEqual(heur);
    expect(noDir).toEqual(ALL);
  });
});

describe('mapFilesToRoutesDeep — monorepo path awareness (C2)', () => {
  const routes = [
    { path: '/',         name: 'Home' },
    { path: '/checkout', name: 'Checkout' },
  ];
  const ALL  = ['/', '/checkout'];
  // sourceDir is the apps/web PACKAGE subdir; PR paths are repo-root-relative ("apps/web/...").
  const deep = files => mapFilesToRoutesDeep(files, routes, { sourceDir: IG_MONOREPO }).map(r => r.path).sort();

  it('re-bases a repo-root-relative monorepo path into the package graph and narrows', () => {
    expect(deep(['apps/web/components/CartSummary.jsx'])).toEqual(['/checkout']);
  });

  it('resolves a monorepo util transitively (lib → component → page)', () => {
    expect(deep(['apps/web/lib/formatPrice.js'])).toEqual(['/checkout']);
  });

  // ── SAFETY: never narrow away a possible regression in a monorepo ──
  it('falls back to ALL routes for an orphan under the package (never narrows)', () => {
    expect(deep(['apps/web/lib/orphan.js'])).toEqual(ALL);
  });

  it('never misattributes a foreign-package file to a web route (no prefix overlap)', () => {
    expect(deep(['apps/admin/pages/index.jsx'])).toEqual(ALL);
  });

  it('a precise component + an ambiguous monorepo file falls back to ALL routes', () => {
    expect(deep(['apps/web/components/CartSummary.jsx', 'apps/web/lib/orphan.js'])).toEqual(ALL);
  });
});

describe('mapFilesToRoutes — workspace prefix slug hygiene (C2b)', () => {
  const routes = [{ path: '/' }, { path: '/web' }, { path: '/checkout' }];

  it('strips the workspace prefix so a checkout file does not spuriously match /web', () => {
    expect(mapFilesToRoutes(['apps/web/checkout.tsx'], routes).map(r => r.path)).toEqual(['/checkout']);
  });

  it('falls back to ALL routes (not a spurious /web) when only the workspace prefix would match', () => {
    expect(mapFilesToRoutes(['apps/web/index.tsx'], routes).map(r => r.path).sort())
      .toEqual(['/', '/checkout', '/web']);
  });
});

describe('stripWorkspacePrefix + packageRelativePath (C2 pure fns)', () => {
  it('strips a recognized 2-segment workspace prefix, leaving the package-relative path', () => {
    expect(stripWorkspacePrefix('apps/web/components/Foo.tsx')).toBe('components/Foo.tsx');
    expect(stripWorkspacePrefix('packages/ui/src/Button.tsx')).toBe('src/Button.tsx');
  });

  it('leaves non-workspace and remainderless paths unchanged', () => {
    expect(stripWorkspacePrefix('src/pages/checkout.tsx')).toBe('src/pages/checkout.tsx');
    expect(stripWorkspacePrefix('apps/web')).toBe('apps/web');         // only 2 segments — nothing to strip
    expect(stripWorkspacePrefix('components/Foo.tsx')).toBe('components/Foo.tsx');
  });

  it('re-bases a repo-root path onto a matching package subdir, null for a foreign/relative path', () => {
    const root = '/repo/apps/web';
    expect(packageRelativePath(root, 'apps/web/components/Foo.tsx')).toBe('components/Foo.tsx');
    expect(packageRelativePath(root, 'apps/admin/x.js')).toBeNull();     // different package — no overlap
    expect(packageRelativePath(root, 'components/Foo.tsx')).toBeNull();  // already package-relative
  });
});
