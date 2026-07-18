/**
 * Aegis Step 1 — secret-patterns.js unit suite (Chrome-free).
 *
 * Proves each SECRET_RULES / PII_RULES entry with a POSITIVE fixture AND a
 * NEGATIVE control (UUID, CSS-module hash, example.com, test@test, long hex),
 * the Luhn + Shannon primitives, the scrubText invariants (idempotent, never
 * lengthens under mask, full secret never survives), and that the GitHub-only
 * scrubSecrets re-export is intact (github-api.js stays byte-unchanged).
 *
 * Detection here FAILS CLOSED: over-detection (a false positive) is acceptable;
 * a missed secret is not. The negative controls below therefore prove PRECISION
 * (no over-fire on the classic FP shapes), not a relaxation of that posture.
 */

import { describe, it, expect } from 'vitest';
import {
  SECRET_RULES, PII_RULES, CONTEXT_WORDS,
  shannonEntropy, luhnValid, isStatisticallyRare,
  findSensitiveSpans, scrubText, mergeSpans,
  scrubSecrets, setTokenizer, tokenEfficiency, setVaultTokenizer,
} from '../../src/utils/secret-patterns.js';

// Real-shaped positives (documented example credentials, not live secrets).
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
// Synthetic Google API key — assembled from fragments so no full-format literal ever
// sits in source (GitHub secret scanning matches static text, not runtime values).
// Still matches the detector regex /\bAIza[0-9A-Za-z_-]{35}\b/ at runtime, so the test
// exercises the real google_api_key rule.
const GOOGLE_KEY = 'AIza' + 'SyFAKEKEYFORTESTSONLY'.padEnd(35, '0');

const SECRET_POSITIVES = {
  jwt: JWT,
  anthropic_key: 'sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx',
  openai_key: 'sk-proj-abcdef1234567890ABCDEFGHIJklmno',
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  google_api_key: GOOGLE_KEY,
  slack_token: 'xoxb-EXAMPLE-PLACEHOLDER-slack-token',
  github_pat: 'github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz1234567890ABCD',
  github_token: 'ghp_1234567890abcdefghijABCDEFGHIJ',
  private_key_pem: '-----BEGIN RSA PRIVATE KEY-----',
  bearer: 'Authorization: Bearer abcDEF123456_tokenXYZ',
  basic_auth_url: 'https://admin:s3cr3tpass@example.com/admin',
  generic_assignment: 'password=Sup3rSecretValue',
};

// The exact secret substring that must NEVER survive an egress scrub.
const SECRET_VALUE = {
  jwt: JWT,
  anthropic_key: 'sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx',
  openai_key: 'sk-proj-abcdef1234567890ABCDEFGHIJklmno',
  aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  google_api_key: GOOGLE_KEY,
  slack_token: 'xoxb-EXAMPLE-PLACEHOLDER-slack-token',
  github_pat: 'github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz1234567890ABCD',
  github_token: 'ghp_1234567890abcdefghijABCDEFGHIJ',
  bearer: 'abcDEF123456_tokenXYZ',
  basic_auth_url: 'admin:s3cr3tpass',
  generic_assignment: 'Sup3rSecretValue',
};

// Pure negative controls — the classic false-positive shapes. NONE may produce a span.
const NEGATIVE_CONTROLS = {
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  css_module_hash: 'header_logo__2Kd9f',
  example_domain: 'example.com',
  test_email_shape: 'test@test',
  short_hex: 'a3f5e8c9b2d1',
  plain_word: 'documentation',
};

describe('SECRET_RULES — regex layer fires on each positive in isolation', () => {
  for (const rule of SECRET_RULES) {
    it(`${rule.name} matches its positive fixture`, () => {
      const fixture = SECRET_POSITIVES[rule.name];
      expect(fixture, `no positive fixture for rule ${rule.name}`).toBeTypeOf('string');
      rule.regex.lastIndex = 0;
      expect(rule.regex.test(fixture), `${rule.name} regex did not match`).toBe(true);
    });
  }
});

