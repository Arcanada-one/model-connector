// AUP-CACHE-006 (enforce0) — pre-warm endpoint.
//
// POST /v1/prompt-cache/prewarm sends the caller's stable prefix (L0–L3 as a
// raw Messages API body) with `max_tokens: 0`, which the platform permits as a
// cache write / TTL refresh (contract `official_facts.pre_warm`,
// `ttl_policy.keep_warm`). The request goes through ConnectorsService.execute()
// like any other — the same choke point, the same policy evaluation, the same
// billing — so a pre-warm can never bypass what a real step could not pass.
// A pre-warm that violates the contract is refused in enforce mode and marked
// in observe mode exactly like a step (the contract: "it must itself pass the
// linter").

import { Body, Controller, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ConnectorsService } from '../connectors/connectors.service';
import { ConnectorResponse } from '../connectors/interfaces/connector.interface';
import { MESSAGES_API_PASSTHROUGH_KEYS } from './messages-api';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

const passthroughShape = Object.fromEntries(
  [...MESSAGES_API_PASSTHROUGH_KEYS].map((key) => [key, z.unknown().optional()]),
);

export const PrewarmRequestSchema = z
  .object({
    /** Only the Anthropic connector speaks the Messages API in enforce0. */
    connector: z.literal('anthropic').default('anthropic'),
    model: z.string().min(1).max(200),
    /** The raw Messages API fields of the stable prefix (tools, system, messages …). */
    messages_api: z.object(passthroughShape).strict(),
    prompt_cache: z
      .object({
        session_id: z.string().min(1).max(200).optional(),
        session_epoch: z.string().min(1).max(200).optional(),
        prefix_hash: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PrewarmRequest = z.infer<typeof PrewarmRequestSchema>;

const HTTP_STATUS: Record<string, HttpStatus> = {
  policy_violation: HttpStatus.FORBIDDEN,
  validation_error: HttpStatus.BAD_REQUEST,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  circuit_open: HttpStatus.SERVICE_UNAVAILABLE,
  auth_error: HttpStatus.SERVICE_UNAVAILABLE,
  queue_timeout: HttpStatus.SERVICE_UNAVAILABLE,
  provider_not_routable: HttpStatus.FORBIDDEN,
  credit_depleted: HttpStatus.PAYMENT_REQUIRED,
};

@Controller('v1/prompt-cache')
export class PromptCachePrewarmController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Post('prewarm')
  async prewarm(
    @Body(new ZodValidationPipe(PrewarmRequestSchema)) body: PrewarmRequest,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const response: ConnectorResponse = await this.connectors.execute(
      body.connector,
      {
        // The prompt field is CONN's own record of the request (logging, the
        // pre-dispatch cost estimate); the provider body is `messages_api`.
        prompt: '[prompt-cache pre-warm]',
        model: body.model,
        maxRetries: 0,
        extra: {
          max_tokens: 0,
          messages_api: body.messages_api,
          ...(body.prompt_cache ? { prompt_cache: body.prompt_cache } : {}),
        },
      },
      apiKeyId,
    );
    if (response.status !== 'success') {
      const type = response.error?.type ?? 'api_error';
      throw new HttpException(response, HTTP_STATUS[type] ?? HttpStatus.BAD_GATEWAY);
    }
    return {
      prewarm: true,
      id: response.id,
      connector: response.connector,
      model: response.model,
      usage: response.usage,
      latencyMs: response.latencyMs,
      promptCachePolicy: response.promptCachePolicy ?? null,
    };
  }
}
