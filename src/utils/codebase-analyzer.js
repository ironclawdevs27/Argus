/**
 * ARGUS Phase C1: Codebase Cross-Reference Analysis
 *
 * Reads target app source files to surface issues that browser-only testing misses:
 *   C1.1  env_var_missing      — process.env.X used in code but absent from all .env files
 *   C1.2  feature_flag_leakage — env var used in a conditional that is falsy/unset in .env
 *   C1.3  error_source_linked  — console error stack trace parsed to file:line (info — enrichment)
 *   C1.4  dead_route           — internal navigation link that returns HTTP 404
 *
 * All functions are pure (no MCP dependency) except detectDeadRoutes which does
 * Node.js fetch() calls — it still requires no browser.
 */

import fs   from 'fs';
import path from 'path';

// ── File scanning ──────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte']);

// Node/OS built-in env names to skip in all checks
const BUILTIN_VARS = new Set([
  'NODE_ENV', 'PORT', 'HOST', 'PATH', 'HOME', 'USER', 'SHELL', 'PWD',
  'LANG', 'TZ', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'LOGNAME', 'UID',
  'COLORTERM', 'npm_package_version', 'npm_lifecycle_event',
]);

function collectSourceFiles(sourceDir) {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === '.next') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); }
      else if (SOURCE_EXTENSIONS.has(path.extname(e.name))) {
        try { files.push({ filePath: full, content: fs.readFileSync(full, 'utf8') }); } catch {}
      }
    }
  }
  walk(sourceDir);
  return files;
}

function parseEnvFile(envFilePath) {
  const vars = {};
  let content;
  try { content = fs.readFileSync(envFilePath, 'utf8'); } catch { return vars; }
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) vars[key] = val;
  }
  return vars;
}

function loadDeclaredVars(sourceDir, envFile) {
  const declared = {};
  const candidates = [
    envFile,
    envFile ? null : path.join(sourceDir, '.env'),
    path.join(sourceDir, '.env.local'),
    path.join(sourceDir, '.env.example'),
    path.join(sourceDir, '.env.development'),
    path.join(sourceDir, '.env.production'),
  ].filter(Boolean);

  for (const ef of candidates) Object.assign(declared, parseEnvFile(ef));

  // Runtime env (the process running Argus) counts too — it may have vars set in CI
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) declared[k] = v;
  }
  return declared;
}

// ── C1.1: Env variable audit ───────────────────────────────────────────────────

const ENV_REF_RE = /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g;

export function auditEnvVariables(sourceDir, envFile) {
  if (!sourceDir) return [];
  const files    = collectSourceFiles(sourceDir);
  const declared = loadDeclaredVars(sourceDir, envFile);

  // Collect all refs: varName → [relPath, ...]
  const refs = {};
  for (const { filePath, content } of files) {
    const rel = path.relative(sourceDir, filePath);
    ENV_REF_RE.lastIndex = 0;
    let m;
    while ((m = ENV_REF_RE.exec(content)) !== null) {
      const name = m[1];
      if (BUILTIN_VARS.has(name)) continue;
      if (!refs[name]) refs[name] = [];
      if (!refs[name].includes(rel)) refs[name].push(rel);
    }
  }

  return Object.entries(refs)
    .filter(([name]) => !(name in declared))
    .map(([name, files]) => ({
      type:         'env_var_missing',
      varName:      name,
      referencedIn: files.slice(0, 5),
      message:      `process.env.${name} referenced in source but not declared in any .env file (found in: ${files.slice(0, 3).join(', ')})`,
      severity:     'warning',
    }));
}

// ── C1.2: Feature flag leakage ────────────────────────────────────────────────
// Detect env vars used in conditionals (if/&&/||/ternary) that are falsy in .env.
// A permanently-disabled code path is a dead-weight risk — it may also shadow bugs.

