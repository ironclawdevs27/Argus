import { describe, it, expect } from 'vitest';
import { createFinding } from '../../src/domain/finding.js';

describe('createFinding', () => {
  it('creates a valid finding with all fields', () => {
    const f = createFinding({ type: 'console_error', severity: 'warning', message: 'oops', url: '/foo' });
    expect(f.type).toBe('console_error');
    expect(f.severity).toBe('warning');
    expect(f.message).toBe('oops');
    expect(f.url).toBe('/foo');
  });

  it('defaults url to empty string when omitted', () => {
    const f = createFinding({ type: 't', severity: 'info', message: 'm' });
    expect(f.url).toBe('');
  });

  it('throws when type is missing', () => {
    expect(() => createFinding({ severity: 'info', message: 'm' })).toThrow('type');
  });

  it('throws when message is missing', () => {
    expect(() => createFinding({ type: 't', severity: 'info' })).toThrow('message');
  });

  it('throws on invalid severity', () => {
    expect(() => createFinding({ type: 't', severity: 'medium', message: 'm' })).toThrow('severity');
  });

  it('accepts all three valid severities', () => {
    expect(() => createFinding({ type: 't', severity: 'critical', message: 'm' })).not.toThrow();
    expect(() => createFinding({ type: 't', severity: 'warning',  message: 'm' })).not.toThrow();
    expect(() => createFinding({ type: 't', severity: 'info',     message: 'm' })).not.toThrow();
  });

  it('returns a frozen (immutable) object', () => {
    const f = createFinding({ type: 't', severity: 'info', message: 'm' });
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('preserves extra fields via rest spread', () => {
    const f = createFinding({ type: 't', severity: 'info', message: 'm', custom: 'data', count: 3 });
    expect(f.custom).toBe('data');
    expect(f.count).toBe(3);
  });
});
