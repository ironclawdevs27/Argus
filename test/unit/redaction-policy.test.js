/**
 * Aegis — engine `policy` param unit suite (Chrome-free).
 *
 * The org policy resolver (redaction-policy.js) + its threading through
 * secret-patterns.js and sensitivity-classifier.js. Proves the four invariants
 * the enterprise governance seam depends on:
 *   - OPT-IN + DEFAULT-IDENTICAL: no policy ⇒ byte-identical to the pre-policy engine.
 *   - FAIL-CLOSED: a missing / malformed / throwing policy ⇒ the strict floor, never looser.
 *   - NARROW-ONLY EGRESS: a policy may only NARROW the field allowlist and only WIDEN
 *     the sensitive-type set — it can never add a leaky field or drop a built-in type.
 *   - NO-LEAK FLOOR: the entropy layer + the category/body-field catch-alls are NOT
 *     policy-toggleable, so an actual secret cannot leak even with named rules OFF.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  resolvePolicy, policyOpts, policyFromEnv, effectivePolicyOpts,
  STRICT_DEFAULT, VALID_MODES, _resetPolicyCacheForTests,
} from '../../src/utils/redaction-policy.js';
import { findSensitiveSpans, scrubText } from '../../src/utils/secret-patterns.js';
import {
  classifyFinding, redactForEgress, isSensitiveType, deepScrub, redactReport,
  summarizeRedaction, REDACT_MARKER,
} from '../../src/utils/sensitivity-classifier.js';

const ANTH = 'sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const EMAIL = 'jane.doe@example.com';

afterEach(() => {
  delete process.env.ARGUS_REDACT_POLICY;
  delete process.env.ARGUS_REDACT_SENSITIVE;
  delete process.env.ARGUS_REDACT_MODE;
  _resetPolicyCacheForTests();
});

describe('resolvePolicy — fail-closed to the strict default', () => {
  it('null / undefined ⇒ STRICT_DEFAULT (no-policy path)', () => {
    expect(resolvePolicy(null)).toBe(STRICT_DEFAULT);
    expect(resolvePolicy(undefined)).toBe(STRICT_DEFAULT);
  });
  it('non-object ⇒ fail-closed (invalid flag, null effects)', () => {
    for (const bad of ['x', 42, true, Symbol('x')]) {
      const r = resolvePolicy(bad);
      expect(r.invalid).toBe(true);
      expect(r.ruleFilter).toBe(null);
      expect(r.mode).toBe(null);
      expect(r.sensitiveTypes).toBe(null);
      expect(r.egressAllowlist).toBe(null);
    }
  });
  it('a throwing getter ⇒ fail-closed, never throws', () => {
    const evil = {}; Object.defineProperty(evil, 'rules', { get() { throw new Error('boom'); } });
    const r = resolvePolicy(evil);
    expect(r.invalid).toBe(true);
    expect(r.ruleFilter).toBe(null);
  });
  it('floor.failOpen is FORCED false even if the policy asks for true', () => {
    const r = resolvePolicy({ floor: { failOpen: true, minMode: 'label' } });
    expect(r.floor.failOpen).toBe(false);
    expect(r.floor.minMode).toBe('label');
  });
  it('an invalid mode is dropped (null), a valid one kept', () => {
    expect(resolvePolicy({ mode: 'nonsense' }).mode).toBe(null);
    expect(resolvePolicy({ mode: 'drop' }).mode).toBe('drop');
    for (const m of VALID_MODES) expect(resolvePolicy({ mode: m }).mode).toBe(m);
  });
});

describe('policyOpts / effectivePolicyOpts', () => {
  it('STRICT_DEFAULT / no policy ⇒ null (cheap short-circuit)', () => {
    expect(policyOpts(STRICT_DEFAULT)).toBe(null);
    expect(effectivePolicyOpts({})).toBe(null);
    expect(effectivePolicyOpts()).toBe(null);
  });
  it('a real policy ⇒ only the fields it sets', () => {
    const o = effectivePolicyOpts({ policy: { mode: 'drop', rules: { pii: { email: false } } } });
    expect(o.mode).toBe('drop');
    expect(typeof o.ruleFilter).toBe('function');
    expect(o.sensitiveTypes).toBe(undefined);
  });
  it('an empty egress allowlist is preserved ([] = narrow-all, distinct from null)', () => {
    const o = effectivePolicyOpts({ policy: { egressFieldAllowlist: [] } });
    expect(Array.isArray(o.egressAllowlist)).toBe(true);
    expect(o.egressAllowlist.length).toBe(0);
  });
});

describe('policyFromEnv — ARGUS_REDACT_POLICY (inline JSON), cached', () => {
  it('unset ⇒ null (byte-identical no-policy path)', () => {
    expect(policyFromEnv()).toBe(null);
  });
  it('valid JSON ⇒ resolved; cached by raw string', () => {
    process.env.ARGUS_REDACT_POLICY = JSON.stringify({ mode: 'label' });
    const a = policyFromEnv();
    const b = policyFromEnv();
    expect(a.mode).toBe('label');
    expect(a).toBe(b); // cache hit returns the same object
  });
  it('malformed JSON ⇒ fail-closed strict floor (not silently ignored)', () => {
    process.env.ARGUS_REDACT_POLICY = '{not json';
    const r = policyFromEnv();
    expect(r.invalid).toBe(true);
    expect(r.ruleFilter).toBe(null);
  });
});

describe('rule toggles (secret-patterns.js findSensitiveSpans)', () => {
  it('default ⇒ every rule runs (email + ssn detected)', () => {
    expect(findSensitiveSpans(`m ${EMAIL}`).map((s) => s.name)).toContain('email');
    expect(findSensitiveSpans('ssn 123-45-6789').map((s) => s.name)).toContain('ssn_us');
  });
  it('rules.pii.email:false disables ONLY email; other PII unaffected', () => {
    const o = effectivePolicyOpts({ policy: { rules: { pii: { email: false } } } });
    expect(findSensitiveSpans(`m ${EMAIL}`, o).map((s) => s.name)).not.toContain('email');
    expect(findSensitiveSpans('ssn 123-45-6789', o).map((s) => s.name)).toContain('ssn_us');
  });
  it('rules.secret.all:false disables the NAMED secret rules', () => {
    const o = effectivePolicyOpts({ policy: { rules: { secret: { all: false } } } });
    // The generic-assignment rule no longer fires on a short/low-entropy value.
    expect(findSensitiveSpans('password=hunter2', o).map((s) => s.name)).not.toContain('generic_assignment');
  });
  it('rules.secret.extra ADDS a custom rule (only ever redacts more)', () => {
    const o = effectivePolicyOpts({ policy: { rules: { secret: { all: true, extra: [{ name: 'acme', pattern: 'ACME-[0-9]{6}' }] } } } });
    expect(findSensitiveSpans('id ACME-123456 x', o).map((s) => s.name)).toContain('acme');
  });
  it('a malformed custom regex is skipped, never throws', () => {
    const o = effectivePolicyOpts({ policy: { rules: { secret: { all: true, extra: ['(unclosed', { name: 'ok', pattern: 'ZZ-[0-9]{3}' }] } } } });
    expect(() => findSensitiveSpans('ZZ-123', o)).not.toThrow();
    expect(findSensitiveSpans('ZZ-123', o).map((s) => s.name)).toContain('ok');
  });
  it('the entropy floor is NOT toggleable — a high-entropy token is still caught with all rules off', () => {
    const o = effectivePolicyOpts({ policy: { rules: { secret: { all: false }, pii: {} } } });
    const spans = findSensitiveSpans(`tok ${ANTH}`, o);
    expect(spans.some((s) => s.kind === 'entropy')).toBe(true);
  });
});

describe('sensitiveTypes union (isSensitiveType / classifyFinding)', () => {
  it('a policy WIDENS the sensitive-type set', () => {
    expect(isSensitiveType('perf_budget')).toBe(false);
    expect(isSensitiveType('perf_budget', ['perf_*'])).toBe(true);
    expect(isSensitiveType('exact_type', ['exact_type'])).toBe(true);
  });
  it('a built-in sensitive type stays sensitive even if the policy omits it (union, never drops)', () => {
    expect(isSensitiveType('security_no_https', ['perf_*'])).toBe(true);
    expect(isSensitiveType('cors_violation', ['perf_*'])).toBe(true);
  });
  it('classifyFinding respects the widened set', () => {
    const f = { type: 'perf_budget', severity: 'warning', message: 'slow' };
    expect(classifyFinding(f).sensitive).toBe(false);
    expect(classifyFinding(f, { sensitiveTypes: ['perf_*'] }).sensitive).toBe(true);
  });
});

describe('egress allowlist — NARROW-ONLY (redactForEgress)', () => {
  const finding = { type: 'layout_shift', severity: 'warning', route: '/x', url: 'http://h/p?t=1', selector: '#a', status: 404, count: 3, message: 'ok' };
  it('default keeps the optional passthroughs', () => {
    const out = redactForEgress([finding])[0];
    expect(out.selector).toBe('#a');
    expect(out.status).toBe(404);
    expect(out.count).toBe(3);
  });
  it('a narrower allowlist drops optional passthroughs (structural fields always kept)', () => {
    const out = redactForEgress([finding], { policy: { egressFieldAllowlist: ['type', 'severity', 'route'] } })[0];
    expect(out.selector).toBe(undefined);
    expect(out.status).toBe(undefined);
    expect(out.count).toBe(undefined);
    expect(out.type).toBe('layout_shift'); // structural — never dropped
    expect(out.route).toBe('/x');
  });
  it('a policy can NEVER widen the allowlist to leak a new field', () => {
    const leaky = { type: 't', severity: 'info', password: 'sekret', apiKey: 'k' };
    const keys = Object.keys(redactForEgress([leaky], { policy: { egressFieldAllowlist: ['password', 'apiKey', 'type', 'severity'] } })[0]);
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('apiKey');
  });
});

describe('FAIL-CLOSED — a malformed policy still redacts', () => {
  const secretFinding = { type: 'security_x', severity: 'critical', route: '/x', message: `key ${ANTH}` };
  it('a garbage policy ⇒ the finding is still redacted (marker, no raw key)', () => {
    const out = redactForEgress([secretFinding], { policy: 'garbage' })[0];
    expect(out.message).toBe(REDACT_MARKER);
    expect(JSON.stringify(out)).not.toContain(ANTH);
  });
  it('a throwing-getter policy ⇒ still redacted', () => {
    const evil = {}; Object.defineProperty(evil, 'egressFieldAllowlist', { get() { throw new Error('x'); } });
    const out = redactForEgress([secretFinding], { policy: evil })[0];
    expect(JSON.stringify(out)).not.toContain(ANTH);
  });
});

describe('NO-LEAK FLOOR — secret survives no policy weakening', () => {
  it('category floor: a security finding is fully redacted even with ALL rules off', () => {
    const f = { type: 'security_leak', severity: 'critical', route: '/x', message: `Authorization: Bearer ${ANTH}` };
    const o = { policy: { rules: { secret: { all: false }, pii: {} }, sensitiveTypes: [] } };
    const out = redactForEgress([f], o)[0];
    expect(out.message).toBe(REDACT_MARKER);
    expect(JSON.stringify(out)).not.toContain(ANTH);
  });
  it('entropy floor: a benign finding carrying a high-entropy secret still masks it with secret rules off', () => {
    const f = { type: 'console_warning', severity: 'info', route: '/x', message: `leaked ${AWS}INGKEY9876` };
    const out = redactForEgress([f], { policy: { rules: { secret: { all: false } } } })[0];
    expect(out.message).not.toContain(`${AWS}INGKEY9876`);
  });
  it('deepScrub honors the policy but the entropy floor still masks', () => {
    const o = { policy: { rules: { secret: { all: false } } } };
    const scrubbed = deepScrub({ log: `tok ${ANTH}` }, o);
    expect(scrubbed.log).not.toContain(ANTH);
  });
});

describe('OPT-IN / DEFAULT byte-identical', () => {
  const findings = [
    { type: 'security_no_https', severity: 'critical', route: '/login', message: `k ${ANTH}`, url: 'http://h/x?token=abc' },
    { type: 'layout_shift', severity: 'warning', route: '/', selector: '#hero', value: 'plain text', count: 2 },
    { type: 'console_error', severity: 'warning', route: '/a', message: `email ${EMAIL}` },
  ];
  it('redactForEgress with no policy === with an explicitly null policy === today', () => {
    const base = redactForEgress(findings);
    const withNull = redactForEgress(findings, { policy: null });
    const withUndef = redactForEgress(findings, {});
    expect(withNull).toEqual(base);
    expect(withUndef).toEqual(base);
  });
  it('redactReport with no policy is unchanged (rider + projection identical)', () => {
    const report = { routes: [{ url: 'http://h/', errors: findings }] };
    const a = redactReport(structuredClone(report));
    const b = redactReport(structuredClone(report), { policy: null });
    expect(b).toEqual(a);
  });
  it('the ARGUS_REDACT_SENSITIVE=0 opt-out still wins over a policy', () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    const out = redactForEgress(findings, { policy: { mode: 'drop', egressFieldAllowlist: [] } });
    expect(out).toEqual(findings.slice()); // byte-identical passthrough
  });
});

describe('rider count reconciles under a widening policy', () => {
  it('summarizeRedaction counts the widened types', () => {
    const findings = [{ type: 'perf_budget', severity: 'warning', message: 'slow' }];
    expect(summarizeRedaction(findings).redacted).toBe(0);
    expect(summarizeRedaction(findings, { sensitiveTypes: ['perf_*'] }).redacted).toBe(1);
  });
});
