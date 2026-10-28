import { describe, expect, it } from 'vitest';
import {
  actualTierFromResponse,
  normalizeProcessingTier,
  requestedTierFromExtra,
} from './processing-tier';

describe('normalizeProcessingTier (#5704 convention)', () => {
  it('maps empty / null / default / auto to standard', () => {
    expect(normalizeProcessingTier(null)).toBe('standard');
    expect(normalizeProcessingTier(undefined)).toBe('standard');
    expect(normalizeProcessingTier('')).toBe('standard');
    expect(normalizeProcessingTier('  ')).toBe('standard');
    expect(normalizeProcessingTier('default')).toBe('standard');
    expect(normalizeProcessingTier('AUTO')).toBe('standard');
    expect(normalizeProcessingTier('Standard')).toBe('standard');
  });

  it('keeps flex / batch / fast and aliases priority → fast', () => {
    expect(normalizeProcessingTier('flex')).toBe('flex');
    expect(normalizeProcessingTier('BATCH')).toBe('batch');
    expect(normalizeProcessingTier('fast')).toBe('fast');
    expect(normalizeProcessingTier('priority')).toBe('fast');
  });

  it('returns unknown for unrecognized tokens (never invents)', () => {
    expect(normalizeProcessingTier('turbo')).toBe('unknown');
    expect(normalizeProcessingTier(42)).toBe('unknown');
    expect(normalizeProcessingTier({ tier: 'fast' })).toBe('unknown');
  });
});

describe('requested / actual helpers', () => {
  it('reads service_tier from request extra', () => {
    expect(requestedTierFromExtra({ service_tier: 'flex' })).toBe('flex');
    expect(requestedTierFromExtra({ serviceTier: 'priority' })).toBe('fast');
    expect(requestedTierFromExtra(undefined)).toBe('standard');
  });

  it('reads service_tier from a response echo object', () => {
    expect(actualTierFromResponse({ service_tier: 'fast' })).toBe('fast');
    expect(actualTierFromResponse('batch')).toBe('batch');
    expect(actualTierFromResponse(undefined)).toBe('standard');
  });
});
