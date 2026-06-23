import { describe, it, expect } from 'vitest';
import {
  CatalogModelEntrySchema,
  CatalogResponseSchema,
  CatalogFiltersSchema,
  CAPABILITY_FILTER_VALUES,
  MODEL_MODALITY_VALUES,
  buildDerivedTags,
  entryMatchesFilters,
  normalizePerMTokPrice,
  type CatalogModelEntry,
} from './catalog.dto';

// ─── CONN-0226 — catalog DTO schema unit tests ────────────────────────────────

const validEntry = {
  connector: 'openmodel',
  model: 'deepseek-v4-flash',
  modality: 'chat' as const,
  tags: ['modality:chat', 'cost:free', 'cost:cheap', 'cap:json-schema'],
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

// ─── CONN-0232 — modality + tags + new filters ────────────────────────────────

describe('CatalogModelEntrySchema — modality + tags (CONN-0232)', () => {
  it('rejects an entry missing modality', () => {
    const { modality: _omit, ...rest } = validEntry;
    expect(CatalogModelEntrySchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an entry missing tags', () => {
    const { tags: _omit, ...rest } = validEntry;
    expect(CatalogModelEntrySchema.safeParse(rest).success).toBe(false);
  });

  it('accepts every modality enum value', () => {
    for (const m of MODEL_MODALITY_VALUES) {
      const entry = { ...validEntry, modality: m };
      expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('rejects an unknown modality', () => {
    const entry = { ...validEntry, modality: 'telepathy' };
    expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('accepts an optional routing.endpoint (honest non-chat path)', () => {
    const entry = {
      ...validEntry,
      modality: 'image_generation' as const,
      routing: { connector: 'vertex', model: 'vertex:imagen-4', endpoint: '/images/generate' },
    };
    expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(true);
  });
});

// ─── CONN-0238 — new modalities (video / moderation) + pricing/context fields ──

describe('CONN-0238 — modality enum additions', () => {
  it('includes video (grok-imagine-video) and moderation (groq prompt-guard)', () => {
    expect(MODEL_MODALITY_VALUES).toContain('video');
    expect(MODEL_MODALITY_VALUES).toContain('moderation');
  });

  it('accepts a video modality entry', () => {
    const entry = { ...validEntry, modality: 'video' as const };
    expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts a moderation modality entry', () => {
    const entry = { ...validEntry, modality: 'moderation' as const };
    expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe('CONN-0238 — pricing / contextWindow / maxOutputTokens fields', () => {
  it('defaults the new fields to null when absent (back-compat)', () => {
    const parsed = CatalogModelEntrySchema.parse(validEntry);
    expect(parsed.pricing).toBeNull();
    expect(parsed.contextWindow).toBeNull();
    expect(parsed.maxOutputTokens).toBeNull();
  });

  it('accepts a per-1M-token pricing object with context + max-output', () => {
    const entry = {
      ...validEntry,
      pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79, unit: 'per_1m_tokens' },
      contextWindow: 131072,
      maxOutputTokens: 32768,
    };
    const result = CatalogModelEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    expect(result.data?.pricing?.inputPerMTok).toBe(0.59);
    expect(result.data?.contextWindow).toBe(131072);
  });

  it('accepts null pricing fields (price unknown / non-token unit)', () => {
    const entry = {
      ...validEntry,
      pricing: { inputPerMTok: null, outputPerMTok: null, unit: 'per_1m_tokens' },
    };
    expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('rejects a non-positive contextWindow', () => {
    const entry = { ...validEntry, contextWindow: 0 };
    expect(CatalogModelEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe('normalizePerMTokPrice (CONN-0238)', () => {
  it('normalises a per-token string to per-1M tokens (6dp, no float noise)', () => {
    expect(normalizePerMTokPrice('0.00000059')).toBe(0.59);
    expect(normalizePerMTokPrice('0.000000075')).toBe(0.075);
  });

  it('maps a literal "0" to 0 (genuinely free), not null', () => {
    expect(normalizePerMTokPrice('0')).toBe(0);
  });

  it('accepts a numeric per-token value too', () => {
    expect(normalizePerMTokPrice(0.00000059)).toBe(0.59);
  });

  it('returns null for absent / empty / non-numeric / non-finite input', () => {
    expect(normalizePerMTokPrice(undefined)).toBeNull();
    expect(normalizePerMTokPrice(null)).toBeNull();
    expect(normalizePerMTokPrice('')).toBeNull();
    expect(normalizePerMTokPrice('   ')).toBeNull();
    expect(normalizePerMTokPrice('not-a-number')).toBeNull();
    expect(normalizePerMTokPrice(Number.NaN)).toBeNull();
    expect(normalizePerMTokPrice(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('buildDerivedTags (CONN-0232)', () => {
  it('always includes the modality tag', () => {
    const tags = buildDerivedTags({
      modality: 'embedding',
      free: false,
      cheap: false,
      capabilities: { supportsStreaming: false, supportsJsonSchema: false, supportsTools: false },
    });
    expect(tags).toContain('modality:embedding');
  });

  it('derives cost + capability tags reproducibly', () => {
    const tags = buildDerivedTags({
      modality: 'chat',
      free: true,
      cheap: true,
      capabilities: { supportsStreaming: true, supportsJsonSchema: true, supportsTools: true },
    });
    expect(tags).toEqual([
      'modality:chat',
      'cost:free',
      'cost:cheap',
      'cap:streaming',
      'cap:tools',
      'cap:json-schema',
    ]);
  });

  it('omits cost/cap tags when the flags are false', () => {
    const tags = buildDerivedTags({
      modality: 'chat',
      free: false,
      cheap: false,
      capabilities: { supportsStreaming: false, supportsJsonSchema: false, supportsTools: false },
    });
    expect(tags).toEqual(['modality:chat']);
  });
});

describe('CatalogFiltersSchema — type/modality/connector/tag/group (CONN-0232)', () => {
  it('parses a valid modality filter', () => {
    const result = CatalogFiltersSchema.safeParse({ modality: 'image_generation' });
    expect(result.success).toBe(true);
    expect(result.data?.modality).toBe('image_generation');
  });

  it('rejects an unknown modality filter', () => {
    expect(CatalogFiltersSchema.safeParse({ modality: 'nope' }).success).toBe(false);
  });

  it('parses connector / tag / group filters', () => {
    const result = CatalogFiltersSchema.safeParse({
      connector: 'groq',
      tag: 'cost:free',
      group: 'cost',
    });
    expect(result.success).toBe(true);
    expect(result.data?.connector).toBe('groq');
    expect(result.data?.tag).toBe('cost:free');
    expect(result.data?.group).toBe('cost');
  });
});

describe('entryMatchesFilters (CONN-0232)', () => {
  const base: CatalogModelEntry = CatalogModelEntrySchema.parse(validEntry);
  const noFilters = { free: false, cheap: false } as ReturnType<typeof CatalogFiltersSchema.parse>;

  it('passes with no active filters', () => {
    expect(entryMatchesFilters(base, noFilters)).toBe(true);
  });

  it('modality filter excludes non-matching entries', () => {
    expect(entryMatchesFilters(base, { ...noFilters, modality: 'embedding' })).toBe(false);
    expect(entryMatchesFilters(base, { ...noFilters, modality: 'chat' })).toBe(true);
  });

  it('connector filter is exact', () => {
    expect(entryMatchesFilters(base, { ...noFilters, connector: 'groq' })).toBe(false);
    expect(entryMatchesFilters(base, { ...noFilters, connector: 'openmodel' })).toBe(true);
  });

  it('tag filter is exact membership', () => {
    expect(entryMatchesFilters(base, { ...noFilters, tag: 'cost:free' })).toBe(true);
    expect(entryMatchesFilters(base, { ...noFilters, tag: 'cost:expensive' })).toBe(false);
  });

  it('group filter is delimiter-safe prefix (cost does NOT match cost-something)', () => {
    const trap: CatalogModelEntry = { ...base, tags: ['cost-something:weird'] };
    expect(entryMatchesFilters(trap, { ...noFilters, group: 'cost' })).toBe(false);
    expect(entryMatchesFilters(base, { ...noFilters, group: 'cost' })).toBe(true);
    expect(entryMatchesFilters(base, { ...noFilters, group: 'cap' })).toBe(true);
  });
});
