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
  ],
  providers: [ConnectorJobProcessor],
  exports: [BullModule, ConnectorJobProcessor],
})
export class QueueModule {}
