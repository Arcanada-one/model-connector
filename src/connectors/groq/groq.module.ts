import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { GroqConnector } from './groq.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [GroqConnector],
})
export class GroqModule implements OnModuleInit {
  constructor(
    private readonly groq: GroqConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.groq);
  }
}
