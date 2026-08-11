import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { OllamaCloudConnector } from './ollama-cloud.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OllamaCloudConnector],
})
export class OllamaCloudModule implements OnModuleInit {
  constructor(
    private readonly ollamaCloud: OllamaCloudConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.ollamaCloud);
    void this.ollamaCloud.refreshModels();
  }
}