describe('Each secret positive is detected AND fully scrubbed', () => {
  for (const [name, fixture] of Object.entries(SECRET_POSITIVES)) {
    it(`${name}: findSensitiveSpans non-empty and value gone after scrub`, () => {
      const wrapped = `prefix ${fixture} suffix`;
      const spans = findSensitiveSpans(wrapped);
      expect(spans.length, `${name} produced no span`).toBeGreaterThan(0);
      const value = SECRET_VALUE[name];
      const scrubbed = scrubText(wrapped, { mode: 'mask' });
      expect(scrubbed.includes(value), `${name} value survived mask scrub`).toBe(false);
      // label / drop modes must also fully remove it.
      expect(scrubText(wrapped, { mode: 'label' }).includes(value)).toBe(false);
      expect(scrubText(wrapped, { mode: 'drop' }).includes(value)).toBe(false);
    });
  }
});

describe('PII_RULES — positive detection', () => {
  it('email is detected', () => {
    const spans = findSensitiveSpans('contact alice.smith@corp.example.org now');
    expect(spans.some((s) => s.kind === 'pii' && s.name === 'email')).toBe(true);
  });
  it('Luhn-valid credit card is detected; Luhn-invalid is NOT (by the card rule)', () => {
    const valid = findSensitiveSpans('card 4111 1111 1111 1111 on file');
    expect(valid.some((s) => s.name === 'credit_card')).toBe(true);
    const cardRule = PII_RULES.find((r) => r.name === 'credit_card');
    // The card rule's own validate gate rejects a non-Luhn 16-digit string.
    expect(cardRule.validate('4111111111111112')).toBe(false);
  });
  it('US SSN shape is detected', () => {
    expect(findSensitiveSpans('ssn 123-45-6789').some((s) => s.name === 'ssn_us')).toBe(true);
  });
  it('private host + E.164 phone are detected', () => {
    expect(findSensitiveSpans('host app.internal down').some((s) => s.name === 'private_host')).toBe(true);
    expect(findSensitiveSpans('call +14155552671 asap').some((s) => s.name === 'phone_e164')).toBe(true);
  });
});

describe('Negative controls — no over-fire on classic FP shapes', () => {
  for (const [label, value] of Object.entries(NEGATIVE_CONTROLS)) {
    it(`${label} (${value}) produces zero spans`, () => {
      expect(findSensitiveSpans(value)).toEqual([]);
    });
    it(`${label} matches no SECRET_RULES regex`, () => {
      for (const rule of SECRET_RULES) {
        rule.regex.lastIndex = 0;
        expect(rule.regex.test(value), `${label} unexpectedly matched ${rule.name}`).toBe(false);
      }
    });
  }
});

describe('luhnValid truth table', () => {
  it('accepts valid card-length numbers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4012 8888 8888 1881')).toBe(true); // Visa test, with spaces
    expect(luhnValid('5555-5555-5555-4444')).toBe(true); // Mastercard test, hyphens
  });
  it('rejects non-Luhn and out-of-length inputs', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234567890123456')).toBe(false);
    expect(luhnValid('49927398716')).toBe(false);   // valid Luhn but <13 digits ⇒ not a card
    expect(luhnValid('not-a-number')).toBe(false);
    expect(luhnValid('')).toBe(false);
    expect(luhnValid(null)).toBe(false);
  });
});

describe('shannonEntropy boundaries', () => {
  it('is 0 for empty / single-symbol strings and rises with diversity', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1, 5);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 5);
    expect(shannonEntropy('Tr0ub4dor&3xPl0it!')).toBeGreaterThan(3);
  });
});

