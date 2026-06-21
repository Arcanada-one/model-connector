import { describe, it, expect } from 'vitest';
import {
  buildFreeModels,
  OPENMODEL_FREE_MODELS_DEFAULT,
  OPENMODEL_CATALOGUE,
} from './openmodel.catalogue';

describe('buildFreeModels', () => {
  it('returns default when no CSV provided', () => {
    expect(buildFreeModels()).toEqual(OPENMODEL_FREE_MODELS_DEFAULT);
  });

  it('returns default when empty string provided', () => {
    expect(buildFreeModels('')).toEqual(OPENMODEL_FREE_MODELS_DEFAULT);
  });

  it('returns default when whitespace-only string provided', () => {
    expect(buildFreeModels('   ')).toEqual(OPENMODEL_FREE_MODELS_DEFAULT);
  });

  it('parses CSV override correctly', () => {
    expect(buildFreeModels('model-a,model-b,model-c')).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('trims whitespace around CSV entries', () => {
    expect(buildFreeModels(' model-a , model-b ')).toEqual(['model-a', 'model-b']);
  });

  it('single model CSV works', () => {
    expect(buildFreeModels('deepseek-v4-flash')).toEqual(['deepseek-v4-flash']);
  });
});

describe('OPENMODEL_CATALOGUE price_multiplier', () => {
  it('deepseek-v4-flash has price_multiplier === 0 (free)', () => {
    const model = OPENMODEL_CATALOGUE.find((m) => m.id === 'deepseek-v4-flash');
    expect(model).toBeDefined();
    expect(model!.price_multiplier).toBe(0);
  });

  it('all free models have price_multiplier === 0', () => {
    const freeModels = OPENMODEL_CATALOGUE.filter((m) => m.price_multiplier === 0);
    expect(freeModels.length).toBeGreaterThan(0);
    expect(freeModels.every((m) => m.price_multiplier === 0)).toBe(true);
  });

  it('catalogue contains at least one paid model', () => {
    const paid = OPENMODEL_CATALOGUE.filter((m) => m.price_multiplier > 0);
    expect(paid.length).toBeGreaterThan(0);
  });
});
