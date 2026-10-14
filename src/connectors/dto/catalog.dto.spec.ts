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

const schemaAccepts = (parse: () => unknown): boolean => {
  try {
    parse();
    return true;
  } catch {
    return false;
  }
};

describe('CatalogModelEntrySchema', () => {
  it('accepts a valid free model entry', () => {
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(validEntry))).toBe(true);
  });

  it('preserves validated snapshot provenance and legacy-null identity', () => {
    const observedAt = new Date('2026-07-26T13:00:00.000Z').toISOString();
    const current = CatalogModelEntrySchema.parse({
      ...validEntry,
      snapshotId: 'snapshot-1',
      contentFingerprint: 'a'.repeat(64),
      observedAt,
      source: 'provider-api',
      freshness: 'fresh',
    });
    const legacy = CatalogModelEntrySchema.parse({
      ...validEntry,
      snapshotId: null,
      contentFingerprint: null,
      observedAt,
      source: 'legacy-unknown',
      freshness: 'unknown',
    });

    expect(current.snapshotId).toBe('snapshot-1');
    expect(current.contentFingerprint).toBe('a'.repeat(64));
    expect(current.observedAt).toBe(observedAt);
    expect(current.source).toBe('provider-api');
    expect(current.freshness).toBe('fresh');
    expect(legacy.snapshotId).toBeNull();
    expect(legacy.contentFingerprint).toBeNull();
  });

  it('rejects fabricated provenance values and malformed fingerprints', () => {
    expect(
      schemaAccepts(() =>
        CatalogModelEntrySchema.parse({
          ...validEntry,
          snapshotId: 'snapshot-1',
          contentFingerprint: 'not-a-sha256',
          observedAt: new Date().toISOString(),
          source: 'guessed',
          freshness: 'probably-fresh',
        }),
      ),
    ).toBe(false);
  });

  it('accepts a paid model with priceMultiplier > 0', () => {
    const entry = { ...validEntry, free: false, cheap: false, priceMultiplier: 2 };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
  });

  it('accepts null priceMultiplier (unknown price)', () => {
    const entry = { ...validEntry, priceMultiplier: null };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
  });

  it('accepts non-null rateLimits when connector exposes them', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: 60, tokensPerMinute: 100_000 },
    };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
  });

  it('accepts partial rateLimits with null fields', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: null, tokensPerMinute: 100_000 },
    };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
  });

  it('rejects missing required connector field', () => {
    const { connector: _omit, ...entry } = validEntry;
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(false);
  });

  it('rejects missing routing field', () => {
    const { routing: _omit, ...entry } = validEntry;
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(false);
  });

  it('rejects negative rateLimits values', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: -1, tokensPerMinute: 100 },
    };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(false);
  });

  it('rejects zero rateLimits values (must be positive when present)', () => {
    const entry = {
      ...validEntry,
      rateLimits: { requestsPerMinute: 0, tokensPerMinute: 100 },
    };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(false);
  });
});

describe('CatalogResponseSchema', () => {
  const validResponse = {
    models: [validEntry],
    generatedAt: new Date().toISOString(),
    count: 1,
  };

  it('accepts a valid response', () => {
    expect(schemaAccepts(() => CatalogResponseSchema.parse(validResponse))).toBe(true);
  });

  it('accepts empty models array', () => {
    expect(
      schemaAccepts(() => CatalogResponseSchema.parse({ ...validResponse, models: [], count: 0 })),
    ).toBe(true);
  });

  it('rejects non-ISO-8601 generatedAt', () => {
    expect(
      schemaAccepts(() =>
        CatalogResponseSchema.parse({
          ...validResponse,
          generatedAt: 'not-a-date',
        }),
      ),
    ).toBe(false);
  });

  it('rejects negative count', () => {
    expect(schemaAccepts(() => CatalogResponseSchema.parse({ ...validResponse, count: -1 }))).toBe(
      false,
    );
  });
});

