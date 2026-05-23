/**
 * Login Orchestrator — run login flows and manage mid-run session refresh.
 *
 * Extracted from session-manager.js (v9.1.7). Handles:
 *   - runLoginFlow: execute a targets.js auth.steps flow
 *   - refreshSession: detect expiring sessions and re-login proactively
 *
 * Uses a lock file to prevent concurrent shards from running redundant
 * login flows when ARGUS_CONCURRENCY > 1.
 */

import fs from 'fs';
import { runFlow } from './flow-runner.js';
import { saveSession } from './session-persistence.js';
import { childLogger } from './logger.js';

const logger = childLogger('login-orchestrator');

// ── Login Flow Runner ───────────────────────────────────────────────────────────

/**
 * Execute a login flow defined as a steps array in targets.js.
 *
 * Delegates to flow-runner.js runFlow — same step DSL (navigate, fill, click,
 * press_key, waitFor, sleep, handle_dialog, assert).
 *
 * @param {object}   browser  - CdpBrowserAdapter
 * @param {string}   baseUrl  - Base URL prepended to path-relative navigate steps
 * @param {object[]} steps    - Step definitions (same DSL as flows[] in targets.js)
 */
export async function runLoginFlow(browser, baseUrl, steps) {
  await runFlow({ name: 'login', steps }, baseUrl, browser);
}

// ── Session Refresh (D7.6) ──────────────────────────────────────────────────────

/**
 * Refresh the session mid-run if it is approaching expiry.
 *
 * Called between routes (before restoreSession). When the saved session has
 * less than auth.sessionRefreshWindowMs of validity remaining, the full login
 * flow is re-run and a fresh session is saved.
 *
 * No-ops when:
 *   - auth is null or has no steps (public crawl)
 *   - no session file exists yet (initial login not done)
 *   - the session still has more than refreshWindowMs remaining
 *
 * @param {object}      browser - CdpBrowserAdapter
 * @param {object|null} auth    - Auth config from targets.js
 * @param {string}      baseUrl - Base URL used for the login navigate step
 * @returns {Promise<{ refreshed: boolean }>}
 */
export async function refreshSession(browser, auth, baseUrl) {
  if (!auth?.steps?.length) return { refreshed: false };

  const sessionFile     = auth.sessionFile          ?? '.argus-session.json';
  const maxAgeMs        = auth.sessionMaxAgeMs       ?? 60 * 60 * 1000;
  const refreshWindowMs = auth.sessionRefreshWindowMs ?? 5 * 60 * 1000;

  if (!fs.existsSync(sessionFile)) return { refreshed: false };

  let state;
  try {
    state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch {
    return { refreshed: false };
  }

  const age = Date.now() - new Date(state.savedAt).getTime();
  if (isNaN(age)) return { refreshed: false };
  const remainingMs = maxAgeMs - age;

  if (remainingMs > refreshWindowMs) return { refreshed: false };

  logger.info(
    `[ARGUS] Auth: session expires in ${Math.round(remainingMs / 1000)}s — refreshing login...`
  );

  const lockFile = sessionFile + '.lock';
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockFile, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      logger.info('[ARGUS] Auth: refresh lock held by another shard — skipping duplicate login');
      return { refreshed: false };
    }
    throw err;
  }
  try {
    await runLoginFlow(browser, baseUrl, auth.steps);
    await saveSession(browser, sessionFile);
    return { refreshed: true };
  } finally {
    if (lockFd !== null) { try { fs.closeSync(lockFd); } catch {} }
    try { fs.unlinkSync(lockFile); } catch {}
  }
}
