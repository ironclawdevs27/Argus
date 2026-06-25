/**
 * PR Diff Analyzer — maps GitHub PR changed files to affected Argus routes.
 *
 * parsePrUrl(prUrl)               → { owner, repo, prNumber }
 * fetchPrFiles(prUrl, token)      → Array<{ filename, status, patch }> for changed files
 * mapFilesToRoutes(files, routes) → Route[] subset likely affected by the diff
 *                                   (accepts string[] OR the fetchPrFiles object[] above)
 * mapFilesToRoutesDeep(files, routes, { sourceDir })
 *                                 → framework-aware Route[] (C1): maps a changed component to
 *                                   only the routes whose page files import it via the static
 *                                   import graph; falls back to mapFilesToRoutes on any
 *                                   ambiguity (never narrows away a possible regression).
 *                                   Monorepo-aware (C2): when sourceDir points at a workspace
 *                                   package subdir (apps/web, packages/ui, …) and GitHub
 *                                   returns repo-root-relative paths, the workspace prefix is
 *                                   stripped so the file resolves into the package graph.
 *                                   Stylesheet-aware (C3): a changed non-global stylesheet
 *                                   (CSS/SCSS/Sass/Less) attributes to only the routes that
 *                                   import it via the same graph; global stylesheets
 *                                   (globals.css, …) keep the conservative all-routes fallback.
 * stripWorkspacePrefix(filename)  → drop a leading monorepo workspace prefix
 *                                   ("apps/<pkg>/", "packages/<pkg>/", …) so workspace dirs
 *                                   don't pollute slug matching (C2)
 * packageRelativePath(root, file) → repo-root-relative file path re-based onto a package
 *                                   subdir `root`, or null when there is no prefix overlap (C2)
 * firstAddedLine(patch)           → new-file line number of the first added (+) line, or null
 * resolveAnnotationTarget(route, prFiles)
 *                                 → { path, line } when a changed file SPECIFICALLY maps to
 *                                   the route AND has a real patch line; null otherwise
 *                                   (Phase A3 file:line annotations — never fabricates a line)
 *
 * Pure functions + one async fetch — no Chrome, no MCP, no AI verdict.
 * AI verdict logic ships separately in the private argus-pro repo.
 *
 * This module is imported by the MCP server — nothing here may write to
 * stdout (reserved for JSON-RPC). CI annotations are emitted by the CLI
 * entry point (src/cli/pr-validate.js), which owns stdout.
 */

import path from 'path';
import { childLogger } from './logger.js';
import { discoverNextJsRouteFiles } from './route-discoverer.js';
import { buildImportGraph, findDependents } from './import-graph.js';
import { githubFetch } from './github-api.js';

const logger = childLogger('pr-diff-analyzer');

/**
 * Parse a GitHub PR URL into its owner/repo/prNumber components.
 *
 * Accepted formats:
 *   https://github.com/owner/repo/pull/123
 *   https://github.com/owner/repo/pull/123/files
 *
 * @param {string} prUrl
 * @returns {{ owner: string, repo: string, prNumber: number }}
 */
