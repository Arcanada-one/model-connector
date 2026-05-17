import { Global, Module } from '@nestjs/common';
import { SpeechMetricsModule } from '../speech/speech-metrics.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  imports: [SpeechMetricsModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService, SpeechMetricsModule],
})
export class MetricsModule {}
