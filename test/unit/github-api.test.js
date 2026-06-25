import { describe, it, expect } from 'vitest';
import {
  headerValue, scrubSecrets, isRateLimitResponse, retryDelayMs,
  classifyGitHubError, githubFetch,
} from '../../src/utils/github-api.js';

const TOKEN = 'ghp_supersecret_value_1234567890';
const noSleep = async () => {};

/** Build a Response-like stub for the injected fetch. */
function res(body, { status = 200, ok = status >= 200 && status < 300, statusText = 'OK', headers } = {}) {
  return {
    ok, status, statusText,
    headers,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('headerValue', () => {
  it('reads from a Headers object (.get) case-insensitively', () => {
    const h = new Map([['retry-after', '7']]);
    expect(headerValue(h, 'Retry-After')).toBe('7');
    expect(headerValue(h, 'retry-after')).toBe('7');
  });
  it('reads from a plain object case-insensitively', () => {
    expect(headerValue({ 'X-RateLimit-Remaining': '0' }, 'x-ratelimit-remaining')).toBe('0');
  });
  it('returns undefined for a missing/absent headers bag', () => {
    expect(headerValue(undefined, 'retry-after')).toBeUndefined();
    expect(headerValue({}, 'retry-after')).toBeUndefined();
  });
});

describe('scrubSecrets', () => {
  it('redacts Bearer, ghp_, and github_pat_ tokens', () => {
    expect(scrubSecrets(`Authorization: Bearer ${TOKEN}`)).toBe('Authorization: Bearer ***');
    expect(scrubSecrets(`leaked ${TOKEN} here`)).toBe('leaked *** here');
    expect(scrubSecrets('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz')).toBe('***');
  });
  it('leaves non-secret text intact', () => {
    expect(scrubSecrets('API rate limit exceeded')).toBe('API rate limit exceeded');
  });
});

describe('isRateLimitResponse', () => {
  it('classifies 429 as a rate-limit', () => {
    expect(isRateLimitResponse(429, {})).toBe(true);
  });
  it('classifies a 403 primary rate-limit (X-RateLimit-Remaining: 0)', () => {
    expect(isRateLimitResponse(403, { 'x-ratelimit-remaining': '0' })).toBe(true);
  });
  it('classifies a 403 secondary rate-limit (Retry-After present)', () => {
    expect(isRateLimitResponse(403, { 'retry-after': '30' })).toBe(true);
  });
  it('does NOT classify a plain 403 (permissions) or a 404 as a rate-limit', () => {
    expect(isRateLimitResponse(403, {})).toBe(false);
    expect(isRateLimitResponse(403, { 'x-ratelimit-remaining': '17' })).toBe(false);
    expect(isRateLimitResponse(404, {})).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After (seconds → ms), capped at maxMs', () => {
    expect(retryDelayMs(429, { 'retry-after': '3' }, 1, { maxMs: 8000 })).toBe(3000);
    expect(retryDelayMs(429, { 'retry-after': '999' }, 1, { maxMs: 8000 })).toBe(8000);
  });
  it('honours X-RateLimit-Reset (epoch s) relative to now(), capped', () => {
    const now = () => 1_000_000_000_000;          // fixed clock
    const reset = 1_000_000_002;                   // +2s from now
    expect(retryDelayMs(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, 1, { now, maxMs: 8000 }))
      .toBe(2000);
  });
  it('falls back to exponential backoff (base·2^(attempt-1)), capped', () => {
    expect(retryDelayMs(500, {}, 1, { baseMs: 1000, maxMs: 8000 })).toBe(1000);
    expect(retryDelayMs(500, {}, 2, { baseMs: 1000, maxMs: 8000 })).toBe(2000);
    expect(retryDelayMs(500, {}, 9, { baseMs: 1000, maxMs: 8000 })).toBe(8000); // capped
  });
});

describe('classifyGitHubError', () => {
  it('carries the cause for 401/404/422 and is secret-free', () => {
    expect(classifyGitHubError(401, 'Unauthorized', 'Bad credentials', 'GET /x'))
      .toContain('401 (bad credentials)');
    expect(classifyGitHubError(404, 'Not Found', 'Not Found', 'GET /x')).toContain('404 (not found)');
    const e422 = classifyGitHubError(422, 'Unprocessable', 'Validation failed', 'POST /y');
    expect(e422).toContain('422 (unprocessable)');
    expect(e422).toContain('Validation failed');
  });
  it('redacts a token that somehow appears in the body', () => {
    const msg = classifyGitHubError(404, 'Not Found', `debug Bearer ${TOKEN}`, 'GET /x');
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('Bearer ***');
  });
});

describe('githubFetch — happy path', () => {
  it('returns the OK Response without retrying', async () => {
    let calls = 0;
    const r = await githubFetch('https://api.github.com/x', {
      sleep: noSleep,
      fetchImpl: async () => { calls++; return res({ ok: 1 }); },
    });
    expect(calls).toBe(1);
    expect(await r.json()).toEqual({ ok: 1 });
  });
});

describe('githubFetch — retries (resilience)', () => {
  it('retries a 403 PRIMARY rate-limit (Remaining: 0) then succeeds', async () => {
    let calls = 0;
    const r = await githubFetch('https://api.github.com/x', {
      sleep: noSleep,
      fetchImpl: async () => {
        calls++;
        return calls < 3
          ? res('rate limited', { status: 403, ok: false, headers: { 'x-ratelimit-remaining': '0' } })
          : res({ ok: 1 });
      },
    });
    expect(calls).toBe(3);
    expect(await r.json()).toEqual({ ok: 1 });
  });

  it('retries a 429 secondary rate-limit then succeeds', async () => {
    let calls = 0;
    await githubFetch('https://api.github.com/x', {
      sleep: noSleep,
      fetchImpl: async () => {
        calls++;
        return calls < 2 ? res('slow down', { status: 429, ok: false, headers: { 'retry-after': '1' } }) : res({});
      },
    });
    expect(calls).toBe(2);
  });

  it('retries a transient 5xx then succeeds', async () => {
    let calls = 0;
    await githubFetch('https://api.github.com/x', {
      sleep: noSleep,
      fetchImpl: async () => { calls++; return calls < 2 ? res('bad gateway', { status: 502, ok: false }) : res({}); },
    });
    expect(calls).toBe(2);
  });

  it('retries a network error then succeeds', async () => {
    let calls = 0;
    await githubFetch('https://api.github.com/x', {
      sleep: noSleep,
      fetchImpl: async () => { calls++; if (calls < 2) throw new Error('ECONNRESET'); return res({}); },
    });
    expect(calls).toBe(2);
  });
});

describe('githubFetch — terminal errors (no retry, secret-free)', () => {
  it('does NOT retry a 404 — throws after exactly one call, message carries the cause, never the token', async () => {
    let calls = 0;
    let err;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep,
        context: 'GET /repos/o/r/pulls/7/files',
        fetchImpl: async () => { calls++; return res('Not Found', { status: 404, ok: false, statusText: 'Not Found' }); },
      });
    } catch (e) { err = e; }
    expect(calls).toBe(1);
    expect(err.message).toContain('404 (not found)');
    expect(err.message).toContain('GET /repos/o/r/pulls/7/files');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('is not defined');
  });

  it('does NOT retry a 422 — throws a structured error', async () => {
    let calls = 0;
    let err;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep,
        fetchImpl: async () => { calls++; return res('Validation Failed', { status: 422, ok: false }); },
      });
    } catch (e) { err = e; }
    expect(calls).toBe(1);
    expect(err.message).toContain('422 (unprocessable)');
  });

  it('does NOT retry a plain 403 (permissions) — treated as forbidden, not rate-limit', async () => {
    let calls = 0;
    let err;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep,
        fetchImpl: async () => { calls++; return res('Resource not accessible', { status: 403, ok: false }); },
      });
    } catch (e) { err = e; }
    expect(calls).toBe(1);
    expect(err.message).toContain('403 (forbidden)');
  });

  it('throws after exhausting retries on a persistent rate-limit (bounded call count)', async () => {
    let calls = 0;
    let err;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep, maxAttempts: 3,
        fetchImpl: async () => { calls++; return res('API rate limit exceeded', { status: 429, ok: false }); },
      });
    } catch (e) { err = e; }
    expect(calls).toBe(3);                                   // maxAttempts, never unbounded
    expect(err.message).toContain('rate limit exceeded');
    expect(err.message).toContain('retries exhausted');
  });

  it('never leaks a token even when the response body echoes one', async () => {
    let err;
    try {
      await githubFetch('https://api.github.com/x', {
        sleep: noSleep,
        fetchImpl: async () => res(`internal debug Authorization: Bearer ${TOKEN}`, { status: 422, ok: false }),
      });
    } catch (e) { err = e; }
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('Bearer ***');
  });
});