describe('isStatisticallyRare gating', () => {
  it('skips canonical UUIDs and short/low-diversity tokens', () => {
    expect(isStatisticallyRare('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isStatisticallyRare('shortone')).toBe(false);          // 8 chars, no context
    expect(isStatisticallyRare('aaaaaaaaaaaaaaaaaaaa')).toBe(false); // no charset diversity
  });
  it('flags a long high-entropy mixed-charset token', () => {
    expect(isStatisticallyRare('aG7xQ2mZ9pL4kR8vT1wY6nB3cF5dH0jS')).toBe(true);
  });
  it('positive context lowers the length bar', () => {
    // 12-char token: not flagged bare, flagged when context says it is positive.
    expect(isStatisticallyRare('aG7xQ2mZ9pL4', { positiveContext: false })).toBe(false);
    expect(isStatisticallyRare('aG7xQ2mZ9pL4', { positiveContext: true })).toBe(true);
  });
});

describe('scrubText invariants', () => {
  const corpus = [
    `Bearer ${JWT}`,
    'login admin:hunter2pass@10.0.0.5/dash and key sk-proj-abcdef1234567890ABCDEFGHIJklmno',
    'email bob@example.org card 4111111111111111 ssn 123-45-6789',
    'no secrets here, just ordinary prose about alt text and headings',
  ];
  it('is idempotent: scrub(scrub(x)) === scrub(x)', () => {
    for (const x of corpus) {
      const once = scrubText(x, { mode: 'mask' });
      expect(scrubText(once, { mode: 'mask' })).toBe(once);
    }
  });
  it('mask never lengthens the input', () => {
    for (const x of corpus) {
      expect(scrubText(x, { mode: 'mask' }).length).toBeLessThanOrEqual(x.length);
    }
  });
  it('leaves clean prose untouched', () => {
    const clean = 'no secrets here, just ordinary prose about alt text and headings';
    expect(scrubText(clean)).toBe(clean);
  });
  it('mergeSpans coalesces overlaps', () => {
    const merged = mergeSpans([
      { start: 0, end: 10, kind: 'secret', name: 'a' },
      { start: 5, end: 20, kind: 'entropy', name: 'b' },
      { start: 30, end: 35, kind: 'pii', name: 'c' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ start: 0, end: 20 });
  });
});

describe('Token Efficiency seam falls back to entropy when no tokenizer', () => {
  it('tokenEfficiency returns null with no injected tokenizer', () => {
    expect(tokenEfficiency('anystring')).toBeNull();
  });
  it('an injected tokenizer flips Layer 3 to efficiency, then reverts', () => {
    // Fake tokenizer: 1 token per char ⇒ efficiency 1.0 (< floor) ⇒ rare.
    setTokenizer((s) => s.split(''));
    try {
      expect(tokenEfficiency('hello')).toBeCloseTo(1, 5);
      expect(isStatisticallyRare('lowercaseonlytoken12', { positiveContext: false })).toBe(true);
    } finally {
      setTokenizer(null);
    }
    expect(tokenEfficiency('hello')).toBeNull();
  });
});

describe('scrubText token mode + setVaultTokenizer seam (Aegis Step 8)', () => {
  const SECRET = 'Bearer sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx';

  it('token mode with NO vault wired falls back to mask — never emits the raw value', () => {
    setVaultTokenizer(null);
    const out = scrubText(SECRET, { mode: 'token' });
    expect(out).not.toContain('sk-ant-api03-abcdefghij1234567890ABCDqrstuvwx');
    expect(out).not.toMatch(/AEGIS_/);
    expect(out).toContain('█'); // masked (fail-closed)
  });

  it('an injected vault tokenizer turns matched spans into its token, then reverts', () => {
    const calls = [];
    setVaultTokenizer((v) => { calls.push(v); return 'AEGIS_deadbeef00000000'; });
    try {
      const out = scrubText(SECRET, { mode: 'token' });
      expect(out).toContain('AEGIS_deadbeef00000000');
      expect(out).not.toContain('abcdefghij1234567890'); // raw token span replaced
      expect(calls.length).toBeGreaterThan(0);            // the span was handed to the vault
    } finally {
      setVaultTokenizer(null);
    }
    // Reverted ⇒ token mode masks again.
    expect(scrubText(SECRET, { mode: 'token' })).toMatch(/█/);
  });

  it('a throwing tokenizer fails CLOSED to mask (never raw)', () => {
    setVaultTokenizer(() => { throw new Error('vault down'); });
    try {
      const out = scrubText(SECRET, { mode: 'token' });
      expect(out).not.toContain('abcdefghij1234567890');
      expect(out).not.toMatch(/AEGIS_/);
      expect(out).toContain('█');
    } finally {
      setVaultTokenizer(null);
    }
  });
});

describe('scrubSecrets re-export (github-api.js unchanged)', () => {
  it('redacts GitHub token shapes', () => {
    expect(scrubSecrets('Bearer ghp_123456789012345678')).toBe('Bearer ***');
    expect(scrubSecrets('token github_pat_ABCDEFGHIJKLMNOPQRSTUV')).toBe('token ***');
  });
  it('CONTEXT_WORDS exports both polarities', () => {
    expect(CONTEXT_WORDS.positive).toContain('token');
    expect(CONTEXT_WORDS.negative).toContain('example');
  });
});
