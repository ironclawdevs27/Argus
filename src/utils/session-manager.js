/**
 * Session Manager — backward-compat re-export barrel (v9.1.7).
 *
 * All callers continue to import from this file unchanged.
 * Implementations live in the two focused modules below.
 *
 *   session-persistence.js — saveSession, restoreSession, hasSession, clearSession
 *   login-orchestrator.js  — runLoginFlow, refreshSession
 */

export * from './session-persistence.js';
export * from './login-orchestrator.js';
