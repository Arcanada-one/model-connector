import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { GeminiApiConnector } from './gemini-api.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [GeminiApiConnector],
  exports: [GeminiApiConnector],
})
export class GeminiApiModule implements OnModuleInit {
  constructor(
    private readonly connector: GeminiApiConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.connector);
    void this.connector.refreshModels();
  }
}
