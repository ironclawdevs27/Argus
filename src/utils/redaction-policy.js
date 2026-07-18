/**
 * Aegis — structured redaction policy resolver (the engine `policy` param).
 *
 * The shipped engine enforces exactly two knobs: the redaction `mode`
 * (ARGUS_REDACT_MODE) and the always-on fail-closed floor. An org, however, wants
 * finer control — which of the 13 secret / 7 PII detectors run, extra custom
 * patterns, which finding TYPES count as sensitive, and a narrower egress field
 * allowlist. This module turns a structured policy object (the same shape the
 * closed control plane stores + serves) into an "effective config" the existing
 * redaction entry points consume via their `opts`.
 *
 * SECURITY POSTURE — this module UPHOLDS Aegis's fail-closed inversion:
 *   • A missing / malformed / unparseable policy resolves to STRICT_DEFAULT — the
 *     strictest currently-shipped behavior (all rules on, built-in sensitive
 *     types + allowlist). Never looser on error.
 *   • The egress field allowlist may only ever be NARROWED (intersected with the
 *     built-in) — a policy can never add a new field that leaks (that intersection
 *     is applied in sensitivity-classifier.js, where the built-in list lives).
 *   • The sensitive-type set is only ever WIDENED (unioned with the built-in) — a
 *     policy can add types but never drop a built-in one.
 *   • The statistical-entropy layer and the finding-level catch-alls (body fields,
 *     security category) are NOT policy-toggleable — they are the floor that keeps
 *     an actual secret from leaking even if a named rule is turned off.
 *   • No policy at all (the default) ⇒ every effect is null ⇒ byte-identical to the
 *     pre-policy engine. The param is opt-in and inert until a policy is supplied.
 *
 * Pure + zero-dependency + zero-I/O (same discipline as secret-patterns.js). It
 * imports nothing from the engine so it cannot introduce a circular dependency;
 * the allowlist intersection / type union that need the built-in lists happen at
 * the classifier call sites.
 *
 * NOTE: the `person_name_ner` toggle in the policy schema references a detector
 * the OSS engine does not ship (there is no NER). Unknown rule names in a policy
 * are simply ignored — they disable nothing real and can never loosen the floor.
 */

/** The five redaction modes maskValue() understands. */
export const VALID_MODES = new Set(['mask', 'label', 'hash', 'token', 'drop']);

/** Hard cap on operator-supplied lists so a pathological policy can't DoS a run. */
const MAX_EXTRA_RULES = 50;
const MAX_LIST = 256;

/**
 * The null-effect resolution: a run with STRICT_DEFAULT behaves EXACTLY as the
 * pre-policy engine (all rules on, caller's env/opts mode, built-in sensitive
 * types + egress allowlist). This is both the "no policy supplied" result and the
 * fail-closed fallback on any error — identical strict behavior either way.
 */
export const STRICT_DEFAULT = Object.freeze({
  version: null,
  orgId: null,
  enforcement: 'strict',
  mode: null, // null ⇒ caller's env/opts mode (byte-identical default)
  ruleFilter: null, // null ⇒ ALL secret + PII rules run
  extraSecretRules: Object.freeze([]),
  sensitiveTypes: null, // null ⇒ built-in SENSITIVE_TYPES only
  egressAllowlist: null, // null ⇒ built-in EGRESS_ALLOWLIST only
  sinks: null,
  floor: Object.freeze({ failOpen: false, minMode: 'mask' }),
  invalid: false,
});

/** Fail-closed clone (marks `invalid` so a caller can log/telemeter the reject). */
function failClosed() {
  return { ...STRICT_DEFAULT, floor: { ...STRICT_DEFAULT.floor }, extraSecretRules: [], invalid: true };
}

/**
 * Compile the org's custom `rules.secret.extra` entries into `{name, regex}`
 * secret rules (ADDITIVE — they only ever redact MORE). Each entry may be a bare
 * regex-source string or `{ name?, pattern|source|regex, flags? }`. A bad regex is
 * skipped (logged nowhere — this module is I/O-free — never thrown). The global
 * flag is forced so findSensitiveSpans' matchAll iterates correctly.
 * @param {unknown} extra
 * @returns {{name:string, regex:RegExp}[]}
 */
