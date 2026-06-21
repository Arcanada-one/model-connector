import { Module, forwardRef } from '@nestjs/common';
import { CascadeRouterService } from './cascade-router.service';
import { ConnectorsModule } from '../connectors.module';
import { MetricsModule } from '../../metrics/metrics.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule), MetricsModule],
  providers: [CascadeRouterService],
  exports: [CascadeRouterService],
})
export class CascadeModule {}
