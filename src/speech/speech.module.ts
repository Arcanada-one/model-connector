import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SpeechController } from './speech.controller';
import { SpeechService } from './speech.service';
import { TranscribatorProxy } from './transcribator.proxy';
import { GroqSttModule } from './stt/groq-stt.module';
import { DeepgramSttModule } from './stt/deepgram-stt.module';
import { AssemblyAiSttModule } from './stt/assemblyai-stt.module';
import { OpenAiSttModule } from './stt/openai-stt.module';
import { LocalWhisperSttModule } from './stt/local-whisper-stt.connector.module';
import { SttRouterService } from './stt/stt-router.service';
import { SttQuotaService } from './stt/stt-quota.service';
import { STT_REDIS_PROVIDER } from './stt-redis.provider';
import { SttAsyncController } from './stt/stt-async.controller';
import { SttJobProcessor } from './stt/stt-job.processor';
import { MetricsModule } from '../metrics/metrics.module';
import { DeepgramTtsConnector } from './tts/deepgram-tts.connector';
import { TogetherTtsConnector } from './tts/together-tts.connector';
// CONN-1671 — per-key access policy enforcement on STT/TTS dispatch paths that
// bypass the ConnectorsService choke point. Provides the real PolicyService.
import { PolicyModule } from '../policy/policy.module';

@Module({
  imports: [
    GroqSttModule,
    DeepgramSttModule,
    AssemblyAiSttModule,
    OpenAiSttModule,
    LocalWhisperSttModule,
    MetricsModule,
    PolicyModule,
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
    DeepgramTtsConnector,
    TogetherTtsConnector,
    SttRouterService,
    SttQuotaService,
    SttJobProcessor,
    // Dedicated Redis client for STT quota counters. Shares the cluster
    // configured for BullMQ (REDIS_HOST/PORT/PASSWORD) but is its own
    // connection — keeps the quota pipeline isolated from BullMQ's blocking
    // reads. ioredis is already a transitive dep of @nestjs/bullmq.
    STT_REDIS_PROVIDER,
  ],
  exports: [SpeechService, SttRouterService, SttQuotaService],
})
export class SpeechModule {}
