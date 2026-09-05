// AUP-CACHE-006 (enforce0) — prompt-cache policy module (state + admin surface).
// Imports nothing from connectors so AnthropicModule can import it without a
// cycle; the pre-warm endpoint, which needs ConnectorsService, lives in
// PromptCachePrewarmModule.

import { Module } from '@nestjs/common';
import { PromptCacheAdminController } from './prompt-cache-admin.controller';
import { PromptCachePolicyService } from './prompt-cache-policy.service';

@Module({
  controllers: [PromptCacheAdminController],
  providers: [PromptCachePolicyService],
  exports: [PromptCachePolicyService],
})
export class PromptCacheModule {}
