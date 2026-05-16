import {
  Controller,
  Headers,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
  UsePipes,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ttsRequestSchema, TtsRequestDto } from './dto/tts-request.dto';
import { vadRequestSchema, VadRequestDto } from './dto/vad-request.dto';
import { Body } from '@nestjs/common';
import { ZodError } from 'zod';
import { SpeechService } from './speech.service';
import { SttRouterService } from './stt/stt-router.service';
import { sttRequestSchema } from './dto/stt-request.dto';
import {
  SttAllProvidersExhausted,
  SttAudioTooLargeError,
  SttProviderError,
  SttUnsupportedMimeError,
} from './stt/stt-pilot.errors';
import type { SpeechErrorEnvelope } from './dto/speech-response.dto';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

@Controller('v1/speech')
export class SpeechController {
  private readonly logger = new Logger(SpeechController.name);

  constructor(
    private readonly service: SpeechService,
    private readonly sttRouter: SttRouterService,
  ) {}

  @Post('tts')
  @UsePipes(new ZodValidationPipe(ttsRequestSchema))
  async tts(
    @Body() body: TtsRequestDto,
    @Headers('x-request-id') incomingRequestId: string | undefined,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const requestId = incomingRequestId ?? randomUUID();
    const outcome = await this.service.tts(body, requestId);
    this.send(reply, outcome, requestId);
  }

  @Post('vad')
  @UsePipes(new ZodValidationPipe(vadRequestSchema))
  async vad(
    @Body() body: VadRequestDto,
    @Headers('x-request-id') incomingRequestId: string | undefined,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const requestId = incomingRequestId ?? randomUUID();
    const outcome = await this.service.vad(body, requestId);
    this.send(reply, outcome, requestId);
  }

  @Post('stt')
  async stt(
    @Headers('x-request-id') incomingRequestId: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const requestId = incomingRequestId ?? randomUUID();
    reply.header('X-Request-ID', requestId);
    try {
      const apiKeyId = req.apiKey?.id;
      if (!apiKeyId) {
        // AuthGuard normally rejects before here; this is a defensive fallback.
        throw new HttpException(
          { statusCode: 401, error_code: 'unauthorized', message: 'API key required' },
          401,
        );
      }
      const parsed = await this.parseMultipart(req);
      const fields = sttRequestSchema.parse({ ...parsed.fields, mimeType: parsed.mimeType });
      const envelope = await this.sttRouter.transcribe(
        {
          file: parsed.file,
          filename: parsed.filename,
          mimeType: fields.mimeType,
          audioBytes: parsed.file.length,
          language: fields.language,
          model: fields.model,
          prompt: fields.prompt,
          temperature: fields.temperature,
          requestId,
          timeoutMs: fields.timeoutMs,
        },
        apiKeyId,
      );
      reply.status(200);
      reply.header('Content-Type', 'application/json');
      reply.send(envelope);
    } catch (err) {
      const envelope = this.mapSttError(err);
      reply.status(envelope.statusCode);
      reply.header('Content-Type', 'application/json');
      reply.send(envelope);
    }
  }

  private async parseMultipart(req: AuthenticatedRequest): Promise<{
    file: Buffer;
    filename?: string;
    mimeType: string;
    fields: Record<string, string>;
  }> {
    // `req.file()` is added by @fastify/multipart (registered in main.ts).
    const reqWithMultipart = req as unknown as {
      file: () => Promise<
        | undefined
        | {
            file: AsyncIterable<Buffer>;
            filename: string;
            mimetype: string;
            toBuffer: () => Promise<Buffer>;
            fields: Record<string, { value?: string }>;
          }
      >;
    };
    const data = await reqWithMultipart.file();
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
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(data.fields)) {
      if (key === 'file') continue;
      const value = (raw as { value?: string }).value;
      if (typeof value === 'string') fields[key] = value;
    }
    return { file: buffer, filename: data.filename, mimeType: data.mimetype, fields };
  }

  private mapSttError(err: unknown): SpeechErrorEnvelope {
    if (err instanceof SttAudioTooLargeError) {
      return {
        statusCode: 413,
        error_code: 'stt_audio_too_large',
        message: err.message,
      };
    }
    if (err instanceof SttUnsupportedMimeError) {
      return {
        statusCode: 400,
        error_code: 'stt_unsupported_mime',
        message: err.message,
      };
    }
    if (err instanceof ZodError) {
      return {
        statusCode: 400,
        error_code: 'stt_validation_error',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
    }
    if (err instanceof SttAllProvidersExhausted) {
      return {
        statusCode: 503,
        error_code: 'stt_all_providers_exhausted',
        message: err.message,
      };
    }
    if (err instanceof SttProviderError) {
      return {
        statusCode: this.providerErrorToStatus(err),
        error_code: 'stt_provider_failed',
        message: err.message,
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
    this.logger.error(`Unhandled STT error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      statusCode: 500,
      error_code: 'stt_provider_failed',
      message: 'Unexpected STT failure',
    };
  }

  private providerErrorToStatus(err: SttProviderError): number {
    switch (err.type) {
      case 'auth_failed':
        return 502; // MC-side: provider auth failure surfaces as bad-gateway to client.
      case 'rate_limited':
        return 429;
      case 'timeout':
        return 504;
      case 'server_error':
      case 'network_error':
      case 'parse_error':
      case 'http_error':
      default:
        return 502;
    }
  }

  private send(
    reply: FastifyReply,
    outcome: Awaited<ReturnType<SpeechService['tts']>>,
    requestId: string,
  ): void {
    reply.header('X-Request-ID', requestId);
    if (outcome.kind === 'proxied') {
      const { result } = outcome;
      for (const [key, value] of Object.entries(result.headers)) {
        if (key.toLowerCase() === 'x-request-id') continue;
        reply.header(key, value);
      }
      reply.status(result.status);
      reply.send(Buffer.from(result.body));
      return;
    }
    const { envelope } = outcome;
    reply.status(envelope.statusCode);
    reply.header('Content-Type', 'application/json');
    reply.send(envelope);
  }
}
