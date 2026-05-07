import { Controller, Get, HttpException, HttpStatus, Param, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { PrismaService } from '../../../prisma/prisma.service';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

@Controller('jobs')
export class ImageJobController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /jobs/:id — ownership-gated job status.
   * Per memory `feedback_authenticated_emit_endpoints_fail_soft`:
   * fails with 404 if job not found OR apiKeyId mismatch (no info leak).
   */
  @Get(':id')
  async getJobStatus(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const apiKeyId = req.apiKey?.id;

    if (!apiKeyId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    const job = await this.prisma.imageGeneration.findFirst({
      where: { id, apiKeyId },
      select: {
        id: true,
        status: true,
        resultUrl: true,
        costUsd: true,
        latencyMs: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!job) {
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    return {
      jobId: job.id,
      status: job.status,
      resultUrl: job.resultUrl,
      costUsd: Number(job.costUsd),
      latencyMs: job.latencyMs,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}
