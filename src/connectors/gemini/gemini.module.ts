import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { GeminiConnector } from './gemini.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [GeminiConnector],
})
export class GeminiModule implements OnModuleInit {
  constructor(
    private readonly gemini: GeminiConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.gemini);
  }
}
