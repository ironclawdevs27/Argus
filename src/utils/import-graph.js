/**
 * Argus — static ES/CJS import graph for framework-aware PR route mapping (PR_VALIDATOR C1).
 *
 * Builds a forward + reverse import adjacency over a source tree by statically parsing
 * import / export-from / require / dynamic-import specifiers (regex — no AST, no execution)
 * and resolving relative + tsconfig-alias specifiers to on-disk files. The PR Validator's
 * framework-aware mapping uses the REVERSE graph to find which route entry files
 * (transitively) import a changed component, so a PR touching `components/Foo.tsx` audits
 * only the routes that render it instead of every route.
 *
 * Deliberately conservative + bounded:
 *   - bare package specifiers (react, lodash, next/link) are ignored — they resolve to
 *     node_modules, never an app route;
 *   - unresolvable specifiers (computed requires, aliases we can't read) are dropped;
 *   - stylesheet imports (`import './x.module.css'`) are tracked as LEAF nodes so a changed
 *     stylesheet attributes to its importing routes (PR_VALIDATOR C3); they are never parsed;
 *   - the walk skips node_modules/.git/build dirs and caps file count + size.
 * The CALLER treats an INCOMPLETE resolution as "ambiguous → audit all routes", so any gap
 * in this graph costs precision, never a missed regression.
 *
 * Pure filesystem + string parsing. No Chrome, no MCP, no network. This module is reachable
 * from the MCP server (via pr-diff-analyzer), so it writes NOTHING to stdout — diagnostics
 * go to stderr through childLogger.
 */

import fs   from 'fs';
import path from 'path';
import { childLogger } from './logger.js';

const logger = childLogger('import-graph');

// Source extensions we parse + resolve, in resolution-preference order.
export const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_BASENAMES    = SOURCE_EXTS.map(e => `index${e}`);

// Stylesheet (asset) extensions tracked as LEAF nodes in the graph (PR_VALIDATOR C3): a changed
// stylesheet must resolve to its importing routes, but a stylesheet imports nothing the route
// graph cares about, so asset files are never parsed for specifiers. They participate in
// resolution ONLY with an explicit extension (you write `import './x.module.css'`), never via
// the extensionless inference used for source modules.
export const ASSET_EXTS = ['.css', '.scss', '.sass', '.less'];
const ASSET_EXT_SET     = new Set(ASSET_EXTS);
const GRAPH_EXT_SET      = new Set([...SOURCE_EXTS, ...ASSET_EXTS]);

// Directories never worth walking for app source.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'out', 'coverage', '.turbo', '.cache', '.vercel',
]);

const MAX_FILES      = 5000;          // bound the walk on a mega-repo
const MAX_FILE_BYTES = 512 * 1024;    // skip giant generated/bundled files

// Static specifier extractors. Targeted (not one mega-regex) to limit false matches.
const SPECIFIER_RES = [
  /\bimport\s+(?:[\w*${},\s]+\s+from\s+)?['"]([^'"]+)['"]/g, // import x from 'y' | import 'y'
  /\bexport\s+(?:[\w*${},\s]+\s+)?from\s+['"]([^'"]+)['"]/g, // export … from 'y'
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,                     // require('y')
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,                      // dynamic import('y')
];

/**
 * Extract the raw module specifiers referenced by a source file's text.
 * Static parse only — template-string / computed specifiers are not detected (and are
 * inherently unresolvable, so they fall into the caller's conservative bucket).
 *
 * @param {string} src
 * @returns {string[]} de-duplicated specifier strings
 */
export function parseImports(src) {
  if (typeof src !== 'string' || src.length === 0) return [];
  const found = new Set();
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * Resolve a candidate path (without/with extension, or a directory) to a concrete source
 * file on disk, applying extension inference and index-file resolution. Returns null when
 * nothing matches.
 */
function resolveFileCandidate(candidate) {
  try {
    // Exact path with a known source OR asset extension (asset = a C3 stylesheet leaf, e.g.
    // an explicit `import './x.module.css'`).
    if (GRAPH_EXT_SET.has(path.extname(candidate)) && isFile(candidate)) return candidate;
    // Extensionless import → try each source extension. (Stylesheets are always imported with
    // their extension, so they never participate in this inference.)
    for (const ext of SOURCE_EXTS) {
      const withExt = candidate + ext;
      if (isFile(withExt)) return withExt;
    }
    // Directory import → index.<ext>.
    for (const idx of INDEX_BASENAMES) {
      const indexed = path.join(candidate, idx);
      if (isFile(indexed)) return indexed;
    }
  } catch { /* fall through to null */ }
  return null;
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Read tsconfig.json / jsconfig.json `compilerOptions.paths` aliases (the common `@/*`
 * style). Lenient: strips // and /* *​/ comments + trailing commas before parsing, and
 * returns [] on any read/parse error so a missing or exotic config never throws.
 *
 * @param {string} rootDir
 * @returns {Array<{ prefix: string, targets: string[] }>} prefix→absolute-dir aliases
 */
export function loadAliases(rootDir) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(rootDir, name);
    if (!isFile(file)) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const cleaned = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1')    // line comments (not URLs after ':')
        .replace(/,(\s*[}\]])/g, '$1');        // trailing commas
      const cfg     = JSON.parse(cleaned);
      const co      = cfg.compilerOptions ?? {};
      const baseUrl = path.resolve(rootDir, co.baseUrl ?? '.');
      const paths   = co.paths ?? {};
      const aliases = [];
      for (const [key, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const prefix = key.replace(/\*$/, '');               // "@/*" → "@/"
        const absTargets = targets.map(t =>
          path.resolve(baseUrl, String(t).replace(/\*$/, '')), // "src/*" → "<base>/src/"
        );
        aliases.push({ prefix, targets: absTargets });
      }
      // Longer prefixes first so "@/components/" wins over "@/".
      aliases.sort((a, b) => b.prefix.length - a.prefix.length);
      return aliases;
    } catch (err) {
      logger.debug(`[ARGUS] C1: could not parse ${name} for path aliases — ${err.message}`);
      return [];
    }
  }
  return [];
}

