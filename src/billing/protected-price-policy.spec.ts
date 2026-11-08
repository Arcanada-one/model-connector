import { describe, expect, it } from 'vitest';

import {
  NATIVE_PRICING_UNAVAILABLE,
  PROTECTED_PRICE_REVISION_MISMATCH,
  deriveProtectedPricePolicyRevision,
  isTrustedPricedRow,
  resolveProtectedPricePolicy,
} from './protected-price-policy';
import {
  ceilUsdToLedgerPrecision,
  estimateProtectedHoldUsd,
  protectedInputTokenUpperBound,
} from './protected-cost-estimate';
import { estimateCostUsd } from './cost-estimate';

const PAID_FP = 'a'.repeat(64);
const FREE_FP = 'b'.repeat(64);
const ROUTE_A = 'connectors/mock/protected/execute';
const ROUTE_B = 'connectors/mock/protected/prepare';
const NOW = new Date('2026-11-08T22:00:00.000Z');
const FRESH_AT = new Date('2026-11-08T21:30:00.000Z'); // 30m old
const STALE_AT = new Date('2026-11-08T20:00:00.000Z'); // 2h old

function freshAuthority<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    observedAt: FRESH_AT,
    freshness: 'fresh' as const,
    authoritative: true as const,
  };
}

const paidRow = freshAuthority({
  connector: 'mock',
  model: 'paid-m',
  tier: 'paid',
  inputPerMTok: 10,
  outputPerMTok: 30,
  contentFingerprint: PAID_FP,
  snapshotId: 'snap-paid',
});

const freeRow = freshAuthority({
  connector: 'mock',
  model: 'free-m',
  tier: 'free',
  free: true,
  inputPerMTok: 0,
  outputPerMTok: 0,
  contentFingerprint: FREE_FP,
  snapshotId: 'snap-free',
});

