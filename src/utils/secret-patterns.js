/**
 * Aegis — secret / PII pattern core (Step 1 of REDACTION_BOUNDARY_MAX_PLAN.md).
 *
 * Pure, zero-dependency detection primitives shared by the sensitivity
 * classifier and every egress guard. NOTHING here does I/O, touches Chrome,
 * spawns a process, or makes a network call — it is regex + arithmetic only,
 * so it runs in microseconds and is trivially unit-testable.
 *
 * SECURITY POSTURE — Aegis FAILS CLOSED (the one deliberate inversion from the
 * rest of Argus): every primitive here is built so that ambiguity redacts MORE,
 * never less. `findSensitiveSpans` is the union of independent layers — a miss
 * by one is caught by another — and `scrubText` is the projector all sinks call.
 *
 * Layers implemented here:
 *   L2  Secret regexes      — SECRET_RULES (JWT / AWS / Google / Slack / OpenAI /
 *                             Anthropic / GitHub / PEM / Bearer / basic-auth URL /
 *                             generic assignment).
 *   L3  Statistical rarity  — Token Efficiency (BPE) when a tokenizer is injected
 *                             via setTokenizer(); Shannon entropy is the zero-dep
 *                             FALLBACK so the layer ALWAYS functions without a dep
 *                             (js-tiktoken / gpt-tokenizer are absent by default).
 *   L4  Structured PII      — PII_RULES (email / E.164 phone / Luhn-valid card /
 *                             US SSN / IPv4 / IPv6 / private host).
 *   L5  Context boosting     — CONTEXT_WORDS (+/-) lower/raise the L3 threshold
 *                             near words like "token"/"secret" vs "example"/"test".
 *
 * Layer 1 (category rules) and the report walk live in sensitivity-classifier.js.
 *
 * `scrubSecrets` (the GitHub-token-only redactor) is RE-EXPORTED from
 * github-api.js at the bottom so callers can import it from here while
 * github-api.js stays byte-for-byte unchanged (its tests keep passing).
 */

// ── Secret regexes (Layer 2) ────────────────────────────────────────────────
// Each rule = { name, regex }. The regex MUST be global (/g) — findSensitiveSpans
// iterates matchAll. When a rule wants to redact only PART of the match (e.g. the
// token after "Bearer "), it uses a capture group named `secret` OR group 1; the
// span is that group when present, else the whole match.

