import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { normalizePerMTokPrice } from '../dto/catalog.dto';
import {
  OPENROUTER_TYPESAFE_JEV_MODELS_FIXTURE,
  assertRoutableAvailablePriceHonesty,
  buildJevCapabilityModelMeta,
  buildJevCatalogPriceRows,
  pricingMapFromDirectModelsProbe,
  pricingMapFromOpenRouterModels,
} from './jev.catalog-pricing';

describe('CONN-JEV-05 catalog pricing without invention', () => {
  it('normalises the measured OpenRouter fixture prompt to 0.042 $/MTok', () => {
    expect(normalizePerMTokPrice('0.000000042')).toBe(0.042);
    expect(normalizePerMTokPrice('0')).toBe(0);
  });

  it('AC-22: openrouter fixture yields decision metas with machine prices', () => {
    const map = pricingMapFromOpenRouterModels(OPENROUTER_TYPESAFE_JEV_MODELS_FIXTURE);
    const priced = map.get('typesafe/jev-1.13');
    expect(priced?.pricing).toEqual({
      inputPerMTok: 0.042,
      outputPerMTok: 0,
      unit: 'per_1m_tokens',
    });

    const rows = buildJevCatalogPriceRows({
      env: {},
      directModelsProbe: null,
      openRouterModels: map,
    });
    const openrouter = rows.filter((r) => r.route === 'openrouter');
    expect(openrouter.length).toBeGreaterThan(0);
    for (const row of openrouter) {
      expect(row.provenance).toBe('openrouter-models-fixture');
      expect(row.pricing?.inputPerMTok).toBe(0.042);
      expect(row.pricing?.outputPerMTok).toBe(0);
      expect(row.contextWindow).toBe(32_000);
      expect(row.available).toBe(false); // stub until keyed
    }

    const metas = buildJevCapabilityModelMeta({
      env: {},
      openRouterModels: map,
    });
    const orMeta = metas.find((m) => m.id === 'typesafe/jev-1.13');
    expect(orMeta?.modality).toBe('decision');
    expect(orMeta?.pricing?.inputPerMTok).toBe(0.042);
  });

  it('AC-22: direct stays pricing null when the /v1/models probe has no price fields', () => {
    const probe = {
      data: [{ id: 'jev-latest', context_length: 32_000 }],
    };
    const map = pricingMapFromDirectModelsProbe(probe);
    expect(map.get('jev-latest')?.pricing).toBeNull();

    const rows = buildJevCatalogPriceRows({
      env: {
        TYPESAFE_API_KEY: 'synthetic',
        TYPESAFE_JEV_ROUTES_ENABLED: 'direct',
      },
      directModelsProbe: probe,
    });
    const direct = rows.filter((r) => r.route === 'direct');
    expect(direct.every((r) => r.pricing === null)).toBe(true);
    expect(direct.every((r) => r.provenance === 'direct-models-unconfirmed')).toBe(true);
    expect(direct.every((r) => r.contextWindow === 32_000)).toBe(true);
  });

  it('direct adopts machine prices only when the probe publishes them', () => {
    const probe = {
      data: [
        {
          id: 'jev-latest',
          pricing: { prompt: '0.0000001', completion: '0' },
          context_length: 64_000,
        },
      ],
    };
    const rows = buildJevCatalogPriceRows({
      env: { TYPESAFE_API_KEY: 'synthetic', TYPESAFE_JEV_ROUTES_ENABLED: 'direct' },
      directModelsProbe: probe,
    });
    const latest = rows.find((r) => r.model === 'jev-latest');
    expect(latest?.provenance).toBe('direct-models-probe');
    expect(latest?.pricing?.inputPerMTok).toBe(0.1);
    expect(latest?.pricing?.outputPerMTok).toBe(0);
    expect(latest?.contextWindow).toBe(64_000);
  });

  it('on-disk fixture is marked and matches the in-module fragment', () => {
    const path = resolve(
      __dirname,
      '../../../test/fixtures/connectors/openrouter-typesafe-jev-models.fixture.json',
    );
    const disk = JSON.parse(readFileSync(path, 'utf8')) as {
      _fixture_provenance: string;
      data: Array<{ id: string; pricing: { prompt: string; completion: string } }>;
    };
    expect(disk._fixture_provenance).toContain('Fixture-marked');
    expect(disk._fixture_provenance).toContain('CONN-JEV-05');
    const sample = disk.data.find((e) => e.id === 'typesafe/jev-1.13');
    expect(sample?.pricing.prompt).toBe('0.000000042');
    expect(normalizePerMTokPrice(sample?.pricing.prompt)).toBe(0.042);
  });

  it('negative control: available:true openrouter row without machine price fails honesty', () => {
    const honest = buildJevCatalogPriceRows({ env: {} });
    expect(assertRoutableAvailablePriceHonesty(honest).ok).toBe(true);

    const forged = honest.map((row) =>
      row.route === 'openrouter' && row.model === 'typesafe/jev-1.13'
        ? {
            ...row,
            available: true,
            pricing: null,
            provenance: 'openrouter-models-fixture' as const,
          }
        : row,
    );
    const check = assertRoutableAvailablePriceHonesty(forged);
    expect(check.ok).toBe(false);
    expect(check.violations.some((v) => v.includes('typesafe/jev-1.13'))).toBe(true);
  });

  it('never hardcodes 0.042 outside a machine/fixture source', () => {
    const rows = buildJevCatalogPriceRows({
      env: {},
      openRouterModels: new Map(), // empty machine source
    });
    const openrouter = rows.filter((r) => r.route === 'openrouter');
    // Without the fixture map, prices must be null — inventing 0.042 would fail AC-22.
    expect(openrouter.every((r) => r.pricing === null)).toBe(true);
  });
});
