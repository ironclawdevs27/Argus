/**
 * Aegis — local re-hydration vault (Step 8 of REDACTION_BOUNDARY_MAX_PLAN.md).
 *
 * OPTIONAL, default OFF (ARGUS_REDACT_VAULT=1 to enable). Implements the enterprise
 * "smart redaction" reversible-tokenization pattern (plan §5.3): a sensitive span is
 * replaced on egress (scrubText's `token` mode) by a deterministic, information-free
 * token (`AEGIS_<hmac16>`), and the token→original mapping is written to a LOCAL,
 * gitignored, 0600 vault file. The token that crosses the trust boundary reveals
 * NOTHING; only an operator on THIS machine — who holds the per-machine key and the
 * vault files — can re-hydrate via `npm run report:rehydrate`.
 *
 * SECURITY POSTURE — fail CLOSED (consistent with the rest of Aegis):
 *   - The token is an HMAC tag → it cannot contain the secret. A leak of the egress
 *     artifact discloses no plaintext.
 *   - If the vault is NOT enabled / wired, scrubText's `token` mode falls back to
 *     MASK (never the raw value) — see secret-patterns.js maskValue.
 *   - The vault key + mapping files are written 0600 and live under
 *     reports/.aegis-vault/ (gitignored). The audit trail is secret-free (token only).
 *
 * Crypto note (plan §5.3 / §13.6): the default token is HMAC-SHA256 — NOT
 * format-preserving, so it needs no cipher. If a shape-preserving token is ever
 * required, use NIST FF1 (SP 800-38G); FF3/FF3-1 were WITHDRAWN by NIST in Feb 2025
 * and must not be used.
 *
 * This module is the ONLY place Aegis does filesystem I/O. secret-patterns.js stays
 * pure — it receives `tokenFor` through the setVaultTokenizer injection seam.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { childLogger } from './logger.js';
import { getCurrentBranch } from './baseline-manager.js';
import { setVaultTokenizer } from './secret-patterns.js';

const logger = childLogger('aegis-vault');

const TOKEN_PREFIX = 'AEGIS_';
const TOKEN_HEX_LEN = 16;                  // 64-bit HMAC tag
// Matches exactly what computeToken emits — used by rehydrate to find tokens.
const TOKEN_RE = /AEGIS_[0-9a-f]{16}/g;

let _key = null;        // cached per-machine key (Buffer)
let _branch = null;     // cached branch name (avoid repeated git calls)
let _wired = false;     // setVaultTokenizer registered?
const _seen = new Set(); // tokens persisted this process (in-run dedup)

/** True when the operator opted into the reversible vault. */
export function vaultEnabled() {
  return process.env.ARGUS_REDACT_VAULT === '1';
}

/** Base vault dir (overridable for tests/operators via ARGUS_REDACT_VAULT_DIR). */
function vaultDir() {
  return process.env.ARGUS_REDACT_VAULT_DIR || path.join('reports', '.aegis-vault');
}

/** Secret-free provenance/audit dir (sibling of the vault). */
function auditDir() {
  return process.env.ARGUS_REDACT_AUDIT_DIR || path.join('reports', '.aegis-audit');
}

function keyFile() {
  return path.join(vaultDir(), 'key');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
}

/**
 * Per-machine HMAC key. Read from reports/.aegis-vault/key if present, else
 * generated (32 random bytes) and persisted 0600. Cached in-process. On a write
 * failure an ephemeral key is used (tokens stay valid within the run).
 * @returns {Buffer}
 */
export function getKey() {
  if (_key) return _key;
  const file = keyFile();
  try {
    if (fs.existsSync(file)) {
      const hex = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(hex)) { _key = Buffer.from(hex, 'hex'); return _key; }
    }
  } catch { /* fall through and regenerate */ }

  ensureDir(vaultDir());
  const key = crypto.randomBytes(32);
  try {
    // Owner-only (0600) — the key seeds every reversible token. chmod after write is
    // best-effort (no-op on Windows, where access is ACL-based, not POSIX mode bits).
    fs.writeFileSync(file, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* mode bits unsupported on this platform */ }
  } catch (err) {
    logger.warn(`[ARGUS] Aegis vault: could not persist key — using an ephemeral key: ${err.message}`);
  }
  _key = key;
  return _key;
}

function currentBranch() {
  if (_branch) return _branch;
  try { _branch = getCurrentBranch() || 'default'; } catch { _branch = 'default'; }
  return _branch;
}

