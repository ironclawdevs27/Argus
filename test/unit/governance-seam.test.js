/**
 * Aegis — governance seam unit suite (Chrome-free).
 *
 * The opt-in self-hosted central-policy bridge (governance-seam.js) that fetches +
 * Ed25519-verifies the org policy and applies it through the shipped `policy` param.
 * Proves the AEGIS_FOR_TEAMS §9 invariants the enterprise moat rests on:
 *   - SIGNATURE: a genuinely-signed policy verifies; a tampered body under a valid
 *     signature is REJECTED; the wrong public key is REJECTED.
 *   - FAIL-CLOSED: a bad signature / unreachable URL / malformed policy all fall
 *     back to the STRICT floor (redaction is never loosened on error).
 *   - APPLY: a verified policy flows through the REAL redactForEgress (a rule toggle
 *     takes effect only after verification succeeds).
 *   - NO-LEAK: the aggregate POST body carries only secret-free label counts.
 *   - OPT-IN DEFAULT-IDENTICAL: no gov token ⇒ the engine is byte-identical.
 *   - TTL CACHE: at most one fetch per TTL window.
 *   - STRICT CLAMP: a gov token disables the local ARGUS_REDACT_SENSITIVE=0 opt-out.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  canonicalPolicyBytes, verifySignedPolicy, ensureGovernancePolicy,
  postRedactionAggregate, governanceActive, governancePolicyVersion,
  _resetGovernanceForTests,
} from '../../src/utils/governance-seam.js';
import {
  effectivePolicyOpts, governanceOptOutClamped, _resetPolicyCacheForTests,
} from '../../src/utils/redaction-policy.js';
import { redactForEgress, REDACT_MARKER } from '../../src/utils/sensitivity-classifier.js';

const ANTH = 'sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx';
const EMAIL = 'jane.doe@example.com';
const URL = 'https://control-plane.example.com/aegis/policy';
const AUDIT_URL = 'https://control-plane.example.com/aegis/audit';

// One org keypair for the whole suite; a SECOND (attacker) key for the wrong-key proof.
const org = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const ORG_PUB_PEM = org.publicKey.export({ type: 'spki', format: 'pem' });

// A representative org policy: mode label, email PII off, secrets on.
const POLICY = {
  version: 7,
  orgId: 'org_acme',
  enforcement: 'strict',
  mode: 'label',
  rules: { secret: { all: true }, pii: { email: false, credit_card: true, ssn_us: true } },
  sensitiveTypes: ['security_*'],
  egressFieldAllowlist: ['type', 'severity', 'route', 'url', 'selector', 'value', 'title'],
  floor: { failOpen: false, minMode: 'mask' },
};

function signWith(privKey, policy = POLICY) {
  return edSign(null, Buffer.from(canonicalPolicyBytes(policy), 'utf8'), privKey).toString('base64');
}
function signedPayload(policy = POLICY, privKey = org.privateKey) {
  return { policy, signature: signWith(privKey, policy), alg: 'ed25519' };
}
// A fetch stub that returns a payload (or throws for the unreachable case).
function fetchReturning(payload, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => payload });
}
function fetchThrowing(msg = 'ECONNREFUSED') {
  return async () => { throw new Error(msg); };
}

beforeEach(() => {
  process.env.ARGUS_GOV_TOKEN = 'gov_test_token_123';
  process.env.ARGUS_REDACT_POLICY_URL = URL;
  process.env.ARGUS_REDACT_POLICY_PUBKEY = ORG_PUB_PEM;
  _resetGovernanceForTests();
  _resetPolicyCacheForTests();
});
afterEach(() => {
  delete process.env.ARGUS_GOV_TOKEN;
  delete process.env.ARGUS_REDACT_POLICY_URL;
  delete process.env.ARGUS_REDACT_POLICY_PUBKEY;
  delete process.env.ARGUS_REDACT_AUDIT_URL;
  delete process.env.ARGUS_REDACT_SENSITIVE;
  delete process.env.ARGUS_REDACT_MODE;
  delete process.env.ARGUS_REDACT_POLICY_TTL_MS;
  _resetGovernanceForTests();
  _resetPolicyCacheForTests();
});

// ── SIGNATURE ─────────────────────────────────────────────────────────────────
describe('verifySignedPolicy — Ed25519 signature', () => {
  it('a genuinely-signed policy verifies and returns the doc', () => {
    const doc = verifySignedPolicy(signedPayload());
    expect(doc.version).toBe(7);
    expect(doc.orgId).toBe('org_acme');
  });
  it('a tampered body under a valid signature is REJECTED', () => {
    const p = signedPayload();
    p.policy = { ...p.policy, mode: 'drop', rules: { secret: { all: false }, pii: {} } }; // weaken after signing
    expect(() => verifySignedPolicy(p)).toThrow(/verification failed/i);
  });
  it('the WRONG public key is REJECTED (attacker-signed policy)', () => {
    const p = signedPayload(POLICY, attacker.privateKey); // signed by the wrong key
    expect(() => verifySignedPolicy(p)).toThrow(/verification failed/i);
  });
  it('a missing signature / missing pubkey / non-object all throw (→ caller fails closed)', () => {
    expect(() => verifySignedPolicy({ policy: POLICY })).toThrow(/signature/i);
    expect(() => verifySignedPolicy(signedPayload(), '')).toThrow(/PUBKEY/i);
    expect(() => verifySignedPolicy(null)).toThrow(/not an object/i);
    expect(() => verifySignedPolicy({ signature: 'x' })).toThrow(/missing "policy"/i);
  });
  it('canonicalPolicyBytes is key-order-stable (interop with the cloud signer)', () => {
    const a = canonicalPolicyBytes({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = canonicalPolicyBytes({ a: 2, nested: { x: 2, y: 1 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"nested":{"x":2,"y":1}}');
  });
});

// ── APPLY (verified policy flows through the REAL redactForEgress) ─────────────
describe('ensureGovernancePolicy — a verified policy is applied', () => {
  it('rules.pii.email:false takes effect through redactForEgress after verify', async () => {
    const benign = { type: 'console_error', severity: 'warning', route: '/a', message: `contact ${EMAIL}` };
    // Before the fetch: cold + active ⇒ strict floor ⇒ email IS redacted (fail-closed).
    expect(redactForEgress([benign])[0].message).not.toContain(EMAIL);

    const resolved = await ensureGovernancePolicy({ fetchImpl: fetchReturning(signedPayload()) });
    expect(resolved.orgId).toBe('org_acme');
    expect(governancePolicyVersion()).toBe(7);

    // After verify+apply: the org turned email OFF ⇒ the email SURVIVES.
    const out = redactForEgress([benign])[0];
    expect(out.message).toContain(EMAIL);
    // …but the mode came from the policy (label) and secrets are still redacted.
    const secretF = { type: 'console_error', severity: 'warning', route: '/a', message: `key ${ANTH}` };
    expect(redactForEgress([secretF])[0].message).not.toContain(ANTH);
  });

  it('effectivePolicyOpts reflects the applied policy mode', async () => {
    await ensureGovernancePolicy({ fetchImpl: fetchReturning(signedPayload()) });
    expect(effectivePolicyOpts({}).mode).toBe('label');
  });
});

// ── FAIL-CLOSED ───────────────────────────────────────────────────────────────
describe('fail-closed — any error falls back to the strict floor', () => {
  const secretFinding = { type: 'security_leak', severity: 'critical', route: '/x', message: `Authorization: Bearer ${ANTH}` };

  it('a tampered (bad-signature) policy ⇒ STRICT floor ⇒ finding still redacted', async () => {
    const p = signedPayload();
    p.policy = { ...p.policy, egressFieldAllowlist: ['type', 'severity', 'password'] }; // weaken after signing
    const resolved = await ensureGovernancePolicy({ fetchImpl: fetchReturning(p) });
    expect(resolved.invalid === false && resolved.mode === null).toBe(true); // STRICT_DEFAULT
    expect(effectivePolicyOpts({})).toBe(null); // strict floor ⇒ no loosening opts
    const out = redactForEgress([secretFinding])[0];
    expect(out.message).toBe(REDACT_MARKER);
    expect(JSON.stringify(out)).not.toContain(ANTH);
  });

  it('an unreachable POLICY_URL ⇒ STRICT floor (redaction not loosened)', async () => {
    await ensureGovernancePolicy({ fetchImpl: fetchThrowing() });
    expect(effectivePolicyOpts({})).toBe(null);
    expect(JSON.stringify(redactForEgress([secretFinding])[0])).not.toContain(ANTH);
  });

  it('a malformed payload (missing signature) ⇒ STRICT floor', async () => {
    await ensureGovernancePolicy({ fetchImpl: fetchReturning({ policy: POLICY }) });
    expect(effectivePolicyOpts({})).toBe(null);
  });

  it('an HTTP error (403) ⇒ STRICT floor', async () => {
    await ensureGovernancePolicy({ fetchImpl: fetchReturning({}, { ok: false, status: 403 }) });
    expect(effectivePolicyOpts({})).toBe(null);
    expect(governancePolicyVersion()).toBe(null);
  });

  it('ensureGovernancePolicy NEVER throws (even with no fetch impl)', async () => {
    await expect(ensureGovernancePolicy({ fetchImpl: undefined })).resolves.toBeDefined();
  });
});

// ── OPT-IN DEFAULT-IDENTICAL ──────────────────────────────────────────────────
describe('opt-in — no gov token ⇒ byte-identical', () => {
  const findings = [
    { type: 'security_no_https', severity: 'critical', route: '/login', message: `k ${ANTH}` },
    { type: 'console_error', severity: 'warning', route: '/a', message: `email ${EMAIL}` },
  ];
  it('governanceActive false + source returns null when no token', async () => {
    delete process.env.ARGUS_GOV_TOKEN;
    expect(governanceActive()).toBe(false);
    expect(governanceOptOutClamped()).toBe(false);
    // No fetch happens; redaction is exactly the pre-seam default.
    const before = redactForEgress(findings);
    const nulled = await ensureGovernancePolicy({ fetchImpl: fetchReturning(signedPayload()) });
    expect(nulled).toBe(null); // inert
    expect(redactForEgress(findings)).toEqual(before);
    expect(effectivePolicyOpts({})).toBe(null);
  });
  it('no token ⇒ the ARGUS_REDACT_SENSITIVE=0 opt-out still passes through raw', () => {
    delete process.env.ARGUS_GOV_TOKEN;
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    expect(redactForEgress(findings)).toEqual(findings.slice());
  });
});

// ── STRICT CLAMP ──────────────────────────────────────────────────────────────
describe('strict enforcement — a gov token clamps the local opt-out (§4.3)', () => {
  const secretFinding = { type: 'security_leak', severity: 'critical', route: '/x', message: `key ${ANTH}` };
  it('ARGUS_REDACT_SENSITIVE=0 is IGNORED while a gov token is present', () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    expect(governanceOptOutClamped()).toBe(true); // token set ⇒ clamped
    const out = redactForEgress([secretFinding])[0];
    expect(out.message).toBe(REDACT_MARKER);       // still redacted despite opt-out
    expect(JSON.stringify(out)).not.toContain(ANTH);
  });
  it('the clamp lifts the moment the token is removed (byte-identical opt-out)', () => {
    delete process.env.ARGUS_GOV_TOKEN;
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    expect(governanceOptOutClamped()).toBe(false);
    expect(redactForEgress([secretFinding])).toEqual([secretFinding]); // raw passthrough
  });
});

// ── NO-LEAK AGGREGATE POST ────────────────────────────────────────────────────
describe('postRedactionAggregate — secret-free by construction', () => {
  it('posts only label counts + coarse meta; no secret substring in the body', async () => {
    process.env.ARGUS_REDACT_AUDIT_URL = AUDIT_URL;
    let capturedBody = null;
    let capturedAuth = null;
    const fetchImpl = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      capturedAuth = opts.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    // A byReason map whose LABEL is (pathologically) tainted with a secret + a real one.
    const summary = { total: 5, redacted: 3, byReason: { 'secret:jwt': 2, 'pii:email': 1, [`tok ${ANTH}`]: 1 } };
    const res = await postRedactionAggregate(summary, { fetchImpl, meta: { runRef: `error-report ${EMAIL}.json` } });

    expect(res.posted).toBe(true);
    const wire = JSON.stringify(capturedBody);
    expect(wire).not.toContain(ANTH);   // tainted label scrubbed
    expect(wire).not.toContain(EMAIL);  // scrubbed from meta.runRef too
    expect(capturedBody.byReason['secret:jwt']).toBe(2);
    expect(capturedBody.byReason['pii:email']).toBe(1);
    expect(capturedBody.total).toBe(5);
    expect(capturedBody.redacted).toBe(3);
    expect(capturedAuth).toBe('Bearer gov_test_token_123');
  });

  it('is a no-op (not-configured) when no audit URL is set — never throws', async () => {
    const res = await postRedactionAggregate({ total: 1, redacted: 1, byReason: { 'secret:jwt': 1 } }, { fetchImpl: fetchThrowing() });
    expect(res.posted).toBe(false);
    expect(res.reason).toBe('not-configured');
  });

  it('a POST failure is swallowed (best-effort, never blocks the run)', async () => {
    process.env.ARGUS_REDACT_AUDIT_URL = AUDIT_URL;
    const res = await postRedactionAggregate({ total: 1, redacted: 1, byReason: {} }, { fetchImpl: fetchThrowing('network down') });
    expect(res.posted).toBe(false);
    expect(res.reason).toMatch(/network down/);
  });
});

// ── TTL CACHE ─────────────────────────────────────────────────────────────────
describe('TTL cache — at most one fetch per window', () => {
  it('a second call within TTL does NOT re-fetch; expiry re-fetches', async () => {
    process.env.ARGUS_REDACT_POLICY_TTL_MS = '1000';
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => signedPayload() }; };

    let t = 10_000;
    const now = () => t;
    await ensureGovernancePolicy({ fetchImpl, now });   // fetch #1
    await ensureGovernancePolicy({ fetchImpl, now });   // cached
    t += 500;
    await ensureGovernancePolicy({ fetchImpl, now });   // still fresh
    expect(calls).toBe(1);

    t += 600; // now 900ms past → beyond the 1000ms? 500+600=1100 > 1000 ⇒ expired
    await ensureGovernancePolicy({ fetchImpl, now });   // fetch #2
    expect(calls).toBe(2);
  });

  it('a failed fetch is also cached for the window (does not hammer the endpoint)', async () => {
    process.env.ARGUS_REDACT_POLICY_TTL_MS = '5000';
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('down'); };
    let t = 0;
    const now = () => t;
    await ensureGovernancePolicy({ fetchImpl, now });
    t += 100;
    await ensureGovernancePolicy({ fetchImpl, now });
    expect(calls).toBe(1);              // negative result cached
    expect(effectivePolicyOpts({})).toBe(null); // still strict floor
  });
});