export function parsePrUrl(prUrl) {
  const match = String(prUrl).match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (!match) throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

/**
 * Fetch the files changed by a GitHub pull request (up to 300 — 3 pages × 100).
 *
 * Returns the per-file `status` (added | modified | removed | renamed | …) and the
 * unified-diff `patch` hunk text for each file, in addition to the filename. `status`
 * + `patch` are consumed downstream by the PR Validator's line-level annotations
 * (file:line from the patch hunks) and component→route mapping; callers that only need
 * filenames derive them with `files.map(f => f.filename)`.
 *
 * GitHub omits `patch` for binary files and files whose diff is too large to inline —
 * those come back as `patch: null` (never `undefined`).
 *
 * The REST host is `process.env.GITHUB_API_URL` (GitHub Actions sets this; GHES points it
 * at the enterprise host) and defaults to `https://api.github.com` when unset.
 *
 * @param {string} prUrl        - GitHub PR URL (any format accepted by parsePrUrl)
 * @param {string} [githubToken] - GitHub token; omit for public repos
 * @returns {Promise<Array<{ filename: string, status: string, patch: string|null }>>}
 */
export async function fetchPrFiles(prUrl, githubToken) {
  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'argusqa-os',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };

  // REST API base host. Defaults to the public github.com API; honours GITHUB_API_URL —
  // the env var GitHub Actions injects automatically (and that GitHub Enterprise Server
  // sets to the enterprise API host), so the validator works on GHES unchanged and the
  // CLI entry point is hermetically testable against a recorded fixture server. Unset →
  // 'https://api.github.com' → byte-identical to before. Trailing slash trimmed so the
  // path concatenation below never doubles a '/'.
  const apiBase = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  const allFiles = [];
  const MAX_PAGES = 3; // caps at 300 files; avoids runaway requests on mega-PRs

  for (let page = 1; page <= MAX_PAGES; page++) {
    const apiUrl = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    // E2: resilient — retries a rate-limit (403 primary / 429 secondary) + transient
    // 5xx with backoff, and throws a structured, secret-free error on 404/422/etc.
    // (the CLI surfaces err.message into a ::error:: annotation, so it must never leak
    // the token). githubFetch returns the OK Response; this loop owns the pagination.
    const res = await githubFetch(apiUrl, {
      headers,
      context: `GET repos/${owner}/${repo}/pulls/${prNumber}/files (page ${page})`,
    });
    const files = await res.json();
    allFiles.push(...files.map(f => ({
      filename: f.filename,
      status:   f.status,
      patch:    f.patch ?? null,
    })));
    if (files.length < 100) break; // last page reached
  }

  if (allFiles.length >= 300) {
    logger.warn('[ARGUS] PR has 300+ changed files — Argus analyzed the first 300. Routes affected by later files may be missed.');
  }

  return allFiles;
}

/**
 * Files that are never relevant to app routes — CI configs, docs, repo metadata.
 * Changes to ONLY these files cause mapFilesToRoutes to return [] (skip audit).
 */
const EXCLUDED_PATTERNS = [
  /^\.github\//i,
  /^docs?\//i,
  /\.md$/i,
  /^(LICENSE|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\..*)?$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
];

/**
 * Patterns that indicate an infrastructure-level file whose change can affect
 * every route — framework configs, root layouts, global stylesheets, package.json.
 * Exported for reuse by root-cause-linker.js (MIT).
 */
export const INFRA_PATTERNS = [
  /next\.config\./i,
  /vite\.config\./i,
  /tailwind\.config\./i,
  /postcss\.config\./i,
  /webpack\.config\./i,
  /global(s)?\.(css|scss|less)$/i,
  /(^|[/\\])(layout|_app|_document|root)\.(tsx?|jsx?)$/i,
  /(^|[/\\])app\.(tsx?|jsx?)$/i,
  /(^|[/\\])main\.(tsx?|jsx?)$/i,
  /package\.json$/i,
];

/**
 * Recognized monorepo workspace roots. A file under one of these (e.g.
 * "apps/web/components/Foo.tsx", "packages/ui/src/Button.tsx") carries TWO leading segments —
 * the workspace-root literal and the package name — that describe WHICH package the file
 * lives in, not which app ROUTE it affects. (PR_VALIDATOR C2 — monorepo path awareness.)
 */
const WORKSPACE_ROOTS = new Set(['apps', 'packages', 'libs', 'services']);

/**
 * Strip a leading monorepo workspace prefix ("<root>/<package>/") from a repo-relative path,
 * returning the package-relative remainder, so the workspace-root literal and the package
 * name don't pollute slug tokenization (e.g. "apps/web/checkout.tsx" → "checkout.tsx", matched
 * on "checkout" not the workspace dirs "apps"/"web"). Returns the path unchanged when it is not
 * under a recognized workspace root, or when stripping would leave no remaining segment. Pure
 * string op. (PR_VALIDATOR C2.)
 *
 * @param {string} filename - a repo-root-relative path (forward or back slashes)
 * @returns {string}
 */
