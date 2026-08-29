import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ConnectorsService } from './connectors.service';
import { ConnectorResponse } from './interfaces/connector.interface';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  ExecuteRequestDto,
  executeRequestSchema,
  PerConnectorExecuteDto,
  perConnectorExecuteSchema,
  imageGenerateRequestSchema,
  ImageGenerateRequestDto,
} from './dto/execute.dto';
import { CatalogFiltersSchema } from './dto/catalog.dto';
import { ImageGenerationService } from './image-generation/image-generation.service';
import { IMAGE_CAPABILITIES } from './image-generation/capabilities';
import { CascadeRouterService } from './cascade/cascade-router.service';
import { CascadeExhaustedError, CascadeBudgetExceededError } from './cascade/cascade.errors';
import {
  IDEMPOTENCY_HEADER,
  InvalidIdempotencyKeyError,
  normalizeIdempotencyKey,
} from '../billing/intent';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

const HTTP_ERROR_STATUS: Record<string, HttpStatus> = {
  queue_timeout: HttpStatus.SERVICE_UNAVAILABLE,
  circuit_open: HttpStatus.SERVICE_UNAVAILABLE,
  auth_error: HttpStatus.SERVICE_UNAVAILABLE,
  binary_not_found: HttpStatus.SERVICE_UNAVAILABLE,
  // service_unavailable: durability condition (e.g. refresh_token_reused) that
  // routes to 503 without going through the auth_error / instant-open CB path.
  service_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  unsupported_modality: HttpStatus.BAD_REQUEST,
  // CONN-1665 — per-key access policy denial / server-side policy misconfiguration.
  policy_violation: HttpStatus.FORBIDDEN,
  config_error: HttpStatus.INTERNAL_SERVER_ERROR,
  // ARAS-0058 — idempotency outcomes get real status codes, because a client
  // library's retry logic branches on the status long before it reads the body.
  // A conflict returned as 200 would be retried as a success.
  idempotency_conflict: HttpStatus.CONFLICT,
  idempotency_key_reused: HttpStatus.UNPROCESSABLE_ENTITY,
  idempotency_replay_unavailable: HttpStatus.CONFLICT,
  request_cost_limit_exceeded: HttpStatus.BAD_REQUEST,
};

/**
 * ARAS-0058 — lift the caller's `Idempotency-Key` header onto the request.
 *
 * A malformed key is a 400, never a silent drop. Dropping it would leave the
 * caller believing they had an at-most-once guarantee they do not have, and
 * they would discover otherwise by being charged twice.
 */
function parseIdempotencyKey(raw: string | undefined): string | undefined {
  try {
    return normalizeIdempotencyKey(raw) ?? undefined;
  } catch (err) {
    if (err instanceof InvalidIdempotencyKeyError) {
      throw new HttpException(
        { error: 'validation_error', message: err.message },
        HttpStatus.BAD_REQUEST,
      );
    }
    throw err;
  }
}