function compileExtraSecretRules(extra) {
  if (!Array.isArray(extra)) return [];
  const out = [];
  for (const item of extra.slice(0, MAX_EXTRA_RULES)) {
    let source;
    let flags = '';
    let name = 'policy_custom';
    try {
      if (typeof item === 'string') {
        source = item;
      } else if (item && typeof item === 'object') {
        source = item.pattern ?? item.source ?? item.regex;
        if (typeof item.flags === 'string') flags = item.flags;
        if (typeof item.name === 'string' && item.name) name = item.name;
      }
      if (typeof source !== 'string' || source === '') continue;
      // Force /g; drop a caller-supplied duplicate g to avoid "invalid flags".
      const merged = 'g' + flags.replace(/g/g, '');
      out.push({ name, regex: new RegExp(source, merged) });
    } catch {
      continue; // unparseable regex ⇒ skip (fail toward the built-in floor)
    }
  }
  return out;
}

/**
 * Build the (name, kind) → boolean rule predicate from `policy.rules`.
 *   • secret rules are all-or-nothing via `rules.secret.all` (default true).
 *   • each PII rule is on unless `rules.pii[name] === false` (default true).
 *   • entropy / any other kind is ALWAYS on (the non-toggleable floor).
 * Returns null when `policy.rules` is absent (⇒ every rule runs, byte-identical).
 * @param {unknown} rules
 * @returns {((name:string, kind:string) => boolean) | null}
 */
function buildRuleFilter(rules) {
  if (!rules || typeof rules !== 'object') return null;
  const secretAll = rules.secret && typeof rules.secret === 'object'
    ? rules.secret.all !== false
    : true;
  const piiMap = rules.pii && typeof rules.pii === 'object' ? rules.pii : null;
  return (name, kind) => {
    if (kind === 'secret') return secretAll;
    if (kind === 'pii') return piiMap ? piiMap[name] !== false : true;
    return true; // entropy + future kinds: not policy-toggleable (floor)
  };
}

/**
 * Resolve a raw org policy (the §4.2 schema) into an effective config. ALWAYS
 * fail-closed: any missing / non-object / throwing input yields STRICT_DEFAULT.
 * A valid policy may narrow the rule set + widen the sensitive-type set + narrow
 * the egress allowlist + set the mode; it can never disable the entropy floor,
 * fail open, or widen the allowlist (those are enforced here + at the call sites).
 *
 * @param {unknown} policy
 * @returns {typeof STRICT_DEFAULT}
 */
export function resolvePolicy(policy) {
  if (policy === null || policy === undefined) return STRICT_DEFAULT;
  if (typeof policy !== 'object') return failClosed();
  try {
    const mode = typeof policy.mode === 'string' && VALID_MODES.has(policy.mode) ? policy.mode : null;

    const rawTypes = Array.isArray(policy.sensitiveTypes)
      ? policy.sensitiveTypes.filter((t) => typeof t === 'string' && t).slice(0, MAX_LIST)
      : null;
    const sensitiveTypes = rawTypes && rawTypes.length ? rawTypes : null;

    const rawAllow = Array.isArray(policy.egressFieldAllowlist)
      ? policy.egressFieldAllowlist.filter((f) => typeof f === 'string' && f).slice(0, MAX_LIST)
      : null;
    // An empty-but-present allowlist is meaningful (drop every optional field) —
    // keep [] distinct from null. The intersection with the built-in happens in
    // the classifier, so this can only ever NARROW.
    const egressAllowlist = rawAllow !== null ? rawAllow : null;

    const minMode = policy.floor && VALID_MODES.has(policy.floor.minMode) ? policy.floor.minMode : 'mask';

    return {
      version: typeof policy.version === 'number' ? policy.version : null,
      orgId: typeof policy.orgId === 'string' ? policy.orgId : null,
      enforcement: policy.enforcement === 'advisory' ? 'advisory' : 'strict',
      mode,
      ruleFilter: buildRuleFilter(policy.rules),
      extraSecretRules: compileExtraSecretRules(policy.rules && policy.rules.secret && policy.rules.secret.extra),
      sensitiveTypes,
      egressAllowlist,
      sinks: policy.sinks && typeof policy.sinks === 'object' ? { ...policy.sinks } : null,
      floor: { failOpen: false, minMode }, // failOpen is FORCED false — a policy can never open the gate
      invalid: false,
    };
  } catch {
    return failClosed(); // a throwing getter / exotic input ⇒ strict floor
  }
}

/**
 * Project a resolved config into the `opts` fields the redaction entry points
 * consume. Absent effects are omitted (never `undefined`-override an explicit
 * caller opt). Returns null for the null-effect / no-policy case so callers can
 * cheaply short-circuit to their existing behavior.
 * @param {typeof STRICT_DEFAULT | null} resolved
 * @returns {{mode?:string, ruleFilter?:Function, extraSecretRules?:object[], sensitiveTypes?:string[], egressAllowlist?:string[]} | null}
 */
