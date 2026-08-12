// CONN-0243 — OpenAI-compatible facade. Lets an unmodified OpenAI-shaped client
// (Hermes custom provider, coworker, any OpenAI SDK) point base_url at MC and get a
// completion served by the free-first cross-provider failover chain. The global
// AuthGuard applies (Authorization: Bearer <MC key>) — these routes are NOT @Public.

import { Body, Controller, Get, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  openAiChatCompletionRequestSchema,
  OpenAiChatCompletionRequest,
} from './dto/openai-chat.dto';
import { toConnectorRequest, toOpenAiChatCompletion, toOpenAiModelList } from './openai-translate';
import { FailoverRouterService } from '../connectors/failover/failover-router.service';
import { FailoverExhaustedError, FailoverAbortError } from '../connectors/failover/failover.errors';
import { ConnectorsService } from '../connectors/connectors.service';
import { ConnectorResponse } from '../connectors/interfaces/connector.interface';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

// ConnectorResponse.error.type → OpenAI-style HTTP status for the /v1 surface.
const HTTP_ERROR_STATUS: Record<string, HttpStatus> = {
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  circuit_open: HttpStatus.SERVICE_UNAVAILABLE,
  auth_error: HttpStatus.SERVICE_UNAVAILABLE,
  queue_timeout: HttpStatus.SERVICE_UNAVAILABLE,
  unsupported_modality: HttpStatus.BAD_REQUEST,
  validation_error: HttpStatus.BAD_REQUEST,
  // CONN-1665 — per-key access policy denial / server-side policy misconfiguration.
  policy_violation: HttpStatus.FORBIDDEN,
  config_error: HttpStatus.INTERNAL_SERVER_ERROR,
};

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function openAiError(message: string, type: string, status: HttpStatus, code?: string): never {
  throw new HttpException({ error: { message, type, code: code ?? null } }, status);
}

@Controller()
export class OpenAiCompatController {
  constructor(
    private readonly failoverRouter: FailoverRouterService,
    private readonly connectorsService: ConnectorsService,
  ) {}

  /**
   * POST /v1/chat/completions — OpenAI-compatible chat completion with transparent
   * free-first cross-provider failover (DeepSeek first) on 429 / 5xx / connection errors.
   */
  @Post('v1/chat/completions')
  async chatCompletions(
    @Body(new ZodValidationPipe(openAiChatCompletionRequestSchema))
    body: OpenAiChatCompletionRequest,
    @Req() req: AuthenticatedRequest,
  ) {
    // Streaming and tool-calling are not yet supported on the failover surface —
    // reject explicitly rather than silently degrade (consilium R-F5/R-F6).
    if (body.stream === true) {
      openAiError(
        'Streaming responses (stream:true) are not supported by the Model Connector failover gateway yet.',
        'unsupported',
        HttpStatus.BAD_REQUEST,
        'stream_unsupported',
      );
    }
    if (body.tools !== undefined || body.tool_choice !== undefined) {
      openAiError(
        'Tool/function calling is not supported by the Model Connector failover gateway yet.',
        'unsupported',
        HttpStatus.BAD_REQUEST,
        'tools_unsupported',
      );
    }

    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const { request, requestedModel } = toConnectorRequest(body);

    let response: ConnectorResponse;
    try {
      response = await this.failoverRouter.complete(request, apiKeyId, { requestedModel });
    } catch (err) {
      // Abort-class error from a candidate — surface its real status (e.g. validation_error
      // → 400, auth_error → 503), not a generic cascade_exhausted 503 (QA D1 / PRD §7).
      if (err instanceof FailoverAbortError) {
        const status = HTTP_ERROR_STATUS[err.errorType] ?? HttpStatus.BAD_GATEWAY;
        openAiError(err.message, err.errorType, status, err.errorType);
      }
      if (err instanceof FailoverExhaustedError) {
        openAiError(err.message, 'cascade_exhausted', HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw err;
    }

    if (response.status !== 'success') {
      const errorType = response.error?.type ?? 'api_error';
      const status = HTTP_ERROR_STATUS[errorType] ?? HttpStatus.BAD_GATEWAY;
      openAiError(
        response.error?.message ?? 'Upstream provider error',
        errorType,
        status,
        errorType,
      );
    }

    return toOpenAiChatCompletion(response, nowUnixSeconds());
  }

  /**
   * GET /v1/models — OpenAI-compatible model list. Built from in-memory connector
   * capabilities (no getCatalog network probes — R-F3); chat models only.
   * CONN-1665 — filtered by the caller's per-key access policy (provider +
   * model gates; under free-only, unknown-catalog-tier models are omitted).
   */
  @Get('v1/models')
  async listModels(@Req() req: AuthenticatedRequest) {
    const capabilities = await this.connectorsService.listCapabilitiesForKey(req.apiKey?.id);
    return toOpenAiModelList(capabilities, nowUnixSeconds());
  }
}
