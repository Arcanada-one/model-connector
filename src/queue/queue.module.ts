import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConnectorJobProcessor } from './connector-job.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'connector-jobs',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
        attempts: 1,
      },
    }),
    // CONN-0104 — STT Phase 2 async pipeline. Distinct queue (not reuse of
    // connector-jobs) so concurrency=1 + 5-min timeout + 2 attempts apply
    // only to faster-whisper jobs and never bleed into chat/CLI execution.
    BullModule.registerQueue({
      name: 'connector-jobs-stt',
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 2,
      },
    }),
  ],
  providers: [ConnectorJobProcessor],
  exports: [BullModule, ConnectorJobProcessor],
})
export class QueueModule {}
