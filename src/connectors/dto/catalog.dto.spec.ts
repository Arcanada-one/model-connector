import { describe, it, expect } from 'vitest';
import {
  CatalogModelEntrySchema,
  CatalogResponseSchema,
  CatalogFiltersSchema,
  CAPABILITY_FILTER_VALUES,
} from './catalog.dto';

// ─── CONN-0226 — catalog DTO schema unit tests ────────────────────────────────

const validEntry = {
  connector: 'openmodel',
  model: 'deepseek-v4-flash',
  free: true,
  cheap: true,
  priceMultiplier: 0,
  rateLimits: null,
  capabilities: {
    supportsStreaming: false,
    supportsJsonSchema: true,
    supportsTools: false,
  },
  routing: {
    connector: 'openmodel',
    model: 'deepseek-v4-flash',
  },
  available: true,
};

describe('CatalogModelEntrySchema', () => {
  it('accepts a valid free model entry', () => {
    const result = CatalogModelEntrySchema.safeParse(validEntry);
    expect(result.success).toBe(true);
  });

  it('accepts a paid model with priceMultiplier > 0', () => {
    const entry = { ...validEntry, free: false, cheap: false, priceMultiplier: 2 };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts null priceMultiplier (unknown price)', () => {
    const entry = { ...validEntry, priceMultiplier: null };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts non-null rateLimits when connector exposes them', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: 60, tokensPerMinute: 100_000 },
    };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts partial rateLimits with null fields', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: null, tokensPerMinute: 100_000 },
    };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects missing required connector field', () => {
    const { connector: _omit, ...entry } = validEntry;
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects missing routing field', () => {
    const { routing: _omit, ...entry } = validEntry;
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects negative rateLimits values', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: -1, tokensPerMinute: 100 },
    };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  it('rejects zero rateLimits values (must be positive when present)', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: 0, tokensPerMinute: 100 },
    };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

describe('CatalogResponseSchema', () => {
  const validResponse = {
    models: [validEntry],
    generatedAt: new Date().toISOString(),
    count: 1,
  };

  it('accepts a valid response', () => {
    const result = CatalogResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it('accepts empty models array', () => {
    const result = CatalogResponseSchema.safeParse({ ...validResponse, models: [], count: 0 });
    expect(result.success).toBe(true);
  });

  it('rejects non-ISO-8601 generatedAt', () => {
    const result = CatalogResponseSchema.safeParse({
      ...validResponse,
      generatedAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative count', () => {
    const result = CatalogResponseSchema.safeParse({ ...validResponse, count: -1 });
    expect(result.success).toBe(false);
  });
});

describe('CatalogFiltersSchema', () => {
  it('parses free=true', () => {
    const result = CatalogFiltersSchema.safeParse({ free: 'true' });
    expect(result.success).toBe(true);
    expect(result.data?.free).toBe(true);
  });

  it('parses free=1', () => {
    const result = CatalogFiltersSchema.safeParse({ free: '1' });
    expect(result.success).toBe(true);
    expect(result.data?.free).toBe(true);
  });

  it('parses free="" (empty string = flag present)', () => {
    const result = CatalogFiltersSchema.safeParse({ free: '' });
    expect(result.success).toBe(true);
    expect(result.data?.free).toBe(true);
  });

  it('parses free=false as false', () => {
    const result = CatalogFiltersSchema.safeParse({ free: 'false' });
    expect(result.success).toBe(true);
    expect(result.data?.free).toBe(false);
  });

  it('parses absent free as false', () => {
    const result = CatalogFiltersSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.free).toBe(false);
  });

  it('parses cheap=true', () => {
    const result = CatalogFiltersSchema.safeParse({ cheap: 'true' });
    expect(result.success).toBe(true);
    expect(result.data?.cheap).toBe(true);
  });

  it('parses valid capability filter values', () => {
    for (const cap of CAPABILITY_FILTER_VALUES) {
      const result = CatalogFiltersSchema.safeParse({ capability: cap });
      expect(result.success, `capability=${cap}`).toBe(true);
      expect(result.data?.capability).toBe(cap);
    }
  });

  it('rejects unknown capability value', () => {
    const result = CatalogFiltersSchema.safeParse({ capability: 'supportsUnicorns' });
    expect(result.success).toBe(false);
  });

  it('parses empty filters object (no active filters)', () => {
    const result = CatalogFiltersSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.free).toBe(false);
    expect(result.data?.cheap).toBe(false);
    expect(result.data?.capability).toBeUndefined();
  });
});
