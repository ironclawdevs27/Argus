/**
 * Aegis — team-vault routing (AEGIS_FOR_TEAMS_PLAN.md §9, the last T3 sub-item).
 *
 * When an org's central policy runs in `token` mode AND a governance token is set AND
 * a team-vault endpoint URL is configured, route the reversible token→secret mapping
 * to the org's CENTRAL team vault (the closed control plane) INSTEAD of the LOCAL
 * 0600 file (aegis-vault.js). That lets a token minted on a dev's laptop / in CI be
 * re-hydrated through the org's authorized, RBAC-gated `Reveal ▸` flow — the whole
 * point of a *team* vault (plan §5.2). Without the URL, `token` mode keeps using the
 * local vault (or masks) — the secret never leaves the machine.
 *
 * OPEN-CORE + fail-closed discipline (identical to governance-seam.js §9):
 *   • Inert unless ARGUS_GOV_TOKEN (the same master switch governanceActive() reads)
 *     AND ARGUS_REDACT_VAULT_URL are BOTH set. Off ⇒ the engine is byte-identical to
 *     v9.9.0. No phone-home, no fetch, no new required dependency, no perf cost.
 *   • The token is an HMAC tag (information-free — aegis-vault computeToken). The
 *     SECRET only ever travels to the authenticated team-vault endpoint (TLS + the
 *     gov-token bearer) and is encrypted at rest there; it NEVER reaches Slack /
 *     GitHub / the LLM / the on-disk report. The redacted artifact carries only the
 *     token. Centralized secret storage is an EXPLICIT opt-in (§14 Q1): you must set
 *     ARGUS_REDACT_VAULT_URL — presence of the URL IS the opt-in.
 *   • The tokenizer is SYNCHRONOUS (scrubText calls _vaultTokenFn inline): it computes
 *     the token + buffers the mapping in memory, and a best-effort async
 *     flushTeamVault() ships the buffer after the egress pass (mirrors
 *     governance-seam.js postRedactionAggregate). A flush failure loses only
 *     re-hydratability (the emitted token is already safe) — never a leak, never a
 *     throw. On a failed flush the buffer is retained for the next flush.
 *   • Precedence (§4.3 — a gov policy clamps the local opt-out): when the team vault
 *     is active it WINS over the local ARGUS_REDACT_VAULT vault; ensureTokenVaultWired
 *     falls back to the local vault only when the team vault is inactive.
 *
 * Uses only the global fetch (built-in on the supported Node) — NO new dependency.
 * secret-patterns.js stays I/O-free; this module injects teamTokenFor through the
 * SAME setVaultTokenizer seam aegis-vault.js uses.
 */

import { childLogger } from './logger.js';
import { setVaultTokenizer, scrubText } from './secret-patterns.js';
import { computeToken, ensureVaultWired } from './aegis-vault.js';

const logger = childLogger('aegis');

// Cap the in-memory mapping buffer so a persistent flush failure can never grow it
// unbounded. Once full we stop buffering NEW mappings (the tokens still emit + are
// safe — they just can't be re-hydrated). Matches the spirit of aegis-vault dedup.
const MAX_BUFFER = 5000;

const _buffer = new Map();   // token → secret, pending flush (dedup: first-seen wins)
const _flushed = new Set();  // tokens already shipped this process (avoid re-upload)
let _wired = false;          // is teamTokenFor currently registered on the seam?

/**
 * True iff the team vault is active: a governance token AND a team-vault endpoint URL
 * are both provisioned. ARGUS_GOV_TOKEN is the SAME master switch governanceActive()
 * reads (checked inline to keep this module free of the governance-seam import graph).
 * @returns {boolean}
 */
export function teamVaultActive() {
  return !!process.env.ARGUS_GOV_TOKEN && !!process.env.ARGUS_REDACT_VAULT_URL;
}

/**
 * The synchronous tokenizer registered on scrubText's `token` mode when the team
 * vault is active. Computes the deterministic, information-free token (aegis-vault
 * HMAC) and buffers the token→secret mapping for the async flush. Returns the token
 * to embed in the egress artifact. Never throws (scrubText's maskValue falls back to
 * mask on any throw, so even a defect here fails closed).
 * @param {*} value
 * @returns {string}
 */
