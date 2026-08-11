import { describe, expect, it } from 'vitest';
import type { ModelCatalogUpsert } from './catalog.repository';
import {
  diffCatalogRows,
  fingerprintCatalogRow,
  fingerprintProviderSnapshot,
  prepareCatalogRows,
} from './catalog-snapshot';

function row(overrides: Partial<ModelCatalogUpsert> = {}): ModelCatalogUpsert {
  return {
    connector: 'groq',
    model: 'model-a',
    modality: 'chat',
    status: 'online',
    lastChecked: new Date('2026-07-26T12:00:00.000Z'),
    supportsStreaming: true,
    supportsJsonSchema: true,
    supportsTools: true,
    inputPerMTok: null,
    outputPerMTok: null,
    priceUnit: 'USD/1M tokens',
    tier: 'unknown',
    free: false,
    priceMultiplier: null,
    contextWindow: null,
    maxOutputTokens: null,
    endpoint: null,
    executableHere: true,
    routable: true,
    ...overrides,
  };
}

describe('catalog snapshot fingerprints', () => {
  it('is deterministic and excludes volatile status, routing, and check time', () => {
    const baseline = row();
    const changedVolatile = row({
      status: 'offline',
      lastChecked: new Date('2030-01-01T00:00:00.000Z'),
      routable: false,
    });

    expect(fingerprintCatalogRow(baseline)).toBe(fingerprintCatalogRow(changedVolatile));
    expect(fingerprintCatalogRow(baseline)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when stable model content changes', () => {
    expect(fingerprintCatalogRow(row())).not.toBe(
      fingerprintCatalogRow(row({ contextWindow: 128_000 })),
    );
  });

  it('sorts provider rows by model before fingerprinting', () => {
    const rows = prepareCatalogRows([row({ model: 'z' }), row({ model: 'a' })]);
    expect(fingerprintProviderSnapshot('groq', rows)).toBe(
      fingerprintProviderSnapshot('groq', [...rows].reverse()),
    );
  });
});

describe('diffCatalogRows corrected state machine', () => {
  it('emits added, removed, and changed with stable changed field names', () => {
    const previous = [
      {
        ...row({ model: 'removed' }),
        absent: false,
        contentFingerprint: fingerprintCatalogRow(row({ model: 'removed' })),
      },
      {
        ...row({ model: 'changed', contextWindow: 1 }),
        absent: false,
        contentFingerprint: fingerprintCatalogRow(row({ model: 'changed', contextWindow: 1 })),
      },
    ];
    const next = prepareCatalogRows([
      row({ model: 'added' }),
      row({ model: 'changed', contextWindow: 2 }),
    ]);

    expect(diffCatalogRows(previous, next)).toEqual([
      expect.objectContaining({ model: 'added', changeType: 'added' }),
      expect.objectContaining({
        model: 'changed',
        changeType: 'changed',
        changedFields: ['contextWindow'],
      }),
      expect.objectContaining({ model: 'removed', changeType: 'removed' }),
    ]);
  });

  it('does not emit removed repeatedly for an already-absent row still missing', () => {
    const previous = [
      {
        ...row({ model: 'gone' }),
        absent: true,
        contentFingerprint: fingerprintCatalogRow(row({ model: 'gone' })),
      },
    ];

    expect(diffCatalogRows(previous, [])).toEqual([]);
  });

  it('emits added when an absent row reappears', () => {
    const previous = [
      {
        ...row({ model: 'returned' }),
        absent: true,
        contentFingerprint: fingerprintCatalogRow(row({ model: 'returned' })),
      },
    ];

    expect(diffCatalogRows(previous, prepareCatalogRows([row({ model: 'returned' })]))).toEqual([
      expect.objectContaining({ model: 'returned', changeType: 'added' }),
    ]);
  });

  it('establishes a legacy null fingerprint baseline without changed', () => {
    const previous = [
      {
        ...row({ model: 'legacy', contextWindow: null }),
        absent: false,
        contentFingerprint: null,
      },
    ];

    expect(
      diffCatalogRows(
        previous,
        prepareCatalogRows([row({ model: 'legacy', contextWindow: 128_000 })]),
      ),
    ).toEqual([]);
  });
});
