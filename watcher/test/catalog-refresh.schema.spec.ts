import { describe, expect, it } from 'vitest';
import { normalizeOpenRouterCatalog } from '../src/catalog/openrouter.adapter.js';

describe('OpenRouter catalog schema', () => {
  it('normalizes valid model attributes', () => {
    const catalog = normalizeOpenRouterCatalog({ data: [{ id: 'a/b', pricing: { prompt: '0', completion: '0' }, context_length: 1000, architecture: { modality: 'text->text' } }] });
    expect(catalog[0]).toMatchObject({ id: 'a/b', free: true, contextLength: 1000 });
  });

  it.each([
    null,
    {},
    { data: [{ id: 5 }] },
    { data: [{ id: 'a/b', pricing: { prompt: [], completion: '0' } }] },
  ])('rejects malformed/type-drift payload %#', (payload) => {
    expect(() => normalizeOpenRouterCatalog(payload)).toThrow();
  });

  it('detects commercial attribute changes through normalization', () => {
    const free = normalizeOpenRouterCatalog({ data: [{ id: 'a/b', pricing: { prompt: '0', completion: '0' } }] })[0];
    const paid = normalizeOpenRouterCatalog({ data: [{ id: 'a/b', pricing: { prompt: '0.1', completion: '0.2' } }] })[0];
    expect(paid.free).not.toBe(free.free);
  });

  it('accepts extra pricing keys returned by live OpenRouter API', () => {
    const entry = {
      id: 'openai/gpt-4o',
      pricing: {
        prompt: '0.0000025',
        completion: '0.00001',
        web_search: '0.03',
        image: '0.00765',
        audio: '0.0001',
        internal_reasoning: '0.000005',
        input_cache_read: '0.00000125',
        input_cache_write: '0.000005',
      },
      context_length: 128000,
      architecture: { modality: 'text+image->text' },
    };
    const result = normalizeOpenRouterCatalog({ data: [entry] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'openai/gpt-4o',
      free: false,
      promptPrice: 0.0000025,
      completionPrice: 0.00001,
      contextLength: 128000,
    });
  });

  it('accepts extra top-level keys in the OpenRouter response envelope', () => {
    const result = normalizeOpenRouterCatalog({
      data: [{ id: 'x/y', pricing: { prompt: '0', completion: '0' } }],
      meta: { page: 1, total: 1 },
      unknown_future_field: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('x/y');
  });
});
