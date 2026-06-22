import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OpenRouterConnector } from './openrouter.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OpenRouterConnector],
})
export class OpenRouterModule implements OnModuleInit {
  constructor(
    private readonly openrouter: OpenRouterConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.openrouter);
    // CONN-0233 — kick off free-model refresh on startup (fire-and-forget).
    // Failure is tolerated inside refreshFreeModels; catalog still works
    // with empty freeModels if the API is unreachable at boot.
    void this.openrouter.refreshFreeModels();
  }
}