@Controller()
export class ConnectorsController {
  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly imageGenerationService: ImageGenerationService,
    private readonly cascadeRouterService: CascadeRouterService,
  ) {}

  @Get('connectors')
  async listConnectors() {
    return this.connectorsService.listAll();
  }

  /**
   * GET /connectors/catalog — Universal model catalog across all connectors.
   *
   * Query params:
   *   free=true       Return only free-tier models.
   *   cheap=true      Return free + low-cost models (price_multiplier <= 1).
   *   capability=X    Return models whose connector supports X.
   *                   X ∈ supportsJsonSchema | supportsTools | supportsStreaming
   *   modality=M      Return only models of modality M (CONN-0232). `type=M` is
   *                   accepted as an alias and mapped to `modality`.
   *                   M ∈ chat | embedding | image_generation | speech_to_text |
   *                       text_to_speech | rerank
   *   connector=NAME  Return only models of that connector (CONN-0232).
   *   tag=T           Exact-match a single derived tag, e.g. cost:free (CONN-0232).
   *   group=G         Namespace-prefix match, e.g. group=cost → any cost:* (CONN-0232).
   *
   * Route must appear before /connectors/:name/status so Fastify does not
   * match the literal segment "catalog" as a :name parameter.
   */
  @Get('connectors/catalog')
  async getCatalog(@Query() rawQuery: Record<string, string>, @Req() req: AuthenticatedRequest) {
    // CONN-0232: `?type=` is an operator-facing alias for `?modality=`. Map it
    // before parsing; an explicit `?modality=` always wins.
    const { type, ...rest } = rawQuery;
    const normalizedQuery =
      type !== undefined && rest.modality === undefined ? { ...rest, modality: type } : rawQuery;
    const parsed = CatalogFiltersSchema.safeParse(normalizedQuery);
    if (!parsed.success) {
      throw new HttpException(
        { error: 'validation_error', details: parsed.error.flatten() },
        HttpStatus.BAD_REQUEST,
      );
    }
    // CONN-1665 — discovery mirrors enforcement: filter by the caller's policy.
    const apiKeyId = req.apiKey?.id;
    return apiKeyId
      ? this.connectorsService.getCatalog(parsed.data, apiKeyId)
      : this.connectorsService.getCatalog(parsed.data);
  }

  @Get('connectors/:name/status')
  async getStatus(@Param('name') name: string) {
    return this.connectorsService.getStatus(name);
  }

  @Post('connectors/:name/execute')
  async executePerConnector(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(perConnectorExecuteSchema)) body: PerConnectorExecuteDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const response = await this.connectorsService.execute(
      name,
      { ...body, idempotencyKey: parseIdempotencyKey(idempotencyKey) },
      apiKeyId,
    );
    return this.mapResponseStatus(response);
  }

  @Post('execute')
  async executeUniversal(
    @Body(new ZodValidationPipe(executeRequestSchema)) body: ExecuteRequestDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const intentKey = parseIdempotencyKey(idempotencyKey);

    if (body.profile != null) {
      // ARAS-0058 — a cascade fans one intent out across N candidate
      // connectors, each of which opens and settles its own intent. A single
      // key threaded down that path would be claimed by the first candidate and
      // then collide with itself on every subsequent hop, which is worse than
      // no idempotency at all: the caller would believe they had a guarantee.
      // Refused explicitly until the intent is hoisted to the cascade level.
      // No caller can be broken by this — the header did not exist before.
      if (intentKey) {
        throw new HttpException(
          {
            error: 'idempotency_unsupported',
            message:
              'Idempotency-Key is not yet supported together with `profile`: a cascade ' +
              'dispatches to several connectors and the key cannot span them safely. ' +
              'Name an explicit `connector` to use idempotency.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      const { profile, ...request } = body;
      try {
        const response = await this.cascadeRouterService.execute(profile, request, apiKeyId);
        return this.mapResponseStatus(response);
      } catch (err) {
        if (err instanceof CascadeExhaustedError) {
          throw new HttpException(
            { error: 'cascade_exhausted', tried: err.tried, message: err.message },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
        if (err instanceof CascadeBudgetExceededError) {
          throw new HttpException(
            {
              error: 'budget_exceeded',
              dailyCostUsd: err.dailyCostUsd,
              limitUsd: err.limitUsd,
              message: err.message,
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
        throw err;
      }
    }

    const { connector, ...request } = body;
    const response = await this.connectorsService.execute(
      connector!,
      { ...request, idempotencyKey: intentKey },
      apiKeyId,
    );
    return this.mapResponseStatus(response);
  }

  // ─── Image Generation endpoints ──────────────────────────────────────────────

  @Get('connectors/image/capabilities')
  getImageCapabilities() {
    return IMAGE_CAPABILITIES;
  }

  /**
   * POST /images/generate — image generation entry point.
   * Returns 201 for async (job created) or 200 for sync (completed immediately).
   * Per memory feedback_mc_http_201: async → 201, sync → 200.
   */
  @Post('images/generate')
  async generateImage(
    @Body(new ZodValidationPipe(imageGenerateRequestSchema)) body: ImageGenerateRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const result = await this.imageGenerationService.handleRequest(body, apiKeyId);

    if (result.status === 'queued') {
      // 201 Created — async job enqueued
      throw new HttpException(result, HttpStatus.CREATED);
    }

    return result; // 200 OK — sync completed
  }

  private mapResponseStatus(response: ConnectorResponse): ConnectorResponse {
    const errorType = response.error?.type;
    if (errorType && errorType in HTTP_ERROR_STATUS) {
      throw new HttpException(response, HTTP_ERROR_STATUS[errorType]);
    }
    return response;
  }
}
