import { describe, it, expect } from 'vitest';
import { ConfigSchema, validateConfig } from '../../src/config/schema.js';

const VALID_CONFIG = {
  config: { pageSettleMs: 1000 },
  routes: [{ path: '/', name: 'Home', critical: false }],
  thresholds: {
    perf:         { LCP: 2500, CLS: 0.1, FID: 100, TTFB: 800 },
    network:      { slowWarning: 1000, slowCritical: 3000, sizeWarning: 500000, sizeCritical: 2000000 },
    memory:       { detachedWarning: 10, detachedCritical: 100, heapGrowthWarning: 2000000, heapGrowthCritical: 10000000 },
    hover:        { waitMs: 350, maxDropdowns: 8, maxTooltips: 5 },
    security:     { headTimeoutMs: 3000 },
    apiFrequency: { warningCount: 3, criticalCount: 6 },
    lighthouse: {
      accessibility:    { critical: 50, warning: 90 },
      performance:      { critical: 50, warning: 90 },
      seo:              { critical: 50, warning: 90 },
      'best-practices': { critical: 50, warning: 90 },
    },
  },
};

describe('validateConfig', () => {
  it('accepts a valid config without throwing', () => {
    expect(() => validateConfig(VALID_CONFIG)).not.toThrow();
  });

  it('throws when routes is missing', () => {
    const { routes: _, ...rest } = VALID_CONFIG;
    expect(() => validateConfig(rest)).toThrow();
  });

  it('throws when route.path is missing the leading slash', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      routes: [{ path: 'no-slash', name: 'Bad', critical: false }],
    })).toThrow();
  });

  it('throws when route.name is empty string', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      routes: [{ path: '/', name: '', critical: false }],
    })).toThrow();
  });

  it('throws when a threshold value is a string instead of a number', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      thresholds: {
        ...VALID_CONFIG.thresholds,
        perf: { ...VALID_CONFIG.thresholds.perf, LCP: 'slow' },
      },
    })).toThrow();
  });

  it('accepts optional fields (comparisonRoutes, apiContracts, auth)', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      comparisonRoutes: [],
      apiContracts: [],
      auth: null,
    })).not.toThrow();
  });
});

describe('ConfigSchema.parse', () => {
  it('returns the parsed object on success', () => {
    const result = ConfigSchema.safeParse(VALID_CONFIG);
    expect(result.success).toBe(true);
  });

  it('returns failure on invalid input', () => {
    const result = ConfigSchema.safeParse({ config: { pageSettleMs: -1 }, routes: [], thresholds: {} });
    expect(result.success).toBe(false);
  });
});