function vaultFile() {
  return path.join(vaultDir(), `${currentBranch()}.jsonl`);
}

/**
 * Deterministic, information-free token for a value (HMAC-SHA256 tag). Same value ⇒
 * same token on this machine, so the external artifact stays diff-stable. Does NOT
 * persist a mapping — use tokenFor for that.
 * @param {*} value
 * @returns {string}
 */
export function computeToken(value) {
  const v = String(value ?? '');
  const tag = crypto.createHmac('sha256', getKey()).update(v).digest('hex').slice(0, TOKEN_HEX_LEN);
  return TOKEN_PREFIX + tag;
}

/**
 * Append a secret-free provenance line for an egress action. The audit trail
 * records WHAT token was minted, never the plaintext (the token is information-free).
 * Gives the NIST-RMF "traceability" trail without itself storing a secret.
 * @param {object} entry
 */
export function appendAudit(entry) {
  ensureDir(auditDir());
  const file = path.join(auditDir(), `${currentBranch()}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* unsupported on Windows */ }
  } catch { /* audit is best-effort; never break egress */ }
}

/**
 * Persist a token→value mapping to the vault file (0600). In-run dedup keeps the
 * file from growing per duplicate span within a single process.
 * @param {string} token
 * @param {*} value
 */
export function storeMapping(token, value) {
  if (_seen.has(token)) return;
  _seen.add(token);
  ensureDir(vaultDir());
  const line = JSON.stringify({ token, value: String(value ?? ''), ts: new Date().toISOString() }) + '\n';
  try {
    fs.appendFileSync(vaultFile(), line, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(vaultFile(), 0o600); } catch { /* unsupported on Windows */ }
  } catch (err) {
    logger.warn(`[ARGUS] Aegis vault: mapping write failed: ${err.message}`);
  }
  // Secret-free provenance (the token, not the value).
  appendAudit({ action: 'tokenize', token });
}

/**
 * Token for a value: compute the deterministic token AND persist its mapping. This
 * is the function wired into scrubText's `token` mode (via setVaultTokenizer).
 * @param {*} value
 * @returns {string}
 */
export function tokenFor(value) {
  const token = computeToken(value);
  storeMapping(token, value);
  return token;
}

/**
 * Load every token→value mapping from the vault dir (all *.jsonl, merged) into a
 * Map. Branch-agnostic so rehydrate works regardless of which branch minted a token.
 * @returns {Map<string,string>}
 */
export function loadVault() {
  const map = new Map();
  const dir = vaultDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return map; }
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const { token, value } = JSON.parse(s);
        if (typeof token === 'string') map.set(token, value);
      } catch { /* skip a malformed line */ }
    }
  }
  return map;
}

/**
 * Re-inflate a redacted object/string by swapping every AEGIS_ token back to its
 * original from the vault. Unknown tokens (no mapping) are left untouched. Returns a
 * BRAND-NEW value — never mutates the input.
 * @param {*} obj
 * @param {Map<string,string>} [vault]
 * @returns {*}
 */
export function rehydrate(obj, vault) {
  const map = vault || loadVault();
  const walk = (v) => {
    if (typeof v === 'string') {
      return v.replace(TOKEN_RE, (tok) => (map.has(tok) ? map.get(tok) : tok));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(obj);
}

/**
 * Wire (or un-wire) the scrubText `token` mode seam. When the vault is enabled,
 * registers tokenFor as the tokenizer; otherwise ensures the seam is OFF so token
 * mode falls back to mask (fail-closed). Idempotent + cheap — the egress path calls
 * this before redacting in token mode.
 * @returns {boolean} whether the vault is now wired
 */
export function ensureVaultWired() {
  if (vaultEnabled()) {
    if (!_wired) { setVaultTokenizer(tokenFor); _wired = true; }
    return true;
  }
  if (_wired) { setVaultTokenizer(null); _wired = false; }
  return false;
}

/** Test seam — clears cached key/branch/dedup/wiring. NOT for production use. */
export function _resetVaultForTests() {
  _key = null;
  _branch = null;
  _wired = false;
  _seen.clear();
  setVaultTokenizer(null);
}

// Wire on import when the env var is already set (the production case, where the
// process is launched with ARGUS_REDACT_VAULT=1). The egress path additionally calls
// ensureVaultWired() lazily, so an env var set after import is still honoured.
ensureVaultWired();
