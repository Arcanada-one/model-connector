import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { CloudflareWorkersAiConnector } from './cloudflare-workers-ai.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [CloudflareWorkersAiConnector],
})
export class CloudflareWorkersAiModule implements OnModuleInit {
  constructor(
    private readonly connector: CloudflareWorkersAiConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.connector);
  }
}