export function stripWorkspacePrefix(filename) {
  const parts = String(filename).split(/[/\\]+/).filter(Boolean);
  if (parts.length >= 3 && WORKSPACE_ROOTS.has(parts[0].toLowerCase())) {
    return parts.slice(2).join('/');
  }
  return String(filename);
}

/**
 * Re-base a repo-root-relative file path onto a package-subdir `root`.
 *
 * The PR Validator's `sourceDir` may point at a monorepo PACKAGE subdir (e.g. ".../apps/web"),
 * but GitHub returns changed-file paths relative to the REPO root ("apps/web/components/Foo.tsx").
 * A naive path.resolve(root, file) then double-counts the workspace prefix and misses the file.
 * This returns the file path relative to the package by stripping the longest leading run of the
 * file's segments that equals `root`'s trailing segments (e.g. root ".../apps/web" + file
 * "apps/web/components/Foo.tsx" → "components/Foo.tsx"). Returns null when there is no such overlap
 * — the file is already package-relative, or belongs to a DIFFERENT package, in which case the
 * caller's direct resolve + conservative fallback handle it (a foreign-package file is never
 * misattributed into this package's graph). Comparison is case-insensitive (Windows/macOS).
 * Always leaves ≥1 remaining segment. Pure string op. (PR_VALIDATOR C2.)
 *
 * @param {string} root - absolute path to the package subdir (sourceDir)
 * @param {string} file - repo-root-relative changed-file path
 * @returns {string|null}
 */
export function packageRelativePath(root, file) {
  const rootSegs = String(root).split(/[/\\]+/).filter(Boolean);
  const fileSegs = String(file).split(/[/\\]+/).filter(Boolean);
  const maxK = Math.min(rootSegs.length, fileSegs.length - 1); // leave ≥1 remainder
  let best = 0;
  for (let k = 1; k <= maxK; k++) {
    const tail = rootSegs.slice(rootSegs.length - k);
    if (tail.every((s, i) => s.toLowerCase() === fileSegs[i].toLowerCase())) best = k;
  }
  return best > 0 ? fileSegs.slice(best).join('/') : null;
}

/**
 * Lowercase slug tokens extracted from a file path (e.g. "src/pages/checkout.tsx"
 * → {"src","pages","checkout"}), with any monorepo workspace prefix stripped first (C2) so
 * workspace dirs don't pollute matching. Shared by mapFilesToRoutes (route matching) and
 * resolveAnnotationTarget (annotation file matching) so the two cannot drift.
 */
function fileSlugTokens(filename) {
  return new Set(
    stripWorkspacePrefix(filename)
      .toLowerCase()
      .replace(/\.[^./\\]+$/, '')
      .split(/[/\\._-]+/)
      .filter(s => s.length > 1),
  );
}

/**
 * Meaningful lowercase segments of a route path
 * (e.g. "/checkout/review" → ["checkout","review"]). The root path "/" yields [].
 */
function routePathSegments(routePath) {
  return String(routePath ?? '')
    .toLowerCase()
    .split('/')
    .map(s => s.replace(/[^a-z0-9]/g, ''))
    .filter(s => s.length > 1);
}

/**
 * Normalize + classify changed files into the buckets every route mapper shares, so the
 * slug heuristic (mapFilesToRoutes) and the framework-aware mapper (mapFilesToRoutesDeep)
 * apply the SAME excluded/infra short-circuits and cannot drift.
 *
 * @param {Array<string|{ filename: string }>} changedFiles
 * @returns {{ fileNames: string[], appFiles: string[], allExcluded: boolean, hasInfra: boolean }}
 *   - fileNames:   every changed filename (extracted from string OR object, empties dropped)
 *   - appFiles:    fileNames minus EXCLUDED_PATTERNS (docs / CI / repo metadata)
 *   - allExcluded: there were files but ALL were excluded → audit should be skipped ([])
 *   - hasInfra:    an appFile matches INFRA_PATTERNS → blast radius is ALL routes
 */
