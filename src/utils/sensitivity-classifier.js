/**
 * Aegis — sensitivity classifier + egress projector (Step 2 of
 * REDACTION_BOUNDARY_MAX_PLAN.md).
 *
 * Two functions, one contract (plan §4.2):
 *   - classifySensitivity(report)  — the DETECTOR. Runs once in the pipeline,
 *     tags each finding {sensitive, sensitivityReasons, localRef} on a shallow
 *     CLONE (never mutates the frozen original, §5.4), preserving full local
 *     detail. Idempotent. FAILS CLOSED per finding.
 *   - redactForEgress(findings)    — the PROJECTOR. Pure. Returns BRAND-NEW
 *     objects carrying only the deny-by-default field allowlist (§5.2); a
 *     sensitive finding's detail becomes a 🔒 marker, a benign finding's message
 *     survives only after a mandatory scrubText() catch-all. FAILS CLOSED per
 *     finding (any error ⇒ a fully-redacted stub, never the raw finding).
 *
 * SECURITY POSTURE — fail CLOSED. Ambiguity, errors, and unknown shapes redact
 * MORE, never less. The deny-by-default allowlist guarantees a finding field
 * added next year leaks NOTHING until someone deliberately allowlists it.
 *
 * Layer 1 (category rules) lives here; Layers 2–5 (secrets/entropy/PII/context)
 * come from secret-patterns.js.
 */

import { childLogger } from './logger.js';
import { findSensitiveSpans, scrubText, stripZeroWidth } from './secret-patterns.js';
import { ensureTokenVaultWired } from './team-vault.js';
import { effectivePolicyOpts, governanceOptOutClamped } from './redaction-policy.js';

const logger = childLogger('aegis');

// ── Layer 1 — category rules ────────────────────────────────────────────────

/**
 * Non-`security_*` finding types treated as sensitive by category. (Every type
 * beginning `security_` is caught by the prefix test in isSensitiveType.)
 * @type {Set<string>}
 */
export const SENSITIVE_TYPES = new Set([
  'cors_violation', 'cors_error', 'mixed_content', 'permission_policy_violation',
  'cookie_attribute_missing', 'csp_violation', 'unclassified_devtools_issue',
  'uncaught_exception', 'unhandled_rejection', 'sensitive_console',
]);

/**
 * Fields whose mere presence on a finding marks it sensitive — a body/stack/
 * header/cookie blob is exploit-or-secret-bearing regardless of the finding type
 * (the Layer-1 catch-all that makes an unknown future type fail closed).
 * @type {string[]}
 */
export const BODY_FIELDS = ['requestBody', 'responseBody', 'stack', 'headers', 'cookies'];

/** Free-text fields scanned by the content layers (2–5). */
const TEXT_FIELDS = ['message', 'evidence', 'snippet', 'payload', 'detail', 'title',
  'url', 'requestUrl', 'source', 'element', 'property'];

/**
 * Deny-by-default egress field allowlist (§5.2). ONLY these keys may ever appear
 * in an external object; everything else is dropped. `url`/`requestUrl` pass
 * through sanitizeUrl; a string `value` is scrubbed; `message` survives only for
 * a non-sensitive finding and only after scrubText.
 */
export const EGRESS_ALLOWLIST = ['type', 'severity', 'route', 'url', 'requestUrl',
  'selector', 'status', 'method', 'metric', 'value', 'budget', 'count', 'title',
  'isNew', 'noisy', 'flaky', 'localRef'];

/**
 * True when `type` matches one of the org policy's `sensitiveTypes` patterns.
 * A pattern is a literal type or a `prefix_*` glob (trailing `*` only — the shape
 * the schema uses, e.g. `security_*`). Policy types only ever WIDEN the built-in
 * set (union in isSensitiveType) — a policy can never drop a built-in type.
 * @param {string} type
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesPolicyType(type, patterns) {
  for (const p of patterns) {
    if (typeof p !== 'string' || !p) continue;
    if (p.endsWith('*')) { if (type.startsWith(p.slice(0, -1))) return true; }
    else if (type === p) return true;
  }
  return false;
}

/**
 * @param {string} type
 * @param {string[]} [policyTypes]  org policy sensitiveTypes — UNIONed (widens only)
 * @returns {boolean}
 */
