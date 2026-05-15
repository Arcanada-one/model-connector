import { Body, Controller, Headers, HttpException, Post, Req, Res, UsePipes } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ttsRequestSchema, TtsRequestDto } from './dto/tts-request.dto';
import { vadRequestSchema, VadRequestDto } from './dto/vad-request.dto';
import { SpeechService } from './speech.service';

@Controller('v1/speech')
export class SpeechController {
  constructor(private readonly service: SpeechService) {}

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
  stt(): never {
    const envelope = this.service.stt();
    throw new HttpException(envelope, envelope.statusCode);
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
