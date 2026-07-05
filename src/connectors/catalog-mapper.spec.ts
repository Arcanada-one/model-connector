import { describe, it, expect } from 'vitest';
import { deriveTier, entryToRow, rowToEntry } from './catalog-mapper';
import type { CatalogModelEntry } from './dto/catalog.dto';
import type { ModelCatalogRow } from './catalog.repository';

function baseEntry(overrides: Partial<CatalogModelEntry> = {}): CatalogModelEntry {
  return {
    connector: 'groq',
    model: 'llama-3.3-70b-versatile',
    modality: 'chat',
    tags: ['modality:chat'],
    free: false,
    cheap: false,
    priceMultiplier: null,
    rateLimits: null,
    pricing: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: { supportsStreaming: false, supportsJsonSchema: true, supportsTools: true },
    routing: { connector: 'groq', model: 'llama-3.3-70b-versatile' },
    routable: true,
    available: true,
    ...overrides,
  };
}

function baseRow(overrides: Partial<ModelCatalogRow> = {}): ModelCatalogRow {
  return {
    id: 'row-1',
    connector: 'groq',
    model: 'llama-3.3-70b-versatile',
    modality: 'chat',
    status: 'online',
    lastChecked: new Date('2026-07-05T16:00:00.000Z'),
    supportsStreaming: false,
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
    firstSeen: new Date('2026-07-01T00:00:00.000Z'),
    lastSeen: new Date('2026-07-05T16:00:00.000Z'),
    absent: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-05T16:00:00.000Z'),
    ...overrides,
  };
}

describe('deriveTier (CONN-0245 — tier from REAL provider tariffs only)', () => {
  it('real pricing 0/0 -> free', () => {
    expect(deriveTier({ inputPerMTok: 0, outputPerMTok: 0, free: false })).toEqual({
      tier: 'free',
      free: true,
    });
  });

  it('real pricing > 0 -> paid, even if provider marks it free-ish elsewhere', () => {
    expect(deriveTier({ inputPerMTok: 0.59, outputPerMTok: 0.79, free: true })).toEqual({
      tier: 'paid',
      free: false,
    });
  });

  it('partial pricing (one side null) does NOT qualify for the real-pricing branch — falls through to free-flag/unknown', () => {
    // Spec requires BOTH input and output present to use the real-tariff
    // branch; a half-known price is not enough signal to call it 'paid'
    // (anti-fabrication — 'unknown' is the honest answer here).
    expect(deriveTier({ inputPerMTok: 0.5, outputPerMTok: null, free: false })).toEqual({
      tier: 'unknown',
      free: false,
    });
  });

  it('provider-native free flag used only when NO real pricing exists', () => {
    expect(deriveTier({ inputPerMTok: null, outputPerMTok: null, free: true })).toEqual({
      tier: 'free',
      free: true,
    });
  });

  it('no pricing and not provider-free -> unknown (never fabricate free)', () => {
    expect(deriveTier({ inputPerMTok: null, outputPerMTok: null, free: false })).toEqual({
      tier: 'unknown',
      free: false,
    });
  });

  it('CONN-0244 regression: MC-side price_multiplier must NOT leak into tier/free', () => {
    // priceMultiplier=0 (the old openmodel-catalogue "free" signal) is not even
    // a parameter of deriveTier — it is not consulted at all. A model with a
    // multiplier-implied "free" but no real 0/0 tariff and no provider-native
    // free flag must resolve to 'unknown', never 'free'.
    expect(deriveTier({ inputPerMTok: null, outputPerMTok: null, free: false })).toEqual({
      tier: 'unknown',
      free: false,
    });
  });
});