export function policyOpts(resolved) {
  if (!resolved || typeof resolved !== 'object') return null;
  const out = {};
  if (resolved.mode) out.mode = resolved.mode;
  if (resolved.ruleFilter) out.ruleFilter = resolved.ruleFilter;
  if (Array.isArray(resolved.extraSecretRules) && resolved.extraSecretRules.length) out.extraSecretRules = resolved.extraSecretRules;
  if (Array.isArray(resolved.sensitiveTypes) && resolved.sensitiveTypes.length) out.sensitiveTypes = resolved.sensitiveTypes;
  if (Array.isArray(resolved.egressAllowlist)) out.egressAllowlist = resolved.egressAllowlist; // [] is meaningful (narrow-all)
  return Object.keys(out).length ? out : null;
}

// Parse ARGUS_REDACT_POLICY (inline JSON) at most once per distinct value.
let _envCache = { raw: null, resolved: null };

/**
 * The local/CI env entry point: read `ARGUS_REDACT_POLICY` (inline JSON) and
 * resolve it. Returns null when unset (⇒ the byte-identical no-policy path).
 * A SET-but-malformed value fails closed to the strict floor (the operator asked
 * for governance; we honor it as "strictest" rather than silently ignoring it).
 * Cached by raw string so hot egress paths don't re-parse.
 * @returns {typeof STRICT_DEFAULT | null}
 */
export function policyFromEnv() {
  const raw = process.env.ARGUS_REDACT_POLICY;
  if (!raw) return null; // no policy ⇒ caller keeps its existing behavior
  if (_envCache.raw === raw) return _envCache.resolved;
  let resolved;
  try {
    resolved = resolvePolicy(JSON.parse(raw));
  } catch {
    resolved = failClosed(); // malformed JSON ⇒ strict floor, never looser
  }
  _envCache = { raw, resolved };
  return resolved;
}

// ── Governance seam (the self-hosted central-policy bridge, AEGIS_FOR_TEAMS §9) ──
// This module stays PURE + I/O-free. The opt-in network seam (governance-seam.js)
// does the fetch + Ed25519 verify and injects a SYNC source here — the same
// discipline as secret-patterns.js setVaultTokenizer. The injected source returns
// a RESOLVED config: null when governance is inactive (no gov token ⇒ byte-
// identical), the org's resolved policy when a fresh verified one is in force, or
// STRICT_DEFAULT when active-but-cold/failed (fail-closed to the strict floor).
let _governanceSource = null;

/** Inject the governance policy source (governance-seam.js). null clears it. */
export function setGovernanceSource(fn) {
  _governanceSource = typeof fn === 'function' ? fn : null;
}

/** Read the injected source without ever throwing. */
function readGovernance() {
  if (!_governanceSource) return null;
  try {
    return _governanceSource();
  } catch {
    // A throwing source ⇒ treat as active-but-failed → strict floor (fail-closed).
    return STRICT_DEFAULT;
  }
}

/**
 * True iff a governance policy is in force (a gov token is provisioned). The
 * classifier ANDs this into the ARGUS_REDACT_SENSITIVE=0 opt-out so a dev cannot
 * disable redaction locally while under an org policy (AEGIS_FOR_TEAMS §4.3). Pure:
 * false whenever no source is wired (⇒ the opt-out keeps its byte-identical effect).
 * @returns {boolean}
 */
export function governanceOptOutClamped() {
  return readGovernance() != null;
}

/**
 * The single helper the redaction entry points call: resolve the effective policy
 * from `opts.policy` (a RAW §4.2 policy object) if present, else the governance
 * seam (network-fetched + verified), else the ARGUS_REDACT_POLICY env, then project
 * to consumable opts. Returns null when no policy is in force anywhere (⇒ byte-
 * identical default). Precedence: explicit opts.policy > governance > env.
 * @param {{policy?: unknown}} [opts]
 * @returns {{mode?:string, ruleFilter?:Function, extraSecretRules?:object[], sensitiveTypes?:string[], egressAllowlist?:string[]} | null}
 */
export function effectivePolicyOpts(opts = {}) {
  let resolved;
  if (opts.policy !== undefined && opts.policy !== null) {
    resolved = resolvePolicy(opts.policy);
  } else {
    const gov = readGovernance();
    resolved = gov != null ? gov : policyFromEnv();
  }
  return policyOpts(resolved);
}

/** Test seam: drop the ARGUS_REDACT_POLICY parse cache. */
export function _resetPolicyCacheForTests() {
  _envCache = { raw: null, resolved: null };
}