function classifyChangedFiles(changedFiles) {
  const fileNames = (Array.isArray(changedFiles) ? changedFiles : [])
    .map(f => (typeof f === 'string' ? f : f?.filename))
    .filter(f => typeof f === 'string' && f.length > 0);
  const appFiles = fileNames.filter(f => !EXCLUDED_PATTERNS.some(re => re.test(f)));
  return {
    fileNames,
    appFiles,
    allExcluded: fileNames.length > 0 && appFiles.length === 0,
    hasInfra:    appFiles.some(f => INFRA_PATTERNS.some(re => re.test(f))),
  };
}

/**
 * Map a list of changed file paths to the subset of Argus route configs that
 * are likely affected, using heuristic slug matching.
 *
 * Heuristic rules (applied in order):
 *   1. Any infrastructure file → return ALL routes (full audit)
 *   2. File path contains a slug that matches a route path segment → include that route
 *   3. No matches → return ALL routes (conservative fallback — never miss a regression)
 *
 * @param {Array<string|{ filename: string }>} changedFiles - Filenames from fetchPrFiles;
 *   accepts either bare path strings or the `{ filename, status, patch }` objects that
 *   fetchPrFiles now returns (the filename is extracted from each).
 * @param {Array<{ path: string, name: string }>} routes - Route configs from targets.js
 * @returns {Array<{ path: string, name: string }>}
 */
export function mapFilesToRoutes(changedFiles, routes) {
  if (!routes || routes.length === 0) return [];
  if (!changedFiles || changedFiles.length === 0) return routes;

  const { fileNames, appFiles, allExcluded, hasInfra } = classifyChangedFiles(changedFiles);
  if (fileNames.length === 0) return routes;   // nothing usable → conservative
  if (allExcluded) return [];                  // README-only / CI-only PR — skip the audit
  if (hasInfra) return routes;                 // infrastructure change → full audit

  // Build a flat set of lowercase slugs from app-relevant changed files
  const fileSlugs = new Set(appFiles.flatMap(f => [...fileSlugTokens(f)]));

  const matched = routes.filter(route =>
    routePathSegments(route.path).some(seg => fileSlugs.has(seg)),
  );

  // Conservative fallback: if nothing matched, audit everything
  return matched.length > 0 ? matched : routes;
}

/** Normalize a route path to a single leading slash for slug-insensitive comparison. */
function normalizeRoutePath(p) {
  return '/' + String(p ?? '').replace(/^\/+/, '');
}

/**
 * Framework-aware route mapping (PR_VALIDATOR C1) — the precise sibling of mapFilesToRoutes.
 *
 * When `sourceDir` points at the app's source tree, a changed COMPONENT or STYLESHEET file is
 * mapped to ONLY the routes whose page files (transitively) import it — using the Next.js
 * route-file convention (route-discoverer) plus the static import graph (import-graph, which
 * tracks CSS/SCSS/Sass/Less leaves for C3) — instead of the slug heuristic's blunt all-routes
 * fallback. A changed PAGE file maps to its own route by convention. A GLOBAL stylesheet
 * (globals.css — INFRA_PATTERNS) keeps the conservative all-routes classification on purpose:
 * by convention it is imported by the root layout and applies to every route, so narrowing it
 * could miss a regression. Only NON-global stylesheets are narrowed.
 *
 * SAFETY (never miss a regression): this only ever NARROWS the result, and only when EVERY
 * changed app file resolves to ≥1 concrete route that EXISTS in the caller's `routes` list.
 * It falls back to the conservative mapFilesToRoutes (which audits ALL routes on no-match)
 * for every ambiguity:
 *   - no `sourceDir` (opt-in — default CLI behaviour is unchanged),
 *   - not a Next.js tree (no discoverable route files),
 *   - the import-graph walk hit its file cap (possibly incomplete),
 *   - a changed file is not a node in the tree (deleted, or in a DIFFERENT monorepo package
 *     than `sourceDir`; C2 re-bases a repo-root-relative path onto a package-subdir `sourceDir`,
 *     but a foreign package shares no prefix and still falls back here),
 *   - a changed file is imported by no page (could be an alias we did not resolve),
 *   - a resolved route path is absent from the caller's `routes` list.
 * Precision is therefore never paid for with a missed route.
 *
 * @param {Array<string|{ filename: string }>} changedFiles
 * @param {Array<{ path: string, name?: string }>} routes
 * @param {{ sourceDir?: string|null }} [options]
 * @returns {Array<{ path: string, name?: string }>}
 */