describe('CatalogFiltersSchema', () => {
  it('parses free=true', () => {
    expect(CatalogFiltersSchema.parse({ free: 'true' }).free).toBe(true);
  });

  it('parses free=1', () => {
    expect(CatalogFiltersSchema.parse({ free: '1' }).free).toBe(true);
  });

  it('parses free="" (empty string = flag present)', () => {
    expect(CatalogFiltersSchema.parse({ free: '' }).free).toBe(true);
  });

  it('parses free=false as false', () => {
    expect(CatalogFiltersSchema.parse({ free: 'false' }).free).toBe(false);
  });

  it('parses absent free as false', () => {
    expect(CatalogFiltersSchema.parse({}).free).toBe(false);
  });

  it('parses cheap=true', () => {
    expect(CatalogFiltersSchema.parse({ cheap: 'true' }).cheap).toBe(true);
  });

  it('parses valid capability filter values', () => {
    for (const cap of CAPABILITY_FILTER_VALUES) {
      expect(CatalogFiltersSchema.parse({ capability: cap }).capability).toBe(cap);
    }
  });

  it('rejects unknown capability value', () => {
    expect(
      schemaAccepts(() => CatalogFiltersSchema.parse({ capability: 'supportsUnicorns' })),
    ).toBe(false);
  });

  it('parses empty filters object (no active filters)', () => {
    const result = CatalogFiltersSchema.parse({});
    expect(result.free).toBe(false);
    expect(result.cheap).toBe(false);
    expect(result.capability).toBeUndefined();
  });
});

// ─── CONN-0232 — modality + tags + new filters ────────────────────────────────

describe('CatalogModelEntrySchema — modality + tags (CONN-0232)', () => {
  it('rejects an entry missing modality', () => {
    const { modality: _omit, ...rest } = validEntry;
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(rest))).toBe(false);
  });

  it('rejects an entry missing tags', () => {
    const { tags: _omit, ...rest } = validEntry;
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(rest))).toBe(false);
  });

  it('accepts every modality enum value', () => {
    for (const m of MODEL_MODALITY_VALUES) {
      const entry = { ...validEntry, modality: m };
      expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
    }
  });

  it('rejects an unknown modality', () => {
    const entry = { ...validEntry, modality: 'telepathy' };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(false);
  });

  it('accepts an optional routing.endpoint (honest non-chat path)', () => {
    const entry = {
      ...validEntry,
      modality: 'image_generation' as const,
      routing: { connector: 'vertex', model: 'vertex:imagen-4', endpoint: '/images/generate' },
    };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
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
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
  });

  it('accepts a moderation modality entry', () => {
    const entry = { ...validEntry, modality: 'moderation' as const };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
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
    const result = CatalogModelEntrySchema.parse(entry);
    expect(result.pricing?.inputPerMTok).toBe(0.59);
    expect(result.contextWindow).toBe(131072);
  });

  it('accepts null pricing fields (price unknown / non-token unit)', () => {
    const entry = {
      ...validEntry,
      pricing: { inputPerMTok: null, outputPerMTok: null, unit: 'per_1m_tokens' },
    };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(true);
  });

  it('rejects a non-positive contextWindow', () => {
    const entry = { ...validEntry, contextWindow: 0 };
    expect(schemaAccepts(() => CatalogModelEntrySchema.parse(entry))).toBe(false);
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
    expect(CatalogFiltersSchema.parse({ modality: 'image_generation' }).modality).toBe(
      'image_generation',
    );
  });

  it('rejects an unknown modality filter', () => {
    expect(schemaAccepts(() => CatalogFiltersSchema.parse({ modality: 'nope' }))).toBe(false);
  });

  it('parses connector / tag / group filters', () => {
    const result = CatalogFiltersSchema.parse({
      connector: 'groq',
      tag: 'cost:free',
      group: 'cost',
    });
    expect(result.connector).toBe('groq');
    expect(result.tag).toBe('cost:free');
    expect(result.group).toBe('cost');
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
