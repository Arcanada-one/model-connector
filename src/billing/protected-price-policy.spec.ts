import { describe, expect, it } from 'vitest';

import {
  NATIVE_PRICING_UNAVAILABLE,
  PROTECTED_PRICE_REVISION_MISMATCH,
  deriveProtectedPricePolicyRevision,
  resolveProtectedPricePolicy,
} from './protected-price-policy';

const PAID_FP = 'a'.repeat(64);
const FREE_FP = 'b'.repeat(64);

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
      routeKey: 'connectors/mock/protected/execute',
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
      routeKey: 'connectors/mock/protected/execute',
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
      routeKey: 'connectors/mock/protected/execute',
      promptLength: 4_000,
      maxTokens: 2_000,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.pricePolicyRevision).toBe(`catalog:${PAID_FP}`);
    expect(result.positivelyZero).toBe(false);
    expect(Number(result.holdUsd)).toBeGreaterThan(0);
  });

  it('positive zero: server pins zero:catalog revision and a zero hold', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: freeRow,
      routeKey: 'connectors/mock/protected/execute',
      promptLength: 4_000,
    });
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(result.pricePolicyRevision).toBe(`zero:catalog:${FREE_FP}`);
    expect(result.positivelyZero).toBe(true);
    expect(result.holdUsd).toBe('0.000000');
  });

  it('client zero: label for a paid model is refused (never a zero hold)', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: 'connectors/mock/protected/execute',
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
    const server = deriveProtectedPricePolicyRevision(paidRow, 'connectors/mock/protected/execute');
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: paidRow,
      routeKey: 'connectors/mock/protected/execute',
      promptLength: 4_000,
      clientRevision: server,
    });
    expect(result.outcome).toBe('resolved');
  });

  it('unknown tier refuses', () => {
    const result = resolveProtectedPricePolicy({
      catalogReadable: true,
      row: { ...paidRow, tier: 'unknown', inputPerMTok: null, outputPerMTok: null },
      routeKey: 'connectors/mock/protected/execute',
      promptLength: 100,
    });
    expect(result.outcome).toBe('unavailable');
  });
});
