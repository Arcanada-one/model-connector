import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { GrokConnector } from './grok.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [GrokConnector],
})
export class GrokModule implements OnModuleInit {
  constructor(
    private readonly grok: GrokConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.grok);
  }
}