export function mapFilesToRoutesDeep(changedFiles, routes, { sourceDir } = {}) {
  const heuristic = () => mapFilesToRoutes(changedFiles, routes);

  if (!routes || routes.length === 0) return [];
  if (!changedFiles || changedFiles.length === 0) return routes;
  if (!sourceDir) return heuristic();   // opt-in: no source dir → pure heuristic (unchanged)

  const { fileNames, appFiles, allExcluded, hasInfra } = classifyChangedFiles(changedFiles);
  if (fileNames.length === 0) return routes;
  if (allExcluded) return [];           // docs/CI-only PR — skip (same as the heuristic)
  if (hasInfra) return heuristic();     // infra change → all routes (defer to the heuristic)

  try {
    const root       = path.resolve(sourceDir);
    const routeFiles = discoverNextJsRouteFiles(root);
    if (!routeFiles || routeFiles.length === 0) return heuristic(); // not a Next.js tree

    const graph = buildImportGraph(root);
    if (graph.truncated) return heuristic(); // file cap hit → graph may be incomplete

    // route file (abs) → set of route paths it defines
    const routeFileToPaths = new Map();
    for (const { path: rp, file } of routeFiles) {
      if (!routeFileToPaths.has(file)) routeFileToPaths.set(file, new Set());
      routeFileToPaths.get(file).add(rp);
    }
    const routeFileSet = new Set(routeFileToPaths.keys());

    // Resolve every changed app file to the route paths it can affect.
    const resolvedPaths = new Set();
    for (const f of appFiles) {
      let abs = path.resolve(root, f);
      if (!graph.files.has(abs)) {
        // C2 (monorepo): `root` may be a package subdir (".../apps/web") while `f` is
        // repo-root-relative ("apps/web/components/Foo.tsx"). Re-base onto the package and
        // retry — but ONLY adopt the result when it is a VERIFIED graph node, so a
        // foreign-package file (no prefix overlap) still falls through to the conservative
        // fallback below rather than being misattributed into this package's graph.
        const rel = packageRelativePath(root, f);
        if (rel) {
          const monoAbs = path.resolve(root, rel);
          if (graph.files.has(monoAbs)) abs = monoAbs;
        }
      }
      if (!graph.files.has(abs)) return heuristic(); // not a node in the tree → ambiguous

      const pathsForFile = new Set();
      const ownPaths = routeFileToPaths.get(abs);    // the file IS a page
      if (ownPaths) for (const p of ownPaths) pathsForFile.add(p);
      for (const dep of findDependents(graph.reverse, [abs])) {
        const depPaths = routeFileToPaths.get(dep);  // a page that imports the file
        if (depPaths) for (const p of depPaths) pathsForFile.add(p);
      }

      if (pathsForFile.size === 0) return heuristic(); // imported by no page → ambiguous
      for (const p of pathsForFile) resolvedPaths.add(p);
    }

    // Intersect resolved route paths with the caller's routes (slug-insensitive on the
    // leading slash). Any resolved path not in the list → we cannot confidently narrow.
    const routesByNorm = new Map();
    for (const r of routes) {
      const n = normalizeRoutePath(r.path);
      if (!routesByNorm.has(n)) routesByNorm.set(n, []);
      routesByNorm.get(n).push(r);
    }
    for (const p of resolvedPaths) {
      if (!routesByNorm.has(normalizeRoutePath(p))) return heuristic();
    }

    const seen = new Set();
    const matched = [];
    for (const p of resolvedPaths) {
      for (const r of routesByNorm.get(normalizeRoutePath(p))) {
        if (!seen.has(r)) { seen.add(r); matched.push(r); }
      }
    }
    if (matched.length === 0) return heuristic();
    logger.debug(`[ARGUS] C1: framework-aware mapping narrowed ${appFiles.length} file(s) to ${matched.length}/${routes.length} route(s)`);
    return matched;
  } catch (err) {
    // Any unexpected failure in static analysis must never narrow the audit — fall back.
    logger.debug(`[ARGUS] C1: framework-aware mapping failed (${err.message}) — using slug heuristic`);
    return heuristic();
  }
}

