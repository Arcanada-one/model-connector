import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { SpeechMetricsService } from '../speech/speech-metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly speechMetrics: SpeechMetricsService) {}

  @Get()
  async metrics(@Res() reply: FastifyReply): Promise<void> {
    const registry = this.speechMetrics.getRegistry();
    const body = await registry.metrics();
    reply.status(200);
    reply.header('Content-Type', registry.contentType);
    reply.send(body);
  }
}
