/**
 * Argus Phase C3: Auto route discovery.
 *
 * C3.1  discoverFromSitemap(baseUrl)       — fetch /sitemap.xml, parse <loc> paths
 * C3.2  discoverFromNextJs(sourceDir)      — scan pages/ + app/ directory structure
 * C3.3  discoverFromReactRouter(sourceDir) — grep source for <Route path> patterns
 * C3.4  mergeRoutes(manualRoutes, paths)   — deduplicate, preserve manual config
 * C3.5  discoverRoutes(baseUrl, ...)       — orchestrate all sources
 *
 * Design decisions:
 *   - discoverFromSitemap uses native fetch (Node 18+) with a 10s timeout; returns []
 *     on any network or parse error so a missing sitemap never fails a crawl.
 *   - discoverFromNextJs handles both pages/ (Next 12) and app/ (Next 13+) layouts.
 *     Route groups like (auth) are stripped from app/ paths.
 *   - discoverFromReactRouter is intentionally conservative: only static paths
 *     (starting with /, no :param, no * wildcard) are extracted.
 *   - mergeRoutes is pure — manual route config (critical, waitFor) is always preserved.
 */

import fs   from 'fs';
import path from 'path';

// File extensions to scan for page/route files
const PAGE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);

// Next.js pages/ entries to always skip
const NEXTJS_SKIP = new Set(['_app', '_document', '_error', 'api']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive a human-readable label from a URL path. */
function nameFromPath(urlPath) {
  if (urlPath === '/') return 'Home';
  return urlPath
    .split('/')
    .filter(Boolean)
    .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' '))
    .join(' / ');
}

/** Recursively list all files under dir. Returns [] if dir doesn't exist. */
function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

// ── C3.1: Sitemap discovery ───────────────────────────────────────────────────

/**
 * Fetch /sitemap.xml from baseUrl and return same-origin URL paths.
 * Follows a single level of sitemap index indirection.
 * Returns [] on any network or parse error.
 *
 * @param {string} baseUrl
 * @returns {Promise<string[]>}
 */
export async function discoverFromSitemap(baseUrl) {
  const sitemapUrl = `${baseUrl.replace(/\/$/, '')}/sitemap.xml`;
  try {
    const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const xml = await res.text();

    // Sitemap index: follow first child sitemap only (avoid unbounded fan-out)
    // Match <loc> inside a <sitemap> element to avoid picking up a <url><loc> entry.
    if (/<sitemapindex/i.test(xml)) {
      const childMatch = xml.match(/<sitemap[^>]*>[\s\S]*?<loc>([\s\S]*?)<\/loc>/i);
      if (!childMatch) return [];
      const childRes = await fetch(childMatch[1].trim(), { signal: AbortSignal.timeout(10000) });
      if (!childRes.ok) return [];
      return parseLocElements(await childRes.text(), baseUrl);
    }

    return parseLocElements(xml, baseUrl);
  } catch {
    return [];
  }
}

function parseLocElements(xml, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const paths = new Set();
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
    const raw = m[1].trim();
    try {
      const u = new URL(raw);
      if (u.origin !== origin) continue;
      paths.add(u.pathname || '/');
    } catch { /* skip malformed loc entries */ }
  }
  return [...paths];
}

// ── C3.2: Next.js route discovery ─────────────────────────────────────────────

/**
 * Scan a Next.js project root for routable pages.
 *
 * pages/ layout (Next 12):
 *   - pages/index.jsx        → /
 *   - pages/blog/index.jsx   → /blog
 *   - pages/about.tsx        → /about
 *   - pages/[slug].tsx       → skipped  (dynamic — no concrete URL to crawl)
 *   - pages/_app.jsx         → skipped
 *   - pages/api/*            → skipped
 *
 * app/ layout (Next 13+):
 *   - app/page.tsx           → /
 *   - app/about/page.tsx     → /about
 *   - app/(auth)/login/page.tsx → /login  (route group stripped)
 *   - app/api/route.ts       → skipped (not a page.* file)
 *
 * @param {string} sourceDir  project root (contains pages/ and/or app/)
 * @returns {string[]}
 */