/**
 * Resolve a single import specifier from a source file to an absolute on-disk source file,
 * or null when it is a bare package import / unresolvable.
 *
 * @param {string} spec        the import specifier (e.g. "../components/Foo", "@/lib/api")
 * @param {string} fromFileAbs absolute path of the importing file
 * @param {Array<{prefix:string,targets:string[]}>} aliases  from loadAliases()
 * @returns {string|null}
 */
export function resolveSpecifier(spec, fromFileAbs, aliases = []) {
  if (typeof spec !== 'string' || spec.length === 0) return null;

  // Relative import.
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return resolveFileCandidate(path.resolve(path.dirname(fromFileAbs), spec));
  }

  // tsconfig path alias.
  for (const { prefix, targets } of aliases) {
    if (prefix && spec.startsWith(prefix)) {
      const rest = spec.slice(prefix.length);
      for (const target of targets) {
        const hit = resolveFileCandidate(path.join(target, rest));
        if (hit) return hit;
      }
    }
  }

  // Bare package specifier (react, next/link, lodash/get, …) → not an app file.
  return null;
}

/**
 * Recursively collect graph files under dir — source modules plus C3 stylesheet leaves
 * (bounded; skips SKIP_DIRS + symlinks).
 */
function collectSourceFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;             // avoid symlink cycles
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (GRAPH_EXT_SET.has(path.extname(entry.name))) {
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/**
 * Build the import graph for a source tree.
 *
 * @param {string} rootDir
 * @returns {{ files: Set<string>,
 *            forward: Map<string, Set<string>>,
 *            reverse: Map<string, Set<string>>,
 *            truncated: boolean }}
 *   `forward[a]` = files a imports; `reverse[b]` = files that import b. Both keyed by
 *   absolute path. `truncated` is true when the MAX_FILES cap was hit (the graph may be
 *   incomplete → the caller must fall back conservatively).
 */
export function buildImportGraph(rootDir) {
  const files     = new Set();
  const forward   = new Map();
  const reverse   = new Map();
  const empty     = { files, forward, reverse, truncated: false };

  if (typeof rootDir !== 'string' || !isDir(rootDir)) return empty;

  const sourceFiles = collectSourceFiles(rootDir);
  const truncated   = sourceFiles.length >= MAX_FILES;
  const fileSet     = new Set(sourceFiles);
  const aliases     = loadAliases(rootDir);

  for (const file of sourceFiles) {
    files.add(file);
    if (!forward.has(file)) forward.set(file, new Set());

    // C3: stylesheet leaves are graph NODES (so a changed stylesheet resolves + carries reverse
    // edges from its importers) but import nothing the route graph tracks — never parse them.
    if (ASSET_EXT_SET.has(path.extname(file))) continue;

    let src;
    try {
      // Open once and stat/read the SAME descriptor — avoids a stat→read TOCTOU on `file`
      // (CodeQL js/file-system-race). The size guard still skips pathologically large files.
      const fd = fs.openSync(file, 'r');
      try {
        if (fs.fstatSync(fd).size > MAX_FILE_BYTES) continue; // skip giant files
        src = fs.readFileSync(fd, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch { continue; }

    for (const spec of parseImports(src)) {
      const target = resolveSpecifier(spec, file, aliases);
      if (!target || !fileSet.has(target)) continue;        // bare pkg or outside the tree
      forward.get(file).add(target);
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }

  return { files, forward, reverse, truncated };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Transitive reverse closure: every file that (directly or indirectly) imports any seed.
 * Seeds themselves are NOT included unless they are reached via another importer.
 *
 * @param {Map<string, Set<string>>} reverse  reverse adjacency from buildImportGraph
 * @param {Iterable<string>} seeds            absolute paths of changed files
 * @returns {Set<string>} absolute paths of importing files
 */
export function findDependents(reverse, seeds) {
  const dependents = new Set();
  const stack = [...seeds];
  const visited = new Set(stack);
  while (stack.length > 0) {
    const cur = stack.pop();
    const importers = reverse.get(cur);
    if (!importers) continue;
    for (const imp of importers) {
      if (!dependents.has(imp)) {
        dependents.add(imp);
        if (!visited.has(imp)) { visited.add(imp); stack.push(imp); }
      }
    }
  }
  return dependents;
}
