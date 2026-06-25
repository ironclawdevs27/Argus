import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeUrl,
  pickPreviewFromEnv,
  isPreviewDeployment,
  pickPreviewDeployment,
  previewUrlFromStatuses,
  fetchPreviewUrlFromDeployments,
  resolveTargetUrl,
} from '../../src/utils/deploy-preview.js';

// ── Recorded-shape GitHub Deployments + statuses (Vercel-style preview) ──────────
const PREVIEW_DEPLOYMENT = {
  id: 9911,
  environment: 'Preview – my-app',
  transient_environment: true,
  production_environment: false,
  ref: 'feature/x',
  sha: 'abc123',
};
const PRODUCTION_DEPLOYMENT = {
  id: 9900,
  environment: 'Production',
  production_environment: true,
  sha: 'abc123',
};
const SUCCESS_STATUS = {
  state: 'success',
  environment_url: 'https://my-app-git-feature-x.vercel.app',
  target_url: 'https://vercel.com/inspect/abc',
};
const FAILURE_STATUS = {
  state: 'failure',
  environment_url: 'https://broken-deploy.vercel.app',
  target_url: 'https://vercel.com/inspect/def',
};

describe('normalizeUrl', () => {
  it('accepts http(s) URLs and trims surrounding whitespace', () => {
    expect(normalizeUrl('https://x.com')).toBe('https://x.com');
    expect(normalizeUrl('  http://localhost:3000  ')).toBe('http://localhost:3000');
  });
  it('rejects non-http, empty, and nullish values', () => {
    expect(normalizeUrl('my-app.vercel.app')).toBeNull();   // no scheme
    expect(normalizeUrl('ftp://x')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
    expect(normalizeUrl(null)).toBeNull();
  });
});

describe('pickPreviewFromEnv', () => {
  it('returns ARGUS_PREVIEW_URL with a namespaced source', () => {
    expect(pickPreviewFromEnv({ ARGUS_PREVIEW_URL: 'https://pr-42.example.app' }))
      .toEqual({ url: 'https://pr-42.example.app', source: 'env:ARGUS_PREVIEW_URL' });
  });
  it('recognizes Netlify DEPLOY_PRIME_URL', () => {
    expect(pickPreviewFromEnv({ DEPLOY_PRIME_URL: 'https://deploy-preview-7--site.netlify.app' }))
      .toEqual({ url: 'https://deploy-preview-7--site.netlify.app', source: 'env:DEPLOY_PRIME_URL' });
  });
  it('normalizes Vercel VERCEL_URL (bare host → https://)', () => {
    expect(pickPreviewFromEnv({ VERCEL_URL: 'my-app-git-pr.vercel.app' }))
      .toEqual({ url: 'https://my-app-git-pr.vercel.app', source: 'env:VERCEL_URL' });
  });
  it('honours ARGUS_PREVIEW_URL precedence over provider vars', () => {
    const out = pickPreviewFromEnv({
      ARGUS_PREVIEW_URL: 'https://canonical.app',
      DEPLOY_PRIME_URL:  'https://netlify.app',
      VERCEL_URL:        'vercel.app',
    });
    expect(out.url).toBe('https://canonical.app');
    expect(out.source).toBe('env:ARGUS_PREVIEW_URL');
  });
  it('returns null when no recognized var is set or the value is invalid', () => {
    expect(pickPreviewFromEnv({})).toBeNull();
    expect(pickPreviewFromEnv({ ARGUS_PREVIEW_URL: '   ' })).toBeNull();
    expect(pickPreviewFromEnv({ ARGUS_PREVIEW_URL: 'not-a-url' })).toBeNull();   // no scheme
  });
});

describe('isPreviewDeployment', () => {
  it('recognizes a Vercel/Netlify preview environment', () => {
    expect(isPreviewDeployment(PREVIEW_DEPLOYMENT)).toBe(true);
    expect(isPreviewDeployment({ environment: 'deploy-preview' })).toBe(true);
    expect(isPreviewDeployment({ environment: 'qa', production_environment: false })).toBe(true);
    expect(isPreviewDeployment({ environment: 'qa', transient_environment: true })).toBe(true);
  });
  it('excludes production deployments', () => {
    expect(isPreviewDeployment(PRODUCTION_DEPLOYMENT)).toBe(false);
    expect(isPreviewDeployment({ environment: 'Production', production_environment: false })).toBe(false);
  });
  it('is null/garbage-safe', () => {
    expect(isPreviewDeployment(null)).toBe(false);
    expect(isPreviewDeployment(undefined)).toBe(false);
    expect(isPreviewDeployment('x')).toBe(false);
    expect(isPreviewDeployment({ environment: 'unknown' })).toBe(false);
  });
});

describe('pickPreviewDeployment', () => {
  it('returns the first (most recent) preview deployment, skipping production', () => {
    expect(pickPreviewDeployment([PRODUCTION_DEPLOYMENT, PREVIEW_DEPLOYMENT])).toBe(PREVIEW_DEPLOYMENT);
  });
  it('returns null when no preview qualifies / input is not an array', () => {
    expect(pickPreviewDeployment([PRODUCTION_DEPLOYMENT])).toBeNull();
    expect(pickPreviewDeployment([])).toBeNull();
    expect(pickPreviewDeployment(null)).toBeNull();
  });
});

describe('previewUrlFromStatuses', () => {
  it('returns the environment_url of the most recent success status', () => {
    expect(previewUrlFromStatuses([SUCCESS_STATUS])).toBe('https://my-app-git-feature-x.vercel.app');
  });
  it('falls back to target_url when environment_url is absent', () => {
    expect(previewUrlFromStatuses([{ state: 'success', target_url: 'https://live.app' }])).toBe('https://live.app');
  });
  it('NEVER adopts a non-success status (failed/pending/inactive deploy is not audited)', () => {
    expect(previewUrlFromStatuses([FAILURE_STATUS])).toBeNull();
    expect(previewUrlFromStatuses([{ state: 'pending', environment_url: 'https://pending.app' }])).toBeNull();
    expect(previewUrlFromStatuses([{ state: 'inactive', environment_url: 'https://stale.app' }])).toBeNull();
  });
  it('skips a success status with no usable URL, and is array-safe', () => {
    expect(previewUrlFromStatuses([{ state: 'success' }])).toBeNull();
    expect(previewUrlFromStatuses([])).toBeNull();
    expect(previewUrlFromStatuses(null)).toBeNull();
  });
  it('prefers the first success in newest-first order', () => {
    expect(previewUrlFromStatuses([FAILURE_STATUS, SUCCESS_STATUS])).toBe('https://my-app-git-feature-x.vercel.app');
  });
});

describe('fetchPreviewUrlFromDeployments (injected global fetch)', () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });

  const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

  it('resolves the preview environment_url via deployments → statuses', async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      if (/\/deployments\?sha=/.test(url)) return okJson([PRODUCTION_DEPLOYMENT, PREVIEW_DEPLOYMENT]);
      if (/\/deployments\/9911\/statuses/.test(url)) return okJson([SUCCESS_STATUS]);
      throw new Error(`unexpected url ${url}`);
    };
    const url = await fetchPreviewUrlFromDeployments({ owner: 'o', repo: 'r', sha: 'abc123', token: 't' });
    expect(url).toBe('https://my-app-git-feature-x.vercel.app');
    expect(seen[0]).toContain('/repos/o/r/deployments?sha=abc123');
    expect(seen[1]).toContain('/deployments/9911/statuses');
  });

  it('returns null (fail-safe) when no sha is provided — no fetch made', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return okJson([]); };
    expect(await fetchPreviewUrlFromDeployments({ owner: 'o', repo: 'r' })).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when the deployments call is non-2xx', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchPreviewUrlFromDeployments({ owner: 'o', repo: 'r', sha: 's' })).toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
    await expect(fetchPreviewUrlFromDeployments({ owner: 'o', repo: 'r', sha: 's' })).resolves.toBeNull();
  });

  it('returns null when the deploy status is a failure (not a success)', async () => {
    globalThis.fetch = async (url) => {
      if (/\/deployments\?sha=/.test(url)) return okJson([PREVIEW_DEPLOYMENT]);
      return okJson([FAILURE_STATUS]);
    };
    expect(await fetchPreviewUrlFromDeployments({ owner: 'o', repo: 'r', sha: 's', token: 't' })).toBeNull();
  });
});

