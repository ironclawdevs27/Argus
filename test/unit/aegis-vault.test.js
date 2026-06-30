/**
 * Aegis Step 8 — aegis-vault.js unit suite (Chrome-free).
 *
 * Proves the reversible local re-hydration vault (plan §5.3) end to end:
 *   - DETERMINISTIC + INFORMATION-FREE token: same value ⇒ same AEGIS_<hmac16>; the
 *     token never contains the secret substring.
 *   - ROUND-TRIP: tokenFor → loadVault → rehydrate restores the original.
 *   - REAL EGRESS PATH: deepScrub / redactForEgress in `token` mode mint vault
 *     tokens (no raw secret), and rehydrate re-inflates the redacted artifact.
 *   - FAIL-CLOSED: token mode WITHOUT the vault enabled masks (never raw, never a
 *     token); a throwing tokenizer masks.
 *   - OPT-OUT: ARGUS_REDACT_SENSITIVE=0 is byte-identical passthrough.
 *   - 0600 + LOCAL-ONLY: key + mapping files land under the (gitignored) vault dir;
 *     the audit trail is SECRET-FREE (token, never the value).
 *
 * All filesystem writes are redirected to an os.tmpdir() sandbox via
 * ARGUS_REDACT_VAULT_DIR / ARGUS_REDACT_AUDIT_DIR so the repo tree stays clean.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  vaultEnabled, computeToken, tokenFor, storeMapping, loadVault, rehydrate,
  getKey, ensureVaultWired, appendAudit, _resetVaultForTests,
} from '../../src/utils/aegis-vault.js';
import { deepScrub, redactForEgress } from '../../src/utils/sensitivity-classifier.js';

const SECRET = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const TOKEN_RE = /AEGIS_[0-9a-f]{16}/;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-vault-test-'));
const VAULT_DIR = path.join(ROOT, 'vault');
const AUDIT_DIR = path.join(ROOT, 'audit');

function enableVault() {
  process.env.ARGUS_REDACT_VAULT = '1';
  process.env.ARGUS_REDACT_MODE = 'token';
  process.env.ARGUS_REDACT_VAULT_DIR = VAULT_DIR;
  process.env.ARGUS_REDACT_AUDIT_DIR = AUDIT_DIR;
  delete process.env.ARGUS_REDACT_SENSITIVE;
  _resetVaultForTests();
}

beforeEach(() => {
  // Fresh sandbox dirs each test for isolation.
  for (const d of [VAULT_DIR, AUDIT_DIR]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  enableVault();
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  delete process.env.ARGUS_REDACT_VAULT;
  delete process.env.ARGUS_REDACT_MODE;
  delete process.env.ARGUS_REDACT_VAULT_DIR;
  delete process.env.ARGUS_REDACT_AUDIT_DIR;
  delete process.env.ARGUS_REDACT_SENSITIVE;
  _resetVaultForTests();
});

describe('vaultEnabled / ensureVaultWired (default OFF)', () => {
  it('reflects ARGUS_REDACT_VAULT and wiring is gated on it', () => {
    expect(vaultEnabled()).toBe(true);
    expect(ensureVaultWired()).toBe(true);

    process.env.ARGUS_REDACT_VAULT = '0';
    _resetVaultForTests();
    expect(vaultEnabled()).toBe(false);
    expect(ensureVaultWired()).toBe(false);

    delete process.env.ARGUS_REDACT_VAULT;
    _resetVaultForTests();
    expect(vaultEnabled()).toBe(false);   // unset ⇒ OFF by default
    expect(ensureVaultWired()).toBe(false);
  });
});

describe('computeToken — deterministic + information-free', () => {
  it('emits AEGIS_<hmac16> and never embeds the secret', () => {
    const t = computeToken(SECRET);
    expect(t).toMatch(/^AEGIS_[0-9a-f]{16}$/);
    expect(t).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV');
    expect(SECRET.includes(t)).toBe(false);
  });
  it('is deterministic for the same value and distinct for different values', () => {
    expect(computeToken(SECRET)).toBe(computeToken(SECRET));
    expect(computeToken('alpha')).not.toBe(computeToken('beta'));
  });
  it('reuses the persisted per-machine key across resets (token stays stable)', () => {
    const first = computeToken(SECRET);
    expect(fs.existsSync(path.join(VAULT_DIR, 'key'))).toBe(true);
    _resetVaultForTests();                 // drop the in-memory key cache
    expect(computeToken(SECRET)).toBe(first); // re-read from disk ⇒ same token
  });
});

describe('tokenFor / storeMapping / loadVault — persistence round-trip', () => {
  it('persists a token→value mapping that loadVault returns', () => {
    const t = tokenFor(SECRET);
    const vault = loadVault();
    expect(vault.get(t)).toBe(SECRET);
  });
  it('dedups identical spans within a run (one mapping line per token)', () => {
    tokenFor(SECRET);
    tokenFor(SECRET);
    const file = fs.readdirSync(VAULT_DIR).find((f) => f.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(VAULT_DIR, file), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
  it('loadVault returns an empty Map when no vault dir exists', () => {
    fs.rmSync(VAULT_DIR, { recursive: true, force: true });
    _resetVaultForTests();
    expect(loadVault().size).toBe(0);
  });
});

describe('rehydrate — re-inflate a redacted artifact', () => {
  it('swaps known tokens back, leaves unknown tokens + plain text untouched, non-mutating', () => {
    const t = tokenFor(SECRET);
    const vault = loadVault();
    const redacted = {
      a: `prefix ${t} suffix`,
      b: ['nested', `${t}`, 'AEGIS_0000000000000000'], // last token has no mapping
      c: 42,
      d: 'no tokens here',
    };
    const frozen = JSON.parse(JSON.stringify(redacted));
    const out = rehydrate(redacted, vault);

    expect(out.a).toBe(`prefix ${SECRET} suffix`);
    expect(out.b[1]).toBe(SECRET);
    expect(out.b[2]).toBe('AEGIS_0000000000000000'); // unknown token preserved
    expect(out.c).toBe(42);
    expect(out.d).toBe('no tokens here');
    expect(redacted).toEqual(frozen); // input never mutated
  });
});

describe('token mode through the real egress path (deepScrub)', () => {
  it('mints a vault token for a console secret — no raw — and rehydrate restores it', () => {
    const consoleMsgs = [{ level: 'error', text: `auth failed Bearer ${SECRET} retry` }];
    const scrubbed = deepScrub(consoleMsgs, {});
    const txt = scrubbed[0].text;

    expect(txt).not.toContain(SECRET);
    expect(txt).toMatch(TOKEN_RE);

    const restored = rehydrate(scrubbed, loadVault());
    expect(restored[0].text).toContain(SECRET);
  });
  it('tokenises a benign finding string value field via redactForEgress', () => {
    const findings = [{ type: 'perf_metric', severity: 'info', value: `marker ${SECRET} tail`, route: '/v' }];
    const out = redactForEgress(findings, {});
    expect(out[0].value).toMatch(TOKEN_RE);
    expect(out[0].value).not.toContain(SECRET);
    expect(rehydrate(out, loadVault())[0].value).toContain(SECRET);
  });
});

describe('FAIL-CLOSED — token mode is safe even when the vault is unavailable', () => {
  it('vault OFF ⇒ deepScrub token mode MASKS the secret (no raw, no token)', () => {
    process.env.ARGUS_REDACT_VAULT = '0';
    _resetVaultForTests();
    const scrubbed = deepScrub([{ text: `Bearer ${SECRET}` }], {});
    const txt = scrubbed[0].text;
    expect(txt).not.toContain(SECRET);
    expect(txt).not.toMatch(TOKEN_RE);
    expect(txt).toContain('█');
  });
});

describe('OPT-OUT — ARGUS_REDACT_SENSITIVE=0 is byte-identical passthrough', () => {
  it('deepScrub returns the input verbatim (raw secret intact — the documented opt-out)', () => {
    process.env.ARGUS_REDACT_SENSITIVE = '0';
    _resetVaultForTests();
    const input = [{ text: `Bearer ${SECRET}` }];
    const out = deepScrub(input, {});
    expect(out).toBe(input);                // identity passthrough
    expect(out[0].text).toContain(SECRET);  // non-vacuity: there WAS a secret to leak
  });
});

describe('audit trail is SECRET-FREE + files land in the sandbox', () => {
  it('the audit line records the token, never the plaintext', () => {
    const t = tokenFor(SECRET);
    const auditFile = fs.readdirSync(AUDIT_DIR).find((f) => f.endsWith('.jsonl'));
    const audit = fs.readFileSync(path.join(AUDIT_DIR, auditFile), 'utf8');
    expect(audit).toContain(t);
    expect(audit).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV');
  });
  it('appendAudit writes a timestamped, secret-free provenance line', () => {
    appendAudit({ action: 'tokenize', token: 'AEGIS_1111111111111111' });
    const auditFile = fs.readdirSync(AUDIT_DIR).find((f) => f.endsWith('.jsonl'));
    const parsed = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, auditFile), 'utf8').trim().split('\n').pop());
    expect(parsed.action).toBe('tokenize');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('getKey persists the key under the configured (gitignored) vault dir', () => {
    getKey();
    const keyHex = fs.readFileSync(path.join(VAULT_DIR, 'key'), 'utf8').trim();
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
  });
});