// Match env var on either side of a comparison / logical operator
const FLAG_RE = /(?:(?:if\s*\(|&&|\|\||[?]|===|!==|==|!=)\s*process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\.([A-Z_][A-Z0-9_]*)\s*(?:===|!==|==|!=|&&|\|\||[?:]))/g;

export function detectFeatureFlagLeakage(sourceDir, envFile) {
  if (!sourceDir) return [];
  const files   = collectSourceFiles(sourceDir);
  const envVars = parseEnvFile(envFile ?? path.join(sourceDir, '.env'));
  // Don't use runtime process.env here — we want to surface flags that are absent from .env

  const findings = [];
  const seen     = new Set();

  for (const { filePath, content } of files) {
    const rel = path.relative(sourceDir, filePath);
    FLAG_RE.lastIndex = 0;
    let m;
    while ((m = FLAG_RE.exec(content)) !== null) {
      const name = m[1] ?? m[2];
      if (!name || BUILTIN_VARS.has(name)) continue;

      const dedupeKey = `${name}::${rel}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const value = envVars[name]; // undefined if not in .env
      const falsy = value === undefined || value === '' || value === 'false' || value === '0';
      if (!falsy) continue;

      findings.push({
        type:    'feature_flag_leakage',
        varName: name,
        value:   value ?? '(not set)',
        file:    rel,
        message: `process.env.${name} is used in a conditional in ${rel} but is ${value === undefined ? 'not set in .env' : `"${value}" (falsy)`} — that code branch is permanently disabled`,
        severity: 'warning',
      });
    }
  }
  return findings;
}

// ── C1.3: Error-to-source linking ─────────────────────────────────────────────
// Parse stack traces from console error findings. Source maps are not resolved —
// we surface the bundle file:line as-is; that's already enough to grep.

// Chrome stack frame:  "    at FnName (http://host/bundle.js:1:4567)"
// Chrome anon:         "    at http://host/chunk.js:1:4567"
const FRAME_RE = /at\s+(?:([^\s(]+)\s+\()?(?:https?:\/\/[^)]+?\/([^/)\s]+\.(?:js|ts|jsx|tsx|mjs)):(\d+):(\d+)\)?|([^\s/]+\.(?:js|ts|jsx|tsx|mjs)):(\d+):(\d+))/g;

export function enrichErrorsWithSource(consoleFindings) {
  const enriched = [];
  for (const finding of consoleFindings) {
    if (finding.type !== 'console') continue;
    const msg = String(finding.message ?? finding.text ?? '');
    if (!msg.includes(' at ')) continue;

    const frames = [];
    FRAME_RE.lastIndex = 0;
    let m;
    while ((m = FRAME_RE.exec(msg)) !== null && frames.length < 5) {
      frames.push({
        fn:   m[1] ?? '(anonymous)',
        file: m[2] ?? m[5] ?? '?',
        line: parseInt(m[3] ?? m[6] ?? '0', 10),
        col:  parseInt(m[4] ?? m[7] ?? '0', 10),
      });
    }
    if (frames.length === 0) continue;

    const top = frames[0];
    enriched.push({
      type:            'error_source_linked',
      originalMessage: msg.slice(0, 200),
      stackFrames:     frames,
      message:         `Console error in ${top.file}:${top.line} (fn: ${top.fn})`,
      severity:        'info',
    });
  }
  return enriched;
}

// ── C1.4: Dead route detection ────────────────────────────────────────────────
// HEAD-request each internal link discovered on crawled pages that was not already
// in the targeted route list. 404 responses are emitted as dead_route warnings.

const INTERNAL_LINKS_SCRIPT = `() => {
  try {
    var o = window.location.origin;
    return Array.from(document.querySelectorAll('a[href]'))
      .map(function(a){ return a.href; })
      .filter(function(h){
        if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:') || h.startsWith('javascript:')) return false;
        try { return new URL(h).origin === o; } catch { return false; }
      });
  } catch(e) { return []; }
}`;

export { INTERNAL_LINKS_SCRIPT };

export async function detectDeadRoutes(baseUrl, discoveredLinks, alreadyTestedPaths) {
  if (!discoveredLinks?.length) return [];

  const findings  = [];
  const testedSet = new Set(
    (alreadyTestedPaths ?? []).map(p => p.replace(/\/$/, '') || '/')
  );

  for (const href of discoveredLinks) {
    let normalized;
    try {
      const u = new URL(href, baseUrl);
      normalized = u.pathname.replace(/\/$/, '') || '/';
    } catch { continue; }

    if (testedSet.has(normalized)) continue;
    testedSet.add(normalized);

    try {
      const res = await fetch(new URL(href, baseUrl).href, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      if (res.status === 404) {
        findings.push({
          type:     'dead_route',
          path:     normalized,
          status:   404,
          message:  `Internal link ${normalized} returns 404`,
          severity: 'warning',
        });
      }
    } catch { /* network error — skip */ }
  }
  return findings;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * C1 codebase analysis — static analysis (no MCP, no browser).
 * detectDeadRoutes is called separately from runCrawl (needs discovered link list).
 *
 * @param {object}   opts
 * @param {string}   opts.sourceDir       — abs path to target app source code
 * @param {string}  [opts.envFile]        — path to .env file (defaults to sourceDir/.env)
 * @param {object[]} [opts.consoleFindings] — console findings from route crawl for enrichment
 * @returns {object[]} findings array (env_var_missing, feature_flag_leakage, error_source_linked)
 */
export async function analyzeCodebase({ sourceDir, envFile = null, consoleFindings = [] } = {}) {
  if (!sourceDir) return [];

  const findings = [];

  try { findings.push(...auditEnvVariables(sourceDir, envFile)); }
  catch (e) { console.warn(`[ARGUS] C1: env audit skipped: ${e.message}`); }

  try { findings.push(...detectFeatureFlagLeakage(sourceDir, envFile)); }
  catch (e) { console.warn(`[ARGUS] C1: feature flag check skipped: ${e.message}`); }

  try { findings.push(...enrichErrorsWithSource(consoleFindings)); }
  catch (e) { console.warn(`[ARGUS] C1: error enrichment skipped: ${e.message}`); }

  return findings;
}