describe('resolveTargetUrl', () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });

  it('default (nothing set) is byte-identical to TARGET_DEV_URL', async () => {
    expect(await resolveTargetUrl({ env: { TARGET_DEV_URL: 'http://localhost:3000' } }))
      .toEqual({ url: 'http://localhost:3000', source: 'target-dev-url' });
    // No TARGET_DEV_URL → the same localhost default as the pre-D3 code.
    expect(await resolveTargetUrl({ env: {} }))
      .toEqual({ url: 'http://localhost:3000', source: 'target-dev-url' });
  });

  it('an explicit per-call target wins over everything (passed through raw)', async () => {
    const out = await resolveTargetUrl({
      env: { ARGUS_PREVIEW_URL: 'https://preview.app', TARGET_DEV_URL: 'http://dev' },
      explicitTarget: 'https://explicit.example',
    });
    expect(out).toEqual({ url: 'https://explicit.example', source: 'explicit' });
  });

  it('uses ARGUS_PREVIEW_URL when no explicit target is given', async () => {
    const out = await resolveTargetUrl({ env: { ARGUS_PREVIEW_URL: 'https://pr-42.app', TARGET_DEV_URL: 'http://dev' } });
    expect(out).toEqual({ url: 'https://pr-42.app', source: 'env:ARGUS_PREVIEW_URL' });
  });

  it('auto-detects a preview from GitHub Deployments when opted in', async () => {
    globalThis.fetch = async (url) => {
      if (/\/deployments\?sha=/.test(url)) return { ok: true, json: async () => [PREVIEW_DEPLOYMENT] };
      return { ok: true, json: async () => [SUCCESS_STATUS] };
    };
    const out = await resolveTargetUrl({
      env: { ARGUS_PREVIEW_DETECT: '1', TARGET_DEV_URL: 'http://dev' },
      prUrl: 'https://github.com/o/r/pull/42', headSha: 'abc123', token: 't',
    });
    expect(out).toEqual({ url: 'https://my-app-git-feature-x.vercel.app', source: 'deployment' });
  });

  it('degrades to TARGET_DEV_URL when detection finds no live preview', async () => {
    globalThis.fetch = async (url) => {
      if (/\/deployments\?sha=/.test(url)) return { ok: true, json: async () => [PREVIEW_DEPLOYMENT] };
      return { ok: true, json: async () => [FAILURE_STATUS] };   // only a failed deploy
    };
    const out = await resolveTargetUrl({
      env: { ARGUS_PREVIEW_DETECT: '1', TARGET_DEV_URL: 'http://dev' },
      prUrl: 'https://github.com/o/r/pull/42', headSha: 'abc123', token: 't',
    });
    expect(out).toEqual({ url: 'http://dev', source: 'target-dev-url' });
  });

  it('does NOT probe the network unless ARGUS_PREVIEW_DETECT is opted in', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => [] }; };
    const out = await resolveTargetUrl({
      env: { TARGET_DEV_URL: 'http://dev' },   // detect flag absent
      prUrl: 'https://github.com/o/r/pull/42', headSha: 'abc123', token: 't',
    });
    expect(out).toEqual({ url: 'http://dev', source: 'target-dev-url' });
    expect(called).toBe(false);
  });

  it('is fail-safe — a detection throw still resolves to TARGET_DEV_URL', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    const out = await resolveTargetUrl({
      env: { ARGUS_PREVIEW_DETECT: 'true', TARGET_DEV_URL: 'http://dev' },
      prUrl: 'https://github.com/o/r/pull/42', headSha: 'abc123', token: 't',
    });
    expect(out).toEqual({ url: 'http://dev', source: 'target-dev-url' });
  });

  it('skips detection when the token or head SHA is missing (opted in but unconfigured)', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => [] }; };
    const out = await resolveTargetUrl({
      env: { ARGUS_PREVIEW_DETECT: '1', TARGET_DEV_URL: 'http://dev' },
      prUrl: 'https://github.com/o/r/pull/42', headSha: undefined, token: undefined,
    });
    expect(out).toEqual({ url: 'http://dev', source: 'target-dev-url' });
    expect(called).toBe(false);
  });
});
