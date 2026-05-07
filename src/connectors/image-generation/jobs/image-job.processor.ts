import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ImageGenerationRequest, ImageGenerationResult } from '../types';

export interface ImageJobData {
  request: ImageGenerationRequest;
  apiKeyId: string;
  imageGenerationId: string;
}

/**
 * Interface for the image generation service injected into the processor.
 * Decoupled to allow testing without full NestJS DI.
 */
export interface IImageGenerationService {
  processRequest(req: ImageGenerationRequest, apiKeyId: string): Promise<ImageGenerationResult>;
}

@Processor('image-jobs')
export class ImageJobProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageJobProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly imageService: IImageGenerationService,
  ) {
    super();
  }

  async process(job: Job<ImageJobData>): Promise<ImageGenerationResult> {
    const { request, apiKeyId, imageGenerationId } = job.data;
    this.logger.log(
      `Processing async image job ${job.id} for imageGenerationId=${imageGenerationId}`,
    );

    try {
      // Update DB status: processing
      await this.prisma.imageGeneration.update({
        where: { id: imageGenerationId },
        data: { status: 'processing' },
      });

      const result = await this.imageService.processRequest(request, apiKeyId);

      // Update DB with result
      await this.prisma.imageGeneration.update({
        where: { id: imageGenerationId },
        data: {
          status: 'completed',
          resultUrl: result.urls?.[0] ?? null,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
        },
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Image job ${job.id} failed: ${message}`);

      await this.prisma.imageGeneration.update({
        where: { id: imageGenerationId },
        data: {
          status: 'failed',
          errorMessage: message,
        },
      });

      throw err;
    }
  }
}