export function isSensitiveType(type, policyTypes) {
  if (typeof type !== 'string') return true; // unknown shape ⇒ fail closed
  if (type.startsWith('security_')) return true;
  if (SENSITIVE_TYPES.has(type)) return true;
  if (Array.isArray(policyTypes) && policyTypes.length && matchesPolicyType(type, policyTypes)) return true;
  return false;
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Build a stable, secret-free key for a finding (the localRef fragment + audit
 * key). `type::route` per the plan example (`security_no_https::/login`).
 * @param {object} finding
 * @returns {string}
 */
export function findingKey(finding) {
  const type = finding?.type ?? 'unknown';
  const route = finding?.route ?? routeFromUrl(finding?.url) ?? '';
  return `${type}::${route}`;
}

/**
 * Classify ONE finding across all five layers.
 *   L1 category/body-field · L2 secret regex · L3 entropy/token-efficiency ·
 *   L4 PII · L5 context (the latter four via findSensitiveSpans over its free
 *   text). Sensitive iff any layer fires.
 *
 * The optional `po` (effective policy opts from redaction-policy.js) widens the
 * sensitive-type set and applies the secret/PII rule toggles to the content scan.
 * Absent ⇒ byte-identical to the pre-policy classifier.
 *
 * @param {object} finding
 * @param {{ ruleFilter?: Function, extraSecretRules?: object[], sensitiveTypes?: string[] }} [po]
 * @returns {{ sensitive: boolean, sensitivityReasons: string[] }}
 */
export function classifyFinding(finding, po = null) {
  const reasons = [];
  const spanOpts = po ? { ruleFilter: po.ruleFilter, extraSecretRules: po.extraSecretRules } : undefined;

  // Layer 1 — category + body-field catch-all.
  if (isSensitiveType(finding?.type, po?.sensitiveTypes)) reasons.push(`category:${finding?.type ?? 'unknown'}`);
  for (const f of BODY_FIELDS) {
    const v = finding?.[f];
    if (v !== undefined && v !== null && v !== '') { reasons.push(`category:has_${f}`); break; }
  }

  // Layers 2–5 — content scan over every free-text + serialisable field.
  let blob = '';
  for (const f of TEXT_FIELDS) {
    const v = finding?.[f];
    if (typeof v === 'string' && v) blob += ' ' + v;
  }
  for (const f of BODY_FIELDS) {
    const v = finding?.[f];
    if (v === undefined || v === null) continue;
    blob += ' ' + (typeof v === 'string' ? v : safeStringify(v));
  }
  const addSpan = (span) => {
    const tag = span.kind === 'secret' ? `secret:${span.name}`
      : span.kind === 'pii' ? `pii:${span.name}`
        : 'entropy:high';
    if (reasons.includes(tag)) return false;
    reasons.push(tag);
    return true;
  };
  for (const span of findSensitiveSpans(blob, spanOpts)) addSpan(span);
  // Defeat zero-width-splice evasion: re-scan a boundary-preserving, zero-width-
  // stripped variant so \b-anchored rules (email/private-host) and the secret
  // regexes still fire after a U+200B/soft-hyphen splice. ADDITIVE + fail closed.
  const zwStripped = stripZeroWidth(blob);
  if (zwStripped !== blob) {
    let addedNew = false;
    for (const span of findSensitiveSpans(zwStripped, spanOpts)) { if (addSpan(span)) addedNew = true; }
    if (addedNew) reasons.push('evasion:normalized');
  }

  return { sensitive: reasons.length > 0, sensitivityReasons: reasons };
}

/**
 * Walk every finding in the report, tag each with sensitivity on a SHALLOW CLONE
 * (never mutating the frozen original), and attach a localRef pointer. Fails
 * closed per finding: any classifier error ⇒ that finding is marked sensitive.
 *
 * @param {object} report
 * @param {{ reportRef?: string, policy?: unknown }} [opts]
 * @returns {{ sensitiveCount: number }}
 */
export function classifySensitivity(report, opts = {}) {
  const reportRef = opts.reportRef || 'local-report';
  const po = effectivePolicyOpts(opts); // null ⇒ byte-identical pre-policy classify
  let sensitiveCount = 0;

  const tag = (finding) => {
    try {
      const result = classifyFinding(finding, po);
      if (result.sensitive) sensitiveCount++;
      // Shallow clone — works whether or not the source is Object.freeze'd, and
      // never removes local detail (the local report stays pristine + now tagged).
      // The spread can itself throw on a pathological getter, so it lives INSIDE
      // the try: any failure falls through to the fail-closed stub below.
      return {
        ...finding,
        sensitive: result.sensitive,
        sensitivityReasons: result.sensitivityReasons,
        localRef: `${reportRef}#${findingKey(finding)}`,
      };
    } catch (err) {
      logger.error(`[ARGUS] Aegis classify/clone threw — failing closed: ${err.message}`);
      sensitiveCount++;
      // Do NOT spread the finding (a getter may re-throw). Salvage safe scalars.
      const type = safeGet(finding, 'type') ?? 'unknown';
      const route = safeGet(finding, 'route') ?? routeFromUrl(safeGet(finding, 'url')) ?? '';
      return { type, severity: safeGet(finding, 'severity') ?? 'critical',
        sensitive: true, sensitivityReasons: ['classifier-error'],
        localRef: `${reportRef}#${type}::${route}` };
    }
  };

  for (const routeResult of (report?.routes ?? [])) {
    if (Array.isArray(routeResult?.errors)) routeResult.errors = routeResult.errors.map(tag);
  }
  for (const flowResult of (report?.flows ?? [])) {
    if (Array.isArray(flowResult?.findings)) flowResult.findings = flowResult.findings.map(tag);
  }
  if (Array.isArray(report?.codebase)) report.codebase = report.codebase.map(tag);

  return { sensitiveCount };
}

// ── Projection ──────────────────────────────────────────────────────────────

/**
 * Keep origin + path; strip the query string, fragment, and userinfo (tokens
 * hide in query params and `user:pass@`). Plan §5.2.
 * @param {*} u
 * @returns {string}
 */
export function sanitizeUrl(u) {
  if (typeof u !== 'string' || u === '') return '';
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname}`; // origin excludes userinfo + query + hash
  } catch {
    // Relative / malformed — strip manually.
    return u.replace(/^([a-z]+:\/\/)([^/\s@]+@)/i, '$1') // userinfo
      .split('#')[0].split('?')[0];
  }
}

/**
 * Logical route name for a finding: explicit `route`, else the URL pathname.
 * @param {*} u
 * @returns {string}
 */
export function routeFromUrl(u) {
  if (typeof u !== 'string' || u === '') return '';
  try {
    return new URL(u).pathname || '/';
  } catch {
    return u.replace(/^[a-z]+:\/\/[^/]+/i, '').split('#')[0].split('?')[0] || u;
  }
}

function routeOf(finding) {
  return finding?.route ?? routeFromUrl(finding?.url) ?? '';
}

function titleFor(finding) {
  return `${finding?.type ?? 'finding'} on ${routeOf(finding) || '/'} (${finding?.severity ?? 'info'})`;
}

export const REDACT_MARKER = '🔒 redacted — full detail in local report (localRef)';

// Fields that ALWAYS survive projection — structural + secret-free by construction
// (the redaction markers are compile-time constants). A narrower org allowlist may
// drop the OPTIONAL passthroughs below, never these.
const ALWAYS_KEEP = new Set(['type', 'severity', 'route', 'title', 'localRef', 'detail', 'message']);

/**
 * Project ONE finding to its egress-safe shape under the deny-by-default
 * allowlist. Builds a brand-new object — never mutates the input.
 *
 * `ctx.po` (effective policy opts) applies the secret/PII rule toggles to the
 * inner classify + scrub; `ctx.allowSet` (an org allowlist already INTERSECTED
 * with the built-in EGRESS_ALLOWLIST — narrow-only) drops optional passthroughs
 * not in it. Both absent ⇒ byte-identical to the pre-policy projector.
 *
 * @param {object} finding
 * @param {{ mode: string, failClosed: boolean, po?: object, allowSet?: Set<string> }} ctx
 * @returns {object}
 */
function projectFinding(finding, ctx) {
  let sensitive = ctx.failClosed === true || finding?.sensitive === true;
  if (!sensitive) sensitive = classifyFinding(finding, ctx.po).sensitive; // untagged fallback
  const scrubOpts = { mode: ctx.mode, ruleFilter: ctx.po?.ruleFilter, extraSecretRules: ctx.po?.extraSecretRules };

  const out = {
    type: finding?.type ?? 'unknown',
    severity: finding?.severity ?? 'info',
    route: routeOf(finding),
    title: titleFor(finding),
  };

  // url / requestUrl — sanitised (origin+path, no query/fragment/userinfo).
  if (typeof finding?.url === 'string' && finding.url) out.url = sanitizeUrl(finding.url);
  if (typeof finding?.requestUrl === 'string' && finding.requestUrl) out.requestUrl = sanitizeUrl(finding.requestUrl);

  // Structural / short-enum passthroughs (only when present).
  if (typeof finding?.selector === 'string') out.selector = finding.selector;
  if (finding?.status !== undefined) out.status = finding.status;
  if (typeof finding?.method === 'string') out.method = finding.method;
  if (typeof finding?.metric === 'string') out.metric = finding.metric;
  if (finding?.budget !== undefined && typeof finding.budget !== 'string') out.budget = finding.budget;
  if (typeof finding?.count === 'number') out.count = finding.count;
  // value: numeric passes through; a string value is free-text ⇒ scrub it.
  if (typeof finding?.value === 'number') out.value = finding.value;
  else if (typeof finding?.value === 'string') out.value = scrubText(finding.value, scrubOpts);

  // Booleans needed for new/persisting/resolved reconciliation.
  for (const b of ['isNew', 'noisy', 'flaky']) {
    if (typeof finding?.[b] === 'boolean') out[b] = finding[b];
  }
  if (typeof finding?.localRef === 'string') out.localRef = finding.localRef;

  // Org policy egress allowlist (narrow-only): drop optional passthroughs the org
  // excluded. ALWAYS_KEEP fields are never dropped; the marker fields are added below.
  if (ctx.allowSet) {
    for (const k of Object.keys(out)) {
      if (!ALWAYS_KEEP.has(k) && !ctx.allowSet.has(k)) delete out[k];
    }
  }

  if (sensitive) {
    // Sensitive: the RAW message never crosses. The redaction marker is carried in BOTH
    // `detail` (the explicit provenance marker, plan §5.2) AND `message` — the latter so the
    // canonical finding contract's required `message` (golden findingSchema) is satisfied and
    // every sink that renders f.message shows the notice without special-casing. The marker is
    // a compile-time constant — provably secret-free (the fuzz/red-team "no secret substring"
    // invariants hold unchanged).
    out.detail = REDACT_MARKER;     // detail withheld; pointer is localRef
    out.message = REDACT_MARKER;
  } else {
    // Catch-all: a benign finding keeps its helpful message, but only after the
    // mandatory secret/PII scrub (an accidental key in an innocuous message dies).
    out.message = scrubText(typeof finding?.message === 'string' ? finding.message : '', scrubOpts);
  }
  return out;
}

/**
 * The egress projector. Returns a NEW array of minimal, sanitised objects safe
 * to cross any trust boundary. Honours the ARGUS_REDACT_SENSITIVE=0 opt-out
 * (byte-identical passthrough) and fails closed per finding.
 *
 * @param {object[]} findings
 * @param {{ mode?: string, failClosed?: boolean }} [opts]
 * @returns {object[]}
 */
export function redactForEgress(findings, opts = {}) {
  const list = Array.isArray(findings) ? findings : [];
  // Opt-out: byte-identical to pre-Aegis (the sinks shipped raw findings).
  if (process.env.ARGUS_REDACT_SENSITIVE === '0' && !governanceOptOutClamped()) return list.slice();

  // Effective org policy (opts.policy or ARGUS_REDACT_POLICY env). null ⇒ default.
  const po = effectivePolicyOpts(opts);
  const mode = (po && po.mode) || process.env.ARGUS_REDACT_MODE || opts.mode || 'mask';
  const failClosed = opts.failClosed === true;
  // Egress allowlist can only NARROW: intersect the org list with the built-in one,
  // so a policy can never allow a field the deny-by-default allowlist didn't.
  const allowSet = po && po.egressAllowlist
    ? new Set(po.egressAllowlist.filter((f) => EGRESS_ALLOWLIST.includes(f)))
    : null;
  if (mode === 'token') ensureTokenVaultWired(); // wire the reversible vault seam (team vault > local, §9) lazily

  return list.map((finding) => {
    try {
      return projectFinding(finding, { mode, failClosed, po, allowSet });
    } catch (err) {
      // Per-finding fail-closed: emit a fully-redacted stub, never the raw finding.
      logger.error(`[ARGUS] Aegis redactForEgress threw — emitting redacted stub: ${err.message}`);
      return {
        type: finding?.type ?? 'unknown',
        severity: finding?.severity ?? 'critical', // worst-case on uncertainty
        route: '',
        title: 'redacted',
        detail: REDACT_MARKER,
        localRef: typeof finding?.localRef === 'string' ? finding.localRef : null,
      };
    }
  });
}

/**
 * Aggregate counts for the "N sensitive finding(s) redacted" banners. Fails
 * closed: a finding whose classification throws is counted as redacted.
 *
 * @param {object[]} findings
 * @param {{ ruleFilter?: Function, extraSecretRules?: object[], sensitiveTypes?: string[] }} [po]  effective policy opts
 * @returns {{ total: number, redacted: number, byReason: Record<string, number> }}
 */
export function summarizeRedaction(findings, po = null) {
  const list = Array.isArray(findings) ? findings : [];
  let redacted = 0;
  const byReason = Object.create(null);
  for (const finding of list) {
    let sensitive;
    let reasons;
    if (finding?.sensitive === true) {
      sensitive = true;
      reasons = Array.isArray(finding.sensitivityReasons) ? finding.sensitivityReasons : [];
    } else if (finding?.sensitive === false) {
      sensitive = false;
      reasons = [];
    } else {
      try {
        const r = classifyFinding(finding, po);
        sensitive = r.sensitive;
        reasons = r.sensitivityReasons;
      } catch {
        sensitive = true; // fail closed
        reasons = ['classifier-error'];
      }
    }
    if (sensitive) {
      redacted++;
      for (const reason of reasons) byReason[reason] = (byReason[reason] || 0) + 1;
    }
  }
  return { total: list.length, redacted, byReason };
}

// ── Egress riders + loose-object scrubbing (MCP/sink helpers, plan §6 Step 4) ──

/**
 * Build the `redaction` rider every guarded egress response carries: a secret-free
 * summary of how much detail was withheld + a pointer to the full local report.
 * Powers the "🔒 N redacted" banner. Plan §6 Step 4 / §9.1 [168i].
 *
 * @param {object[]} rawFindings  the ORIGINAL (un-projected) findings
 * @param {{ localReportPath?: string|null }} [opts]
 * @returns {{ redacted: number, total: number, localReportPath: string|null, note: string }}
 */
export function buildRedactionRider(rawFindings, opts = {}) {
  const list = Array.isArray(rawFindings) ? rawFindings : [];
  const r = summarizeRedaction(list, effectivePolicyOpts(opts));
  // Fail-closed (report-level _aegisFailClosed): EVERY finding was force-redacted, so the
  // rider must say so rather than undercounting via the per-finding classifier.
  const redacted = opts.failClosed === true ? list.length : r.redacted;
  return {
    redacted,
    total: r.total,
    localReportPath: opts.localReportPath ?? null,
    note: 'Detail withheld at the trust boundary — full report retained on the local machine.',
  };
}

/** Keys whose string value is a URL → sanitised (origin+path) before scrubbing. */
const URL_KEYS = new Set(['url', 'requestUrl', 'documentUrl', 'documentURL', 'source',
  'href', 'location', 'devUrl', 'stagingUrl', 'baseUrl', 'redirectUrl']);

/**
 * Recursively scrub an arbitrary LOOSE object/array (console messages, network
 * requests, env-comparison diffs) for egress: every string runs through scrubText
 * (secrets/PII masked); a URL-valued key is sanitised (query/userinfo stripped)
 * first; numbers/booleans pass through; a throwing getter is dropped (fail closed).
 * Bounded recursion depth. Returns a BRAND-NEW value — never mutates the input.
 *
 * Unlike redactForEgress (deny-by-default findings projection), deepScrub PRESERVES
 * the object's key set — these payloads have no canonical allowlist, so the safety
 * comes from scrubbing every string rather than from dropping unknown keys.
 *
 * @param {*} value
 * @param {{ mode?: string }} [opts]
 * @param {number} [depth]
 * @returns {*}
 */
export function deepScrub(value, opts = {}, depth = 0) {
  if (process.env.ARGUS_REDACT_SENSITIVE === '0' && !governanceOptOutClamped()) return value;
  // Resolve the org policy once at the top level, then thread it down via `_po`
  // so a deep payload doesn't re-resolve at every node (perf-neutral when unset).
  const po = depth === 0 ? effectivePolicyOpts(opts) : opts._po;
  const mode = (po && po.mode) || process.env.ARGUS_REDACT_MODE || opts.mode || 'mask';
  if (mode === 'token' && depth === 0) ensureTokenVaultWired(); // wire the vault seam once per top-level call (team > local, §9)
  const scrubOpts = { mode, ruleFilter: po && po.ruleFilter, extraSecretRules: po && po.extraSecretRules };
  const childOpts = depth === 0 && po ? { ...opts, _po: po } : opts;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value, scrubOpts);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return undefined; // pathological nesting → drop (fail closed)
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, childOpts, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      let v;
      try { v = value[k]; } catch { continue; } // throwing getter → drop the field
      if (URL_KEYS.has(k) && typeof v === 'string') out[k] = scrubText(sanitizeUrl(v), scrubOpts);
      else out[k] = deepScrub(v, childOpts, depth + 1);
    }
    return out;
  }
  return undefined; // functions / symbols → dropped
}

/**
 * Project a REPORT-shaped object (argus_audit_full / argus_compare /
 * argus_last_report) for egress: every finding array (routes[].errors,
 * routes[].findings, flows[].findings, codebase[]) runs through redactForEgress;
 * env-comparison routes[].diffs are deepScrub'd; a `redaction` rider is attached.
 * Report metadata (summary, route urls, mode, timestamps) is PRESERVED so the
 * golden response schemas still hold. Never mutates the input.
 *
 * Honours the report-level `_aegisFailClosed` flag (set by report-processor step 3c
 * on a classifier error): when set, ALL findings are force-redacted.
 *
 * A `policy` (raw §4.2 org policy) in `opts` flows through to redactForEgress /
 * deepScrub / the rider count; absent ⇒ the ARGUS_REDACT_POLICY env, else default.
 *
 * @param {object} report
 * @param {{ localReportPath?: string|null, mode?: string, failClosed?: boolean, policy?: unknown }} [opts]
 * @returns {object}
 */
export function redactReport(report, opts = {}) {
  if (process.env.ARGUS_REDACT_SENSITIVE === '0' && !governanceOptOutClamped()) return report;
  if (!report || typeof report !== 'object') return report;

  const failClosed = report._aegisFailClosed === true || opts.failClosed === true;
  const ro = { ...opts, failClosed };
  const rawFindings = [];
  const out = { ...report };

  if (Array.isArray(report.routes)) {
    out.routes = report.routes.map((route) => {
      if (!route || typeof route !== 'object') return route;
      const r = { ...route };
      if (Array.isArray(route.errors))   { rawFindings.push(...route.errors);   r.errors   = redactForEgress(route.errors, ro); }
      if (Array.isArray(route.findings)) { rawFindings.push(...route.findings); r.findings = redactForEgress(route.findings, ro); }
      if (Array.isArray(route.diffs))    { r.diffs = route.diffs.map((d) => deepScrub(d, ro)); }
      return r;
    });
  }
  if (Array.isArray(report.flows)) {
    out.flows = report.flows.map((flow) => {
      if (flow && typeof flow === 'object' && Array.isArray(flow.findings)) {
        rawFindings.push(...flow.findings);
        return { ...flow, findings: redactForEgress(flow.findings, ro) };
      }
      return flow;
    });
  }
  if (Array.isArray(report.codebase)) {
    rawFindings.push(...report.codebase);
    out.codebase = redactForEgress(report.codebase, ro);
  }

  if (Array.isArray(report.routes) || Array.isArray(report.flows) || Array.isArray(report.codebase)) {
    out.redaction = buildRedactionRider(rawFindings, { ...opts, failClosed });
  }
  return out;
}

/** Read a property without ever throwing (a pathological getter ⇒ undefined). */
function safeGet(obj, key) {
  try { return obj?.[key]; } catch { return undefined; }
}

/** JSON.stringify that never throws (cyclic / exotic values ⇒ a short token). */
function safeStringify(v) {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '[unserialisable]';
  }
}
