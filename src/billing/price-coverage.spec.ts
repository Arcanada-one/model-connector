/**
 * A2-223 — the ratchet: a routable paid model with no price makes this red.
 *
 * Two halves, and they fail for different reasons on purpose.
 *
 * 1. The RULE (`classifyPriceCoverage` / `auditPriceCoverage`) — pure, fast,
 *    and mutation-tested below. These are the assertions that prove the check
 *    can go red at all, which is the only thing that makes its green worth
 *    anything.
 * 2. The ROUTING TABLE sweep — walks the connectors `ConnectorsModule`
 *    actually registers, reading Nest's own DI metadata rather than a list
 *    maintained here, and audits every model each one advertises. A new paid
 *    model added to any connector reaches this test without anybody editing
 *    this test. That is the whole point: the previous state of the world was a
 *    connector shipping for months with `pricing: undefined` and nothing to
 *    notice.
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../connectors/connectors.module';
import type { ConnectorCapabilities } from '../connectors/interfaces/connector.interface';
import {
  auditPriceCoverage,
  classifyPriceCoverage,
  findWaiver,
  formatPriceCoverageAudit,
  PRICE_COVERAGE_ENUMERATION_GAPS,
  PRICE_COVERAGE_WAIVERS,
  type PriceCoverageWaiver,
  type RoutableModel,
} from './price-coverage';

const NOW = new Date('2026-09-23T00:00:00Z');
const LIVE: PriceCoverageWaiver[] = [
  {
    connector: 'acme',
    model: 'acme-1',
    reason: 'no published price',
    owner: 'test',
    expiresAtUtc: '2026-12-01T00:00:00Z',
  },
];
const paid = (over: Partial<RoutableModel> = {}): RoutableModel => ({
  connector: 'acme',
  model: 'acme-1',
  ...over,
});

describe('classifyPriceCoverage', () => {
  it('a tariff on either side is a price', () => {
    expect(
      classifyPriceCoverage(paid({ pricing: { inputPerMTok: 1, outputPerMTok: 2 } }), [], NOW),
    ).toBe('priced');
    // Some providers publish only a prompt rate. Half a price is still a price:
    // `measureCostUsd` bills the known side and contributes nothing for the
    // other, which is a number we stand behind.
    expect(classifyPriceCoverage(paid({ pricing: { inputPerMTok: 1 } }), [], NOW)).toBe('priced');
    expect(classifyPriceCoverage(paid({ pricing: { outputPerMTok: 2 } }), [], NOW)).toBe('priced');
  });

  it('an empty or null tariff is NOT a price', () => {
    expect(classifyPriceCoverage(paid({ pricing: null }), [], NOW)).toBe('missing');
    expect(classifyPriceCoverage(paid({ pricing: {} }), [], NOW)).toBe('missing');
    expect(
      classifyPriceCoverage(
        paid({ pricing: { inputPerMTok: null, outputPerMTok: null } }),
        [],
        NOW,
      ),
    ).toBe('missing');
    // NaN is what a bad parse produces, and it must not read as a tariff.
    expect(classifyPriceCoverage(paid({ pricing: { inputPerMTok: Number.NaN } }), [], NOW)).toBe(
      'missing',
    );
  });

  it("the provider's free flag is a known price of zero", () => {
    expect(classifyPriceCoverage(paid({ free: true }), [], NOW)).toBe('free');
    expect(classifyPriceCoverage(paid({ free: false }), [], NOW)).toBe('missing');
  });

  it('a subscription lane owes no tariff', () => {
    expect(classifyPriceCoverage(paid({ lane: 'subscription' }), [], NOW)).toBe('subscription');
    // and an api lane is the default, so omitting the lane must NOT excuse it
    expect(classifyPriceCoverage(paid({ lane: 'api' }), [], NOW)).toBe('missing');
    expect(classifyPriceCoverage(paid(), [], NOW)).toBe('missing');
  });

  it('a live waiver excuses; an expired one does not', () => {
    expect(classifyPriceCoverage(paid(), LIVE, NOW)).toBe('waived');
    expect(classifyPriceCoverage(paid(), LIVE, new Date('2026-12-02T00:00:00Z'))).toBe('missing');
    // exactly at the expiry the waiver is already spent
    expect(classifyPriceCoverage(paid(), LIVE, new Date('2026-12-01T00:00:00Z'))).toBe('missing');
  });

  it('a wildcard waiver covers the connector, and only that connector', () => {
    const wild: PriceCoverageWaiver[] = [{ ...LIVE[0], model: '*' }];
    expect(classifyPriceCoverage(paid({ model: 'acme-9' }), wild, NOW)).toBe('waived');
    expect(classifyPriceCoverage(paid({ connector: 'other' }), wild, NOW)).toBe('missing');
  });

  it('a price beats a waiver, so the waiver can be reported stale', () => {
    expect(classifyPriceCoverage(paid({ pricing: { inputPerMTok: 1 } }), LIVE, NOW)).toBe('priced');
  });

  it('findWaiver prefers the exact id over the wildcard', () => {
    const both: PriceCoverageWaiver[] = [
      { ...LIVE[0], model: '*', reason: 'wildcard' },
      { ...LIVE[0], model: 'acme-1', reason: 'exact' },
    ];
    expect(findWaiver({ connector: 'acme', model: 'acme-1' }, both, NOW)?.waiver.reason).toBe(
      'exact',
    );
  });
});

describe('auditPriceCoverage', () => {
  it('reports an unpriced paid model as missing, with an actionable message', () => {
    const audit = auditPriceCoverage([paid()], [], NOW);
    expect(audit.missing).toHaveLength(1);
    expect(audit.counts.missing).toBe(1);
    expect(formatPriceCoverageAudit(audit)).toContain('MISSING  acme/acme-1');
  });

  it('separates an expired waiver from a plain miss', () => {
    const audit = auditPriceCoverage([paid()], LIVE, new Date('2026-12-02T00:00:00Z'));
    expect(audit.missing).toHaveLength(0);
    expect(audit.expired).toHaveLength(1);
    expect(formatPriceCoverageAudit(audit)).toContain('EXPIRED  acme/acme-1');
  });

  it('reports a waiver whose model is priced now as stale', () => {
    const audit = auditPriceCoverage([paid({ pricing: { inputPerMTok: 1 } })], LIVE, NOW);
    expect(audit.stale).toHaveLength(1);
    expect(audit.missing).toHaveLength(0);
    expect(formatPriceCoverageAudit(audit)).toContain('STALE');
  });

  it('reports a waiver naming nothing in the routing table as dead', () => {
    const audit = auditPriceCoverage([paid({ connector: 'other', model: 'x' })], LIVE, NOW);
    expect(audit.dead).toHaveLength(1);
    expect(formatPriceCoverageAudit(audit)).toContain('DEAD');
  });

  it('a wildcard waiver is not stale while it still covers one unpriced model', () => {
    const wild: PriceCoverageWaiver[] = [{ ...LIVE[0], model: '*' }];
    const audit = auditPriceCoverage(
      [paid({ model: 'acme-1', pricing: { inputPerMTok: 1 } }), paid({ model: 'acme-2' })],
      wild,
      NOW,
    );
    expect(audit.stale).toHaveLength(0);
    expect(audit.counts.waived).toBe(1);
  });
});

/**
 * The routing table itself.
 *
 * `ConnectorsModule`'s `imports` are the modules whose `onModuleInit` calls
 * `ConnectorsService.register()`; each module's `providers` hold the connector
 * class. Reading both out of Nest's metadata is what makes this an enumeration
 * of what MC ROUTES rather than of what somebody remembered to list.
 */
