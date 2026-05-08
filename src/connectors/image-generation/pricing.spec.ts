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

/**
 * Pricing range validation — 2026-05-07.
 *
 * These ranges are validated against INSIGHTS-CONN-0052.md § Documentation References.
 * When real API calls are available (Phase 2 full), replace with live price probes.
 *
 * NOTE: If a provider changes pricing, these tests will fail as an early-warning signal.
 * Update PRICING_TABLE + re-validate at provider pricing pages:
 *   - Vertex AI:   https://cloud.google.com/vertex-ai/generative-ai/pricing
 *   - Replicate:   https://replicate.com/pricing
 *   - OpenAI:      https://openai.com/api/pricing/
 */
describe('PRICING_TABLE — 2026 range validation', () => {
  it('vertex:nano-banana is in expected range [$0.030, $0.050] per image', () => {
    const price = PRICING_TABLE['vertex:nano-banana']!;
    expect(price).toBeGreaterThanOrEqual(0.03);
    expect(price).toBeLessThanOrEqual(0.05);
  });

  it('vertex:imagen-4-fast is cheapest Imagen 4 tier (< vertex:imagen-4)', () => {
    const fast = PRICING_TABLE['vertex:imagen-4-fast']!;
    const standard = PRICING_TABLE['vertex:imagen-4']!;
    expect(fast).toBeLessThan(standard);
  });

  it('vertex:imagen-4-ultra is most expensive Vertex tier', () => {
    const ultra = PRICING_TABLE['vertex:imagen-4-ultra']!;
    const fast = PRICING_TABLE['vertex:imagen-4-fast']!;
    const standard = PRICING_TABLE['vertex:imagen-4']!;
    expect(ultra).toBeGreaterThan(fast);
    expect(ultra).toBeGreaterThan(standard);
  });

  it('replicate:flux-pro is in expected range [$0.030, $0.060] per image', () => {
    const price = PRICING_TABLE['replicate:flux-pro']!;
    expect(price).toBeGreaterThanOrEqual(0.03);
    expect(price).toBeLessThanOrEqual(0.06);
  });

  it('openai:gpt-image-1-low < openai:gpt-image-1-medium < openai:gpt-image-1-high (quality tiers)', () => {
    const low = PRICING_TABLE['openai:gpt-image-1-low']!;
    const med = PRICING_TABLE['openai:gpt-image-1-medium']!;
    const high = PRICING_TABLE['openai:gpt-image-1-high']!;
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });

  it('openai:gpt-image-1-high is in expected range [$0.15, $0.30] per image', () => {
    const price = PRICING_TABLE['openai:gpt-image-1-high']!;
    expect(price).toBeGreaterThanOrEqual(0.15);
    expect(price).toBeLessThanOrEqual(0.3);
  });

  it('all prices are positive and non-zero', () => {
    for (const [model, price] of Object.entries(PRICING_TABLE)) {
      expect(price, `${model} price > 0`).toBeGreaterThan(0);
    }
  });

  it('no price exceeds $1.00 (sanity ceiling — update if provider releases ultra-premium tier)', () => {
    for (const [model, price] of Object.entries(PRICING_TABLE)) {
      expect(price, `${model} price <= $1.00`).toBeLessThanOrEqual(1.0);
    }
  });
});
