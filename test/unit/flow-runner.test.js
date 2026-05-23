import { describe, it, expect, vi } from 'vitest';
import { normalizeArray, runFlow } from '../../src/utils/flow-runner.js';

describe('normalizeArray', () => {
  it('returns empty array for null', () => {
    expect(normalizeArray(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(normalizeArray(undefined)).toEqual([]);
  });

  it('returns the array as-is when input is already an array', () => {
    const arr = [1, 2, 3];
    expect(normalizeArray(arr)).toBe(arr);
  });

  it('extracts .messages array from object', () => {
    const msgs = [{ text: 'hello' }];
    expect(normalizeArray({ messages: msgs })).toBe(msgs);
  });

  it('extracts .requests array from object', () => {
    const reqs = [{ url: '/api' }];
    expect(normalizeArray({ requests: reqs })).toBe(reqs);
  });

  it('extracts .result array from object', () => {
    const res = [{ value: 1 }];
    expect(normalizeArray({ result: res })).toBe(res);
  });

  it('returns empty array for object with no known array field', () => {
    expect(normalizeArray({ unknown: [1, 2] })).toEqual([]);
  });
});

describe('runFlow', () => {
  function makeBrowser(overrides = {}) {
    return {
      listConsole:  vi.fn().mockResolvedValue([]),
      listNetwork:  vi.fn().mockResolvedValue([]),
      navigate:     vi.fn().mockResolvedValue(null),
      evaluate:     vi.fn().mockResolvedValue(null),
      click:        vi.fn().mockResolvedValue(null),
      fill:         vi.fn().mockResolvedValue(null),
      takeScreenshot: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  it('returns status:pass for an empty flow', async () => {
    const result = await runFlow({ name: 'empty', steps: [] }, 'http://localhost', makeBrowser());
    expect(result.status).toBe('pass');
    expect(result.findings).toHaveLength(0);
  });

  it('completes a sleep step without error', async () => {
    const result = await runFlow(
      { name: 'sleepy', steps: [{ action: 'sleep', ms: 1 }] },
      'http://localhost',
      makeBrowser(),
    );
    expect(result.status).toBe('pass');
    expect(result.stepsCompleted).toBe(1);
  });

  it('produces flow_step_failed finding when navigate throws', async () => {
    const browser = makeBrowser({
      navigate: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED')),
    });
    const result = await runFlow(
      { name: 'nav-fail', steps: [{ action: 'navigate', url: 'http://localhost/page' }] },
      'http://localhost',
      browser,
    );
    expect(result.status).toBe('fail');
    expect(result.findings[0].type).toBe('flow_step_failed');
    expect(result.findings[0].message).toContain('net::ERR_CONNECTION_REFUSED');
  });

  it('sets totalSteps to flow.steps.length', async () => {
    const result = await runFlow(
      { name: 'multi', steps: [{ action: 'sleep', ms: 1 }, { action: 'sleep', ms: 1 }] },
      'http://localhost',
      makeBrowser(),
    );
    expect(result.totalSteps).toBe(2);
  });
});
