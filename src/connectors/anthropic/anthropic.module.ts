import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { AnthropicConnector } from './anthropic.connector';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { PromptCacheModule } from '../../prompt-cache/prompt-cache.module';

@Module({
  // AUP-CACHE-006 — PromptCacheModule provides the policy the connector gates on.
  imports: [forwardRef(() => ConnectorsModule), PromptCacheModule],
  providers: [AnthropicConnector],
})
export class AnthropicModule implements OnModuleInit {
  constructor(
    private readonly anthropic: AnthropicConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.anthropic);
  }
}