function enumerateRoutingTable(): {
  entries: RoutableModel[];
  gaps: { connector: string; reason: string }[];
} {
  const entries: RoutableModel[] = [];
  const gaps: { connector: string; reason: string }[] = [];
  const modules: unknown[] = (Reflect.getMetadata('imports', ConnectorsModule) ?? []) as unknown[];

  for (const mod of modules) {
    if (typeof mod !== 'function') continue;
    const providers: unknown[] = (Reflect.getMetadata('providers', mod) ?? []) as unknown[];
    for (const provider of providers) {
      if (typeof provider !== 'function') continue;
      const proto = (provider as { prototype?: Record<string, unknown> }).prototype;
      if (typeof proto?.getCapabilities !== 'function') continue;

      let caps: ConnectorCapabilities;
      let lane: RoutableModel['lane'];
      try {
        const instance = new (provider as new () => {
          getCapabilities(): ConnectorCapabilities;
          billingLane?: RoutableModel['lane'];
        })();
        caps = instance.getCapabilities();
        lane = instance.billingLane;
      } catch (err) {
        gaps.push({
          connector: (provider as { name: string }).name,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const metas = caps.modelMeta ?? [];
      if (metas.length > 0) {
        for (const meta of metas) {
          entries.push({
            connector: caps.name,
            model: meta.id,
            lane,
            pricing: meta.pricing ?? null,
            free: meta.free,
            modality: meta.modality ?? null,
          });
        }
        continue;
      }
      // A connector with ids but no metas advertises models at no price at all
      // — the worst shape, and the one that must not slip through because the
      // richer field happens to be empty.
      for (const id of caps.models ?? []) {
        entries.push({ connector: caps.name, model: id, lane, pricing: null });
      }
    }
  }
  return { entries, gaps };
}

describe('the routing table itself', () => {
  const { entries, gaps } = enumerateRoutingTable();

  it('enumerates a non-trivial routing table (a silent empty sweep would pass everything)', () => {
    // The failure this guards against is the enumeration breaking — a Nest
    // metadata key renamed, say — and the audit then passing over nothing at
    // all. 20 connectors and 60 models were measured on 2026-09-23; the floor
    // is set well below that so a real removal does not trip it.
    const connectors = new Set(entries.map((e) => e.connector));
    expect(connectors.size).toBeGreaterThanOrEqual(15);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    expect(connectors.has('deepseek')).toBe(true);
    expect(connectors.has('anthropic')).toBe(true);
  });

  it('every connector that cannot be enumerated is declared, not swallowed', () => {
    const declared = new Set(PRICE_COVERAGE_ENUMERATION_GAPS.map((g) => g.connector));
    const undeclared = gaps.filter((g) => !declared.has(g.connector));
    expect(
      undeclared,
      `A connector in the routing table could not be enumerated and is not in ` +
        `PRICE_COVERAGE_ENUMERATION_GAPS. Its models are not_measured — neither proven ` +
        `priced nor proven unpriced — and that has to be written down:\n` +
        undeclared.map((g) => `  ${g.connector}: ${g.reason}`).join('\n'),
    ).toEqual([]);
  });

  it('every CLI connector declares its billing lane', () => {
    // `type: 'cli'` here always means a locally authenticated, seat-funded
    // binary, and the default lane is 'api'. A new CLI connector that says
    // nothing would therefore be metered as cash against a catalogue tariff it
    // does not have — which is precisely how claude-code came to book
    // $120.363277 of notional charges. Forcing the declaration is cheaper than
    // finding it in the ledger.
    const { entries: all } = enumerateRoutingTable();
    const cliConnectors = new Set(
      all
        .filter((e) => ['claude-code', 'codex', 'cursor', 'gemini'].includes(e.connector))
        .map((e) => e.connector),
    );
    for (const name of cliConnectors) {
      const sample = all.find((e) => e.connector === name)!;
      expect(sample.lane, `${name} must declare billingLane`).toBe('subscription');
    }
  });

  it('every routable paid model has a price, a free flag, a seat, or a dated waiver', () => {
    const audit = auditPriceCoverage(entries, PRICE_COVERAGE_WAIVERS);
    const report = formatPriceCoverageAudit(audit);
    expect(
      report,
      `Price coverage over the routing table (${entries.length} models):\n` +
        JSON.stringify(audit.counts) +
        '\n' +
        report,
    ).toBe('');
  });
});
