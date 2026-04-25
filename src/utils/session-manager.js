/**
 * ARGUS Session Manager (v3 Phase B2 / D7.6)
 *
 * Saves and restores browser session state (cookies + localStorage + sessionStorage)
 * so Argus can crawl authenticated routes without re-logging in for each route.
 *
 * Limitation: only JS-accessible cookies are captured (not HttpOnly). For apps
 * that rely solely on HttpOnly session cookies, use a persistent Chrome profile
 * (--user-data-dir) instead. JS-accessible cookies (CSRF tokens, preferences),
 * localStorage (JWT, user prefs), and sessionStorage are all fully supported.
 *
 * Session file format (JSON):
 * {
 *   savedAt:        ISO timestamp,
 *   originUrl:      origin the session was captured from,
 *   cookies:        document.cookie string (JS-visible cookies only),
 *   localStorage:   { key → value },
 *   sessionStorage: { key → value }
 * }
 *
 * Integration in crawl-and-report.js:
 *   if (auth?.steps?.length > 0) {
 *     const sf = auth.sessionFile ?? '.argus-session.json';
 *     if (!hasSession(sf, auth.sessionMaxAgeMs)) {
 *       await runLoginFlow(mcp, baseUrl, auth.steps);
 *       await saveSession(mcp, sf);
 *     }
 *   }
 *   // … before each route (D7.6 refresh comes first):
 *   await refreshSession(mcp, auth, baseUrl);
 *   await restoreSession(mcp, baseUrl, sf);
 */

import fs from 'fs';
import { runFlow } from './flow-runner.js';
import { unwrapEval } from './mcp-client.js';

// ── Capture Script ─────────────────────────────────────────────────────────────

/**
 * Arrow-function string executed via evaluate_script.
 * Returns a JSON string of { cookies, localStorage, sessionStorage, origin }.
 */
const SESSION_CAPTURE_SCRIPT = `() => {
  var ls = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    ls[k] = localStorage.getItem(k);
  }
  var ss = {};
  for (var i = 0; i < sessionStorage.length; i++) {
    var k = sessionStorage.key(i);
    ss[k] = sessionStorage.getItem(k);
  }
  return JSON.stringify({
    cookies: document.cookie,
    localStorage: ls,
    sessionStorage: ss,
    origin: window.location.origin
  });
}`;

// ── Restore Script Builder ─────────────────────────────────────────────────────

/**
 * Build an arrow-function string that restores all saved session state
 * into the current page context.
 *
 * Cookies are set with path=/ so they apply to all routes on the origin.
 * Values are JSON.stringify-escaped to prevent injection.
 *
 * @param {object} state - Parsed session file object
 * @returns {string} Arrow-function string for evaluate_script
 */
function buildRestoreScript(state) {
  const lines = [];

  // Restore cookies (JS-accessible only; HttpOnly cookies cannot be set via JS)
  if (state.cookies) {
    for (const part of state.cookies.split(';')) {
      const pair = part.trim();
      if (pair) {
        // path=/ ensures the cookie is visible on all routes, not just the current path
        lines.push(`document.cookie=${JSON.stringify(pair + '; path=/')};`);
      }
    }
  }

  // Restore localStorage
  for (const [k, v] of Object.entries(state.localStorage ?? {})) {
    lines.push(`localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v ?? ''))});`);
  }

  // Restore sessionStorage
  for (const [k, v] of Object.entries(state.sessionStorage ?? {})) {
    lines.push(`sessionStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v ?? ''))});`);
  }

  return `() => { ${lines.join(' ')} return true; }`;
}

// ── Login Flow Runner ──────────────────────────────────────────────────────────

/**
 * Execute a login flow defined as a steps array in `targets.js`.
 *
 * Delegates to flow-runner.js runFlow — same step DSL (navigate, fill, click,
 * press_key, waitFor, sleep, handle_dialog, assert). The full superset of actions
 * is available here, not just the original subset.
 *
 * Use explicit `sleep` steps or `waitFor` steps for timing between actions —
 * the automatic 300ms inter-step delay from the old implementation is removed.
 *
 * @param {object} mcp      - MCP tool interface
 * @param {string} baseUrl  - Base URL prepended to path-relative navigate steps
 * @param {object[]} steps  - Step definitions (same DSL as flows[] in targets.js)
 */
export async function runLoginFlow(mcp, baseUrl, steps) {
  await runFlow({ name: 'login', steps }, baseUrl, mcp);
}

// ── Session Save ───────────────────────────────────────────────────────────────

/**
 * Capture session state from the currently-loaded page and write to a JSON file.
 * Must be called while the browser is on the authenticated origin.
 *
 * @param {object} mcp         - MCP tool interface (evaluate_script)
 * @param {string} sessionFile - Path to write the session JSON
 * @returns {Promise<object>}  The session state object (also written to disk)
 */
