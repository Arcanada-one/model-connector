import { describe, expect, it, vi } from 'vitest';
import { CatalogSync } from '../src/catalog/catalog-sync.js';
import { DisabledCatalogWriterAdapter } from '../src/contracts/catalog-writer.adapter.js';

describe('catalog sync', () => {
  it('persists LKG and reports added/changed/missing without writes', async () => {
    const persist = vi.fn();
    const sync = new CatalogSync(new DisabledCatalogWriterAdapter(), persist, { removalBlockRatio: 0.2, removalBlockCount: 10 });
    const result = await sync.reconcile('openrouter', [{ id: 'a', free: true }], [{ id: 'a', free: false }, { id: 'b', free: true }], false);
    expect(result).toMatchObject({ added: ['b'], changed: ['a'], missing: [], writeAttempted: false });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('blocks anomalous removal and never exposes delete', async () => {
    const writer = new DisabledCatalogWriterAdapter();
    const sync = new CatalogSync(writer, vi.fn(), { removalBlockRatio: 0.2, removalBlockCount: 10 });
    const previous = Array.from({ length: 20 }, (_, index) => ({ id: `m${index}`, free: true }));
    const result = await sync.reconcile('openrouter', previous, previous.slice(0, 10), true);
    expect(result.blocked).toBe(true);
    expect('delete' in writer).toBe(false);
  });

  it('keeps first missing observation candidate-only', async () => {
    const sync = new CatalogSync(new DisabledCatalogWriterAdapter(), vi.fn(), {
      removalBlockRatio: 0.2,
      removalBlockCount: 10,
      missingBeforeDeprecate: 2,
    });
    const first = await sync.reconcile('openrouter', [{ id: 'a', free: true }], [], false);
    const second = await sync.reconcile('openrouter', [{ id: 'a', free: true }], [], false);
    expect(first.eligibleMissing).toEqual([]);
    expect(second.eligibleMissing).toEqual(['a']);
  });

  it('makes accepted attributes visible through a local contract fixture', async () => {
    const catalog = new Map<string, unknown>();
    const writer = {
      contractVersion: 'fixture-v1',
      isAvailable: () => true,
      submitValidatedDiff: async (diff: { provider: string; current: unknown[] }) => {
        catalog.set(diff.provider, diff.current);
      },
    };
    const sync = new CatalogSync(writer, vi.fn(), {
      removalBlockRatio: 0.2,
      removalBlockCount: 10,
      missingBeforeDeprecate: 2,
    });
    const current = [{ id: 'a', free: false, contextLength: 4096 }];
    const result = await sync.reconcile('openrouter', [], current, true);
    expect(result.writeAttempted).toBe(true);
    expect(catalog.get('openrouter')).toEqual(current);
  });
});
