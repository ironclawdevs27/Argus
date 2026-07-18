/**
 * Aegis — governance seam (the opt-in, self-hosted central-policy bridge).
 *
 * The shipped engine applies a structured redaction policy locally via the
 * `policy` param / ARGUS_REDACT_POLICY env (redaction-policy.js). This module is
 * the THIN, OPT-IN network wrapper that lets a self-hosted laptop / CI run
 * *participate in central governance*: it fetches the org's signed policy from the
 * closed control plane, VERIFIES it (Ed25519, MITM-resistant), applies it through
 * the existing `policy` param, caches it with a TTL, and posts SECRET-FREE
 * redaction aggregates back for the compliance trail.
 *
 * OPEN-CORE DISCIPLINE (AEGIS_FOR_TEAMS_PLAN.md §9 — re-read before editing):
 *   • Inert without a governance token. `ARGUS_GOV_TOKEN` unset ⇒ this module wires
 *     a source that returns null ⇒ the engine is BYTE-IDENTICAL to v9.9.0. No
 *     phone-home, no fetch, no new required dependency, no perf cost by default.
 *   • Fail-CLOSED everywhere. Any fetch / parse / signature error ⇒ the engine
 *     falls back to the STRICT floor (redact MORE, never less). A verify failure
 *     NEVER loosens redaction — it is treated exactly as "no policy fetched".
 *   • Ed25519-signed policy, verified before use. The control plane signs; the
 *     engine verifies with the org's PUBLIC key (ARGUS_REDACT_POLICY_PUBKEY, pinned
 *     out-of-band). A bad signature / wrong key / tampered body is rejected → floor.
 *   • Secret-free aggregates only. What posts to ARGUS_REDACT_AUDIT_URL is the
 *     `byReason` LABEL stream (secret:* / pii:* / category:* counts) — never a
 *     secret, token, or raw value. Best-effort: posting never blocks or fails a run.
 *   • Strict enforcement clamps the local opt-out. When a gov token is present a
 *     dev cannot set ARGUS_REDACT_SENSITIVE=0 to escape the org policy — that clamp
 *     is exposed to the classifier via redaction-policy.js governanceOptOutClamped().
 *
 * Uses only node:crypto + the global fetch (both built-in on the supported Node) —
 * NO new dependency. The pure policy resolver stays in redaction-policy.js (I/O-
 * free); this module does the I/O and injects a sync source into it, mirroring the
 * aegis-vault.js ⇄ secret-patterns.js setVaultTokenizer seam.
 *
 * DEFERRED (needs the central control plane's team-vault endpoint): routing
 * `mode=token` vault writes/reads to the team endpoint when a gov token is present.
 * Today `mode=token` without a wired vault degrades to mask in-engine (unchanged).
 */

import { verify as edVerify, createPublicKey } from 'node:crypto';
import { childLogger } from './logger.js';
import { scrubText } from './secret-patterns.js';
import { resolvePolicy, STRICT_DEFAULT, setGovernanceSource } from './redaction-policy.js';

const logger = childLogger('aegis');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min — a policy is re-fetched at most this often

// Module-level policy cache. `ok` distinguishes a verified policy (apply the
// resolved config) from a fetch/verify failure (fail-closed to the strict floor).
let _cache = { resolved: STRICT_DEFAULT, fetchedAt: null, ok: false, version: null, error: null };

/** True iff a governance token is provisioned — the master switch for the seam. */
export function governanceActive() {
  return !!process.env.ARGUS_GOV_TOKEN;
}