describe('resolveProtectedPricePolicy', () => {
  it('refuses when the catalogue is unreadable', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: false,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      connectorForwardsMaxTokens: true,
      maxTokens: 2_000,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('refuses an uncatalogued / unpriced model', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: null,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      connectorForwardsMaxTokens: true,
      maxTokens: 2_000,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('positive paid: server pins catalog revision and a positive hold', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 4_000,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.pricePolicyRevision).toBe(deriveProtectedPricePolicyRevision(paidRow, ROUTE_A));
    expect(result.pricePolicyRevision.startsWith('catalog:')).toBe(true);
    expect(result.pricePolicyRevision).not.toBe(`catalog:${PAID_FP}`);
    expect(result.positivelyZero).toBe(false);
    expect(Number(result.holdUsd)).toBeGreaterThan(0);
    expect(result.assumedOutputTokens).toBe(2_000);
  });

  it('positive zero: server pins zero:catalog revision and a zero hold', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freeRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 4_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.pricePolicyRevision).toBe(deriveProtectedPricePolicyRevision(freeRow, ROUTE_A));
    expect(result.pricePolicyRevision.startsWith('zero:catalog:')).toBe(true);
    expect(result.pricePolicyRevision).not.toBe(`zero:catalog:${FREE_FP}`);
    expect(result.positivelyZero).toBe(true);
    expect(result.holdUsd).toBe('0.000000');
  });

  it('client zero: label for a paid model is refused (never a zero hold)', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 4_000,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      clientRevision: 'zero:attacker-free',
      now: NOW,
    });
    expect(result.outcome).toBe('mismatch');
    if (result.outcome !== 'mismatch') return;
    expect(result.code).toBe(PROTECTED_PRICE_REVISION_MISMATCH);
    expect(result.serverRevision.startsWith('catalog:')).toBe(true);
    expect(result.serverRevision.startsWith('zero:')).toBe(false);
  });

  it('matching client revision is accepted', () => {
    const server = deriveProtectedPricePolicyRevision(paidRow, ROUTE_A);
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 4_000,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      clientRevision: server,
      now: NOW,
    });
    expect(result.outcome).toBe('resolved');
  });

  it('unknown tier refuses', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freshAuthority({
        ...paidRow,
        tier: 'unknown',
        inputPerMTok: null,
        outputPerMTok: null,
      }),
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      connectorForwardsMaxTokens: true,
      maxTokens: 2_000,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
  });

  it('partial-null output tariff refuses (hard bound; never under-holds)', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freshAuthority({
        ...paidRow,
        inputPerMTok: 3,
        outputPerMTok: null,
      }),
      routeKey: ROUTE_A,
      inputTokenUpperBound: 4_000,
      maxTokens: 4096,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('route-bound pin: same row, routes A and B differ; same route is stable', () => {
    const a1 = deriveProtectedPricePolicyRevision(paidRow, ROUTE_A);
    const a2 = deriveProtectedPricePolicyRevision(paidRow, ROUTE_A);
    const b1 = deriveProtectedPricePolicyRevision(paidRow, ROUTE_B);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a1.startsWith('catalog:')).toBe(true);
    expect(b1.startsWith('catalog:')).toBe(true);
    expect(a1).not.toBe(`catalog:${PAID_FP}`);
    expect(b1).not.toBe(`catalog:${PAID_FP}`);
  });

  it('M-HOLD: non-zero-priced row whose estimate is 0 is refused (hold > 0 bound)', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freshAuthority({
        ...paidRow,
        inputPerMTok: 10,
        outputPerMTok: 0,
      }),
      routeKey: ROUTE_A,
      inputTokenUpperBound: 0,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-NULLZERO: paid-tier both-null refuses; never a zero: pin', () => {
    const row = freshAuthority({
      ...paidRow,
      tier: 'paid',
      free: false,
      inputPerMTok: null,
      outputPerMTok: null,
    });
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 4_000,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
    const revision = deriveProtectedPricePolicyRevision(row, ROUTE_A);
    expect(revision.startsWith('zero:')).toBe(false);
  });

  it('M-OUTCAP: missing max_tokens refuses with NATIVE_PRICING_UNAVAILABLE', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-OUTCAP: connector that does not forward max_tokens refuses', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: false,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-ROUNDDOWN: a tiny positive cost rounds up and never to 0.000000', () => {
    // 1 input token @ 0.1 / MTok → 1e-7 USD; toFixed(6) would become 0.000000.
    const raw = estimateProtectedHoldUsd({
      inputTokenUpperBound: 1,
      outputTokenCap: 0,
      inputPerMTok: 0.1,
      outputPerMTok: 0,
    });
    expect(raw).toBeGreaterThan(0);
    expect(raw).toBeLessThan(0.0000005);
    expect(raw.toFixed(6)).toBe('0.000000');
    const hold = ceilUsdToLedgerPrecision(raw);
    expect(hold).toBe('0.000001');

    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freshAuthority({
        ...paidRow,
        inputPerMTok: 0.1,
        outputPerMTok: 0,
      }),
      routeKey: ROUTE_A,
      inputTokenUpperBound: 1,
      maxTokens: 1,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    // outputPerMTok 0 + tiny input may still resolve if hold > 0 after ceil
    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.holdUsd).toBe('0.000001');
      expect(result.holdUsd).not.toBe('0.000000');
    }
  });

  it('M-INBOUND: UTF-8 upper bound holds at no less than bytes (beats chars/4)', () => {
    // Single-byte separators: "a a a a" → 7 chars → chars/4 = 2 tokens;
    // UTF-8 bytes = 7 tokens upper bound.
    const prompt = 'a a a a';
    const bytes = protectedInputTokenUpperBound({ prompt });
    expect(bytes).toBe(7);
    const legacyTokens = Math.ceil(prompt.length / 4);
    expect(legacyTokens).toBe(2);

    const row = freshAuthority({
      ...paidRow,
      inputPerMTok: 1_000_000, // $1 per token
      outputPerMTok: 0,
    });
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row,
      routeKey: ROUTE_A,
      inputTokenUpperBound: bytes,
      maxTokens: 1,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(Number(result.holdUsd)).toBeGreaterThanOrEqual(7);

    // Multibyte: one Cyrillic char is 2 UTF-8 bytes → bound ≥ 2, chars/4 = 1.
    const multi = 'я';
    expect(protectedInputTokenUpperBound({ prompt: multi })).toBe(2);
    expect(Math.ceil(multi.length / 4)).toBe(1);
  });

  it('M-STALE: stale row is refused', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        ...paidRow,
        observedAt: STALE_AT,
        freshness: 'fresh',
        authoritative: true,
      },
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-STALE: row without provenance is refused', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        connector: 'mock',
        model: 'paid-m',
        tier: 'paid',
        inputPerMTok: 10,
        outputPerMTok: 30,
        contentFingerprint: PAID_FP,
        snapshotId: 'snap-paid',
        // no observedAt / freshness / authoritative
      },
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
  });

  it('fresh authoritative row is admitted', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('resolved');
  });

  it('M-NEG: negative input rate refuses', () => {
    expect(
      isTrustedPricedRow(
        freshAuthority({
          ...paidRow,
          inputPerMTok: -3,
          outputPerMTok: 15,
        }),
      ),
    ).toBe(false);
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freshAuthority({
        ...paidRow,
        inputPerMTok: -3,
        outputPerMTok: 15,
      }),
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
  });

  it('M-NEG: zero input / negative output refuses', () => {
    expect(
      isTrustedPricedRow(
        freshAuthority({
          ...paidRow,
          inputPerMTok: 0,
          outputPerMTok: -1,
        }),
      ),
    ).toBe(false);
  });

  it('legacy estimateCostUsd behaviour is unchanged (chars/4 + 2000 floor)', () => {
    const pricing = { inputPerMTok: 10, outputPerMTok: 30 };
    expect(estimateCostUsd(100, pricing)).toBe(estimateCostUsd(100, pricing, {}));
    expect(estimateCostUsd(100, pricing, { maxTokens: 1 })).toBe(estimateCostUsd(100, pricing));
    const withLarge = estimateCostUsd(100, pricing, { maxTokens: 64_000 });
    expect(withLarge).toBeGreaterThan(estimateCostUsd(100, pricing));
  });

  it('M-JSONOBJ-RF: server-set response_format json_object increases the input bound', () => {
    const prompt = 'hello';
    const without = protectedInputTokenUpperBound({ prompt });
    const withRf = protectedInputTokenUpperBound({
      prompt,
      responseFormat: { type: 'json_object' },
    });
    expect(withRf).toBeGreaterThan(without);
    expect(withRf - without).toBe(
      Buffer.byteLength(JSON.stringify({ type: 'json_object' }), 'utf8'),
    );
  });

  it('M-SYSPROMPT: large system prompt strictly increases the hold', () => {
    const prompt = 'hello';
    const systemPrompt = 'S'.repeat(2_000);
    const withoutSys = protectedInputTokenUpperBound({ prompt });
    const withSys = protectedInputTokenUpperBound({ prompt, systemPrompt });
    expect(withSys).toBeGreaterThan(withoutSys);

    const row = freshAuthority({
      ...paidRow,
      inputPerMTok: 1_000_000,
      outputPerMTok: 0,
    });
    const base = resolveProtectedPricePolicy({
      catalogReadable: true,
      row,
      routeKey: ROUTE_A,
      inputTokenUpperBound: withoutSys,
      maxTokens: 1,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    const larger = resolveProtectedPricePolicy({
      catalogReadable: true,
      row,
      routeKey: ROUTE_A,
      inputTokenUpperBound: withSys,
      maxTokens: 1,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(base.outcome).toBe('resolved');
    expect(larger.outcome).toBe('resolved');
    if (base.outcome !== 'resolved' || larger.outcome !== 'resolved') return;
    expect(Number(larger.holdUsd)).toBeGreaterThan(Number(base.holdUsd));
  });

  it('M-AUTH: authoritative false fresh row is refused', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        ...paidRow,
        observedAt: FRESH_AT,
        freshness: 'fresh',
        authoritative: false,
      },
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-FRESHENUM: static freshness observed 1 min ago is refused', () => {
    const oneMinuteAgo = new Date(NOW.getTime() - 60_000);
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        ...paidRow,
        observedAt: oneMinuteAgo,
        freshness: 'static',
        authoritative: true,
      },
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-FRESHENUM: stale-labelled row observed 1 min ago is refused', () => {
    const oneMinuteAgo = new Date(NOW.getTime() - 60_000);
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        ...paidRow,
        observedAt: oneMinuteAgo,
        freshness: 'stale',
        authoritative: true,
      },
      routeKey: ROUTE_A,
      inputTokenUpperBound: 100,
      maxTokens: 2_000,
      connectorForwardsMaxTokens: true,
      now: NOW,
    });
    expect(result.outcome).toBe('unavailable');
  });
});