/**
 * Parse the new-file line number of the FIRST added (`+`) line in a unified-diff patch.
 *
 * Walks the first hunk that contains an added line, counting new-file lines from the
 * hunk header's `+start`. Returns null when the patch is absent/binary (`patch: null`),
 * empty, or deletion-only (no `+` line) — the caller MUST treat null as "no real line"
 * and fall back to a route-level annotation. This function never fabricates a line: every
 * value it returns is a genuine line present in the PR diff.
 *
 * @param {string|null|undefined} patch - unified-diff hunk text from fetchPrFiles
 * @returns {number|null}
 */
export function firstAddedLine(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return null;

  let newLineNo = null; // null until we are inside a hunk body
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { newLineNo = parseInt(header[1], 10); continue; }
    if (newLineNo === null) continue;  // pre-hunk lines (---/+++ file headers)

    if (line.startsWith('+')) return newLineNo;     // first added line — done
    if (line.startsWith('-')) continue;             // deletion — no new-file line consumed
    newLineNo++;                                    // context line advances the new-file counter
  }
  return null; // no added line found (deletion-only hunk)
}

/**
 * Resolve a file:line annotation target for a route from the PR's changed files.
 *
 * Returns `{ path, line }` ONLY when a changed file maps to the route SPECIFICALLY via
 * slug overlap (the same heuristic mapFilesToRoutes uses) AND that file carries a real
 * added line in its patch. Returns null — so the caller emits a route-level annotation —
 * for every ambiguous case:
 *   - the root route "/" (no segment to match specifically)
 *   - infra files (INFRA_PATTERNS → they map to ALL routes, never a specific cause)
 *   - excluded files (docs/CI metadata)
 *   - a matched file with no usable patch line (binary or deletion-only)
 *   - no slug-matching file at all
 * When several files match, the first with a usable line wins (deterministic by PR order).
 *
 * This NEVER fabricates a line: the returned `line` always comes from firstAddedLine,
 * which only yields lines genuinely present in the diff.
 *
 * @param {string} routePath - the audited route path (e.g. "/checkout")
 * @param {Array<string|{ filename: string, patch?: string|null }>} prFiles - fetchPrFiles output
 * @returns {{ path: string, line: number } | null}
 */
export function resolveAnnotationTarget(routePath, prFiles) {
  if (!Array.isArray(prFiles) || prFiles.length === 0) return null;
  const segs = routePathSegments(routePath);
  if (segs.length === 0) return null; // root / unsegmented route — no specific cause

  for (const file of prFiles) {
    const filename = typeof file === 'string' ? file : file?.filename;
    if (typeof filename !== 'string' || filename.length === 0) continue;
    if (EXCLUDED_PATTERNS.some(re => re.test(filename))) continue;
    if (INFRA_PATTERNS.some(re => re.test(filename))) continue; // maps to ALL routes — not specific

    const slugs = fileSlugTokens(filename);
    if (!segs.some(seg => slugs.has(seg))) continue;

    const patch = typeof file === 'string' ? null : file?.patch;
    const line  = firstAddedLine(patch);
    if (line != null) return { path: filename, line };
    // slug-matched but no real line (binary/deletion) — keep scanning for a better file
  }
  return null;
}
