import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Headers,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { uuidv7 } from 'uuidv7';
import { ZodError } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { SttQuotaService } from './stt-quota.service';
import { sttRequestSchema, STT_ALLOWED_MIME_TYPES } from '../dto/stt-request.dto';
import type { SpeechErrorEnvelope } from '../dto/speech-response.dto';
import { SttAudioTooLargeError, SttUnsupportedMimeError } from './stt-pilot.errors';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

interface MultipartFile {
  file: AsyncIterable<Buffer>;
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
  fields: Record<string, { value?: string }>;
}

interface AsyncJobStatusResponse {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: {
    transcription: string;
    language?: string;
    duration_seconds?: number;
    cost_usd: number;
    provider: string;
    model: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

const PROVIDER_NAME = 'local-whisper';

/**
 * CONN-0104 — async STT entrypoints.
 *
 * POST /v1/speech/stt/async — accepts the same multipart payload as the
 * sync controller, performs quota precheck, persists a queued row, enqueues
 * a `transcribe` job onto `connector-jobs-stt`, and returns 202 + status_url.
 *
 * GET /v1/speech/stt/jobs/:id — ownership-gated polling endpoint. 404 on
 * missing row OR apiKeyId mismatch (no info leak — same shape as image
 * jobs controller).
 */
@Controller('v1/speech/stt')
export class SttAsyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: SttQuotaService,
    @InjectQueue('connector-jobs-stt') private readonly queue: Queue,
  ) {}

  @Post('async')
  async submit(
    @Headers('x-request-id') incomingRequestId: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const requestId = incomingRequestId ?? randomUUID();
    reply.header('X-Request-ID', requestId);
    try {
      const apiKeyId = req.apiKey?.id;
      if (!apiKeyId) {
        throw new HttpException(
          { statusCode: 401, error_code: 'unauthorized', message: 'API key required' },
          401,
        );
      }
      const parsed = await this.parseMultipart(req);
      const fields = sttRequestSchema.parse({ ...parsed.fields, mimeType: parsed.mimeType });

      const precheck = await this.quota.precheck(requestId);
      if (!precheck.allowed) {
        const envelope: SpeechErrorEnvelope = {
          statusCode: 503,
          error_code: 'stt_budget_exhausted',
          message: 'STT daily budget exhausted',
          details: {
            daily_cost_usd: precheck.dailyCostMicroCents / 100_000_000,
            providers_tried: [PROVIDER_NAME],
          },
        };
        reply.status(envelope.statusCode);
        reply.header('Content-Type', 'application/json');
        reply.send(envelope);
        return;
      }

      const jobId = uuidv7();
      const audioBuffer = parsed.file;
      await this.prisma.sttTranscription.create({
        data: {
          id: uuidv7(),
          apiKeyId,
          provider: PROVIDER_NAME,
          model: fields.model ?? 'Systran/faster-distil-whisper-large-v3',
          language: fields.language,
          audioBytes: audioBuffer.length,
          mimeType: fields.mimeType,
          transcriptionPreview: '',
          costUsd: 0,
          latencyMs: 0,
          status: 'queued',
          requestId,
          mode: 'async',
          jobId,
        },
      });

      await this.queue.add('transcribe', {
        jobId,
        audioBase64: audioBuffer.toString('base64'),
        mimeType: fields.mimeType,
        audioBytes: audioBuffer.length,
        filename: parsed.filename,
        requestId,
        apiKeyId,
        language: fields.language,
        model: fields.model,
        prompt: fields.prompt,
        temperature: fields.temperature,
        timeoutMs: fields.timeoutMs,
      });

      reply.status(202);
      reply.header('Content-Type', 'application/json');
      reply.send({
        job_id: jobId,
        status: 'queued',
        status_url: `/v1/speech/stt/jobs/${jobId}`,
      });
    } catch (err) {
      const envelope = this.mapError(err);
      reply.status(envelope.statusCode);
      reply.header('Content-Type', 'application/json');
      reply.send(envelope);
    }
  }

