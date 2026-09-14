// AUP-CACHE-006 (enforce0) — pre-warm endpoint module (needs ConnectorsService).

import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { PromptCachePrewarmController } from './prompt-cache-prewarm.controller';

@Module({
  imports: [ConnectorsModule],
  controllers: [PromptCachePrewarmController],
})
export class PromptCachePrewarmModule {}
