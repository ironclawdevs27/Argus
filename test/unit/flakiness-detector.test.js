import { describe, it, expect } from 'vitest';
import { findingKey, mergeRunResults } from '../../src/utils/flakiness-detector.js';

describe('findingKey', () => {
  it('produces a stable key from type and message', () => {
    const f = { type: 'console_error', message: 'Something broke', severity: 'warning' };
    expect(findingKey(f)).toBe('console_error::Something broke');
  });

  it('normalizes extra whitespace in message', () => {
    const f1 = { type: 't', message: 'a  b' };
    const f2 = { type: 't', message: 'a b' };
    expect(findingKey(f1)).toBe(findingKey(f2));
  });

  it('trims leading and trailing whitespace', () => {
    const f1 = { type: 't', message: '  hello  ' };
    const f2 = { type: 't', message: 'hello' };
    expect(findingKey(f1)).toBe(findingKey(f2));
  });

  it('appends status when present', () => {
    const f = { type: 't', message: 'm', status: 404 };
    expect(findingKey(f)).toBe('t::m::404');
  });

  it('omits status suffix when status is null/undefined', () => {
    const f = { type: 't', message: 'm', status: null };
    expect(findingKey(f)).toBe('t::m');
  });

  it('truncates message to 100 characters', () => {
    const long = 'x'.repeat(150);
    const key = findingKey({ type: 't', message: long });
    expect(key).toBe('t::' + 'x'.repeat(100));
  });
});

describe('mergeRunResults', () => {
  function makeRun(errors) {
    return { url: '/', errors, screenshot: null };
  }

  const crit = { type: 'js_error', message: 'Uncaught TypeError', severity: 'critical' };
  const warn = { type: 'network_4xx', message: '404 /api/data', severity: 'warning' };

  it('throws TypeError when run1 is null', () => {
    expect(() => mergeRunResults(null, makeRun([]))).toThrow(TypeError);
  });

  it('throws TypeError when run2.errors is not an array', () => {
    expect(() => mergeRunResults(makeRun([]), { url: '/', errors: null })).toThrow(TypeError);
  });

  it('confirmed finding (in both runs) keeps original severity and flaky: false', () => {
    const merged = mergeRunResults(makeRun([crit]), makeRun([{ ...crit }]));
    const f = merged.errors[0];
    expect(f.flaky).toBe(false);
    expect(f.severity).toBe('critical');
  });

  it('run1-only finding → flaky: true, severity: info', () => {
    const merged = mergeRunResults(makeRun([crit]), makeRun([]));
    const f = merged.errors[0];
    expect(f.flaky).toBe(true);
    expect(f.severity).toBe('info');
  });

  it('run2-only finding → flaky: true, severity: info', () => {
    const merged = mergeRunResults(makeRun([]), makeRun([warn]));
    const f = merged.errors[0];
    expect(f.flaky).toBe(true);
    expect(f.severity).toBe('info');
  });

  it('confirmed count is correct when both runs have same findings', () => {
    const merged = mergeRunResults(makeRun([crit, warn]), makeRun([{ ...crit }, { ...warn }]));
    const confirmed = merged.errors.filter(f => !f.flaky);
    expect(confirmed).toHaveLength(2);
  });

  it('merged result uses run2 screenshot', () => {
    const run1 = { url: '/', errors: [], screenshot: 'r1.png' };
    const run2 = { url: '/', errors: [], screenshot: 'r2.png' };
    const merged = mergeRunResults(run1, run2);
    expect(merged.screenshot).toBe('r2.png');
  });
});
