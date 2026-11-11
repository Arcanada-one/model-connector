import { randomUUID } from 'node:crypto';
import type { ConnectorRequest, ConnectorResponse } from '../interfaces/connector.interface';
import type { CostSource } from '../../billing/measured-cost';
import {
  DecisionLedgerSchema,
  DecisionLedgerV1,
  DECISION_LEDGER_VERSION,
  canonicalJson,
  decisionIdentityDigest,
  detectStateLang,
  ledgerCostUsd,
  sha256Utf8,
} from './decision-ledger.contract';
import { DecisionRequestSchema, type DecisionResult } from './decision.contract';

/** Default route id for the native typesafe-jev execute path (CONN-JEV-02 direct). */
export const TYPESAFE_JEV_DIRECT_ROUTE = 'typesafe-jev/direct';

export type DecisionLedgerTx = {
  decisionLedger: {
    createMany: (args: {
      data: Array<Record<string, unknown>>;
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
  };
};

/**
 * Build a validated DecisionLedger/v1 row from an execute settle.
 * Returns null when the prompt is not a DecisionRequest/v1 (non-decision traffic).
 */
export function buildDecisionLedgerRow(input: {
  response: ConnectorResponse;
  request: ConnectorRequest;
  apiKeyId: string;
  requestId: string;
  costSource: CostSource | null;
  route?: string;
}): DecisionLedgerV1 | null {
  const prompt = typeof input.request.prompt === 'string' ? input.request.prompt : null;
  if (!prompt) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(prompt);
  } catch {
    return null;
  }
  const parsed = DecisionRequestSchema.safeParse(parsedJson);
  if (!parsed.success) return null;

  const decisionReq = parsed.data;
  const route = input.route ?? TYPESAFE_JEV_DIRECT_ROUTE;
  const stateDigest = sha256Utf8(decisionReq.state);
  const templateDigest = sha256Utf8(canonicalJson(decisionReq.questions));
  const routeDigest = sha256Utf8(route);
  const identityDigest = decisionIdentityDigest({ stateDigest, templateDigest, route });

  const structured = input.response.structured as DecisionResult | undefined;
  const verdict: DecisionLedgerV1['verdict'] =
    structured?.status === 'observed'
      ? 'observed'
      : structured?.status === 'unknown'
        ? 'unknown'
        : input.response.status === 'success'
          ? 'unknown'
          : 'not_measured';

  const answers =
    structured && typeof structured.answers === 'object' && structured.answers
      ? (structured.answers as Record<string, unknown>)
      : {};
  const abstained = verdict !== 'observed' || Object.keys(answers).length === 0;
  const usageMissing = input.response.usage.usageMissing === true;
  const costUsd = ledgerCostUsd({
    usageMissing,
    costUsd: input.response.usage.costUsd,
    costSource: input.costSource ?? input.response.usage.costSource ?? null,
  });

  const row: DecisionLedgerV1 = {
    version: DECISION_LEDGER_VERSION,
    decisionId: randomUUID(),
    identityDigest,
    decisionType: decisionReq.decisionType,
    templateRef: decisionReq.policyId,
    policyVersion: decisionReq.policyId,
    route,
    modelRequested: decisionReq.model,
    modelObserved: structured?.observedModel ?? input.response.model ?? null,
    providerRequestId: input.response.id || null,
    stateDigest,
    templateDigest,
    routeDigest,
    candidateSetDigest: null,
    answers,
    verdict,
    policyAction: structured?.action ?? 'none',
    suppressedPermissive: false,
    abstained,
    latencyMs: Math.max(0, Math.round(input.response.latencyMs ?? 0)),
    usageMissing,
    costUsd,
    cacheHit: 'disabled',
    traceId: null,
    caller: null,
    stateLang: detectStateLang(decisionReq.state),
    outcome: null,
    requestId: input.requestId,
    apiKeyId: input.apiKeyId,
  };

  return DecisionLedgerSchema.parse(row);
}

/** Map a validated ledger row to the Prisma createMany payload. */
export function toPrismaDecisionLedgerData(row: DecisionLedgerV1): Record<string, unknown> {
  return {
    id: row.decisionId,
    version: row.version,
    identityDigest: row.identityDigest,
    decisionType: row.decisionType,
    templateRef: row.templateRef,
    policyVersion: row.policyVersion,
    route: row.route,
    modelRequested: row.modelRequested,
    modelObserved: row.modelObserved,
    providerRequestId: row.providerRequestId,
    stateDigest: row.stateDigest,
    templateDigest: row.templateDigest,
    routeDigest: row.routeDigest,
    candidateSetDigest: row.candidateSetDigest,
    answers: row.answers,
    verdict: row.verdict,
    policyAction: row.policyAction,
    suppressedPermissive: row.suppressedPermissive,
    abstained: row.abstained,
    latencyMs: row.latencyMs,
    usageMissing: row.usageMissing,
    costUsd: row.costUsd,
    cacheHit: row.cacheHit,
    traceId: row.traceId,
    caller: row.caller,
    stateLang: row.stateLang,
    outcome: row.outcome,
    requestId: row.requestId,
    apiKeyId: row.apiKeyId,
  };
}

/**
 * Persist DecisionLedger/v1 for typesafe-jev settles.
 * Idempotent: identical identityDigest → skipDuplicates (one row).
 * Returns inserted count (0 or 1), or null when not applicable.
 */
export async function recordDecisionLedgerIfApplicable(
  tx: DecisionLedgerTx,
  input: {
    response: ConnectorResponse;
    request: ConnectorRequest;
    apiKeyId: string;
    requestId: string;
    costSource: CostSource | null;
  },
): Promise<number | null> {
  if (input.response.connector !== 'typesafe-jev') return null;
  // Request.id is always a UUID in production; skip rather than fail settle on a fixture without one.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId,
    )
  ) {
    return null;
  }
  let row: ReturnType<typeof buildDecisionLedgerRow>;
  try {
    row = buildDecisionLedgerRow(input);
  } catch {
    // Never fail Request settle on a ledger shape problem; skip the row.
    return null;
  }
  if (!row) return null;
  const result = await tx.decisionLedger.createMany({
    data: [toPrismaDecisionLedgerData(row)],
    skipDuplicates: true,
  });
  return result.count;
}