describe('entryToRow (CONN-0245 — cron write path)', () => {
  it('maps real pricing + tier + status + capabilities from the entry', () => {
    const entry = baseEntry({
      pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'per_1m_tokens' },
      free: true,
      available: true,
      contextWindow: 131072,
      maxOutputTokens: 32768,
    });
    const row = entryToRow(entry);
    expect(row.connector).toBe('groq');
    expect(row.model).toBe('llama-3.3-70b-versatile');
    expect(row.modality).toBe('chat');
    expect(row.status).toBe('online');
    expect(row.tier).toBe('free');
    expect(row.free).toBe(true);
    expect(row.inputPerMTok).toBe(0);
    expect(row.outputPerMTok).toBe(0);
    expect(row.contextWindow).toBe(131072);
    expect(row.maxOutputTokens).toBe(32768);
    expect(row.supportsStreaming).toBe(false);
    expect(row.supportsJsonSchema).toBe(true);
    expect(row.supportsTools).toBe(true);
    expect(row.lastChecked).toBeInstanceOf(Date);
  });

  it('status=offline when entry.available=false', () => {
    const row = entryToRow(baseEntry({ available: false }));
    expect(row.status).toBe('offline');
  });

  it('CONN-0244 regression: openmodel priceMultiplier=1 with NO real pricing must NEVER become free (unknown, not fabricated)', () => {
    // This is the exact shape of the CONN-0244 false-free bug: an MC-side
    // priceMultiplier that used to leak into `free`. entryToRow must ignore
    // priceMultiplier entirely and derive tier only from entry.pricing / the
    // provider-native free flag — with neither present, the honest answer is
    // 'unknown', NOT 'free' (the bug) and not a fabricated 'paid' either.
    const entry = baseEntry({
      connector: 'openmodel',
      model: 'deepseek-v4-flash',
      priceMultiplier: 1, // MC-side multiplier — must be ignored for tier
      free: false, // no real pricing, no provider-native free flag
      pricing: null,
    });
    const row = entryToRow(entry);
    expect(row.tier).toBe('unknown');
    expect(row.free).toBe(false);
  });

  it('CONN-0244 regression: openmodel with REAL paid tariffs persists as tier=paid (multiplier still ignored)', () => {
    const entry = baseEntry({
      connector: 'openmodel',
      model: 'deepseek-r2',
      priceMultiplier: 1, // MC-side multiplier — must be ignored for tier
      free: false,
      pricing: { inputPerMTok: 0.3, outputPerMTok: 0.3, unit: 'per_1m_tokens' },
    });
    const row = entryToRow(entry);
    expect(row.tier).toBe('paid');
    expect(row.free).toBe(false);
  });

  it('endpoint null when routing.endpoint absent; executableHere derived from modality', () => {
    const chat = entryToRow(baseEntry({ modality: 'chat' }));
    expect(chat.endpoint).toBeNull();
    expect(chat.executableHere).toBe(true);

    const stt = entryToRow(
      baseEntry({
        modality: 'speech_to_text',
        routing: { connector: 'groq', model: 'whisper-large-v3', endpoint: '/v1/speech/stt' },
      }),
    );
    expect(stt.endpoint).toBe('/v1/speech/stt');
    expect(stt.executableHere).toBe(false);
  });

  it('priceUnit falls back to the schema default when entry.pricing is null', () => {
    const row = entryToRow(baseEntry({ pricing: null }));
    expect(row.priceUnit).toBe('USD/1M tokens');
  });

  it('priceUnit uses the entry pricing unit when present', () => {
    const row = entryToRow(
      baseEntry({ pricing: { inputPerMTok: 1, outputPerMTok: 2, unit: 'per_1m_tokens' } }),
    );
    expect(row.priceUnit).toBe('per_1m_tokens');
  });

  // QA FIX B (Finding 1) — priceMultiplier persists verbatim (write path).
  describe('priceMultiplier persistence (QA FIX B)', () => {
    it('persists entry.priceMultiplier verbatim, independent of tier/free', () => {
      const row = entryToRow(baseEntry({ priceMultiplier: 1 }));
      expect(row.priceMultiplier).toBe(1);
    });

    it('persists null when the entry has no multiplier data', () => {
      const row = entryToRow(baseEntry({ priceMultiplier: null }));
      expect(row.priceMultiplier).toBeNull();
    });

    it('a real 0 multiplier persists as 0, not null (never collapse a genuine 0)', () => {
      const row = entryToRow(baseEntry({ priceMultiplier: 0 }));
      expect(row.priceMultiplier).toBe(0);
    });
  });

  // ── CONN-0245-EXT — routable persists CONN-0244's access.use verbatim ──
  describe('routable (CONN-0245-EXT)', () => {
    it('defaults useEnabled=true when omitted (back-compat — no behavior change pre-READ/USE)', () => {
      const row = entryToRow(baseEntry({ modality: 'chat' }));
      expect(row.routable).toBe(true);
    });

    it('useEnabled=false -> routable=false, independent of executableHere', () => {
      const row = entryToRow(baseEntry({ modality: 'chat' }), { useEnabled: false });
      expect(row.routable).toBe(false);
      // executableHere is a pure function of modality — independent of useEnabled.
      expect(row.executableHere).toBe(true);
    });

    it('useEnabled=true persists routable=true even for a non-executableHere modality (routable is pure access.use, not ANDed with executableHere)', () => {
      const row = entryToRow(
        baseEntry({
          modality: 'image_generation',
          routing: { connector: 'grok', model: 'grok-imagine-image', endpoint: '/images/generate' },
        }),
        { useEnabled: true },
      );
      expect(row.routable).toBe(true);
      expect(row.executableHere).toBe(false);
    });

    it('useEnabled=true AND executableHere -> routable=true', () => {
      const row = entryToRow(baseEntry({ modality: 'chat' }), { useEnabled: true });
      expect(row.routable).toBe(true);
    });

    it('CONN-0245-EXT headline case: an OpenModel-style entry with real (non-free) pricing and USE=off persists as routable=false, tier from real tariffs (not free)', () => {
      const row = entryToRow(
        baseEntry({
          connector: 'openmodel',
          model: 'deepseek-v4-flash',
          modality: 'chat',
          priceMultiplier: 1, // MC-side multiplier — irrelevant, ignored
          free: false,
          pricing: { inputPerMTok: 0.3, outputPerMTok: 0.6, unit: 'per_1m_tokens' },
          available: false, // buildCatalogSnapshot already ANDs in routable — USE=off means available:false there too
        }),
        { useEnabled: false },
      );
      expect(row.tier).toBe('paid'); // real tariffs, never false-free
      expect(row.free).toBe(false);
      expect(row.routable).toBe(false);
      expect(row.status).toBe('offline'); // entry.available was already false
    });
  });
});

