import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ApiKeyPolicy } from '../../policy/policy.schema';
import type { ProviderKeyOverride } from '../../policy/provider-key.context';
import type { ConnectorRequest } from '../../connectors/interfaces/connector.interface';
import { spendContextSchema, type ProfileSpendPolicy, type SpendContext } from './policy';
import { buildDeepSeekRequestBody } from '../../connectors/deepseek/deepseek.connector';
import { moneyUnits, pricedUnits } from './money';

export class ProfileSpendError extends HttpException {
  constructor(code: string, status = HttpStatus.SERVICE_UNAVAILABLE) {
    super({ error: code }, status);
  }
}
export interface SpendRequest extends ConnectorRequest {
  idempotencyKey?: string;
  spendContext?: SpendContext;
  output_format?: unknown;
  firstDispatchMeasurement?: unknown;
}
export interface SpendPlan {
  accountId: string;
  ownerProfileId: string;
  clientKeyId: string;
  profileId: string;
  provider: string;
  credentialRef: string;
  credentialVersion: string;
  intentKey: string;
  digest: string;
  model: string;
  runId: string;
  operationId: string;
  routeEpoch: string;
  requestBytes: number;
  nodes: string[];
  at: Date;
  policy: ProfileSpendPolicy;
  tariff: ProfileSpendPolicy['providers'][string]['models'][string];
  reserve: bigint;
  inputBound: number;
  outputBound: number;
  request: SpendRequest;
  profileBindings: Record<string, string>;
}
export function prepareSpend(
  policy: ApiKeyPolicy,
  provider: string,
  request: SpendRequest,
  clientKeyId: string,
  credential: ProviderKeyOverride | null,
  at = new Date(),
): SpendPlan {
  const spend = policy.spend;
  if (
    !spend ||
    policy.policyVersion !== 2 ||
    !policy.profile ||
    !credential?.credentialRef ||
    !credential.credentialVersion
  )
    throw new ProfileSpendError('profile_spend_unavailable');
  const valid = (from: string, until: string) =>
    Date.parse(from) <= at.getTime() && at.getTime() < Date.parse(until);
  if (!valid(spend.effectiveFrom, spend.effectiveUntil))
    throw new ProfileSpendError('profile_spend_policy_stale');
  const config = spend.providers[provider];
  const tariff = request.model ? config?.models[request.model] : undefined;
  if (!tariff || !valid(tariff.validFrom, tariff.validUntil))
    throw new ProfileSpendError('profile_spend_tariff_unavailable');
  const context = spendContextSchema.safeParse(request.spendContext);
  if (
    !context.success ||
    !request.idempotencyKey ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(request.idempotencyKey)
  )
    throw new ProfileSpendError('profile_spend_context_required', HttpStatus.BAD_REQUEST);
  if (
    typeof request.prompt !== 'string' ||
    request.output_format !== undefined ||
    request.firstDispatchMeasurement !== undefined
  )
    throw new ProfileSpendError('profile_spend_unbounded_request', HttpStatus.BAD_REQUEST);
  // JEV does not forward a qualified finite output ceiling on this route.
  if (provider !== 'deepseek') throw new ProfileSpendError('profile_spend_bounds_unqualified');
  const output = request.extra?.max_tokens ?? tariff.maxOutputTokens;
  if (
    typeof output !== 'number' ||
    !Number.isSafeInteger(output) ||
    output < 1 ||
    output > tariff.maxOutputTokens
  )
    throw new ProfileSpendError('profile_spend_output_bound', HttpStatus.BAD_REQUEST);
  const capability = tariff.capability;
  if (
    !valid(capability.validFrom, capability.validUntil) ||
    capability.provider !== provider ||
    capability.model !== request.model ||
    tariff.inputTokenBound > capability.inputTokenCeiling ||
    output > capability.outputTokenCeiling ||
    tariff.maxPayloadBytes > capability.payloadByteCeiling
  )
    throw new ProfileSpendError('profile_spend_capability_unavailable');
  const reserve = pricedUnits(
    tariff.inputTokenBound,
    output,
    tariff.inputPerMTok,
    tariff.outputPerMTok,
  );
  for (const cap of [
    spend.client.dailyLimit,
    spend.client.monthlyLimit,
    spend.client.runLimit,
    config.dailyLimit,
    config.monthlyLimit,
  ])
    if (reserve > moneyUnits(cap))
      throw new ProfileSpendError('profile_spend_cap_exceeded', HttpStatus.TOO_MANY_REQUESTS);
  const providerRequest = {
    ...request,
    maxRetries: 0,
    extra: { ...request.extra, max_tokens: output },
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(buildDeepSeekRequestBody(providerRequest)));
  if (requestBytes > tariff.maxPayloadBytes)
    throw new ProfileSpendError('profile_spend_payload_bound', HttpStatus.BAD_REQUEST);
  const { idempotencyKey: _key, ...payload } = providerRequest;
  const digest = createHash('sha256')
    .update(JSON.stringify({ provider, request: payload }))
    .digest('hex');
  return {
    accountId: policy.profile.accountingBucket,
    ownerProfileId: policy.profile.id,
    clientKeyId,
    profileId: config.profileId,
    provider,
    credentialRef: credential.credentialRef,
    credentialVersion: credential.credentialVersion,
    intentKey: request.idempotencyKey,
    digest,
    model: request.model!,
    runId: context.data.runId,
    operationId: context.data.operationId,
    routeEpoch: context.data.routeEpoch,
    requestBytes,
    nodes: context.data.nodes,
    at,
    policy: spend,
    tariff,
    reserve,
    inputBound: tariff.inputTokenBound,
    outputBound: output,
    request: providerRequest,
    profileBindings: Object.fromEntries(
      Object.entries(spend.providers).map(([p, c]) => [p, c.profileId]),
    ),
  };
}
