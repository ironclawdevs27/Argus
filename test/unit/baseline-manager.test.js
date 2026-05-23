import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadBaseline, saveBaseline, applyBaseline } from '../../src/utils/baseline-manager.js';

const TMP_DIR = path.join(os.tmpdir(), `argus-unit-${process.pid}`);
const baselineFile = path.join(TMP_DIR, 'test-baseline.json');

afterEach(() => {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
});

describe('loadBaseline', () => {
  it('returns null when file does not exist', () => {
    expect(loadBaseline(path.join(TMP_DIR, 'nonexistent.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(baselineFile, 'not valid json');
    expect(loadBaseline(baselineFile)).toBeNull();
  });

  it('loads routes as a Map of Sets', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const data = { savedAt: '2024-01-01', routes: { '/': ['t::m'] }, flows: {}, codebase: [] };
    fs.writeFileSync(baselineFile, JSON.stringify(data));
    const baseline = loadBaseline(baselineFile);
    expect(baseline).not.toBeNull();
    expect(baseline.routes).toBeInstanceOf(Map);
    expect(baseline.routes.get('/')).toBeInstanceOf(Set);
    expect(baseline.routes.get('/').has('t::m')).toBe(true);
  });

  it('loads flows as a Map of Sets', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const data = { savedAt: '2024-01-01', routes: {}, flows: { login: ['f::msg'] }, codebase: [] };
    fs.writeFileSync(baselineFile, JSON.stringify(data));
    const baseline = loadBaseline(baselineFile);
    expect(baseline.flows.get('login').has('f::msg')).toBe(true);
  });

  it('defaults missing flows to empty Map', () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const data = { savedAt: '2024-01-01', routes: {} };
    fs.writeFileSync(baselineFile, JSON.stringify(data));
    const baseline = loadBaseline(baselineFile);
    expect(baseline.flows).toBeInstanceOf(Map);
    expect(baseline.flows.size).toBe(0);
  });
});

describe('saveBaseline', () => {
  it('creates parent directory if missing', () => {
    saveBaseline(baselineFile, { routes: [{ url: '/', errors: [] }], flows: [], codebase: [] });
    expect(fs.existsSync(baselineFile)).toBe(true);
  });

  it('round-trips through loadBaseline', () => {
    const finding = { type: 'console_error', message: 'oops', severity: 'warning' };
    const report = { routes: [{ url: '/page', errors: [finding] }], flows: [], codebase: [] };
    saveBaseline(baselineFile, report);
    const baseline = loadBaseline(baselineFile);
    expect(baseline).not.toBeNull();
    expect(baseline.routes.has('/page')).toBe(true);
    expect(baseline.routes.get('/page').size).toBe(1);
  });
});

describe('applyBaseline', () => {
  it('marks all findings isNew:true on first run (null baseline)', () => {
    const finding = { type: 'js_error', message: 'crash', severity: 'critical' };
    const report = { routes: [{ url: '/', errors: [finding] }], flows: [], codebase: [] };
    const result = applyBaseline(report, null);
    expect(result.isFirstRun).toBe(true);
    expect(finding.isNew).toBe(true);
    expect(result.newCount).toBe(1);
    expect(result.resolvedCount).toBe(0);
  });

  it('marks no findings as new when identical to baseline', () => {
    const finding = { type: 'console_error', message: 'oops', severity: 'warning' };
    const report = { routes: [{ url: '/', errors: [finding] }], flows: [], codebase: [] };
    saveBaseline(baselineFile, report);
    const baseline = loadBaseline(baselineFile);
    const finding2 = { type: 'console_error', message: 'oops', severity: 'warning' };
    const report2 = { routes: [{ url: '/', errors: [finding2] }], flows: [], codebase: [] };
    const result = applyBaseline(report2, baseline);
    expect(result.isFirstRun).toBe(false);
    expect(finding2.isNew).toBe(false);
    expect(result.newCount).toBe(0);
  });

  it('resolvedCount reflects findings in baseline but not in current report', () => {
    const finding = { type: 'js_error', message: 'gone', severity: 'critical' };
    const report = { routes: [{ url: '/', errors: [finding] }], flows: [], codebase: [] };
    saveBaseline(baselineFile, report);
    const baseline = loadBaseline(baselineFile);
    const emptyReport = { routes: [{ url: '/', errors: [] }], flows: [], codebase: [] };
    const result = applyBaseline(emptyReport, baseline);
    expect(result.resolvedCount).toBe(1);
  });
});