function ttlMs() {
  const raw = Number(process.env.ARGUS_REDACT_POLICY_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function pubKeyPem() {
  return process.env.ARGUS_REDACT_POLICY_PUBKEY || '';
}

/**
 * The sync source injected into redaction-policy.js. Returns:
 *   • null            — governance inactive (no token)  ⇒ engine keeps env/default
 *   • resolved config — active + a fresh verified policy ⇒ apply it
 *   • STRICT_DEFAULT  — active but cold / expired / failed ⇒ fail-CLOSED strict floor
 * Never throws.
 */
function governanceSource() {
  if (!governanceActive()) return null;
  if (_cache.ok && _cache.fetchedAt !== null && (Date.now() - _cache.fetchedAt) < ttlMs()) {
    return _cache.resolved;
  }
  return STRICT_DEFAULT; // active but no valid policy in force ⇒ strict floor
}

// Register the source at module load: merely importing this module makes the
// engine governance-aware (inert until a token is set). Mirrors setVaultTokenizer.
setGovernanceSource(governanceSource);

/** Key-sorted JSON — the exact bytes the control plane signs over. Must match the
 *  cloud signer's canonicalize() so a policy signed there verifies here. */
export function canonicalPolicyBytes(policy) {
  return JSON.stringify(sortKeys(policy));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** Decode an Ed25519 signature that may arrive hex or base64/base64url. */
function decodeSignature(sig) {
  if (/^[0-9a-fA-F]+$/.test(sig) && sig.length % 2 === 0) return Buffer.from(sig, 'hex');
  return Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a signed-policy payload against the pinned org public key. Returns the
 * inner policy doc on success; THROWS on any problem (missing fields, no pubkey,
 * bad signature, wrong key) so the caller fails closed. Exported for unit proof.
 * @param {{policy?:object, signature?:string}} payload
 * @param {string} [publicKeyPem]
 * @returns {object} the verified policy doc
 */
export function verifySignedPolicy(payload, publicKeyPem = pubKeyPem()) {
  if (!payload || typeof payload !== 'object') throw new Error('governance policy payload is not an object');
  const { policy, signature } = payload;
  if (!policy || typeof policy !== 'object') throw new Error('governance policy payload missing "policy"');
  if (typeof signature !== 'string' || signature.length === 0) throw new Error('governance policy payload missing "signature"');
  if (!publicKeyPem) throw new Error('ARGUS_REDACT_POLICY_PUBKEY is not set — cannot verify a signed policy');

  const key = createPublicKey({ key: publicKeyPem, format: 'pem' });
  const ok = edVerify(null, Buffer.from(canonicalPolicyBytes(policy), 'utf8'), key, decodeSignature(signature));
  if (!ok) throw new Error('governance policy signature verification failed');
  return policy;
}

async function fetchSignedPolicy(fetchImpl) {
  const url = process.env.ARGUS_REDACT_POLICY_URL;
  const token = process.env.ARGUS_GOV_TOKEN;
  if (!url) throw new Error('ARGUS_REDACT_POLICY_URL is not set');
  if (!token) throw new Error('ARGUS_GOV_TOKEN is not set');
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res || res.ok !== true) throw new Error(`governance policy fetch HTTP ${res && res.status}`);
  return res.json();
}

/**
 * Fetch + Ed25519-verify + cache the org policy. Idempotent + TTL-gated: at most
 * one fetch per TTL window. Best-effort and NEVER throws — on any error it caches
 * the STRICT floor (fail-closed) and returns it. Call once at run start (before the
 * first redaction); the verified config then feeds every redaction via the source.
 *
 * @param {{ fetchImpl?: Function, now?: () => number }} [deps]  test seams
 * @returns {Promise<typeof STRICT_DEFAULT | null>} null when inactive
 */
export async function ensureGovernancePolicy(deps = {}) {
  if (!governanceActive()) return null; // opt-in: no token ⇒ nothing fetched, byte-identical
  const now = (deps.now || Date.now)();
  // Fresh cache (success OR recent failure) ⇒ don't re-hit the endpoint every run.
  if (_cache.fetchedAt !== null && (now - _cache.fetchedAt) < ttlMs()) {
    return _cache.ok ? _cache.resolved : STRICT_DEFAULT;
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  try {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
    const payload = await fetchSignedPolicy(fetchImpl);
    const doc = verifySignedPolicy(payload); // throws on bad sig / wrong key / missing pubkey
    _cache = { resolved: resolvePolicy(doc), fetchedAt: now, ok: true, version: typeof doc.version === 'number' ? doc.version : null, error: null };
    logger.info(`[ARGUS] Aegis governance: applied org policy v${_cache.version ?? '?'} (verified)`);
    return _cache.resolved;
  } catch (err) {
    _cache = { resolved: STRICT_DEFAULT, fetchedAt: now, ok: false, version: null, error: String((err && err.message) || err) };
    logger.warn(`[ARGUS] Aegis governance: policy fetch/verify failed — failing closed to strict floor: ${_cache.error}`);
    return STRICT_DEFAULT;
  }
}

/** Coerce a byReason map into a SECRET-FREE {label:int}. Each label is scrubbed
 *  (defence in depth — reason labels are structural, but a tainted one dies here)
 *  and length-capped; each value is a non-negative integer. */
function safeByReason(byReason) {
  const out = {};
  if (!byReason || typeof byReason !== 'object') return out;
  for (const [rawKey, rawVal] of Object.entries(byReason)) {
    const label = scrubText(String(rawKey)).slice(0, 64);
    const n = Number(rawVal);
    if (label && Number.isFinite(n) && n >= 0) out[label] = Math.floor(n);
  }
  return out;
}

function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * POST a SECRET-FREE redaction aggregate to ARGUS_REDACT_AUDIT_URL (the compliance
 * trail). Best-effort: never blocks, never throws, never sends a secret. The body
 * carries only label counts + coarse non-secret meta + the enforced policy version.
 * No-op (not-configured) unless a gov token AND an audit URL are set.
 *
 * @param {{ total?:number, redacted?:number, byReason?:object }} summary  from summarizeRedaction
 * @param {{ fetchImpl?: Function, meta?: object }} [deps]
 * @returns {Promise<{posted:boolean, reason?:string, body?:object}>}
 */
export async function postRedactionAggregate(summary, deps = {}) {
  const url = process.env.ARGUS_REDACT_AUDIT_URL;
  const token = process.env.ARGUS_GOV_TOKEN;
  if (!url || !token) return { posted: false, reason: 'not-configured' };

  const meta = deps.meta && typeof deps.meta === 'object' ? deps.meta : {};
  const body = {
    total: safeInt(summary && summary.total),
    redacted: safeInt(summary && summary.redacted),
    byReason: safeByReason(summary && summary.byReason),
    policyVersion: _cache.version,
    // Coarse, non-secret provenance only — every string is scrubbed.
    runRef: typeof meta.runRef === 'string' ? scrubText(meta.runRef).slice(0, 128) : null,
    at: new Date().toISOString(),
  };
  try {
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
    await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { posted: true, body };
  } catch (err) {
    logger.debug(`[ARGUS] Aegis governance: aggregate POST failed (best-effort, ignored): ${String((err && err.message) || err)}`);
    return { posted: false, reason: String((err && err.message) || err), body };
  }
}

/** The policy version currently in force (for callers/telemetry). null when none. */
export function governancePolicyVersion() {
  return governanceActive() && _cache.ok ? _cache.version : null;
}

/** Test seam: reset the module cache to the cold fail-closed state. */
export function _resetGovernanceForTests() {
  _cache = { resolved: STRICT_DEFAULT, fetchedAt: null, ok: false, version: null, error: null };
}
