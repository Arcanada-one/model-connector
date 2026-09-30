import { BadRequestException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { ConnectorsService } from '../connectors.service';
import {
  DecisionRequest,
  DecisionRequestSchema,
  DecisionResult,
  unknownDecision,
} from './decision.contract';

/** Every request crosses the same provider/key policy, budget and billing gates as /execute. */
@Injectable()
export class DecisionService {
  constructor(
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  async evaluate(request: DecisionRequest, apiKeyId: string): Promise<DecisionResult> {
    const parsed = DecisionRequestSchema.safeParse(request);
    if (!parsed.success || !apiKeyId) throw new BadRequestException('Invalid decision request');
    const response = await this.connectors.execute(
      'typesafe-jev',
      {
        prompt: JSON.stringify(parsed.data),
        model: parsed.data.model,
        maxRetries: 0,
        timeout: 15000,
      },
      apiKeyId,
    );
    if (response.status !== 'success') return unknownDecision(parsed.data, 'connector_unavailable');
    // Only the registered native adapter authors this structured result.
    const result = response.structured as DecisionResult | undefined;
    if (
      !result ||
      result.version !== 'DecisionResult/v1' ||
      result.mode !== 'shadow' ||
      result.action !== 'none'
    ) {
      return unknownDecision(parsed.data, 'invalid_response');
    }
    return result;
  }
}
