import { describe, it, expect } from 'vitest';
import { calculateCostUsd, PRICING_TABLE } from './pricing';

describe('calculateCostUsd', () => {
  it('returns correct cost for vertex:nano-banana × 1', () => {
    expect(calculateCostUsd('vertex:nano-banana', 1)).toBeCloseTo(0.039);
  });

  it('returns correct cost for vertex:imagen-4 × 3', () => {
    expect(calculateCostUsd('vertex:imagen-4', 3)).toBeCloseTo(0.12);
  });

  it('returns correct cost for openai:gpt-image-1-high × 1', () => {
    expect(calculateCostUsd('openai:gpt-image-1-high', 1)).toBeCloseTo(0.25);
  });

  it('returns 0 for unknown model', () => {
    expect(calculateCostUsd('unknown:model', 2)).toBe(0);
  });

  it('PRICING_TABLE has all expected models', () => {
    const expected = [
      'vertex:nano-banana',
      'vertex:imagen-4-fast',
      'vertex:imagen-4',
      'vertex:imagen-4-ultra',
      'replicate:flux-pro',
      'openai:gpt-image-1-low',
      'openai:gpt-image-1-medium',
      'openai:gpt-image-1-high',
    ];
    for (const id of expected) {
      expect(PRICING_TABLE).toHaveProperty(id);
    }
  });

  it('multiplies by count', () => {
    const single = calculateCostUsd('replicate:flux-pro', 1);
    const quad = calculateCostUsd('replicate:flux-pro', 4);
    expect(quad).toBeCloseTo(single * 4);
  });
});
