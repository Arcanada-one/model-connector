import { Module } from '@nestjs/common';
import { SpeechMetricsService } from './speech-metrics.service';

@Module({
  providers: [SpeechMetricsService],
  exports: [SpeechMetricsService],
})
export class SpeechMetricsModule {}
