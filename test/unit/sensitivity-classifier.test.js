/**
 * Aegis Step 2 — sensitivity-classifier.js unit suite (Chrome-free).
 *
 * Proves the four marquee safety properties at the unit level:
 *   - DENY-BY-DEFAULT: a finding carrying an unknown extra field never leaks it.
 *   - FAIL-CLOSED: a finding whose classification throws is redacted MORE
 *     (a fully-redacted stub / sensitive), never passed through raw.
 *   - LOCAL FIDELITY: classifySensitivity TAGS on a clone — the report's raw
 *     secret survives, and Object.freeze'd (createFinding) inputs never throw.
 *   - OPT-OUT: ARGUS_REDACT_SENSITIVE=0 ⇒ byte-identical passthrough.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createFinding } from '../../src/domain/finding.js';
import {
  classifyFinding, classifySensitivity, redactForEgress, summarizeRedaction,
  sanitizeUrl, routeFromUrl, isSensitiveType, findingKey,
  buildRedactionRider, deepScrub, redactReport, REDACT_MARKER,
  EGRESS_ALLOWLIST, SENSITIVE_TYPES, BODY_FIELDS,
} from '../../src/utils/sensitivity-classifier.js';

const ANTH = 'sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

// Output keys Aegis may emit: the allowlist plus the two generated markers.
const ALLOWED_OUT_KEYS = new Set([...EGRESS_ALLOWLIST, 'detail', 'message']);

afterEach(() => { delete process.env.ARGUS_REDACT_SENSITIVE; delete process.env.ARGUS_REDACT_MODE; });

describe('isSensitiveType (Layer 1 category)', () => {
  it('flags every security_* type, the seed set, and unknown shapes', () => {
    expect(isSensitiveType('security_no_https')).toBe(true);
    expect(isSensitiveType('security_anything_new')).toBe(true);
    expect(isSensitiveType('cors_violation')).toBe(true);
    expect(isSensitiveType('cookie_attribute_missing')).toBe(true);
    expect(isSensitiveType(undefined)).toBe(true);  // fail closed on unknown shape
    expect(isSensitiveType(123)).toBe(true);
  });
  it('does NOT flag cosmetic categories', () => {
    expect(isSensitiveType('seo_missing_description')).toBe(false);
    expect(isSensitiveType('theme_no_dark_mode')).toBe(false);
    expect(isSensitiveType('font_slow_load')).toBe(false);
    expect(SENSITIVE_TYPES.has('seo_missing_description')).toBe(false);
  });
  it('a body field marks an otherwise-cosmetic finding sensitive (catch-all)', () => {
    expect(BODY_FIELDS).toContain('responseBody');
    const f = { type: 'font_slow_load', severity: 'info', message: 'slow', responseBody: '{"k":1}' };
    expect(classifyFinding(f).sensitive).toBe(true);
    expect(classifyFinding(f).sensitivityReasons).toContain('category:has_responseBody');
  });
});

describe('DENY-BY-DEFAULT — unknown fields never cross', () => {
  it('drops an unknown extra field and its value', () => {
    const f = {
      type: 'security_no_https', severity: 'critical', url: 'http://x.com/login',
      message: 'over http', internalTopologyNote: 'db at 10.0.0.5', futureSecretField: ANTH,
    };
    const [out] = redactForEgress([f]);
    expect('internalTopologyNote' in out).toBe(false);
    expect('futureSecretField' in out).toBe(false);
    const json = JSON.stringify(out);
    expect(json.includes(ANTH)).toBe(false);
    expect(json.includes('10.0.0.5')).toBe(false);
    // EVERY output key is on the allowlist (+ generated markers).
    for (const k of Object.keys(out)) expect(ALLOWED_OUT_KEYS.has(k), `unexpected key ${k}`).toBe(true);
  });
  it('a benign finding with an unknown field also drops it', () => {
    const f = { type: 'seo_missing_description', severity: 'warning', url: 'http://x.com', message: 'add desc', debugBlob: ANTH };
    const [out] = redactForEgress([f]);
    expect('debugBlob' in out).toBe(false);
    expect(JSON.stringify(out).includes(ANTH)).toBe(false);
    for (const k of Object.keys(out)) expect(ALLOWED_OUT_KEYS.has(k), `unexpected key ${k}`).toBe(true);
  });
});

describe('FAIL-CLOSED', () => {
  it('opts.failClosed forces a benign finding to be redacted', () => {
    const seo = { type: 'seo_missing_description', severity: 'warning', url: 'http://x.com', message: 'add a meta description' };
    const normal = redactForEgress([seo])[0];
    expect(normal.message).toBe('add a meta description'); // benign normally keeps it
    const forced = redactForEgress([seo], { failClosed: true })[0];
    // A sensitive/forced finding carries the redaction MARKER in `message` (satisfies the
    // canonical finding contract + every sink that reads f.message) — never the raw message.
    // `detail` carries the same provenance marker. The marker is a constant: provably secret-free.
    expect(forced.message).toBe(REDACT_MARKER);
    expect(forced.detail).toContain('redacted');
  });
  it('a finding whose getter THROWS is redacted, never raw (both paths)', () => {
    const boom = { type: 'security_no_https', severity: 'critical', url: 'http://x.com/login' };
    Object.defineProperty(boom, 'message', { enumerable: true, get() { throw new Error('boom'); } });

    // classifySensitivity per-finding catch ⇒ sensitive:true, classifier-error.
    const report = { routes: [{ errors: [boom] }] };
    const { sensitiveCount } = classifySensitivity(report);
    expect(sensitiveCount).toBe(1);
    expect(report.routes[0].errors[0].sensitivityReasons).toContain('classifier-error');

    // redactForEgress per-finding catch ⇒ fully-redacted stub, no secret.
    const [stub] = redactForEgress([boom]);
    expect(stub.detail).toContain('redacted');
    expect('message' in stub).toBe(false);
  });
});

describe('LOCAL FIDELITY — classifySensitivity tags without removing detail', () => {
  it('the raw secret survives in the tagged report; tags are added', () => {
    const msg = `posts over http; Authorization: Bearer ${ANTH}`;
    const report = { routes: [{ errors: [{ type: 'security_no_https', severity: 'critical', url: 'http://app.internal/login', message: msg }] }] };
    const { sensitiveCount } = classifySensitivity(report, { reportRef: 'error-report-X.json' });
    expect(sensitiveCount).toBe(1);
    const tagged = report.routes[0].errors[0];
    expect(tagged.message).toBe(msg);            // full detail preserved locally
    expect(tagged.message.includes(ANTH)).toBe(true);
    expect(tagged.sensitive).toBe(true);
    expect(tagged.localRef).toBe('error-report-X.json#security_no_https::/login');
  });
  it('does not throw on Object.freeze(createFinding) inputs and tags clones', () => {
    const frozen = createFinding({ type: 'security_no_https', severity: 'critical', url: 'http://x/login', message: `key ${ANTH}` });
    expect(Object.isFrozen(frozen)).toBe(true);
    const report = { routes: [{ errors: [frozen] }], flows: [{ findings: [frozen] }], codebase: [frozen] };
    expect(() => classifySensitivity(report)).not.toThrow();
    expect(report.routes[0].errors[0].sensitive).toBe(true);
    expect(report.flows[0].findings[0].sensitive).toBe(true);
    expect(report.codebase[0].sensitive).toBe(true);
    expect(frozen.sensitive).toBeUndefined(); // original untouched
  });
  it('is idempotent — re-tagging yields the same sensitivity', () => {
    const report = { routes: [{ errors: [{ type: 'security_no_https', severity: 'critical', url: 'http://x/a', message: 'm' }] }] };
    classifySensitivity(report);
    const first = report.routes[0].errors[0].sensitive;
    classifySensitivity(report);
    expect(report.routes[0].errors[0].sensitive).toBe(first);
  });
});

describe('OPT-OUT — ARGUS_REDACT_SENSITIVE=0 is byte-identical passthrough', () => {
  it('returns the same finding objects unredacted', () => {
    const f = { type: 'security_no_https', severity: 'critical', url: 'http://x?t=secret', message: `key ${ANTH}`, evidence: 'raw' };
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    const out = redactForEgress([f]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(f);                 // same reference — no projection
    expect(out[0].message.includes(ANTH)).toBe(true);
    expect(out[0].evidence).toBe('raw');
  });
});

describe('Projection details', () => {
  it('strips the query string + userinfo from urls; keeps origin+path', () => {
    expect(sanitizeUrl('http://u:p@app.internal:8080/login?session=' + JWT + '#x')).toBe('http://app.internal:8080/login');
    expect(sanitizeUrl('/relative/path?token=abc#frag')).toBe('/relative/path');
    expect(sanitizeUrl('')).toBe('');
    expect(routeFromUrl('http://x.com/checkout?a=1')).toBe('/checkout');
  });
  it('numeric value passes through; a string value is scrubbed', () => {
    const numeric = redactForEgress([{ type: 'long_task', severity: 'warning', value: 1234, message: 'slow' }])[0];
    expect(numeric.value).toBe(1234);
    const strVal = redactForEgress([{ type: 'seo_missing_description', severity: 'info', value: `tok ${ANTH}`, message: 'm' }])[0];
    expect(typeof strVal.value).toBe('string');
    expect(strVal.value.includes(ANTH)).toBe(false);
  });
  it('summarizeRedaction reconciles with the sensitive count', () => {
    const sensitive = { type: 'security_no_https', severity: 'critical', url: 'http://x', message: 'm' };
    const benign = { type: 'seo_missing_description', severity: 'info', url: 'http://x', message: 'm' };
    const r = summarizeRedaction([sensitive, benign, sensitive]);
    expect(r.total).toBe(3);
    expect(r.redacted).toBe(2);
    expect(r.byReason['category:security_no_https']).toBe(2);
  });
  it('findingKey is type::route', () => {
    expect(findingKey({ type: 'security_no_https', route: '/login' })).toBe('security_no_https::/login');
    expect(findingKey({ type: 'security_no_https', url: 'http://x/login?q=1' })).toBe('security_no_https::/login');
  });
});

// ── Step 4 egress helpers (MCP boundary) ──────────────────────────────────────

describe('Step 4 — a sensitive projection carries a schema-valid marker message', () => {
  it('a sensitive finding gets message === REDACT_MARKER (never the raw message) + detail', () => {
    const f = { type: 'security_no_https', severity: 'critical', url: 'http://x/login', message: `key ${ANTH}` };
    const out = redactForEgress([f])[0];
    expect(out.message).toBe(REDACT_MARKER);         // satisfies the canonical findingSchema's required `message`
    expect(out.message.includes(ANTH)).toBe(false);  // raw message did NOT cross
    expect(out.detail).toContain('redacted');
    expect(typeof out.message).toBe('string');
  });
  it('a benign finding keeps its scrubbed message (not the marker)', () => {
    const out = redactForEgress([{ type: 'seo_missing_description', severity: 'info', url: 'http://x', message: 'add a meta description' }])[0];
    expect(out.message).toBe('add a meta description');
    expect(out.message).not.toBe(REDACT_MARKER);
  });
});

describe('buildRedactionRider', () => {
  it('reconciles the rider with the sensitive count and carries a localReportPath', () => {
    const findings = [
      { type: 'security_no_https', severity: 'critical', url: 'http://x', message: 'm' },
      { type: 'seo_missing_description', severity: 'info', url: 'http://x', message: 'm' },
    ];
    const rider = buildRedactionRider(findings, { localReportPath: '/reports/r.json' });
    expect(rider.total).toBe(2);
    expect(rider.redacted).toBe(1);
    expect(rider.localReportPath).toBe('/reports/r.json');
    expect(typeof rider.note).toBe('string');
  });
  it('defaults localReportPath to null and tolerates a non-array', () => {
    const rider = buildRedactionRider(undefined);
    expect(rider).toEqual(expect.objectContaining({ redacted: 0, total: 0, localReportPath: null }));
  });
});

describe('deepScrub — loose console/network/diff scrubbing', () => {
  it('masks an embedded secret in a string and a URL key, keeps scalars, preserves keys', () => {
    const con = deepScrub({ level: 'error', text: `Authorization: Bearer ${ANTH}`, source: `http://app.internal/cb?token=${JWT}`, count: 3 });
    expect(JSON.stringify(con).includes(ANTH)).toBe(false);
    expect(JSON.stringify(con).includes(JWT)).toBe(false);   // query stripped by sanitizeUrl on a url-key
    expect(con.source.includes('?')).toBe(false);
    expect(con.level).toBe('error');                          // scalar passthrough — key set preserved
    expect(con.count).toBe(3);
  });
  it('recurses arrays/objects, never throws on a throwing getter (fail closed), drops it', () => {
    const bad = { ok: 'x' };
    Object.defineProperty(bad, 'boom', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => deepScrub([{ nested: bad }])).not.toThrow();
    const out = deepScrub([{ nested: bad }]);
    expect('boom' in out[0].nested).toBe(false);
    expect(out[0].nested.ok).toBe('x');
  });
  it('ARGUS_REDACT_SENSITIVE=0 returns the value unchanged (opt-out)', () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    const v = { text: `Bearer ${ANTH}` };
    expect(deepScrub(v)).toBe(v);
  });
});

describe('redactReport — report-shaped egress (audit_full / compare / last_report)', () => {
  it('redacts routes[].errors + flows[].findings + codebase[], preserves metadata, attaches a rider', () => {
    const report = {
      generatedAt: 't', baseUrl: 'http://x', summary: { total: 1, critical: 1, warning: 0, info: 0 },
      routes: [{ route: 'r', url: 'http://x', crawledAt: 't', pageTitle: 'p', isBlankPage: false, screenshot: null,
        errors: [{ type: 'security_sensitive_console', severity: 'critical', url: 'http://x', message: `Bearer ${ANTH}` }] }],
      flows: [{ name: 'f', findings: [{ type: 'security_no_https', severity: 'critical', url: 'http://x', message: `jwt ${JWT}` }] }],
      codebase: [{ type: 'security_secret_in_code', severity: 'critical', message: `key ${ANTH}` }],
    };
    const out = redactReport(report);
    const txt = JSON.stringify(out);
    expect(txt.includes(ANTH)).toBe(false);
    expect(txt.includes(JWT)).toBe(false);
    expect(out.routes[0].route).toBe('r');              // route metadata preserved (golden schema holds)
    expect(out.summary.total).toBe(1);                  // summary preserved (computed pre-redaction)
    expect(out.redaction.redacted).toBe(3);
    expect(out.redaction.total).toBe(3);
    expect(report.routes[0].errors[0].message.includes(ANTH)).toBe(true); // input NOT mutated (local fidelity)
  });
  it('css-analysis mode redacts routes[].findings; env-comparison mode deepScrubs routes[].diffs', () => {
    const css = { mode: 'css-analysis', generatedAt: 't', baseUrl: 'http://x', note: 'n', summary: { total: 0, critical: 0, warning: 0, info: 0 },
      routes: [{ route: 'r', url: 'http://x', analyzedAt: 't', screenshot: null,
        findings: [{ type: 'css_override', severity: 'warning', url: 'http://x', message: `leaked ${ANTH}` }] }] };
    expect(JSON.stringify(redactReport(css)).includes(ANTH)).toBe(false);

    const env = { mode: 'env-comparison', generatedAt: 't', devUrl: 'http://d', stagingUrl: 'http://s', summary: { total: 1, critical: 1, warning: 0, info: 0 },
      routes: [{ route: 'r', devUrl: 'http://d', stagingUrl: 'http://s',
        diffs: [{ type: 'console_regression', severity: 'critical', description: `New console error: Bearer ${ANTH}` }] }] };
    const out = redactReport(env);
    expect(JSON.stringify(out).includes(ANTH)).toBe(false);
    expect(out.routes[0].diffs[0].type).toBe('console_regression');  // diff type preserved
  });
  it('honours report._aegisFailClosed — a benign finding is force-redacted', () => {
    const report = { _aegisFailClosed: true, routes: [{ errors: [
      { type: 'seo_missing_description', severity: 'info', url: 'http://x', message: 'add a meta description' },
    ] }], flows: [], codebase: [] };
    const out = redactReport(report);
    expect(out.routes[0].errors[0].message).toBe(REDACT_MARKER);  // fail-closed: redacted despite benign category
    expect(out.redaction.redacted).toBe(1);
  });
  it('ARGUS_REDACT_SENSITIVE=0 returns the same report reference (opt-out)', () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    const report = { routes: [{ errors: [{ type: 'security_no_https', severity: 'critical', message: `k ${ANTH}` }] }] };
    expect(redactReport(report)).toBe(report);
  });
});
