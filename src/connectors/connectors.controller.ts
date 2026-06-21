import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Req } from '@nestjs/common';
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
import { ImageGenerationService } from './image-generation/image-generation.service';
import { IMAGE_CAPABILITIES } from './image-generation/capabilities';
import { CascadeRouterService } from './cascade/cascade-router.service';
import { CascadeExhaustedError, CascadeBudgetExceededError } from './cascade/cascade.errors';

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
};

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

  @Get('connectors/:name/status')
  async getStatus(@Param('name') name: string) {
    return this.connectorsService.getStatus(name);
  }

  @Post('connectors/:name/execute')
  async executePerConnector(
    @Param('name') name: string,
    @Body(new ZodValidationPipe(perConnectorExecuteSchema)) body: PerConnectorExecuteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const response = await this.connectorsService.execute(name, body, apiKeyId);
    return this.mapResponseStatus(response);
  }

  @Post('execute')
  async executeUniversal(
    @Body(new ZodValidationPipe(executeRequestSchema)) body: ExecuteRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const apiKeyId = req.apiKey?.id ?? 'unknown';

    if (body.profile != null) {
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
    const response = await this.connectorsService.execute(connector!, request, apiKeyId);
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
