import { describe, expect, it } from 'vitest';
import {
  DecisionLedgerSchema,
  canonicalJson,
  decisionIdentityDigest,
  detectStateLang,
  ledgerCostUsd,
  sha256Utf8,
} from './decision-ledger.contract';

const stateDigest = sha256Utf8('state');
const templateDigest = sha256Utf8('template');
const route = 'typesafe-jev/direct';
const base = {
  version: 'DecisionLedger/v1' as const,
  decisionId: '11111111-1111-4111-8111-111111111111',
  identityDigest: decisionIdentityDigest({ stateDigest, templateDigest, route }),
  decisionType: 'task-routing',
  templateRef: 'fixture-v1',
  policyVersion: 'fixture-v1',
  route,
  modelRequested: 'jev-latest',
  modelObserved: 'jev-fixture',
  providerRequestId: 'resp-1',
  stateDigest,
  templateDigest,
  routeDigest: sha256Utf8(route),
  candidateSetDigest: null,
  answers: { tier: { primitive: 'choice', choice: 'small', confidence: 0.6, probabilities: null } },
  verdict: 'observed' as const,
  policyAction: 'none',
  suppressedPermissive: false,
  abstained: false,
  latencyMs: 12,
  usageMissing: false,
  costUsd: null as number | null,
  cacheHit: 'disabled' as const,
  traceId: null,
  caller: null,
  stateLang: 'en' as const,
  outcome: null,
  requestId: '22222222-2222-4222-8222-222222222222',
  apiKeyId: 'fixture-key',
};

describe('DecisionLedger/v1 contract', () => {
  it('accepts a complete §15 row with digests of input, template and route', () => {
    const row = DecisionLedgerSchema.parse(base);
    expect(row.version).toBe('DecisionLedger/v1');
    expect(row.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.templateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.routeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.identityDigest).toBe(
      decisionIdentityDigest({
        stateDigest: row.stateDigest,
        templateDigest: row.templateDigest,
        route: row.route,
      }),
    );
  });

  it('refuses costUsd when usageMissing (AC-15 / A2-223 class)', () => {
    const bad = { ...base, usageMissing: true, costUsd: 0 };
    expect(DecisionLedgerSchema.safeParse(bad).success).toBe(false);
  });

  it('allows costUsd null when usage is missing', () => {
    expect(
      DecisionLedgerSchema.parse({ ...base, usageMissing: true, costUsd: null }).costUsd,
    ).toBeNull();
  });

  it('allows measured costUsd 0 (zero-usage) when usage is present', () => {
    expect(DecisionLedgerSchema.parse({ ...base, usageMissing: false, costUsd: 0 }).costUsd).toBe(
      0,
    );
  });

  it('maps unpriced / missing usage to null cost (never invents 0)', () => {
    expect(ledgerCostUsd({ usageMissing: true, costUsd: 0, costSource: 'provider' })).toBeNull();
    expect(ledgerCostUsd({ usageMissing: false, costUsd: 0, costSource: 'unpriced' })).toBeNull();
    expect(ledgerCostUsd({ usageMissing: false, costUsd: 0.12, costSource: 'catalog' })).toBe(0.12);
  });

  it('identity digest is stable for identical input/template/route', () => {
    const a = decisionIdentityDigest({
      stateDigest: sha256Utf8('s'),
      templateDigest: sha256Utf8(canonicalJson({ q: 1 })),
      route: 'typesafe-jev/direct',
    });
    const b = decisionIdentityDigest({
      stateDigest: sha256Utf8('s'),
      templateDigest: sha256Utf8(canonicalJson({ q: 1 })),
      route: 'typesafe-jev/direct',
    });
    expect(a).toBe(b);
  });

  it('detects state language from Cyrillic share', () => {
    expect(detectStateLang('Synthetic local task')).toBe('en');
    expect(detectStateLang('Синтетическая локальная задача')).toBe('ru');
    expect(detectStateLang('Hello мир and more русский текст here')).toBe('mixed');
  });
});
