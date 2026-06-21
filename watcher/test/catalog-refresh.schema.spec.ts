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
});
