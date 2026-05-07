import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import { ImageRouterService, ASYNC_PROVIDERS, ImageRoutingError } from './image-router.service';
import { VertexImageConnector } from './vertex/vertex-image.connector';
import { ReplicateFluxConnector } from './replicate/replicate-flux.connector';
import { OpenAIImagesConnector } from './openai-images/openai-images.connector';
import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import { getConfig } from '../../config/env.schema';
import { ProviderNotProvisionedError } from './errors/provider-not-provisioned.error';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from './types';
import type { ImageJobData } from './jobs/image-job.processor';
import type { IImageGenerationService } from './jobs/image-job.processor';

@Injectable()
export class ImageGenerationService implements IImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);
  private readonly router: ImageRouterService;
  private readonly cbManager: CircuitBreakerManager;
  private readonly vertexConnector: VertexImageConnector | null = null;
  private readonly replicateConnector: ReplicateFluxConnector | null = null;
  private readonly openaiConnector: OpenAIImagesConnector | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('image-jobs') private readonly imageJobQueue: Queue,
  ) {
    this.cbManager = new CircuitBreakerManager('image-generation', 5, 30_000);
    this.router = new ImageRouterService(this.cbManager);

    const config = getConfig();

    if (config.IMAGE_PROVIDER_VERTEX_ENABLED && config.VERTEX_PROJECT_ID) {
      this.vertexConnector = new VertexImageConnector(
        config.VERTEX_PROJECT_ID,
        config.VERTEX_LOCATION,
        config.VERTEX_SERVICE_ACCOUNT_JSON,
        this.cbManager,
      );
    }

    if (config.IMAGE_PROVIDER_REPLICATE_ENABLED && config.REPLICATE_API_TOKEN) {
      this.replicateConnector = new ReplicateFluxConnector(
        config.REPLICATE_API_TOKEN,
        this.cbManager,
      );
    }

    if (config.IMAGE_PROVIDER_OPENAI_ENABLED && config.OPENAI_API_KEY) {
      this.openaiConnector = new OpenAIImagesConnector(config.OPENAI_API_KEY, this.cbManager);
    }
  }

  /**
   * Determines whether a request should run async based on model type and override flag.
   * Per creative-async-strategy: sync ≤30s / BullMQ async for ASYNC_PROVIDERS.
   */
  shouldRunAsync(modelId: string, asyncMode: 'auto' | 'force' | 'never'): boolean {
    if (asyncMode === 'never') return false;
    if (asyncMode === 'force') return true;
    return ASYNC_PROVIDERS.has(modelId);
  }

  /**
   * Entry point for HTTP-triggered image generation.
   * Decides sync vs async, creates DB record, dispatches.
   * Implements fallback when a provider throws ProviderNotProvisionedError.
   */
  async handleRequest(
    req: ImageGenerationRequest,
    apiKeyId: string,
  ): Promise<ImageGenerationResult> {
    // Fallback loop: try each provider in tier order until one succeeds or all unprovisioned
    const excludedProviders: string[] = [];
    let routing = this.router.route(req.tier, { model: req.model });

    while (true) {
      const asyncMode = req.outputAsync ?? 'auto';
      const runAsync = this.shouldRunAsync(routing.chosenModel, asyncMode);
      const generationId = uuidv7();

      try {
        return await this._handleWithRouting(req, apiKeyId, routing, generationId, runAsync);
      } catch (err) {
        if (err instanceof ProviderNotProvisionedError) {
          excludedProviders.push(routing.chosenProvider);
          this.logger.warn(
            `Provider ${routing.chosenProvider} unprovisioned, trying fallback. Excluded: ${excludedProviders.join(', ')}`,
          );
          try {
            routing = this.router.routeExcluding(req.tier, { model: req.model }, excludedProviders);
          } catch (routingErr) {
            if (routingErr instanceof ImageRoutingError) {
              // All providers exhausted — throw aggregate error
              const allProviders = excludedProviders.join(', ');
              throw new ProviderNotProvisionedError(
                `[${allProviders}]` as never,
                `All providers for tier ${req.tier} unprovisioned: ${allProviders}`,
              );
            }
            throw routingErr;
          }
          continue;
        }
        throw err;
      }
    }
  }

  /** Internal: execute one routing attempt (sync or async). */
  private async _handleWithRouting(
    req: ImageGenerationRequest,
    apiKeyId: string,
    routing: ReturnType<ImageRouterService['route']>,
    generationId: string,
    runAsync: boolean,
  ): Promise<ImageGenerationResult> {
    // Create DB record (UUID v7 per memory feedback_uuid_v7_app_side_generation)
    await this.prisma.imageGeneration.create({
      data: {
        id: generationId,
        apiKeyId,
        provider: routing.chosenProvider,
        model: routing.chosenModel,
        prompt: req.prompt,
        negativePrompt: req.negativePrompt,
        width: req.width,
        height: req.height,
        aspectRatio: req.aspectRatio,
        seed: req.seed,
        status: runAsync ? 'pending' : 'processing',
        metadata: JSON.stringify({ routing }),
      },
    });

    if (runAsync) {
      // Enqueue for BullMQ processing
      const jobData: ImageJobData = {
        request: req,
        apiKeyId,
        imageGenerationId: generationId,
      };
      const job = await this.imageJobQueue.add('generate', jobData);

      return {
        requestId: generationId,
        status: 'queued',
        jobId: String(job.id),
        pollUrl: `/jobs/${generationId}`,
        costUsd: 0,
        routing,
      };
    }

    // Sync path
    const result = await this.processRequest(
      req,
      apiKeyId,
      routing.chosenProvider,
      routing.chosenModel,
    );

    await this.prisma.imageGeneration.update({
      where: { id: generationId },
      data: {
        status: 'completed',
        resultUrl: result.urls?.[0] ?? null,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      },
    });

    return { ...result, requestId: generationId };
  }

  /**
   * Core processing called both from sync path and from BullMQ worker.
   * Implements IImageGenerationService interface.
   */
  async processRequest(
    req: ImageGenerationRequest,
    _apiKeyId: string,
    provider?: ProviderId | string,
    modelId?: string,
  ): Promise<ImageGenerationResult> {
    const resolvedProvider =
      provider ?? this.router.route(req.tier, { model: req.model }).chosenProvider;

    const connector = this.resolveConnector(resolvedProvider as ProviderId);
    if (!connector) {
      throw new Error(`Provider ${resolvedProvider} is not enabled or configured`);
    }

    return connector.generate({ ...req, model: modelId ?? req.model });
  }

  private resolveConnector(provider: ProviderId) {
    switch (provider) {
      case 'vertex':
        return this.vertexConnector;
      case 'replicate':
        return this.replicateConnector;
      case 'openai-images':
        return this.openaiConnector;
      default:
        return null;
    }
  }
}
