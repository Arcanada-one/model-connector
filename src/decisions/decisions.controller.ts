import { Body, Controller, Headers, HttpException, Post, Req, Res, UsePipes } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { publicDecisionRequestSchema, PublicDecisionRequestDto } from './dto/decision-request.dto';
import { DecisionsRouteService } from './decisions.service';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

/**
 * CONN-JEV-07 — typed POST /v1/decisions.
 * AuthGuard applies (Bearer MC key). Not @Public.
 */
@Controller('v1')
export class DecisionsController {
  constructor(private readonly service: DecisionsRouteService) {}

  @Post('decisions')
  @UsePipes(new ZodValidationPipe(publicDecisionRequestSchema))
  async create(
    @Body() body: PublicDecisionRequestDto,
    @Headers('x-request-id') incomingRequestId: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const requestId = incomingRequestId ?? randomUUID();
    reply.header('X-Request-ID', requestId);
    const apiKeyId = req.apiKey?.id;
    if (!apiKeyId) {
      throw new HttpException(
        { statusCode: 401, error_code: 'unauthorized', message: 'API key required' },
        401,
      );
    }
    const result = await this.service.handle(body, apiKeyId);
    reply.status(201).send(result);
  }
}