/** @type {{name:string, regex:RegExp}[]} */
export const SECRET_RULES = [
  // JSON Web Token — three base64url segments. The header always starts `eyJ`.
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g },
  // Anthropic key — checked BEFORE the generic OpenAI `sk-` rule (more specific).
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI key (incl. sk-proj-…) — negative lookahead excludes the Anthropic shape.
  { name: 'openai_key', regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  // AWS access key id.
  { name: 'aws_access_key_id', regex: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA)[0-9A-Z]{16}\b/g },
  // AWS secret access key — anchored on the assignment to avoid 40-char base64 FPs.
  { name: 'aws_secret_access_key', regex: /aws_secret_access_key\s*[=:]\s*["']?(?<secret>[A-Za-z0-9/+]{40})/gi },
  // Google API key.
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack token.
  { name: 'slack_token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  // GitHub fine-grained PAT (has underscores) — checked before the short ghX_ rule.
  { name: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'github_token', regex: /\bgh[posru]_[A-Za-z0-9_]{10,}/g },
  // PEM private-key header (any algorithm).
  { name: 'private_key_pem', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // Bearer token — span is the token only (keep the literal "Bearer " readable).
  { name: 'bearer', regex: /(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{8,}/gi },
  // basic-auth URL — span is the userinfo `user:pass` (before the @).
  { name: 'basic_auth_url', regex: /(?<=:\/\/)(?<secret>[^/\s:@]+:[^/\s:@]+)(?=@)/g },
  // generic assignment: password= / api_key: / secret= / token= … — span is the value.
  { name: 'generic_assignment', regex: /\b(?:password|passwd|pwd|api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[=:]\s*["']?(?<secret>[^\s"'<>&]{6,})/gi },
];

// ── Structured PII (Layer 4) ────────────────────────────────────────────────
// validate? — an optional gate run over the matched span (group `secret`/1 or
// whole match); the span is dropped if it returns false (e.g. Luhn for cards).

/** @type {{name:string, regex:RegExp, validate?:(s:string)=>boolean}[]} */
export const PII_RULES = [
  { name: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'phone_e164', regex: /\+[1-9]\d{7,14}\b/g },
  {
    name: 'credit_card',
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    validate: (s) => luhnValid(s),
  },
  { name: 'ssn_us', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: 'ipv4',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  { name: 'ipv6', regex: /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b/g },
  {
    name: 'private_host',
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+\.internal|[A-Za-z0-9-]+\.local)\b/g,
  },
];

// ── Context words (Layer 5) ─────────────────────────────────────────────────
export const CONTEXT_WORDS = {
  positive: ['token', 'secret', 'password', 'passwd', 'pwd', 'authorization', 'auth',
    'bearer', 'cookie', 'apikey', 'api_key', 'api-key', 'access_key', 'accesskey',
    'private_key', 'privatekey', 'credential', 'credentials', 'session', 'signature'],
  negative: ['example', 'sample', 'dummy', 'test', 'placeholder', 'your', 'fake',
    'redacted', 'lorem', 'foobar', 'changeme', 'xxxx'],
};

// ── Statistical-rarity tuning (Layer 3) ─────────────────────────────────────
const ENTROPY_BASE64 = 4.0;  // bits/char default for a base64-charset token
const ENTROPY_HEX     = 3.0;  // bits/char for an all-hex token
const MIN_LEN_NO_CONTEXT = 20; // a bare high-entropy token must be this long…
const MIN_LEN_CONTEXT    = 12; // …unless a positive context word sits nearby
const CONTEXT_WINDOW     = 24; // chars before the token scanned for context
const TOKEN_EFFICIENCY_FLOOR = 2.5; // BPE efficiency below this ⇒ secret-shaped

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_RE  = /^[0-9a-fA-F]+$/;
// A token candidate for the entropy scan: a run of secret-shaped chars.
const TOKEN_SCAN_RE = /[A-Za-z0-9+/=_-]{8,}/g;

// Optional BPE tokenizer (Token Efficiency, plan §13.1). Absent by default; the
// production opt-in (ARGUS_REDACT_TOKEN_EFFICIENCY) wires js-tiktoken's encode in
// via setTokenizer(). When null, Layer 3 uses Shannon entropy — the zero-dep
// fallback — so the layer ALWAYS functions.
let _encode = null;

/**
 * Inject a BPE encoder (e.g. js-tiktoken's `encode`) to switch Layer 3 to Token
 * Efficiency. Pass null/undefined to revert to the Shannon-entropy fallback.
 * @param {((s:string)=>unknown[])|null} encodeFn
 */
export function setTokenizer(encodeFn) {
  _encode = typeof encodeFn === 'function' ? encodeFn : null;
}

// Optional reversible-vault tokenizer (Aegis Step 8, plan §5.3). Injected by
// aegis-vault.js when ARGUS_REDACT_VAULT=1; turns scrubText's `token` mode into a
// deterministic, information-free vault token. secret-patterns.js stays I/O-free —
// the I/O (mapping persistence) lives entirely in the injected function. When null,
// `token` mode FALLS BACK TO MASK (never emits the raw value — fail closed).
let _vaultTokenFn = null;

/**
 * Inject the vault tokenizer (aegis-vault's `tokenFor`) to enable scrubText's
 * `token` mode. Pass null/undefined to disable it (token mode then masks).
 * @param {((value:string)=>string)|null} fn
 */
export function setVaultTokenizer(fn) {
  _vaultTokenFn = typeof fn === 'function' ? fn : null;
}

/**
 * Token Efficiency = len(string) / len(BPE tokens). Real secrets fragment into
 * many short tokens (low efficiency); natural language compresses (high). Returns
 * null when no tokenizer is injected (caller falls back to Shannon entropy).
 * @param {string} str
 * @returns {number|null}
 */
export function tokenEfficiency(str) {
  if (!_encode || !str) return null;
  try {
    const tokens = _encode(str);
    const n = Array.isArray(tokens) ? tokens.length : Number(tokens?.length ?? 0);
    if (!n) return null;
    return str.length / n;
  } catch {
    return null; // fail toward the entropy fallback, never throw
  }
}

/**
 * Shannon entropy in bits/char.
 * @param {string} str
 * @returns {number}
 */
export function shannonEntropy(str) {
  if (!str) return 0;
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let H = 0;
  const len = str.length;
  for (const ch in freq) {
    const p = freq[ch] / len;
    H -= p * Math.log2(p);
  }
  return H;
}

/**
 * Luhn (mod-10) checksum validator for a candidate card number (may contain
 * spaces/hyphens). Cuts the credit-card false-positive rate dramatically.
 * @param {string} input
 * @returns {boolean}
 */
export function luhnValid(input) {
  const digits = String(input ?? '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * True when a context word from `list` appears within CONTEXT_WINDOW chars before
 * `start` in `text`.
 * @param {string} text
 * @param {number} start
 * @param {string[]} list
 * @returns {boolean}
 */
function hasContext(text, start, list) {
  const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start).toLowerCase();
  return list.some((w) => before.includes(w));
}

/**
 * Layer-3 decision for one candidate token: is it statistically rare enough
 * (secret-shaped) to flag? Uses Token Efficiency when a tokenizer is injected,
 * else Shannon entropy. UUIDs and short/low-diversity tokens are suppressed
 * (the gitleaks-style false-positive gate). Positive context lowers the length
 * bar; negative context raises the entropy bar.
 *
 * @param {string} token
 * @param {{ entropyThreshold?: number, positiveContext?: boolean, negativeContext?: boolean }} [opts]
 * @returns {boolean}
 */
export function isStatisticallyRare(token, opts = {}) {
  if (!token) return false;
  if (UUID_RE.test(token)) return false; // canonical UUID — never a secret

  const len = token.length;
  const minLen = opts.positiveContext ? MIN_LEN_CONTEXT : MIN_LEN_NO_CONTEXT;
  if (len < minLen) return false;

  // Charset-diversity gate: require ≥2 of {lower, upper, digit} OR base64 padding,
  // so an all-lowercase English-ish run or a CSS class name isn't flagged.
  const classes = (/[a-z]/.test(token) ? 1 : 0) + (/[A-Z]/.test(token) ? 1 : 0) +
                  (/[0-9]/.test(token) ? 1 : 0);
  if (classes < 2 && !/[+/=]/.test(token)) return false;

  // Token Efficiency first (when available), else Shannon entropy.
  const eff = tokenEfficiency(token);
  if (eff !== null) {
    const floor = opts.negativeContext ? TOKEN_EFFICIENCY_FLOOR - 0.6 : TOKEN_EFFICIENCY_FLOOR;
    return eff < floor;
  }

  const isHex = HEX_RE.test(token);
  let threshold = opts.entropyThreshold ?? (isHex ? ENTROPY_HEX : ENTROPY_BASE64);
  if (opts.negativeContext) threshold += 0.8; // make a "test"/"example" token harder to flag
  if (opts.positiveContext) threshold -= 0.8; // a "token="/"secret=" neighbour promotes it
  return shannonEntropy(token) >= threshold;
}

// Zero-width / soft-hyphen characters an attacker can splice into a secret to
// break a regex without changing how it renders.
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;

/**
 * Strip zero-width / soft-hyphen chars an attacker splices into a secret to break
 * a regex without changing how it renders. PRESERVES whitespace + word boundaries
 * (so \b-anchored rules like email / private-host still fire). Boundary-safe.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripZeroWidth(text) {
  return (typeof text === 'string' ? text : String(text ?? '')).replace(ZERO_WIDTH_RE, '');
}

// NOTE: a whitespace-REJOINING normaliser (to rebuild a secret split across
// spaces/newlines) was prototyped and REMOVED — on natural-language blobs it
// fused ordinary words into spurious high-entropy tokens, over-redacting benign
// findings. Whitespace/newline-split secrets in benign free-text are therefore a
// documented limitation, defended instead by the category + body-field catch-alls
// (a security-category finding or any finding carrying a body field drops ALL its
// free text). See REDACTION_BOUNDARY_MAX_PLAN.md Progress Log.

// ── Span union scan ─────────────────────────────────────────────────────────

/**
 * The union of all detection layers over `text`. Returns NON-overlapping spans
 * (overlaps merged) sorted by start, each `{start, end, kind, name}` where kind ∈
 * {secret, pii, entropy}. This is the single source of truth that scrubText
 * redacts and that the fuzz invariant proves redactForEgress never leaks.
 *
 * @param {string} text
 * @param {{ entropyThreshold?: number }} [opts]
 * @returns {{start:number, end:number, kind:'secret'|'pii'|'entropy', name:string}[]}
 */
export function findSensitiveSpans(text, opts = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (!s) return [];
  /** @type {{start:number,end:number,kind:string,name:string}[]} */
  const spans = [];

  const pushFromRule = (rule, kind) => {
    rule.regex.lastIndex = 0;
    for (const m of s.matchAll(rule.regex)) {
      // Prefer the named `secret` group, else group 1, else the whole match.
      const captured = (m.groups && m.groups.secret !== undefined) ? m.groups.secret : (m[1] ?? m[0]);
      if (captured === undefined || captured === '') continue;
      if (rule.validate && !rule.validate(captured)) continue;
      // Locate the captured span inside the full match (handles lookbehind + groups).
      const matchStart = m.index ?? s.indexOf(m[0]);
      const offset = m[0].indexOf(captured);
      const start = matchStart + (offset >= 0 ? offset : 0);
      spans.push({ start, end: start + captured.length, kind, name: rule.name });
    }
  };

  for (const rule of SECRET_RULES) pushFromRule(rule, 'secret');
  for (const rule of PII_RULES)    pushFromRule(rule, 'pii');

  // Layer 3 — entropy / token-efficiency over candidate tokens.
  TOKEN_SCAN_RE.lastIndex = 0;
  for (const m of s.matchAll(TOKEN_SCAN_RE)) {
    const token = m[0];
    const start = m.index ?? 0;
    const positiveContext = hasContext(s, start, CONTEXT_WORDS.positive);
    const negativeContext = hasContext(s, start, CONTEXT_WORDS.negative);
    if (isStatisticallyRare(token, { entropyThreshold: opts.entropyThreshold, positiveContext, negativeContext })) {
      spans.push({ start, end: start + token.length, kind: 'entropy', name: 'high_entropy' });
    }
  }

  return mergeSpans(spans);
}

/**
 * Merge overlapping/adjacent spans into the widest covering span so scrubText
 * replaces each region once. Keeps the first contributing span's name/kind.
 * @param {{start:number,end:number,kind:string,name:string}[]} spans
 */
export function mergeSpans(spans) {
  if (spans.length <= 1) return spans.slice();
  const sorted = spans.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end); // overlap → extend
    } else {
      out.push(cur);
    }
  }
  return out;
}

// ── Redaction modes ─────────────────────────────────────────────────────────
const MASK_CHAR = '█';

/**
 * Replacement string for one span's text under the chosen mode. INVARIANT
 * (mode=mask): the result is never LONGER than the original span and never
 * reproduces the full secret verbatim.
 * @param {string} value  the raw span substring
 * @param {string} kind
 * @param {string} name
 * @param {string} mode   mask | label | hash | token | drop
 * @returns {string}
 */
function maskValue(value, kind, name, mode) {
  switch (mode) {
    case 'drop':
      return '';
    case 'label':
      return `[REDACTED_${String(name || kind).toUpperCase()}]`;
    case 'token': {
      // Reversible vault token (plan §5.2/§5.3). The token is an HMAC — information-
      // free, so the secret never crosses; the token→original mapping lives only in
      // the local 0600 vault. FAILS CLOSED: no vault wired ⇒ fall back to mask.
      if (_vaultTokenFn) {
        try { return _vaultTokenFn(value); } catch { /* fall through to mask */ }
      }
      const keepT = Math.min(4, Math.floor(value.length / 3));
      return value.slice(0, keepT) + MASK_CHAR.repeat(value.length - keepT);
    }
    case 'hash': {
      // Length-stable, collision-resistant-enough correlation tag (no crypto dep).
      let h = 0;
      for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
      const hex = (h >>> 0).toString(16).padStart(8, '0');
      return `«${name}:${hex}»`;
    }
    case 'mask':
    default: {
      // Keep a SHORT prefix (≤4 chars, never ≥ half the secret) for debuggability;
      // mask the rest. Same length ⇒ never lengthens; full secret never survives.
      const keep = Math.min(4, Math.floor(value.length / 3));
      return value.slice(0, keep) + MASK_CHAR.repeat(value.length - keep);
    }
  }
}

/**
 * Replace every sensitive span in `text` per `mode`. Idempotent
 * (scrub(scrub(x)) === scrub(x)) and, for mode=mask, never lengthens the input.
 * This SUPERSEDES the GitHub-only scrubSecrets for free-text egress.
 *
 * @param {string} text
 * @param {{ mode?: string, entropyThreshold?: number }} [opts]
 * @returns {string}
 */
export function scrubText(text, opts = {}) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  if (!s) return s;
  const mode = opts.mode || 'mask';
  const spans = findSensitiveSpans(s, opts);
  if (spans.length === 0) return s;

  let out = '';
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start < cursor) continue; // defensive (merged spans shouldn't overlap)
    out += s.slice(cursor, sp.start);
    out += maskValue(s.slice(sp.start, sp.end), sp.kind, sp.name, mode);
    cursor = sp.end;
  }
  out += s.slice(cursor);
  return out;
}

// Re-export the GitHub-token-only redactor so callers can import it from here
// while github-api.js stays byte-for-byte unchanged (its existing tests pass).
export { scrubSecrets } from './github-api.js';
