import { intentPayloadFingerprint } from '../intent';
import { moneyUnits, pricedUnits, utcPeriods } from './money';
import type { SpendEvent } from './envelope';
import type { PhysicalAttemptBinding } from './envelope-mirror';

/** Expected data must be enrolled by the authenticated consumer registry, before
 * importing this page. A self-consistent exported hash never establishes trust. */
export function assertSpendReliance(
  a: SpendEvent['attempt'],
  expected: PhysicalAttemptBinding,
): void {
  const fail = () => {
    throw new Error('spend_reliance_conflict');
  };
  for (const key of [
    'runId',
    'operationId',
    'routeEpoch',
    'provider',
    'model',
    'profileId',
    'credentialRef',
    'credentialVersion',
    'clientKeyId',
    'admittedAt',
    'digest',
  ] as const)
    if (a[key] !== expected[key]) fail();
  if (
    intentPayloadFingerprint(a.qualification) !== intentPayloadFingerprint(expected.qualification)
  )
    fail();
  const q = a.qualification,
    t = q.tariff,
    c = t.capability,
    policy = q.policy;
  const at = Date.parse(a.admittedAt);
  const valid = (from: string, until: string) => Date.parse(from) <= at && at < Date.parse(until);
  if (
    !valid(policy.effectiveFrom, policy.effectiveUntil) ||
    !valid(t.validFrom, t.validUntil) ||
    !valid(c.validFrom, c.validUntil) ||
    c.provider !== a.provider ||
    c.model !== a.model ||
    a.policyRevision !== policy.revision ||
    a.tariffRevision !== t.revision ||
    a.policyHash !== intentPayloadFingerprint(policy) ||
    a.tariffHash !== intentPayloadFingerprint(t) ||
    policy.providers[a.provider]?.profileId !== a.profileId ||
    intentPayloadFingerprint(policy.providers[a.provider]?.models[a.model]) !==
      intentPayloadFingerprint(t) ||
    q.inputTokenCeiling !== t.inputTokenBound ||
    q.inputTokenCeiling > c.inputTokenCeiling ||
    q.outputTokenCeiling > t.maxOutputTokens ||
    q.outputTokenCeiling > c.outputTokenCeiling ||
    q.payloadByteCeiling !== t.maxPayloadBytes ||
    q.payloadByteCeiling > c.payloadByteCeiling ||
    q.requestBytes > q.payloadByteCeiling ||
    BigInt(a.reserveNano) !==
      pricedUnits(q.inputTokenCeiling, q.outputTokenCeiling, t.inputPerMTok, t.outputPerMTok)
  )
    fail();
  if (a.servedModel !== null && a.servedModel !== a.model) fail();
  if (
    (a.inputTokens !== null && BigInt(a.inputTokens) > BigInt(q.inputTokenCeiling)) ||
    (a.outputTokens !== null && BigInt(a.outputTokens) > BigInt(q.outputTokenCeiling))
  )
    fail();
  if (a.observedNano !== null) {
    if (
      a.inputTokens === null ||
      a.outputTokens === null ||
      BigInt(a.inputTokens) > BigInt(q.inputTokenCeiling) ||
      BigInt(a.outputTokens) > BigInt(q.outputTokenCeiling) ||
      BigInt(a.observedNano) !==
        pricedUnits(Number(a.inputTokens), Number(a.outputTokens), t.inputPerMTok, t.outputPerMTok)
    )
      fail();
  }
  if (a.state === 'completed' && (a.observedNano === null || a.servedModel !== a.model)) fail();
  const p = utcPeriods(new Date(a.admittedAt));
  const limits = [
    policy.client.dailyLimit,
    policy.client.monthlyLimit,
    policy.providers[a.provider].dailyLimit,
    policy.providers[a.provider].monthlyLimit,
    policy.client.runLimit,
  ];
  const periods = [
    [p.dayStart, p.dayEnd],
    [p.monthStart, p.monthEnd],
    [p.dayStart, p.dayEnd],
    [p.monthStart, p.monthEnd],
    [new Date(policy.effectiveFrom), new Date(policy.effectiveUntil)],
  ];
  a.admissionCaps.forEach((cap, i) => {
    if (
      cap.observedAt !== a.admittedAt ||
      cap.policyRevision !== policy.revision ||
      BigInt(cap.limitNano) !== moneyUnits(limits[i]) ||
      BigInt(cap.exposureNano) < BigInt(a.reserveNano) ||
      BigInt(cap.exposureNano) > BigInt(cap.limitNano) ||
      cap.from !== periods[i][0].toISOString() ||
      cap.to !== periods[i][1].toISOString() ||
      cap.scope !== (i < 2 ? 'mc_client_currency' : i < 4 ? 'provider_profile' : 'run') ||
      cap.period !== (i === 4 ? 'run' : i % 2 === 0 ? 'day' : 'month') ||
      cap.profileId !== (i === 2 || i === 3 ? a.profileId : null) ||
      cap.runId !== (i === 4 ? a.runId : null)
    )
      fail();
  });
}
