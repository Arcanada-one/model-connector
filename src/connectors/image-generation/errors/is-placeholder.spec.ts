import { describe, it, expect } from 'vitest';
import { isPlaceholder } from './is-placeholder';

describe('isPlaceholder', () => {
  it('returns true for PLACEHOLDER_ prefix', () => {
    expect(isPlaceholder('PLACEHOLDER_CONN-0052')).toBe(true);
  });

  it('returns true for any PLACEHOLDER_ prefixed value', () => {
    expect(isPlaceholder('PLACEHOLDER_AUTH-0001')).toBe(true);
  });

  it('returns false for real API token', () => {
    expect(isPlaceholder('r8_abc123xyz')).toBe(false);
  });

  it('returns false for real API key', () => {
    expect(isPlaceholder('sk-proj-abc123')).toBe(false);
  });

  it('returns false for real PEM key beginning', () => {
    expect(isPlaceholder('-----BEGIN RSA PRIVATE KEY-----')).toBe(false);
  });

  it('returns true for empty string (no real value)', () => {
    expect(isPlaceholder('')).toBe(true);
  });

  it('returns true for whitespace-only string', () => {
    expect(isPlaceholder('   ')).toBe(true);
  });
});