export async function saveSession(mcp, sessionFile) {
  const raw = await mcp.evaluate_script({ function: SESSION_CAPTURE_SCRIPT });
  const val = unwrapEval(raw);

  let parsed;
  try {
    parsed = typeof val === 'string' ? JSON.parse(val) : val;
    if (!parsed || typeof parsed !== 'object') throw new Error('unexpected shape');
  } catch {
    throw new Error(`[ARGUS] saveSession: evaluate_script returned non-JSON — Chrome may not be running. Raw: ${String(val).slice(0, 120)}`);
  }

  const state = {
    savedAt:        new Date().toISOString(),
    originUrl:      String(parsed.origin ?? ''),
    cookies:        String(parsed.cookies ?? ''),
    localStorage:   typeof parsed.localStorage  === 'object' ? parsed.localStorage  : {},
    sessionStorage: typeof parsed.sessionStorage === 'object' ? parsed.sessionStorage : {},
  };

  fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), 'utf8');

  const lsCount   = Object.keys(state.localStorage).length;
  const ssCount   = Object.keys(state.sessionStorage).length;
  const hasCookie = state.cookies.length > 0;
  console.log(
    `[ARGUS] Session saved → ${sessionFile}` +
    ` (${lsCount} localStorage, ${ssCount} sessionStorage, cookies: ${hasCookie ? 'yes' : 'none'})`
  );

  return state;
}

// ── Session Restore ────────────────────────────────────────────────────────────

/**
 * Restore a saved session into the browser.
 *
 * Must navigate to the saved origin before injecting so that cookies and
 * localStorage are set for the correct domain. After restore, the browser
 * remains on `baseUrl` — the caller should then navigate to the target route.
 *
 * @param {object} mcp         - MCP tool interface (navigate_page, evaluate_script)
 * @param {string} baseUrl     - Must match the origin the session was captured from
 * @param {string} sessionFile - Path to the session JSON file
 * @returns {Promise<boolean>} true if session was restored, false if no session file
 */
export async function restoreSession(mcp, baseUrl, sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    console.warn(`[ARGUS] No session file at ${sessionFile} — skipping restore`);
    return false;
  }

  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

  // Navigate to the origin so cookies land on the right domain
  await mcp.navigate_page({ url: baseUrl });
  await new Promise(r => setTimeout(r, 400));

  const restoreScript = buildRestoreScript(state);
  await mcp.evaluate_script({ function: restoreScript });

  console.log(`[ARGUS] Session restored from ${sessionFile} (saved at ${state.savedAt})`);
  return true;
}

// ── Session Utilities ──────────────────────────────────────────────────────────

/**
 * Check whether a valid, non-expired session file exists.
 *
 * @param {string} sessionFile
 * @param {number} [maxAgeMs=3600000] - Max age in ms before requiring re-login (default: 1 h)
 * @returns {boolean}
 */
export function hasSession(sessionFile, maxAgeMs = 60 * 60 * 1000) {
  if (!fs.existsSync(sessionFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const age   = Date.now() - new Date(state.savedAt).getTime();
    return age < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Delete the session file, forcing re-login on the next run.
 *
 * @param {string} sessionFile
 */
export function clearSession(sessionFile) {
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    console.log(`[ARGUS] Session cleared: ${sessionFile}`);
  }
}

// ── Session Refresh (D7.6) ─────────────────────────────────────────────────────

/**
 * Refresh the session mid-run if it is approaching expiry.
 *
 * Called between routes in crawl-and-report.js (before restoreSession). When the
 * saved session has less than `auth.sessionRefreshWindowMs` of validity remaining,
 * the full login flow is re-run and a fresh session is saved. This prevents long
 * crawls from failing on their last routes when the auth cookie expires mid-run.
 *
 * No-ops when:
 *   - auth is null or has no steps (public crawl)
 *   - no session file exists yet (initial login not done)
 *   - the session still has more than refreshWindowMs remaining
 *
 * Note: when ARGUS_CONCURRENCY > 1, multiple shard workers call this independently.
 * Concurrent refreshes are harmless — both logins succeed — but may produce two
 * sequential login flows. The last saveSession write wins (valid credentials).
 *
 * @param {object} mcp     - MCP tool interface (navigate_page, evaluate_script)
 * @param {object|null} auth - Auth config from targets.js (steps, sessionFile,
 *                             sessionMaxAgeMs, sessionRefreshWindowMs)
 * @param {string} baseUrl - Base URL used for the login navigate step
 * @returns {Promise<{ refreshed: boolean }>}
 */
export async function refreshSession(mcp, auth, baseUrl) {
  if (!auth?.steps?.length) return { refreshed: false };

  const sessionFile      = auth.sessionFile         ?? '.argus-session.json';
  const maxAgeMs         = auth.sessionMaxAgeMs      ?? 60 * 60 * 1000;  // default 1 h
  const refreshWindowMs  = auth.sessionRefreshWindowMs ?? 5 * 60 * 1000; // default 5 min

  if (!fs.existsSync(sessionFile)) return { refreshed: false };

  let state;
  try {
    state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch {
    return { refreshed: false };
  }

  const age         = Date.now() - new Date(state.savedAt).getTime();
  const remainingMs = maxAgeMs - age;

  if (remainingMs > refreshWindowMs) return { refreshed: false };

  console.log(
    `[ARGUS] Auth: session expires in ${Math.round(remainingMs / 1000)}s — refreshing login...`
  );
  await runLoginFlow(mcp, baseUrl, auth.steps);
  await saveSession(mcp, sessionFile);
  return { refreshed: true };
}
