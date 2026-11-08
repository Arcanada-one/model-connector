import { describe, expect, it } from 'vitest';

import {
  NATIVE_PRICING_UNAVAILABLE,
  PROTECTED_PRICE_REVISION_MISMATCH,
  deriveProtectedPricePolicyRevision,
  resolveProtectedPricePolicy,
} from './protected-price-policy';

const PAID_FP = 'a'.repeat(64);
const FREE_FP = 'b'.repeat(64);
const ROUTE_A = 'connectors/mock/protected/execute';
const ROUTE_B = 'connectors/mock/protected/prepare';

const paidRow = {
  connector: 'mock',
  model: 'paid-m',
  tier: 'paid',
  inputPerMTok: 10,
  outputPerMTok: 30,
  contentFingerprint: PAID_FP,
  snapshotId: 'snap-paid',
};

const freeRow = {
  connector: 'mock',
  model: 'free-m',
  tier: 'free',
  free: true,
  inputPerMTok: 0,
  outputPerMTok: 0,
  contentFingerprint: FREE_FP,
  snapshotId: 'snap-free',
};

describe('resolveProtectedPricePolicy', () => {
  it('refuses when the catalogue is unreadable', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: false,
      row: paidRow,
      routeKey: ROUTE_A,
      promptLength: 100,
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
      promptLength: 100,
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
      promptLength: 4_000,
      maxTokens: 2_000,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.pricePolicyRevision).toBe(deriveProtectedPricePolicyRevision(paidRow, ROUTE_A));
    expect(result.pricePolicyRevision.startsWith('catalog:')).toBe(true);
    expect(result.pricePolicyRevision).not.toBe(`catalog:${PAID_FP}`);
    expect(result.positivelyZero).toBe(false);
    expect(Number(result.holdUsd)).toBeGreaterThan(0);
  });

  it('positive zero: server pins zero:catalog revision and a zero hold', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freeRow,
      routeKey: ROUTE_A,
      promptLength: 4_000,
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
      promptLength: 4_000,
      clientRevision: 'zero:attacker-free',
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
      promptLength: 4_000,
      clientRevision: server,
    });
    expect(result.outcome).toBe('resolved');
  });

  it('unknown tier refuses', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: { ...paidRow, tier: 'unknown', inputPerMTok: null, outputPerMTok: null },
      routeKey: ROUTE_A,
      promptLength: 100,
    });
    expect(result.outcome).toBe('unavailable');
  });

  it('partial-null output tariff refuses (hard bound; never under-holds)', () => {
    // Coordinator probe: input 3 / output null at max_tokens 4096 previously
    // held ~0.003 vs ~0.0644 for the fully priced row.
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        ...paidRow,
        inputPerMTok: 3,
        outputPerMTok: null,
      },
      routeKey: ROUTE_A,
      promptLength: 4_000,
      maxTokens: 4096,
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
    // Fingerprint alone must not be the pin when contentFingerprint is set.
    expect(a1).not.toBe(`catalog:${PAID_FP}`);
    expect(b1).not.toBe(`catalog:${PAID_FP}`);
  });

  it('M-HOLD: non-zero-priced row whose estimate is 0 is refused (hold > 0 bound)', () => {
    // input priced, output explicitly 0, empty prompt → estimate 0, not positivelyZero.
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: {
        ...paidRow,
        inputPerMTok: 10,
        outputPerMTok: 0,
      },
      routeKey: ROUTE_A,
      promptLength: 0,
      maxTokens: 2_000,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
  });

  it('M-NULLZERO: paid-tier both-null refuses; never a zero: pin', () => {
    const row = {
      ...paidRow,
      tier: 'paid',
      free: false,
      inputPerMTok: null,
      outputPerMTok: null,
    };
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row,
      routeKey: ROUTE_A,
      promptLength: 4_000,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
    // Even the revision helper must not mint a zero: pin for this row.
    const revision = deriveProtectedPricePolicyRevision(row, ROUTE_A);
    expect(revision.startsWith('zero:')).toBe(false);
  });
});