export function teamTokenFor(value) {
  const token = computeToken(value);
  if (!_flushed.has(token) && !_buffer.has(token) && _buffer.size < MAX_BUFFER) {
    _buffer.set(token, String(value ?? ''));
  }
  return token;
}

/**
 * Wire the team tokenizer onto the scrubText `token` mode seam when the team vault is
 * active. Does NOT touch the seam when inactive (so the local vault path can manage
 * it). Idempotent + cheap — the egress path calls this before redacting in token mode.
 * @returns {boolean} true when the team vault is active (and now wired), else false
 */
export function ensureTeamVaultWired() {
  if (teamVaultActive()) {
    if (!_wired) { setVaultTokenizer(teamTokenFor); _wired = true; }
    return true;
  }
  if (_wired) { setVaultTokenizer(null); _wired = false; }
  return false;
}

/**
 * The unified `token` mode wiring entry the classifier calls: the TEAM vault wins
 * when active (§4.3), else fall back to the LOCAL vault (aegis-vault ensureVaultWired,
 * which itself masks when the local vault is disabled). One call site, correct
 * precedence, no double-wiring.
 * @returns {boolean} whether ANY reversible vault is now wired (team or local)
 */
export function ensureTokenVaultWired() {
  if (ensureTeamVaultWired()) return true;
  return ensureVaultWired();
}

/**
 * Ship the buffered token→secret mappings to the org's team-vault endpoint. Best-
 * effort, mirrors postRedactionAggregate: never blocks, never throws, and — because
 * the emitted tokens are already information-free — a failure never leaks. On success
 * the shipped tokens are marked flushed and the buffer is cleared; on failure the
 * buffer is retained for the next flush. No-op (inactive/empty) unless the team vault
 * is active with pending mappings.
 *
 * The body is `{ mappings: [{ token, secret }], artifactRef }` — the shape the cloud
 * team-vault ingest (flushVaultMappings) consumes. The SECRET is sent DELIBERATELY
 * (that is the centralized-vault contract, §5.2): the endpoint encrypts it at rest so
 * a later authorized, logged re-hydration can return it. The token stays on every
 * OTHER sink; the secret goes ONLY here.
 *
 * @param {{ fetchImpl?: Function, artifactRef?: string }} [deps]  test/caller seams
 * @returns {Promise<{posted:boolean, count:number, reason?:string}>}
 */
export async function flushTeamVault(deps = {}) {
  if (!teamVaultActive()) return { posted: false, count: 0, reason: 'inactive' };
  const url = process.env.ARGUS_REDACT_VAULT_URL;
  const token = process.env.ARGUS_GOV_TOKEN;
  if (!url || !token) return { posted: false, count: 0, reason: 'not-configured' };
  if (_buffer.size === 0) return { posted: true, count: 0 };

  const entries = [..._buffer.entries()];
  const mappings = entries.map(([tok, secret]) => ({ token: tok, secret }));
  const artifactRef = typeof deps.artifactRef === 'string' ? scrubText(deps.artifactRef).slice(0, 256) : null;
  try {
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mappings, artifactRef }),
    });
    if (!res || res.ok !== true) throw new Error(`team-vault flush HTTP ${res && res.status}`);
    for (const [tok] of entries) { _flushed.add(tok); }
    _buffer.clear();
    logger.debug(`[ARGUS] Aegis team vault: flushed ${mappings.length} mapping(s)`);
    return { posted: true, count: mappings.length };
  } catch (err) {
    // Fail-closed: the emitted tokens are information-free, so a failed flush leaks
    // nothing — it only forgoes central re-hydration for these tokens. Keep the buffer
    // for a later flush; never throw into the egress path.
    logger.debug(`[ARGUS] Aegis team vault: flush failed (best-effort, ignored): ${String((err && err.message) || err)}`);
    return { posted: false, count: mappings.length, reason: String((err && err.message) || err) };
  }
}

/** Count of mappings buffered and not yet flushed (telemetry/tests). */
export function pendingTeamVaultCount() {
  return _buffer.size;
}

/** Test seam — clears the buffer/flushed/wiring state. NOT for production use. */
export function _resetTeamVaultForTests() {
  _buffer.clear();
  _flushed.clear();
  _wired = false;
  setVaultTokenizer(null);
}
