import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { SpeechController } from './speech.controller';
import { SpeechService } from './speech.service';
import { TranscribatorProxy } from './transcribator.proxy';
import { GroqSttModule } from './stt/groq-stt.module';
import { DeepgramSttModule } from './stt/deepgram-stt.module';
import { AssemblyAiSttModule } from './stt/assemblyai-stt.module';
import { OpenAiSttModule } from './stt/openai-stt.module';
import { LocalWhisperSttModule } from './stt/local-whisper-stt.connector.module';
import { SttRouterService } from './stt/stt-router.service';
import { SttQuotaService, STT_REDIS_CLIENT } from './stt/stt-quota.service';
import { SttAsyncController } from './stt/stt-async.controller';
import { SttJobProcessor } from './stt/stt-job.processor';
import { MetricsModule } from '../metrics/metrics.module';
import { getConfig } from '../config/env.schema';

@Module({
  imports: [
    GroqSttModule,
    DeepgramSttModule,
    AssemblyAiSttModule,
    OpenAiSttModule,
    LocalWhisperSttModule,
    MetricsModule,
    // CONN-0104 — async STT pipeline queue. Distinct from connector-jobs
    // (chat/CLI) so concurrency=1 + 2 attempts apply only to faster-whisper.
    BullModule.registerQueue({
      name: 'connector-jobs-stt',
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 2,
      },
    }),
  ],
  controllers: [SpeechController, SttAsyncController],
  providers: [
    SpeechService,
    TranscribatorProxy,
    SttRouterService,
    SttQuotaService,
    SttJobProcessor,
    // Dedicated Redis client for STT quota counters. Shares the cluster
    // configured for BullMQ (REDIS_HOST/PORT/PASSWORD) but is its own
    // connection — keeps the quota pipeline isolated from BullMQ's blocking
    // reads. ioredis is already a transitive dep of @nestjs/bullmq.
    {
      provide: STT_REDIS_CLIENT,
      useFactory: () => {
        const cfg = getConfig();
        return new Redis({
          host: cfg.REDIS_HOST,
          port: cfg.REDIS_PORT,
          ...(cfg.REDIS_PASSWORD && { password: cfg.REDIS_PASSWORD }),
          // STT quota keys already start with `conn:` per convention; we
          // omit `keyPrefix` so the literal key string is sent verbatim.
          lazyConnect: false,
        });
      },
    },
  ],
  exports: [SpeechService, SttRouterService, SttQuotaService],
})
export class SpeechModule {}