  @Get('jobs/:id')
  async getJobStatus(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AsyncJobStatusResponse> {
    const apiKeyId = req.apiKey?.id;
    if (!apiKeyId) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
    const row = await this.prisma.sttTranscription.findFirst({
      where: { jobId: id, apiKeyId },
    });
    if (!row) {
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    const status = mapDbStatusToApi(row.status);
    const body: AsyncJobStatusResponse = { job_id: id, status };
    if (status === 'completed') {
      body.result = {
        transcription: row.transcriptionPreview,
        language: row.language ?? undefined,
        duration_seconds: row.audioDurationSeconds ?? undefined,
        cost_usd: Number(row.costUsd),
        provider: row.provider,
        model: row.model,
      };
    } else if (status === 'failed') {
      body.error = {
        code: row.errorType ?? 'unknown_error',
        message: row.errorMessage ?? 'Transcription failed',
      };
    }
    return body;
  }

  private async parseMultipart(req: AuthenticatedRequest): Promise<{
    file: Buffer;
    filename?: string;
    mimeType: string;
    fields: Record<string, string>;
  }> {
    const reqWithMultipart = req as unknown as {
      file: () => Promise<undefined | MultipartFile>;
    };
    let data: Awaited<ReturnType<typeof reqWithMultipart.file>>;
    try {
      data = await reqWithMultipart.file();
    } catch (err) {
      if (this.isFastifyErrorCode(err, 'FST_REQ_NOT_MULTIPART')) {
        throw new HttpException(
          {
            statusCode: 400,
            error_code: 'stt_validation_error',
            message: 'Content-Type must be multipart/form-data',
          },
          400,
        );
      }
      throw err;
    }
    if (!data) {
      throw new HttpException(
        {
          statusCode: 400,
          error_code: 'stt_validation_error',
          message: 'Multipart file field "file" is required',
        },
        400,
      );
    }
    const buffer = await data.toBuffer();
    const baseMime = data.mimetype.split(';')[0].trim().toLowerCase();
    if (!(STT_ALLOWED_MIME_TYPES as readonly string[]).includes(baseMime)) {
      throw new SttUnsupportedMimeError(baseMime, STT_ALLOWED_MIME_TYPES);
    }
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(data.fields)) {
      if (key === 'file') continue;
      const value = (raw as { value?: string }).value;
      if (typeof value === 'string') fields[key] = value;
    }
    return { file: buffer, filename: data.filename, mimeType: baseMime, fields };
  }

  private isFastifyErrorCode(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
  }

  private mapError(err: unknown): SpeechErrorEnvelope {
    if (this.isFastifyErrorCode(err, 'FST_REQ_FILE_TOO_LARGE')) {
      return {
        statusCode: 413,
        error_code: 'stt_audio_too_large',
        message: 'Audio payload exceeds the configured maximum',
      };
    }
    if (err instanceof SttAudioTooLargeError) {
      return { statusCode: 413, error_code: 'stt_audio_too_large', message: err.message };
    }
    if (err instanceof SttUnsupportedMimeError) {
      return { statusCode: 400, error_code: 'stt_unsupported_mime', message: err.message };
    }
    if (err instanceof ZodError) {
      return {
        statusCode: 400,
        error_code: 'stt_validation_error',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      if (typeof body === 'object' && body !== null) {
        return body as SpeechErrorEnvelope;
      }
      return {
        statusCode: err.getStatus(),
        error_code: 'stt_validation_error',
        message: String(body),
      };
    }
    return {
      statusCode: 500,
      error_code: 'stt_provider_failed',
      message: err instanceof Error ? err.message : 'Unexpected async STT failure',
    };
  }
}

function mapDbStatusToApi(dbStatus: string): AsyncJobStatusResponse['status'] {
  switch (dbStatus) {
    case 'queued':
      return 'queued';
    case 'processing':
      return 'processing';
    case 'success':
      return 'completed';
    case 'error':
      return 'failed';
    default:
      return 'queued';
  }
}