export function discoverFromNextJs(sourceDir) {
  const discovered = new Set();

  // ── pages/ ────────────────────────────────────────────────────────────────
  const pagesDir = path.join(sourceDir, 'pages');
  if (fs.existsSync(pagesDir)) {
    for (const file of walkDir(pagesDir)) {
      const ext = path.extname(file);
      if (!PAGE_EXTS.has(ext)) continue;

      const rel   = path.relative(pagesDir, file);
      const parts = rel.split(path.sep);

      // Skip underscore files and reserved directories anywhere in path
      if (parts.some(p => p.startsWith('_') || NEXTJS_SKIP.has(p.replace(/\..+$/, '')))) continue;

      // Strip extension from final segment, collapse trailing 'index' to parent
      const urlParts = parts.map((p, i) => i === parts.length - 1 ? p.replace(ext, '') : p);
      if (urlParts[urlParts.length - 1] === 'index') urlParts.pop();

      // Skip dynamic segments like [slug] — no concrete URL to crawl
      if (urlParts.some(p => p.includes('['))) continue;

      discovered.add(urlParts.length === 0 ? '/' : '/' + urlParts.join('/'));
    }
  }

  // ── app/ ─────────────────────────────────────────────────────────────────
  const appDir = path.join(sourceDir, 'app');
  if (fs.existsSync(appDir)) {
    for (const file of walkDir(appDir)) {
      // Only files named page.{ext} are routes in the app/ router
      if (!/^page\.(js|jsx|ts|tsx)$/.test(path.basename(file))) continue;

      const relDir = path.dirname(path.relative(appDir, file));
      const parts  = relDir === '.' ? [] : relDir.split(path.sep);

      // Skip api/ and private _folders; strip route groups (parenthesized dirs)
      if (parts.some(p => p === 'api' || p.startsWith('_'))) continue;
      const filtered = parts.filter(p => !/^\(.*\)$/.test(p));

      // Skip dynamic segments like [id] — no concrete URL to crawl
      if (filtered.some(p => p.includes('['))) continue;

      discovered.add(filtered.length === 0 ? '/' : '/' + filtered.join('/'));
    }
  }

  return [...discovered];
}

// ── C3.3: React Router route discovery ───────────────────────────────────────

/**
 * Grep JS/TS source files for React Router path declarations.
 *
 * Detects:
 *   <Route path="/foo" ... />
 *   { path: '/foo', element: ... }  (createBrowserRouter / route objects)
 *
 * Only static paths are returned: must start with /, no :param segments, no * wildcards.
 *
 * @param {string} sourceDir
 * @returns {string[]}
 */
export function discoverFromReactRouter(sourceDir) {
  if (!fs.existsSync(sourceDir)) return [];

  const files = walkDir(sourceDir).filter(f => PAGE_EXTS.has(path.extname(f)));
  const discovered = new Set();

  const PATTERNS = [
    // JSX:  <Route path="/foo"
    /<Route[^>]*\bpath\s*=\s*['"]([^'"]+)['"]/g,
    // Object: path: '/foo'
    /\bpath\s*:\s*['"]([^'"]+)['"]/g,
  ];

  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }

    for (const re of PATTERNS) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const p = m[1].trim();
        // Only absolute, static paths
        if (!p.startsWith('/') || p.includes(':') || p.includes('*')) continue;
        if (p.includes('//') || /\.(js|ts|json|css)$/.test(p)) continue;
        discovered.add(p);
      }
    }
  }

  return [...discovered];
}

// ── C3.4: Merge with manual routes ────────────────────────────────────────────

/**
 * Merge discovered paths into the manual routes array.
 * Manual routes always take precedence — their config (critical, waitFor, name) is
 * preserved as-is. New paths get sensible defaults and a `discovered: true` flag.
 *
 * @param {Array<{path: string}>} manualRoutes
 * @param {string[]} discoveredPaths
 * @returns {Array}
 */
export function mergeRoutes(manualRoutes, discoveredPaths) {
  const known = new Set(manualRoutes.map(r => r.path));
  const merged = [...manualRoutes];
  for (const p of discoveredPaths) {
    if (!known.has(p)) {
      known.add(p);
      merged.push({
        path:       p,
        name:       nameFromPath(p),
        critical:   false,
        waitFor:    null,
        discovered: true,
      });
    }
  }
  return merged;
}

// ── C3.5: Orchestrator ────────────────────────────────────────────────────────

/**
 * Run all enabled discovery methods and return a merged route array.
 *
 * @param {string} baseUrl
 * @param {string|null} sourceDir
 * @param {{ sitemap?: boolean, nextjs?: boolean, reactRouter?: boolean }} autoDiscover
 * @param {Array} manualRoutes
 * @returns {Promise<Array>}
 */
export async function discoverRoutes(baseUrl, sourceDir, autoDiscover, manualRoutes) {
  if (!autoDiscover) return manualRoutes;
  const { sitemap = true, nextjs = true, reactRouter = false } = autoDiscover;
  const allPaths = [];

  if (sitemap) {
    const paths = await discoverFromSitemap(baseUrl);
    allPaths.push(...paths);
    if (paths.length > 0) console.log(`[ARGUS] C3: sitemap → ${paths.length} route(s)`);
  }

  if (nextjs && sourceDir) {
    const paths = discoverFromNextJs(sourceDir);
    allPaths.push(...paths);
    if (paths.length > 0) console.log(`[ARGUS] C3: Next.js → ${paths.length} route(s)`);
  }

  if (reactRouter && sourceDir) {
    const paths = discoverFromReactRouter(sourceDir);
    allPaths.push(...paths);
    if (paths.length > 0) console.log(`[ARGUS] C3: React Router → ${paths.length} route(s)`);
  }

  const merged = mergeRoutes(manualRoutes, allPaths);
  const added  = merged.length - manualRoutes.length;
  if (added > 0) console.log(`[ARGUS] C3: ${added} new route(s) added (total: ${merged.length})`);
  return merged;
}
