import { describe, it, expect } from 'vitest';
import { imageGenerateRequestSchema } from './execute.dto';

describe('imageGenerateRequestSchema', () => {
  describe('maxBudgetUsd validation (G2)', () => {
    it('accepts $0.01 (positive budget)', () => {
      const result = imageGenerateRequestSchema.safeParse({
        prompt: 'test',
        maxBudgetUsd: 0.01,
      });
      expect(result.success).toBe(true);
    });

    it('rejects $0 (zero budget is not a valid limit)', () => {
      const result = imageGenerateRequestSchema.safeParse({
        prompt: 'test',
        maxBudgetUsd: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative budget', () => {
      const result = imageGenerateRequestSchema.safeParse({
        prompt: 'test',
        maxBudgetUsd: -1,
      });
      expect(result.success).toBe(false);
    });

    it('accepts absent maxBudgetUsd (optional field)', () => {
      const result = imageGenerateRequestSchema.safeParse({ prompt: 'test' });
      expect(result.success).toBe(true);
    });
  });
});
