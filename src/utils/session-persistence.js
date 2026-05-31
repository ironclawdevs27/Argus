/**
 * Session Persistence — save / restore / query browser session state.
 *
 * Handles cookies (JS-accessible only), localStorage, and sessionStorage.
 * Uses an atomic tmp→rename write so a mid-write crash leaves the previous
 * session file intact rather than a truncated JSON blob.
 *
 * Session file format:
 * {
 *   savedAt:        ISO timestamp,
 *   originUrl:      origin the session was captured from,
 *   cookies:        document.cookie string (JS-visible cookies only),
 *   localStorage:   { key → value },
 *   sessionStorage: { key → value }
 * }
 */

import fs from 'fs';
import path from 'path';
import { unwrapEval } from './mcp-client.js';
import { childLogger } from './logger.js';

const logger = childLogger('session-persistence');

// ── Capture Script ──────────────────────────────────────────────────────────────

const SESSION_CAPTURE_SCRIPT = `() => {
  var ls = {};
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k !== null) ls[k] = localStorage.getItem(k);
  }
  var ss = {};
  for (var j = 0; j < sessionStorage.length; j++) {
    var sk = sessionStorage.key(j);
    if (sk !== null) ss[sk] = sessionStorage.getItem(sk);
  }
  return JSON.stringify({
    cookies: document.cookie,
    localStorage: ls,
    sessionStorage: ss,
    origin: window.location.origin
  });
}`;

// ── Restore Script Builder ──────────────────────────────────────────────────────

function buildRestoreScript(state) {
  const lines = [];

  if (state.cookies) {
    for (const part of state.cookies.split(';')) {
      const pair = part.trim();
      if (pair) {
        lines.push(`document.cookie=${JSON.stringify(pair + '; path=/')};`);
      }
    }
  }

  for (const [k, v] of Object.entries(state.localStorage ?? {})) {
    lines.push(`localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v ?? ''))});`);
  }

  for (const [k, v] of Object.entries(state.sessionStorage ?? {})) {
    lines.push(`sessionStorage.setItem(${JSON.stringify(k)},${JSON.stringify(String(v ?? ''))});`);
  }

  return `() => { ${lines.join(' ')} return true; }`;
}

// ── Session Save ────────────────────────────────────────────────────────────────

/**
 * Capture session state from the current page and write to a JSON file.
 * Must be called while the browser is on the authenticated origin.
 *
 * @param {object} browser     - CdpBrowserAdapter
 * @param {string} sessionFile - Path to write the session JSON
 * @returns {Promise<object>}  The session state object
 */
export async function saveSession(browser, sessionFile) {
  let raw;
  try {
    raw = await browser.evaluate(SESSION_CAPTURE_SCRIPT);
  } catch (err) {
    throw new Error(`[ARGUS] saveSession: evaluate_script failed — Chrome may not be running: ${err.message}`);
  }
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
    localStorage:   parsed.localStorage  !== null && typeof parsed.localStorage  === 'object' ? parsed.localStorage  : {},
    sessionStorage: parsed.sessionStorage !== null && typeof parsed.sessionStorage === 'object' ? parsed.sessionStorage : {},
  };

  const dir = path.dirname(sessionFile);
  try {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`[ARGUS] saveSession: failed to create directory "${dir}": ${err.message}`);
  }

  const tmpFile = `${sessionFile}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, sessionFile);
  } catch (err) {
    throw new Error(`[ARGUS] saveSession: failed to write session file "${sessionFile}": ${err.message}`);
  }

  const lsCount   = Object.keys(state.localStorage).length;
  const ssCount   = Object.keys(state.sessionStorage).length;
  const hasCookie = state.cookies.length > 0;
  logger.info(
    `[ARGUS] Session saved → ${sessionFile}` +
    ` (${lsCount} localStorage, ${ssCount} sessionStorage, cookies: ${hasCookie ? 'yes' : 'none'})`
  );

  return state;
}

// ── Session Restore ─────────────────────────────────────────────────────────────

/**
 * Restore a saved session into the browser.
 *
 * Navigates to baseUrl so cookies land on the correct domain, injects saved
 * state, then returns. Caller should navigate to the target route afterward.
 *
 * @param {object} browser     - CdpBrowserAdapter
 * @param {string} baseUrl     - Must match the origin the session was captured from
 * @param {string} sessionFile - Path to the session JSON file
 * @returns {Promise<boolean>} true if session was restored, false if no session file
 */
export async function restoreSession(browser, baseUrl, sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    logger.warn(`[ARGUS] No session file at ${sessionFile} — skipping restore`);
    return false;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch (err) {
    logger.warn(`[ARGUS] Failed to parse session file ${sessionFile}: ${err.message}`);
    return false;
  }

  if (state.originUrl) {
    try {
      const savedOrigin   = new URL(state.originUrl).origin;
      const currentOrigin = new URL(baseUrl).origin;
      if (savedOrigin !== currentOrigin) {
        logger.warn(
          `[ARGUS] Session origin mismatch: saved="${savedOrigin}" current="${currentOrigin}" — ` +
          `session will not apply; re-run login to capture a fresh session`
        );
        return false;
      }
    } catch { /* URL parse failure — proceed and let Chrome handle it */ }
  }

  const NAV_TIMEOUT_MS = 10000;
  await Promise.race([
    browser.navigate(baseUrl),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`restoreSession: navigate to "${baseUrl}" timed out after ${NAV_TIMEOUT_MS}ms`)), NAV_TIMEOUT_MS)),
  ]);
  await new Promise(r => setTimeout(r, 400));

  const restoreScript = buildRestoreScript(state);
  await browser.evaluate(restoreScript);

  logger.info(`[ARGUS] Session restored from ${sessionFile} (saved at ${state.savedAt})`);
  return true;
}

// ── Session Utilities ───────────────────────────────────────────────────────────

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
  let cleared = false;
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    cleared = true;
  }
  const tmpFile = `${sessionFile}.tmp`;
  if (fs.existsSync(tmpFile)) {
    try {
      fs.unlinkSync(tmpFile);
      logger.debug(`[ARGUS] Removed stale session temp file: ${tmpFile}`);
    } catch {}
  }
  if (cleared) logger.info(`[ARGUS] Session cleared: ${sessionFile}`);
}
