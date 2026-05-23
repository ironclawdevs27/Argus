import { describe, it, expect } from 'vitest';
import { deduplicateFindings, rebuildSummary } from '../../src/orchestration/report-processor.js';

describe('deduplicateFindings', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateFindings([])).toEqual([]);
  });

  it('removes duplicate findings with identical type + message + url', () => {
    const f = { type: 'console_error', message: 'oops', url: '/foo', severity: 'warning' };
    const result = deduplicateFindings([f, { ...f }]);
    expect(result).toHaveLength(1);
  });

  it('keeps findings that differ by type', () => {
    const base = { message: 'oops', url: '/foo', severity: 'warning' };
    const a = { ...base, type: 'console_error' };
    const b = { ...base, type: 'network_error' };
    expect(deduplicateFindings([a, b])).toHaveLength(2);
  });

  it('keeps findings that differ by url', () => {
    const base = { type: 'console_error', message: 'oops', severity: 'warning' };
    const a = { ...base, url: '/foo' };
    const b = { ...base, url: '/bar' };
    expect(deduplicateFindings([a, b])).toHaveLength(2);
  });

  it('keeps findings that differ by message', () => {
    const base = { type: 'console_error', url: '/', severity: 'warning' };
    const a = { ...base, message: 'error A' };
    const b = { ...base, message: 'error B' };
    expect(deduplicateFindings([a, b])).toHaveLength(2);
  });

  it('filters out null and non-object entries', () => {
    const f = { type: 't', message: 'm', url: '/', severity: 'info' };
    const result = deduplicateFindings([null, f, undefined, f]);
    expect(result).toHaveLength(1);
  });

  it('preserves order — first occurrence is kept', () => {
    const a = { type: 't', message: 'm', url: '/', severity: 'critical' };
    const b = { type: 't', message: 'm', url: '/', severity: 'warning' };
    const result = deduplicateFindings([a, b]);
    expect(result[0].severity).toBe('critical');
  });
});

describe('rebuildSummary', () => {
  function makeReport(routeErrors = [], flowFindings = [], codebase = []) {
    return {
      routes: [{ errors: routeErrors }],
      flows: flowFindings.length > 0 ? [{ findings: flowFindings }] : [],
      codebase,
    };
  }

  it('counts route findings by severity', () => {
    const report = makeReport([
      { type: 'a', severity: 'critical', message: 'c' },
      { type: 'b', severity: 'warning',  message: 'w' },
      { type: 'c', severity: 'info',     message: 'i' },
    ]);
    rebuildSummary(report);
    expect(report.summary.critical).toBe(1);
    expect(report.summary.warning).toBe(1);
    expect(report.summary.info).toBe(1);
    expect(report.summary.total).toBe(3);
  });

  it('counts flow findings', () => {
    const report = makeReport(
      [],
      [{ type: 'flow_assert_failed', severity: 'warning', message: 'w' }],
    );
    rebuildSummary(report);
    expect(report.summary.warning).toBe(1);
    expect(report.summary.total).toBe(1);
  });

  it('returns zero counts for empty report', () => {
    const report = makeReport();
    rebuildSummary(report);
    expect(report.summary.total).toBe(0);
    expect(report.summary.critical).toBe(0);
  });

  it('counts codebase findings', () => {
    const report = makeReport([], [], [
      { type: 'env_var_missing', severity: 'warning', message: 'w' },
    ]);
    rebuildSummary(report);
    expect(report.summary.warning).toBe(1);
    expect(report.summary.total).toBe(1);
  });
});