describe('rowToEntry (CONN-0245 — getCatalog read path)', () => {
  it('reconstructs a CatalogModelEntry with the same field names/types as the legacy assembly', () => {
    const row = baseRow({
      tier: 'free',
      free: true,
      inputPerMTok: 0,
      outputPerMTok: 0,
      priceUnit: 'per_1m_tokens',
      contextWindow: 131072,
      maxOutputTokens: 32768,
    });
    const entry = rowToEntry(row);
    expect(entry.connector).toBe('groq');
    expect(entry.model).toBe('llama-3.3-70b-versatile');
    expect(entry.modality).toBe('chat');
    expect(entry.free).toBe(true);
    expect(entry.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0, unit: 'per_1m_tokens' });
    expect(entry.contextWindow).toBe(131072);
    expect(entry.maxOutputTokens).toBe(32768);
    expect(entry.capabilities).toEqual({
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
    });
    expect(entry.routing).toEqual({ connector: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(entry.available).toBe(true);
    expect(entry.tags).toContain('modality:chat');
    expect(entry.tags).toContain('cost:free');
    expect(entry.rateLimits).toBeNull();
  });

  it('available reflects row.status === "online" (breaker/reachability already baked in at snapshot time)', () => {
    expect(rowToEntry(baseRow({ status: 'online' })).available).toBe(true);
    expect(rowToEntry(baseRow({ status: 'offline' })).available).toBe(false);
  });

  // ── CONN-0245-EXT — routable = useEnabled && executableHere; available = status==='online' && routable ──
  describe('routable / access:read-only tag (CONN-0245-EXT / CONN-0244)', () => {
    it('routable=true: no access:read-only tag; available reflects status only', () => {
      const entry = rowToEntry(baseRow({ status: 'online', routable: true }));
      expect(entry.tags).not.toContain('access:read-only');
      expect(entry.available).toBe(true);
    });

    it('routable=false: access:read-only tag present (CatalogModelEntry itself has no `routable` field — CONN-0244 never added one)', () => {
      const entry = rowToEntry(baseRow({ status: 'online', routable: false }));
      expect(entry.tags).toContain('access:read-only');
      expect(entry).not.toHaveProperty('routable');
    });

    it('available comes straight from status (already encodes routable at cron-persist time via entryToRow) — status=offline -> available=false regardless of the routable tag', () => {
      const entry = rowToEntry(baseRow({ status: 'offline', routable: false }));
      expect(entry.available).toBe(false);
      expect(entry.tags).toContain('access:read-only');
    });

    it('CONN-0245-EXT headline case: OpenModel-style row — READ-visible, real (non-free) tier, access:read-only tag, available=false', () => {
      const row = baseRow({
        connector: 'openmodel',
        model: 'deepseek-v4-flash',
        status: 'offline', // buildCatalogSnapshot already ANDs routable into available/status
        tier: 'paid',
        free: false,
        inputPerMTok: 0.3,
        outputPerMTok: 0.6,
        priceUnit: 'per_1m_tokens',
        routable: false, // USE=off — persisted from CONN-0244's access.use
      });
      const entry = rowToEntry(row);
      // present: true — this IS a row findAll() returns (it passed the READ
      // gate at cron time; only readEnabled=false rows are excluded upstream).
      expect(entry.connector).toBe('openmodel');
      expect(entry.free).toBe(false); // real tariffs -> NOT falsely free
      expect(entry.tags).not.toContain('cost:free');
      expect(entry.tags).toContain('access:read-only');
      expect(entry.available).toBe(false);
    });
  });

  it('pricing is null when both inputPerMTok and outputPerMTok are null', () => {
    const entry = rowToEntry(baseRow({ inputPerMTok: null, outputPerMTok: null }));
    expect(entry.pricing).toBeNull();
  });

  it('routing.endpoint included only when the row has one (non-chat families)', () => {
    const withEndpoint = rowToEntry(baseRow({ endpoint: '/v1/speech/stt' }));
    expect(withEndpoint.routing.endpoint).toBe('/v1/speech/stt');
    const withoutEndpoint = rowToEntry(baseRow({ endpoint: null }));
    expect(withoutEndpoint.routing.endpoint).toBeUndefined();
  });

  // QA FIX B (Finding 1) — priceMultiplier/cheap round-trip the DB exactly,
  // restoring the pre-CONN-0245 (origin) formula byte-for-byte instead of
  // fabricating priceMultiplier from tier or collapsing cheap to ≡ free.
  describe('priceMultiplier / cheap round-trip (QA FIX B)', () => {
    it('priceMultiplier passes through the persisted value verbatim (not derived from tier)', () => {
      expect(
        rowToEntry(baseRow({ tier: 'free', free: true, priceMultiplier: 0 })).priceMultiplier,
      ).toBe(0);
      expect(
        rowToEntry(baseRow({ tier: 'paid', free: false, priceMultiplier: 1 })).priceMultiplier,
      ).toBe(1);
      expect(
        rowToEntry(baseRow({ tier: 'unknown', free: false, priceMultiplier: null }))
          .priceMultiplier,
      ).toBeNull();
    });

    it('cheap = free || (priceMultiplier !== null && priceMultiplier <= 1) — the exact origin/pre-CONN-0245 formula', () => {
      // free -> cheap regardless of multiplier
      expect(rowToEntry(baseRow({ free: true, priceMultiplier: null })).cheap).toBe(true);
      // paid but multiplier <= 1 (e.g. openmodel deepseek-r2) -> cheap
      expect(rowToEntry(baseRow({ free: false, priceMultiplier: 1 })).cheap).toBe(true);
      // paid with multiplier > 1 -> NOT cheap
      expect(rowToEntry(baseRow({ free: false, priceMultiplier: 2 })).cheap).toBe(false);
      // paid, no multiplier data at all -> NOT cheap (never fabricated)
      expect(rowToEntry(baseRow({ free: false, priceMultiplier: null })).cheap).toBe(false);
    });

    it('CONN-0244 false-free regression survives the round-trip: a real-paid multiplier=1 model is cheap but NEVER free', () => {
      const entry = rowToEntry(
        baseRow({
          connector: 'openmodel',
          model: 'deepseek-v4-flash',
          tier: 'paid',
          free: false,
          priceMultiplier: 1,
        }),
      );
      expect(entry.free).toBe(false);
      expect(entry.cheap).toBe(true);
      expect(entry.tags).not.toContain('cost:free');
      expect(entry.tags).toContain('cost:cheap');
    });
  });
});
