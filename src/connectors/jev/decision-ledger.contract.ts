import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Wire / storage schema name for CONN-JEV-06 DecisionLedger/v1. */
export const DECISION_LEDGER_VERSION = 'DecisionLedger/v1' as const;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/)
  .refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s));

/**
 * DecisionLedger/v1 — material decision facts (JEV-DECISION-LAYER-SPEC §15).
 * Raw `state` is never stored; digests of input, template and route identify the row.
 */
export const DecisionLedgerSchema = z
  .object({
    version: z.literal(DECISION_LEDGER_VERSION),
    decisionId: z.string().uuid(),
    identityDigest: sha256Hex,
    decisionType: identifier,
    templateRef: z.string().min(1).max(256),
    policyVersion: z.string().min(1).max(128),
    route: z.string().min(1).max(128),
    modelRequested: z.string().min(1).max(256),
    modelObserved: z.string().min(1).max(256).nullable(),
    providerRequestId: z.string().min(1).max(256).nullable(),
    stateDigest: sha256Hex,
    templateDigest: sha256Hex,
    routeDigest: sha256Hex,
    candidateSetDigest: sha256Hex.nullable(),
    answers: z.record(z.string(), z.unknown()),
    verdict: z.enum(['observed', 'unknown', 'not_measured']),
    policyAction: z.string().min(1).max(64),
    suppressedPermissive: z.boolean(),
    abstained: z.boolean(),
    latencyMs: z.number().int().nonnegative(),
    usageMissing: z.boolean(),
    /** NULL when no machine price (AC-15). Never invent 0 for unpriced. */
    costUsd: z.number().finite().nullable(),
    cacheHit: z.enum(['hit', 'miss', 'disabled']),
    traceId: z.string().min(1).max(128).nullable(),
    caller: z.string().min(1).max(128).nullable(),
    stateLang: z.enum(['en', 'ru', 'mixed']),
    outcome: z.string().min(1).max(128).nullable(),
    requestId: z.string().uuid().nullable(),
    apiKeyId: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((row, ctx) => {
    // AC-15 negative: cost_usd must be null when the meter did not observe usage.
    // A measured zero (e.g. costSource=zero-usage) is allowed; unpriced settles
    // must store null via ledgerCostUsd, never a fabricated 0.
    if (row.usageMissing && row.costUsd !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'costUsd must be null when usageMissing is true',
        path: ['costUsd'],
      });
    }
  });

export type DecisionLedgerV1 = z.infer<typeof DecisionLedgerSchema>;

export function sha256Utf8(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical JSON for digesting template / candidate sets (sort keys, no spaces). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, (v as Record<string, unknown>)[k]]),
      );
    }
    return v;
  });
}

/**
 * Identity of a material decision: digests of input (state), template, and route.
 * Replay of the same triple MUST map to one ledger row.
 */
export function decisionIdentityDigest(input: {
  stateDigest: string;
  templateDigest: string;
  route: string;
}): string {
  return sha256Utf8(`${input.stateDigest}\0${input.templateDigest}\0${input.route}`);
}

/** Deterministic language label from Cyrillic share in state (§6.3 / §15). */
export function detectStateLang(state: string): 'en' | 'ru' | 'mixed' {
  let letters = 0;
  let cyr = 0;
  for (const ch of state) {
    if (/[A-Za-zА-Яа-яЁё]/.test(ch)) {
      letters += 1;
      if (/[А-Яа-яЁё]/.test(ch)) cyr += 1;
    }
  }
  if (letters === 0) return 'en';
  const ratio = cyr / letters;
  if (ratio >= 0.6) return 'ru';
  if (ratio <= 0.15) return 'en';
  return 'mixed';
}

/**
 * Resolve costUsd for ledger storage.
 * Unpriced / usage-missing → null (never fabricate 0).
 */
export function ledgerCostUsd(input: {
  usageMissing: boolean;
  costUsd: number;
  costSource: string | null | undefined;
}): number | null {
  if (input.usageMissing) return null;
  if (input.costSource === 'unpriced' || input.costSource == null) return null;
  return input.costUsd;
}
