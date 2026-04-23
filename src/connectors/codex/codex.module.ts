import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { CodexConnector } from './codex.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [CodexConnector],
})
export class CodexModule implements OnModuleInit {
  constructor(
    private readonly codex: CodexConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.codex);
  }
}
