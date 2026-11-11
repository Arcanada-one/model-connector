import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DecisionService } from '../connectors/jev/decision.service';
import type { DecisionRequest, DecisionResult } from '../connectors/jev/decision.contract';
import { PublicDecisionRequestDto, resolveTemplateIdentity } from './dto/decision-request.dto';
import { validateTemplateRequest } from './templates';

export type PublicDecisionResponse = {
  schema: 'DecisionResult/v1';
  decision_id: string;
  template_ref: { id: string; version: number };
  state_digest: string;
  /** Connector-native shadow result (DecisionResult/v1 structured). */
  decision: DecisionResult;
};

@Injectable()
export class DecisionsRouteService {
  constructor(private readonly decisions: DecisionService) {}

  /**
   * Validate template+state before any provider call, then evaluate via DecisionService.
   * Returns null-provider path only after validation passes.
   */
  async handle(dto: PublicDecisionRequestDto, apiKeyId: string): Promise<PublicDecisionResponse> {
    if (!apiKeyId) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: 'unauthorized_key',
        message: 'API key required',
      });
    }

    const identity = resolveTemplateIdentity(dto);
    const hasInlineQuestions =
      dto.questions !== undefined || dto.instructions !== undefined || dto.criteria !== undefined;

    const validated = validateTemplateRequest({
      templateId: identity.id,
      templateVersion: identity.version,
      state: dto.state,
      templateParams: dto.template_params as Record<string, unknown> | undefined,
      hasInlineQuestions,
    });

    if (!validated.ok) {
      throw new BadRequestException({
        statusCode: 400,
        error_code: validated.code,
        message: validated.message,
      });
    }

    const template = validated.template;
    const stateDigest = createHash('sha256')
      .update(typeof dto.state === 'string' ? dto.state : JSON.stringify(dto.state))
      .digest('hex');

    const nativeState = typeof dto.state === 'string' ? dto.state : JSON.stringify(dto.state);

    const nativeRequest: DecisionRequest = {
      version: 'DecisionRequest/v1',
      mode: 'shadow',
      decisionType: dto.decision_type ?? template.id,
      policyId: 'conn-jev-07-v1',
      model: 'jev-latest',
      state: nativeState,
      questions: template.questions,
    };

    const decision = await this.decisions.evaluate(nativeRequest, apiKeyId);

    return {
      schema: 'DecisionResult/v1',
      decision_id: randomUUID(),
      template_ref: { id: template.id, version: template.version },
      state_digest: stateDigest,
      decision,
    };
  }
}
