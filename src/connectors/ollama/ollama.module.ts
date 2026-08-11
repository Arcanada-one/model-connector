import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { OllamaConnector } from './ollama.connector';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OllamaConnector],
})
export class OllamaModule implements OnModuleInit {
  constructor(
    private readonly ollama: OllamaConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.ollama);
    void this.ollama.refreshModels();
  }
}
