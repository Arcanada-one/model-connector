import { describe, it, expect } from 'vitest';
import { IMAGE_CAPABILITIES, imageCapabilitiesSchema, type CapabilityRecord } from './capabilities';

describe('IMAGE_CAPABILITIES', () => {
  it('passes Zod validation for every model entry', () => {
    expect(() => imageCapabilitiesSchema.parse(IMAGE_CAPABILITIES)).not.toThrow();
  });

  it('has all 8 expected model entries', () => {
    const keys = Object.keys(IMAGE_CAPABILITIES);
    expect(keys).toHaveLength(8);
  });

  it('each entry has required fields', () => {
    for (const [id, cap] of Object.entries(IMAGE_CAPABILITIES as CapabilityRecord)) {
      expect(cap.modelId, `${id}.modelId`).toBe(id);
      expect(cap.provider, `${id}.provider`).toBeTruthy();
      expect(cap.displayName, `${id}.displayName`).toBeTruthy();
      expect(Array.isArray(cap.sizes), `${id}.sizes`).toBe(true);
      expect(cap.sizes.length, `${id}.sizes not empty`).toBeGreaterThan(0);
      expect(typeof cap.costPerImageUsd, `${id}.costPerImageUsd`).toBe('number');
      expect(cap.costPerImageUsd, `${id}.costPerImageUsd > 0`).toBeGreaterThan(0);
      expect(typeof cap.latencyP95Ms, `${id}.latencyP95Ms`).toBe('number');
      expect(typeof cap.asyncThresholdMs, `${id}.asyncThresholdMs`).toBe('number');
    }
  });

  it('asyncThresholdMs >= latencyP95Ms (sanity)', () => {
    for (const [id, cap] of Object.entries(IMAGE_CAPABILITIES as CapabilityRecord)) {
      expect(cap.asyncThresholdMs, `${id}: asyncThreshold >= latencyP95`).toBeGreaterThanOrEqual(
        cap.latencyP95Ms,
      );
    }
  });

  it('watermark field is one of allowed values', () => {
    const allowed = ['always', 'never', 'optional'];
    for (const [id, cap] of Object.entries(IMAGE_CAPABILITIES as CapabilityRecord)) {
      expect(allowed, `${id}.watermark`).toContain(cap.watermark);
    }
  });
});
