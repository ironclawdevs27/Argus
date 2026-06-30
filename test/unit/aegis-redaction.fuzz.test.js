/**
 * Aegis — redaction fuzz invariant (Vitest + fast-check, Chrome-free).
 *
 * THE core safety property, proven over thousands of generated inputs rather
 * than a handful of hand cases:
 *
 *   For all strings, every span findSensitiveSpans() reports is ABSENT from
 *   scrubText() output — and from redactForEgress() output — verbatim.
 *
 * Plus the structural guarantees: scrubText never throws and is idempotent;
 * redactForEgress never throws, never emits a key outside the allowlist, and
 * never leaks a generated secret embedded in ANY field (including an unknown one).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { findSensitiveSpans, scrubText } from '../../src/utils/secret-patterns.js';
import { redactForEgress, EGRESS_ALLOWLIST } from '../../src/utils/sensitivity-classifier.js';

const RUNS = { numRuns: 500 };
const ALLOWED_OUT_KEYS = new Set([...EGRESS_ALLOWLIST, 'detail', 'message']);

// ── Generators for real-shaped secrets ──────────────────────────────────────
const chars = (set, min, max) =>
  fc.array(fc.constantFrom(...set.split('')), { minLength: min, maxLength: max }).map((a) => a.join(''));
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPERNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const secretGen = fc.oneof(
  // JWT (three base64url parts).
  fc.tuple(chars(B64URL, 10, 20), chars(B64URL, 8, 20), chars(B64URL, 20, 40))
    .map(([a, b, c]) => `eyJ${a}.${b}.${c}`),
  chars(ALNUM, 28, 40).map((s) => `sk-ant-api03-${s}`),
  chars(ALNUM, 24, 40).map((s) => `sk-proj-${s}`),
  chars(UPPERNUM, 16, 16).map((s) => `AKIA${s}`),
  chars(ALNUM, 24, 40).map((s) => `ghp_${s}`),
  // High-entropy bare blob (caught by Layer 3).
  chars(B64URL, 28, 44),
);

// A document mixing plain words with embedded secrets — spans are guaranteed.
const wordGen = chars('abcdefghijklmnopqrstuvwxyz ', 1, 12).map((w) => w.trim() || 'x');
const docGen = fc.tuple(
  fc.array(fc.oneof(wordGen, secretGen), { minLength: 1, maxLength: 6 }),
  secretGen,
  fc.array(fc.oneof(wordGen, secretGen), { minLength: 0, maxLength: 4 }),
).map(([pre, mid, post]) => [...pre, mid, ...post].join(' '));

describe('fuzz — scrubText removes every reported span', () => {
  it('no reported span survives scrubText (mask) verbatim', () => {
    fc.assert(fc.property(docGen, (s) => {
      const spans = findSensitiveSpans(s);
      const scrubbed = scrubText(s, { mode: 'mask' });
      for (const sp of spans) {
        const secret = s.slice(sp.start, sp.end);
        expect(scrubbed.includes(secret)).toBe(false);
      }
    }), RUNS);
  });

  it('holds for label and drop modes too', () => {
    fc.assert(fc.property(docGen, fc.constantFrom('label', 'drop', 'hash'), (s, mode) => {
      const spans = findSensitiveSpans(s);
      const scrubbed = scrubText(s, { mode });
      for (const sp of spans) {
        expect(scrubbed.includes(s.slice(sp.start, sp.end))).toBe(false);
      }
    }), RUNS);
  });

  it('scrubText never throws and is idempotent for ANY input', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const once = scrubText(s, { mode: 'mask' });
      expect(typeof once).toBe('string');
      expect(scrubText(once, { mode: 'mask' })).toBe(once);
    }), RUNS);
  });

  it('mask never lengthens', () => {
    fc.assert(fc.property(docGen, (s) => {
      expect(scrubText(s, { mode: 'mask' }).length).toBeLessThanOrEqual(s.length);
    }), RUNS);
  });
});

describe('fuzz — redactForEgress never leaks a generated secret', () => {
  it('a secret embedded in message/evidence/url/unknown field never crosses', () => {
    fc.assert(fc.property(secretGen, fc.constantFrom('message', 'evidence', 'payload', 'futureField', 'note'), (secret, field) => {
      const finding = { type: 'security_no_https', severity: 'critical', url: 'http://app.internal/login', [field]: `value ${secret} end` };
      const out = redactForEgress([finding]);
      const json = JSON.stringify(out);
      expect(json.includes(secret), `secret leaked via ${field}`).toBe(false);
    }), RUNS);
  });

  it('a secret in a query string never crosses (url sanitised)', () => {
    fc.assert(fc.property(secretGen, (secret) => {
      const finding = { type: 'security_token_in_url', severity: 'critical', url: `http://app.internal/cb?token=${secret}`, message: 'token in url' };
      expect(JSON.stringify(redactForEgress([finding])).includes(secret)).toBe(false);
    }), RUNS);
  });

  it('output keys are always within the allowlist; never throws', () => {
    fc.assert(fc.property(
      fc.record({
        type: fc.string(), severity: fc.constantFrom('critical', 'warning', 'info'),
        message: fc.string(), url: fc.webUrl(), randomField: fc.string(),
        value: fc.oneof(fc.string(), fc.integer()),
      }),
      (finding) => {
        const out = redactForEgress([finding]);
        expect(Array.isArray(out)).toBe(true);
        for (const k of Object.keys(out[0])) {
          expect(ALLOWED_OUT_KEYS.has(k), `leaked key ${k}`).toBe(true);
        }
      },
    ), RUNS);
  });
});

describe('fuzz — the generator actually produces spans (non-vacuity guard)', () => {
  it('docGen embeds at least one detectable span in the common case', () => {
    let withSpans = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const s = fc.sample(docGen, 1)[0];
      if (findSensitiveSpans(s).length > 0) withSpans++;
    }
    expect(withSpans).toBeGreaterThan(N * 0.8); // the invariant is exercised, not vacuous
  });
});
